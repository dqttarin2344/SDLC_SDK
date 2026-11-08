import { join } from "node:path";
import { STAGE_ORDER, isInherit, loadConfig, loadRoles, stageSystemPrompt, writeFile, type Role, type SdlcConfig } from "@sdlc/core";

/** "claude-sonnet-5.5" → "Claude Sonnet 5.5 (copilot)", the model naming VS Code agent files use. */
export function vscodeModelName(id: string): string {
  const pretty = id
    .split("-")
    .map((p) => (/^gpt$/i.test(p) ? "GPT" : /^\d/.test(p) ? p : p[0]!.toUpperCase() + p.slice(1)))
    .join(" ")
    .replace(/^GPT /, "GPT-");
  return `${pretty} (copilot)`;
}

const yamlStr = (s: string) => JSON.stringify(s);

function stageTitle(role: Role): string {
  return role.stage.replace(/-/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/** Copilot-only preamble: approval check and where to write the report. */
function copilotPreamble(role: Role): string {
  const nn = String(STAGE_ORDER.indexOf(role.stage) + 1).padStart(2, "0"); // fixed per stage, same as the SDK runner
  return [
    "## Before you start (required)",
    "1. Run `npx --no-install sdlc-estimate verify <runId>` in the terminal, using the run id from the conversation (the approved estimate); use `latest` only if no run id appears above.",
    "   - If it fails, **stop**: tell the user the cost estimate has not been approved and to use the **sdlc-planner** agent (`/sdlc`). Do no other work.",
    "   - If it succeeds, note the run id it prints. The run directory is `.sdlc/runs/<runId>/`.",
    "2. Read `.sdlc/runs/<runId>/plan.json` for the requirement, mode, test commands and enabled stages, and read every earlier stage report in that directory.",
    `3. Write your report to \`.sdlc/runs/<runId>/${nn}-${role.stage}.md\` (if that file exists because this is a rework round, write \`${nn}-${role.stage}.rK.md\` with the next K).`,
    "",
  ].join("\n");
}

export function copilotAgentMarkdown(role: Role, cfg: SdlcConfig, roles: Role[]): string {
  const stage = cfg.stages.find((s) => s.id === role.stage);
  const handoffs: string[] = [];
  const next = roles.find((r) => r.name === role.next);
  if (next) {
    handoffs.push(
      `  - label: ${yamlStr(`▶ Next: ${stageTitle(next)}`)}`,
      `    agent: ${next.name}`,
      `    prompt: ${yamlStr(`Continue the approved SDLC run (see the conversation above): do the ${next.stage} stage.`)}`,
      "    send: false",
    );
  }
  const back = roles.find((r) => r.name === role.back);
  if (back) {
    handoffs.push(
      `  - label: ${yamlStr(`↩ Send back to ${back.title}`)}`,
      `    agent: ${back.name}`,
      `    prompt: ${yamlStr(`Fix the issues reported in the ${role.stage} report above (only BLOCKER/MAJOR findings or product defects). Write a new implementation report.`)}`,
      "    send: false",
    );
  }
  const frontmatter = [
    `name: ${role.name}`,
    `description: ${yamlStr(role.description)}`,
    `tools: [${role.copilotTools.map((t) => `'${t}'`).join(", ")}]`,
    // "inherit": no model line, so the agent uses whatever model is picked in the chat model picker.
    stage && !isInherit(stage.model.copilot) && `model: ${yamlStr(vscodeModelName(stage.model.copilot))}`,
    handoffs.length && "handoffs:\n" + handoffs.join("\n"),
  ].filter(Boolean);
  return ["---", ...frontmatter, "---", "", copilotPreamble(role), stageSystemPrompt(role), ""].join("\n");
}

export function plannerAgentMarkdown(): string {
  return `---
name: sdlc-planner
description: "Entry point of the SDLC agent pipeline. Estimates the cost of a run (tokens, USD, AI credits) and waits for the human to approve, cheapen or change the plan before any stage starts."
tools: ['execute', 'read']
handoffs:
  - label: "✅ Approve & start: Requirements"
    agent: sdlc-analyst
    prompt: "I APPROVE the most recent cost estimate shown above. First run \`npx --no-install sdlc-estimate approve <runId of that estimate> --note 'approved in GitHub Copilot'\` (use the exact run id printed with the estimate, not 'latest'), then do the requirements stage."
    send: false
  - label: "💰 Re-estimate cheaper (economy preset)"
    agent: sdlc-planner
    prompt: "Re-estimate the same requirement with --preset economy (keep my other options)."
    send: true
  - label: "✏️ Change the plan"
    agent: sdlc-planner
    prompt: "Change the plan: "
    send: false
---

You are the **SDLC Planner**. You never write code or start pipeline stages yourself. Your only job is to produce a cost estimate and let the human decide.

## Steps
1. Take the requirement from the user's message (and any options such as preset, mode, budget, stages to skip, model overrides).
2. Run in the terminal, passing the requirement through a quoted heredoc so quotes, parentheses or \`$\` in it are never interpreted by the shell:
   \`\`\`bash
   npx --no-install sdlc-estimate plan --target copilot --markdown [options] -f - <<'SDLC_REQ_<hex>'
   <requirement text, verbatim>
   SDLC_REQ_<hex>
   \`\`\`
   Use a heredoc delimiter \`SDLC_REQ_<8 random hex chars>\` that does not occur anywhere in the requirement text.
   Options: \`--preset economy|balanced|quality\`, \`--mode feature|modify|bugfix\`, \`--budget <usd>\`, \`--disable <stage,...>\`, \`--only <stage,...>\`, \`--model <stage>=<model>\`, \`--complexity S|M|L|XL\`, \`--review-iterations <n>\`, \`--test-fix-iterations <n>\`.
3. Show the Markdown table from the output to the user unchanged (it includes the run id), then add 2–3 sentences: the expected and worst-case cost, the most expensive stages, and the cheapest levers.
4. End with: **"Choose a button below: Approve & start, Re-estimate cheaper, or Change the plan."** If the estimate exceeds the budget, say approval is blocked until the plan is changed or the budget is raised.

## Rules
- Do **not** run \`sdlc-estimate approve\` yourself. Approval happens only when the human clicks **Approve & start** and sends that message.
- Stage runs inside Copilot Chat spend AI credits roughly as estimated but are not hard-capped by this tool. For a hard cap, tell the user to run \`npx sdlc-copilot run "<requirement>"\` in a terminal, or set an AI-credit budget in their GitHub billing settings.
`;
}

/** Writes .github/agents/*.agent.md (planner + one agent per role) into `outDir`. */
export function generateCopilotAgents(outDir: string, repoRoot = process.cwd()): string[] {
  const cfg = loadConfig(repoRoot);
  const roles = loadRoles();
  const files: string[] = [];
  const planner = join(outDir, ".github", "agents", "sdlc-planner.agent.md");
  writeFile(planner, plannerAgentMarkdown());
  files.push(planner);
  for (const role of roles) {
    const p = join(outDir, ".github", "agents", `${role.name}.agent.md`);
    writeFile(p, copilotAgentMarkdown(role, cfg, roles));
    files.push(p);
  }
  return files;
}
