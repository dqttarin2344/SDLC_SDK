import { enabledStages, resolveModel } from "./config.js";
import { costUsd, getPrice } from "./pricing.js";
import { estimateTokens } from "./scanner.js";
import type {
  Complexity,
  CostRange,
  PipelineEstimate,
  RepoStats,
  SdlcConfig,
  StageConfig,
  StageEstimate,
  StageId,
  StageProfile,
  Target,
  TokenBreakdown,
} from "./types.js";

/**
 * Built-in token profiles. They model an agent loop with prompt caching:
 * every turn re-sends the whole context (mostly cache reads), new context is
 * written to cache once, and each turn produces some output.
 * Tune them per repo via `profiles` in sdlc.config.json, or let the ledger calibrate them.
 */
export const DEFAULT_PROFILES: Record<StageId, StageProfile> = {
  requirements:      { turns: { S: 4, M: 7, L: 12, XL: 18 },  outputPerTurn: 1500, baseContext: 16000, growthPerTurn: 2000, repoReadShare: 0.03, repoReadCap: 30000 },
  research:          { turns: { S: 6, M: 12, L: 20, XL: 30 }, outputPerTurn: 1200, baseContext: 18000, growthPerTurn: 4000, repoReadShare: 0.08, repoReadCap: 80000 },
  design:            { turns: { S: 5, M: 10, L: 16, XL: 26 }, outputPerTurn: 2500, baseContext: 18000, growthPerTurn: 3000, repoReadShare: 0.10, repoReadCap: 100000 },
  implement:         { turns: { S: 10, M: 25, L: 45, XL: 80 }, outputPerTurn: 2000, baseContext: 18000, growthPerTurn: 3000, repoReadShare: 0.12, repoReadCap: 150000 },
  review:            { turns: { S: 5, M: 9, L: 15, XL: 24 },  outputPerTurn: 1500, baseContext: 18000, growthPerTurn: 3500, repoReadShare: 0.05, repoReadCap: 60000 },
  "unit-test":       { turns: { S: 8, M: 16, L: 28, XL: 45 }, outputPerTurn: 1800, baseContext: 18000, growthPerTurn: 2500, repoReadShare: 0.04, repoReadCap: 40000 },
  "integration-test":{ turns: { S: 6, M: 12, L: 22, XL: 35 }, outputPerTurn: 1800, baseContext: 18000, growthPerTurn: 2500, repoReadShare: 0.04, repoReadCap: 40000 },
  "functional-test": { turns: { S: 6, M: 12, L: 20, XL: 32 }, outputPerTurn: 1800, baseContext: 18000, growthPerTurn: 2500, repoReadShare: 0.03, repoReadCap: 30000 },
  release:           { turns: { S: 2, M: 3, L: 4, XL: 6 },    outputPerTurn: 1200, baseContext: 12000, growthPerTurn: 2000, repoReadShare: 0, repoReadCap: 0 },
};

/** Context is compacted around here, so per-turn context never grows past it. */
const CONTEXT_CAP = 160_000;
/** Uncached input per turn (the newest user/tool block after the last cache breakpoint). */
const UNCACHED_PER_TURN = 300;
/** Average size of one prior stage report that later stages read. */
const ARTIFACT_TOKENS = 2500;
const TURN_SPREAD = { low: 0.6, high: 1.8 };
const READ_SCALE: Record<Complexity, number> = { S: 0.5, M: 1, L: 1.5, XL: 2 };

const MODE_FACTOR: Record<SdlcConfig["mode"], Partial<Record<StageId, number>>> = {
  feature: {},
  modify: { research: 0.8, design: 0.8 },
  bugfix: { requirements: 0.6, design: 0.6, implement: 0.6, "unit-test": 0.7, "integration-test": 0.7, "functional-test": 0.7 },
};

const BUMP_WORDS = /\b(migrat|refactor|architect|rewrite|multi[- ]?tenant|distributed|microservice|integrat|payment|security|auth)/i;

