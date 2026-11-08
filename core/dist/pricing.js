const anthropic = (input, output, cacheRead) => ({
    input,
    output,
    cacheRead,
    cacheWrite: +(input * 1.25).toFixed(4),
});
/**
 * Claude API list prices (Anthropic first-party), snapshot 2026-10.
 * Override at runtime with SDLC_PRICING_FILE=/path/to/pricing.json if prices change.
 */
export const CLAUDE_PRICES = {
    "claude-fable-5-1": anthropic(10, 50, 0.25),
    "claude-opus-5-5": anthropic(4, 20, 0.2),
    "claude-opus-5": anthropic(5, 25, 0.5),
    "claude-opus-4-8": anthropic(5, 25, 0.5),
    "claude-sonnet-5-5": anthropic(2, 10, 0.2),
    "claude-sonnet-5": anthropic(2, 10, 0.2),
    "claude-sonnet-4-6": anthropic(3, 15, 0.3),
    "claude-haiku-5-5": {
        ...anthropic(0.1, 0.5, 0.01),
        longContext: { threshold: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
    },
    "claude-haiku-4-5": anthropic(1, 5, 0.1),
};
/**
 * GitHub Copilot usage-based billing (AI credits, 1 credit = $0.01), snapshot 2026-11
 * from docs.github.com "Models and pricing for GitHub Copilot".
 * Copilot does not publish cache-write prices in that table; 1.25x input is assumed for Anthropic models.
 */
export const COPILOT_PRICES = {
    "claude-fable-5.1": anthropic(10, 50, 0.25),
    "claude-opus-5.5": anthropic(4, 20, 0.2),
    "claude-opus-5": anthropic(5, 25, 0.5),
    "claude-opus-4.8": anthropic(5, 25, 0.5),
    "claude-sonnet-5.5": anthropic(2, 10, 0.1),
    "claude-sonnet-5": anthropic(2, 10, 0.2),
    "claude-sonnet-4.6": anthropic(3, 15, 0.3),
    "claude-haiku-5.5": {
        ...anthropic(0.1, 0.5, 0.01),
        longContext: { threshold: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
    },
    "claude-haiku-4.5": anthropic(1, 5, 0.1),
    "gpt-6.1-sol": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2 },
    "gpt-6.1-terra": { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1 },
    "gpt-6-luna": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.1 },
    "gpt-5.3-codex": { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 },
    "gemini-4-argon": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2 },
    "gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 },
};
/** Monthly AI-credit allowances for individual Copilot plans (for "% of plan" display). */
export const COPILOT_PLAN_CREDITS = {
    pro: 1_500,
    "pro+": 7_000,
    max: 20_000,
};
let overrides;
/** Throws unless every price is a finite, non-negative number (a NaN price would silently disable budget caps). */
export function validatePrice(model, p) {
    const v = p;
    for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
        const n = v?.[k];
        if (typeof n !== "number" || !Number.isFinite(n) || n < 0)
            throw new Error(`Invalid price for "${model}": ${k} must be a finite number >= 0`);
    }
    return v;
}
export function setPricingOverrides(o) {
    for (const table of Object.values(o))
        for (const [m, p] of Object.entries(table ?? {}))
            validatePrice(m, p);
    overrides = o;
}
export function priceTable(target) {
    const base = target === "claude" ? CLAUDE_PRICES : COPILOT_PRICES;
    return { ...base, ...(overrides?.[target] ?? {}) };
}
export function getPrice(target, model) {
    const table = priceTable(target);
    const p = table[model];
    if (!p) {
        const known = Object.keys(table).join(", ");
        throw new Error(`No price for model "${model}" on target "${target}". Known: ${known}. ` +
            `Add your own in sdlc.config.json: "prices": { "${target}": { "${model}": { "input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0 } } } ` +
            `(USD per 1M tokens), or fix the model id.`);
    }
    return p;
}
/** Strip decorations a session model id may carry: "deepseek-v4-pro[1m]" → "deepseek-v4-pro". */
export function normalizeModelId(model) {
    return model.replace(/\[[^\]]*\]$/, "").trim();
}
const CLAUDE_ALIAS = { opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" };
/** Price of a model if known (frozen plan prices, then config/user prices, then built-in tables). */
export function lookupPrice(target, model, frozen) {
    const id = normalizeModelId(model);
    const alias = target === "claude" ? CLAUDE_ALIAS[id.toLowerCase()] : undefined;
    const table = priceTable(target);
    return frozen?.[id] ?? frozen?.[model] ?? table[id] ?? (alias ? table[alias] : undefined);
}
/** Cost in USD of a token breakdown. `promptSize` selects the long-context tier when applicable. */
export function costUsd(price, t, promptSize = 0) {
    const tier = price.longContext && promptSize > price.longContext.threshold ? price.longContext : price;
    return ((t.input * tier.input + t.cacheWrite * tier.cacheWrite + t.cacheRead * tier.cacheRead + t.output * tier.output) /
        1_000_000);
}
/** Model presets usable from the approval "modify" menu. */
export const PRESETS = {
    economy: {
        claude: { heavy: "claude-sonnet-5-5", standard: "claude-haiku-5-5", light: "claude-haiku-5-5" },
        copilot: { heavy: "claude-sonnet-5.5", standard: "claude-haiku-5.5", light: "claude-haiku-5.5" },
    },
    balanced: {
        claude: { heavy: "claude-opus-5-5", standard: "claude-sonnet-5-5", light: "claude-haiku-5-5" },
        copilot: { heavy: "claude-opus-5.5", standard: "claude-sonnet-5.5", light: "claude-haiku-5.5" },
    },
    quality: {
        claude: { heavy: "claude-opus-5-5", standard: "claude-opus-5-5", light: "claude-sonnet-5-5" },
        copilot: { heavy: "claude-opus-5.5", standard: "claude-opus-5.5", light: "claude-sonnet-5.5" },
    },
};
/** Which preset slot each stage uses. */
export const STAGE_WEIGHT = {
    requirements: "standard",
    research: "standard",
    design: "heavy",
    implement: "standard",
    review: "heavy",
    "unit-test": "standard",
    "integration-test": "standard",
    "functional-test": "standard",
    release: "light",
};
//# sourceMappingURL=pricing.js.map