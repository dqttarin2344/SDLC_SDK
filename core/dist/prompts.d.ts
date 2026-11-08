import type { Role } from "./roles.js";
import type { RunPlan, StageConfig } from "./types.js";
export interface StagePromptInput {
    plan: RunPlan;
    stage: StageConfig;
    role: Role;
    index: number;
    total: number;
    artifactPath: string;
    priorArtifacts: string[];
    /** Report the agent must act on (review findings / failing tests / human feedback). */
    feedback?: {
        kind: "review" | "test" | "human" | "resume";
        path?: string;
        text?: string;
    };
}
/** System-prompt addition: the role persona plus pipeline-wide rules. */
export declare function stageSystemPrompt(role: Role): string;
/** The user prompt for one stage run. */
export declare function stageUserPrompt(i: StagePromptInput): string;
export type Verdict = "APPROVED" | "CHANGES_REQUESTED" | "PASS" | "FAIL";
/** Last `VERDICT:` line in a report, if any. */
export declare function parseVerdict(report: string): Verdict | undefined;
