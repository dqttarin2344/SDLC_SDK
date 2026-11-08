## SDLC agent pipeline

This repository uses an SDLC agent pipeline: requirements → research → design → implement → review → unit / integration / functional tests → release notes.

- Start with `/sdlc <requirement>` in Copilot Chat. It opens the **sdlc-planner** agent, which shows a cost estimate (USD and AI credits), then advances automatically once you approve the plan.
- No stage agent (`sdlc-analyst`, `sdlc-researcher`, `sdlc-architect`, `sdlc-developer`, `sdlc-reviewer`, `sdlc-*-tester`, `sdlc-release`) may do work until `npx --no-install sdlc-estimate verify latest` succeeds.
- Each stage writes a report to `.sdlc/runs/<runId>/NN-<stage>.md`; the next stage reads the earlier reports and the pipeline automatically continues without requiring a manual handoff click between stages.
- Settings (models per stage, budget cap, review/test loop limits, test commands) live in `sdlc.config.json`.
- Never commit, push, publish or touch `.env` files as part of the pipeline.
