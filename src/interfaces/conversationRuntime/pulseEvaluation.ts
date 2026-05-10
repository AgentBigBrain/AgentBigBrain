/**
 * @fileoverview Canonical legacy and dynamic Agent Pulse user-evaluation helpers.
 */

import type {
  AgentPulseEvaluationResult
} from "../../core/profileMemoryStore";
import type {
  ApplyPulseStateToUserSessions,
  AgentPulseSchedulerConfig,
  AgentPulseSchedulerDeps
} from "./pulseSchedulerContracts";
import type { AgentPulseReason } from "../../core/agentPulse";
import type { ConversationSession } from "../sessionStore";
import {
  buildSuppressedEvaluation,
  evaluateContextualFollowupCandidate,
  toContextualLexicalEvidence
} from "./pulseContextualFollowup";
import { buildPulsePrompt } from "./pulsePrompting";
import {
  selectPulseTargetSession,
  shouldSkipSessionForPulse,
  shouldSuppressPulseForSessionDomain
} from "./pulseScheduling";
import { evaluateDynamicPulse } from "./pulseDynamicEvaluation";
import {
  buildPulseAuthorityRequestId,
  buildPulseDecisionRecord,
  buildPulseSystemJobMetadata,
  evaluatePulseAuthorityGateway,
  type PulseAuthorityGatewayDecision
} from "../proactiveRuntime/pulseAuthorityGateway";

export interface PulseUserEvaluationParams {
  controllerSession: ConversationSession;
  userSessions: ConversationSession[];
  nowIso: string;
  deps: AgentPulseSchedulerDeps;
  config: AgentPulseSchedulerConfig;
  applyPulseStateToUserSessions: ApplyPulseStateToUserSessions;
}

/**
 * Evaluates one user's sessions for pulse emission and persists the resulting state transition.
 */
