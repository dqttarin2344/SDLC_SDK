import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { CONFIG_FILE } from "./config.js";

export interface CopyReport {
  written: string[];
  skipped: string[];
}

/** Copy a directory tree. Existing files are kept unless `force`. */
export function copyTree(src: string, dst: string, force = false, report: CopyReport = { written: [], skipped: [] }, root = dst): CopyReport {
  for (const name of readdirSync(src)) {
    const s = join(src, name);
    const d = join(dst, name);
    if (statSync(s).isDirectory()) {
      copyTree(s, d, force, report, root);
      continue;
    }
    if (existsSync(d) && !force) {
      report.skipped.push(relative(root, d));
      continue;
    }
    mkdirSync(dirname(d), { recursive: true });
    copyFileSync(s, d);
    report.written.push(relative(root, d));
  }
  return report;
}

export function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Append a marked section to a file once (idempotent). */
export function appendSection(path: string, marker: string, content: string): "appended" | "present" | "created" {
  const tag = `<!-- ${marker} -->`;
  if (!existsSync(path)) {
    writeFile(path, `${tag}\n${content.trim()}\n`);
    return "created";
  }
  const cur = readFileSync(path, "utf8");
  if (cur.includes(tag)) return "present";
  writeFileSync(path, `${cur.trimEnd()}\n\n${tag}\n${content.trim()}\n`);
  return "appended";
}

/**
 * Drop a minimal starter sdlc.config.json into a repo if it has none.
 * It deliberately does NOT copy the defaults (models, stages): repo config overrides the defaults,
 * so copying them would freeze today's defaults (and any pinned model) into your repository.
 */
export function ensureRepoConfig(repoRoot: string): boolean {
  const p = join(repoRoot, CONFIG_FILE);
  if (existsSync(p)) return false;
  const starter = {
    $comment:
      "Overrides only; everything omitted uses the SDK defaults. Stages run on your session model ('inherit'). " +
      "To pin a model: stages: [{ id: 'design', model: { claude: 'claude-opus-5-5', copilot: 'claude-opus-5.5' } }]. " +
      "For other models (e.g. DeepSeek) add prices (USD per 1M tokens) and optionally estimateAs.",
    budget: { maxUsd: 25, overrunTolerance: 0.25 },
    test: { commands: {} },
    prices: {},
  };
  writeFile(p, JSON.stringify(starter, null, 2) + "\n");
  return true;
}
