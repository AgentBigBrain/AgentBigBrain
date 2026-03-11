/**
 * @fileoverview Canonical persistence, evidence, receipt, and workflow schema contracts extracted from the shared runtime type surface.
 */

import type { ActionType } from "./actionTypes";
import type {
  MemoryMutationOperationV1,
  MemoryMutationStoreV1
} from "./taskPlanningTypes";
export {
  STAGE_6_85_BLOCK_CODES,
  WORKFLOW_CONFLICT_CODES_V1,
  type Stage685BlockCode,
  type WorkflowAdaptationResult,
  type WorkflowApprovalPosture,
  type WorkflowCaptureEventV1,
  type WorkflowCaptureV1,
  type WorkflowConflictCodeV1,
  type WorkflowCostBand,
  type WorkflowExecutionStyle,
  type WorkflowLatencyBand,
  type WorkflowObservation,
  type WorkflowOperationV1,
  type WorkflowOutcome,
  type WorkflowPattern,
  type WorkflowPatternStatus,
  type WorkflowRunReceiptV1,
  type WorkflowScriptV1
} from "./workflowPersistenceTypes";

export interface SchemaEnvelopeV1<TPayload = unknown> {
  schemaName: string;
  schemaVersion: "v1";
  createdAt: string;
  hash: string;
  payload: TPayload;
}

export const STAGE_6_75_BLOCK_CODES = [
  "QUARANTINE_NOT_APPLIED",
  "RAW_EXTERNAL_TEXT_TO_PLANNER_DENIED",
  "CONTENT_SIZE_EXCEEDED",
  "CONTENT_TYPE_UNSUPPORTED",
  "REDIRECT_LIMIT_EXCEEDED",
  "PRIVATE_RANGE_TARGET_DENIED",
  "RISK_SIGNAL_ESCALATION_REQUIRED",
  "RISK_SIGNAL_UNACKNOWLEDGED_BLOCKED",
  "MISSION_STOP_LIMIT_REACHED",
  "IDEMPOTENCY_KEY_REPLAY_DETECTED",
  "IDEMPOTENCY_RECEIPT_REATTACHED",
  "ACTION_ID_DUPLICATE_DETECTED",
  "STATE_STALE_REPLAN_REQUIRED",
  "CONFLICT_OBJECT_UNRESOLVED",
  "APPROVAL_DIFF_HASH_MISMATCH",
  "APPROVAL_EXPIRED",
  "APPROVAL_SCOPE_MISMATCH",
  "APPROVAL_MAX_USES_EXCEEDED",
  "LIVE_REVIEW_FAILED_ROLLBACK_APPLIED",
  "ROLLBACK_APPLIED",
  "SECRET_EGRESS_BLOCKED",
  "TOKEN_SERIALIZATION_DENIED",
  "NETWORK_EGRESS_POLICY_BLOCKED",
  "CONNECTOR_OPERATION_NOT_SUPPORTED_IN_STAGE_6_75",
  "EVIDENCE_ORPHANED_ARTIFACT",
  "CANONICALIZATION_RULE_MISSING_OR_CONFLICTING"
] as const;

export type Stage675BlockCode = (typeof STAGE_6_75_BLOCK_CODES)[number];

export interface DistilledPacketV1 {
  packetId: string;
  packetHash: string;
  sourceKind: "web" | "email" | "calendar" | "document" | "other";
  sourceId: string;
  contentType: string;
  observedAt: string;
  distilledAt: string;
  byteLength: number;
  rawContentHash: string;
  summary: string;
  excerpt: string;
  riskSignals: readonly string[];
}

export interface EvidenceArtifactLink {
  receiptHash?: string;
  traceId?: string;
}

export interface EvidenceArtifactV1<TPayload = unknown> {
  artifactId: string;
  artifactHash: string;
  createdAt: string;
  schemaEnvelope: SchemaEnvelopeV1<TPayload>;
  linkedFrom: EvidenceArtifactLink;
}

export interface EvidenceStoreDocumentV1 {
  schemaVersion: "v1";
  artifacts: EvidenceArtifactV1[];
}

export type MissionPhaseV1 =
  | "intake"
  | "retrieve"
  | "synthesize"
  | "build"
  | "verify"
  | "propose_writes"
  | "execute_writes"
  | "monitor";

export interface MissionCheckpointV1 {
  missionId: string;
  missionAttemptId: number;
  phase: MissionPhaseV1;
  actionType: ActionType;
  observedAt: string;
  idempotencyKey: string;
  actionId: string;
}

export interface ApprovalRequestV1 {
  approvalId: string;
  missionId: string;
  actionIds: readonly string[];
  diff: string;
  diffHash: string;
  riskClass: "tier_2" | "tier_3";
  idempotencyKeys: readonly string[];
  expiresAt: string;
  maxUses: number;
}

export interface ApprovalGrantV1 {
  approvalId: string;
  missionId: string;
  actionIds: readonly string[];
  diffHash: string;
  approvedAt: string;
  expiresAt: string;
  approvedBy: string;
  idempotencyKeys: readonly string[];
  maxUses: number;
  uses: number;
  grantHash: string;
}

