// "inherit" models, user-supplied prices (e.g. DeepSeek) and the generated agent files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
process.env.SDLC_HOME = mkdtempSync(join(tmpdir(), "sdlc-home-"));
delete process.env.ANTHROPIC_MODEL;
import {
  applyPlanFlags, applyMode, createPlan, estimateModel, loadConfig, lookupPrice, normalizeModelId, resolveModel, setPricingOverrides,
} from "../dist/index.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli", "estimate.js");
const REQ = "Add a subtract function";

function makeRepo(cfg) {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-inh-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test" } }));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "index.js"), "export const add = (a, b) => a + b;\n");
  if (cfg) writeFileSync(join(dir, "sdlc.config.json"), JSON.stringify(cfg));
  return dir;
}

const DEEPSEEK = { input: 0.5, output: 1, cacheRead: 0.01, cacheWrite: 0.5 };

test("every stage inherits the session model by default and is priced as estimateAs", () => {
  const repo = makeRepo();
  const cfg = loadConfig(repo);
  assert.ok(cfg.stages.every((s) => s.model.claude === "inherit" && s.model.copilot === "inherit"));
  const plan = createPlan({ target: "claude", requirement: REQ, repoRoot: repo });
  assert.ok(plan.estimate.stages.every((s) => s.inherited && s.model === "claude-sonnet-5-5"));
  assert.match(plan.estimate.assumptions.join(" "), /inherit.*priced as claude-sonnet-5-5/);
  assert.equal(resolveModel(cfg, cfg.stages[0], "claude").run, undefined);
});

test("ANTHROPIC_MODEL (e.g. DeepSeek via ANTHROPIC_BASE_URL) is used for pricing when set, [1m] suffix stripped", () => {
  const repo = makeRepo({ prices: { claude: { "deepseek-v4-pro": DEEPSEEK } } });
  process.env.ANTHROPIC_MODEL = "deepseek-v4-pro[1m]";
  try {
    const cfg = loadConfig(repo);
    assert.equal(estimateModel(cfg, "claude"), "deepseek-v4-pro");
    const plan = createPlan({ target: "claude", requirement: REQ, repoRoot: repo });
    assert.ok(plan.estimate.stages.every((s) => s.model === "deepseek-v4-pro"));
    delete process.env.ANTHROPIC_MODEL;
    // Far cheaper than the Sonnet-priced default (computed without the env var).
    const sonnet = createPlan({ target: "claude", requirement: REQ, repoRoot: makeRepo() });
    assert.ok(plan.estimate.totalUsd.expected < sonnet.estimate.totalUsd.expected / 2);
  } finally {
    delete process.env.ANTHROPIC_MODEL;
  }
});

test("unpriced models fail with an actionable message instead of a made-up price", () => {
  const repo = makeRepo();
  const cfg = applyPlanFlags(applyMode(loadConfig(repo)), { "estimate-as": "deepseek-v4-pro" }, "claude");
  assert.throws(() => createPlan({ target: "claude", requirement: REQ, repoRoot: repo, config: cfg }), /No price for model "deepseek-v4-pro".*sdlc\.config\.json.*"prices"/s);
});

test("user prices from sdlc.config.json are validated (NaN/missing/negative rejected)", () => {
  assert.throws(() => loadConfig(makeRepo({ prices: { claude: { x: { input: 1, output: 1, cacheRead: 0.1 } } } })), /cacheWrite/);
  assert.throws(() => loadConfig(makeRepo({ prices: { claude: { x: { input: -1, output: 1, cacheRead: 0.1, cacheWrite: 1 } } } })), /input/);
  setPricingOverrides({}); // leave global state clean for other tests
});

