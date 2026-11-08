// Regression tests for bugs found in review (2026-11-08).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  checkCommand, checkReadPath, checkWritePath, createPlan, Ledger, loadConfig, RunStore, runPipeline, ScriptedIO,
} from "../dist/index.js";

// Keep the approval-signing key out of the real ~/.config during tests.
import { mkdtempSync as _mk } from "node:fs";
import { tmpdir as _tmp } from "node:os";
import { join as _join } from "node:path";
process.env.SDLC_HOME = _mk(_join(_tmp(), "sdlc-home-"));

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli", "estimate.js");
const REQ = "Add a subtract function";

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-reg-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test" } }));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "index.js"), "export const add = (a, b) => a + b;\n");
  return dir;
}

test("agents cannot approve budget or edit pipeline bookkeeping", () => {
  for (const access of ["read-only", "write"]) {
    assert.equal(checkCommand("npx --no-install sdlc-estimate approve latest", access).allow, false, access);
    assert.equal(checkCommand("sdlc-estimate record latest --stage x --usd 0", access).allow, false, access);
    assert.equal(checkCommand("echo '[]' > .sdlc/runs/x/approval.json", access).allow, false, access);
    assert.equal(checkCommand("cp /tmp/a .sdlc/runs/x/plan.json", access).allow, false, access);
  }
  assert.equal(checkCommand("cat .sdlc/runs/x/plan.json", "read-only").allow, true);
  assert.equal(checkCommand("npx --no-install sdlc-estimate verify latest", "read-only").allow, true);
  const repo = "/r", run = "/r/.sdlc/runs/x";
  assert.equal(checkWritePath("/r/.sdlc/runs/x/approval.json", "write", repo, run).allow, false);
  assert.equal(checkWritePath("/r/.sdlc/runs/x/actuals.json", "read-only", repo, run).allow, false);
  assert.equal(checkWritePath("/r/.sdlc/runs/other/05-review.md", "write", repo, run).allow, false);
  assert.equal(checkWritePath("/r/.sdlc/ledger.jsonl", "write", repo, run).allow, false);
  assert.equal(checkWritePath("/r/sdlc.config.json", "write", repo, run).allow, false);
  assert.equal(checkWritePath("/r/.sdlc/runs/x/04-implement.r1.md", "write", repo, run).allow, true);
});

test("read-only stages cannot write or execute through shell tricks", () => {
  for (const cmd of [
    "echo hacked > src/index.js",
    "cat a >> src/b.js",
    "find . -name '*.js' -delete",
    "find . -exec rm {} ;",
    "echo $(rm -rf src)",
    "grep x `touch y`",
    "ls | xargs rm",
    "git diff | tee out.patch",
  ]) assert.equal(checkCommand(cmd, "read-only").allow, false, cmd);
  assert.equal(checkCommand("git diff 2>&1", "read-only").allow, true);
  assert.equal(checkCommand("git log --oneline > /dev/null", "read-only").allow, true);
});

test("guard catches git push/commit variants and wider rm targets", () => {
  for (const cmd of ["git -C . push", "git --no-pager push origin", "git commit -m x", "rm -rf /*", "rm -rf ~/", "rm -r -f /"]) {
    assert.equal(checkCommand(cmd, "write").allow, false, cmd);
  }
  assert.equal(checkCommand("rm -rf build", "write").allow, true);
});

test("read-only stages may run the configured test commands; .env reads are blocked", () => {
  assert.equal(checkCommand("npm test", "read-only").allow, false);
  assert.equal(checkCommand("npm test", "read-only", { readOnlyAllow: ["npm test"] }).allow, true);
  assert.equal(checkCommand("npm test -- --grep x", "read-only", { readOnlyAllow: ["npm test"] }).allow, true);
  assert.equal(checkCommand("npm testx", "read-only", { readOnlyAllow: ["npm test"] }).allow, false);
  assert.equal(checkReadPath("/r/.env").allow, false);
  assert.equal(checkReadPath("/r/.env.local").allow, false);
  assert.equal(checkReadPath("/r/.env.example").allow, true);
  assert.equal(checkReadPath("/r/src/env.ts").allow, true);
});

test("unknown stage ids in sdlc.config.json are rejected, not silently ignored", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "sdlc.config.json"), JSON.stringify({ stages: [{ id: "unit-tests", enabled: false }] }));
  assert.throws(() => loadConfig(repo), /unknown stage id\(s\) unit-tests/);
});

