/**
 * @fileoverview Canonical routing and delivery-selection helpers for proactive follow-up.
 */

import type { AgentPulseReason } from "../../core/agentPulse";
import type { ConversationSession } from "../sessionStore";
import type { ProactiveTargetSelection } from "./contracts";
import { shouldSuppressForPulseGap } from "./cooldownPolicy";

/**
 * Returns true when a conversation key belongs to the active provider namespace.
 *
 * @param conversationKey - Stored conversation key.
 * @param provider - Active interface provider.
 * @returns `true` when the key belongs to the provider namespace.
 */
export function conversationBelongsToProvider(
  conversationKey: string,
  provider: "telegram" | "discord"
): boolean {
  return conversationKey.startsWith(`${provider}:`);
}

/**
 * Returns true when a session should be skipped for proactive evaluation.
 *
 * @param session - Session under evaluation.
 * @returns `true` when proactive work should be skipped.
 */
export function shouldSkipSessionForPulse(session: ConversationSession): boolean {
  if (!session.agentPulse.optIn) {
    return true;
  }
  if (Boolean(session.runningJobId) || session.queuedJobs.length > 0) {
    return true;
  }
  if (shouldSuppressForPulseGap(session.agentPulse.lastPulseSentAt)) {
    return true;
  }
  return false;
}

/**
 * Returns whether workflow-dominant active continuity should suppress a pulse reason.
 *
 * Explicit user-requested follow-ups and unresolved commitments still remain eligible.
 */
export function shouldSuppressPulseForSessionDomain(
  session: ConversationSession,
  reason: AgentPulseReason | "dynamic"
): boolean {
  if (session.domainContext.dominantLane !== "workflow") {
    return false;
  }

  const continuity = session.domainContext.continuitySignals;
  const hasActiveWorkflowContinuity =
    continuity.activeWorkspace || continuity.returnHandoff || continuity.modeContinuity;
  if (!hasActiveWorkflowContinuity) {
    return false;
  }

  return !(
    reason === "unresolved_commitment" ||
    reason === "user_requested_followup"
  );
}

/**
 * Sorts sessions from most recently updated to least recently updated.
 *
 * @param sessions - Sessions to sort.
 * @returns New array sorted by most recent update first.
 */
export function sortByMostRecentSessionUpdate(
  sessions: ConversationSession[]
): ConversationSession[] {
  return [...sessions].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  );
}

/**
 * Resolves the concrete session that should receive a proactive follow-up.
 *
 * @param controllerSession - Session whose opt-in/mode controls routing.
 * @param userSessions - All sessions for the same user.
 * @returns Concrete target session plus any suppression code.
 */
export function selectPulseTargetSession(
  controllerSession: ConversationSession,
  userSessions: ConversationSession[]
): ProactiveTargetSelection {
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
