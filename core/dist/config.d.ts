import type { SdlcConfig, StageConfig, StageId, Target } from "./types.js";
export declare const CORE_ROOT: string;
export declare const ROLES_DIR: string;
export declare const DEFAULT_CONFIG_PATH: string;
export declare const CONFIG_FILE = "sdlc.config.json";
export declare const STAGE_ORDER: StageId[];
/**
 * Load config: built-in defaults <- repo sdlc.config.json <- explicit overrides.
 * Also applies SDLC_PRICING_FILE price overrides if set.
 */
export declare function loadConfig(repoRoot: string, overrides?: Partial<SdlcConfig>): SdlcConfig;
export declare function validateConfig(cfg: SdlcConfig): void;
/** Apply mode-specific stage defaults: bugfix mode skips research and release notes. */
export declare function applyMode(cfg: SdlcConfig): SdlcConfig;
export declare function enabledStages(cfg: SdlcConfig): StageConfig[];
export declare const INHERIT = "inherit";
export declare const isInherit: (model: string | undefined) => boolean;
/** The model used to price stages that inherit the session model. */
export declare function estimateModel(cfg: SdlcConfig, target: Target): string;
export interface ResolvedModel {
    /** What is passed to the SDK: undefined means "do not set a model, use the session's". */
    run: string | undefined;
    /** Model the cost estimate is computed for. */
    priced: string;
    inherited: boolean;
    /** Label for tables: the model id, or "inherit". */
    label: string;
}
export declare function resolveModel(cfg: SdlcConfig, stage: Pick<StageConfig, "model">, target: Target): ResolvedModel;
export declare function modelFor(cfg: SdlcConfig, stage: StageId, target: Target): string;
