import { type Role, type SdlcConfig } from "@sdlc/core";
/** Claude Code subagent frontmatter accepts aliases; aliases track the newest model of each tier. */
export declare function claudeAlias(model: string): string;
export declare function claudeAgentMarkdown(role: Role, cfg: SdlcConfig): string;
/** Writes .claude/agents/*.md for every role into `outDir`. */
export declare function generateClaudeAgents(outDir: string, repoRoot?: string): string[];