test("--model '*=<id>', --preset inherit and --estimate-as", () => {
  const repo = makeRepo({ prices: { claude: { "deepseek-v4-flash": DEEPSEEK } } });
  const base = applyMode(loadConfig(repo));
  const all = applyPlanFlags(base, { model: ["*=deepseek-v4-flash"] }, "claude");
  assert.ok(all.stages.every((s) => s.model.claude === "deepseek-v4-flash"));
  const one = applyPlanFlags(all, { model: ["design=claude-opus-5-5"] }, "claude");
  assert.equal(one.stages.find((s) => s.id === "design").model.claude, "claude-opus-5-5");
  const back = applyPlanFlags(all, { preset: "inherit" }, "claude");
  assert.ok(back.stages.every((s) => s.model.claude === "inherit"));
  const est = applyPlanFlags(base, { "estimate-as": "deepseek-v4-flash" }, "claude");
  assert.equal(estimateModel(est, "claude"), "deepseek-v4-flash");
  assert.throws(() => applyPlanFlags(base, { model: ["nope=x"] }, "claude"), /unknown stage "nope"/);
  assert.throws(() => applyPlanFlags(base, { model: ["design"] }, "claude"), /expects <stage>=<model>/);
});

test("lookupPrice handles ids with [1m] suffix, claude aliases and frozen plan prices", () => {
  assert.equal(normalizeModelId("deepseek-v4-pro[1m]"), "deepseek-v4-pro");
  assert.equal(lookupPrice("claude", "sonnet").input, lookupPrice("claude", "claude-sonnet-5-5").input);
  assert.equal(lookupPrice("claude", "unknown-model"), undefined);
  assert.equal(lookupPrice("claude", "unknown-model", { "unknown-model": DEEPSEEK }), DEEPSEEK);
});

test("generated agents keep the session model when stages inherit; pinned models only when configured", async () => {
  const { claudeAgentMarkdown } = await import("../../claude/dist/index.js");
  const { copilotAgentMarkdown } = await import("../../copilot/dist/index.js");
  const { loadRoles } = await import("../dist/index.js");
  const roles = loadRoles();
  const role = roles.find((r) => r.stage === "review");
  const inherit = loadConfig(makeRepo());
  assert.match(claudeAgentMarkdown(role, inherit), /^model: inherit$/m);
  assert.doesNotMatch(copilotAgentMarkdown(role, inherit, roles), /^model:/m);
  const pinned = applyPlanFlags(inherit, { model: ["review=claude-opus-5-5"] }, "claude");
  pinned.stages.find((s) => s.id === "review").model.copilot = "claude-opus-5.5";
  assert.match(claudeAgentMarkdown(role, pinned), /^model: claude-opus-5-5$/m);
  assert.match(copilotAgentMarkdown(role, pinned, roles), /^model: "Claude Opus 5\.5 \(copilot\)"$/m);
});

test("estimate CLI: --preset inherit and `models` mention inherit", () => {
  const repo = makeRepo();
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  const plan = run(["plan", "--target", "copilot", "--repo", repo, "--preset", "inherit", "--json", REQ]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.ok(JSON.parse(plan.stdout).estimate.stages.every((s) => s.inherited));
  assert.match(run(["models", "--target", "claude", "--repo", repo]).stdout, /^inherit /m);
  assert.match(readFileSync(join(repo, ".sdlc/runs", readdirSyncFirst(join(repo, ".sdlc/runs")), "estimate.md"), "utf8"), /inherit ≈/);
});

import { readdirSync } from "node:fs";
function readdirSyncFirst(dir) {
  return readdirSync(dir)[0];
}

test("init writes a minimal sdlc.config.json that does not freeze defaults or models", async () => {
  const { ensureRepoConfig } = await import("../dist/index.js");
  const repo = makeRepo();
  assert.equal(ensureRepoConfig(repo), true);
  const written = JSON.parse(readFileSync(join(repo, "sdlc.config.json"), "utf8"));
  assert.equal(written.stages, undefined);
  assert.ok(loadConfig(repo).stages.every((s) => s.model.claude === "inherit"));
  assert.equal(ensureRepoConfig(repo), false); // never overwrites
});
