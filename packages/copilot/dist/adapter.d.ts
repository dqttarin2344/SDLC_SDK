import { type AgentAdapter, type StageRequest, type StageResult } from "@sdlc/core";
export interface CopilotAdapterOptions {
    verbose?: boolean;
    /** Per-stage timeout in ms (default 60 min). */
    timeoutMs?: number;
    log?: (line: string) => void;
}
/**
 * Runs one SDLC stage as a GitHub Copilot SDK session.
 * The Copilot SDK has no built-in USD cap, so spend is computed from `assistant.usage`
 * events with the Copilot price table and the session is aborted when it reaches the stage budget.
 */
export declare class CopilotAdapter implements AgentAdapter {
    private opts;
    readonly target: "copilot";
    private client?;
    constructor(opts?: CopilotAdapterOptions);
    private getClient;
    runStage(req: StageRequest): Promise<StageResult>;
    dispose(): Promise<void>;
    /** Models available to the signed-in Copilot account. */
    listModels(): Promise<Array<{
        id: string;
        name?: string;
    }>>;
}
