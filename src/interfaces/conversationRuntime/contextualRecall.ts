/**
 * @fileoverview Owns bounded in-conversation contextual recall helpers for active user turns.
 */

import type { ConversationInboundMediaEnvelope } from "../mediaRuntime/contracts";
import type { ProfileMemoryRequestTelemetry } from "../../core/profileMemoryRuntime/contracts";
import {
  recordProfileMemoryIdentitySafetyDecision,
  recordProfileMemoryRenderOperation,
  recordProfileMemorySynthesisOperation
} from "../../core/profileMemoryRuntime/profileMemoryRequestTelemetry";
import { normalizeWhitespace } from "../conversationManagerHelpers";
import type { ConversationSession } from "../sessionStore";
import type { ContextualReferenceInterpretationResolver, EntityReferenceInterpretationResolver } from "../../organs/languageUnderstanding/localIntentModelContracts";
import type {
  GetConversationEntityGraph,
  QueryConversationContinuityEpisodes,
  QueryConversationContinuityFacts
} from "./managerContracts";
import { resolveContextualReferenceHints } from "../../organs/languageUnderstanding/contextualReferenceResolution";
import {
  buildRecallSynthesis,
  renderRecallSynthesisSupportLines
} from "../../organs/memorySynthesis/recallSynthesis";
import { buildMediaContinuityHints } from "../../core/stage6_86/mediaContinuityLinking";
import {
  buildOpenLoopResumeRecallCandidate,
  buildEpisodeRecallCandidates,
  buildPausedThreadRecallCandidate,
  hasRecentDuplicateAssistantRecall,
  resolveConversationStack,
  tokenizeTopicTerms
} from "./contextualRecallSupport";
import {
  selectBestContextualRecallCandidate,
  type ContextualRecallCandidate
} from "./contextualRecallRanking";
import {
  resolveInterpretedContextualReferenceHints,
  type InterpretedContextualReferenceHints
} from "./contextualReferenceInterpretationSupport";
import { resolveInterpretedEntityReferenceHints, type InterpretedEntityReferenceHints } from "./contextualEntityReferenceInterpretationSupport";
import {
  dedupeRecallHints,
  isStructuredContinuityFactResult,
  toMemorySynthesisFactRecord
} from "./contextualRecallContinuitySupport";
import {
  describeRecallShadowParityMismatchFields,
  shouldSuppressWeakContextualRecallCandidate
} from "./contextualRecallShadowParitySupport";

export type { ContextualRecallCandidate } from "./contextualRecallRanking";

interface ContextualRecallSignals {
  stack: ReturnType<typeof resolveConversationStack>;
  resolvedReference: ReturnType<typeof resolveContextualReferenceHints>;
  mediaHints: ReturnType<typeof buildMediaContinuityHints>;
  interpretedHints: InterpretedContextualReferenceHints | null; interpretedEntityHints: InterpretedEntityReferenceHints | null;
  resolvedHints: readonly string[];
  userTokens: readonly string[];
}

/**
 * Builds the bounded hint bundle used by contextual recall before ranking candidates.
 *
 * @param session - Conversation session providing prior turns and stack state.
 * @param userInput - Current raw user message before execution wrapping.
 * @param media - Optional interpreted media envelope that may provide continuity cues.
 * @param contextualReferenceInterpretationResolver - Optional bounded contextual-reference interpreter.
 * @returns Deterministic and model-assisted recall hints for the current turn.
 */
