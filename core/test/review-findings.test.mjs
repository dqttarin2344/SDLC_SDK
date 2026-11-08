// Regression tests for the independent review findings (2026-11-08).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
process.env.SDLC_HOME = mkdtempSync(join(tmpdir(), "sdlc-home-"));
import {
  checkCommand, checkWritePath, checkWritePathIde, createPlan, loadConfig, RunStore, runPipeline, ScriptedIO, setPricingOverrides,
} from "../dist/index.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli", "estimate.js");
const REQ = "Add a subtract function";
const cli = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: { ...process.env }, ...opts });

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "sdlc-rf-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", scripts: { test: "node --test" } }));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "index.js"), "export const add = (a, b) => a + b;\n");
  return dir;
}
function approvedPlan(overrides) {
  const repo = makeRepo();
  const plan = createPlan({ target: "claude", requirement: REQ, repoRoot: repo, overrides });
  const store = RunStore.forPlan(plan);
  store.savePlan(plan);
  return { repo, plan, store, approval: store.approve(plan) };
}

test("#1 read-only escapes found by the reviewer are blocked", () => {
  for (const cmd of [
    "ls &>src/app.js", "ls nope 2>src/app.js", "cat <(rm -rf src)", "ls & rm -rf src",
    "rg --pre 'sh -c id' x", "git grep -Ocat x", "git grep --open-files-in-pager=vim x",
    "git diff --output=src/a.js", "tree -o src/app.js", "git -c core.pager='sh -c id' log",
  ]) assert.equal(checkCommand(cmd, "read-only").allow, false, cmd);
});

test("#2 write-stage approval/publish/push bypasses are blocked by the guard", () => {
  for (const cmd of [
    "node node_modules/@sdlc/core/dist/cli/estimate.js approve latest",
    "npx sdlc-estimate 'approve' latest",
    "cat ~/.config/sdlc/approval.key",
    "npm --registry=x publish", "pnpm -r publish",
    "gh release create v1", "gh pr merge 3",
  ]) assert.equal(checkCommand(cmd, "write").allow, false, cmd);
});

test("#2 forged or edited approvals are rejected (HMAC signature)", () => {
  const { plan, store } = approvedPlan();
  const file = join(store.dir, "approval.json");
  const list = JSON.parse(readFileSync(file, "utf8"));
  // Inflate the amount, keep the old signature.
  writeFileSync(file, JSON.stringify([{ ...list[0], approvedUsd: 1000 }]));
  assert.throws(() => store.requireApproval(plan), /no valid signature/);
  // A hand-written approval with the right hash but no signature.
  writeFileSync(file, JSON.stringify([{ ...list[0], signature: undefined }]));
  assert.throws(() => store.requireApproval(plan), /no valid signature/);
});

test("#2 a budget extension is based on the in-memory approval, not on a tampered file", async () => {
  const { plan, store, approval } = approvedPlan();
  const file = join(store.dir, "approval.json");
  const adapter = {
    target: "claude", hit: false,
    async runStage(req) {
      if (!this.hit && req.stage.id === "research") {
        this.hit = true;
        const list = JSON.parse(readFileSync(file, "utf8"));
        list.push({ ...list[0], approvedUsd: 1000 }); // agent forges a big approval mid-run
        writeFileSync(file, JSON.stringify(list));
        return { status: "budget_exceeded", usd: req.budgetUsd, turns: 1, tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } };
      }
      mkdirSync(dirname(req.artifactPath), { recursive: true });
      writeFileSync(req.artifactPath, req.stage.id === "review" ? "VERDICT: APPROVED" : req.stage.id.endsWith("-test") ? "VERDICT: PASS" : "ok");
      return { status: "ok", usd: 0.01, turns: 1, tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } };
    },
  };
  await runPipeline(plan, adapter, new ScriptedIO(["1", "c"]), { skipCheckpoints: true });
  const last = store.approvals().at(-1);
  assert.ok(Math.abs(last.approvedUsd - (approval.approvedUsd + 1)) < 1e-9, `got ${last.approvedUsd}`);
});

test("#3 .git is protected case-insensitively, in subfolders, and through symlinks", () => {
  const repo = makeRepo();
  const run = join(repo, ".sdlc/runs/x");
  assert.equal(checkWritePath(join(repo, ".GIT/config"), "write", repo, run).allow, false);
  assert.equal(checkWritePath(join(repo, "sub/.git/hooks/pre-commit"), "write", repo, run).allow, false);
  const outside = mkdtempSync(join(tmpdir(), "sdlc-outside-"));
  symlinkSync(outside, join(repo, "link"));
  assert.equal(checkWritePath(join(repo, "link/evil.sh"), "write", repo, run).allow, false);
  assert.equal(checkWritePath(join(repo, "src/ok.js"), "write", repo, run).allow, true);
});

