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
  shouldSkipSessionForPulse
} from "./pulseScheduling";
import { evaluateDynamicPulse } from "./pulseDynamicEvaluation";

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
    await params.applyPulseStateToUserSessions(params.userSessions, {
      lastDecisionCode: targetSelection.suppressionCode ?? "NO_PRIVATE_ROUTE",
      lastEvaluatedAt: params.nowIso,
      lastContextualLexicalEvidence: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: null,
      updatedAt: params.nowIso
    });
    return;
  }
  if (shouldSkipSessionForPulse(targetSelection.targetSession)) {
    return;
  }

  if (params.deps.enableDynamicPulse && params.deps.getEntityGraph) {
    await evaluateDynamicPulse({
      controllerSession: params.controllerSession,
      userSessions: params.userSessions,
      targetSession: targetSelection.targetSession,
      nowIso: params.nowIso,
      deps: params.deps,
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
      lastPulseSentAtIso: params.controllerSession.agentPulse.lastPulseSentAt
    });
    lastEvaluation = evaluation;
    selectedReason = reason;

    if (!evaluation.decision.allowed) {
      if (!highestPrioritySuppression) {
        highestPrioritySuppression = {
          evaluation,
          reason
        };
      }
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
      params.nowIso
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