async function resolveContextualRecallSignals(
  session: ConversationSession,
  userInput: string,
  media: ConversationInboundMediaEnvelope | null,
  contextualReferenceInterpretationResolver?: ContextualReferenceInterpretationResolver,
  getEntityGraph?: GetConversationEntityGraph,
  entityReferenceInterpretationResolver?: EntityReferenceInterpretationResolver
): Promise<ContextualRecallSignals> {
  const normalizedInput = normalizeWhitespace(userInput);
  const stack = resolveConversationStack(session);
  const resolvedReference = resolveContextualReferenceHints({
    userInput: normalizedInput,
    recentTurns: session.conversationTurns,
    threads: stack.threads
  });
  const mediaHints = buildMediaContinuityHints(media);
  const interpretedHints = await resolveInterpretedContextualReferenceHints(
    session,
    stack,
    normalizedInput,
    resolvedReference,
    contextualReferenceInterpretationResolver
  );
  const interpretedEntityHints = await resolveInterpretedEntityReferenceHints(session, normalizedInput, resolvedReference, getEntityGraph, entityReferenceInterpretationResolver);
  const modelHints = interpretedHints ? [...interpretedHints.entityHints, ...interpretedHints.topicHints] : [];
  const entityHints = interpretedEntityHints?.resolvedEntityHints ?? [];
  const resolvedHints = dedupeRecallHints([
    ...resolvedReference.resolvedHints,
    ...modelHints,
    ...entityHints,
    ...mediaHints.recallHints
  ]);
  const fallbackTokens = dedupeRecallHints([
    ...tokenizeTopicTerms(normalizedInput),
    ...modelHints,
    ...entityHints,
    ...mediaHints.recallHints
  ]);
  const userTokens = resolvedHints.length > 0 ? resolvedHints : fallbackTokens;
  return {
    stack,
    resolvedReference,
    mediaHints,
    interpretedHints,
    interpretedEntityHints,
    resolvedHints,
    userTokens
  };
}

/**
 * Selects the best contextual recall candidate from one already-resolved signal bundle.
 *
 * @param session - Conversation session providing prior turns and stack state.
 * @param signals - Deterministic and model-assisted recall hints for the current turn.
 * @param queryContinuityEpisodes - Optional bounded episodic-memory query capability.
 * @returns One grounded recall candidate, or `null` when no bounded recall should be offered.
 */
async function resolveContextualRecallCandidateFromSignals(
  session: ConversationSession,
  signals: ContextualRecallSignals,
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes
): Promise<ContextualRecallCandidate | null> {
  if (signals.userTokens.length === 0) {
    return null;
  }

  const nowMs = Date.parse(session.updatedAt);
  const openLoopResumeCandidate = signals.interpretedHints?.kind === "open_loop_resume_reference"
    ? buildOpenLoopResumeRecallCandidate(
      session,
      signals.stack,
      [...signals.interpretedHints.entityHints, ...signals.interpretedHints.topicHints]
    )
    : null;
  const pausedThreadCandidate = Number.isFinite(nowMs)
    ? buildPausedThreadRecallCandidate(session, signals.stack, signals.userTokens, nowMs)
    : null;
  const episodeQueryHints = signals.interpretedEntityHints?.resolvedEntityHints.length ? signals.interpretedEntityHints.resolvedEntityHints : signals.userTokens;
  const episodeCandidates = await buildEpisodeRecallCandidates(
    session,
    signals.stack,
    episodeQueryHints,
    queryContinuityEpisodes
  );
  const bestCandidate = selectBestContextualRecallCandidate([
    ...(openLoopResumeCandidate ? [openLoopResumeCandidate] : []),
    ...(pausedThreadCandidate ? [pausedThreadCandidate] : []),
    ...episodeCandidates
  ]);
  if (!bestCandidate) {
    return null;
  }

  if (
    shouldSuppressWeakContextualRecallCandidate(
      bestCandidate,
      signals.resolvedReference,
      signals.mediaHints.recallHints,
      signals.interpretedHints
    )
  ) {
    return null;
  }

  if (hasRecentDuplicateAssistantRecall(session, bestCandidate, signals.userTokens)) {
    return null;
  }

  return bestCandidate;
}

/**
 * Resolves one bounded in-conversation contextual recall opportunity for the current user turn.
 *
 * @param session - Conversation session providing prior turns and stack state.
 * @param userInput - Current raw user message before execution wrapping.
 * @param queryContinuityEpisodes - Optional bounded episodic-memory query capability.
 * @param media - Optional interpreted media envelope that may provide continuity cues.
 * @returns One grounded recall candidate, or `null` when no bounded recall should be offered.
 */
