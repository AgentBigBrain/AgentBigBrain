/**
 * @fileoverview Canonical session-state normalization helpers for interface session runtime flows.
 */

import {
  isConversationStackV1,
  migrateSessionConversationStackToV2
} from "../../core/stage6_86ConversationStack";
import type { ConversationStackV1, SessionSchemaVersionV1 } from "../../core/types";
import type { InterfaceSessionFile } from "./contracts";
import type {
  AgentPulseDecisionCode,
  AgentPulseMode,
  AgentPulseRouteStrategy,
  AgentPulseSessionState,
  ConversationAckLifecycleState,
  ConversationClassifierEvent,
  ConversationClassifierIntent,
  ConversationFinalDeliveryOutcome,
  ConversationJob,
  ConversationJobStatus,
  ConversationSession,
  ConversationTurn,
  ConversationVisibility,
  ProposalStatus
} from "../sessionStore";
import { createEmptyInterfaceSessionFile } from "./sessionPersistence";
import {
  createDefaultAgentPulseState,
  normalizeAgentPulseContextualLexicalEvidence,
  normalizeRecentEmissions
} from "./sessionPulseMetadata";

/**
 * Normalizes one persisted conversation session into the stable runtime shape.
 */
export function normalizeSession(raw: Partial<ConversationSession>): ConversationSession | null {
  if (
    typeof raw.conversationId !== "string" ||
    typeof raw.userId !== "string" ||
    typeof raw.username !== "string" ||
    typeof raw.updatedAt !== "string"
  ) {
    return null;
  }

  const activeProposal =
    raw.activeProposal &&
    typeof raw.activeProposal.id === "string" &&
    typeof raw.activeProposal.originalInput === "string" &&
    typeof raw.activeProposal.currentInput === "string" &&
    typeof raw.activeProposal.createdAt === "string" &&
    typeof raw.activeProposal.updatedAt === "string" &&
    typeof raw.activeProposal.status === "string"
      ? {
          id: raw.activeProposal.id,
          originalInput: raw.activeProposal.originalInput,
          currentInput: raw.activeProposal.currentInput,
          createdAt: raw.activeProposal.createdAt,
          updatedAt: raw.activeProposal.updatedAt,
          status: raw.activeProposal.status as ProposalStatus
        }
      : null;

  const normalizeJob = (job: Partial<ConversationJob>): ConversationJob | null => {
    if (
      typeof job.id !== "string" ||
      typeof job.input !== "string" ||
      typeof job.createdAt !== "string"
    ) {
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
        typeof job.finalDeliveryLastAttemptAt === "string" ? job.finalDeliveryLastAttemptAt : null
    };
  };

  const normalizeTurn = (turn: Partial<ConversationTurn>): ConversationTurn | null => {
    if (
      (turn.role !== "user" && turn.role !== "assistant") ||
      typeof turn.text !== "string" ||
      typeof turn.at !== "string"
    ) {
      return null;
    }

    return {
      role: turn.role,
      text: turn.text,
      at: turn.at
    };
  };

  const queuedJobs = Array.isArray(raw.queuedJobs)
    ? raw.queuedJobs
        .map((job) => normalizeJob(job as Partial<ConversationJob>))
        .filter((job): job is ConversationJob => job !== null)
    : [];
  const recentJobs = Array.isArray(raw.recentJobs)
    ? raw.recentJobs
        .map((job) => normalizeJob(job as Partial<ConversationJob>))
        .filter((job): job is ConversationJob => job !== null)
    : [];
  const conversationTurns = Array.isArray(raw.conversationTurns)
    ? raw.conversationTurns
        .map((turn) => normalizeTurn(turn as Partial<ConversationTurn>))
        .filter((turn): turn is ConversationTurn => turn !== null)
    : [];

  let sessionSchemaVersionCandidate: SessionSchemaVersionV1 | null = null;
  if (raw.sessionSchemaVersion === undefined) {
    sessionSchemaVersionCandidate = null;
  } else if (raw.sessionSchemaVersion === "v1" || raw.sessionSchemaVersion === "v2") {
    sessionSchemaVersionCandidate = raw.sessionSchemaVersion;
  } else {
    return null;
  }

  let existingConversationStack: ConversationStackV1 | null = null;
  if (raw.conversationStack === undefined || raw.conversationStack === null) {
    existingConversationStack = null;
  } else if (isConversationStackV1(raw.conversationStack)) {
    existingConversationStack = raw.conversationStack;
  } else {
    return null;
  }

  const stackMigration = migrateSessionConversationStackToV2({
    sessionSchemaVersion: sessionSchemaVersionCandidate,
    updatedAt: raw.updatedAt,
    conversationTurns,
    conversationStack: existingConversationStack
  });

  const normalizeClassifierEvent = (
    event: Partial<ConversationClassifierEvent>
  ): ConversationClassifierEvent | null => {
    if (
      (event.classifier !== "follow_up" &&
        event.classifier !== "proposal_reply" &&
        event.classifier !== "pulse_lexical") ||
      typeof event.input !== "string" ||
      typeof event.at !== "string" ||
      typeof event.isShortFollowUp !== "boolean" ||
      (event.category !== "ACK" &&
        event.category !== "APPROVE" &&
        event.category !== "DENY" &&
        event.category !== "UNCLEAR" &&
        event.category !== "COMMAND" &&
        event.category !== "NON_COMMAND") ||
      (event.confidenceTier !== "HIGH" &&
        event.confidenceTier !== "MED" &&
        event.confidenceTier !== "LOW") ||
      typeof event.matchedRuleId !== "string" ||
      typeof event.rulepackVersion !== "string"
    ) {
      return null;
    }

    const intentCandidate = event.intent;
    const normalizedIntent: ConversationClassifierIntent =
      intentCandidate === "APPROVE" ||
      intentCandidate === "CANCEL" ||
      intentCandidate === "ADJUST" ||
      intentCandidate === "QUESTION" ||
      intentCandidate === "on" ||
      intentCandidate === "off" ||
      intentCandidate === "private" ||
      intentCandidate === "public" ||
      intentCandidate === "status" ||
      intentCandidate === null
        ? intentCandidate
        : null;

    return {
      classifier: event.classifier,
      input: event.input,
      at: event.at,
      isShortFollowUp: event.isShortFollowUp,
      category: event.category,
      confidenceTier: event.confidenceTier,
      matchedRuleId: event.matchedRuleId,
      rulepackVersion: event.rulepackVersion,
      intent: normalizedIntent,
      conflict: typeof event.conflict === "boolean" ? event.conflict : false
    };
  };

  const classifierEvents = Array.isArray(raw.classifierEvents)
    ? raw.classifierEvents
        .map((event) => normalizeClassifierEvent(event as Partial<ConversationClassifierEvent>))
        .filter((event): event is ConversationClassifierEvent => event !== null)
    : [];

  const normalizedVisibility: ConversationVisibility =
    raw.conversationVisibility === "private" ||
    raw.conversationVisibility === "public" ||
    raw.conversationVisibility === "unknown"
      ? raw.conversationVisibility
      : "unknown";

  const normalizedAgentPulseRaw =
    raw.agentPulse && typeof raw.agentPulse === "object" ? raw.agentPulse : {};
  const defaultPulse = createDefaultAgentPulseState();
  const modeCandidate =
    typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).mode === "string"
      ? ((normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).mode as AgentPulseMode)
      : defaultPulse.mode;
  const routeStrategyCandidate =
    typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).routeStrategy === "string"
      ? ((normalizedAgentPulseRaw as Partial<AgentPulseSessionState>)
          .routeStrategy as AgentPulseRouteStrategy)
      : defaultPulse.routeStrategy;
  const lastDecisionCandidate =
    typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).lastDecisionCode === "string"
      ? ((normalizedAgentPulseRaw as Partial<AgentPulseSessionState>)
          .lastDecisionCode as AgentPulseDecisionCode)
      : defaultPulse.lastDecisionCode;

  const normalizedAgentPulse: AgentPulseSessionState = {
    optIn:
      typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).optIn === "boolean"
        ? ((normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).optIn as boolean)
        : defaultPulse.optIn,
    mode:
      modeCandidate === "private" || modeCandidate === "public" ? modeCandidate : defaultPulse.mode,
    routeStrategy:
      routeStrategyCandidate === "last_private_used" || routeStrategyCandidate === "current_conversation"
        ? routeStrategyCandidate
        : defaultPulse.routeStrategy,
    lastPulseSentAt:
      typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).lastPulseSentAt === "string"
        ? ((normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).lastPulseSentAt as string)
        : null,
    lastPulseReason:
      typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).lastPulseReason === "string"
        ? ((normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).lastPulseReason as string)
        : null,
    lastPulseTargetConversationId:
      typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).lastPulseTargetConversationId ===
      "string"
        ? ((normalizedAgentPulseRaw as Partial<AgentPulseSessionState>)
            .lastPulseTargetConversationId as string)
        : null,
    lastDecisionCode:
      lastDecisionCandidate === "ALLOWED" ||
      lastDecisionCandidate === "DISABLED" ||
      lastDecisionCandidate === "OPT_OUT" ||
      lastDecisionCandidate === "NO_PRIVATE_ROUTE" ||
      lastDecisionCandidate === "NO_STALE_FACTS" ||
      lastDecisionCandidate === "NO_UNRESOLVED_COMMITMENTS" ||
      lastDecisionCandidate === "NO_CONTEXTUAL_LINKAGE" ||
      lastDecisionCandidate === "RELATIONSHIP_ROLE_SUPPRESSED" ||
      lastDecisionCandidate === "CONTEXT_DRIFT_SUPPRESSED" ||
      lastDecisionCandidate === "CONTEXTUAL_TOPIC_COOLDOWN" ||
      lastDecisionCandidate === "QUIET_HOURS" ||
      lastDecisionCandidate === "RATE_LIMIT" ||
      lastDecisionCandidate === "NOT_EVALUATED" ||
      lastDecisionCandidate === "DYNAMIC_SENT" ||
      lastDecisionCandidate === "DYNAMIC_SUPPRESSED"
        ? lastDecisionCandidate
        : defaultPulse.lastDecisionCode,
    lastEvaluatedAt:
      typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).lastEvaluatedAt === "string"
        ? ((normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).lastEvaluatedAt as string)
        : null,
    lastContextualLexicalEvidence: normalizeAgentPulseContextualLexicalEvidence(
      (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).lastContextualLexicalEvidence
    ),
    recentEmissions: normalizeRecentEmissions(
      (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).recentEmissions
    ),
    userStyleFingerprint:
      typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).userStyleFingerprint === "string"
        ? (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).userStyleFingerprint
        : undefined,
    userTimezone:
      typeof (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).userTimezone === "string"
        ? (normalizedAgentPulseRaw as Partial<AgentPulseSessionState>).userTimezone
        : undefined
  };

  return {
    conversationId: raw.conversationId,
    userId: raw.userId,
    username: raw.username,
    conversationVisibility: normalizedVisibility,
    sessionSchemaVersion: stackMigration.sessionSchemaVersion,
    conversationStack: stackMigration.conversationStack,
    updatedAt: raw.updatedAt,
    activeProposal,
    runningJobId: typeof raw.runningJobId === "string" ? raw.runningJobId : null,
    queuedJobs,
    recentJobs,
    conversationTurns,
    classifierEvents,
    agentPulse: normalizedAgentPulse
  };
}

/**
 * Normalizes persisted interface-session state into the stable runtime shape.
 */
export function normalizeState(raw: Partial<InterfaceSessionFile>): InterfaceSessionFile {
  if (!raw.conversations || typeof raw.conversations !== "object") {
    return createEmptyInterfaceSessionFile();
  }

  const normalizedConversations: Record<string, ConversationSession> = {};
  for (const [key, value] of Object.entries(raw.conversations)) {
    const normalized = normalizeSession(value as Partial<ConversationSession>);
    if (normalized) {
      normalizedConversations[key] = normalized;
    }
  }

  return {
    conversations: normalizedConversations
  };
}
