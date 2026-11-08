import { type Role, type SdlcConfig } from "@sdlc/core";
/** "claude-sonnet-5.5" → "Claude Sonnet 5.5 (copilot)", the model naming VS Code agent files use. */
export declare function vscodeModelName(id: string): string;
export declare function copilotAgentMarkdown(role: Role, cfg: SdlcConfig, roles: Role[]): string;
export declare function plannerAgentMarkdown(): string;
/** Writes .github/agents/*.agent.md (planner + one agent per role) into `outDir`. */
export declare function generateCopilotAgents(outDir: string, repoRoot?: string): string[];
