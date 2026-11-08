import { join } from "node:path";
import { isInherit, loadConfig, loadRoles, stageSystemPrompt, writeFile, type Role, type SdlcConfig } from "@sdlc/core";

/** Claude Code subagent frontmatter accepts aliases; aliases track the newest model of each tier. */
export function claudeAlias(model: string): string {
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  if (model.includes("haiku")) return "haiku";
  return model;
}

export function claudeAgentMarkdown(role: Role, cfg: SdlcConfig): string {
  const stage = cfg.stages.find((s) => s.id === role.stage);
  // "inherit" keeps the subagent on whatever model the session uses (Claude, or DeepSeek etc. via ANTHROPIC_BASE_URL).
  const model = stage && !isInherit(stage.model.claude) ? stage.model.claude : "inherit";
  return [
    "---",
    `name: ${role.name}`,
    `description: ${role.description}`,
    `tools: ${role.claudeTools.join(", ")}`,
    `model: ${model}`,
    "---",
    "",
    stageSystemPrompt(role),
    "",
  ].join("\n");
}

/** Writes .claude/agents/*.md for every role into `outDir`. */
export function generateClaudeAgents(outDir: string, repoRoot = process.cwd()): string[] {
  const cfg = loadConfig(repoRoot);
  return loadRoles().map((role) => {
    const p = join(outDir, ".claude", "agents", `${role.name}.md`);
    writeFile(p, claudeAgentMarkdown(role, cfg));
    return p;
  });
}
