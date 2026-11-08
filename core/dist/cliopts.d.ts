import type { SdlcConfig, Target } from "./types.js";
/** Plan-shaping CLI flags shared by sdlc-estimate, sdlc-claude and sdlc-copilot. */
export declare const PLAN_OPTIONS: {
    readonly requirement: {
        readonly type: "string";
        readonly short: "r";
    };
    readonly "requirement-file": {
        readonly type: "string";
        readonly short: "f";
    };
    readonly repo: {
        readonly type: "string";
        readonly default: ".";
    };
    readonly preset: {
        readonly type: "string";
    };
    readonly complexity: {
        readonly type: "string";
    };
    readonly mode: {
        readonly type: "string";
    };
    readonly budget: {
        readonly type: "string";
    };
    readonly disable: {
        readonly type: "string";
    };
    readonly enable: {
        readonly type: "string";
    };
    readonly only: {
        readonly type: "string";
    };
    readonly model: {
        readonly type: "string";
        readonly multiple: true;
    };
    readonly "estimate-as": {
        readonly type: "string";
    };
    readonly "review-iterations": {
        readonly type: "string";
    };
    readonly "test-fix-iterations": {
        readonly type: "string";
    };
};
export interface PlanFlags {
    requirement?: string;
    "requirement-file"?: string;
    preset?: string;
    complexity?: string;
    mode?: string;
    budget?: string;
    disable?: string;
    enable?: string;
    only?: string;
    model?: string[];
    "estimate-as"?: string;
    "review-iterations"?: string;
    "test-fix-iterations"?: string;
}
export declare const PLAN_HELP = "Plan options:\n  -r, --requirement <text>       The request to build (or pass it as positional text)\n  -f, --requirement-file <path>  Read the request from a file (\"-\" = stdin)\n      --repo <path>              Repository root (default: .)\n      --preset <name>            inherit | economy | balanced | quality (inherit = your session model everywhere)\n      --complexity <c>           auto | S | M | L | XL\n      --mode <m>                 feature | modify | bugfix\n      --budget <usd>             Budget cap for the run\n      --disable <ids>            Comma list of stages to skip (e.g. research,release)\n      --enable <ids>             Comma list of stages to turn on\n      --only <ids>               Run only these stages\n      --model <stage=model>      Override a stage's model (repeatable); \"*=<model>\" sets every stage;\n                                 a model of \"inherit\" uses the model of your session\n      --estimate-as <model>      Price \"inherit\" stages as this model (e.g. your DeepSeek id; needs a price in config)\n      --review-iterations <n>    Max review\u2192fix rounds\n      --test-fix-iterations <n>  Max test\u2192fix rounds per test stage";
export declare function readRequirement(flags: PlanFlags, positionals: string[]): string;
/** Applies CLI flags on top of a loaded config. */
export declare function applyPlanFlags(cfg: SdlcConfig, flags: PlanFlags, target: Target): SdlcConfig;
