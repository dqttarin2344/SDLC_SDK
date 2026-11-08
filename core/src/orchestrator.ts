import { existsSync, readFileSync } from "node:fs";
import { enabledStages, resolveModel } from "./config.js";
import type { GateIO } from "./io.js";
import { Ledger } from "./ledger.js";
import { RunStore } from "./plan.js";
import { parseVerdict, stageSystemPrompt, stageUserPrompt, type StagePromptInput, type Verdict } from "./prompts.js";
import { renderActuals, usd } from "./render.js";
import { loadRole, type Role } from "./roles.js";
import type { RunPlan, StageActual, StageConfig, StageId, Target, TokenBreakdown } from "./types.js";

export interface StageRequest {
  plan: RunPlan;
  stage: StageConfig;
  role: Role;
  systemPrompt: string;
  userPrompt: string;
  artifactPath: string;
  runDir: string;
  /** Hard USD ceiling for this stage invocation. The adapter must stop at (or just past) it. */
  budgetUsd: number;
  iteration: number;
  /** Resume a previous SDK session (after a budget extension), when the adapter supports it. */
  resumeSessionId?: string;
  signal: AbortSignal;
}

export interface StageResult {
  status: "ok" | "failed" | "budget_exceeded" | "aborted";
  usd: number;
  tokens: TokenBreakdown;
  turns: number;
  sessionId?: string;
  error?: string;
  /** Model(s) the stage actually ran on, as reported by the platform (useful when the stage inherits). */
  model?: string;
}

/** What each platform (Claude Agent SDK, Copilot SDK) must implement. */
export interface AgentAdapter {
  readonly target: Target;
  runStage(req: StageRequest): Promise<StageResult>;
  dispose?(): Promise<void>;
}

export interface RunOptions {
  /** Skip human checkpoints between stages (the pre-run cost gate still applies). */
  skipCheckpoints?: boolean;
  /** Start from this stage (earlier stages' reports must already exist). */
  fromStage?: StageId;
  onEvent?: (e: Record<string, unknown>) => void;
}

export interface RunSummary {
  status: "completed" | "stopped" | "failed";
  actuals: StageActual[];
  spentUsd: number;
  approvedUsd: number;
}

class StopRun extends Error {}

/**
 * Runs an approved plan stage by stage with:
 *  - a hard spend ceiling = approved amount (stages get the remaining budget as their cap),
 *  - a soft checkpoint when spend runs ahead of the estimate by more than the tolerance,
 *  - review → implement and failing-test → implement rework loops (bounded),
 *  - optional human checkpoints after stages marked `gateAfter`.
 */
