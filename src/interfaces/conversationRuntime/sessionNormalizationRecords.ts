/**
 * @fileoverview Stable record-level normalization helpers for persisted interface session state.
 */

import type {
  ActiveClarificationOption,
  ActiveClarificationState,
  ConversationAckLifecycleState,
  ConversationAssistantTurnKind,
  ConversationFinalDeliveryOutcome,
  ConversationJob,
  ConversationJobStatus,
  ConversationModeContinuityState,
  ConversationProgressState,
  ConversationRecoveryTrace,
  ConversationReturnHandoffRecord,
  ConversationRecentActionRecord,
  ConversationTurn,
  ConversationTurnMetadata,
  ConversationTurnMetadataSource
} from "./sessionStateContracts";
import type { RecoveryFailureClass } from "../../core/autonomy/contracts";
import { normalizeConversationTurnSourceRecallMetadata } from "./sessionNormalizationSourceRecallRecords";
export {
  normalizeActiveWorkspaceRecord,
  normalizeBrowserSessionRecord,
  normalizeClassifierEventRecord,
  normalizePathDestinationRecord
} from "./sessionNormalizationOwnershipRecords";

/**
 * Normalizes persisted handoff-domain snapshot lanes into the supported shared-lane subset.
 *
 * @param value - Persisted candidate lane label.
 * @returns Normalized snapshot lane or `null` when absent/unsupported.
 */
function normalizeDomainSnapshotLane(value: unknown): ConversationReturnHandoffRecord["domainSnapshotLane"] {
  return value === "profile" ||
    value === "relationship" ||
    value === "workflow" ||
    value === "system_policy"
    ? value
    : null;
}

/**
 * Normalizes one persisted recovery failure class into the supported autonomy subset.
 *
 * @param value - Persisted candidate recovery class.
 * @returns Canonical recovery failure class or `null` when unsupported.
 */
function normalizeRecoveryFailureClass(value: unknown): RecoveryFailureClass | null {
  return value === "EXECUTABLE_NOT_FOUND" ||
    value === "COMMAND_TOO_LONG" ||
    value === "DEPENDENCY_MISSING" ||
    value === "VERSION_INCOMPATIBLE" ||
    value === "PROCESS_PORT_IN_USE" ||
    value === "PROCESS_NOT_READY" ||
    value === "TARGET_NOT_RUNNING" ||
    value === "AUTH_NOT_INITIALIZED" ||
    value === "REMOTE_RATE_LIMITED" ||
    value === "REMOTE_UNAVAILABLE" ||
    value === "BROWSER_START_BLOCKED" ||
    value === "WORKSPACE_HOLDER_CONFLICT" ||
    value === "TRANSCRIPTION_BACKEND_UNAVAILABLE" ||
    value === "UNKNOWN_EXECUTION_FAILURE"
    ? value
    : null;
}

/**
 * Normalizes one persisted conversation recovery trace into the stable runtime shape.
 *
 * @param candidate - Persisted recovery trace candidate.
 * @returns Canonical recovery trace or `null` when invalid.
 */
function normalizeRecoveryTrace(
  candidate: Partial<ConversationRecoveryTrace> | null | undefined
): ConversationRecoveryTrace | null {
  if (
    !candidate ||
    (candidate.kind !== "structured_executor_recovery" &&
      candidate.kind !== "workspace_auto_recovery" &&
      candidate.kind !== "stale_session_recovery") ||
    (candidate.status !== "attempting" &&
      candidate.status !== "recovered" &&
      candidate.status !== "failed") ||
    typeof candidate.summary !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    kind: candidate.kind,
    status: candidate.status,
    summary: candidate.summary,
    updatedAt: candidate.updatedAt,
    recoveryClass: normalizeRecoveryFailureClass(candidate.recoveryClass),
    fingerprint:
      typeof candidate.fingerprint === "string" && candidate.fingerprint.trim().length > 0
        ? candidate.fingerprint
        : null
  };
}

/**
 * Normalizes one clarification option into the stable runtime shape.
 */
export function normalizeClarificationOption(
  option: Partial<ActiveClarificationOption>
): ActiveClarificationOption | null {
  if (
    (option.id !== "plan" &&
      option.id !== "build" &&
      option.id !== "static_html" &&
      option.id !== "nextjs" &&
      option.id !== "react" &&
      option.id !== "explain" &&
      option.id !== "fix_now" &&
      option.id !== "skills" &&
      option.id !== "continue_recovery" &&
      option.id !== "retry_with_shutdown" &&
      option.id !== "cancel") ||
    typeof option.label !== "string" ||
    !option.label.trim()
  ) {
    return null;
  }

  return {
    id: option.id,
    label: option.label.trim()
  };
}