export function detectComplexity(requirement: string, repo: RepoStats, mode: SdlcConfig["mode"]): Complexity {
  const req = estimateTokens(requirement);
  let score = req < 150 ? 0 : req < 500 ? 1 : req < 1500 ? 2 : 3;
  score += repo.totalTokens < 50_000 ? 0 : repo.totalTokens < 300_000 ? 1 : repo.totalTokens < 1_500_000 ? 2 : 3;
  if (BUMP_WORDS.test(requirement)) score += 1;
  if (mode === "bugfix") score -= 1;
  if (score <= 1) return "S";
  if (score <= 3) return "M";
  if (score === 4) return "L";
  return "XL";
}

/** Token usage of one agent loop with `turns` round-trips. */
export function loopTokens(turns: number, startContext: number, growth: number, outputPerTurn: number): TokenBreakdown & { peakContext: number } {
  let processed = 0;
  let ctx = startContext;
  let compactions = 0;
  for (let i = 0; i < turns; i++) {
    processed += ctx;
    ctx += growth + outputPerTurn;
    if (ctx > CONTEXT_CAP) {
      compactions++;
      ctx = Math.round(CONTEXT_CAP * 0.35); // summary + recent turns survive compaction
    }
  }
  const input = UNCACHED_PER_TURN * turns;
  // Each new token is written to cache once; each compaction rewrites the compacted context.
  const cacheWrite = Math.min(processed - input, startContext + (growth + outputPerTurn) * Math.max(turns - 1, 0) + compactions * CONTEXT_CAP * 0.35);
  const cacheRead = Math.max(processed - input - cacheWrite, 0);
  return { input, cacheWrite: Math.max(cacheWrite, 0), cacheRead, output: outputPerTurn * turns, peakContext: Math.min(startContext + (growth + outputPerTurn) * turns, CONTEXT_CAP) };
}

function profileFor(cfg: SdlcConfig, id: StageId): StageProfile {
  const o = cfg.profiles?.[id];
  const d = DEFAULT_PROFILES[id];
  return o ? { ...d, ...o, turns: { ...d.turns, ...(o.turns ?? {}) } } : d;
}

interface StageCtx {
  cfg: SdlcConfig;
  target: Target;
  complexity: Complexity;
  repo: RepoStats;
  requirementTokens: number;
  priorStages: number;
}

function stageCost(stage: StageConfig, ctx: StageCtx, turnScale = 1): { turns: CostRange; usd: CostRange; tokens: TokenBreakdown } {
  const p = profileFor(ctx.cfg, stage.id);
  const modeF = MODE_FACTOR[ctx.cfg.mode][stage.id] ?? 1;
  const baseTurns = Math.max(1, p.turns[ctx.complexity] * modeF * turnScale);
  const repoRead = Math.min(ctx.repo.totalTokens * p.repoReadShare, p.repoReadCap) * READ_SCALE[ctx.complexity];
  const start = p.baseContext + ctx.requirementTokens + Math.min(ctx.priorStages * ARTIFACT_TOKENS, 20_000);
  const price = getPrice(ctx.target, resolveModel(ctx.cfg, stage, ctx.target).priced);

  const at = (turns: number) => {
    const t = Math.max(1, Math.round(turns));
    const growth = p.growthPerTurn + repoRead / t;
    const tok = loopTokens(t, start, growth, p.outputPerTurn);
    return { t, tok, usd: costUsd(price, tok, tok.peakContext) };
  };
  const lo = at(baseTurns * TURN_SPREAD.low);
  const ex = at(baseTurns);
  const hi = at(baseTurns * TURN_SPREAD.high);
  const { peakContext: _peak, ...tokens } = ex.tok;
  return {
    turns: { low: lo.t, expected: ex.t, high: hi.t },
    usd: { low: lo.usd, expected: ex.usd, high: hi.usd },
    tokens,
  };
}

const scale = (r: CostRange, f: number): CostRange => ({ low: r.low * f, expected: r.expected * f, high: r.high * f });
const add = (a: CostRange, b: CostRange): CostRange => ({ low: a.low + b.low, expected: a.expected + b.expected, high: a.high + b.high });
const ZERO: CostRange = { low: 0, expected: 0, high: 0 };

export interface EstimateInput {
  target: Target;
  requirement: string;
  repo: RepoStats;
  config: SdlcConfig;
  /** Per-stage calibration multipliers from the ledger (actual / estimated). */
  calibration?: Partial<Record<StageId, number>>;
}

