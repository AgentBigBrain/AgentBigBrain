/**
 * @fileoverview Derives bounded recent-assistant turn context so conversational answer threads do
 * not get hijacked by stale workflow continuity.
 */

import { isLikelyAssistantClarificationPrompt } from "../conversationManagerHelpers";
import type { ConversationSession } from "../sessionStore";
import {
  analyzeConversationChatTurnSignals,
  isLikelyAssistantIdentityAnswer,
  isRelationshipConversationRecallTurn
} from "./chatTurnSignals";
import { collectConversationChatTurnRawTokens } from "./chatTurnSignalAnalysis";

export type RecentAssistantTurnKind =
  | "clarification"
  | "informational_answer"
  | "workflow_progress"
  | "other";

export interface RecentAssistantTurnContext {
  recentAssistantTurnKind: RecentAssistantTurnKind | null;
  recentAssistantAnswerThreadActive: boolean;
}

const ASSISTANT_WORKFLOW_PROGRESS_SEQUENCES: readonly (readonly string[])[] = [
  ["status"],
  ["autonomous", "task", "completed"],
  ["i'm", "taking", "this", "end", "to", "end", "now"],
  ["im", "taking", "this", "end", "to", "end", "now"],
  ["i'm", "picking", "that", "back", "up", "from", "the", "last", "checkpoint", "now"],
  ["im", "picking", "that", "back", "up", "from", "the", "last", "checkpoint", "now"],
  ["on", "it", "i'll", "start", "with"],
  ["on", "it", "ill", "start", "with"],
  ["finished", "this", "request"]
] as const;

/**
 * Returns whether one bounded token sequence appears contiguously inside the current token list.
 *
 * @param tokens - Normalized raw token sequence for one assistant turn.
 * @param sequence - Candidate ordered token sequence.
 * @returns `true` when every token appears contiguously in order.
 */
