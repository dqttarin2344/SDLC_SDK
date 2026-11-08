import { dirname, join } from "node:path";
import { query, type CanUseTool, type HookCallback, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { approvalKeyPath, checkCommand, checkReadPath, checkWritePath, costUsd, lookupPrice, normalizeModelId, resolveModel, type ModelPrice, type AgentAdapter, type GuardDecision, type StageRequest, type StageResult } from "@sdlc/core";

/** Tools whose use is decided by the SDLC guard. Everything else in the role's tool list is allowed. */
const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const ALL_GATED_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "WebSearch", "WebFetch", "Agent", "Task"];

export interface ClaudeAdapterOptions {
  /** Print a short line per tool call. Default true. */
  verbose?: boolean;
  /** Extra Claude Agent SDK settings sources. Default ["project"] (loads CLAUDE.md, .claude/settings.json). */
  settingSources?: Array<"user" | "project" | "local">;
  log?: (line: string) => void;
}

function decide(req: StageRequest, tool: string, input: Record<string, unknown>): GuardDecision {
  if (!req.role.claudeTools.includes(tool) && ALL_GATED_TOOLS.includes(tool)) {
    return { allow: false, reason: `Tool ${tool} is not available to ${req.role.name}` };
  }
  if (WRITE_TOOLS.has(tool)) {
    const path = String(input.file_path ?? input.notebook_path ?? "");
    return checkWritePath(path, req.stage.access, req.plan.repoRoot, req.runDir);
  }
  if (tool === "Read") return checkReadPath(String(input.file_path ?? ""));
  if (tool === "Bash") return checkCommand(String(input.command ?? ""), req.stage.access, { readOnlyAllow: testCommands(req) });
  return { allow: true };
}

/** Test commands configured for the run; read-only stages (review) may run them too. */
function testCommands(req: StageRequest): string[] {
  return Object.values(req.plan.config.test.commands).filter((c): c is string => Boolean(c));
}

/** Runs one SDLC stage as a Claude Agent SDK `query()` with a hard USD budget. */
export class ClaudeAdapter implements AgentAdapter {
  readonly target = "claude" as const;
  /** Last cumulative cost seen per SDK session: a resumed session reports the running total, not the delta. */
  private sessionCost = new Map<string, number>();

  constructor(private opts: ClaudeAdapterOptions = {}) {}

