/**
 * @fileoverview Shared domain contracts for tasks, planning, governance decisions, execution results, and runtime state.
 */

export type ActionType =
  | "respond"
  | "read_file"
  | "write_file"
  | "delete_file"
  | "list_directory"
  | "create_skill"
  | "run_skill"
  | "network_write"
  | "self_modify"
  | "shell_command"
  | "memory_mutation"
  | "pulse_emit";

export type ExecutionMode = "fast_path" | "escalation_path";

export type GovernorId =
  | "ethics"
  | "logic"
  | "resource"
  | "security"
  | "continuity"
  | "utility"
  | "compliance"
  | "codeReview";

export const ALL_GOVERNOR_IDS: readonly GovernorId[] = [
  "ethics",
  "logic",
  "resource",
  "security",
  "continuity",
  "utility",
  "compliance",
  "codeReview"
] as const;

export const FULL_COUNCIL_GOVERNOR_IDS: GovernorId[] = [
  "ethics",
  "logic",
  "resource",
  "security",
  "continuity",
  "utility",
  "compliance"
];

/**
 * Evaluates governor id and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the governor id policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is GovernorId` result.
 */
export function isGovernorId(value: unknown): value is GovernorId {
  return typeof value === "string" && ALL_GOVERNOR_IDS.includes(value as GovernorId);
}

export interface TaskRequest {
  id: string;
  agentId?: string;
  goal: string;
  userInput: string;
  createdAt: string;
}

export interface RespondActionParams extends Record<string, unknown> {
  message?: string;
  text?: string;
  actorIdentity?: string;
  speakerRole?: string;
  impersonateHuman?: boolean;
  sharePersonalData?: boolean;
  explicitHumanApproval?: boolean;
  approvalId?: string;
  dataClassification?: string;
  recipient?: string;
  recipientId?: string;
  recipientName?: string;
  audience?: string;
  destination?: string;
  destinationAgentId?: string;
  targetUserId?: string;
  targetConversationId?: string;
  channel?: string;
  conversationId?: string;
}

export interface ReadFileActionParams extends Record<string, unknown> {
  path?: string;
}

export interface WriteFileActionParams extends Record<string, unknown> {
  path?: string;
  content?: string;
}

export interface DeleteFileActionParams extends Record<string, unknown> {
  path?: string;
}

export interface ListDirectoryActionParams extends Record<string, unknown> {
  path?: string;
}

export interface CreateSkillActionParams extends Record<string, unknown> {
  name?: string;
  code?: string;
}

export interface RunSkillActionParams extends Record<string, unknown> {
  name?: string;
  input?: string;
  text?: string;
  exportName?: string;
}

export interface NetworkWriteActionParams extends Record<string, unknown> {
  endpoint?: string;
  url?: string;
  payload?: unknown;
  method?: string;
  connector?: "gmail" | "calendar";
  operation?: "read" | "watch" | "draft" | "propose" | "write" | "update" | "delete";
  approvalDiff?: string;
  approvalExpiresAt?: string;
  approvalMaxUses?: number;
  approvalUses?: number;
  approvalActionIds?: readonly string[];
  idempotencyKey?: string;
  idempotencyKeys?: readonly string[];
  riskClass?: "tier_2" | "tier_3";
  approvedBy?: string;
  lastReadAtIso?: string;
  observedAtWatermark?: string;
  freshnessWindowMs?: number;
  unresolvedConflict?: ConflictObjectV1;
  requiresConsistencyPreflight?: boolean;
  externalIds?: readonly string[];
  sharePersonalData?: boolean;
  explicitHumanApproval?: boolean;
  approvalId?: string;
  dataClassification?: string;
  recipient?: string;
  recipientId?: string;
  recipientName?: string;
  audience?: string;
  destination?: string;
  destinationAgentId?: string;
  targetUserId?: string;
  targetConversationId?: string;
  channel?: string;
  conversationId?: string;
}

export interface SelfModifyActionParams extends Record<string, unknown> {
  target?: string;
  touchesImmutable?: boolean;
}

export type ShellKindV1 = "powershell" | "pwsh" | "cmd" | "bash" | "wsl_bash";

export type ShellInvocationModeV1 = "inline_command";

export type EnvModeV1 = "allowlist" | "passthrough";

