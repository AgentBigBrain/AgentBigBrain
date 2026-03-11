/**
 * @fileoverview Canonical helper contracts for workflow-learning extraction, ranking, planner bias, and inspection.
 */

import type {
  WorkflowApprovalPosture,
  WorkflowCostBand,
  WorkflowExecutionStyle,
  WorkflowLatencyBand,
  WorkflowPattern
} from "../types";

export interface WorkflowObservationSummary {
  executionStyle: WorkflowExecutionStyle;
  actionSequenceShape: string;
  approvalPosture: WorkflowApprovalPosture;
  verificationProofPresent: boolean;
  costBand: WorkflowCostBand;
  latencyBand: WorkflowLatencyBand;
  dominantFailureMode: string | null;
  recoveryPath: string | null;
  linkedSkillName: string | null;
  linkedSkillVerificationStatus: "unverified" | "verified" | "failed" | null;
}

export interface RankedWorkflowPattern {
  pattern: WorkflowPattern;
  score: number;
}

export interface WorkflowPlannerBiasSummary {
  preferredPatterns: readonly WorkflowPattern[];
  discouragedPatterns: readonly WorkflowPattern[];
}

export interface WorkflowInspectionEntry {
  workflowKey: string;
  confidence: number;
  status: WorkflowPattern["status"];
  outcomeCounts: {
    success: number;
    failure: number;
    suppressed: number;
  };
  executionStyle: WorkflowExecutionStyle | null;
  linkedSkillName: string | null;
  linkedSkillVerificationStatus: "unverified" | "verified" | "failed" | null;
  updatedAt: string;
}
