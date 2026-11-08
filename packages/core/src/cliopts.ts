import { readFileSync } from "node:fs";
import { applyMode } from "./config.js";
import { PRESETS, STAGE_WEIGHT } from "./pricing.js";
import type { Complexity, SdlcConfig, StageId, Target, WorkMode } from "./types.js";

/** Plan-shaping CLI flags shared by sdlc-estimate, sdlc-claude and sdlc-copilot. */
export const PLAN_OPTIONS = {
  requirement: { type: "string", short: "r" },
  "requirement-file": { type: "string", short: "f" },
  repo: { type: "string", default: "." },
  preset: { type: "string" },
  complexity: { type: "string" },
  mode: { type: "string" },
  budget: { type: "string" },
  disable: { type: "string" },
  enable: { type: "string" },
  only: { type: "string" },
  model: { type: "string", multiple: true },
  "estimate-as": { type: "string" },
  "review-iterations": { type: "string" },
  "test-fix-iterations": { type: "string" },
} as const;

export interface PlanFlags {
  requirement?: string;
  "requirement-file"?: string;
  preset?: string;
  complexity?: string;
  mode?: string;
  budget?: string;
  disable?: string;
  enable?: string;
  only?: string;
  model?: string[];
  "estimate-as"?: string;
  "review-iterations"?: string;
  "test-fix-iterations"?: string;
}

export const PLAN_HELP = `Plan options:
  -r, --requirement <text>       The request to build (or pass it as positional text)
  -f, --requirement-file <path>  Read the request from a file ("-" = stdin)
      --repo <path>              Repository root (default: .)
      --preset <name>            inherit | economy | balanced | quality (inherit = your session model everywhere)
      --complexity <c>           auto | S | M | L | XL
      --mode <m>                 feature | modify | bugfix
      --budget <usd>             Budget cap for the run
      --disable <ids>            Comma list of stages to skip (e.g. research,release)
      --enable <ids>             Comma list of stages to turn on
      --only <ids>               Run only these stages
      --model <stage=model>      Override a stage's model (repeatable); "*=<model>" sets every stage;
                                 a model of "inherit" uses the model of your session
      --estimate-as <model>      Price "inherit" stages as this model (e.g. your DeepSeek id; needs a price in config)
      --review-iterations <n>    Max review→fix rounds
      --test-fix-iterations <n>  Max test→fix rounds per test stage`;

export function readRequirement(flags: PlanFlags, positionals: string[]): string {
  const file = flags["requirement-file"];
  // "-f -" reads stdin, so agents can pass any text through a quoted heredoc without shell quoting issues.
  const text = file ? readFileSync(file === "-" ? 0 : file, "utf8") : flags.requirement ?? positionals.join(" ");
  if (!text.trim()) throw new Error("A requirement is required: pass it as text, --requirement, or --requirement-file.");
  return text.trim();
}

const ids = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) as StageId[] : []);

/** Applies CLI flags on top of a loaded config. */
export function applyPlanFlags(cfg: SdlcConfig, flags: PlanFlags, target: Target): SdlcConfig {
  let c = structuredClone(cfg);
  if (flags.mode) {
    if (!["feature", "modify", "bugfix"].includes(flags.mode)) throw new Error(`--mode must be feature|modify|bugfix`);
    c.mode = flags.mode as WorkMode;
    c = applyMode(c);
  }
  if (flags.complexity) {
    const v = flags.complexity.toUpperCase();
    if (v === "AUTO") c.complexity = "auto";
    else if (["S", "M", "L", "XL"].includes(v)) c.complexity = v as Complexity;
    else throw new Error("--complexity must be auto|S|M|L|XL");
  }
  if (flags.budget) {
    const b = Number(flags.budget);
    if (!(b > 0)) throw new Error("--budget must be a positive number");
    c.budget.maxUsd = b;
  }
  if (flags.preset === "inherit") {
    for (const s of c.stages) s.model[target] = "inherit";
  } else if (flags.preset) {
    const p = PRESETS[flags.preset]?.[target];
    if (!p) throw new Error(`--preset must be one of inherit, ${Object.keys(PRESETS).join(", ")}`);
    for (const s of c.stages) s.model[target] = p[STAGE_WEIGHT[s.id] ?? "standard"];
  }
  if (flags["estimate-as"]) {
    c.estimateAs = { ...(c.estimateAs ?? {}), [target]: flags["estimate-as"] };
  }
  const only = ids(flags.only);
  if (only.length) for (const s of c.stages) s.enabled = only.includes(s.id);
  for (const id of ids(flags.enable)) {
    const s = c.stages.find((x) => x.id === id);
    if (!s) throw new Error(`unknown stage "${id}"`);
    s.enabled = true;
  }
  for (const id of ids(flags.disable)) {
    const s = c.stages.find((x) => x.id === id);
    if (!s) throw new Error(`unknown stage "${id}"`);
    s.enabled = false;
  }
  for (const m of flags.model ?? []) {
    const eq = m.indexOf("=");
    const id = eq < 0 ? "" : m.slice(0, eq);
    const model = eq < 0 ? "" : m.slice(eq + 1);
    if (!id || !model) throw new Error(`--model expects <stage>=<model> (or *=<model>), got "${m}"`);
    if (id === "*") {
      for (const s of c.stages) s.model[target] = model;
      continue;
    }
    const s = c.stages.find((x) => x.id === id);
    if (!s) throw new Error(`--model: unknown stage "${id}"`);
    s.model[target] = model;
  }
  if (flags["review-iterations"]) c.review.maxIterations = Math.max(0, parseInt(flags["review-iterations"], 10));
  if (flags["test-fix-iterations"]) c.test.maxFixIterations = Math.max(0, parseInt(flags["test-fix-iterations"], 10));
  if (!c.stages.some((s) => s.enabled)) throw new Error("No stages enabled.");
  return c;
}
