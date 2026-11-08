/**
 * Shared types for the SDLC agent pipeline.
 * Both the Claude and the GitHub Copilot adapters consume these.
 */

export type Target = "claude" | "copilot";

export type StageId =
  | "requirements"
  | "research"
  | "design"
  | "implement"
  | "review"
  | "unit-test"
  | "integration-test"
  | "functional-test"
  | "release";

/** Whether a stage may modify the codebase or only write its own report. */
export type StageAccess = "read-only" | "write";

export type Complexity = "S" | "M" | "L" | "XL";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type WorkMode = "feature" | "modify" | "bugfix";

export interface StageConfig {
  id: StageId;
  /** Agent/role name, e.g. "sdlc-analyst". Must exist in packages/core/roles. */
  agent: string;
  enabled: boolean;
  access: StageAccess;
  /**
   * Model per target. "inherit" (the default) runs the stage on whatever model your session already uses
   * (Claude Code / Copilot picker / ANTHROPIC_MODEL / DeepSeek via ANTHROPIC_BASE_URL…) and prices it as `estimateAs`.
   * Otherwise a model id: Claude IDs look like "claude-sonnet-5-5"; Copilot IDs like "claude-sonnet-5.5".
   */
  model: Record<Target, string>;
  effort?: Effort;
  /** Pause for a human checkpoint after this stage finishes (interactive mode). */
  gateAfter?: boolean;
}

/** Token-usage profile used by the estimator for one stage. */
export interface StageProfile {
  /** Expected agent turns (model round-trips) by complexity. */
  turns: Record<Complexity, number>;
  /** Average output tokens per turn (includes thinking). */
  outputPerTurn: number;
  /** Fixed context each turn starts with: system prompt + tool schemas + role prompt. */
  baseContext: number;
  /** New context added per turn (tool results, file reads, own messages). */
  growthPerTurn: number;
  /** Fraction of the repository's tokens this stage is expected to read. */
  repoReadShare: number;
  /** Upper bound on repository tokens read by this stage. */
  repoReadCap: number;
}

export interface BudgetConfig {
  /** Hard ceiling for one pipeline run, in USD. Plans above it cannot be approved without raising it. */
  maxUsd: number;
  /** Allowed overrun above the approved amount before the run pauses and asks again (0.25 = 25%). */
  overrunTolerance: number;
}

export interface CopilotProviderConfig {
  type?: "openai" | "azure" | "anthropic";
  baseUrl: string;
  /** Name of the environment variable that holds the API key (the key itself never goes in config). */
  apiKeyEnv?: string;
  wireApi?: "completions" | "responses";
}

export interface SdlcConfig {
  mode: WorkMode;
  complexity: Complexity | "auto";
  /** Model used to price stages whose model is "inherit". Precedence: this setting, then $ANTHROPIC_MODEL (Claude), then a Sonnet-class default. */
  estimateAs?: Partial<Record<Target, string>>;
  /** Your own prices (USD per 1M tokens) for models the built-in tables do not know, e.g. DeepSeek. */
  prices?: Partial<Record<Target, Record<string, import("./pricing.js").ModelPrice>>>;
  /** GitHub Copilot SDK "bring your own key" provider, e.g. an OpenAI-compatible DeepSeek endpoint. */
  copilotProvider?: CopilotProviderConfig;
  budget: BudgetConfig;
  review: { maxIterations: number };
  test: {
    maxFixIterations: number;
    commands: { unit?: string; integration?: string; functional?: string };
  };
  /**
   * OS-level sandbox for agent shell commands (Claude Agent SDK `sandbox`): blocks writes to .git, the
   * pipeline state directory and the signing key even if a command slips past the regex guard.
   * `required: true` refuses to run where no sandbox is available.
   */
  sandbox: { enabled: boolean; required: boolean };
  /** Where run artifacts (reports, estimates, approvals) live, relative to the repo root. */
  artifactsDir: string;
  stages: StageConfig[];
  /** Optional per-stage overrides of the built-in estimation profiles. */
  profiles?: Partial<Record<StageId, Partial<StageProfile>>>;
  /** Extra glob-ish path fragments the repository scanner should skip. */
  scanIgnore?: string[];
}

export interface RepoStats {
  root: string;
  files: number;
  sourceFiles: number;
  testFiles: number;
  totalTokens: number;
  languages: Record<string, number>;
  hasTests: boolean;
  packageManager?: string;
  detectedTestCommand?: string;
}

export interface TokenBreakdown {
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
}

export interface CostRange {
  low: number;
  expected: number;
  high: number;
}

export interface StageEstimate {
  stage: StageId;
  agent: string;
  /** Model the cost is computed for (for inherited stages: the `estimateAs` model). */
  model: string;
  /** True when the stage runs on the session's own model ("inherit"). */
  inherited: boolean;
  turns: CostRange;
  tokens: TokenBreakdown; // expected case
  usd: CostRange;
  /** Calibration factor applied from the ledger (1 = none). */
  calibration: number;
  notes: string[];
}

export interface PipelineEstimate {
  target: Target;
  complexity: Complexity;
  requirementTokens: number;
  repo: RepoStats;
  stages: StageEstimate[];
  /** Review/test-fix rework loops (implement + re-check), priced separately. */
  rework: CostRange;
  totalUsd: CostRange;
  /** Copilot only: AI credits (1 credit = $0.01). */
  totalCredits?: CostRange;
  budget: BudgetConfig;
  withinBudget: boolean;
  assumptions: string[];
}

export interface RunPlan {
  runId: string;
  createdAt: string;
  target: Target;
  requirement: string;
  repoRoot: string;
  config: SdlcConfig;
  estimate: PipelineEstimate;
  /** Prices (USD/1M tokens) of the models this plan uses, frozen at planning time and covered by the approval. */
  prices: Record<string, import("./pricing.js").ModelPrice>;
}

export interface Approval {
  runId: string;
  planHash: string;
  approvedAt: string;
  approvedBy: string;
  /** Amount the human approved: the plan's high estimate, capped by the budget. */
  approvedUsd: number;
  note?: string;
  /** HMAC over the approval, keyed by a secret outside the repository (see approvalKeyPath()). */
  signature?: string;
}

export interface StageActual {
  stage: StageId;
  model: string;
  usd: number;
  tokens: TokenBreakdown;
  turns: number;
  iteration: number;
  status: "ok" | "failed" | "budget_exceeded" | "aborted";
}

export interface LedgerEntry {
  runId: string;
  target: Target;
  at: string;
  stage: StageId;
  model: string;
  complexity: Complexity;
  estimatedUsd: number;
  actualUsd: number;
}
