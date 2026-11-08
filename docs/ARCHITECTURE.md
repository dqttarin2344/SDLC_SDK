# Architecture

## Layers

```
            ┌────────────────────────── @sdlc/core ──────────────────────────┐
 request →  │ scanner → estimator → approvalGate ──approved──► orchestrator  │
            │   (repo)   (tokens→USD)  (approve/modify/      (stages, loops, │
            │                           save/cancel)          budget, gates) │
            │ plan.ts: RunStore (plan.json, approval.json+hash, actuals,     │
            │          reports)        ledger.ts: estimate vs actual          │
            │ roles/*.md (single source of agent prompts)   guard.ts          │
            └──────────────────────────────┬─────────────────────────────────┘
                                           │ AgentAdapter.runStage(req)
                    ┌──────────────────────┴───────────────────────┐
             @sdlc/claude                                   @sdlc/copilot
   query() · maxBudgetUsd · canUseTool +              CopilotClient.createSession ·
   PreToolUse guard · resume                          assistant.usage → USD → abort ·
   generate → .claude/agents, /sdlc                   onPermissionRequest guard
                                                      generate → .github/agents (handoffs)
```

## Data flow of one run

1. `createPlan` loads `sdlc.config.json` (merged over defaults) and scans the repo. It then estimates each enabled stage, adds rework loops, and applies the ledger calibration.
2. `approvalGate` saves `plan.json` and `estimate.md`, then loops through approve / modify / save / cancel. Approving writes `approval.json` with `planHash(plan)`.
3. `runPipeline` checks the approval first. It throws if the plan was never approved or if its hash changed. Then, for each enabled stage:
   - It builds the system prompt (role + pipeline rules) and the user prompt (requirement, earlier reports, test commands, report path, verdict rule).
   - It calls `adapter.runStage` with `budgetUsd = approved − spent`.
   - A `budget_exceeded` result makes it ask for an extension, then resume the stage. `failed` lets the user retry or stop. `aborted` (Ctrl-C) stops the run.
   - It writes actuals to `actuals.json` and adds a first-iteration estimate-vs-actual row to the ledger.
   - It reads the `VERDICT` line. `CHANGES_REQUESTED` from review sends the work back to implement and then review again. `FAIL` from a test stage sends it to implement and then the same test again. Both loops are bounded.
   - It runs the soft checkpoint (spend vs estimate) and the human checkpoint on `gateAfter` stages.
4. At the end it prints a table of estimated vs actual cost per stage.

## Estimation model

For each stage, the expected turns are `profile.turns[complexity] × modeFactor`. Each turn re-sends the current context: start context plus growth per turn, where growth comes from tool output, file reads and the turn's own output. Context is compacted at 160k tokens. Under prompt caching, this is billed as:

- cache writes: each new token is written once, and each compaction rewrites the compacted context;
- cache reads: the rest of the re-sent context;
- uncached input: about 300 tokens per turn;
- output: `outputPerTurn` per turn.

Low and high use 0.6× and 1.8× the expected turns. Rework adds 50% of one review round to the expected case and every allowed round to the high case. Test-fix rounds add 30% of one round to the expected case and every allowed round to the high case. All numbers are tunable per stage via `profiles`.

## Extending

- **Add or adjust a role:** edit `packages/core/roles/<name>.md`, then run `npm run generate`. Both IDE templates are regenerated.
- **Change models or prices:** edit `sdlc.config.json`, or point `SDLC_PRICING_FILE` at a new price table.
- **New platform:** implement `AgentAdapter` (one method, `runStage`). It must stop the stage at or just past `budgetUsd` and report `usd`, `tokens`, `turns` and `status`. Wire it up with `runCommand` / `executeCommand` from `@sdlc/core`.
- **Custom UI or approvals (Slack, web):** implement `GateIO` (`print`, `ask`, `interactive`) and pass it to `approvalGate` and `runPipeline`.
