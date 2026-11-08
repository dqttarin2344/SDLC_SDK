#!/usr/bin/env node
/**
 * sdlc-estimate — platform-neutral planning CLI.
 * Used directly, and by the IDE flows (Claude Code /sdlc command, Copilot sdlc-planner agent)
 * which cannot show an interactive terminal menu: they call `plan --json`, show the table in chat,
 * and call `approve` only after the human says yes.
 */
import { parseArgs } from "node:util";
import { applyMode, estimateModel, loadConfig } from "../config.js";
import { applyPlanFlags, PLAN_HELP, PLAN_OPTIONS, readRequirement } from "../cliopts.js";
import { Ledger } from "../ledger.js";
import { createPlan, planHash, RunStore } from "../plan.js";
import { costUsd, getPrice, priceTable } from "../pricing.js";
import { checkCommand, checkReadPath, checkWritePathIde } from "../guard.js";
import { readFileSync } from "node:fs";
import { renderActuals, renderEstimate, renderEstimateMarkdown, usd } from "../render.js";
const HELP = `sdlc-estimate — estimate, approve and track SDLC pipeline runs

Usage:
  sdlc-estimate plan [requirement] --target claude|copilot [options] [--json|--markdown]
  sdlc-estimate approve <runId|latest> [--extra <usd>] [--note <text>] [--by <name>]
                                               --extra adds budget to an existing approval (extension)
  sdlc-estimate verify <runId|latest>          exit 0 only if approved and unchanged
  sdlc-estimate status <runId|latest>
  sdlc-estimate record <runId|latest> --stage <id> (--usd <amount> | --tokens <n>) [--turns n]
                                               record actual spend (IDE mode) for calibration;
                                               --tokens converts total tokens to approximate USD
  sdlc-estimate models --target claude|copilot
  sdlc-estimate guard-hook                     Claude Code PreToolUse hook (reads the hook JSON on stdin)

${PLAN_HELP}`;
function fail(msg) {
    process.stderr.write(`sdlc-estimate: ${msg}\n`);
    process.exit(1);
}
async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            ...PLAN_OPTIONS,
            target: { type: "string", short: "t", default: "claude" },
            json: { type: "boolean", default: false },
            markdown: { type: "boolean", default: false },
            note: { type: "string" },
            by: { type: "string" },
            stage: { type: "string" },
            usd: { type: "string" },
            turns: { type: "string" },
            tokens: { type: "string" },
            extra: { type: "string" },
            help: { type: "boolean", short: "h" },
        },
    });
    const [cmd, ...rest] = positionals;
    if (values.help || !cmd) {
        process.stdout.write(HELP + "\n");
        return;
    }
    const target = values.target;
    if (target !== "claude" && target !== "copilot")
        fail("--target must be claude or copilot");
    const repo = values.repo;
    const cfg = loadConfig(repo);
    const resolveRun = (id) => {
        const runId = !id || id === "latest" ? RunStore.latest(repo, cfg.artifactsDir) : id;
        if (!runId)
            fail("no runs found; create one with `sdlc-estimate plan`");
        const store = new RunStore(repo, runId, cfg.artifactsDir);
        return { store, plan: store.loadPlan() };
    };
    switch (cmd) {
        case "plan": {
            const requirement = readRequirement(values, rest);
            const config = applyPlanFlags(applyMode(cfg), values, target);
            const plan = createPlan({ target, requirement, repoRoot: repo, config });
            const store = RunStore.forPlan(plan);
            store.savePlan(plan);
            if (values.json) {
                process.stdout.write(JSON.stringify({ runId: plan.runId, runDir: store.dir, planHash: planHash(plan), estimate: plan.estimate }, null, 2) + "\n");
            }
            else if (values.markdown) {
                process.stdout.write(renderEstimateMarkdown(plan) + `\nRun dir: \`${store.dir}\`\n`);
            }
            else {
                process.stdout.write(renderEstimate(plan) + `\n\nSaved to ${store.dir}\nApprove with: sdlc-estimate approve ${plan.runId}\n`);
            }
            return;
        }
        case "approve": {
            const { store, plan } = resolveRun(rest[0]);
            if (!plan.estimate.withinBudget)
                fail(`high estimate ${usd(plan.estimate.totalUsd.high)} exceeds budget ${usd(plan.estimate.budget.maxUsd)}; re-plan with a higher --budget or a cheaper --preset`);
            const extra = values.extra === undefined ? undefined : Number(values.extra);
            if (extra !== undefined && !(extra > 0))
                fail("--extra must be a positive number of USD");
            const a = store.approve(plan, { by: values.by, note: values.note, extraUsd: extra });
            process.stdout.write(`Approved run ${plan.runId} up to ${usd(a.approvedUsd)} (hash ${a.planHash}).\n`);
            return;
        }
        case "verify": {
            const { store, plan } = resolveRun(rest[0]);
            try {
                const a = store.requireApproval(plan);
                process.stdout.write(`OK: run ${plan.runId} approved up to ${usd(a.approvedUsd)} by ${a.approvedBy} at ${a.approvedAt}\n`);
            }
            catch (e) {
                fail(e.message);
            }
            return;
        }
        case "status": {
            const { store, plan } = resolveRun(rest[0]);
            const approvals = store.approvals();
            process.stdout.write(renderEstimate(plan) + "\n");
            process.stdout.write(approvals.length ? `Approved up to ${usd(approvals[approvals.length - 1].approvedUsd)} (${approvals.length} approval record(s))\n` : "Not approved yet.\n");
            const actuals = store.loadActuals();
            if (actuals.length)
                process.stdout.write(renderActuals(plan, actuals) + "\n");
            return;
        }
        case "record": {
            const { store, plan } = resolveRun(rest[0]);
            const stage = values.stage;
            if (!stage || !plan.config.stages.some((s) => s.id === stage))
                fail("record needs --stage <id> of a stage in this plan");
            const est = plan.estimate.stages.find((s) => s.stage === stage);
            let amount = Number(values.usd);
            if (values.tokens && values.usd === undefined) {
                // IDE agents report total tokens only. Blend: 85% cache reads, 5% cache writes, 10% output.
                const n = Number(values.tokens);
                const price = getPrice(plan.target, est?.model ?? "");
                amount = costUsd(price, { input: 0, cacheRead: n * 0.85, cacheWrite: n * 0.05, output: n * 0.1 });
            }
            if (!stage || !(amount >= 0))
                fail("record needs --stage and --usd or --tokens");
            const actuals = store.loadActuals();
            const iteration = actuals.filter((a) => a.stage === stage).length;
            actuals.push({ stage, model: est?.model ?? "?", usd: amount, turns: Number(values.turns ?? 0), iteration, status: "ok", tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } });
            store.saveActuals(actuals);
            if (est && iteration === 0) {
                new Ledger(repo, cfg.artifactsDir).record({ runId: plan.runId, target: plan.target, at: new Date().toISOString(), stage, model: est.model, complexity: plan.estimate.complexity, estimatedUsd: est.usd.expected / (est.calibration || 1), actualUsd: amount });
            }
            const spent = actuals.reduce((s, a) => s + a.usd, 0);
            const approved = store.approvals().at(-1)?.approvedUsd ?? 0;
            process.stdout.write(`Recorded ${usd(amount)} for ${stage}. Spent ${usd(spent)} of approved ${usd(approved)}.\n`);
            if (approved && spent > approved) {
                process.stdout.write("OVER_BUDGET: spend exceeds the approved amount — stop and ask the human before continuing.\n");
                process.exit(2);
            }
            return;
        }
        case "guard-hook": {
            // Claude Code PreToolUse hook. Exit 2 blocks the tool call and shows stderr to the model.
            const input = JSON.parse(readFileSync(0, "utf8") || "{}");
            const root = process.env.CLAUDE_PROJECT_DIR ?? input.cwd ?? process.cwd();
            const tool = input.tool_name ?? "";
            const ti = input.tool_input ?? {};
            let decision = { allow: true };
            if (tool === "Bash") {
                const cmd = String(ti.command ?? "");
                if (/\bsdlc-estimate\s+approve\b/.test(cmd) && !/[;&|`$<>]/.test(cmd.replace(/<<'?SDLC_REQ\w*'?[\s\S]*$/, ""))) {
                    // Approving spends money: always ask the human, even if a permission rule allows it.
                    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "Approving an SDLC budget needs your confirmation." } }));
                    return;
                }
                if (/\bsdlc-estimate\s+record\b/.test(cmd) && !/[;&|`$<>]/.test(cmd))
                    return; // orchestrator bookkeeping
                decision = checkCommand(cmd, "write");
            }
            else if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
                decision = checkWritePathIde(String(ti.file_path ?? ti.notebook_path ?? ""), root, cfg.artifactsDir);
            }
            else if (tool === "Read") {
                decision = checkReadPath(String(ti.file_path ?? ""));
            }
            if (!decision.allow) {
                process.stderr.write(`${decision.reason}\n`);
                process.exit(2);
            }
            return;
        }
        case "models": {
            const table = priceTable(target);
            process.stdout.write(`inherit                use the model of your session (priced as estimateAs: ${estimateModel(cfg, target)})\n`);
            for (const [m, p] of Object.entries(table))
                process.stdout.write(`${m.padEnd(22)} in $${p.input}/M  out $${p.output}/M  cache-read $${p.cacheRead}/M\n`);
            return;
        }
        default:
            fail(`unknown command "${cmd}". See --help.`);
    }
}
main().catch((e) => fail(e.message));
//# sourceMappingURL=estimate.js.map