/**
 * @fileoverview Shared domain contracts for tasks, planning, governance decisions, execution results, and runtime state.
 */

import type {
  BridgeConflictCodeV1,
  MemoryConflictCodeV1
} from "./runtimeTypes/interfaceTypes";

export type { ActionType, ExecutionMode } from "./runtimeTypes/actionTypes";
export {
  MAX_CONVERSATION_DOMAIN_LANE_HISTORY,
  MAX_CONVERSATION_DOMAIN_ROUTING_SIGNALS,
  applyDomainSignalWindow,
  createEmptyConversationDomainContext,
  detectCrossDomainDip,
  isConversationDomainContextMeaningful,
  normalizeConversationDomainContext,
  resolveSessionDomain,
  selectConversationDomainContext
} from "./sessionContext";
export {
  ALL_GOVERNOR_IDS,
  FULL_COUNCIL_GOVERNOR_IDS,
  isGovernorId,
  type GovernorId
} from "./runtimeTypes/governanceTypes";
export type {
  ConversationDomainContext,
  ConversationDomainContinuitySignals,
  ConversationDomainLane,
  ConversationDomainLaneSignal,
  ConversationDomainLaneSignalSource,
  ConversationDomainRoutingMode,
  ConversationDomainRoutingSignal,
  ConversationDomainSignalWindowUpdate
} from "./sessionContext";
export type {
  CheckProcessActionParams,
  CloseBrowserActionParams,
  CreateSkillActionParams,
  DeleteFileActionParams,
  EnvModeV1,
  GovernanceProposal,
  InspectPathHoldersActionParams,
  InspectWorkspaceResourcesActionParams,
  ListDirectoryActionParams,
  MemoryMutationActionParams,
  MemoryMutationOperationV1,
  MemoryMutationStoreV1,
  NetworkWriteActionParams,
  OpenBrowserActionParams,
  Plan,
  PlannedAction,
  PlannedActionByType,
  PlannedActionParamsByType,
  PlannerLearningHintSummaryV1,
  ProbeHttpActionParams,
  ProbePortActionParams,
  PulseEmitActionParams,
  ReadFileActionParams,
  RespondActionParams,
  RunSkillActionParams,
  SelfModifyActionParams,
  ShellCommandActionParams,
  ShellCwdPolicyV1,
  ShellEnvPolicyV1,
  ShellInvocationModeV1,
  ShellKindV1,
  ShellRuntimeProfileV1,
  ShellSpawnSpecV1,
  StartProcessActionParams,
  StopProcessActionParams,
  TaskRequest,
  VerifyBrowserActionParams,
  WriteFileActionParams
} from "./runtimeTypes/taskPlanningTypes";
export {
  CONSTRAINT_VIOLATION_CODES,
  isConstraintViolationCode,
  type ActionBlockReason,
  type ActionRunResult,
  type ConstraintViolation,
  type ConstraintViolationCode,
  type ExecutorExecutionOutcome,
  type ExecutorExecutionStatus,
  type GovernanceBlockCategory,
  type GovernanceMemoryEvent,
  type GovernanceMemoryReadView,
  type GovernanceOutcome,
  type GovernorRejectCategory,
  type GovernorVote,
  type ManagedProcessLifecycleCode,
  type MasterDecision,
  type RuntimeTraceDetailValue,
  type RuntimeTraceEvent,
  type RuntimeTraceEventType
} from "./runtimeTypes/governanceOutcomeTypes";
export type {
  FailureTaxonomyCategory,
  FailureTaxonomyCodeV1,
  FailureTaxonomyResultV1,
  FailureTaxonomySignal,
  FirstPrinciplesPacketV1,
  FirstPrinciplesRubric,
  FirstPrinciplesValidationResult,
  SubagentDelegationDecision,
  SubagentDelegationLimits,
  SubagentDelegationSignal
} from "./runtimeTypes/decisionSupportTypes";
export {
  STAGE_6_86_BLOCK_CODES,
  STAGE_6_86_PRIVACY_BLOCK_REASONS,
  STAGE_6_86_MEMORY_CONFLICT_CODES,
  STAGE_6_86_BRIDGE_CONFLICT_CODES,
  STAGE_6_86_PULSE_BLOCK_CODES,
  STAGE_6_86_BRIDGE_BLOCK_CODES,
  STAGE_6_86_PULSE_REASON_CODES,
  STAGE_6_86_PULSE_DECISION_CODES,
  type BridgeBlockCodeV1,
  type BridgeCandidateV1,
  type BridgeConflictCodeV1,
  type BridgeQuestionV1,
  type ConversationStackV1,
  type EntityGraphV1,
  type EntityNodeV1,
  type EntityTypeV1,
  type MemoryConflictCodeV1,
  type MemoryStatusV1,
  type OpenLoopV1,
  type PulseBlockCodeV1,
  type PulseCandidateV1,
  type PulseDecisionCodeV1,
  type PulseDecisionV1,
  type PulseReasonCodeV1,
  type PulseScoreBreakdownV1,
  type RelationEdgeV1,
  type RelationTypeV1,
  type SessionSchemaVersionV1,
  type Stage686BlockCodeV1,
  type Stage686PrivacyBlockReasonV1,
  type ThreadFrameV1,
  type TopicKeyCandidateV1,
  type TopicNodeV1
} from "./runtimeTypes/interfaceTypes";
export {
  CLONE_PACKET_CONTENT_KINDS_V1,
  MISSION_UX_STATES_V1,
  STAGE_6_75_BLOCK_CODES,
  STAGE_6_85_BLOCK_CODES,
  STAGE_6_85_CLONE_BLOCK_CODES,
  WORKFLOW_CONFLICT_CODES_V1,
  type ApprovalGrantV1,
  type ApprovalGranularityV1,
  type ApprovalRequestV1,
  type ClonePacketContentKindV1,
  type CloneQueueRequestV1,
  type ConnectorReceiptV1,
  type ConflictObjectV1,
  type DistilledPacketV1,
  type EvidenceArtifactLink,
  type EvidenceArtifactV1,
  type EvidenceStoreDocumentV1,
  type FindingsPacketV1,
  type MemoryMutationReceiptV1,
  type MissionCheckpointV1,
  type MissionPhaseV1,
  type MissionTimelineV1,
  type MissionUxResultEnvelopeV1,
  type MissionUxStateTransitionV1,
  type MissionUxStateV1,
  type OptionPacketV1,
  type ParallelSpikeBoundsV1,
  type PlaybookRiskProfileV1,
  type PlaybookV1,
  type PlaybookV1Step,
  type SchemaEnvelopeV1,
  type Stage675BlockCode,
  type Stage685BlockCode,
  type Stage685CloneBlockCode,
  type Stage685MissionPhaseV1,
  type VerificationCategoryV1,
  type VerificationGateV1,
  type WorkflowAdaptationResult,
  type WorkflowCaptureEventV1,
  type WorkflowCaptureV1,
  type WorkflowCostBand,
  type WorkflowConflictCodeV1,
  type WorkflowExecutionStyle,
  type WorkflowObservation,
  type WorkflowOperationV1,
  type WorkflowOutcome,
  type WorkflowPattern,
  type WorkflowApprovalPosture,
  type WorkflowLatencyBand,
  type WorkflowPatternStatus,
  type WorkflowRunReceiptV1,
  type WorkflowScriptV1
} from "./runtimeTypes/persistenceTypes";
export type {
  BrainMetrics,
  BrainState,
  ProfileMemoryStatus,
  TaskRunResult
} from "./runtimeTypes/runtimeStateTypes";

export interface Stage686ConflictObjectV1 {
  conflictCode: MemoryConflictCodeV1 | BridgeConflictCodeV1;
  detail: string;
  observedAt: string;
  evidenceRefs: readonly string[];
}