function hasTokenSequence(
  tokens: readonly string[],
  sequence: readonly string[]
): boolean {
  if (sequence.length === 0 || sequence.length > tokens.length) {
    return false;
  }
  for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (tokens[index + offset] !== sequence[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

/**
 * Finds the latest assistant turn plus its index inside the current session transcript.
 *
 * @param session - Current conversation session.
 * @returns Latest assistant turn with index, or `null` when none exists.
 */
function findLastAssistantTurnWithIndex(
  session: ConversationSession
): { index: number; turn: ConversationSession["conversationTurns"][number] } | null {
  for (let index = session.conversationTurns.length - 1; index >= 0; index -= 1) {
    const turn = session.conversationTurns[index];
    if (turn?.role === "assistant") {
      return { index, turn };
    }
  }
  return null;
}

/**
 * Finds the nearest user turn before one known assistant turn index.
 *
 * @param session - Current conversation session.
 * @param startIndex - Index of the assistant turn we are anchoring against.
 * @returns Nearest prior user turn, or `null` when none exists.
 */
function findNearestPriorUserTurn(
  session: ConversationSession,
  startIndex: number
): ConversationSession["conversationTurns"][number] | null {
  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const turn = session.conversationTurns[index];
    if (turn?.role === "user") {
      return turn;
    }
  }
  return null;
}

/**
 * Resolves structured assistant-turn metadata when the runtime stored it with the turn.
 *
 * @param turn - Latest assistant-authored session turn.
 * @returns Recent assistant-turn context, or `null` when no trusted metadata is present.
 */
function resolveAssistantTurnContextFromMetadata(
  turn: ConversationSession["conversationTurns"][number]
): RecentAssistantTurnContext | null {
  const metadata = turn.metadata;
  if (
    turn.role !== "assistant" ||
    !metadata ||
    metadata.assistantTurnKindSource !== "runtime_metadata" ||
    !metadata.assistantTurnKind
  ) {
    return null;
  }
  return {
    recentAssistantTurnKind: metadata.assistantTurnKind,
    recentAssistantAnswerThreadActive:
      metadata.assistantTurnKind === "informational_answer"
  };
}

/**
 * Returns whether one assistant turn is clearly workflow progress rather than an informational
 * answer.
 *
 * @param text - Latest assistant turn text.
 * @returns `true` when the turn looks like progress/status output.
 */
function isLikelyAssistantWorkflowProgressTurn(text: string): boolean {
  const tokens = collectConversationChatTurnRawTokens(text);
  if (
    ASSISTANT_WORKFLOW_PROGRESS_SEQUENCES.some((sequence) =>
      hasTokenSequence(tokens, sequence)
    )
  ) {
    return true;
  }
  const signals = analyzeConversationChatTurnSignals(text);
  return (
    signals.referencesArtifact ||
    signals.containsWorkflowCallbackCue ||
    (signals.containsWorkflowCue && signals.containsStatusCue) ||
    (signals.containsStatusCue &&
      (signals.containsWorkflowCue || signals.referencesArtifact))
  );
}

/**
 * Returns whether one assistant turn ends like a direct question.
 *
 * @param text - Latest assistant turn text.
 * @returns `true` when the turn ends with question punctuation.
 */
function isLikelyAssistantQuestionTurn(text: string): boolean {
  return /[?\u00bf]\s*$/.test(text.trim());
}

/**
 * Returns the latest assistant-turn context needed to keep short conversational follow-ups attached
 * to an informational answer instead of stale workflow continuity.
 *
 * @param session - Current conversation session.
 * @returns Recent assistant-turn context for routing and local-intent hints.
 */
export function buildRecentAssistantTurnContext(
  session: ConversationSession
): RecentAssistantTurnContext {
  const lastAssistant = findLastAssistantTurnWithIndex(session);
  if (!lastAssistant) {
    return {
      recentAssistantTurnKind: null,
      recentAssistantAnswerThreadActive: false
    };
  }

  const assistantText = lastAssistant.turn.text;
  const metadataContext = resolveAssistantTurnContextFromMetadata(lastAssistant.turn);
  if (metadataContext) {
    return metadataContext;
  }
  if (isLikelyAssistantClarificationPrompt(assistantText)) {
    return {
      recentAssistantTurnKind: "clarification",
      recentAssistantAnswerThreadActive: false
    };
  }
  if (isLikelyAssistantWorkflowProgressTurn(assistantText)) {
    return {
      recentAssistantTurnKind: "workflow_progress",
      recentAssistantAnswerThreadActive: false
    };
  }

  const previousUserTurn = findNearestPriorUserTurn(session, lastAssistant.index);
  if (!previousUserTurn) {
    return {
      recentAssistantTurnKind: "other",
      recentAssistantAnswerThreadActive: false
    };
  }

  const previousUserSignals = analyzeConversationChatTurnSignals(previousUserTurn.text);
  const previousUserAskedForInformation =
    previousUserSignals.primaryKind !== "status_or_recall" &&
    (previousUserSignals.questionLike ||
      previousUserSignals.primaryKind === "assistant_identity_query" ||
      previousUserSignals.primaryKind === "self_identity_query" ||
      isRelationshipConversationRecallTurn(previousUserTurn.text));
  const assistantSignals = analyzeConversationChatTurnSignals(assistantText);
  const informationalAnswer =
    previousUserAskedForInformation &&
    !isLikelyAssistantQuestionTurn(assistantText) &&
    !assistantSignals.referencesArtifact &&
    !assistantSignals.containsWorkflowCue;

  if (informationalAnswer || isLikelyAssistantIdentityAnswer(assistantText)) {
    return {
      recentAssistantTurnKind: "informational_answer",
      recentAssistantAnswerThreadActive: true
    };
  }

  return {
    recentAssistantTurnKind: "other",
    recentAssistantAnswerThreadActive: false
  };
}

/**
 * Returns whether the current user turn should stay attached to the latest informational answer
 * thread instead of being promoted into workflow continuity.
 *
 * @param userInput - Raw current user wording.
 * @param context - Recent assistant-turn context for the current session.
 * @returns `true` when the turn is a short conversational continuation of the latest answer.
 */
export function isRecentAssistantAnswerThreadContinuationCandidate(
  userInput: string,
  context: RecentAssistantTurnContext
): boolean {
  if (
    context.recentAssistantAnswerThreadActive !== true ||
    context.recentAssistantTurnKind !== "informational_answer"
  ) {
    return false;
  }

  const signals = analyzeConversationChatTurnSignals(userInput);
  if (
    signals.primaryKind === "workflow_candidate" ||
    signals.primaryKind === "status_or_recall" ||
    signals.containsWorkflowCue ||
    signals.containsWorkflowCallbackCue ||
    signals.referencesArtifact
  ) {
    return false;
  }

  return (
    signals.lightweightConversation ||
    signals.primaryKind === "plain_chat" ||
    (signals.containsApprovalCue &&
      signals.rawTokenCount <= 4 &&
      !signals.containsStatusCue &&
      !signals.containsWorkflowCue &&
      !signals.referencesArtifact) ||
    isRelationshipConversationRecallTurn(userInput)
  );
}
