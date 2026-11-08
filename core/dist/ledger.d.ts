import type { LedgerEntry, StageId, Target } from "./types.js";
/**
 * Append-only record of estimated vs actual cost per stage.
 * Later estimates use the median actual/estimated ratio per stage to calibrate themselves.
 */
export declare class Ledger {
    readonly path: string;
    constructor(repoRoot: string, artifactsDir?: string);
    record(entry: LedgerEntry): void;
    entries(): LedgerEntry[];
    /** Median actual/estimated ratio per stage over the last `window` samples (needs >= minSamples). */
    calibration(target: Target, window?: number, minSamples?: number): Partial<Record<StageId, number>>;
}