export interface ShellEnvPolicyV1 {
  mode: EnvModeV1;
  allowlist?: readonly string[];
  denylist?: readonly string[];
}

export interface ShellCwdPolicyV1 {
  allowRelative: boolean;
  normalize: "posix" | "native";
  denyOutsideSandbox: boolean;
}

export interface ShellRuntimeProfileV1 {
  profileVersion: "v1";
  platform: "win32" | "darwin" | "linux";
  shellKind: ShellKindV1;
  executable: string;
  invocationMode: ShellInvocationModeV1;
  wrapperArgs: readonly string[];
  encoding: "utf8";
  commandMaxChars: number;
  timeoutMsDefault: number;
  envPolicy: ShellEnvPolicyV1;
  cwdPolicy: ShellCwdPolicyV1;
  wslPolicy?: {
    enabled: boolean;
    windowsOnly: true;
    distro?: string;
  };
}

export interface ShellSpawnSpecV1 {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  envMode: EnvModeV1;
  envKeyNames: readonly string[];
}

export interface ShellCommandActionParams extends Record<string, unknown> {
  command?: string;
  path?: string;
  target?: string;
  file?: string;
  directory?: string;
  cwd?: string;
  workdir?: string;
  timeoutMs?: number;
  requestedShellKind?: ShellKindV1;
  output?: string;
  input?: string;
}

export type MemoryMutationStoreV1 = "entity_graph" | "conversation_stack" | "pulse_state";

export type MemoryMutationOperationV1 = "upsert" | "merge" | "supersede" | "resolve" | "evict";

export interface MemoryMutationActionParams extends Record<string, unknown> {
  store?: MemoryMutationStoreV1;
  operation?: MemoryMutationOperationV1;
  mutationPath?: readonly string[];
  payload?: Record<string, unknown>;
  evidenceRefs?: readonly string[];
}

export interface PulseEmitActionParams extends Record<string, unknown> {
  kind?: "bridge_question" | "open_loop_resume" | "topic_resume" | "stale_fact_revalidation";
  reasonCode?: string;
  threadKey?: string;
  entityRefs?: readonly string[];
  evidenceRefs?: readonly string[];
}

export type PlannedActionParamsByType = {
  respond: RespondActionParams;
  read_file: ReadFileActionParams;
  write_file: WriteFileActionParams;
  delete_file: DeleteFileActionParams;
  list_directory: ListDirectoryActionParams;
  create_skill: CreateSkillActionParams;
  run_skill: RunSkillActionParams;
  network_write: NetworkWriteActionParams;
  self_modify: SelfModifyActionParams;
  shell_command: ShellCommandActionParams;
  memory_mutation: MemoryMutationActionParams;
  pulse_emit: PulseEmitActionParams;
};

export type PlannedActionByType<T extends ActionType> = {
  id: string;
  type: T;
  description: string;
  params: PlannedActionParamsByType[T];
  estimatedCostUsd: number;
};

export type PlannedAction = {
  [K in ActionType]: PlannedActionByType<K>;
}[ActionType];

export interface PlannerLearningHintSummaryV1 {
  workflowHintCount: number;
  judgmentHintCount: number;
}

export interface Plan {
  taskId: string;
  plannerNotes: string;
  actions: PlannedAction[];
  firstPrinciples?: FirstPrinciplesPacketV1;
  learningHints?: PlannerLearningHintSummaryV1;
}

export interface GovernanceProposal {
  id: string;
  taskId: string;
  requestedBy: string;
  rationale: string;
  action: PlannedAction;
  touchesImmutable: boolean;
}

