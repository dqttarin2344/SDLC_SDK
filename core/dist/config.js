import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeModelId, setPricingOverrides } from "./pricing.js";
export const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ROLES_DIR = join(CORE_ROOT, "roles");
export const DEFAULT_CONFIG_PATH = join(CORE_ROOT, "sdlc.config.default.json");
export const CONFIG_FILE = "sdlc.config.json";
export const STAGE_ORDER = [
    "requirements",
    "research",
    "design",
    "implement",
    "review",
    "unit-test",
    "integration-test",
    "functional-test",
    "release",
];
function readJson(path) {
    return JSON.parse(readFileSync(path, "utf8"));
}
/** Deep merge for plain objects; arrays are replaced, except `stages` which merge by id. */
function merge(base, over) {
    if (over === undefined || over === null)
        return base;
    if (Array.isArray(base) || typeof base !== "object" || base === null)
        return over;
    const out = { ...base };
    for (const [k, v] of Object.entries(over)) {
        if (k === "stages" && Array.isArray(v)) {
            const baseStages = out.stages ?? [];
            out.stages = baseStages.map((s) => {
                const o = v.find((x) => x.id === s.id);
                return o ? merge(s, o) : s;
            });
        }
        else {
            out[k] = merge(out[k], v);
        }
    }
    return out;
}
/**
 * Load config: built-in defaults <- repo sdlc.config.json <- explicit overrides.
 * Also applies SDLC_PRICING_FILE price overrides if set.
 */
export function loadConfig(repoRoot, overrides) {
    let cfg = readJson(DEFAULT_CONFIG_PATH);
    const repoCfg = join(repoRoot, CONFIG_FILE);
    if (existsSync(repoCfg)) {
        const repo = readJson(repoCfg);
        const unknown = (repo.stages ?? []).map((st) => st.id).filter((id) => !STAGE_ORDER.includes(id));
        if (unknown.length)
            throw new Error(`${repoCfg}: unknown stage id(s) ${unknown.join(", ")}. Valid: ${STAGE_ORDER.join(", ")}`);
        cfg = merge(cfg, repo);
    }
    if (overrides)
        cfg = merge(cfg, overrides);
    // Prices: built-in < sdlc.config.json "prices" < SDLC_PRICING_FILE. Invalid entries throw.
    const fromFile = process.env.SDLC_PRICING_FILE && existsSync(process.env.SDLC_PRICING_FILE)
        ? readJson(process.env.SDLC_PRICING_FILE)
        : {};
    setPricingOverrides({
        claude: { ...(cfg.prices?.claude ?? {}), ...(fromFile.claude ?? {}) },
        copilot: { ...(cfg.prices?.copilot ?? {}), ...(fromFile.copilot ?? {}) },
    });
    validateConfig(cfg);
    cfg.stages.sort((a, b) => STAGE_ORDER.indexOf(a.id) - STAGE_ORDER.indexOf(b.id));
    return cfg;
}
export function validateConfig(cfg) {
    const errors = [];
    const num = (v) => typeof v === "number" && Number.isFinite(v);
    const int = (v) => Number.isInteger(v) && v >= 0;
    if (!num(cfg.budget?.maxUsd) || !(cfg.budget.maxUsd > 0))
        errors.push("budget.maxUsd must be a number > 0");
    if (!num(cfg.budget?.overrunTolerance) || cfg.budget.overrunTolerance < 0)
        errors.push("budget.overrunTolerance must be a number >= 0");
    if (!int(cfg.review?.maxIterations))
        errors.push("review.maxIterations must be an integer >= 0");
    if (!int(cfg.test?.maxFixIterations))
        errors.push("test.maxFixIterations must be an integer >= 0");
    if (!["feature", "modify", "bugfix"].includes(cfg.mode))
        errors.push(`mode must be feature|modify|bugfix, got "${cfg.mode}"`);
    if (cfg.complexity !== "auto" && !["S", "M", "L", "XL"].includes(cfg.complexity))
        errors.push(`complexity must be auto|S|M|L|XL`);
    // Two relative segments (e.g. ".sdlc/runs"): the parent holds the ledger and is protected as pipeline state.
    const segs = String(cfg.artifactsDir ?? "").split(/[\\/]/).filter(Boolean);
    if (isAbsolute(cfg.artifactsDir ?? "") || segs.length < 2 || segs.some((s) => s === "." || s === "..")) {
        errors.push(`artifactsDir must be a relative path with at least two segments inside the repo (e.g. ".sdlc/runs"), got "${cfg.artifactsDir}"`);
    }
    for (const t of ["claude", "copilot"]) {
        const m = cfg.estimateAs?.[t];
        if (m !== undefined && (typeof m !== "string" || !m.trim() || m === INHERIT))
            errors.push(`estimateAs.${t} must be a concrete model id`);
    }
    if (cfg.copilotProvider && !/^https?:\/\//.test(cfg.copilotProvider.baseUrl ?? ""))
        errors.push("copilotProvider.baseUrl must be an http(s) URL");
    if (typeof cfg.sandbox?.enabled !== "boolean" || typeof cfg.sandbox?.required !== "boolean")
        errors.push("sandbox.enabled and sandbox.required must be booleans");
    for (const s of cfg.stages) {
        if (s.access !== "read-only" && s.access !== "write")
            errors.push(`stage "${s.id}": access must be "read-only" or "write", got "${s.access}"`);
        if (!STAGE_ORDER.includes(s.id))
            errors.push(`unknown stage id "${s.id}"`);
        if (!existsSync(join(ROLES_DIR, `${s.agent}.md`)))
            errors.push(`stage "${s.id}": no role file roles/${s.agent}.md`);
        for (const t of ["claude", "copilot"]) {
            if (typeof s.model?.[t] !== "string" || !s.model[t].trim())
                errors.push(`stage "${s.id}": model.${t} must be a model id or "inherit"`);
        }
    }
    if (errors.length)
        throw new Error(`Invalid SDLC config:\n - ${errors.join("\n - ")}`);
}
/** Apply mode-specific stage defaults: bugfix mode skips research and release notes. */
export function applyMode(cfg) {
    const c = structuredClone(cfg);
    if (c.mode === "bugfix") {
        for (const s of c.stages)
            if (s.id === "research" || s.id === "release")
                s.enabled = false;
    }
    return c;
}
export function enabledStages(cfg) {
    return cfg.stages.filter((s) => s.enabled);
}
export const INHERIT = "inherit";
const DEFAULT_ESTIMATE_AS = { claude: "claude-sonnet-5-5", copilot: "claude-sonnet-5.5" };
export const isInherit = (model) => !model || model === INHERIT;
/** The model used to price stages that inherit the session model. */
export function estimateModel(cfg, target) {
    const fromEnv = target === "claude" ? process.env.ANTHROPIC_MODEL : undefined;
    return cfg.estimateAs?.[target] ?? (fromEnv ? normalizeModelId(fromEnv) : undefined) ?? DEFAULT_ESTIMATE_AS[target];
}
export function resolveModel(cfg, stage, target) {
    const configured = stage.model[target];
    if (isInherit(configured))
        return { run: undefined, priced: estimateModel(cfg, target), inherited: true, label: INHERIT };
    return { run: configured, priced: configured, inherited: false, label: configured };
}
export function modelFor(cfg, stage, target) {
    const s = cfg.stages.find((x) => x.id === stage);
    if (!s)
        throw new Error(`stage ${stage} not in config`);
    return resolveModel(cfg, s, target).priced;
}
//# sourceMappingURL=config.js.map