export interface ConflictObjectV1 {
  conflictCode: Stage675BlockCode;
  detail: string;
  observedAtWatermark: string;
}

export interface ConnectorReceiptV1 {
  connector: "gmail" | "calendar";
  operation: "read" | "watch" | "draft" | "propose" | "write";
  requestFingerprint: string;
  responseFingerprint: string;
  externalIds: readonly string[];
  observedAt: string;
}

export const MISSION_UX_STATES_V1 = [
  "planning",
  "awaiting_approval",
  "executing",
  "blocked",
  "completed"
] as const;

export type MissionUxStateV1 = (typeof MISSION_UX_STATES_V1)[number];

export type ApprovalGranularityV1 = "approve_step" | "approve_all";

export interface MissionUxResultEnvelopeV1 {
  missionId: string;
  state: MissionUxStateV1;
  summary: string;
  evidenceRefs: readonly string[];
  receiptRefs: readonly string[];
  nextStepSuggestion: string | null;
}

export interface MissionUxStateTransitionV1 {
  from: MissionUxStateV1;
  to: MissionUxStateV1;
  reason: string;
  changedAt: string;
}

export type Stage685MissionPhaseV1 = "parallel_spike";

export interface ParallelSpikeBoundsV1 {
  maxClonesPerParallelSpike: number;
  maxCloneDepth: number;
  maxCloneBudgetUsd: number;
  maxPacketsPerClone: number;
}

export const CLONE_PACKET_CONTENT_KINDS_V1 = [
  "pattern",
  "plan_variant",
  "test_idea",
  "selector_strategy",
  "lesson",
  "secret",
  "raw_external_text",
  "uncontrolled_instruction"
] as const;

export type ClonePacketContentKindV1 = (typeof CLONE_PACKET_CONTENT_KINDS_V1)[number];

export interface OptionPacketV1 {
  packetId: string;
  cloneId: string;
  recommendation: string;
  tradeoffs: readonly string[];
  risks: readonly string[];
  evidenceRefs: readonly string[];
  confidence: number;
  contentKind: ClonePacketContentKindV1;
}

export interface FindingsPacketV1 {
  packetId: string;
  cloneId: string;
  recommendation: string;
  tradeoffs: readonly string[];
  risks: readonly string[];
  evidenceRefs: readonly string[];
  confidence: number;
  contentKind: ClonePacketContentKindV1;
}

export const STAGE_6_85_CLONE_BLOCK_CODES = [
  "PARALLEL_SPIKE_BOUNDS_INVALID",
  "CLONE_QUEUE_OBJECT_INVALID",
  "CLONE_PACKET_NON_MERGEABLE",
  "CLONE_DIRECT_SIDE_EFFECT_DENIED"
] as const;

export type Stage685CloneBlockCode = (typeof STAGE_6_85_CLONE_BLOCK_CODES)[number];

export interface CloneQueueRequestV1 {
  missionId: string;
  missionAttemptId: number;
  rootTaskId: string;
  phase: Stage685MissionPhaseV1;
  cloneRole: "creative" | "researcher" | "critic" | "builder";
  requestedCloneCount: number;
  requestedDepth: number;
  requestedBudgetUsd: number;
  packetBudgetPerClone: number;
}

export type PlaybookRiskProfileV1 = "low" | "medium" | "high";

export interface PlaybookV1Step {
  stepId: string;
  actionFamily: string;
  operation: string;
  deterministic: boolean;
}

export interface PlaybookV1 {
  id: string;
  name: string;
  intentTags: readonly string[];
  inputsSchema: string;
  steps: readonly PlaybookV1Step[];
  riskProfile: PlaybookRiskProfileV1;
  defaultStopConditions: readonly string[];
  requiredEvidenceTypes: readonly string[];
}

export type VerificationCategoryV1 = "build" | "research" | "workflow_replay" | "communication";

export interface VerificationGateV1 {
  gateId: string;
  category: VerificationCategoryV1;
  proofRefs: readonly string[];
  waiverApproved: boolean;
  passed: boolean;
  reason: string;
}

export interface MemoryMutationReceiptV1 {
  mutationId: string;
  scopeId: string;
  taskId: string;
  proposalId: string;
  actionId: string;
  missionId?: string;
  missionAttemptId?: string;
  canonicalMutationPayload: Record<string, unknown>;
  store: MemoryMutationStoreV1;
  operation: MemoryMutationOperationV1;
  beforeFingerprint: string;
  afterFingerprint: string;
  evidenceRefs: readonly string[];
  observedAt: string;
  priorReceiptHash: string | null;
}

export interface MissionTimelineV1 {
  missionId: string;
  events: readonly {
    sequence: number;
    phase: string;
    eventType: "plan" | "approval" | "action" | "receipt" | "outcome";
    detail: string;
    observedAt: string;
  }[];
}