export const CONSTRAINT_VIOLATION_CODES = [
  "COST_LIMIT_EXCEEDED",
  "CUMULATIVE_COST_LIMIT_EXCEEDED",
  "IMMUTABLE_VIOLATION",
  "DELETE_MISSING_PATH",
  "DELETE_PROTECTED_PATH",
  "DELETE_OUTSIDE_SANDBOX",
  "READ_MISSING_PATH",
  "READ_PROTECTED_PATH",
  "WRITE_MISSING_PATH",
  "WRITE_PROTECTED_PATH",
  "LIST_MISSING_PATH",
  "LIST_PROTECTED_PATH",
  "LIST_OUTSIDE_SANDBOX",
  "CREATE_SKILL_DISABLED",
  "CREATE_SKILL_MISSING_NAME",
  "CREATE_SKILL_INVALID_NAME",
  "CREATE_SKILL_MISSING_CODE",
  "CREATE_SKILL_CODE_TOO_LARGE",
  "RUN_SKILL_MISSING_NAME",
  "RUN_SKILL_INVALID_NAME",
  "SHELL_DISABLED_BY_POLICY",
  "SHELL_PROFILE_INVALID",
  "SHELL_PROFILE_NOT_SUPPORTED_ON_PLATFORM",
  "SHELL_EXECUTABLE_NOT_FOUND",
  "SHELL_MISSING_COMMAND",
  "SHELL_PROFILE_MISMATCH",
  "SHELL_COMMAND_TOO_LONG",
  "SHELL_TIMEOUT_INVALID",
  "SHELL_CWD_OUTSIDE_SANDBOX",
  "SHELL_DANGEROUS_COMMAND",
  "SHELL_TARGETS_PROTECTED_PATH",
  "NETWORK_WRITE_DISABLED",
  "IDENTITY_IMPERSONATION_DENIED",
  "PERSONAL_DATA_APPROVAL_REQUIRED",
  "GOVERNOR_SET_EMPTY",
  "GOVERNANCE_DECISION_MISSING",
  "GLOBAL_DEADLINE_EXCEEDED",
  "MODEL_SPEND_LIMIT_EXCEEDED",
  "MISSION_STOP_LIMIT_REACHED",
  "IDEMPOTENCY_KEY_REPLAY_DETECTED",
  "ACTION_ID_DUPLICATE_DETECTED",
  "STATE_STALE_REPLAN_REQUIRED",
  "CONFLICT_OBJECT_UNRESOLVED",
  "APPROVAL_DIFF_HASH_MISMATCH",
  "APPROVAL_EXPIRED",
  "APPROVAL_SCOPE_MISMATCH",
  "APPROVAL_MAX_USES_EXCEEDED",
  "CONNECTOR_OPERATION_NOT_SUPPORTED_IN_STAGE_6_75",
  "WORKFLOW_DRIFT_DETECTED",
  "ACTION_EXECUTION_FAILED",
  "CREATE_SKILL_NON_EXECUTABLE",
  "CREATE_SKILL_UNSAFE_CODE",
  "MEMORY_MUTATION_BLOCKED",
  "PULSE_BLOCKED",
  "MEMORY_MUTATION_INVALID_STORE",
  "MEMORY_MUTATION_INVALID_OPERATION",
  "MEMORY_MUTATION_MISSING_PAYLOAD",
  "PULSE_EMIT_INVALID_KIND",
  "VERIFICATION_GATE_FAILED",
  "NETWORK_EGRESS_POLICY_BLOCKED",
  "JIT_APPROVAL_REQUIRED"
] as const;

export type ConstraintViolationCode = (typeof CONSTRAINT_VIOLATION_CODES)[number];

const CONSTRAINT_VIOLATION_CODE_SET = new Set<ConstraintViolationCode>(CONSTRAINT_VIOLATION_CODES);

/**
 * Evaluates constraint violation code and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the constraint violation code policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is ConstraintViolationCode` result.
 */
export function isConstraintViolationCode(value: unknown): value is ConstraintViolationCode {
  return (
    typeof value === "string" &&
    CONSTRAINT_VIOLATION_CODE_SET.has(value as ConstraintViolationCode)
  );
}

export interface ConstraintViolation {
  code: ConstraintViolationCode;
  message: string;
}

export type ActionBlockReason = GovernorId | ConstraintViolationCode;

export type GovernorRejectCategory =
  | "ABUSE_MALWARE_OR_FRAUD"
  | "SECURITY_BOUNDARY"
  | "IDENTITY_INTEGRITY"
  | "COMPLIANCE_POLICY"
  | "RESOURCE_BUDGET"
  | "RATIONALE_QUALITY"
  | "UTILITY_ALIGNMENT"
  | "MODEL_ADVISORY_BLOCK"
  | "GOVERNOR_TIMEOUT_OR_FAILURE"
  | "GOVERNOR_MALFORMED_VOTE"
  | "GOVERNOR_MISSING"
  | "OTHER_POLICY";

