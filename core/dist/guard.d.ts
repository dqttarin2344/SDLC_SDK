import type { StageAccess } from "./types.js";
export interface GuardDecision {
    allow: boolean;
    reason?: string;
}
export interface CommandGuardOptions {
    /** Extra command prefixes allowed in read-only stages (e.g. the configured test commands). */
    readOnlyAllow?: string[];
}
export declare function checkCommand(cmd: string, access: StageAccess, opts?: CommandGuardOptions): GuardDecision;
/**
 * Where a stage may write.
 *  - Every stage: Markdown reports inside its own run directory; never the run's JSON bookkeeping,
 *    other runs, the ledger, .git, .env files, sdlc.config.json, or anything outside the repo.
 *  - Read-only stages: nothing else.
 *  - Write stages: the rest of the repository.
 */
export declare function checkWritePath(path: string, access: StageAccess, repoRoot: string, runDir: string): GuardDecision;
/**
 * Write rules for IDE sessions (Claude Code hook), where the stage is unknown:
 * stay in the repo, never touch .git/.env/config, and leave pipeline bookkeeping (JSON) to sdlc-estimate.
 */
export declare function checkWritePathIde(path: string, repoRoot: string, artifactsDir?: string): GuardDecision;
/** Reads agents must not make (secrets). */
export declare function checkReadPath(path: string): GuardDecision;
