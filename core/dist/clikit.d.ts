import { type PlanFlags } from "./cliopts.js";
import { type GateIO } from "./io.js";
import { type AgentAdapter, type RunSummary } from "./orchestrator.js";
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
export declare function runCommand(o: RunCommandOptions): Promise<RunSummary | undefined>;
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
export declare function executeCommand(o: ExecuteCommandOptions): Promise<RunSummary>;
