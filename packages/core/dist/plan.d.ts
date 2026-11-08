import type { Approval, RunPlan, SdlcConfig, StageActual, StageId, Target } from "./types.js";
export declare function newRunId(now?: Date): string;
export interface CreatePlanInput {
    target: Target;
    requirement: string;
    repoRoot: string;
    overrides?: Partial<SdlcConfig>;
    /** Use an already-loaded config (e.g. after edits in the approval menu). */
    config?: SdlcConfig;
    runId?: string;
}
/** Scan the repo, estimate cost and build a plan (does not write anything). */
export declare function createPlan(input: CreatePlanInput): RunPlan;
/** Where the approval-signing key lives: outside the repository, so agents working in the repo cannot forge approvals. */
export declare function approvalKeyPath(): string;
export declare function approvalSignatureValid(a: Approval): boolean;
/** Hash of everything an approval covers. Changing any of it invalidates the approval. */
export declare function planHash(plan: RunPlan): string;
export declare class RunStore {
    readonly repoRoot: string;
    readonly runId: string;
    readonly dir: string;
    constructor(repoRoot: string, runId: string, artifactsDir?: string);
    static forPlan(plan: RunPlan): RunStore;
    static latest(repoRoot: string, artifactsDir?: string): string | undefined;
    private file;
    savePlan(plan: RunPlan): void;
    loadPlan(): RunPlan;
    approvals(): Approval[];
    /**
     * Records a human approval, signed with the key outside the repo.
     * `extraUsd` > 0 records a budget extension. `baseUsd` is the amount the caller already holds in memory
     * (the orchestrator passes it so a tampered approval.json cannot inflate an extension).
     */
    approve(plan: RunPlan, opts?: {
        by?: string;
        note?: string;
        extraUsd?: number;
        baseUsd?: number;
    }): Approval;
    /** Returns the current approval, or throws if the plan was never approved or changed after approval. */
    requireApproval(plan: RunPlan): Approval;
    saveActuals(actuals: StageActual[]): void;
    loadActuals(): StageActual[];
    /** Report path. Numbers are fixed per stage (01-requirements … 09-release) so every flow agrees on names. */
    artifactPath(stage: StageId, iteration?: number): string;
    /** Newest existing report of a stage (highest rework round), or the base path. */
    latestArtifact(stage: StageId): string;
    log(event: Record<string, unknown>): void;
}