/**
 * Normalizes one persisted clarification state into the stable runtime shape.
 */
export function normalizeActiveClarification(
  candidate: Partial<ActiveClarificationState> | null | undefined
): ActiveClarificationState | null {
  if (
    !candidate ||
    typeof candidate.id !== "string" ||
    (
      candidate.kind !== "execution_mode" &&
      candidate.kind !== "build_format" &&
      candidate.kind !== "task_recovery"
    ) ||
    typeof candidate.sourceInput !== "string" ||
    typeof candidate.question !== "string" ||
    typeof candidate.requestedAt !== "string" ||
    typeof candidate.matchedRuleId !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    kind: candidate.kind,
    sourceInput: candidate.sourceInput,
    question: candidate.question,
    requestedAt: candidate.requestedAt,
    matchedRuleId: candidate.matchedRuleId,
    renderingIntent:
      candidate.renderingIntent === "build_format" ||
      candidate.renderingIntent === "plan_or_build" ||
      candidate.renderingIntent === "fix_or_explain" ||
      candidate.renderingIntent === "task_recovery"
        ? candidate.renderingIntent
        : candidate.kind === "build_format"
          ? "build_format"
          : candidate.kind === "task_recovery"
            ? "task_recovery"
            : "plan_or_build",
    recoveryInstruction:
      typeof candidate.recoveryInstruction === "string"
        ? candidate.recoveryInstruction
        : null,
    options: Array.isArray(candidate.options)
      ? candidate.options
          .map((option) => normalizeClarificationOption(option as Partial<ActiveClarificationOption>))
          .filter((option): option is ActiveClarificationOption => option !== null)
      : []
  };
}

/**
 * Normalizes one persisted conversation job into the stable runtime shape.
 */
export function normalizeConversationJob(job: Partial<ConversationJob>): ConversationJob | null {
  if (typeof job.id !== "string" || typeof job.input !== "string" || typeof job.createdAt !== "string") {
    return null;
  }

  const rawAckLifecycleState = job.ackLifecycleState;
  const ackLifecycleState: ConversationAckLifecycleState =
    rawAckLifecycleState === "NOT_SENT" ||
    rawAckLifecycleState === "SENT" ||
    rawAckLifecycleState === "REPLACED" ||
    rawAckLifecycleState === "FINAL_SENT_NO_EDIT" ||
    rawAckLifecycleState === "CANCELLED"
      ? rawAckLifecycleState
      : "NOT_SENT";
  const rawFinalDeliveryOutcome = job.finalDeliveryOutcome;
  const finalDeliveryOutcome: ConversationFinalDeliveryOutcome =
    rawFinalDeliveryOutcome === "not_attempted" ||
    rawFinalDeliveryOutcome === "sent" ||
    rawFinalDeliveryOutcome === "rate_limited" ||
    rawFinalDeliveryOutcome === "failed"
      ? rawFinalDeliveryOutcome
      : "not_attempted";
  const ackTimerGeneration =
    typeof job.ackTimerGeneration === "number" &&
    Number.isFinite(job.ackTimerGeneration) &&
    job.ackTimerGeneration >= 0
      ? Math.floor(job.ackTimerGeneration)
      : 0;
  const ackEditAttemptCount =
    typeof job.ackEditAttemptCount === "number" &&
    Number.isFinite(job.ackEditAttemptCount) &&
    job.ackEditAttemptCount >= 0
      ? Math.floor(job.ackEditAttemptCount)
      : 0;
  const finalDeliveryAttemptCount =
    typeof job.finalDeliveryAttemptCount === "number" &&
    Number.isFinite(job.finalDeliveryAttemptCount) &&
    job.finalDeliveryAttemptCount >= 0
      ? Math.floor(job.finalDeliveryAttemptCount)
      : 0;

  return {
    id: job.id,
    input: job.input,
    executionInput: typeof job.executionInput === "string" ? job.executionInput : undefined,
    createdAt: job.createdAt,
    startedAt: typeof job.startedAt === "string" ? job.startedAt : null,
    completedAt: typeof job.completedAt === "string" ? job.completedAt : null,
    status: typeof job.status === "string" ? (job.status as ConversationJobStatus) : "queued",
    resultSummary: typeof job.resultSummary === "string" ? job.resultSummary : null,
    errorMessage: typeof job.errorMessage === "string" ? job.errorMessage : null,
    recoveryTrace: normalizeRecoveryTrace(job.recoveryTrace),
    isSystemJob: job.isSystemJob === true ? true : undefined,
    ackTimerGeneration,
    ackEligibleAt: typeof job.ackEligibleAt === "string" ? job.ackEligibleAt : null,
    ackLifecycleState,
    ackMessageId: typeof job.ackMessageId === "string" ? job.ackMessageId : null,
    ackSentAt: typeof job.ackSentAt === "string" ? job.ackSentAt : null,
    ackEditAttemptCount,
    ackLastErrorCode: typeof job.ackLastErrorCode === "string" ? job.ackLastErrorCode : null,
    finalDeliveryOutcome,
    finalDeliveryAttemptCount,
    finalDeliveryLastErrorCode:
      typeof job.finalDeliveryLastErrorCode === "string" ? job.finalDeliveryLastErrorCode : null,
    finalDeliveryLastAttemptAt:
      typeof job.finalDeliveryLastAttemptAt === "string" ? job.finalDeliveryLastAttemptAt : null,
    pauseRequestedAt: typeof job.pauseRequestedAt === "string" ? job.pauseRequestedAt : null
  };
}

