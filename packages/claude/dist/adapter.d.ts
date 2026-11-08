import { type AgentAdapter, type StageRequest, type StageResult } from "@sdlc/core";
export interface ClaudeAdapterOptions {
    /** Print a short line per tool call. Default true. */
    verbose?: boolean;
    /** Extra Claude Agent SDK settings sources. Default ["project"] (loads CLAUDE.md, .claude/settings.json). */
    settingSources?: Array<"user" | "project" | "local">;
    log?: (line: string) => void;
}
/** Runs one SDLC stage as a Claude Agent SDK `query()` with a hard USD budget. */
export declare class ClaudeAdapter implements AgentAdapter {
    private opts;
    readonly target: "claude";
    /** Last cumulative cost seen per SDK session: a resumed session reports the running total, not the delta. */
    private sessionCost;
    constructor(opts?: ClaudeAdapterOptions);
    runStage(req: StageRequest): Promise<StageResult>;
}
