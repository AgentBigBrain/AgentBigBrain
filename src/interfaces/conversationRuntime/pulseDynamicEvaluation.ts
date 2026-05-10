/**
 * @fileoverview Canonical Stage 6.86 dynamic Agent Pulse evaluation helpers.
 */

import {
  computeUserStyleFingerprint,
  resolveUserLocalTime
} from "./sessionPulseMetadata";
import {
  countOpenLoops,
  shouldSuppressRelationshipClarificationPulse
} from "../proactiveRuntime/followupQualification";
import type {
  ApplyPulseStateToUserSessions,
  AgentPulseSchedulerConfig,
  AgentPulseSchedulerDeps
} from "./pulseSchedulerContracts";
import type { AgentPulseEvaluationResult } from "../../core/profileMemoryStore";
import type { ConversationSession } from "../sessionStore";
import {
  evaluatePulseCandidatesV1,
  type PulseEmissionRecordV1
} from "../../core/stage6_86PulseCandidates";
import { buildProactiveInquiryCandidateFromPulseCandidate } from "../../core/stage6_86/proactiveInquiryCandidates";
import { buildConversationStackFromTurnsV1 } from "../../core/stage6_86ConversationStack";
import {
  buildDynamicPulsePrompt,
  computeRelationshipAgeDays,
  type DynamicPulsePromptContext
} from "./pulsePrompting";
import type { ConversationDomainLane, EntityGraphV1 } from "../../core/types";
import { shouldSuppressPulseForSessionDomain } from "./pulseScheduling";
import { hasAuthoritativeConversationDomainLane } from "./sessionDomainRouting";
import { evaluateProactiveInquiryDeliveryPolicy } from "../proactiveRuntime/deliveryPolicy";
import {
  buildDynamicDecisionRecord,
  buildDynamicPulseGatewayRequest
} from "./pulseDynamicAuthority";
import {
  buildPulseDecisionRecord,
  buildPulseSystemJobMetadata,
  evaluatePulseAuthorityGateway
} from "../proactiveRuntime/pulseAuthorityGateway";

const RELATIONSHIP_CLARIFICATION_RECENT_TURN_WINDOW = 8;

export interface DynamicPulseEvaluationParams {
  controllerSession: ConversationSession;
  userSessions: ConversationSession[];
  targetSession: ConversationSession;
  nowIso: string;
  deps: Pick<AgentPulseSchedulerDeps, "getEntityGraph" | "enqueueSystemJob">;
  config: AgentPulseSchedulerConfig;
  preflightEvaluation: AgentPulseEvaluationResult;
  applyPulseStateToUserSessions: ApplyPulseStateToUserSessions;
}

interface DomainBiasedPulseGraphOptions {
  allowFullGraphFallback?: boolean;
}

/**
 * Applies a soft session-domain bias to the entity graph used during dynamic pulse scoring.
 *
 * **Why it exists:**
 * Entity ingress can now carry bounded domain hints. Dynamic pulse should prefer entities that
 * match the current session lane, while still falling back to the full graph when no compatible
 * candidates exist.
 *
 * **What it talks to:**
 * - Uses `EntityGraphV1` (import type `EntityGraphV1`) from `../../core/types`.
 *
 * @param graph - Shared entity graph snapshot for candidate evaluation.
 * @param dominantLane - Current session lane used for soft preference.
 * @returns Domain-biased graph view, or the original graph when no bias applies.
 */
export function buildDomainBiasedPulseGraph(
  graph: EntityGraphV1,
  dominantLane: ConversationDomainLane | null | undefined,
  options: DomainBiasedPulseGraphOptions = {}
): EntityGraphV1 {
  if (!dominantLane || dominantLane === "unknown") {
    return graph;
  }

  const keptEntities = graph.entities.filter(
    (entity) => entity.domainHint === null || entity.domainHint === dominantLane
  );
  if (keptEntities.length === graph.entities.length) {
    return graph;
  }
  if (keptEntities.length === 0) {
    return options.allowFullGraphFallback === true
      ? graph
      : {
          ...graph,
          entities: [],
          edges: []
        };
  }

  const keptEntityKeys = new Set(keptEntities.map((entity) => entity.entityKey));
  return {
    ...graph,
    entities: keptEntities,
    edges: graph.edges.filter(
      (edge) =>
        keptEntityKeys.has(edge.sourceEntityKey) &&
        keptEntityKeys.has(edge.targetEntityKey)
    )
  };
}