export interface GovernorVote {
  governorId: GovernorId;
  approve: boolean;
  reason: string;
  confidence: number;
  rejectCategory?: GovernorRejectCategory;
}

export interface MasterDecision {
  approved: boolean;
  yesVotes: number;
  noVotes: number;
  threshold: number;
  dissent: GovernorVote[];
}

export interface ActionRunResult {
  action: PlannedAction;
  mode: ExecutionMode;
  approved: boolean;
  output?: string;
  executionMetadata?: Record<string, RuntimeTraceDetailValue>;
  blockedBy: ActionBlockReason[];
  violations: ConstraintViolation[];
  votes: GovernorVote[];
  decision?: MasterDecision;
}

export interface TaskRunResult {
  task: TaskRequest;
  plan: Plan;
  actionResults: ActionRunResult[];
  summary: string;
  failureTaxonomy?: FailureTaxonomyResultV1;
  modelUsage?: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedSpendUsd: number;
  };
  startedAt: string;
  completedAt: string;
}

export interface BrainMetrics {
  totalTasks: number;
  totalActions: number;
  approvedActions: number;
  blockedActions: number;
  fastPathActions: number;
  escalationActions: number;
}

export interface BrainState {
  createdAt: string;
  lastRunAt?: string;
  runs: TaskRunResult[];
  metrics: BrainMetrics;
}

export type GovernanceOutcome = "approved" | "blocked";

export type GovernanceBlockCategory = "none" | "constraints" | "governance" | "runtime";

export interface GovernanceMemoryEvent {
  id: string;
  recordedAt: string;
  taskId: string;
  proposalId: string | null;
  actionId: string;
  actionType: ActionType;
  mode: ExecutionMode;
  outcome: GovernanceOutcome;
  blockCategory: GovernanceBlockCategory;
  blockedBy: readonly ActionBlockReason[];
  violationCodes: readonly ConstraintViolationCode[];
  yesVotes: number;
  noVotes: number;
  threshold: number | null;
  dissentGovernorIds: readonly GovernorId[];
}

export interface GovernanceMemoryReadView {
  generatedAt: string;
  totalEvents: number;
  recentEvents: readonly GovernanceMemoryEvent[];
  recentBlockCounts: {
    constraints: number;
    governance: number;
    runtime: number;
  };
  recentGovernorRejectCounts: Partial<Record<GovernorId, number>>;
}

export type RuntimeTraceEventType =
  | "task_started"
  | "planner_completed"
  | "constraint_blocked"
  | "governance_voted"
  | "action_executed"
  | "governance_event_persisted"
  | "task_completed";

export type RuntimeTraceDetailValue = string | number | boolean | null;

export interface RuntimeTraceEvent {
  id: string;
  recordedAt: string;
  eventType: RuntimeTraceEventType;
  taskId: string;
  actionId?: string;
  proposalId?: string;
  governanceEventId?: string;
  mode?: ExecutionMode;
  durationMs?: number;
  details?: Record<string, RuntimeTraceDetailValue>;
}

export type ProfileMemoryStatus = "disabled" | "available" | "degraded_unavailable";

export interface SubagentDelegationSignal {
  capabilityGapScore: number;
  parallelGainScore: number;
  riskReductionScore: number;
  budgetPressureScore: number;
  currentSubagentCount: number;
  requestedDepth: number;
  requiresEscalationApproval: boolean;
}

export interface SubagentDelegationLimits {
  maxSubagentsPerTask: number;
  maxSubagentDepth: number;
  spawnThresholdScore: number;
}

export interface SubagentDelegationDecision {
  shouldSpawn: boolean;
  spawnScore: number;
  blockedBy: readonly string[];
  reasons: readonly string[];
}

export interface FirstPrinciplesRubric {
  facts: readonly string[];
  assumptions: readonly string[];
  constraints: readonly string[];
  unknowns: readonly string[];
  minimalPlan: string;
}

export interface FirstPrinciplesValidationResult {
  valid: boolean;
  violationCodes: readonly string[];
}

export interface FirstPrinciplesPacketV1 {
  required: boolean;
  triggerReasons: readonly string[];
  rubric: FirstPrinciplesRubric | null;
  validation: FirstPrinciplesValidationResult | null;
}