/**
 * Normalizes persisted assistant-turn kind metadata.
 */
function normalizeAssistantTurnKind(value: unknown): ConversationAssistantTurnKind | null {
  return value === "clarification" ||
    value === "informational_answer" ||
    value === "workflow_progress" ||
    value === "other"
    ? value
    : null;
}

/**
 * Normalizes persisted turn-metadata source labels.
 */
function normalizeConversationTurnMetadataSource(
  value: unknown
): ConversationTurnMetadataSource | null {
  return value === "runtime_metadata" || value === "legacy_text_inference"
    ? value
    : null;
}

/**
 * Normalizes optional turn metadata without allowing malformed legacy payloads to poison turns.
 */
function normalizeConversationTurnMetadata(
  turn: Partial<ConversationTurn>
): ConversationTurnMetadata | undefined {
  const metadata = turn.metadata;
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const assistantTurnKind = normalizeAssistantTurnKind(metadata.assistantTurnKind);
  const assistantTurnKindSource = normalizeConversationTurnMetadataSource(
    metadata.assistantTurnKindSource
  );
  const sourceRecall = normalizeConversationTurnSourceRecallMetadata(metadata.sourceRecall);
  if (!sourceRecall && (!assistantTurnKind || !assistantTurnKindSource)) {
    return undefined;
  }
  return {
    ...(assistantTurnKind && assistantTurnKindSource
      ? { assistantTurnKind, assistantTurnKindSource }
      : {}),
    ...(sourceRecall ? { sourceRecall } : {})
  };
}

/**
 * Normalizes one persisted conversation turn into the stable runtime shape.
 */
export function normalizeConversationTurn(turn: Partial<ConversationTurn>): ConversationTurn | null {
  if (
    (turn.role !== "user" && turn.role !== "assistant") ||
    typeof turn.text !== "string" ||
    typeof turn.at !== "string"
  ) {
    return null;
  }

  const metadata = normalizeConversationTurnMetadata(turn);
  return {
    role: turn.role,
    text: turn.text,
    at: turn.at,
    ...(metadata ? { metadata } : {})
  };
}

/**
 * Normalizes one persisted mode-continuity state into the stable runtime shape.
 */
export function normalizeModeContinuityState(
  candidate: Partial<ConversationModeContinuityState> | null | undefined
): ConversationModeContinuityState | null {
  if (
    !candidate ||
    (candidate.activeMode !== "chat" &&
      candidate.activeMode !== "explain" &&
      candidate.activeMode !== "plan" &&
      candidate.activeMode !== "build" &&
      candidate.activeMode !== "autonomous" &&
      candidate.activeMode !== "review" &&
      candidate.activeMode !== "discover_available_capabilities" &&
      candidate.activeMode !== "status_or_recall" &&
      candidate.activeMode !== "unclear") ||
    (candidate.source !== "slash_command" &&
      candidate.source !== "voice_command" &&
      candidate.source !== "natural_intent" &&
      candidate.source !== "clarification_answer") ||
    (candidate.confidence !== "HIGH" &&
      candidate.confidence !== "MED" &&
      candidate.confidence !== "LOW") ||
    typeof candidate.lastAffirmedAt !== "string" ||
    typeof candidate.lastUserInput !== "string"
  ) {
    return null;
  }

  return {
    activeMode: candidate.activeMode,
    source: candidate.source,
    confidence: candidate.confidence,
    lastAffirmedAt: candidate.lastAffirmedAt,
    lastUserInput: candidate.lastUserInput,
    lastClarificationId:
      typeof candidate.lastClarificationId === "string" ? candidate.lastClarificationId : null
  };
}

