/**
 * @fileoverview Canonical Stage 6.86 dynamic Agent Pulse evaluation helpers.
 */

import {
  computeUserStyleFingerprint,
  resolveUserLocalTime
} from "./sessionPulseMetadata";
import type {
  ApplyPulseStateToUserSessions,
  AgentPulseSchedulerDeps
} from "./pulseSchedulerContracts";
import type { ConversationSession } from "../sessionStore";
import {
  evaluatePulseCandidatesV1,
  type PulseEmissionRecordV1
} from "../../core/stage6_86PulseCandidates";
import { buildConversationStackFromTurnsV1 } from "../../core/stage6_86ConversationStack";
import {
  buildDynamicPulsePrompt,
  computeRelationshipAgeDays,
  type DynamicPulsePromptContext
} from "./pulsePrompting";

export interface DynamicPulseEvaluationParams {
  controllerSession: ConversationSession;
  userSessions: ConversationSession[];
  targetSession: ConversationSession;
  nowIso: string;
  deps: Pick<AgentPulseSchedulerDeps, "getEntityGraph" | "enqueueSystemJob">;
  applyPulseStateToUserSessions: ApplyPulseStateToUserSessions;
}

/**
 * Evaluates the Stage 6.86 dynamic pulse candidate path for one selected session.
 */
export async function evaluateDynamicPulse(
  params: DynamicPulseEvaluationParams
): Promise<void> {
  let graph;
  try {
    graph = await params.deps.getEntityGraph?.();
  } catch {
    console.log("[DynamicPulse] Entity graph unavailable, skipping tick.");
    return;
  }
  if (!graph) {
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

  const result = evaluatePulseCandidatesV1({
    graph,
    stack,
    observedAt: params.nowIso,
    recentPulseHistory,
    activeMissionWorkExists
  });

  if (!result.emittedCandidate) {
    await params.applyPulseStateToUserSessions(params.userSessions, {
      lastDecisionCode: "DYNAMIC_SUPPRESSED",
      lastEvaluatedAt: params.nowIso,
      lastContextualLexicalEvidence: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: params.targetSession.conversationId,
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
    graph,
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

  const prompt = buildDynamicPulsePrompt(
    result.emittedCandidate,
    params.targetSession,
    params.controllerSession.agentPulse.mode,
    promptContext
  );

  const enqueued = await params.deps.enqueueSystemJob(
    params.targetSession,
    prompt,
    params.nowIso
  );
  if (!enqueued) {
    return;
  }

  const intentSummary =
    `${result.emittedCandidate.reasonCode}: ${result.emittedCandidate.entityRefs.join(", ") || "(no entities)"}`;
  const emission: PulseEmissionRecordV1 = {
    emittedAt: params.nowIso,
    reasonCode: result.emittedCandidate.reasonCode,
    candidateEntityRefs: [...result.emittedCandidate.entityRefs],
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
    newEmission: emission
  });
}