test("#7 config typos fail loudly instead of weakening the guard", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "sdlc.config.json"), JSON.stringify({ stages: [{ id: "review", access: "readonly" }] }));
  assert.throws(() => loadConfig(repo), /access must be "read-only" or "write"/);
  writeFileSync(join(repo, "sdlc.config.json"), JSON.stringify({ artifactsDir: "runs" }));
  assert.throws(() => loadConfig(repo), /artifactsDir must be a relative path with at least two segments/);
  writeFileSync(join(repo, "sdlc.config.json"), JSON.stringify({ review: { maxIterations: "2" } }));
  assert.throws(() => loadConfig(repo), /review.maxIterations/);
});

test("#8 price overrides are validated and frozen into the approved plan", async () => {
  assert.throws(() => setPricingOverrides({ copilot: { "x-model": { input: 1, output: 1, cacheRead: 0.1 } } }), /cacheWrite/);
  const { plan } = approvedPlan();
  assert.ok(plan.prices["claude-sonnet-5-5"].input > 0);
  // An adapter reporting a NaN cost is treated as having used the budget (non-interactive: stop).
  const nan = { target: "claude", async runStage() { return { status: "ok", usd: NaN, turns: 1, tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } }; } };
  const io = new ScriptedIO([]);
  Object.defineProperty(io, "interactive", { value: false });
  const s = await runPipeline(plan, nan, io, { skipCheckpoints: true });
  assert.equal(s.status, "stopped");
});

test("#5 approve --extra extends an existing approval (IDE flow)", () => {
  const repo = makeRepo();
  cli(["plan", "--target", "claude", "--repo", repo, REQ]);
  const first = cli(["approve", "latest", "--repo", repo]);
  assert.equal(first.status, 0, first.stderr);
  const before = Number(/up to \$([\d.]+)/.exec(first.stdout)[1]);
  const ext = cli(["approve", "latest", "--repo", repo, "--extra", "3"]);
  assert.equal(Number(/up to \$([\d.]+)/.exec(ext.stdout)[1]).toFixed(2), (before + 3).toFixed(2));
  assert.equal(cli(["verify", "latest", "--repo", repo]).status, 0);
});

test("#6 Claude Code guard hook: approve asks the human, dangerous calls exit 2", () => {
  const repo = makeRepo();
  const hook = (tool_name, tool_input) => cli(["guard-hook", "--repo", repo], { input: JSON.stringify({ tool_name, tool_input, cwd: repo }), env: { ...process.env, CLAUDE_PROJECT_DIR: repo } });
  const ask = hook("Bash", { command: "npx --no-install sdlc-estimate approve 20261108-1 --note ok" });
  assert.equal(ask.status, 0);
  assert.equal(JSON.parse(ask.stdout).hookSpecificOutput.permissionDecision, "ask");
  assert.equal(hook("Bash", { command: "npx sdlc-estimate approve x; echo hi" }).status, 2);
  assert.equal(hook("Bash", { command: "git -C . push" }).status, 2);
  assert.equal(hook("Write", { file_path: join(repo, ".sdlc/runs/x/approval.json") }).status, 2);
  assert.equal(hook("Write", { file_path: join(repo, ".sdlc/runs/x/01-requirements.md") }).status, 0);
  assert.equal(hook("Edit", { file_path: join(repo, "src/index.js") }).status, 0);
  assert.equal(hook("Read", { file_path: join(repo, ".env") }).status, 2);
  assert.equal(checkWritePathIde(join(repo, "../x"), repo).allow, false);
});

test("#11 'latest' follows the plan timestamp, not the directory name", () => {
  const repo = makeRepo();
  const a = createPlan({ target: "claude", requirement: REQ, repoRoot: repo, runId: "20991231-235959-ffff" });
  a.createdAt = "2026-01-01T00:00:00.000Z";
  RunStore.forPlan(a).savePlan(a);
  const b = createPlan({ target: "claude", requirement: REQ, repoRoot: repo, runId: "20000101-000000-0000" });
  RunStore.forPlan(b).savePlan(b);
  assert.equal(RunStore.latest(repo), "20000101-000000-0000");
});