export type FailureTaxonomyCategory =
  | "constraint"
  | "objective"
  | "reasoning"
  | "quality"
  | "human_feedback";

export type FailureTaxonomyCodeV1 =
  | "constraint_blocked"
  | "objective_not_met"
  | "reasoning_planner_failed"
  | "quality_rejected"
  | "human_feedback_required";

export interface FailureTaxonomyResultV1 {
  failureCategory: FailureTaxonomyCategory;
  failureCode: FailureTaxonomyCodeV1;
}

export interface FailureTaxonomySignal {
  blockCategory: GovernanceBlockCategory;
  violationCodes: readonly string[];
  objectivePass: boolean;
  humanFeedbackOnly: boolean;
  summary: string;
}

export type WorkflowOutcome = "success" | "failure" | "suppressed";

export type WorkflowPatternStatus = "active" | "superseded";

export interface WorkflowObservation {
  workflowKey: string;
  outcome: WorkflowOutcome;
  observedAt: string;
  domainLane: string;
  contextTags: readonly string[];
  supersedesKeys?: readonly string[];
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
}

export interface WorkflowAdaptationResult {
  patterns: readonly WorkflowPattern[];
  updatedPattern: WorkflowPattern;
  supersededPatternIds: readonly string[];
}

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

export const STAGE_6_86_BLOCK_CODES = ["MEMORY_MUTATION_BLOCKED", "PULSE_BLOCKED"] as const;

export type Stage686BlockCodeV1 = (typeof STAGE_6_86_BLOCK_CODES)[number];

export const STAGE_6_86_PRIVACY_BLOCK_REASONS = ["PRIVACY_SENSITIVE"] as const;

export type Stage686PrivacyBlockReasonV1 = (typeof STAGE_6_86_PRIVACY_BLOCK_REASONS)[number];

export const STAGE_6_86_MEMORY_CONFLICT_CODES = [
  "ALIAS_COLLISION",
  "MERGE_AMBIGUITY",
  "STALE_THREAD_FRAME",
  "SESSION_SCHEMA_MISMATCH",
  "CANONICALIZATION_CONFLICT"
] as const;

export type MemoryConflictCodeV1 = (typeof STAGE_6_86_MEMORY_CONFLICT_CODES)[number];

export const STAGE_6_86_BRIDGE_CONFLICT_CODES = [
  "INSUFFICIENT_EVIDENCE",
  "COOLDOWN_ACTIVE",
  "DERAILS_ACTIVE_MISSION",
  "PRIVACY_SENSITIVE",
  "CAP_REACHED"
] as const;

export type BridgeConflictCodeV1 = (typeof STAGE_6_86_BRIDGE_CONFLICT_CODES)[number];

export const STAGE_6_86_PULSE_BLOCK_CODES = [
  "PULSE_CAP_REACHED",
  "PULSE_COOLDOWN_ACTIVE",
  "DERAILS_ACTIVE_MISSION",
  "PRIVACY_SENSITIVE",
  "OPEN_LOOP_CAP_REACHED"
] as const;

export type PulseBlockCodeV1 = (typeof STAGE_6_86_PULSE_BLOCK_CODES)[number];

export const STAGE_6_86_BRIDGE_BLOCK_CODES = [
  "BRIDGE_INSUFFICIENT_EVIDENCE",
  "BRIDGE_COOLDOWN_ACTIVE",
  "BRIDGE_PRIVACY_SENSITIVE",
  "BRIDGE_CAP_REACHED",
  "DERAILS_ACTIVE_MISSION"
] as const;

export type BridgeBlockCodeV1 = (typeof STAGE_6_86_BRIDGE_BLOCK_CODES)[number];

export type EntityTypeV1 = "person" | "place" | "org" | "event" | "thing" | "concept";

export type RelationTypeV1 =
  | "co_mentioned"
  | "unknown"
  | "friend"
  | "family"
  | "coworker"
  | "project_related"
  | "other";

export type MemoryStatusV1 = "uncertain" | "confirmed" | "superseded";

