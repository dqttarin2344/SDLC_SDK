import type { RunPlan, StageActual } from "./types.js";
export declare const usd: (n: number) => string;
/** Human-readable estimate for the terminal. */
export declare function renderEstimate(plan: RunPlan): string;
/** Markdown version, saved next to the run and shown inside IDE chats. */
export declare function renderEstimateMarkdown(plan: RunPlan): string;
export declare function renderActuals(plan: RunPlan, actuals: StageActual[]): string;