  async runStage(req: StageRequest): Promise<StageResult> {
    const log = this.opts.log ?? ((l: string) => process.stdout.write(l + "\n"));
    const verbose = this.opts.verbose ?? true;
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    req.signal.addEventListener("abort", onAbort, { once: true });

    const canUseTool: CanUseTool = async (tool, input) => {
      const d = decide(req, tool, input);
      return d.allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: d.reason ?? "denied" };
    };
    // PreToolUse runs even for calls that permission rules auto-approve, so the guard always applies.
    const guardHook: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const d = decide(req, input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>);
      return d.allow ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason } };
    };

    const disallowed = ALL_GATED_TOOLS.filter((t) => !req.role.claudeTools.includes(t));
    const est = req.plan.estimate.stages.find((s) => s.stage === req.stage.id);
    const maxTurns = Math.ceil((est?.turns.high ?? 40) * 1.5) + 5;

    const result: StageResult = { status: "failed", usd: 0, turns: 0, tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } };

    // Cost accounting for models the SDK cannot price (DeepSeek and other non-Anthropic backends):
    // price them ourselves from the user's config prices, or from the plan's frozen estimate price as a last resort.
    const resolved = resolveModel(req.plan.config, req.stage, "claude");
    const mine = req.plan.config.prices?.claude ?? {};
    const ourPrice = (model: string): ModelPrice | undefined => {
      const id = normalizeModelId(model);
      const custom = mine[id] ?? mine[model];
      if (custom) return custom;
      return lookupPrice("claude", model) ? undefined : req.plan.prices?.[resolved.priced]; // built-in models: trust the SDK
    };
    const models = new Set<string>();
    const seenMessages = new Set<string>();
    const live = { usd: 0 };
    let capHit = false;

    try {
      const q = query({
        prompt: req.userPrompt,
        options: {
          cwd: req.plan.repoRoot,
          // "inherit": do not set a model, so the session's own model applies (ANTHROPIC_MODEL, settings, DeepSeek via ANTHROPIC_BASE_URL…).
          ...(resolved.run ? { model: resolved.run } : {}),
          effort: req.stage.effort,
          systemPrompt: { type: "preset", preset: "claude_code", append: req.systemPrompt },
          settingSources: this.opts.settingSources ?? ["project"],
          permissionMode: "default",
          disallowedTools: disallowed,
          canUseTool,
          hooks: { PreToolUse: [{ hooks: [guardHook] }] },
          maxBudgetUsd: req.budgetUsd,
          sandbox: sandboxFor(req),
          env: agentEnv(),
          maxTurns,
          abortController: abort,
          resume: req.resumeSessionId,
        },
      });

      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if ("session_id" in msg && typeof msg.session_id === "string") result.sessionId = msg.session_id;
        if (msg.type === "assistant") {
          if (verbose) {
            for (const block of msg.message.content) {
              if (block.type === "tool_use") log(`    · ${block.name} ${summarize(block.input)}`);
            }
          }
          // Live spend for models we price ourselves: the SDK's own maxBudgetUsd cannot see their cost.
          const model = msg.message.model;
          if (model) models.add(model);
          const price = model ? ourPrice(model) : undefined;
          if (price && !seenMessages.has(msg.message.id)) {
            seenMessages.add(msg.message.id);
            const u = msg.message.usage;
            live.usd += costUsd(price, {
              input: u?.input_tokens ?? 0,
              cacheWrite: u?.cache_creation_input_tokens ?? 0,
              cacheRead: u?.cache_read_input_tokens ?? 0,
              output: u?.output_tokens ?? 0,
            });
            if (live.usd >= req.budgetUsd && !capHit) {
              capHit = true;
              abort.abort();
            }
          }
        }
        if (msg.type === "result") {
          // Cumulative cost for this session, per model: our price where the SDK cannot price, the SDK's own otherwise.
          let cumulative = 0;
          const usage = Object.entries(msg.modelUsage ?? {});
          for (const [model, mu] of usage) {
            models.add(model);
            const price = ourPrice(model);
            cumulative += price
              ? costUsd(price, { input: mu.inputTokens, cacheWrite: mu.cacheCreationInputTokens, cacheRead: mu.cacheReadInputTokens, output: mu.outputTokens })
              : (mu.costUSD ?? 0);
          }
          if (!usage.length) cumulative = msg.total_cost_usd;
          const prior = req.resumeSessionId ? (this.sessionCost.get(req.resumeSessionId) ?? 0) : 0;
          result.usd = Math.max(0, cumulative - prior);
          this.sessionCost.set(msg.session_id, cumulative);
          result.turns = msg.num_turns;
          result.tokens = {
            input: msg.usage.input_tokens ?? 0,
            cacheWrite: msg.usage.cache_creation_input_tokens ?? 0,
            cacheRead: msg.usage.cache_read_input_tokens ?? 0,
            output: msg.usage.output_tokens ?? 0,
          };
          if (msg.subtype === "success") result.status = "ok";
          else if (msg.subtype === "error_max_budget_usd") result.status = "budget_exceeded";
          else {
            result.status = "failed";
            result.error = msg.subtype === "error_max_turns" ? `hit max turns (${maxTurns})` : msg.errors.join("; ") || msg.subtype;
          }
        }
      }
    } catch (err) {
      if (capHit) result.status = "budget_exceeded";
      else if (abort.signal.aborted) result.status = "aborted";
      else {
        result.status = "failed";
        result.error = (err as Error).message;
      }
    } finally {
      req.signal.removeEventListener("abort", onAbort);
    }
    if (capHit) {
      // Our own cap fired (a model the SDK cannot price): report it as the budget stop, whatever the SDK said.
      result.status = "budget_exceeded";
      result.usd = Math.max(result.usd, live.usd);
    }
    if (models.size) result.model = [...models].join(", ");
    return result;
  }
}

/** Secrets that let a command publish or push; agents never need them. */
const STRIPPED_ENV = ["GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN", "TWINE_PASSWORD", "CARGO_REGISTRY_TOKEN", "GEM_HOST_API_KEY"];

function agentEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: "sdlc-claude/0.1.0" };
  for (const k of STRIPPED_ENV) delete env[k];
  return env;
}

/**
 * OS sandbox for Bash commands: they can never write .git, the run's bookkeeping, the ledger, the config,
 * or read/write the approval-signing key (so `estimate.js approve` cannot be run from inside a stage).
 * Report files are left writable on purpose; forged approval files elsewhere fail signature checks.
 */
function sandboxFor(req: StageRequest) {
  const sb = req.plan.config.sandbox ?? { enabled: true, required: false };
  if (!sb.enabled) return undefined;
  const root = req.plan.repoRoot;
  const keyDir = dirname(approvalKeyPath());
  const denyWrite = [
    join(root, ".git"),
    join(root, "sdlc.config.json"),
    join(root, dirname(req.plan.config.artifactsDir), "ledger.jsonl"),
    ...["approval.json", "plan.json", "actuals.json", "events.jsonl"].map((f) => join(req.runDir, f)),
    keyDir,
  ];
  return {
    enabled: true,
    failIfUnavailable: sb.required,
    allowUnsandboxedCommands: false,
    filesystem: { denyWrite, denyRead: [keyDir] },
  };
}

function summarize(input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const v = i.file_path ?? i.path ?? i.pattern ?? i.command ?? i.url ?? i.query ?? "";
  const s = String(v).replace(/\s+/g, " ");
  return s.length > 90 ? s.slice(0, 89) + "…" : s;
}
