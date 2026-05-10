/**
 * @fileoverview Selection helpers for Agent Pulse scheduler session groups.
 */

import type { ConversationSession } from "./sessionStore";

/**
 * Selects the newest session that changed user-global pulse controls.
 */
export function selectLatestPulseControlSession(
  sessions: readonly ConversationSession[]
): ConversationSession | null {
  let selected: ConversationSession | null = null;
  let selectedMs = Number.NEGATIVE_INFINITY;
  for (const session of sessions) {
    const controlAt = session.agentPulse.controlUpdatedAt;
    if (!controlAt) {
      continue;
    }
    const parsed = Date.parse(controlAt);
    if (Number.isFinite(parsed) && parsed > selectedMs) {
      selected = session;
      selectedMs = parsed;
    }
  }
  return selected;
}