export async function runPipeline(plan: RunPlan, adapter: AgentAdapter, io: GateIO, opts: RunOptions = {}): Promise<RunSummary> {
  if (adapter.target !== plan.target) throw new Error(`Plan target ${plan.target} does not match adapter ${adapter.target}`);
  const store = RunStore.forPlan(plan);
  let approval = store.requireApproval(plan); // throws if not approved or plan changed
  const ledger = new Ledger(plan.repoRoot, plan.config.artifactsDir);
  const stages = enabledStages(plan.config);
  const abort = new AbortController();
  const actuals: StageActual[] = store.loadActuals();
  if (actuals.length && !opts.fromStage) {
    throw new Error(`Run ${plan.runId} already has recorded stages. Continue it with --from <stage>, or plan a new run.`);
  }
  const spent = () => actuals.reduce((a, x) => a + x.usd, 0);
  const emit = (e: Record<string, unknown>) => {
    store.log(e);
    opts.onEvent?.(e);
  };
  const artifacts = new Map<StageId, string>();
  let expectedSoFar = 0;
  let softWarned = false;
  const rounds = new Map<StageId, number>();
  const nextRound = (id: StageId) => {
    // Continue after reports left by an earlier execution of this run (--from) instead of overwriting them.
    const latest = store.latestArtifact(id).match(/\.r(\d+)\.md$/);
    const n = Math.max(rounds.get(id) ?? 0, latest ? Number(latest[1]) : 0) + 1;
    rounds.set(id, n);
    return n;
  };
  const tol = plan.config.budget.overrunTolerance;

  const startIdx = opts.fromStage ? stages.findIndex((s) => s.id === opts.fromStage) : 0;
  if (startIdx < 0) throw new Error(`Stage ${opts.fromStage} is not enabled in this plan`);
  // When continuing a run, the soft checkpoint compares all spend so far with the estimate of the stages already done.
  for (const s of stages.slice(0, startIdx)) {
    if (actuals.some((a) => a.stage === s.id)) expectedSoFar += plan.estimate.stages.find((e) => e.stage === s.id)?.usd.expected ?? 0;
  }
  stages.slice(0, startIdx).forEach((s) => artifacts.set(s.id, store.latestArtifact(s.id)));

  const onSigint = () => abort.abort();
  process.once("SIGINT", onSigint);

  /** Runs one stage invocation, handling budget extension; records actuals. */
  const invoke = async (stage: StageConfig, index: number, iteration: number, feedback?: StagePromptInput["feedback"]): Promise<string> => {
    const role = loadRole(stage.agent);
    const artifactPath = store.artifactPath(stage.id, iteration);
    const prior = [...artifacts.entries()].filter(([id]) => id !== stage.id).map(([, p]) => p).filter(existsSync);
    let resumeSessionId: string | undefined;
    let fb = feedback;
    let stageUsd = 0; // across budget-extension resumes and retries of this invocation
    for (;;) {
      const remaining = approval.approvedUsd - spent();
      if (remaining <= 0.01) {
        const extended = await extendBudget(stage, 0);
        if (!extended) throw new StopRun("approved budget exhausted");
        continue;
      }
      const userPrompt = stageUserPrompt({ plan, stage, role, index, total: stages.length, artifactPath, priorArtifacts: prior, feedback: fb });
      const rm = resolveModel(plan.config, stage, plan.target);
      emit({ type: "stage_start", stage: stage.id, iteration, budgetUsd: remaining, model: rm.label });
      io.print(`\n▶ [${index + 1}/${stages.length}] ${stage.id}${iteration ? ` (round ${iteration})` : ""} · ${stage.agent} · ${rm.label} · cap ${usd(remaining)}`);
      const res = await adapter.runStage({
        plan, stage, role, systemPrompt: stageSystemPrompt(role), userPrompt, artifactPath, runDir: store.dir,
        budgetUsd: remaining, iteration, resumeSessionId, signal: abort.signal,
      });
      if (!Number.isFinite(res.usd) || res.usd < 0) {
        // An unknown cost must never look like "free": stop and make the human look at it.
        res.error = `adapter reported an invalid cost (${res.usd}); treating the approved budget as used`;
        res.usd = Math.max(remaining, 0);
        res.status = "budget_exceeded";
      }
      actuals.push({ stage: stage.id, model: res.model ?? rm.label, usd: res.usd, tokens: res.tokens, turns: res.turns, iteration, status: res.status });
      store.saveActuals(actuals);
      stageUsd += res.usd;
      emit({ type: "stage_end", stage: stage.id, iteration, ...res });
      io.print(`  ${res.status === "ok" ? "✓" : "✗"} ${stage.id}: ${res.status} · ${usd(res.usd)} · ${res.turns} turns · total spent ${usd(spent())} / approved ${usd(approval.approvedUsd)}`);

      if (res.status === "aborted") throw new StopRun("aborted by user");
      if (res.status === "budget_exceeded") {
        const extended = await extendBudget(stage, stageUsd);
        if (!extended) throw new StopRun(`budget exhausted during ${stage.id}`);
        resumeSessionId = res.sessionId;
        fb = { kind: "resume", text: "You were stopped by the budget limit. Continue from where you stopped; do not redo finished work." };
        continue;
      }
      if (res.status === "failed") {
        if (!io.interactive) throw new Error(`Stage ${stage.id} failed: ${res.error ?? "unknown error"}`);
        const a = (await io.ask(`Stage ${stage.id} failed (${res.error ?? "unknown error"}). [r] retry  [s] stop\n> `)).toLowerCase();
        if (a === "r") {
          // Resume the same session when possible so finished work is not paid for twice.
          resumeSessionId = res.sessionId;
          fb = res.sessionId ? { kind: "resume", text: `You stopped before finishing (${res.error ?? "error"}). Continue from where you stopped; do not redo finished work.` } : feedback;
          continue;
        }
        throw new StopRun(`stage ${stage.id} failed`);
      }
      if (iteration === 0) {
        const est = plan.estimate.stages.find((s) => s.stage === stage.id);
        if (est) {
          ledger.record({
            runId: plan.runId, target: plan.target, at: new Date().toISOString(), stage: stage.id, model: res.model ?? rm.priced,
            complexity: plan.estimate.complexity, estimatedUsd: est.usd.expected / (est.calibration || 1), actualUsd: stageUsd,
          });
          expectedSoFar += est.usd.expected;
        }
      }
      await softCheckpoint();
      if (!existsSync(artifactPath)) io.print(`  ⚠ ${stage.agent} did not write its report to ${artifactPath}`);
      return artifactPath;
    }
  };

  const extendBudget = async (stage: StageConfig, stageSpent: number): Promise<boolean> => {
    io.print(`\n⛔ Approved budget reached (${usd(spent())} of ${usd(approval.approvedUsd)}) during ${stage.id} (stage spent ${usd(stageSpent)}).`);
    if (!io.interactive) return false;
    const a = await io.ask("Approve extra USD to continue (e.g. 5), or Enter to stop: ");
    const extra = Number(a);
    if (!(extra > 0)) return false;
    // Base on the approval held in memory, never on whatever approval.json says now.
    approval = store.approve(plan, { extraUsd: extra, baseUsd: approval.approvedUsd, note: `extension during ${stage.id}` });
    emit({ type: "budget_extended", extra, approvedUsd: approval.approvedUsd });
    io.print(`✅ Approved budget is now ${usd(approval.approvedUsd)}.`);
    return true;
  };

  const softCheckpoint = async () => {
    if (softWarned || expectedSoFar <= 0) return;
    if (spent() <= expectedSoFar * (1 + tol)) return;
    softWarned = true;
    io.print(`\n⚠️  Spend ${usd(spent())} is ${Math.round((spent() / expectedSoFar - 1) * 100)}% above the estimate so far (${usd(expectedSoFar)}).`);
    if (!io.interactive) return;
    const a = (await io.ask("[c] continue (hard cap still applies)  [s] stop now\n> ")).toLowerCase();
    if (a === "s") throw new StopRun("stopped at soft checkpoint");
  };

  const checkpoint = async (stage: StageConfig, index: number, path: string): Promise<void> => {
    if (opts.skipCheckpoints || !stage.gateAfter || !io.interactive) return;
    for (;;) {
      const a = (await io.ask(`\n🔍 Checkpoint after ${stage.id}. Review ${path}\n[c] continue  [f] give feedback & redo stage  [s] stop\n> `)).toLowerCase();
      if (a === "c" || a === "") return;
      if (a === "s") throw new StopRun(`stopped by human after ${stage.id}`);
      if (a === "f") {
        const text = await io.ask("Feedback: ");
        path = await invoke(stage, index, nextRound(stage.id), { kind: "human", path, text });
        artifacts.set(stage.id, path);
      }
    }
  };

  const readVerdict = (path: string): Verdict | undefined => (existsSync(path) ? parseVerdict(readFileSync(path, "utf8")) : undefined);
  const warnNoVerdict = (stage: StageConfig, path: string) => {
    if (!readVerdict(path)) io.print(`  ⚠ ${stage.id} report has no VERDICT line (${path}); treating it as passed — check the report.`);
  };

  let status: RunSummary["status"] = "completed";
  try {
    for (let i = startIdx; i < stages.length; i++) {
      const stage = stages[i]!;
      let path = await invoke(stage, i, 0);
      artifacts.set(stage.id, path);

      const implIdx = stages.findIndex((s) => s.id === "implement");
      const impl = stages[implIdx];
      if (stage.id === "review" || stage.id.endsWith("-test")) warnNoVerdict(stage, path);
      if (stage.id === "review" && impl) {
        for (let round = 1; readVerdict(path) === "CHANGES_REQUESTED" && round <= plan.config.review.maxIterations; round++) {
          io.print(`  ↺ Review requested changes — sending back to ${impl.agent} (round ${round}/${plan.config.review.maxIterations})`);
          artifacts.set("implement", await invoke(impl, implIdx, nextRound(impl.id), { kind: "review", path }));
          path = await invoke(stage, i, nextRound(stage.id));
          artifacts.set(stage.id, path);
        }
        if (readVerdict(path) === "CHANGES_REQUESTED") io.print("  ⚠ Review still requests changes after the allowed rounds; continuing — see the release report's open items.");
      }
      if (stage.id.endsWith("-test") && impl) {
        for (let round = 1; readVerdict(path) === "FAIL" && round <= plan.config.test.maxFixIterations; round++) {
          io.print(`  ↺ ${stage.id} found product defects — sending back to ${impl.agent} (round ${round}/${plan.config.test.maxFixIterations})`);
          artifacts.set("implement", await invoke(impl, implIdx, nextRound(impl.id), { kind: "test", path }));
          path = await invoke(stage, i, nextRound(stage.id));
          artifacts.set(stage.id, path);
        }
      }
      await checkpoint(stage, i, path);
    }
  } catch (err) {
    if (err instanceof StopRun) {
      status = "stopped";
      io.print(`\n■ Pipeline stopped: ${err.message}`);
    } else {
      status = "failed";
      io.print(`\n✗ Pipeline failed: ${(err as Error).message}`);
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    await adapter.dispose?.();
  }

  io.print("\n" + renderActuals(plan, actuals));
  io.print(`Reports: ${store.dir}`);
  emit({ type: "run_end", status, spentUsd: spent() });
  return { status, actuals, spentUsd: spent(), approvedUsd: approval.approvedUsd };
}