/**
 * Evaluates the Stage 6.86 dynamic pulse candidate path for one selected session.
 */
export async function evaluateDynamicPulse(
  params: DynamicPulseEvaluationParams
): Promise<void> {
  if (shouldSuppressPulseForSessionDomain(params.targetSession, "dynamic")) {
    const decisionRecord = buildDynamicDecisionRecord({
      params,
      candidateId: null,
      reasonCode: "dynamic",
      baseDecision: {
        allowed: false,
        decisionCode: "SESSION_DOMAIN_SUPPRESSED",
        suppressedBy: ["session.domain.workflow"],
        nextEligibleAtIso: null
      },
      candidateProposed: false
    });
    await params.applyPulseStateToUserSessions(params.userSessions, {
      lastDecisionCode: "SESSION_DOMAIN_SUPPRESSED",
      lastEvaluatedAt: params.nowIso,
      lastContextualLexicalEvidence: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: params.targetSession.conversationId,
      decisionRecord,
      updatedAt: params.nowIso
    });
    return;
  }

  if (!params.preflightEvaluation.decision.allowed) {
    const decisionRecord = buildDynamicDecisionRecord({
      params,
      candidateId: null,
      reasonCode: "dynamic_preflight",
      baseDecision: params.preflightEvaluation.decision,
      candidateProposed: false
    });
    await params.applyPulseStateToUserSessions(params.userSessions, {
      lastDecisionCode: params.preflightEvaluation.decision.decisionCode,
      lastEvaluatedAt: params.nowIso,
      lastContextualLexicalEvidence: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: params.targetSession.conversationId,
      decisionRecord,
      updatedAt: params.nowIso
    });
    return;
  }

  let graph;
  try {
    graph = await params.deps.getEntityGraph?.();
  } catch {
    const decisionRecord = buildDynamicDecisionRecord({
      params,
      candidateId: null,
      reasonCode: "dynamic_dependency",
      baseDecision: {
        allowed: false,
        decisionCode: "DEPENDENCY_UNAVAILABLE",
        suppressedBy: ["dependency.entity_graph_unavailable"],
        nextEligibleAtIso: null
      },
      candidateProposed: false,
      decisionStatus: "blocked"
    });
    await params.applyPulseStateToUserSessions(params.userSessions, {
      lastDecisionCode: "DEPENDENCY_UNAVAILABLE",
      lastEvaluatedAt: params.nowIso,
      lastContextualLexicalEvidence: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: params.targetSession.conversationId,
      decisionRecord,
      updatedAt: params.nowIso
    });
    return;
  }
  if (!graph) {
    const decisionRecord = buildDynamicDecisionRecord({
      params,
      candidateId: null,
      reasonCode: "dynamic_dependency",
      baseDecision: {
        allowed: false,
        decisionCode: "DEPENDENCY_UNAVAILABLE",
        suppressedBy: ["dependency.entity_graph_missing"],
        nextEligibleAtIso: null
      },
      candidateProposed: false,
      decisionStatus: "blocked"
    });
    await params.applyPulseStateToUserSessions(params.userSessions, {
      lastDecisionCode: "DEPENDENCY_UNAVAILABLE",
      lastEvaluatedAt: params.nowIso,
      lastContextualLexicalEvidence: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: params.targetSession.conversationId,
      decisionRecord,
      updatedAt: params.nowIso
    });
    return;
  }

  const stack = params.targetSession.conversationStack
    ?? buildConversationStackFromTurnsV1(
      params.targetSession.conversationTurns,
      params.targetSession.updatedAt
    );

  const activeMissionWorkExists =
    Boolean(params.targetSession.runningJobId) || params.targetSession.queuedJobs.length > 0;
  const recentPulseHistory: readonly PulseEmissionRecordV1[] =
    params.targetSession.agentPulse.recentEmissions ?? [];

  const biasedGraph = buildDomainBiasedPulseGraph(
    graph,
    params.targetSession.domainContext.dominantLane,
    {
      allowFullGraphFallback: hasAuthoritativeConversationDomainLane(
        params.targetSession,
        params.targetSession.domainContext.dominantLane
      )
    }
  );
  const biasedResult = evaluatePulseCandidatesV1({
    graph: biasedGraph,
    stack,
    observedAt: params.nowIso,
    recentPulseHistory,
    activeMissionWorkExists
  });
  const canUseFullGraphFallback = hasAuthoritativeConversationDomainLane(
    params.targetSession,
    params.targetSession.domainContext.dominantLane
  );
  const result = biasedResult.emittedCandidate || !canUseFullGraphFallback
    ? biasedResult
    : evaluatePulseCandidatesV1({
        graph,
        stack,
        observedAt: params.nowIso,
        recentPulseHistory,
        activeMissionWorkExists
      });
  const effectiveGraph = biasedResult.emittedCandidate || !canUseFullGraphFallback
    ? biasedGraph
    : graph;

  if (!result.emittedCandidate) {
    const decisionRecord = buildDynamicDecisionRecord({
      params,
      candidateId: null,
      reasonCode: "dynamic_candidate",
      baseDecision: {
        allowed: false,
        decisionCode: "DYNAMIC_SUPPRESSED",
        suppressedBy: ["candidate.none_emitted"],
        nextEligibleAtIso: null
      },
      candidateProposed: false
    });
    await params.applyPulseStateToUserSessions(params.userSessions, {
      lastDecisionCode: "DYNAMIC_SUPPRESSED",
      lastEvaluatedAt: params.nowIso,
      lastContextualLexicalEvidence: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: params.targetSession.conversationId,
      decisionRecord,
      updatedAt: params.nowIso
    });
    return;
  }

  if (shouldSuppressRelationshipClarificationPulse({
    candidate: result.emittedCandidate,
    graph: effectiveGraph,
    recentConversationText: params.targetSession.conversationTurns
      .slice(-RELATIONSHIP_CLARIFICATION_RECENT_TURN_WINDOW)
      .map((turn) => turn.text.toLowerCase())
      .join("\n"),
    openLoopCount: countOpenLoops(stack),
    repeatedNegativeOutcomes: (params.targetSession.agentPulse.recentEmissions ?? []).filter(
      (emission) =>
        emission.reasonCode === "RELATIONSHIP_CLARIFICATION" &&
        (emission.responseOutcome === "ignored" || emission.responseOutcome === "dismissed")
    ).length
  })) {
    const decisionRecord = buildDynamicDecisionRecord({
      params,
      candidateId: result.emittedCandidate.candidateId,
      reasonCode: result.emittedCandidate.reasonCode,
      baseDecision: {
        allowed: false,
        decisionCode: "DYNAMIC_SUPPRESSED",
        suppressedBy: ["candidate.relationship_clarification_low_utility"],
        nextEligibleAtIso: null
      },
      candidateProposed: true
    });
    await params.applyPulseStateToUserSessions(params.userSessions, {
      lastDecisionCode: "DYNAMIC_SUPPRESSED",
      lastEvaluatedAt: params.nowIso,
      lastContextualLexicalEvidence: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: params.targetSession.conversationId,
      decisionRecord,
      updatedAt: params.nowIso
    });
    return;
  }

  const nowMs = Date.parse(params.nowIso);
  const userTurns = params.targetSession.conversationTurns.filter((turn) => turn.role === "user");
  const lastUserTurn = userTurns.length > 0 ? userTurns[userTurns.length - 1] : null;
  const conversationalGapMs = lastUserTurn
    ? Math.max(0, nowMs - Date.parse(lastUserTurn.at))
    : 0;

  const userLocalTime = resolveUserLocalTime(
    params.targetSession.agentPulse.userTimezone,
    params.nowIso
  );

  const relationshipAgeDays = computeRelationshipAgeDays(
    effectiveGraph,
    params.targetSession,
    nowMs
  );

  const promptContext: DynamicPulsePromptContext = {
    nowIso: params.nowIso,
    userLocalTime,
    conversationalGapMs,
    relationshipAgeDays,
    previousPulseOutcomes: params.targetSession.agentPulse.recentEmissions ?? [],
    userStyleFingerprint: computeUserStyleFingerprint(params.targetSession.conversationTurns)
  };
  const proactiveInquiryCandidate = buildProactiveInquiryCandidateFromPulseCandidate(
    result.emittedCandidate,
    { sourceRecallStatus: "not_used" }
  );
  const proactiveInquiryDeliveryDecision = evaluateProactiveInquiryDeliveryPolicy({
    candidate: proactiveInquiryCandidate,
    targetMode: params.controllerSession.agentPulse.mode,
    recentPulseHistory
  });
  if (!proactiveInquiryDeliveryDecision.allowed) {
    const decisionRecord = buildDynamicDecisionRecord({
      params,
      candidateId: result.emittedCandidate.candidateId,
      reasonCode: result.emittedCandidate.reasonCode,
      baseDecision: {
        allowed: false,
        decisionCode: "DYNAMIC_SUPPRESSED",
        suppressedBy: proactiveInquiryDeliveryDecision.suppressedBy,
        nextEligibleAtIso: null
      },
      candidateProposed: true
    });
    await params.applyPulseStateToUserSessions(params.userSessions, {
      lastDecisionCode: "DYNAMIC_SUPPRESSED",
      lastEvaluatedAt: params.nowIso,
      lastContextualLexicalEvidence: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: params.targetSession.conversationId,
      decisionRecord,
      updatedAt: params.nowIso
    });
    return;
  }

  const gatewayRequest = buildDynamicPulseGatewayRequest({
    params,
    candidate: result.emittedCandidate,
    proactiveInquiryCandidate
  });
  const gatewayDecision = evaluatePulseAuthorityGateway(gatewayRequest);
  const gatewayDecisionRecord = buildPulseDecisionRecord({
    request: gatewayRequest,
    decision: gatewayDecision,
    candidateProposed: true
  });
  if (!gatewayDecision.allowed) {
    await params.applyPulseStateToUserSessions(params.userSessions, {
      lastDecisionCode: gatewayDecision.decisionCode,
      lastEvaluatedAt: params.nowIso,
      lastContextualLexicalEvidence: null,
      lastPulseReason: result.emittedCandidate.reasonCode,
      lastPulseTargetConversationId: params.targetSession.conversationId,
      decisionRecord: gatewayDecisionRecord,
      updatedAt: params.nowIso
    });
    return;
  }

  const prompt = buildDynamicPulsePrompt(
    result.emittedCandidate,
    params.targetSession,
    params.controllerSession.agentPulse.mode,
    promptContext
  );

  const enqueued = await params.deps.enqueueSystemJob(
    params.targetSession,
    prompt,
    params.nowIso,
    buildPulseSystemJobMetadata({
      pulseId: result.trace.emittedPulseEnvelope?.pulseId ?? null,
      candidateId: result.emittedCandidate.candidateId,
      deliveryDecisionId: gatewayDecision.decisionId,
      decisionRecordId: gatewayDecisionRecord.decisionRecordId,
      promptKind: "stage6_86_dynamic_pulse"
    })
  );
  if (!enqueued) {
    return;
  }

  const intentSummary =
    `${proactiveInquiryCandidate.inquiryType}: ${proactiveInquiryCandidate.questionPlan.userFacingGoal}`;
  const envelope = result.trace.emittedPulseEnvelope;
  const deliveryEnvelope = envelope
    ? {
        ...envelope,
        deliveryDecisionId: gatewayDecision.decisionId,
        decisionRecordId: gatewayDecisionRecord.decisionRecordId,
        inquiryType: proactiveInquiryCandidate.inquiryType
      }
    : undefined;
  const emission: PulseEmissionRecordV1 = {
    emittedAt: params.nowIso,
    reasonCode: result.emittedCandidate.reasonCode,
    candidateEntityRefs: [...result.emittedCandidate.entityRefs],
    pulseId: envelope?.pulseId,
    candidateId: result.emittedCandidate.candidateId,
    questionIntent: proactiveInquiryCandidate.questionPlan.userFacingGoal,
    sourceRecallRefs: deliveryEnvelope?.sourceRecallRefs ?? [],
    proactiveInquiryCandidate,
    deliveryEnvelope,
    outcomeRecord: deliveryEnvelope
      ? {
          pulseId: deliveryEnvelope.pulseId,
          candidateId: deliveryEnvelope.candidateId,
          emittedAt: params.nowIso,
          deliveredTextHash: null,
          deliveredTextPreviewRedacted: null,
          responseOutcome: null,
          outcomeSource: "pending"
        }
      : undefined,
    responseOutcome: null,
    generatedSnippet: intentSummary.slice(0, 120)
  };

  await params.applyPulseStateToUserSessions(params.userSessions, {
    optIn: params.controllerSession.agentPulse.optIn,
    mode: params.controllerSession.agentPulse.mode,
    routeStrategy: params.controllerSession.agentPulse.routeStrategy,
    lastPulseSentAt: params.nowIso,
    lastPulseReason: result.emittedCandidate.reasonCode,
    lastPulseTargetConversationId: params.targetSession.conversationId,
    lastDecisionCode: "DYNAMIC_SENT",
    lastEvaluatedAt: params.nowIso,
    lastContextualLexicalEvidence: null,
    updatedAt: params.nowIso,
    newEmission: emission,
    decisionRecord: gatewayDecisionRecord
  });
}
