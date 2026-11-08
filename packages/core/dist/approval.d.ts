import type { GateIO } from "./io.js";
import type { Approval, RunPlan } from "./types.js";
export type GateDecision = {
    decision: "approved";
    plan: RunPlan;
    approval: Approval;
} | {
    decision: "saved";
    plan: RunPlan;
} | {
    decision: "cancelled";
    plan: RunPlan;
};
/**
 * Pre-run cost gate. Shows the estimate and loops until the human approves,
 * saves the plan for later, or cancels. "Modify" edits the plan and re-estimates.
 * Nothing runs unless this returns `approved`.
 */
export declare function approvalGate(initial: RunPlan, io: GateIO): Promise<GateDecision>;
