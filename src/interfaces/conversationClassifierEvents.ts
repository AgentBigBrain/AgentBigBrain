/**
 * @fileoverview Persists deterministic classifier telemetry events for follow-up/proposal and pulse-lexical flows.
 */

import {
  ConversationClassifierEvent,
  ConversationSession
} from "./sessionStore";
import {
  normalizeTurnText,
  type FollowUpClassification,
  type ProposalReplyClassification,
  type PulseLexicalClassification
} from "./conversationManagerHelpers";

const DEFAULT_MAX_CLASSIFIER_EVENTS = 120;

/**
 * Decides whether a follow-up or proposal-reply classification is worth persisting.
 *
 * **Why it exists:**
 * Persisting every follow-up classification adds noise. This gate keeps history focused on
 * short-reply decisions and explicit proposal intents that matter for audit/debug.
 *
 * **What it talks to:**
 * - Reads classifier fields from follow-up and proposal-reply outputs.
 *
 * @param classification - Follow-up/proposal classifier result.
 * @returns `true` when this classifier event should be recorded.
 */
export function shouldPersistClassifierEvent(
  classification: FollowUpClassification | ProposalReplyClassification
): boolean {
  if ("intent" in classification) {
    return true;
  }
  return classification.isShortFollowUp;
}

/**
 * Appends one normalized follow-up/proposal classifier event with bounded retention.
 *
 * **Why it exists:**
 * Session-level classifier telemetry should be consistent and capped so it remains useful for
 * troubleshooting without unbounded growth.
 *
 * **What it talks to:**
 * - Calls `shouldPersistClassifierEvent`.
 * - Calls `normalizeTurnText`.
 * - Mutates `session.classifierEvents`.
 *
 * @param session - Session receiving classifier telemetry.
 * @param input - Raw user input that was classified.
 * @param at - Event timestamp.
 * @param classification - Follow-up or proposal-reply classification output.
 * @param maxClassifierEvents - Maximum retained classifier events.
 */
export function recordClassifierEvent(
  session: ConversationSession,
  input: string,
  at: string,
  classification: FollowUpClassification | ProposalReplyClassification,
  maxClassifierEvents: number = DEFAULT_MAX_CLASSIFIER_EVENTS
): void {
  if (!shouldPersistClassifierEvent(classification)) {
    return;
  }

  const event: ConversationClassifierEvent = {
    classifier: "intent" in classification ? "proposal_reply" : "follow_up",
    input: normalizeTurnText(input),
    at,
    isShortFollowUp: classification.isShortFollowUp,
    category: classification.category,
    confidenceTier: classification.confidenceTier,
    matchedRuleId: classification.matchedRuleId,
    rulepackVersion: classification.rulepackVersion,
    intent: "intent" in classification ? classification.intent : null
  };

  session.classifierEvents = [...(session.classifierEvents ?? []), event].slice(-maxClassifierEvents);
}

/**
 * Decides whether a pulse-lexical classification should be persisted.
 *
 * **Why it exists:**
 * `NON_COMMAND` noise is usually not useful. Persisting command/conflict outputs keeps telemetry
 * concise while preserving evidence for pulse-control decisions.
 *
 * **What it talks to:**
 * - Reads pulse lexical category/conflict fields.
 *
 * @param classification - Pulse lexical classifier output.
 * @returns `true` when this event should be recorded.
 */
export function shouldPersistPulseLexicalClassifierEvent(
  classification: PulseLexicalClassification
): boolean {
  return classification.category !== "NON_COMMAND" || classification.conflict;
}

/**
 * Appends one normalized pulse-lexical classifier event with bounded retention.
 *
 * **Why it exists:**
 * Pulse command/conflict behavior should be explainable after the fact using durable event history.
 *
 * **What it talks to:**
 * - Calls `shouldPersistPulseLexicalClassifierEvent`.
 * - Calls `normalizeTurnText`.
 * - Mutates `session.classifierEvents`.
 *
 * @param session - Session receiving classifier telemetry.
 * @param input - Raw user input evaluated by pulse lexical classifier.
 * @param at - Event timestamp.
 * @param classification - Pulse lexical classifier output.
 * @param maxClassifierEvents - Maximum retained classifier events.
 */
export function recordPulseLexicalClassifierEvent(
  session: ConversationSession,
  input: string,
  at: string,
  classification: PulseLexicalClassification,
  maxClassifierEvents: number = DEFAULT_MAX_CLASSIFIER_EVENTS
): void {
  if (!shouldPersistPulseLexicalClassifierEvent(classification)) {
    return;
  }

  const event: ConversationClassifierEvent = {
    classifier: "pulse_lexical",
    input: normalizeTurnText(input),
    at,
    isShortFollowUp: false,
    category: classification.category,
    confidenceTier: classification.confidenceTier,
    matchedRuleId: classification.matchedRuleId,
    rulepackVersion: classification.rulepackVersion,
    intent: classification.commandIntent,
    conflict: classification.conflict
  };

  session.classifierEvents = [...(session.classifierEvents ?? []), event].slice(-maxClassifierEvents);
}