test("requirement can be piped through stdin (-f -) with shell-hostile characters", () => {
  const repo = makeRepo();
  const req = `Fix it; don't break list() — keep "$HOME" & \`backticks\` literal`;
  const r = spawnSync(process.execPath, [CLI, "plan", "--target", "claude", "--json", "--repo", repo, "-f", "-"], { input: req, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const { runId } = JSON.parse(r.stdout);
  assert.equal(new RunStore(repo, runId).loadPlan().requirement, req);
});

test("sdlc-estimate record rejects a missing or unknown --stage with a clear message", () => {
  const repo = makeRepo();
  spawnSync(process.execPath, [CLI, "plan", "--target", "claude", "--repo", repo, REQ], { encoding: "utf8" });
  const r = spawnSync(process.execPath, [CLI, "record", "latest", "--repo", repo, "--tokens", "1000"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /needs --stage/);
});

test("report numbers are fixed per stage even when stages are disabled", () => {
  const repo = makeRepo();
  const plan = createPlan({ target: "claude", requirement: REQ, repoRoot: repo, overrides: { mode: "bugfix" } });
  const store = RunStore.forPlan(plan);
  assert.ok(store.artifactPath("design").endsWith("03-design.md"));
  assert.ok(store.artifactPath("review", 2).endsWith("05-review.r2.md"));
});

class FakeAdapter {
  target = "claude";
  calls = [];
  constructor(overBudgetOnce) { this.overBudgetOnce = overBudgetOnce; }
  async runStage(req) {
    this.calls.push(req.stage.id);
    if (this.overBudgetOnce === req.stage.id) {
      this.overBudgetOnce = null;
      return { status: "budget_exceeded", usd: req.budgetUsd, turns: 3, tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }, sessionId: "s1" };
    }
    mkdirSync(dirname(req.artifactPath), { recursive: true });
    const verdict = req.stage.id === "review" ? "APPROVED" : req.stage.id.endsWith("-test") ? "PASS" : "";
    writeFileSync(req.artifactPath, `# ${req.stage.id}\n${verdict ? "VERDICT: " + verdict : ""}\n`);
    return { status: "ok", usd: 0.1, turns: 2, tokens: { input: 1, cacheWrite: 1, cacheRead: 1, output: 1 } };
  }
}

test("ledger records the whole stage spend across a budget-extension resume", async () => {
  const repo = makeRepo();
  const plan = createPlan({ target: "claude", requirement: REQ, repoRoot: repo });
  const store = RunStore.forPlan(plan);
  store.savePlan(plan);
  const approved = store.approve(plan).approvedUsd;
  await runPipeline(plan, new FakeAdapter("requirements"), new ScriptedIO(["5", "c"]), { skipCheckpoints: true });
  const entry = new Ledger(repo).entries().find((e) => e.stage === "requirements");
  assert.ok(Math.abs(entry.actualUsd - (approved + 0.1)) < 1e-9, `ledger ${entry.actualUsd} vs ${approved + 0.1}`);
});

test("a run cannot be executed twice by accident; --from continues without overwriting reports", async () => {
  const repo = makeRepo();
  const plan = createPlan({ target: "claude", requirement: REQ, repoRoot: repo, overrides: { review: { maxIterations: 1 } } });
  const store = RunStore.forPlan(plan);
  store.savePlan(plan);
  store.approve(plan);
  await runPipeline(plan, new FakeAdapter(), new ScriptedIO([]), { skipCheckpoints: true });
  await assert.rejects(runPipeline(plan, new FakeAdapter(), new ScriptedIO([])), /already has recorded stages/);
  const again = new FakeAdapter();
  const s = await runPipeline(plan, again, new ScriptedIO([]), { skipCheckpoints: true, fromStage: "release" });
  assert.deepEqual(again.calls, ["release"]);
  assert.equal(s.status, "completed");
  assert.ok(existsSync(store.artifactPath("release")));
});

test("re-approving a changed plan starts from its own estimate, not the stale approval", () => {
  const repo = makeRepo();
  const plan = createPlan({ target: "claude", requirement: REQ, repoRoot: repo });
  const store = RunStore.forPlan(plan);
  store.savePlan(plan);
  store.approve(plan, { extraUsd: 100 });
  const changed = createPlan({ target: "claude", requirement: REQ, repoRoot: repo, runId: plan.runId, overrides: { complexity: "XL" } });
  const a = store.approve(changed);
  assert.ok(Math.abs(a.approvedUsd - Math.min(changed.estimate.totalUsd.high, changed.config.budget.maxUsd)) < 1e-6);
});