/**
 * Normalizes one persisted progress-state snapshot into the stable runtime shape.
 */
export function normalizeProgressStateRecord(
  candidate: Partial<ConversationProgressState> | null | undefined
): ConversationProgressState | null {
  if (
    !candidate ||
    (candidate.status !== "idle" &&
      candidate.status !== "starting" &&
      candidate.status !== "working" &&
      candidate.status !== "retrying" &&
      candidate.status !== "verifying" &&
      candidate.status !== "waiting_for_user" &&
      candidate.status !== "completed" &&
      candidate.status !== "stopped") ||
    typeof candidate.message !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    status: candidate.status,
    message: candidate.message,
    jobId: typeof candidate.jobId === "string" ? candidate.jobId : null,
    updatedAt: candidate.updatedAt,
    recoveryTrace: normalizeRecoveryTrace(candidate.recoveryTrace)
  };
}

/**
 * Normalizes one persisted return-handoff record into the stable runtime shape.
 */
export function normalizeReturnHandoffRecord(
  candidate: Partial<ConversationReturnHandoffRecord> | null | undefined
): ConversationReturnHandoffRecord | null {
  if (
    !candidate ||
    typeof candidate.id !== "string" ||
    (candidate.status !== "completed" &&
      candidate.status !== "stopped" &&
      candidate.status !== "waiting_for_user") ||
    typeof candidate.goal !== "string" ||
    typeof candidate.summary !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    status: candidate.status,
    goal: candidate.goal,
    summary: candidate.summary,
    nextSuggestedStep:
      typeof candidate.nextSuggestedStep === "string" ? candidate.nextSuggestedStep : null,
    workspaceRootPath:
      typeof candidate.workspaceRootPath === "string" ? candidate.workspaceRootPath : null,
    primaryArtifactPath:
      typeof candidate.primaryArtifactPath === "string" ? candidate.primaryArtifactPath : null,
    previewUrl: typeof candidate.previewUrl === "string" ? candidate.previewUrl : null,
    changedPaths: Array.isArray(candidate.changedPaths)
      ? candidate.changedPaths.filter((value): value is string => typeof value === "string")
      : [],
    sourceJobId: typeof candidate.sourceJobId === "string" ? candidate.sourceJobId : null,
    domainSnapshotLane: normalizeDomainSnapshotLane(candidate.domainSnapshotLane),
    domainSnapshotRecordedAt:
      typeof candidate.domainSnapshotRecordedAt === "string"
        ? candidate.domainSnapshotRecordedAt
        : null,
    updatedAt: candidate.updatedAt
  };
}

/**
 * Normalizes one persisted recent-action record into the stable runtime shape.
 */
export function normalizeRecentActionRecord(
  candidate: Partial<ConversationRecentActionRecord>
): ConversationRecentActionRecord | null {
  if (
    typeof candidate.id !== "string" ||
    (candidate.kind !== "file" &&
      candidate.kind !== "folder" &&
      candidate.kind !== "browser_session" &&
      candidate.kind !== "process" &&
      candidate.kind !== "url" &&
      candidate.kind !== "report" &&
      candidate.kind !== "task_summary") ||
    typeof candidate.label !== "string" ||
    (candidate.status !== "created" &&
      candidate.status !== "updated" &&
      candidate.status !== "open" &&
      candidate.status !== "closed" &&
      candidate.status !== "running" &&
      candidate.status !== "completed" &&
      candidate.status !== "failed") ||
    typeof candidate.at !== "string" ||
    typeof candidate.summary !== "string"
  ) {
    return null;
  }

  return {
    id: candidate.id,
    kind: candidate.kind,
    label: candidate.label,
    location: typeof candidate.location === "string" ? candidate.location : null,
    status: candidate.status,
    sourceJobId: typeof candidate.sourceJobId === "string" ? candidate.sourceJobId : null,
    at: candidate.at,
    summary: candidate.summary
  };
}
