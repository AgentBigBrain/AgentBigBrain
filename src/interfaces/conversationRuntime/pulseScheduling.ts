/**
 * @fileoverview Canonical session-selection and tick-scheduling helpers for Agent Pulse.
 */

import type { ConversationSession } from "../sessionStore";

const PULSE_MINIMUM_GAP_MS = 60_000;

/**
 * Returns true when a conversation key belongs to the active provider namespace.
 */
export function conversationBelongsToProvider(
  conversationKey: string,
  provider: "telegram" | "discord"
): boolean {
  return conversationKey.startsWith(`${provider}:`);
}

/**
 * Returns true when a session should be skipped for pulse evaluation.
 */
export function shouldSkipSessionForPulse(session: ConversationSession): boolean {
  if (!session.agentPulse.optIn) {
    return true;
  }
  if (Boolean(session.runningJobId) || session.queuedJobs.length > 0) {
    return true;
  }
  const lastSentMs = Date.parse(session.agentPulse.lastPulseSentAt ?? "");
  if (Number.isFinite(lastSentMs) && Date.now() - lastSentMs < PULSE_MINIMUM_GAP_MS) {
    return true;
  }
  return false;
}

/**
 * Sorts sessions from most recently updated to least recently updated.
 */
export function sortByMostRecentSessionUpdate(sessions: ConversationSession[]): ConversationSession[] {
  return [...sessions].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  );
}

/**
 * Resolves the concrete session that should receive a pulse for the controller session.
 */
export function selectPulseTargetSession(
  controllerSession: ConversationSession,
  userSessions: ConversationSession[]
): { targetSession: ConversationSession | null; suppressionCode: ConversationSession["agentPulse"]["lastDecisionCode"] | null } {
  if (controllerSession.agentPulse.mode === "private") {
    const privateSessions = sortByMostRecentSessionUpdate(
      userSessions.filter((candidate) => candidate.conversationVisibility === "private")
    );
    if (privateSessions.length === 0) {
      return {
        targetSession: null,
        suppressionCode: "NO_PRIVATE_ROUTE"
      };
    }
    return {
      targetSession: privateSessions[0],
      suppressionCode: null
    };
  }

  const currentSession = userSessions.find(
    (candidate) => candidate.conversationId === controllerSession.conversationId
  );
  return {
    targetSession: currentSession ?? controllerSession,
    suppressionCode: null
  };
}
