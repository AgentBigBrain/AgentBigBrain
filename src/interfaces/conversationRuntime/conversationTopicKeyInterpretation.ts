/**
 * @fileoverview Bounded eligibility, request shaping, and fail-closed mapping for live topic-key interpretation.
 */

import type {
  TopicKeyCandidateV1
} from "../../core/types";
import {
  deriveTopicKeyCandidatesV1,
  isConversationStackV1,
  type TopicKeyInterpretationSignalV1
} from "../../core/stage6_86ConversationStack";
import {
  DEFAULT_TOPIC_SWITCH_THRESHOLD,
  resolveExplicitReturnThread,
  RETURN_SIGNAL_PATTERN
} from "../../core/stage6_86/conversationStackHelpers";
import { routeTopicKeyInterpretationModel } from "../../organs/languageUnderstanding/localIntentModelRouter";
import type { TopicKeyInterpretationResolver } from "../../organs/languageUnderstanding/localIntentModelContracts";
import type { ConversationSession } from "../sessionStore";
import type { RoutingMapClassificationV1 } from "../routingMap";
import type { ResolvedConversationIntentMode } from "./intentModeContracts";
import { buildLocalIntentSessionHints } from "./conversationRoutingSupport";

const MAX_TOPIC_KEY_INTERPRETATION_INPUT_CHARS = 240;
const MAX_TOPIC_KEY_INTERPRETATION_RECENT_TURNS = 4;
const MAX_TOPIC_KEY_INTERPRETATION_PAUSED_THREADS = 4;
const TOPIC_INTERPRETATION_AMBIGUITY_DELTA = 0.08;

/**
 * Returns whether deterministic topic candidate selection is still ambiguous enough to justify
 * bounded model assistance.
 *
 * @param primaryCandidate - Highest-confidence deterministic candidate.
 * @param secondaryCandidate - Runner-up deterministic candidate.
 * @returns `true` when deterministic selection is weak or closely contested.
 */
function hasAmbiguousTopicSelection(
  primaryCandidate: TopicKeyCandidateV1 | null,
  secondaryCandidate: TopicKeyCandidateV1 | null
): boolean {
  if (!primaryCandidate || primaryCandidate.confidence < DEFAULT_TOPIC_SWITCH_THRESHOLD) {
    return true;
  }
  if (!secondaryCandidate) {
    return false;
  }
  return primaryCandidate.confidence - secondaryCandidate.confidence <= TOPIC_INTERPRETATION_AMBIGUITY_DELTA;
}

/**
 * Resolves one optional precomputed topic-key interpretation signal for a live user turn.
 *
 * **Why it exists:**
 * The Stage 6.86 conversation stack remains synchronous. Live routing therefore needs one bounded
 * async step that can precompute a topic/thread hint before the user turn is recorded, and only for
 * ambiguous deterministic leftovers.
 *
 * **What it talks to:**
 * - Calls `routeTopicKeyInterpretationModel` from the shared local-model runtime.
 * - Reads `session.conversationStack` and bounded recent turns from live session state.
 * - Reuses deterministic topic candidate extraction from `deriveTopicKeyCandidatesV1`.
 *
 * @param session - Live conversation session carrying the current Stage 6.86 stack.
 * @param userInput - Current raw user turn.
 * @param receivedAt - Timestamp used for deterministic topic candidates.
 * @param routingClassification - Deterministic routing classification for the same turn.
 * @param resolvedIntentMode - Canonical pre-routing intent resolution for the same turn.
 * @param topicKeyInterpretationResolver - Optional shared topic-key interpreter.
 * @returns One validated precomputed signal for this turn, otherwise `null`.
 */
export async function resolveConversationTopicKeyInterpretationSignal(
  session: ConversationSession,
  userInput: string,
  receivedAt: string,
  routingClassification: RoutingMapClassificationV1 | null,
  resolvedIntentMode: ResolvedConversationIntentMode,
  topicKeyInterpretationResolver?: TopicKeyInterpretationResolver
): Promise<TopicKeyInterpretationSignalV1 | null> {
  if (
    !topicKeyInterpretationResolver ||
    resolvedIntentMode.mode === "discover_available_capabilities"
  ) {
    return null;
  }

  const normalizedInput = userInput.trim();
  if (!normalizedInput || normalizedInput.length > MAX_TOPIC_KEY_INTERPRETATION_INPUT_CHARS) {
    return null;
  }

  const stack = isConversationStackV1(session.conversationStack)
    ? session.conversationStack
    : null;
  if (!stack) {
    return null;
  }

  const activeThread = stack.activeThreadKey
    ? stack.threads.find((thread) => thread.threadKey === stack.activeThreadKey) ?? null
    : null;
  const pausedThreads = stack.threads
    .filter((thread) => thread.state === "paused")
    .slice(0, MAX_TOPIC_KEY_INTERPRETATION_PAUSED_THREADS);
  if (!activeThread && pausedThreads.length === 0) {
    return null;
  }

  const deterministicCandidates = deriveTopicKeyCandidatesV1(normalizedInput, receivedAt).slice(0, 3);
  const primaryCandidate = deterministicCandidates[0] ?? null;
  const secondaryCandidate = deterministicCandidates[1] ?? null;
  const explicitReturn = resolveExplicitReturnThread(stack, normalizedInput);
  const hasReturnSignal = RETURN_SIGNAL_PATTERN.test(normalizedInput);
  const ambiguousReturnSelection =
    explicitReturn === "AMBIGUOUS" ||
    (hasReturnSignal && explicitReturn === null && activeThread !== null);
  const ambiguousTopicSelection = hasAmbiguousTopicSelection(primaryCandidate, secondaryCandidate);
  if (!ambiguousReturnSelection && !ambiguousTopicSelection) {
    return null;
  }

  const interpretedSignal = await routeTopicKeyInterpretationModel(
    {
      userInput: normalizedInput,
      routingClassification,
      sessionHints: buildLocalIntentSessionHints(session),
      recentTurns: session.conversationTurns
        .slice(-MAX_TOPIC_KEY_INTERPRETATION_RECENT_TURNS)
        .map((turn) => ({
          role: turn.role,
          text: turn.text
        })),
      activeThread: activeThread
        ? {
            threadKey: activeThread.threadKey,
            topicKey: activeThread.topicKey,
            topicLabel: activeThread.topicLabel,
            resumeHint: activeThread.resumeHint,
            state: "active"
          }
        : null,
      pausedThreads: pausedThreads.map((thread) => ({
        threadKey: thread.threadKey,
        topicKey: thread.topicKey,
        topicLabel: thread.topicLabel,
        resumeHint: thread.resumeHint,
        state: "paused" as const
      })),
      deterministicCandidates: deterministicCandidates.map((candidate) => ({
        topicKey: candidate.topicKey,
        label: candidate.label,
        confidence: candidate.confidence
      }))
    },
    topicKeyInterpretationResolver
  );
  if (
    !interpretedSignal ||
    interpretedSignal.confidence === "low" ||
    interpretedSignal.kind === "non_topic_turn" ||
    interpretedSignal.kind === "uncertain"
  ) {
    return null;
  }

  return {
    kind: interpretedSignal.kind,
    selectedTopicKey: interpretedSignal.selectedTopicKey,
    selectedThreadKey: interpretedSignal.selectedThreadKey,
    confidence: interpretedSignal.confidence
  };
}
