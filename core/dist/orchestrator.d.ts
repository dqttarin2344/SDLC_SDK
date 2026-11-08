import type { GateIO } from "./io.js";
import { type Role } from "./roles.js";
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
/**
 * Runs an approved plan stage by stage with:
 *  - a hard spend ceiling = approved amount (stages get the remaining budget as their cap),
 *  - a soft checkpoint when spend runs ahead of the estimate by more than the tolerance,
 *  - review → implement and failing-test → implement rework loops (bounded),
 *  - optional human checkpoints after stages marked `gateAfter`.
 */
export declare function runPipeline(plan: RunPlan, adapter: AgentAdapter, io: GateIO, opts?: RunOptions): Promise<RunSummary>;
