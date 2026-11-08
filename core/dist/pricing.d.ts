import type { Target } from "./types.js";
/** USD per 1M tokens. */
export interface ModelPrice {
    input: number;
    output: number;
    cacheRead: number;
    /** Cache write (5-minute TTL). Anthropic charges 1.25x input. */
    cacheWrite: number;
    /** Optional higher tier above a prompt-size threshold (tokens). */
    longContext?: {
        threshold: number;
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
}
/**
 * Claude API list prices (Anthropic first-party), snapshot 2026-10.
 * Override at runtime with SDLC_PRICING_FILE=/path/to/pricing.json if prices change.
 */
export declare const CLAUDE_PRICES: Record<string, ModelPrice>;
/**
 * GitHub Copilot usage-based billing (AI credits, 1 credit = $0.01), snapshot 2026-11
 * from docs.github.com "Models and pricing for GitHub Copilot".
 * Copilot does not publish cache-write prices in that table; 1.25x input is assumed for Anthropic models.
 */
export declare const COPILOT_PRICES: Record<string, ModelPrice>;
/** Monthly AI-credit allowances for individual Copilot plans (for "% of plan" display). */
export declare const COPILOT_PLAN_CREDITS: Record<string, number>;
/** Throws unless every price is a finite, non-negative number (a NaN price would silently disable budget caps). */
export declare function validatePrice(model: string, p: unknown): ModelPrice;
export declare function setPricingOverrides(o: Partial<Record<Target, Record<string, ModelPrice>>>): void;
export declare function priceTable(target: Target): Record<string, ModelPrice>;
export declare function getPrice(target: Target, model: string): ModelPrice;
/** Strip decorations a session model id may carry: "deepseek-v4-pro[1m]" → "deepseek-v4-pro". */
export declare function normalizeModelId(model: string): string;
/** Price of a model if known (frozen plan prices, then config/user prices, then built-in tables). */
export declare function lookupPrice(target: Target, model: string, frozen?: Record<string, ModelPrice>): ModelPrice | undefined;
/** Cost in USD of a token breakdown. `promptSize` selects the long-context tier when applicable. */
export declare function costUsd(price: ModelPrice, t: {
    input: number;
    cacheWrite: number;
    cacheRead: number;
    output: number;
}, promptSize?: number): number;
/** Model presets usable from the approval "modify" menu. */
export declare const PRESETS: Record<string, Record<Target, {
    heavy: string;
    standard: string;
    light: string;
}>>;
/** Which preset slot each stage uses. */
export declare const STAGE_WEIGHT: Record<string, "heavy" | "standard" | "light">;