export async function resolveContextualRecallCandidate(
  session: ConversationSession,
  userInput: string,
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes,
  media?: ConversationInboundMediaEnvelope | null,
  contextualReferenceInterpretationResolver?: ContextualReferenceInterpretationResolver,
  getEntityGraph?: GetConversationEntityGraph,
  entityReferenceInterpretationResolver?: EntityReferenceInterpretationResolver
): Promise<ContextualRecallCandidate | null> {
  const normalizedInput = normalizeWhitespace(userInput);
  if (!normalizedInput) {
    return null;
  }

  const signals = await resolveContextualRecallSignals(
    session,
    normalizedInput,
    media ?? null,
    contextualReferenceInterpretationResolver,
    getEntityGraph,
    entityReferenceInterpretationResolver
  );
  return resolveContextualRecallCandidateFromSignals(
    session,
    signals,
    queryContinuityEpisodes
  );
}

/**
 * Builds the bounded execution-input block for one contextual recall opportunity.
 *
 * @param session - Conversation session providing prior turns and stack state.
 * @param userInput - Current raw user message before execution wrapping.
 * @param queryContinuityEpisodes - Optional bounded episodic-memory query capability.
 * @param queryContinuityFacts - Optional bounded continuity fact query capability.
 * @param media - Optional interpreted media envelope that may provide continuity cues.
 * @returns Instruction block appended to execution input, or `null` when no recall applies.
 */
