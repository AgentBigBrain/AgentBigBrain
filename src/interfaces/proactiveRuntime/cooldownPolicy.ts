/**
 * @fileoverview Cooldown policy helpers for bounded proactive follow-up.
 */

import type { ConversationSession } from "../sessionStore";
import type { ContextualTopicCooldownHistoryRecord } from "./contracts";

export const PULSE_MINIMUM_GAP_MS = 12 * 60 * 60 * 1_000;
export const CONTEXTUAL_FOLLOWUP_TOPIC_COOLDOWN_MS = 6 * 60 * 60 * 1_000;

/**
 * Returns true when the last pulse was sent too recently to interrupt again.
 *
 * @param lastPulseSentAtIso - Timestamp of the last sent pulse.
 * @param nowMs - Current timestamp in milliseconds.
 * @returns `true` when the human-scale minimum gap has not elapsed.
 */
export function shouldSuppressForPulseGap(
  lastPulseSentAtIso: string | null | undefined,
  nowMs = Date.now()
): boolean {
  const lastSentMs = Date.parse(lastPulseSentAtIso ?? "");
  return Number.isFinite(lastSentMs) && nowMs - lastSentMs < PULSE_MINIMUM_GAP_MS;
}

/**
 * Extracts one derived contextual topic key from a prior proactive prompt.
 *
 * @param input - Prompt input previously queued or delivered.
 * @returns Topic key when the prompt belongs to contextual follow-up, else `null`.
 */
export function extractContextualTopicKeyFromPulseInput(input: string): string | null {
  const reasonMatch = input.match(/^\s*Reason code:\s*([a-z_]+)/im);
  if (!reasonMatch || reasonMatch[1].trim().toLowerCase() !== "contextual_followup") {
    return null;
  }
  const topicKeyMatch = input.match(/^\s*Contextual topic key(?:\s+\(derived\))?:\s*([a-z0-9_]+)/im);
  if (!topicKeyMatch) {
    return null;
  }
  return topicKeyMatch[1].trim().toLowerCase();
}

/**
 * Resolves whether a contextual follow-up topic is still under cooldown.
 *
 * @param history - Prior queued/recent job records to inspect.
 * @param topicKey - Derived contextual topic key.
 * @param nowMs - Current timestamp in milliseconds.
 * @returns Next eligible ISO timestamp, or `null` when no cooldown applies.
 */
export function resolveContextualTopicCooldown(
  history: readonly ContextualTopicCooldownHistoryRecord[],
  topicKey: string,
  nowMs: number
): string | null {
  let latestTopicPulseMs: number | null = null;
  for (const record of history) {
    const matchedTopicKey = extractContextualTopicKeyFromPulseInput(record.input);
    if (matchedTopicKey !== topicKey) {
      continue;
    }
    const atIso = record.completedAt ?? record.createdAt;
    const atMs = Date.parse(atIso);
    if (!Number.isFinite(atMs)) {
      continue;
    }
    if (latestTopicPulseMs === null || atMs > latestTopicPulseMs) {
      latestTopicPulseMs = atMs;
    }
  }

  if (latestTopicPulseMs === null) {
    return null;
  }
  if (nowMs - latestTopicPulseMs >= CONTEXTUAL_FOLLOWUP_TOPIC_COOLDOWN_MS) {
    return null;
  }
  return new Date(latestTopicPulseMs + CONTEXTUAL_FOLLOWUP_TOPIC_COOLDOWN_MS).toISOString();
}

/**
 * Builds the contextual topic cooldown history from a session's job ledgers.
 *
 * @param session - Session whose prior queued/recent jobs should be inspected.
 * @returns Stable cooldown-history records.
 */
export function buildContextualTopicCooldownHistory(
  session: ConversationSession
): readonly ContextualTopicCooldownHistoryRecord[] {
  return [...session.queuedJobs, ...session.recentJobs].map((job) => ({
    input: job.input,
    createdAt: job.createdAt,
    completedAt: job.completedAt
  }));
}
