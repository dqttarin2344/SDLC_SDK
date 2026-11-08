import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { applyMode, loadConfig, resolveModel, STAGE_ORDER } from "./config.js";
import { estimatePipeline } from "./estimator.js";
import { Ledger } from "./ledger.js";
import { getPrice } from "./pricing.js";
import { renderEstimateMarkdown } from "./render.js";
import { scanRepo } from "./scanner.js";
export function newRunId(now = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${randomBytes(2).toString("hex")}`;
}
/** Scan the repo, estimate cost and build a plan (does not write anything). */
export function createPlan(input) {
    const repoRoot = resolve(input.repoRoot);
    const config = input.config ? structuredClone(input.config) : applyMode(loadConfig(repoRoot, input.overrides));
    const repo = scanRepo(repoRoot, config.scanIgnore);
    if (!config.test.commands.unit && repo.detectedTestCommand)
        config.test.commands.unit = repo.detectedTestCommand;
    const calibration = new Ledger(repoRoot, config.artifactsDir).calibration(input.target);
    const estimate = estimatePipeline({ target: input.target, requirement: input.requirement, repo, config, calibration });
    const prices = {};
    for (const s of config.stages) {
        if (!s.enabled)
            continue;
        const priced = resolveModel(config, s, input.target).priced;
        prices[priced] = getPrice(input.target, priced);
    }
    return {
        runId: input.runId ?? newRunId(),
        createdAt: new Date().toISOString(),
        target: input.target,
        requirement: input.requirement,
        repoRoot,
        config,
        estimate,
        prices,
    };
}
/** Where the approval-signing key lives: outside the repository, so agents working in the repo cannot forge approvals. */
export function approvalKeyPath() {
    return join(process.env.SDLC_HOME ?? join(homedir(), ".config", "sdlc"), "approval.key");
}
function approvalKey(create) {
    const p = approvalKeyPath();
    if (!existsSync(p)) {
        if (!create)
            return undefined;
        mkdirSync(join(p, ".."), { recursive: true, mode: 0o700 });
        writeFileSync(p, randomBytes(32).toString("hex"), { mode: 0o600 });
        chmodSync(p, 0o600);
    }
    return Buffer.from(readFileSync(p, "utf8").trim(), "hex");
}
function signApproval(a, key) {
    return createHmac("sha256", key).update(JSON.stringify([a.runId, a.planHash, a.approvedAt, a.approvedBy, a.approvedUsd, a.note ?? null])).digest("hex");
}
export function approvalSignatureValid(a) {
    const key = approvalKey(false);
    if (!key || !a.signature)
        return false;
    const { signature, ...rest } = a;
    const expected = Buffer.from(signApproval(rest, key), "hex");
    const got = Buffer.from(signature, "hex");
    return got.length === expected.length && timingSafeEqual(got, expected);
}
/** Hash of everything an approval covers. Changing any of it invalidates the approval. */
export function planHash(plan) {
    const material = {
        runId: plan.runId,
        target: plan.target,
        requirement: plan.requirement,
        mode: plan.config.mode,
        stages: plan.config.stages.map((s) => [s.id, s.agent, s.enabled, s.model[plan.target], s.access, s.effort ?? null, Boolean(s.gateAfter)]),
        prices: plan.prices ?? null,
        estimateAs: plan.config.estimateAs ?? null,
        copilotProvider: plan.config.copilotProvider ?? null,
        budget: plan.config.budget,
        review: plan.config.review,
        test: plan.config.test,
        total: plan.estimate.totalUsd,
    };
    return createHash("sha256").update(JSON.stringify(material)).digest("hex").slice(0, 16);
}
export class RunStore {
    repoRoot;
    runId;
    dir;
    constructor(repoRoot, runId, artifactsDir = ".sdlc/runs") {
        this.repoRoot = repoRoot;
        this.runId = runId;
        this.dir = join(resolve(repoRoot), artifactsDir, runId);
    }
    static forPlan(plan) {
        return new RunStore(plan.repoRoot, plan.runId, plan.config.artifactsDir);
    }
    static latest(repoRoot, artifactsDir = ".sdlc/runs") {
        const base = join(resolve(repoRoot), artifactsDir);
        if (!existsSync(base))
            return undefined;
        // Newest by the plan's own timestamp (ms precision), not by directory name.
        const runs = readdirSync(base)
            .filter((d) => existsSync(join(base, d, "plan.json")))
            .map((d) => {
            let at = "";
            try {
                at = JSON.parse(readFileSync(join(base, d, "plan.json"), "utf8")).createdAt ?? "";
            }
            catch {
                /* unreadable plan: sort by name only */
            }
            return { d, at };
        });
        runs.sort((a, b) => (a.at === b.at ? a.d.localeCompare(b.d) : a.at.localeCompare(b.at)));
        return runs.pop()?.d;
    }
    file(name) {
        return join(this.dir, name);
    }
    savePlan(plan) {
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(this.file("plan.json"), JSON.stringify(plan, null, 2));
        writeFileSync(this.file("estimate.md"), renderEstimateMarkdown(plan));
    }
    loadPlan() {
        const f = this.file("plan.json");
        if (!existsSync(f))
            throw new Error(`No plan for run ${this.runId} at ${f}`);
        return JSON.parse(readFileSync(f, "utf8"));
    }
    approvals() {
        const f = this.file("approval.json");
        if (!existsSync(f))
            return [];
        const data = JSON.parse(readFileSync(f, "utf8"));
        return Array.isArray(data) ? data : [data];
    }
    /**
     * Records a human approval, signed with the key outside the repo.
     * `extraUsd` > 0 records a budget extension. `baseUsd` is the amount the caller already holds in memory
     * (the orchestrator passes it so a tampered approval.json cannot inflate an extension).
     */
    approve(plan, opts = {}) {
        const prev = this.approvals();
        const hash = planHash(plan);
        const last = prev[prev.length - 1];
        // Extensions stack only on a genuine approval of this exact plan; otherwise start from the plan's own estimate.
        const fresh = Math.min(plan.estimate.totalUsd.high, plan.config.budget.maxUsd);
        const base = opts.baseUsd ?? (last && last.planHash === hash && approvalSignatureValid(last) ? last.approvedUsd : fresh);
        const draft = {
            runId: plan.runId,
            planHash: hash,
            approvedAt: new Date().toISOString(),
            approvedBy: opts.by ?? safeUser(),
            approvedUsd: +(base + (opts.extraUsd ?? 0)).toFixed(4),
            note: opts.note,
        };
        const approval = { ...draft, signature: signApproval(draft, approvalKey(true)) };
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(this.file("approval.json"), JSON.stringify([...prev, approval], null, 2));
        return approval;
    }
    /** Returns the current approval, or throws if the plan was never approved or changed after approval. */
    requireApproval(plan) {
        const list = this.approvals();
        const last = list[list.length - 1];
        if (!last)
            throw new Error(`Run ${plan.runId} has not been approved. Run: sdlc-estimate approve ${plan.runId}`);
        if (last.planHash !== planHash(plan)) {
            throw new Error(`Plan for run ${plan.runId} changed after approval (hash mismatch). Re-estimate and approve again.`);
        }
        if (!approvalSignatureValid(last)) {
            throw new Error(`Approval for run ${plan.runId} has no valid signature: approval.json was not written by \`sdlc-estimate approve\` on this machine. Approve again.`);
        }
        return last;
    }
    saveActuals(actuals) {
        writeFileSync(this.file("actuals.json"), JSON.stringify(actuals, null, 2));
    }
    loadActuals() {
        const f = this.file("actuals.json");
        return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : [];
    }
    /** Report path. Numbers are fixed per stage (01-requirements … 09-release) so every flow agrees on names. */
    artifactPath(stage, iteration = 0) {
        const nn = String(STAGE_ORDER.indexOf(stage) + 1).padStart(2, "0");
        return this.file(iteration ? `${nn}-${stage}.r${iteration}.md` : `${nn}-${stage}.md`);
    }
    /** Newest existing report of a stage (highest rework round), or the base path. */
    latestArtifact(stage) {
        for (let k = 20; k > 0; k--) {
            const p = this.artifactPath(stage, k);
            if (existsSync(p))
                return p;
        }
        return this.artifactPath(stage);
    }
    log(event) {
        mkdirSync(this.dir, { recursive: true });
        writeFileSync(this.file("events.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n", { flag: "a" });
    }
}
function safeUser() {
    try {
        return userInfo().username;
    }
    catch {
        return process.env.USER ?? "unknown";
    }
}
//# sourceMappingURL=plan.js.map