export async function evaluatePulseForUser(
  params: PulseUserEvaluationParams
): Promise<void> {
  let lastEvaluation: AgentPulseEvaluationResult | null = null;
  let selectedReason: AgentPulseReason | null = null;
  let highestPrioritySuppression:
    | { evaluation: AgentPulseEvaluationResult; reason: AgentPulseReason }
    | null = null;

  const targetSelection = selectPulseTargetSession(
    params.controllerSession,
    params.userSessions
  );
  if (!targetSelection.targetSession) {
    const decisionRecord = buildSuppressedPulseDecisionRecord({
      controllerSession: params.controllerSession,
      targetSession: null,
      nowIso: params.nowIso,
      reasonCode: "target_selection",
      decisionCode: targetSelection.suppressionCode ?? "NO_PRIVATE_ROUTE",
      suppressedBy: ["policy.no_private_route"]
    });
    await params.applyPulseStateToUserSessions(params.userSessions, {
      lastDecisionCode: targetSelection.suppressionCode ?? "NO_PRIVATE_ROUTE",
      lastEvaluatedAt: params.nowIso,
      lastContextualLexicalEvidence: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: null,
      decisionRecord,
      updatedAt: params.nowIso
    });
    return;
  }
  if (shouldSkipSessionForPulse(targetSelection.targetSession)) {
    const decisionRecord = buildSuppressedPulseDecisionRecord({
      controllerSession: params.controllerSession,
      targetSession: targetSelection.targetSession,
      nowIso: params.nowIso,
      reasonCode: "target_session_skip",
      decisionCode: "SKIPPED_ACTIVE_WORK",
      suppressedBy: ["policy.target_session_unavailable"]
    });
    await params.applyPulseStateToUserSessions(params.userSessions, {
      lastDecisionCode: "SKIPPED_ACTIVE_WORK",
      lastEvaluatedAt: params.nowIso,
      lastPulseReason: null,
      lastPulseTargetConversationId: targetSelection.targetSession.conversationId,
      decisionRecord,
      updatedAt: params.nowIso
    });
    return;
  }

  if (
    params.deps.enableDynamicPulse &&
    params.deps.getEntityGraph &&
    shouldSuppressPulseForSessionDomain(targetSelection.targetSession, "dynamic")
  ) {
    await params.applyPulseStateToUserSessions(params.userSessions, {
      lastDecisionCode: "SESSION_DOMAIN_SUPPRESSED",
      lastEvaluatedAt: params.nowIso,
      lastContextualLexicalEvidence: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: targetSelection.targetSession.conversationId,
      updatedAt: params.nowIso
    });
    return;
  }

  if (params.deps.enableDynamicPulse && params.deps.getEntityGraph) {
    const dynamicPreflight = await params.deps.evaluateAgentPulse({
      nowIso: params.nowIso,
      userOptIn: params.controllerSession.agentPulse.optIn,
      reason: "user_requested_followup",
      lastPulseSentAtIso: params.controllerSession.agentPulse.lastPulseSentAt,
      sessionDominantLane: targetSelection.targetSession.domainContext.dominantLane,
      sessionHasActiveWorkflowContinuity:
        targetSelection.targetSession.domainContext.continuitySignals.activeWorkspace ||
        targetSelection.targetSession.domainContext.continuitySignals.returnHandoff ||
        targetSelection.targetSession.domainContext.continuitySignals.modeContinuity,
      overrideSessionDomainSuppression: true
    });
    await evaluateDynamicPulse({
      controllerSession: params.controllerSession,
      userSessions: params.userSessions,
      targetSession: targetSelection.targetSession,
      nowIso: params.nowIso,
      deps: params.deps,
      config: params.config,
      preflightEvaluation: dynamicPreflight,
      applyPulseStateToUserSessions: params.applyPulseStateToUserSessions
    });
    return;
  }

  const contextualCandidate = evaluateContextualFollowupCandidate(
    targetSelection.targetSession,
    params.nowIso
  );
  const contextualLexicalEvidence = toContextualLexicalEvidence(
    contextualCandidate.lexicalClassification,
    params.nowIso
  );

  for (const reason of params.config.reasonPriority) {
    if (shouldSuppressPulseForSessionDomain(targetSelection.targetSession, reason)) {
      lastEvaluation = buildSuppressedEvaluation({
        allowed: false,
        decisionCode: "SESSION_DOMAIN_SUPPRESSED",
        suppressedBy: ["session.domain.workflow"],
        nextEligibleAtIso: null
      });
      selectedReason = reason;
      if (!highestPrioritySuppression) {
        highestPrioritySuppression = {
          evaluation: lastEvaluation,
          reason
        };
      }
      continue;
    }

    if (reason === "contextual_followup" && !contextualCandidate.eligible) {
      lastEvaluation = buildSuppressedEvaluation({
        allowed: false,
        decisionCode: contextualCandidate.suppressionCode ?? "NO_CONTEXTUAL_LINKAGE",
        suppressedBy:
          contextualCandidate.suppressionCode === "CONTEXTUAL_TOPIC_COOLDOWN"
            ? ["policy.contextual_followup_topic_cooldown"]
            : ["reason.requires_contextual_linkage"],
        nextEligibleAtIso: contextualCandidate.nextEligibleAtIso
      });
      selectedReason = reason;
      if (!highestPrioritySuppression) {
        highestPrioritySuppression = {
          evaluation: lastEvaluation,
          reason
        };
      }
      continue;
    }

    const evaluation = await params.deps.evaluateAgentPulse({
      nowIso: params.nowIso,
      userOptIn: params.controllerSession.agentPulse.optIn,
      reason,
      contextualLinkageConfidence:
        reason === "contextual_followup"
          ? contextualCandidate.linkageConfidence
          : undefined,
      lastPulseSentAtIso: params.controllerSession.agentPulse.lastPulseSentAt,
      sessionDominantLane: targetSelection.targetSession.domainContext.dominantLane,
      sessionHasActiveWorkflowContinuity:
        targetSelection.targetSession.domainContext.continuitySignals.activeWorkspace ||
        targetSelection.targetSession.domainContext.continuitySignals.returnHandoff ||
        targetSelection.targetSession.domainContext.continuitySignals.modeContinuity
    });
    lastEvaluation = evaluation;
    selectedReason = reason;
    const gatewayRequestId = buildPulseAuthorityRequestId({
      userId: params.controllerSession.userId,
      controllerSessionId: params.controllerSession.conversationId,
      targetSessionId: targetSelection.targetSession.conversationId,
      reasonCode: reason,
      candidateId: null,
      trigger: "interval",
      nowIso: params.nowIso
    });
    const gatewayRequest = {
      requestId: gatewayRequestId,
      userId: params.controllerSession.userId,
      controllerSessionId: params.controllerSession.conversationId,
      targetSessionId: targetSelection.targetSession.conversationId,
      targetVisibility: targetSelection.targetSession.conversationVisibility,
      reasonCode: reason,
      candidateId: null,
      trigger: "interval" as const,
      nowIso: params.nowIso,
      baseDecision: evaluation.decision,
      policyContext: {
        targetSessionVisibility: targetSelection.targetSession.conversationVisibility,
        userHasActiveMission: params.userSessions.some((session) => Boolean(session.runningJobId)),
        userHasQueuedMission: params.userSessions.some((session) => session.queuedJobs.length > 0),
        routeIsPublicSafe: targetSelection.targetSession.conversationVisibility !== "public" || params.controllerSession.agentPulse.mode === "public",
        sourceEvidencePublicSafe: true,
        timezoneSource: targetSelection.targetSession.agentPulse.userTimezone ? "explicit_user_setting" as const : "unknown" as const
      },
      evidence: {
        evidenceRefs: [],
        sourceRecallRefs: [],
        sourceRecallStatus: "not_used" as const,
        sourceRecallUsable: false,
        containsPrivateMemoryEvidence: false,
        containsRelationshipEvidence: false,
        containsIdentityEvidence: false
      }
    };
    const gatewayDecision = evaluatePulseAuthorityGateway(gatewayRequest);
    const decisionRecord = buildPulseDecisionRecord({
      request: gatewayRequest,
      decision: gatewayDecision,
      candidateProposed: true
    });

    if (!gatewayDecision.allowed) {
      if (!highestPrioritySuppression) {
        highestPrioritySuppression = {
          evaluation,
          reason
        };
      }
      await params.applyPulseStateToUserSessions(params.userSessions, {
        optIn: params.controllerSession.agentPulse.optIn,
        mode: params.controllerSession.agentPulse.mode,
        routeStrategy: params.controllerSession.agentPulse.routeStrategy,
        lastPulseReason: reason,
        lastDecisionCode: gatewayDecision.decisionCode,
        lastEvaluatedAt: params.nowIso,
        lastContextualLexicalEvidence: contextualLexicalEvidence,
        decisionRecord,
        updatedAt: params.nowIso
      });
      continue;
    }

    const prompt = buildPulsePrompt(
      targetSelection.targetSession,
      reason,
      evaluation,
      params.controllerSession.agentPulse.mode,
      reason === "contextual_followup" ? contextualCandidate : null
    );
    const enqueued = await params.deps.enqueueSystemJob(
      targetSelection.targetSession,
      prompt,
      params.nowIso,
      buildPulseSystemJobMetadata({
        pulseId: null,
        candidateId: null,
        deliveryDecisionId: gatewayDecision.decisionId,
        decisionRecordId: decisionRecord.decisionRecordId,
        promptKind: "legacy_pulse"
      })
    );
    if (!enqueued) {
      continue;
    }

    await params.applyPulseStateToUserSessions(params.userSessions, {
      optIn: params.controllerSession.agentPulse.optIn,
      mode: params.controllerSession.agentPulse.mode,
      routeStrategy: params.controllerSession.agentPulse.routeStrategy,
      lastPulseSentAt: params.nowIso,
      lastPulseReason: reason,
      lastPulseTargetConversationId: targetSelection.targetSession.conversationId,
      lastDecisionCode: evaluation.decision.decisionCode,
      lastEvaluatedAt: params.nowIso,
      lastContextualLexicalEvidence: contextualLexicalEvidence,
      decisionRecord,
      updatedAt: params.nowIso
    });
    return;
  }

  const suppression = highestPrioritySuppression
    ?? (lastEvaluation && selectedReason
      ? { evaluation: lastEvaluation, reason: selectedReason }
      : null);
  if (!suppression) {
    return;
  }

  await params.applyPulseStateToUserSessions(params.userSessions, {
    optIn: params.controllerSession.agentPulse.optIn,
    mode: params.controllerSession.agentPulse.mode,
    routeStrategy: params.controllerSession.agentPulse.routeStrategy,
    lastPulseReason: suppression.reason,
    lastDecisionCode: suppression.evaluation.decision.decisionCode,
    lastEvaluatedAt: params.nowIso,
    lastContextualLexicalEvidence: contextualLexicalEvidence,
    updatedAt: params.nowIso
  });
}