export async function buildContextualRecallBlock(
  session: ConversationSession,
  userInput: string,
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes,
  queryContinuityFacts?: QueryConversationContinuityFacts,
  media?: ConversationInboundMediaEnvelope | null,
  contextualReferenceInterpretationResolver?: ContextualReferenceInterpretationResolver,
  getEntityGraph?: GetConversationEntityGraph,
  entityReferenceInterpretationResolver?: EntityReferenceInterpretationResolver,
  requestTelemetry?: ProfileMemoryRequestTelemetry
): Promise<string | null> {
  const normalizedInput = normalizeWhitespace(userInput);
  const signals = await resolveContextualRecallSignals(
    session,
    normalizedInput,
    media ?? null,
    contextualReferenceInterpretationResolver,
    getEntityGraph,
    entityReferenceInterpretationResolver
  );
  const {
    stack,
    resolvedReference,
    mediaHints,
    interpretedHints,
    interpretedEntityHints,
    resolvedHints
  } = signals;
  const candidate = await resolveContextualRecallCandidateFromSignals(
    session,
    signals,
    queryContinuityEpisodes
  );
  if (!candidate) {
    return null;
  }

  const supportingEpisodes = queryContinuityEpisodes && resolvedHints.length > 0
    ? await queryContinuityEpisodes({
      stack,
      entityHints: resolvedHints,
      semanticMode: "event_history",
      relevanceScope: "conversation_local",
      maxEpisodes: 3
    }).catch(() => [])
    : [];
  const supportingFacts = queryContinuityFacts && resolvedHints.length > 0
    ? await queryContinuityFacts({
      stack,
      entityHints: resolvedHints,
      semanticMode: "relationship_inventory",
      relevanceScope: "conversation_local",
      maxFacts: 3
    }).catch(() => [])
    : [];
  const synthesis = isStructuredContinuityFactResult(supportingFacts)
    ? buildRecallSynthesis(
        supportingFacts.temporalSynthesis,
        supportingEpisodes,
        supportingFacts.map(toMemorySynthesisFactRecord)
      )
    : buildRecallSynthesis(supportingEpisodes, supportingFacts);
  if (interpretedEntityHints) {
    recordProfileMemoryIdentitySafetyDecision(requestTelemetry);
  }
  if (synthesis) {
    recordProfileMemorySynthesisOperation(requestTelemetry);
  }
  const recallSynthesisLines = renderRecallSynthesisSupportLines(synthesis);
  const shadowParityGuardLine =
    synthesis?.shadowParity?.compared &&
    (!synthesis.shadowParity.decisionMatches || !synthesis.shadowParity.renderMatches)
      ? [
          `- Shadow parity guard: temporal recall differs from the compatibility fallback on ${describeRecallShadowParityMismatchFields(
            synthesis.shadowParity.mismatchedFields
          )}. Prefer the temporal split view and fail closed if the answer still feels uncertain.`
        ]
      : [];
  const mediaCueLine = mediaHints.recallHints.length > 0
    ? [`- Media continuity cues: ${mediaHints.recallHints.join(", ")}`]
    : [];
  const mediaEvidenceLine = mediaHints.evidence.length > 0
    ? [`- Media cue sources: ${mediaHints.evidence.join(", ")}`]
    : [];
  const modelEvidenceLine = interpretedHints ? [
    `- Model-assisted contextual hints: ${[...interpretedHints.entityHints, ...interpretedHints.topicHints].join(", ")}`,
    `- Model-assisted cue type: ${interpretedHints.kind}`,
    `- Model-assisted rationale: ${interpretedHints.explanation}`
  ] : [];
  const entityModelEvidenceLine = interpretedEntityHints ? [
    `- Model-assisted entity references: ${interpretedEntityHints.selectedEntityLabels.join(", ")}`,
    `- Model-assisted entity rationale: ${interpretedEntityHints.explanation}`
  ] : [];

  if (candidate.kind === "episode") {
    recordProfileMemoryRenderOperation(requestTelemetry);
    return [
      "Contextual recall opportunity (optional):",
      "- The user naturally re-mentioned a person or topic tied to an older unresolved situation.",
      `- Relevant situation: ${candidate.topicLabel}`,
      `- Situation summary: ${candidate.episodeSummary ?? candidate.supportingCue}`,
      `- Prior cue: ${candidate.supportingCue}`,
      `- Situation status: ${candidate.episodeStatus ?? "unresolved"}`,
      `- Related open loops: ${candidate.openLoopCount}`,
      `- Last mentioned: ${candidate.lastTouchedAt}`,
      ...modelEvidenceLine,
      ...entityModelEvidenceLine,
      ...mediaCueLine,
      ...mediaEvidenceLine,
      ...(resolvedReference.usedFallbackContext
        ? [`- Resolved from context: ${resolvedReference.evidence.join(", ")}`]
        : []),
      ...shadowParityGuardLine,
      ...recallSynthesisLines,
      "- Response rule: if it fits naturally, ask at most one brief follow-up about this specific older situation before returning to the current request.",
      "- Do not ask if it would feel repetitive, overly intrusive, or derail the current request."
    ].join("\n");
  }

  recordProfileMemoryRenderOperation(requestTelemetry);
  return [
    "Contextual recall opportunity (optional):",
    `- The user just re-mentioned an older paused topic: ${candidate.topicLabel}`,
    `- Prior thread cue: ${candidate.supportingCue}`,
    `- Open loops on that thread: ${candidate.openLoopCount}`,
    ...(candidate.matchSource === "open_loop_resume" && candidate.matchedOpenLoopId
      ? [`- Matched unresolved loop: ${candidate.matchedOpenLoopId}`]
      : []),
    ...(candidate.matchSource === "open_loop_resume" && candidate.matchedHintTerms && candidate.matchedHintTerms.length > 0
      ? [`- Matched open-loop cues: ${candidate.matchedHintTerms.join(", ")}`]
      : []),
    `- Last touched: ${candidate.lastTouchedAt}`,
    ...modelEvidenceLine,
    ...entityModelEvidenceLine,
    ...mediaCueLine,
    ...mediaEvidenceLine,
    ...(resolvedReference.usedFallbackContext
      ? [`- Resolved from context: ${resolvedReference.evidence.join(", ")}`]
      : []),
    ...shadowParityGuardLine,
    ...recallSynthesisLines,
    "- Response rule: if it fits naturally, you may ask one brief follow-up about that older unresolved thread before continuing.",
    "- Do not force the detour if the current request is clearly unrelated.",
    "- Do not repeat a recent follow-up the assistant already asked."
  ].join("\n");
}
