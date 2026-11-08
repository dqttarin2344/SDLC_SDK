import type { StageId } from "./types.js";
/**
 * A role is one agent persona (analyst, developer, reviewer, ...).
 * Roles live in packages/core/roles/<name>.md and are the single source of truth:
 * the Claude adapter turns them into .claude/agents/*.md and the Copilot adapter
 * into .github/agents/*.agent.md.
 */
export interface Role {
    name: string;
    stage: StageId;
    title: string;
    description: string;
    claudeTools: string[];
    copilotTools: string[];
    /** Next agent in the pipeline (for Copilot handoff buttons). */
    next?: string;
    /** Agent to send work back to (e.g. reviewer -> developer). */
    back?: string;
    body: string;
}
export declare function loadRole(name: string, dir?: string): Role;
export declare function loadRoles(dir?: string): Role[];
