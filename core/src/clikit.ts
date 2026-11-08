import { approvalGate } from "./approval.js";
import { applyPlanFlags, readRequirement, type PlanFlags } from "./cliopts.js";
import { applyMode, loadConfig } from "./config.js";
import { TerminalIO, type GateIO } from "./io.js";
import { runPipeline, type AgentAdapter, type RunSummary } from "./orchestrator.js";
import { createPlan, RunStore } from "./plan.js";
import { usd } from "./render.js";
import type { StageId, Target } from "./types.js";

export interface RunCommandOptions {
  target: Target;
  repo: string;
  flags: PlanFlags;
  positionals: string[];
  makeAdapter: () => AgentAdapter | Promise<AgentAdapter>;
  skipCheckpoints?: boolean;
  io?: GateIO;
}

/** plan → estimate → human approval gate → run. Nothing executes without approval. */
export async function runCommand(o: RunCommandOptions): Promise<RunSummary | undefined> {
  const io = o.io ?? new TerminalIO();
  const requirement = readRequirement(o.flags, o.positionals);
  const config = applyPlanFlags(applyMode(loadConfig(o.repo)), o.flags, o.target);
  const plan = createPlan({ target: o.target, requirement, repoRoot: o.repo, config });
  const gate = await approvalGate(plan, io);
  if (gate.decision === "cancelled") {
    io.print("Cancelled. Nothing was run.");
    return undefined;
  }
  if (gate.decision === "saved") {
    io.print(`Plan saved, not run. Later: sdlc-estimate approve ${gate.plan.runId}  then  sdlc-${o.target} execute ${gate.plan.runId}`);
    return undefined;
  }
  return runPipeline(gate.plan, await o.makeAdapter(), io, { skipCheckpoints: o.skipCheckpoints });
}

export interface ExecuteCommandOptions {
  target: Target;
  repo: string;
  runId?: string;
  fromStage?: StageId;
  makeAdapter: () => AgentAdapter | Promise<AgentAdapter>;
  skipCheckpoints?: boolean;
  io?: GateIO;
}

/** Execute a plan that was approved earlier (e.g. `sdlc-estimate approve` in CI or from an IDE chat). */
export async function executeCommand(o: ExecuteCommandOptions): Promise<RunSummary> {
  const io = o.io ?? new TerminalIO();
  const cfg = loadConfig(o.repo);
  const runId = !o.runId || o.runId === "latest" ? RunStore.latest(o.repo, cfg.artifactsDir) : o.runId;
  if (!runId) throw new Error("No runs found.");
  const store = new RunStore(o.repo, runId, cfg.artifactsDir);
  const plan = store.loadPlan();
  const approval = store.requireApproval(plan);
  io.print(`Executing run ${runId} (approved up to ${usd(approval.approvedUsd)} by ${approval.approvedBy}).`);
  return runPipeline(plan, await o.makeAdapter(), io, { skipCheckpoints: o.skipCheckpoints, fromStage: o.fromStage });
}
