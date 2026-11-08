#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  appendSection,
  copyTree,
  ensureRepoConfig,
  executeCommand,
  PLAN_HELP,
  PLAN_OPTIONS,
  runCommand,
  type PlanFlags,
  type StageId,
} from "@sdlc/core";
import { ClaudeAdapter } from "./adapter.js";
import { generateClaudeAgents } from "./agents.js";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(PKG_ROOT, "template");

const HELP = `sdlc-claude — SDLC agent pipeline on the Claude Agent SDK

Usage:
  sdlc-claude run [requirement] [plan options] [--no-checkpoints] [--quiet]
      Estimate cost → ask for your approval (approve / modify / save / cancel) → run the pipeline.
  sdlc-claude execute <runId|latest> [--from <stage>] [--no-checkpoints]
      Run a plan approved earlier with \`sdlc-estimate approve\`.
  sdlc-claude plan [requirement] [plan options]
      Estimate only (same as \`sdlc-estimate plan --target claude\`).
  sdlc-claude init [--repo <path>] [--force]
      Install .claude/agents, the /sdlc commands, settings and sdlc.config.json into a repository.
  sdlc-claude generate --out <dir>
      Regenerate .claude/agents/*.md from the shared roles.

Auth: uses ANTHROPIC_API_KEY (or your Claude Code login) like the Claude Agent SDK.

${PLAN_HELP}`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      ...PLAN_OPTIONS,
      "no-checkpoints": { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      from: { type: "string" },
      force: { type: "boolean", default: false },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  const repo = resolve(values.repo ?? ".");
  const makeAdapter = () => new ClaudeAdapter({ verbose: !values.quiet });

  switch (values.help ? undefined : cmd) {
    case "run": {
      const summary = await runCommand({ target: "claude", repo, flags: values as PlanFlags, positionals: rest, makeAdapter, skipCheckpoints: values["no-checkpoints"] });
      process.exitCode = summary && summary.status !== "completed" ? 1 : 0;
      return;
    }
    case "execute": {
      const summary = await executeCommand({ target: "claude", repo, runId: rest[0], fromStage: values.from as StageId | undefined, makeAdapter, skipCheckpoints: values["no-checkpoints"] });
      process.exitCode = summary.status === "completed" ? 0 : 1;
      return;
    }
    case "plan": {
      const { spawnSync } = await import("node:child_process");
      const estimate = join(dirname(fileURLToPath(import.meta.resolve("@sdlc/core"))), "cli", "estimate.js");
      const r = spawnSync(process.execPath, [estimate, "plan", "--target", "claude", ...process.argv.slice(3)], { stdio: "inherit" });
      process.exitCode = r.status ?? 1;
      return;
    }
    case "init": {
      const report = copyTree(TEMPLATE, repo, values.force);
      // CLAUDE.md gets a marked section appended; an existing CLAUDE.md is never overwritten.
      const claudeMd = appendSection(join(repo, "CLAUDE.md"), "sdlc-pipeline", readFileSync(join(PKG_ROOT, "CLAUDE.section.md"), "utf8"));
      const cfg = ensureRepoConfig(repo);
      console.log(`Installed into ${repo}`);
      for (const f of report.written) console.log(`  + ${f}`);
      for (const f of report.skipped) console.log(`  = ${f} (exists, kept; use --force to overwrite)`);
      console.log(`  ${claudeMd === "present" ? "=" : "+"} CLAUDE.md (${claudeMd})`);
      if (cfg) console.log("  + sdlc.config.json");
      console.log("\nNext: install the CLIs in that repo (npm i -D <path>/packages/core <path>/packages/claude), then in Claude Code run:  /sdlc <your requirement>");
      return;
    }
    case "generate": {
      const out = resolve(values.out ?? ".");
      for (const f of generateClaudeAgents(out, repo)) console.log(`  + ${f}`);
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(`sdlc-claude: ${(e as Error).message}`);
  process.exit(1);
});
