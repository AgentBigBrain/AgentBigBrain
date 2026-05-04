/**
 * @fileoverview Canonical workflow-learning and workflow-receipt persistence contracts extracted from the broader persistence schema surface.
 */

export type WorkflowOutcome = "success" | "failure" | "suppressed";

export type WorkflowPatternStatus = "active" | "superseded";

export type WorkflowExecutionStyle =
  | "respond_only"
  | "single_action"
  | "multi_action"
  | "live_run"
  | "skill_based";

export type WorkflowApprovalPosture =
  | "none"
  | "fast_path_only"
  | "escalation_only"
  | "mixed"
  | "blocked_only";

export type WorkflowCostBand = "none" | "low" | "medium" | "high";

export type WorkflowLatencyBand = "fast" | "moderate" | "slow";

export interface WorkflowObservation {
  workflowKey: string;
  outcome: WorkflowOutcome;
  observedAt: string;
  domainLane: string;
  contextTags: readonly string[];
  supersedesKeys?: readonly string[];
  executionStyle?: WorkflowExecutionStyle;
  actionSequenceShape?: string;
  approvalPosture?: WorkflowApprovalPosture;
  verificationProofPresent?: boolean;
  costBand?: WorkflowCostBand;
  latencyBand?: WorkflowLatencyBand;
  dominantFailureMode?: string | null;
  recoveryPath?: string | null;
  linkedSkillName?: string | null;
  linkedSkillVerificationStatus?: "unverified" | "verified" | "failed" | null;
  evidenceRefs?: readonly string[];
}

export interface WorkflowPattern {
  id: string;
  workflowKey: string;
  status: WorkflowPatternStatus;
  confidence: number;
  firstSeenAt: string;
  lastSeenAt: string;
  supersededAt: string | null;
  domainLane: string;
  successCount: number;
  failureCount: number;
  suppressedCount: number;
  contextTags: readonly string[];
  executionStyle?: WorkflowExecutionStyle;
  actionSequenceShape?: string;
  approvalPosture?: WorkflowApprovalPosture;
  verificationProofPresent?: boolean;
  costBand?: WorkflowCostBand;
  latencyBand?: WorkflowLatencyBand;
  dominantFailureMode?: string | null;
  recoveryPath?: string | null;
  linkedSkillName?: string | null;
  linkedSkillVerificationStatus?: "unverified" | "verified" | "failed" | null;
  evidenceRefs?: readonly string[];
}

export interface WorkflowAdaptationResult {
  patterns: readonly WorkflowPattern[];
  updatedPattern: WorkflowPattern;
  supersededPatternIds: readonly string[];
}

export const WORKFLOW_CONFLICT_CODES_V1 = [
  "SELECTOR_NOT_FOUND",
  "ASSERTION_FAILED",
  "WINDOW_NOT_FOCUSED",
  "NAVIGATION_MISMATCH",
  "CAPTURE_SCHEMA_UNSUPPORTED"
] as const;

export type WorkflowConflictCodeV1 = (typeof WORKFLOW_CONFLICT_CODES_V1)[number];

export const STAGE_6_85_BLOCK_CODES = ["WORKFLOW_DRIFT_DETECTED"] as const;

export type Stage685BlockCode = (typeof STAGE_6_85_BLOCK_CODES)[number];

export type WorkflowOperationV1 = "capture_start" | "capture_stop" | "compile" | "replay_step";

export interface WorkflowCaptureEventV1 {
  eventId: string;
  type: "click" | "type" | "navigate";
  timestampMs: number;
  appWindow: string;
  selector: string;
  value?: string;
}

export interface WorkflowCaptureV1 {
  captureId: string;
  startedAt: string;
  stoppedAt: string;
  events: readonly WorkflowCaptureEventV1[];
}

export interface WorkflowScriptV1 {
  scriptId: string;
  captureId: string;
  steps: readonly {
    stepId: string;
    operation: WorkflowOperationV1;
    selector: string;
    assertion: string;
    retryPolicy: "none" | "bounded";
    idempotencyKey: string;
  }[];
}

export interface WorkflowRunReceiptV1 {
  runId: string;
  scriptId: string;
  operation: WorkflowOperationV1;
  actionFamily: "computer_use";
  actionTypeBridge: "run_skill";
  approved: boolean;
  blockCode: Stage685BlockCode | null;
  conflictCode: WorkflowConflictCodeV1 | null;
}
