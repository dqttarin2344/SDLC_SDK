## SDLC agent pipeline

This repository uses the SDLC agent pipeline (requirements → research → design → implement → review → unit / integration / functional tests → release notes).

- Start a run with `/sdlc <requirement>`. Estimate only: `/sdlc-estimate <requirement>`.
- **No pipeline stage may start before the human approves the cost estimate.** Approval is recorded with `npx --no-install sdlc-estimate approve <runId>` and checked with `sdlc-estimate verify <runId>`.
- Approvals are signed with a key in `~/.config/sdlc/` (outside the repo); every `approve` asks the human to confirm, and a PreToolUse hook (`sdlc-estimate guard-hook`) applies the pipeline guard to every agent, subagents included.
- Stage agents live in `.claude/agents/sdlc-*.md`. Each writes its report to `.sdlc/runs/<runId>/NN-<stage>.md`; later stages read earlier reports.
- Pipeline settings (models per stage, budget cap, loops, test commands): `sdlc.config.json`.
- For a hard, SDK-enforced budget run the pipeline from a terminal instead: `npx sdlc-claude run "<requirement>"`.