/**
 * Builds a typed suppression record for legacy pulse paths that stop before queueing a job.
 */
function buildSuppressedPulseDecisionRecord(input: {
  controllerSession: ConversationSession;
  targetSession: ConversationSession | null;
  nowIso: string;
  reasonCode: string;
  decisionCode: PulseAuthorityGatewayDecision["decisionCode"];
  suppressedBy: string[];
}): ReturnType<typeof buildPulseDecisionRecord> {
  const requestId = buildPulseAuthorityRequestId({
    userId: input.controllerSession.userId,
    controllerSessionId: input.controllerSession.conversationId,
    targetSessionId: input.targetSession?.conversationId ?? null,
    reasonCode: input.reasonCode,
    candidateId: null,
    trigger: "interval",
    nowIso: input.nowIso
  });
  const request = {
    requestId,
    userId: input.controllerSession.userId,
    controllerSessionId: input.controllerSession.conversationId,
    targetSessionId: input.targetSession?.conversationId ?? null,
    targetVisibility: input.targetSession?.conversationVisibility ?? "unknown",
    reasonCode: input.reasonCode,
    candidateId: null,
    trigger: "interval" as const,
    nowIso: input.nowIso,
    baseDecision: {
      allowed: false,
      decisionCode: input.decisionCode,
      suppressedBy: input.suppressedBy,
      nextEligibleAtIso: null
    },
    policyContext: {
      targetSessionVisibility: input.targetSession?.conversationVisibility ?? "unknown",
      userHasActiveMission: false,
      userHasQueuedMission: false,
      routeIsPublicSafe: input.targetSession?.conversationVisibility !== "public",
      sourceEvidencePublicSafe: false,
      timezoneSource: input.controllerSession.agentPulse.userTimezone ? "explicit_user_setting" as const : "unknown" as const
    },
    evidence: {
      evidenceRefs: [],
      sourceRecallRefs: [],
      sourceRecallStatus: "not_used" as const,
      sourceRecallUsable: false,
      containsPrivateMemoryEvidence: false,
      containsRelationshipEvidence: false,
      containsIdentityEvidence: false
    }
  };
  const decision = evaluatePulseAuthorityGateway(request);
  return buildPulseDecisionRecord({
    request,
    decision,
    candidateProposed: false,
    decisionStatus: "skipped"
  });
}
