import type { RepoStats } from "./types.js";
/** Rough token estimate (≈4 chars/token for code and English). */
export declare function estimateTokens(text: string): number;
export declare function scanRepo(root: string, extraIgnore?: string[]): RepoStats;
