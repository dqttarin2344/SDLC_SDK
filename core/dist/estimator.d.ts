import type { Complexity, PipelineEstimate, RepoStats, SdlcConfig, StageId, StageProfile, Target, TokenBreakdown } from "./types.js";
/**
 * Built-in token profiles. They model an agent loop with prompt caching:
 * every turn re-sends the whole context (mostly cache reads), new context is
 * written to cache once, and each turn produces some output.
 * Tune them per repo via `profiles` in sdlc.config.json, or let the ledger calibrate them.
 */
export declare const DEFAULT_PROFILES: Record<StageId, StageProfile>;
export declare function detectComplexity(requirement: string, repo: RepoStats, mode: SdlcConfig["mode"]): Complexity;
/** Token usage of one agent loop with `turns` round-trips. */
export declare function loopTokens(turns: number, startContext: number, growth: number, outputPerTurn: number): TokenBreakdown & {
    peakContext: number;
};
export interface EstimateInput {
    target: Target;
    requirement: string;
    repo: RepoStats;
    config: SdlcConfig;
    /** Per-stage calibration multipliers from the ledger (actual / estimated). */
    calibration?: Partial<Record<StageId, number>>;
}
export declare function estimatePipeline(input: EstimateInput): PipelineEstimate;
