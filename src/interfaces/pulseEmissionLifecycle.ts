/**
 * @fileoverview Maintains deterministic lifecycle annotations for recent Agent Pulse emissions in interface sessions.
 */

import {
  ConversationJob,
  ConversationSession
} from "./sessionStore";
import { hashSha256 } from "../core/cryptoUtils";

const PULSE_RESPONSE_WINDOW_MS = 30 * 60 * 1000;
const MAX_SNIPPET_LENGTH = 120;
const MAX_DELIVERED_PREVIEW_LENGTH = 160;
const TOKEN_SHAPED_TEXT_PATTERN = /\b[A-Za-z0-9_./+-]{32,}\b/g;
const QUOTED_EVIDENCE_BLOCK_PATTERN = /```[\s\S]*?```/g;
const LOCAL_PATH_PATTERN = /\b[A-Za-z]:\\[^\s]+|\b\/(?:Users|home|tmp|var)\/[^\s]+/g;
const PRIVATE_CONTEXT_PATTERN =
  /\b(?:relationship|profile memory|source recall|identity memory|works? with|worked with|private project)\b/gi;
const DISMISSAL_KEYWORDS = /\b(stop|not now|don't ask|shut up|quit|enough|no more)\b/i;
const MUTED_KEYWORDS = /\b(?:mute|turn off|disable)\b[\s\S]{0,40}\b(?:pulse|check-?ins?)\b/i;
const NEGATIVE_KEYWORDS =
  /\b(?:not useful|not helpful|useless|bad question|wrong time|irrelevant|annoying)\b/i;

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
  nowMs: number,
  boundUserTurnId?: string
): void {
  if (/^\/pulse\b/i.test(userText.trim())) {
    return;
  }
  const emissions = session.agentPulse.recentEmissions;
  if (!emissions || emissions.length === 0) return;

  const latest = findLatestUnresolvedEmission(emissions) ?? emissions[emissions.length - 1];
  if (latest.responseOutcome !== undefined && latest.responseOutcome !== null) return;

  const emittedMs = Date.parse(latest.emittedAt);
  if (!Number.isFinite(emittedMs)) return;

  if (nowMs - emittedMs > PULSE_RESPONSE_WINDOW_MS) {
    latest.responseOutcome = "ignored";
    if (latest.outcomeRecord) {
      latest.outcomeRecord.responseOutcome = "ignored";
      latest.outcomeRecord.outcomeSource = "timeout";
    }
    return;
  }

  const replyBindingId = boundUserTurnId ?? buildPulseReplyBindingId(userText, nowMs);

  if (MUTED_KEYWORDS.test(userText)) {
    latest.responseOutcome = "muted";
    if (latest.outcomeRecord) {
      latest.outcomeRecord.responseOutcome = "muted";
      latest.outcomeRecord.outcomeSource = "explicit_user_reply";
      latest.outcomeRecord.boundUserTurnId = replyBindingId;
    }
    return;
  }

  if (DISMISSAL_KEYWORDS.test(userText)) {
    latest.responseOutcome = "dismissed";
    if (latest.outcomeRecord) {
      latest.outcomeRecord.responseOutcome = "dismissed";
      latest.outcomeRecord.outcomeSource = "legacy_keyword";
      latest.outcomeRecord.boundUserTurnId = replyBindingId;
    }
    return;
  }

  if (NEGATIVE_KEYWORDS.test(userText)) {
    latest.responseOutcome = "negative";
    if (latest.outcomeRecord) {
      latest.outcomeRecord.responseOutcome = "negative";
      latest.outcomeRecord.outcomeSource = "explicit_user_reply";
      latest.outcomeRecord.boundUserTurnId = replyBindingId;
    }
    return;
  }

  latest.responseOutcome = "engaged";
  if (latest.outcomeRecord) {
    latest.outcomeRecord.responseOutcome = "engaged";
    latest.outcomeRecord.outcomeSource = "explicit_user_reply";
    latest.outcomeRecord.boundUserTurnId = replyBindingId;
  }
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
      if (emission.outcomeRecord) {
        emission.outcomeRecord.responseOutcome = "ignored";
        emission.outcomeRecord.outcomeSource = "timeout";
      }
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

  const latest = completedJob.pulseMetadata?.pulseId
    ? emissions.find((emission) => emission.pulseId === completedJob.pulseMetadata?.pulseId)
    : emissions[emissions.length - 1];
  if (!latest) return;

  if (completedJob.resultSummary) {
    const deliveredPreview = buildPulseDeliveredTextPreview(completedJob.resultSummary);
    latest.generatedSnippet = deliveredPreview.slice(0, MAX_SNIPPET_LENGTH);
    if (latest.outcomeRecord) {
      latest.outcomeRecord.deliveredTextHash ??= hashSha256(completedJob.resultSummary);
      latest.outcomeRecord.deliveredTextPreviewRedacted ??= deliveredPreview;
    }
  }
}

/**
 * Builds a bounded redacted preview of delivered pulse text for outcome learning.
 *
 * **Why it exists:**
 * Outcome records need enough signal to avoid repeating awkward wording, but they must not become a
 * raw Source Recall or private-source storage lane.
 *
 * **What it talks to:**
 * - Uses local redaction and whitespace normalization only.
 *
 * @param deliveredText - Final user-facing pulse text.
 * @returns Bounded preview safe for pulse outcome metadata.
 */
export function buildPulseDeliveredTextPreview(deliveredText: string): string {
  const redacted = deliveredText
    .replace(QUOTED_EVIDENCE_BLOCK_PATTERN, "[quoted evidence redacted]")
    .replace(TOKEN_SHAPED_TEXT_PATTERN, "[redacted]")
    .replace(LOCAL_PATH_PATTERN, "[path redacted]")
    .replace(PRIVATE_CONTEXT_PATTERN, "[private context redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return redacted.slice(0, MAX_DELIVERED_PREVIEW_LENGTH);
}

/**
 * Builds a stable non-raw reply binding id for pulse outcome records.
 *
 * **Why it exists:**
 * Pulse outcome records need to bind a reply to a pulse without retaining the private reply text
 * as durable metadata.
 *
 * **What it talks to:**
 * - Uses `hashSha256` from `../core/cryptoUtils`.
 *
 * @param userText - Incoming user reply text used only for hashing.
 * @param nowMs - Deterministic received timestamp in milliseconds.
 * @returns Bounded synthetic reply binding id.
 */
function buildPulseReplyBindingId(userText: string, nowMs: number): string {
  return `pulse_reply_${hashSha256(`${nowMs}:${userText}`).slice(0, 16)}`;
}

/**
 * Finds the newest pulse emission that has not yet been bound to a user response outcome.
 */
function findLatestUnresolvedEmission(
  emissions: ConversationSession["agentPulse"]["recentEmissions"]
): NonNullable<ConversationSession["agentPulse"]["recentEmissions"]>[number] | null {
  if (!emissions) {
    return null;
  }
  for (let index = emissions.length - 1; index >= 0; index -= 1) {
    const emission = emissions[index];
    if (emission.outcomeRecord?.responseOutcome == null) {
      return emission;
    }
  }
  return null;
}
