import { applyMode, estimateModel } from "./config.js";
import { createPlan, RunStore } from "./plan.js";
import { PRESETS, STAGE_WEIGHT, priceTable } from "./pricing.js";
import { renderEstimate, usd } from "./render.js";
/**
 * Pre-run cost gate. Shows the estimate and loops until the human approves,
 * saves the plan for later, or cancels. "Modify" edits the plan and re-estimates.
 * Nothing runs unless this returns `approved`.
 */
export async function approvalGate(initial, io) {
    let plan = initial;
    const store = RunStore.forPlan(plan);
    for (;;) {
        store.savePlan(plan);
        io.print(renderEstimate(plan));
        io.print(`Saved: ${store.dir}/estimate.md`);
        if (!io.interactive) {
            io.print(`\nNo interactive terminal: plan saved, not approved. Approve with:  sdlc-estimate approve ${plan.runId}`);
            return { decision: "saved", plan };
        }
        const canApprove = plan.estimate.withinBudget;
        const choice = (await io.ask(`\n${canApprove ? "[a] Approve & run   " : ""}[m] Modify plan   [s] Save & exit (approve later)   [c] Cancel\n> `)).toLowerCase();
        if (choice === "a" && canApprove) {
            const note = await io.ask("Approval note (optional, Enter to skip): ");
            const approval = store.approve(plan, { note: note || undefined });
            io.print(`✅ Approved up to ${usd(approval.approvedUsd)} (hash ${approval.planHash}).`);
            store.log({ type: "approved", approval });
            return { decision: "approved", plan, approval };
        }
        if (choice === "a") {
            io.print("⚠️  Cannot approve: the high estimate exceeds the budget cap. Modify the plan or raise the budget.");
            continue;
        }
        if (choice === "s")
            return { decision: "saved", plan };
        if (choice === "c") {
            store.log({ type: "cancelled" });
            return { decision: "cancelled", plan };
        }
        if (choice === "m") {
            const cfg = await modifyMenu(plan, io);
            if (cfg)
                plan = createPlan({ target: plan.target, requirement: plan.requirement, repoRoot: plan.repoRoot, config: cfg, runId: plan.runId });
        }
    }
}
async function modifyMenu(plan, io) {
    const cfg = structuredClone(plan.config);
    const t = plan.target;
    io.print([
        "",
        "Modify plan:",
        "  1) Change the model of a stage",
        "  2) Enable / disable stages",
        "  3) Apply a model preset (economy / balanced / quality)",
        "  4) Set complexity (auto / S / M / L / XL)",
        "  5) Set budget cap (USD)",
        "  6) Set review iterations / test-fix iterations",
        "  7) Set work mode (feature / modify / bugfix)",
        "  0) Back",
    ].join("\n"));
    const c = await io.ask("> ");
    switch (c) {
        case "1": {
            const enabled = cfg.stages.filter((s) => s.enabled);
            enabled.forEach((s, i) => io.print(`  ${i + 1}) ${s.id.padEnd(17)} ${s.model[t]}`));
            const idx = Number(await io.ask("Stage number: ")) - 1;
            const stage = enabled[idx];
            if (!stage)
                return undefined;
            const table = priceTable(t);
            const models = ["inherit", ...Object.keys(table)];
            io.print(`  1) ${"inherit".padEnd(20)} your session's model, priced as ${estimateModel(cfg, t)}`);
            models.slice(1).forEach((m, i) => io.print(`  ${i + 2}) ${m.padEnd(20)} in $${table[m].input}/M · out $${table[m].output}/M`));
            const pick = await io.ask("Model number or id: ");
            const model = models[Number(pick) - 1] ?? (models.includes(pick) ? pick : undefined);
            if (!model) {
                io.print("Unknown model.");
                return undefined;
            }
            stage.model[t] = model;
            return cfg;
        }
        case "2": {
            cfg.stages.forEach((s, i) => io.print(`  ${i + 1}) [${s.enabled ? "x" : " "}] ${s.id}`));
            const nums = (await io.ask("Numbers to toggle (comma separated): ")).split(",").map((n) => Number(n.trim()) - 1);
            for (const n of nums)
                if (cfg.stages[n])
                    cfg.stages[n].enabled = !cfg.stages[n].enabled;
            if (!cfg.stages.some((s) => s.enabled)) {
                io.print("At least one stage must stay enabled.");
                return undefined;
            }
            return cfg;
        }
        case "3": {
            const name = (await io.ask(`Preset (inherit / ${Object.keys(PRESETS).join(" / ")}): `)).toLowerCase();
            if (name === "inherit") {
                for (const s of cfg.stages)
                    s.model[t] = "inherit";
                return cfg;
            }
            const preset = PRESETS[name]?.[t];
            if (!preset)
                return undefined;
            for (const s of cfg.stages)
                s.model[t] = preset[STAGE_WEIGHT[s.id] ?? "standard"];
            return cfg;
        }
        case "4": {
            const v = (await io.ask("Complexity (auto/S/M/L/XL): ")).toUpperCase();
            if (v === "AUTO")
                cfg.complexity = "auto";
            else if (["S", "M", "L", "XL"].includes(v))
                cfg.complexity = v;
            else
                return undefined;
            return cfg;
        }
        case "5": {
            const v = Number(await io.ask(`Budget cap in USD (now ${cfg.budget.maxUsd}): `));
            if (!(v > 0))
                return undefined;
            cfg.budget.maxUsd = v;
            return cfg;
        }
        case "6": {
            const r = Number(await io.ask(`Max review rounds (now ${cfg.review.maxIterations}): `));
            const f = Number(await io.ask(`Max test-fix rounds per test stage (now ${cfg.test.maxFixIterations}): `));
            if (Number.isInteger(r) && r >= 0)
                cfg.review.maxIterations = r;
            if (Number.isInteger(f) && f >= 0)
                cfg.test.maxFixIterations = f;
            return cfg;
        }
        case "7": {
            const m = (await io.ask("Mode (feature/modify/bugfix): ")).toLowerCase();
            if (!["feature", "modify", "bugfix"].includes(m))
                return undefined;
            cfg.mode = m;
            return applyMode(cfg);
        }
        default:
            return undefined;
    }
}
//# sourceMappingURL=approval.js.map