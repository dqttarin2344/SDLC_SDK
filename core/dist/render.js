import { COPILOT_PLAN_CREDITS } from "./pricing.js";
export const usd = (n) => (n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`);
const k = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
function table(rows) {
    const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => (r[c] ?? "").length)));
    const line = (r) => "│ " + r.map((cell, c) => cell.padEnd(widths[c])).join(" │ ") + " │";
    const sep = (l, m, r) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
    return [sep("┌", "┬", "┐"), line(rows[0]), sep("├", "┼", "┤"), ...rows.slice(1, -1).map(line), sep("├", "┼", "┤"), line(rows[rows.length - 1]), sep("└", "┴", "┘")].join("\n");
}
/** Human-readable estimate for the terminal. */
export function renderEstimate(plan) {
    const e = plan.estimate;
    const rows = [["#", "Stage", "Agent", "Model", "Turns", "Tokens in/cache/out", "Low", "Expected", "High"]];
    e.stages.forEach((s, i) => {
        rows.push([
            String(i + 1),
            s.stage,
            s.agent,
            s.inherited ? `inherit≈${s.model}` : s.model,
            `${s.turns.low}-${s.turns.high}`,
            `${k(s.tokens.input + s.tokens.cacheWrite)}/${k(s.tokens.cacheRead)}/${k(s.tokens.output)}`,
            usd(s.usd.low),
            usd(s.usd.expected),
            usd(s.usd.high),
        ]);
    });
    rows.push(["", "rework loops", "", "", "", "", usd(e.rework.low), usd(e.rework.expected), usd(e.rework.high)]);
    rows.push(["", "TOTAL", "", "", "", "", usd(e.totalUsd.low), usd(e.totalUsd.expected), usd(e.totalUsd.high)]);
    const out = [];
    out.push(`\n💰 Cost estimate — run ${plan.runId} (${plan.target})`);
    out.push(`Requirement: ${truncate(plan.requirement, 140)}`);
    out.push(table(rows));
    if (e.totalCredits) {
        const plans = Object.entries(COPILOT_PLAN_CREDITS)
            .map(([p, c]) => `${p}: ${((e.totalCredits.expected / c) * 100).toFixed(1)}%`)
            .join(", ");
        out.push(`AI credits: ~${Math.round(e.totalCredits.expected)} expected (${Math.round(e.totalCredits.low)}-${Math.round(e.totalCredits.high)}) · share of monthly plan → ${plans}`);
    }
    out.push(`Budget cap: ${usd(e.budget.maxUsd)} · pause if spend exceeds approved amount by ${Math.round(e.budget.overrunTolerance * 100)}%`);
    out.push(e.withinBudget ? "✅ High estimate is within budget." : `⚠️  High estimate ${usd(e.totalUsd.high)} exceeds budget ${usd(e.budget.maxUsd)} — modify the plan or raise the budget.`);
    out.push("Assumptions: " + e.assumptions.join("; "));
    return out.join("\n");
}
/** Markdown version, saved next to the run and shown inside IDE chats. */
export function renderEstimateMarkdown(plan) {
    const e = plan.estimate;
    const lines = [
        `# Cost estimate — run \`${plan.runId}\``,
        "",
        `- **Target:** ${plan.target}`,
        `- **Requirement:** ${plan.requirement.replace(/\n/g, " ")}`,
        `- **Complexity:** ${e.complexity} · **Mode:** ${plan.config.mode}`,
        `- **Budget cap:** ${usd(e.budget.maxUsd)} (overrun tolerance ${Math.round(e.budget.overrunTolerance * 100)}%)`,
        "",
        "| # | Stage | Agent | Model | Turns | Low | Expected | High |",
        "|---|---|---|---|---|---:|---:|---:|",
        ...e.stages.map((s, i) => `| ${i + 1} | ${s.stage} | ${s.agent} | ${s.inherited ? `inherit ≈ \`${s.model}\`` : `\`${s.model}\``} | ${s.turns.low}-${s.turns.high} | ${usd(s.usd.low)} | ${usd(s.usd.expected)} | ${usd(s.usd.high)} |`),
        `| | rework loops | | | | ${usd(e.rework.low)} | ${usd(e.rework.expected)} | ${usd(e.rework.high)} |`,
        `| | **TOTAL** | | | | **${usd(e.totalUsd.low)}** | **${usd(e.totalUsd.expected)}** | **${usd(e.totalUsd.high)}** |`,
        "",
    ];
    if (e.totalCredits)
        lines.push(`AI credits: ~${Math.round(e.totalCredits.expected)} (${Math.round(e.totalCredits.low)}–${Math.round(e.totalCredits.high)})`, "");
    lines.push(e.withinBudget ? "✅ Within budget." : `⚠️ High estimate exceeds the budget cap.`, "");
    lines.push("**Assumptions:**", ...e.assumptions.map((a) => `- ${a}`), "");
    return lines.join("\n");
}
export function renderActuals(plan, actuals) {
    const rows = [["Stage", "Iter", "Model", "Turns", "Status", "Estimated", "Actual"]];
    let total = 0;
    for (const a of actuals) {
        const est = plan.estimate.stages.find((s) => s.stage === a.stage);
        total += a.usd;
        rows.push([a.stage, String(a.iteration), a.model, String(a.turns), a.status, a.iteration === 0 && est ? usd(est.usd.expected) : "(rework)", usd(a.usd)]);
    }
    rows.push(["TOTAL", "", "", "", "", usd(plan.estimate.totalUsd.expected), usd(total)]);
    return table(rows);
}
function truncate(s, n) {
    const one = s.replace(/\s+/g, " ").trim();
    return one.length > n ? one.slice(0, n - 1) + "…" : one;
}
//# sourceMappingURL=render.js.map