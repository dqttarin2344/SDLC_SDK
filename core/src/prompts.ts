import { relative } from "node:path";
import type { Role } from "./roles.js";
import type { RunPlan, StageConfig } from "./types.js";

export interface StagePromptInput {
  plan: RunPlan;
  stage: StageConfig;
  role: Role;
  index: number;
  total: number;
  artifactPath: string;
  priorArtifacts: string[];
  /** Report the agent must act on (review findings / failing tests / human feedback). */
  feedback?: { kind: "review" | "test" | "human" | "resume"; path?: string; text?: string };
}

const VERDICT_HINT: Partial<Record<string, string>> = {
  review: "End the report with exactly one line: `VERDICT: APPROVED` or `VERDICT: CHANGES_REQUESTED`.",
  "unit-test": "End the report with exactly one line: `VERDICT: PASS` or `VERDICT: FAIL`.",
  "integration-test": "End the report with exactly one line: `VERDICT: PASS` or `VERDICT: FAIL`.",
  "functional-test": "End the report with exactly one line: `VERDICT: PASS` or `VERDICT: FAIL`.",
};

/** System-prompt addition: the role persona plus pipeline-wide rules. */
export function stageSystemPrompt(role: Role): string {
  return [
    role.body,
    "",
    "## Pipeline rules (all stages)",
    "- You are one stage of an automated, cost-budgeted SDLC pipeline. Stay inside your stage's mission.",
    "- Be economical: read what you need, avoid re-reading large files, do not explore unrelated code.",
    "- Write your report to the exact path you are given. The report is your only hand-off to the next stage.",
    "- Never commit, push, publish, deploy, or read/write secrets.",
  ].join("\n");
}

/** The user prompt for one stage run. */
export function stageUserPrompt(i: StagePromptInput): string {
  const rel = (p: string) => relative(i.plan.repoRoot, p) || p;
  const cmds = i.plan.config.test.commands;
  const lines = [
    `# SDLC pipeline — stage ${i.index + 1}/${i.total}: ${i.stage.id} (${i.role.title})`,
    `Run id: ${i.plan.runId} · repository root: ${i.plan.repoRoot} · mode: ${i.plan.config.mode}`,
    "",
    "## Requirement",
    i.plan.requirement.trim(),
    "",
  ];
  if (i.priorArtifacts.length) {
    lines.push("## Inputs from earlier stages (read these first)", ...i.priorArtifacts.map((p) => `- ${rel(p)}`), "");
  }
  if (i.feedback) {
    const head = {
      review: "## Fix the review findings",
      test: "## Fix the product defects found by tests",
      human: "## Feedback from the human reviewer",
      resume: "## Continue the interrupted stage",
    }[i.feedback.kind];
    lines.push(head);
    if (i.feedback.path) lines.push(`Read: ${rel(i.feedback.path)}`);
    if (i.feedback.text) lines.push(i.feedback.text);
    lines.push("");
  }
  if (i.stage.access === "write" || i.stage.id === "review") {
    const known = Object.entries(cmds).filter(([, v]) => v).map(([k, v]) => `- ${k}: \`${v}\``);
    if (known.length) lines.push("## Test commands", ...known, "");
  }
  lines.push(
    "## Deliverable",
    `Write your report (Markdown) to: ${rel(i.artifactPath)}`,
    i.stage.access === "read-only"
      ? "This stage is read-only: do not modify any file except your report."
      : "You may modify the repository as your role allows. Do not edit other stages' reports.",
  );
  const verdict = VERDICT_HINT[i.stage.id];
  if (verdict) lines.push(verdict);
  return lines.join("\n");
}

export type Verdict = "APPROVED" | "CHANGES_REQUESTED" | "PASS" | "FAIL";

/** Last `VERDICT:` line in a report, if any. */
export function parseVerdict(report: string): Verdict | undefined {
  const matches = [...report.matchAll(/^\s*\**VERDICT:?\**\s*:?\s*\**(APPROVED|CHANGES_REQUESTED|PASS|FAIL)\b/gim)];
  const last = matches[matches.length - 1];
  return last ? (last[1]!.toUpperCase() as Verdict) : undefined;
}
