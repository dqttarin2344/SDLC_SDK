import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LedgerEntry, StageId, Target } from "./types.js";

/**
 * Append-only record of estimated vs actual cost per stage.
 * Later estimates use the median actual/estimated ratio per stage to calibrate themselves.
 */
export class Ledger {
  readonly path: string;

  constructor(repoRoot: string, artifactsDir = ".sdlc/runs") {
    this.path = join(repoRoot, dirname(artifactsDir), "ledger.jsonl");
  }

  record(entry: LedgerEntry): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(entry) + "\n");
  }

  entries(): LedgerEntry[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as LedgerEntry];
        } catch {
          return [];
        }
      });
  }

  /** Median actual/estimated ratio per stage over the last `window` samples (needs >= minSamples). */
  calibration(target: Target, window = 10, minSamples = 3): Partial<Record<StageId, number>> {
    const byStage = new Map<StageId, number[]>();
    for (const e of this.entries()) {
      if (e.target !== target || !(e.estimatedUsd > 0) || !(e.actualUsd >= 0)) continue;
      const arr = byStage.get(e.stage) ?? [];
      arr.push(e.actualUsd / e.estimatedUsd);
      byStage.set(e.stage, arr);
    }
    const out: Partial<Record<StageId, number>> = {};
    for (const [stage, ratios] of byStage) {
      const recent = ratios.slice(-window);
      if (recent.length < minSamples) continue;
      const sorted = [...recent].sort((a, b) => a - b);
      const mid = sorted.length >> 1;
      const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
      out[stage] = Math.min(3, Math.max(0.3, +median.toFixed(2)));
    }
    return out;
  }
}
