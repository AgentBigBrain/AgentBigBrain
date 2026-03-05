/**
 * @fileoverview Builds conversation-aware execution payloads and follow-up envelopes for conversation manager flows.
 */

import type { ConversationSession } from "./sessionStore";
import {
  buildRoutingExecutionHintV1,
  type RoutingMapClassificationV1
} from "./routingMap";
import {
  classifyFollowUp,
  isLikelyAssistantClarificationPrompt,
  type FollowUpClassification,
  type FollowUpRuleContext,
  normalizeWhitespace,
  renderTurnsForContext
} from "./conversationManagerHelpers";

const FIRST_PERSON_STATUS_UPDATE_PATTERN =
  /\bmy\s+[a-z0-9][a-z0-9_.\-/\s]{0,120}\s+is\s+[a-z0-9][^.!?\n]{0,120}/i;
const STATUS_UPDATE_VALUE_MARKER_PATTERN =
  /\b(?:pending|open|stuck|unresolved|incomplete|complete|completed|done|resolved)\b/i;

export interface FollowUpResolution {
  executionInput: string;
  classification: FollowUpClassification;
}

/**
 * Builds a prompt guardrail block when the user gives first-person status updates.
 *
 * @param userInput - Current raw user message.
 * @returns Instruction block appended to execution input, or `null` when no status update is detected.
 */
export function buildTurnLocalStatusUpdateBlock(userInput: string): string | null {
  const normalizedInput = normalizeWhitespace(userInput);
  if (!normalizedInput) {
    return null;
  }
  if (!FIRST_PERSON_STATUS_UPDATE_PATTERN.test(normalizedInput)) {
    return null;
  }
  if (!STATUS_UPDATE_VALUE_MARKER_PATTERN.test(normalizedInput)) {
    return null;
  }

  return [
    "Turn-local status update (authoritative for this turn):",
    `- User stated: ${normalizedInput}`,
    "- Response rule: acknowledge this latest status and do not assert an older contradictory status as fact."
  ].join("\n");
}

/**
 * Wraps user input with recent turn context and deterministic routing hints when context exists.
 *
 * @param session - Conversation session containing recent turns.
 * @param userInput - Current request payload to send to execution.
 * @param maxContextTurnsForExecution - Maximum number of recent turns to include.
 * @param routingClassification - Optional routing-map classification for deterministic hinting.
 * @returns Execution payload passed to the task runner.
 */
export function buildConversationAwareExecutionInput(
  session: ConversationSession,
  userInput: string,
  maxContextTurnsForExecution: number,
  routingClassification: RoutingMapClassificationV1 | null = null
): string {
  const recentTurns = session.conversationTurns.slice(-maxContextTurnsForExecution);
  const statusUpdateBlock = buildTurnLocalStatusUpdateBlock(userInput);
  const routingHint = routingClassification
    ? buildRoutingExecutionHintV1(routingClassification)
    : null;
  if (recentTurns.length === 0 && !statusUpdateBlock && !routingHint) {
    return userInput;
  }

  const lines: string[] = [
    "You are in an ongoing conversation with the same user.",
    "Use recent context to resolve references like 'another', 'same style', and 'as before'.",
    "Treat short confirmations or formatting replies as answers to the most recent assistant question when context indicates that linkage.",
    "Do not claim side effects were completed unless execution evidence in this run confirms it.",
    "For policy or block-reason questions, provide concrete typed reasons and avoid generic speculative explanations.",
    "Do not end with placeholder progress language (for example: 'I will ... shortly' or 'please hold on'). Return the final answer for this run.",
    "If the user gives a first-person status update (for example: 'my ... is ...'), treat that update as the newest fact for this turn and do not contradict it with older memory unless you ask a clarifying question.",
    "Only use facts from the context and current message."
  ];

  if (recentTurns.length > 0) {
    lines.push(
      "",
      "Recent conversation context (oldest to newest):",
      renderTurnsForContext(recentTurns)
    );
  }

  if (statusUpdateBlock) {
    lines.push("", statusUpdateBlock);
  }
  if (routingHint) {
    lines.push("", "Deterministic routing hint:", routingHint);
  }

  lines.push("", "Current user request:", userInput);
  return lines.join("\n");
}

/**
 * Resolves whether input should be handled as standalone text or a short follow-up answer.
 *
 * @param session - Session state containing recent assistant/user turns.
 * @param userInput - Current user text to classify.
 * @param followUpRuleContext - Loaded follow-up rulepack context.
 * @returns Follow-up classification metadata plus the execution payload to send downstream.
 */
export function resolveFollowUpInput(
  session: ConversationSession,
  userInput: string,
  followUpRuleContext: FollowUpRuleContext
): FollowUpResolution {
  const lastAssistantPrompt = [...session.conversationTurns]
    .reverse()
    .find(
      (turn) =>
        turn.role === "assistant" &&
        isLikelyAssistantClarificationPrompt(turn.text)
    );
  const classification = classifyFollowUp(userInput, {
    hasPriorAssistantQuestion: Boolean(lastAssistantPrompt),
    ruleContext: followUpRuleContext
  });

  if (!classification.isShortFollowUp) {
    return {
      executionInput: userInput,
      classification
    };
  }

  if (!lastAssistantPrompt) {
    return {
      executionInput: userInput,
      classification
    };
  }

  return {
    executionInput: [
      "Follow-up user response to prior assistant clarification.",
      `Follow-up classifier: ${classification.matchedRuleId}`,
      `Follow-up rulepack: ${classification.rulepackVersion}`,
      `Follow-up category: ${classification.category}`,
      `Follow-up confidence: ${classification.confidenceTier}`,
      `Previous assistant question: ${lastAssistantPrompt.text}`,
      `User follow-up answer: ${normalizeWhitespace(userInput)}`
    ].join("\n"),
    classification
  };
}

/**
 * Builds the governed execution payload for a system-generated Agent Pulse job.
 *
 * @param session - Session providing recent turn context.
 * @param systemPrompt - Pulse prompt/body generated by scheduler logic.
 * @param maxContextTurnsForExecution - Maximum number of prior turns included in the context block.
 * @returns Fully assembled execution input sent to the queue worker.
 */
export function buildAgentPulseExecutionInput(
  session: ConversationSession,
  systemPrompt: string,
  maxContextTurnsForExecution: number
): string {
  const recentTurns = session.conversationTurns.slice(-maxContextTurnsForExecution);
  const contextBlock =
    recentTurns.length > 0
      ? [
        "",
        "Recent conversation context (oldest to newest):",
        renderTurnsForContext(recentTurns)
      ].join("\n")
      : "";

  return [
    "System-generated Agent Pulse check-in request.",
    "Return one concise proactive check-in message as an explicit AI assistant identity.",
    "Do not impersonate a human.",
    "Do not perform file/network/shell actions unless explicitly required.",
    "",
    "Agent Pulse request:",
    systemPrompt,
    contextBlock
  ].join("\n");
}
