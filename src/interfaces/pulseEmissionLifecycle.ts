/**
 * @fileoverview Maintains deterministic lifecycle annotations for recent Agent Pulse emissions in interface sessions.
 */

import {
  ConversationJob,
  ConversationSession
} from "./sessionStore";

const PULSE_RESPONSE_WINDOW_MS = 30 * 60 * 1000;
const MAX_SNIPPET_LENGTH = 120;
const DISMISSAL_KEYWORDS = /\b(stop|not now|don't ask|shut up|quit|enough|no more)\b/i;

/**
 * Backfills response outcome on the latest pulse emission after a user reply.
 *
 * **Why it exists:**
 * Keeps response-outcome annotations (`engaged|dismissed|ignored`) deterministic for pulse evidence trails.
 *
 * **What it talks to:**
 * - Mutates in-memory `ConversationSession.agentPulse.recentEmissions` records.
 * - Uses local response-window and dismissal-keyword policy constants.
 *
 * @param session - Session state whose latest pulse emission may be updated.
 * @param userText - Incoming user text used for dismissal/engagement detection.
 * @param nowMs - Current timestamp in milliseconds for deterministic age checks.
 */
export function backfillPulseResponseOutcome(
  session: ConversationSession,
  userText: string,
  nowMs: number
): void {
  const emissions = session.agentPulse.recentEmissions;
  if (!emissions || emissions.length === 0) return;

  const latest = emissions[emissions.length - 1];
  if (latest.responseOutcome !== undefined && latest.responseOutcome !== null) return;

  const emittedMs = Date.parse(latest.emittedAt);
  if (!Number.isFinite(emittedMs)) return;

  if (nowMs - emittedMs > PULSE_RESPONSE_WINDOW_MS) {
    latest.responseOutcome = "ignored";
    return;
  }

  if (DISMISSAL_KEYWORDS.test(userText)) {
    latest.responseOutcome = "dismissed";
    return;
  }

  latest.responseOutcome = "engaged";
}

/**
 * Expires unresolved pulse emissions to `ignored` when response window is exceeded.
 *
 * **Why it exists:**
 * Prevents stale unresolved pulse emissions from remaining unclassified indefinitely.
 *
 * **What it talks to:**
 * - Mutates `ConversationSession.agentPulse.recentEmissions` in place.
 * - Uses local response-window policy constant.
 *
 * @param session - Session state whose pulse emissions should be age-checked.
 * @param nowMs - Current timestamp in milliseconds for deterministic age checks.
 */
export function expireStaleEmissions(
  session: ConversationSession,
  nowMs: number
): void {
  const emissions = session.agentPulse.recentEmissions;
  if (!emissions) return;

  for (const emission of emissions) {
    if (emission.responseOutcome !== undefined && emission.responseOutcome !== null) continue;
    const emittedMs = Date.parse(emission.emittedAt);
    if (!Number.isFinite(emittedMs)) continue;
    if (nowMs - emittedMs > PULSE_RESPONSE_WINDOW_MS) {
      emission.responseOutcome = "ignored";
    }
  }
}

/**
 * Backfills generated snippet on the latest pulse emission from completed pulse job output.
 *
 * **Why it exists:**
 * Keeps pulse-emission evidence tied to the final user-facing completion summary when available.
 *
 * **What it talks to:**
 * - Reads `ConversationJob` completion fields.
 * - Mutates latest `ConversationSession.agentPulse.recentEmissions` entry.
 *
 * @param session - Session state whose latest pulse emission may receive snippet output.
 * @param completedJob - Completed job used as snippet source when pulse-triggered and successful.
 */
export function backfillPulseSnippet(
  session: ConversationSession,
  completedJob: ConversationJob
): void {
  const emissions = session.agentPulse.recentEmissions;
  if (!emissions || emissions.length === 0) return;

  const latest = emissions[emissions.length - 1];
  if (latest.generatedSnippet && latest.generatedSnippet.length > 0) return;

  if (completedJob.resultSummary) {
    latest.generatedSnippet = completedJob.resultSummary.slice(0, MAX_SNIPPET_LENGTH);
  }
}