export const STAGE_6_86_PULSE_REASON_CODES = [
  "OPEN_LOOP_RESUME",
  "RELATIONSHIP_CLARIFICATION",
  "TOPIC_DRIFT_RESUME",
  "STALE_FACT_REVALIDATION",
  "USER_REQUESTED_FOLLOWUP",
  "SAFETY_HOLD"
] as const;

export type PulseReasonCodeV1 = (typeof STAGE_6_86_PULSE_REASON_CODES)[number];

export const STAGE_6_86_PULSE_DECISION_CODES = ["EMIT", "SUPPRESS", "DEFER"] as const;

export type PulseDecisionCodeV1 = (typeof STAGE_6_86_PULSE_DECISION_CODES)[number];

export interface EntityNodeV1 {
  entityKey: string;
  canonicalName: string;
  entityType: EntityTypeV1;
  disambiguator: string | null;
  aliases: readonly string[];
  firstSeenAt: string;
  lastSeenAt: string;
  salience: number;
  evidenceRefs: readonly string[];
}

export interface RelationEdgeV1 {
  edgeKey: string;
  sourceEntityKey: string;
  targetEntityKey: string;
  relationType: RelationTypeV1;
  status: MemoryStatusV1;
  coMentionCount: number;
  strength: number;
  firstObservedAt: string;
  lastObservedAt: string;
  evidenceRefs: readonly string[];
}

export interface EntityGraphV1 {
  schemaVersion: "v1";
  updatedAt: string;
  entities: readonly EntityNodeV1[];
  edges: readonly RelationEdgeV1[];
}

export interface TopicNodeV1 {
  topicKey: string;
  label: string;
  firstSeenAt: string;
  lastSeenAt: string;
  mentionCount: number;
}

export interface TopicKeyCandidateV1 {
  topicKey: string;
  label: string;
  confidence: number;
  source: "heuristic_tokens" | "heuristic_phrase" | "fallback_model";
  observedAt: string;
}

export interface OpenLoopV1 {
  loopId: string;
  threadKey: string;
  entityRefs: readonly string[];
  createdAt: string;
  lastMentionedAt: string;
  priority: number;
  status: "open" | "resolved" | "superseded";
}

export interface ThreadFrameV1 {
  threadKey: string;
  topicKey: string;
  topicLabel: string;
  state: "active" | "paused" | "resolved";
  resumeHint: string;
  openLoops: readonly OpenLoopV1[];
  lastTouchedAt: string;
}

export interface ConversationStackV1 {
  schemaVersion: "v1";
  updatedAt: string;
  activeThreadKey: string | null;
  threads: readonly ThreadFrameV1[];
  topics: readonly TopicNodeV1[];
}

export type SessionSchemaVersionV1 = "v1" | "v2";

export interface PulseScoreBreakdownV1 {
  recency: number;
  frequency: number;
  unresolvedImportance: number;
  sensitivityPenalty: number;
  cooldownPenalty: number;
}

export interface PulseCandidateV1 {
  candidateId: string;
  reasonCode: PulseReasonCodeV1;
  score: number;
  scoreBreakdown: PulseScoreBreakdownV1;
  lastTouchedAt: string;
  threadKey: string | null;
  entityRefs: readonly string[];
  evidenceRefs: readonly string[];
  stableHash: string;
}

export interface PulseDecisionV1 {
  decisionCode: PulseDecisionCodeV1;
  candidateId: string;
  blockCode: Extract<Stage686BlockCodeV1, "PULSE_BLOCKED"> | null;
  blockDetailReason: PulseBlockCodeV1 | BridgeBlockCodeV1 | null;
  evidenceRefs: readonly string[];
}

export interface BridgeCandidateV1 {
  candidateId: string;
  sourceEntityKey: string;
  targetEntityKey: string;
  coMentionCount: number;
  lastObservedAt: string;
  evidenceRefs: readonly string[];
}

export interface BridgeQuestionV1 {
  questionId: string;
  sourceEntityKey: string;
  targetEntityKey: string;
  prompt: string;
  createdAt: string;
  cooldownUntil: string;
  threadKey: string | null;
  evidenceRefs: readonly string[];
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

export interface Stage686ConflictObjectV1 {
  conflictCode: MemoryConflictCodeV1 | BridgeConflictCodeV1;
  detail: string;
  observedAt: string;
  evidenceRefs: readonly string[];
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
