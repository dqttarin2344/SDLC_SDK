#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { appendSection, copyTree, ensureRepoConfig, executeCommand, PLAN_HELP, PLAN_OPTIONS, priceTable, runCommand, } from "@sdlc/core";
import { CopilotAdapter } from "./adapter.js";
import { generateCopilotAgents } from "./agents.js";
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(PKG_ROOT, "template");
const HELP = `sdlc-copilot — SDLC agent pipeline on the GitHub Copilot SDK

Usage:
  sdlc-copilot run [requirement] [plan options] [--no-checkpoints] [--quiet]
      Estimate cost (USD + AI credits) → ask for your approval → run the pipeline.
  sdlc-copilot execute <runId|latest> [--from <stage>] [--no-checkpoints]
      Run a plan approved earlier with \`sdlc-estimate approve\`.
  sdlc-copilot plan [requirement] [plan options]
      Estimate only (same as \`sdlc-estimate plan --target copilot\`).
  sdlc-copilot models
      Models your Copilot account can use, marked with whether the estimator has a price for them.
  sdlc-copilot init [--repo <path>] [--force]
      Install .github/agents, prompt files and instructions into a repository.
  sdlc-copilot generate --out <dir>
      Regenerate .github/agents/*.agent.md from the shared roles.

Auth: the Copilot SDK uses your signed-in GitHub Copilot CLI account (or GH_TOKEN / GITHUB_TOKEN).

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
    const makeAdapter = () => new CopilotAdapter({ verbose: !values.quiet });
    switch (values.help ? undefined : cmd) {
        case "run": {
            const summary = await runCommand({ target: "copilot", repo, flags: values, positionals: rest, makeAdapter, skipCheckpoints: values["no-checkpoints"] });
            process.exitCode = summary && summary.status !== "completed" ? 1 : 0;
            return;
        }
        case "execute": {
            const summary = await executeCommand({ target: "copilot", repo, runId: rest[0], fromStage: values.from, makeAdapter, skipCheckpoints: values["no-checkpoints"] });
            process.exitCode = summary.status === "completed" ? 0 : 1;
            return;
        }
        case "plan": {
            const { spawnSync } = await import("node:child_process");
            const estimate = join(dirname(fileURLToPath(import.meta.resolve("@sdlc/core"))), "cli", "estimate.js");
            const r = spawnSync(process.execPath, [estimate, "plan", "--target", "copilot", ...process.argv.slice(3)], { stdio: "inherit" });
            process.exitCode = r.status ?? 1;
            return;
        }
        case "models": {
            const adapter = makeAdapter();
            try {
                const priced = priceTable("copilot");
                for (const m of await adapter.listModels())
                    console.log(`${m.id.padEnd(24)} ${priced[m.id] ? "priced" : "NO PRICE — add to SDLC_PRICING_FILE"}  ${m.name ?? ""}`);
            }
            finally {
                await adapter.dispose();
            }
            return;
        }
        case "init": {
            const report = copyTree(TEMPLATE, repo, values.force);
            const instr = appendSection(join(repo, ".github", "copilot-instructions.md"), "sdlc-pipeline", readFileSync(join(PKG_ROOT, "copilot-instructions.section.md"), "utf8"));
            const cfg = ensureRepoConfig(repo);
            console.log(`Installed into ${repo}`);
            for (const f of report.written)
                console.log(`  + ${f}`);
            for (const f of report.skipped)
                console.log(`  = ${f} (exists, kept; use --force to overwrite)`);
            console.log(`  ${instr === "present" ? "=" : "+"} .github/copilot-instructions.md (${instr})`);
            if (cfg)
                console.log("  + sdlc.config.json");
            console.log("\nNext: install the CLIs in that repo (npm i -D <path>/packages/core <path>/packages/copilot), then in Copilot Chat run:  /sdlc <your requirement>");
            return;
        }
        case "generate": {
            const out = resolve(values.out ?? ".");
            for (const f of generateCopilotAgents(out, repo))
                console.log(`  + ${f}`);
            return;
        }
        default:
            console.log(HELP);
    }
}
main().catch((e) => {
    console.error(`sdlc-copilot: ${e.message}`);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map