export function estimatePipeline(input: EstimateInput): PipelineEstimate {
  const { target, requirement, repo, config: cfg } = input;
  const complexity = cfg.complexity === "auto" ? detectComplexity(requirement, repo, cfg.mode) : cfg.complexity;
  const requirementTokens = estimateTokens(requirement);
  const stages = enabledStages(cfg);

  const estimates: StageEstimate[] = stages.map((stage, i) => {
    const ctx: StageCtx = { cfg, target, complexity, repo, requirementTokens, priorStages: i };
    const c = stageCost(stage, ctx);
    const cal = input.calibration?.[stage.id] ?? 1;
    const notes: string[] = [];
    const rm = resolveModel(cfg, stage, target);
    if (rm.inherited) notes.push(`runs on your session model, priced as ${rm.priced}`);
    if (cal !== 1) notes.push(`calibrated x${cal.toFixed(2)} from past runs`);
    if (stage.access === "write") notes.push("may modify code");
    return {
      stage: stage.id,
      agent: stage.agent,
      model: rm.priced,
      inherited: rm.inherited,
      turns: c.turns,
      tokens: c.tokens,
      usd: scale(c.usd, cal),
      calibration: cal,
      notes,
    };
  });

  // Rework loops: review -> implement, and failing tests -> implement -> re-test.
  const rework = reworkCost(stages, { cfg, target, complexity, repo, requirementTokens, priorStages: stages.length }, input.calibration);

  const totalUsd = add(estimates.reduce((acc, e) => add(acc, e.usd), ZERO), rework.usd);
  const inheritedModels = [...new Set(estimates.filter((e) => e.inherited).map((e) => e.model))];
  const assumptions = [
    ...(inheritedModels.length
      ? [`stages with model "inherit" run on the model of your session and are priced as ${inheritedModels.join(", ")} (change with estimateAs or --estimate-as)`]
      : []),
    `complexity ${complexity}${cfg.complexity === "auto" ? " (auto-detected)" : ""}, mode ${cfg.mode}`,
    `repo ≈ ${Math.round(repo.totalTokens / 1000)}k tokens across ${repo.files} files`,
    "prompt caching on (repeat context billed at cache-read rate)",
    `low/high = ${TURN_SPREAD.low}x / ${TURN_SPREAD.high}x expected turns; high includes worst-case rework loops`,
    ...rework.notes,
  ];
  if (target === "copilot") assumptions.push("Copilot usage-based billing: 1 AI credit = $0.01");

  return {
    target,
    complexity,
    requirementTokens,
    repo,
    stages: estimates,
    rework: rework.usd,
    totalUsd,
    totalCredits: target === "copilot" ? scale(totalUsd, 100) : undefined,
    budget: cfg.budget,
    withinBudget: totalUsd.high <= cfg.budget.maxUsd,
    assumptions,
  };
}

function reworkCost(stages: StageConfig[], ctx: StageCtx, cal?: Partial<Record<StageId, number>>): { usd: CostRange; notes: string[] } {
  const impl = stages.find((s) => s.id === "implement");
  const review = stages.find((s) => s.id === "review");
  const tests = stages.filter((s) => s.id.endsWith("-test"));
  const notes: string[] = [];
  let usd = ZERO;
  if (!impl) return { usd, notes };
  const f = (s: StageConfig) => cal?.[s.id] ?? 1;

  if (review && ctx.cfg.review.maxIterations > 0) {
    const one = add(scale(stageCost(impl, ctx, 0.4).usd, f(impl)), scale(stageCost(review, ctx, 0.6).usd, f(review)));
    // expected: 50% chance of one extra round; high: every allowed round.
    usd = add(usd, { low: 0, expected: one.expected * 0.5, high: one.high * ctx.cfg.review.maxIterations });
    notes.push(`review loop: up to ${ctx.cfg.review.maxIterations} extra implement+review rounds`);
  }
  if (tests.length && ctx.cfg.test.maxFixIterations > 0) {
    for (const t of tests) {
      const one = add(scale(stageCost(impl, ctx, 0.2).usd, f(impl)), scale(stageCost(t, ctx, 0.3).usd, f(t)));
      usd = add(usd, { low: 0, expected: one.expected * 0.3, high: one.high * ctx.cfg.test.maxFixIterations });
    }
    notes.push(`test-fix loop: up to ${ctx.cfg.test.maxFixIterations} fix rounds per test stage`);
  }
  return { usd, notes };
}
