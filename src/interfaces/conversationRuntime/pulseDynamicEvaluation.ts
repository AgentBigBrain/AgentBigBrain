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

const RELATIONSHIP_CLARIFICATION_RECENT_TURN_WINDOW = 8;
const RELATIONSHIP_CLARIFICATION_REPEAT_SUPPRESSION_THRESHOLD = 2;
const MIN_ENTITY_ANCHOR_TOKEN_LENGTH = 3;
const ENTITY_ANCHOR_STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "this",
  "that",
  "your",
  "their",
  "about"
]);

export interface DynamicPulseEvaluationParams {
  controllerSession: ConversationSession;
  userSessions: ConversationSession[];
  targetSession: ConversationSession;
  nowIso: string;
  deps: Pick<AgentPulseSchedulerDeps, "getEntityGraph" | "enqueueSystemJob">;
  applyPulseStateToUserSessions: ApplyPulseStateToUserSessions;
}

/**
 * Counts open loops still present across the active conversation stack.
 */
function countOpenLoops(stack: ReturnType<typeof buildConversationStackFromTurnsV1>): number {
  return stack.threads.reduce((total, thread) => {
    return total + thread.openLoops.filter((loop) => loop.status === "open").length;
  }, 0);
}

/**
 * Builds normalized anchor tokens from an entity name or alias.
 */
function tokenizeEntityAnchor(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) =>
      token.length >= MIN_ENTITY_ANCHOR_TOKEN_LENGTH &&
      !ENTITY_ANCHOR_STOP_WORDS.has(token)
    );
}

/**
 * Returns true when recent conversation text contains any anchor token for the entity.
 */
function recentConversationAnchorsEntity(
  entityKey: string,
  graph: NonNullable<Awaited<ReturnType<NonNullable<DynamicPulseEvaluationParams["deps"]["getEntityGraph"]>>>>,
  recentConversationText: string
): boolean {
  const entity = graph.entities.find((candidate) => candidate.entityKey === entityKey);
  if (!entity) {
    return false;
  }
  const anchorTokens = new Set<string>([
    ...tokenizeEntityAnchor(entity.canonicalName),
    ...entity.aliases.flatMap((alias) => tokenizeEntityAnchor(alias))
  ]);
  if (anchorTokens.size === 0) {
    return false;
  }
  for (const token of anchorTokens) {
    if (recentConversationText.includes(token)) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates whether a relationship-clarification pulse is grounded enough to justify interruption.
 */
function shouldSuppressRelationshipClarification(
  params: {
    candidate: import("../../core/types").PulseCandidateV1;
    graph: NonNullable<Awaited<ReturnType<NonNullable<DynamicPulseEvaluationParams["deps"]["getEntityGraph"]>>>>;
    stack: ReturnType<typeof buildConversationStackFromTurnsV1>;
    session: ConversationSession;
  }
): boolean {
  if (params.candidate.reasonCode !== "RELATIONSHIP_CLARIFICATION") {
    return false;
  }

  const openLoopCount = countOpenLoops(params.stack);
  const recentConversationText = params.session.conversationTurns
    .slice(-RELATIONSHIP_CLARIFICATION_RECENT_TURN_WINDOW)
    .map((turn) => turn.text.toLowerCase())
    .join("\n");

  const anchoredEntityCount = params.candidate.entityRefs.filter((entityKey) =>
    recentConversationAnchorsEntity(entityKey, params.graph, recentConversationText)
  ).length;

  const repeatedNegativeOutcomes = (params.session.agentPulse.recentEmissions ?? []).filter(
    (emission) =>
      emission.reasonCode === "RELATIONSHIP_CLARIFICATION" &&
      (emission.responseOutcome === "ignored" || emission.responseOutcome === "dismissed")
  ).length;

  if (anchoredEntityCount < 2 && openLoopCount === 0) {
    return true;
  }

  if (
    openLoopCount === 0 &&
    repeatedNegativeOutcomes >= RELATIONSHIP_CLARIFICATION_REPEAT_SUPPRESSION_THRESHOLD
  ) {
    return true;
  }

  return false;
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

  if (shouldSuppressRelationshipClarification({
    candidate: result.emittedCandidate,
    graph,
    stack,
    session: params.targetSession
  })) {
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
