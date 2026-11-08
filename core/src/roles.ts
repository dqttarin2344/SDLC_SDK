import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLES_DIR } from "./config.js";
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

function parseFrontmatter(src: string): { meta: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { meta, body: m[2]!.trim() };
}

const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : []);

export function loadRole(name: string, dir = ROLES_DIR): Role {
  const { meta, body } = parseFrontmatter(readFileSync(join(dir, `${name}.md`), "utf8"));
  return {
    name: meta.name ?? name,
    stage: meta.stage as StageId,
    title: meta.title ?? name,
    description: meta.description ?? "",
    claudeTools: list(meta["claude-tools"]),
    copilotTools: list(meta["copilot-tools"]),
    next: meta.next || undefined,
    back: meta.back || undefined,
    body,
  };
}

export function loadRoles(dir = ROLES_DIR): Role[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => loadRole(f.replace(/\.md$/, ""), dir));
}
