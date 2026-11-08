import { CopilotClient } from "@github/copilot-sdk";
import { checkCommand, checkReadPath, checkWritePath, costUsd, lookupPrice, resolveModel } from "@sdlc/core";
/**
 * Runs one SDLC stage as a GitHub Copilot SDK session.
 * The Copilot SDK has no built-in USD cap, so spend is computed from `assistant.usage`
 * events with the Copilot price table and the session is aborted when it reaches the stage budget.
 */
export class CopilotAdapter {
    opts;
    target = "copilot";
    client;
    constructor(opts = {}) {
        this.opts = opts;
    }
    async getClient() {
        if (!this.client) {
            this.client = new CopilotClient();
            await this.client.start();
        }
        return this.client;
    }
    async runStage(req) {
        const log = this.opts.log ?? ((l) => process.stdout.write(l + "\n"));
        const verbose = this.opts.verbose ?? true;
        const resolved = resolveModel(req.plan.config, req.stage, "copilot");
        // Price each usage event by the model that served it; unknown models fall back to the plan's estimate price.
        const fallbackPrice = req.plan.prices?.[resolved.priced];
        const priceFor = (m) => (m ? lookupPrice("copilot", m, req.plan.prices) : undefined) ?? fallbackPrice;
        const usedModels = new Set();
        const provider = req.plan.config.copilotProvider;
        if (provider && !resolved.run) {
            throw new Error('copilotProvider (bring-your-own-key) needs an explicit model: set the stage model (e.g. --model "*=deepseek-chat"), not "inherit".');
        }
        const result = { status: "failed", usd: 0, turns: 0, tokens: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 } };
        let reportedNanoAiu = 0;
        let stopReason;
        const onPermission = (request) => {
            const r = request;
            const testCommands = Object.values(req.plan.config.test.commands).filter((c) => Boolean(c));
            if (r.kind === "shell") {
                if (!req.role.copilotTools.includes("execute"))
                    return { kind: "reject", feedback: `${req.role.name} may not run shell commands` };
                const d = checkCommand(r.fullCommandText ?? "", req.stage.access, { readOnlyAllow: testCommands });
                return d.allow ? { kind: "approve-once" } : { kind: "reject", feedback: d.reason };
            }
            if (r.kind === "write") {
                // A patch can touch several files (and rename them): every path must pass.
                const paths = [r.fileName, ...(r.fileEdits ?? []).flatMap((e) => [e.before?.path, e.after?.path])].filter((p) => Boolean(p));
                for (const p of paths.length ? paths : [""]) {
                    const d = checkWritePath(p, req.stage.access, req.plan.repoRoot, req.runDir);
                    if (!d.allow)
                        return { kind: "reject", feedback: d.reason };
                }
                return { kind: "approve-once" };
            }
            if (r.kind === "read") {
                const d = checkReadPath(r.path ?? "");
                return d.allow ? { kind: "approve-once" } : { kind: "reject", feedback: d.reason };
            }
            if (r.kind === "url") {
                return req.role.copilotTools.includes("web") ? { kind: "approve-once" } : { kind: "reject", feedback: `${req.role.name} has no web access` };
            }
            // Anything else (MCP, extensions, env access, memory, workflows, hooks…) is outside the pipeline's needs.
            return { kind: "reject", feedback: `SDLC guard: permission kind "${r.kind}" is not allowed in pipeline stages` };
        };
        const client = await this.getClient();
        const session = await client.createSession({
            // "inherit": no model set, so the session's default / auto model applies.
            ...(resolved.run ? { model: resolved.run } : {}),
            ...(provider
                ? {
                    provider: {
                        type: provider.type,
                        wireApi: provider.wireApi,
                        baseUrl: provider.baseUrl,
                        apiKey: provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined,
                    },
                }
                : {}),
            reasoningEffort: req.stage.effort,
            workingDirectory: req.plan.repoRoot,
            systemMessage: { mode: "append", content: req.systemPrompt },
            onPermissionRequest: onPermission,
        });
        const unsubs = [];
        unsubs.push(session.on("assistant.usage", (event) => {
            const d = event.data;
            const cacheRead = d.cacheReadTokens ?? 0;
            const cacheWrite = d.cacheWriteTokens ?? 0;
            const rawInput = d.inputTokens ?? 0;
            // Some providers report input including cached tokens; count fresh input only once.
            const input = rawInput >= cacheRead + cacheWrite ? rawInput - cacheRead - cacheWrite : rawInput;
            const t = result.tokens;
            t.input += input;
            t.cacheRead += cacheRead;
            t.cacheWrite += cacheWrite;
            t.output += d.outputTokens ?? 0;
            reportedNanoAiu += d.copilotUsage?.totalNanoAiu ?? 0;
            result.turns++;
            if (d.model)
                usedModels.add(d.model);
            const price = priceFor(d.model);
            result.usd += price ? costUsd(price, { input, cacheRead, cacheWrite, output: d.outputTokens ?? 0 }, rawInput) : NaN;
            // A non-finite cost must stop the session, never let it run uncapped.
            if ((!Number.isFinite(result.usd) || result.usd >= req.budgetUsd) && !stopReason) {
                stopReason = "budget";
                void session.abort();
            }
        }));
        if (verbose) {
            unsubs.push(session.on("tool.execution_start", (event) => {
                const d = event.data;
                log(`    · ${d.toolName ?? "tool"} ${summarize(d.arguments)}`);
            }));
        }
        const onAbort = () => {
            stopReason ??= "abort";
            void session.abort();
        };
        req.signal.addEventListener("abort", onAbort, { once: true });
        try {
            await session.sendAndWait({ prompt: req.userPrompt }, this.opts.timeoutMs ?? 60 * 60 * 1000);
            result.status = stopReason === "budget" ? "budget_exceeded" : stopReason === "abort" ? "aborted" : "ok";
        }
        catch (err) {
            if (stopReason === "budget")
                result.status = "budget_exceeded";
            else if (stopReason === "abort")
                result.status = "aborted";
            else {
                result.status = "failed";
                result.error = err.message;
            }
        }
        finally {
            req.signal.removeEventListener("abort", onAbort);
            unsubs.forEach((u) => u());
            result.sessionId = session.sessionId;
            await session.disconnect().catch(() => undefined);
        }
        if (usedModels.size)
            result.model = [...usedModels].join(", ");
        if (verbose && reportedNanoAiu)
            log(`    (Copilot reported ${reportedNanoAiu} nano-AIU for this stage)`);
        return result;
    }
    async dispose() {
        if (this.client)
            await this.client.stop();
        this.client = undefined;
    }
    /** Models available to the signed-in Copilot account. */
    async listModels() {
        const client = await this.getClient();
        const models = (await client.listModels());
        return models;
    }
}
function summarize(input) {
    const i = (input ?? {});
    const v = i.path ?? i.file_path ?? i.command ?? i.pattern ?? i.url ?? i.query ?? "";
    const s = String(v).replace(/\s+/g, " ");
    return s.length > 90 ? s.slice(0, 89) + "…" : s;
}
//# sourceMappingURL=adapter.js.map