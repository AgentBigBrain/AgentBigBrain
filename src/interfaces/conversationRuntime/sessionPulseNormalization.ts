/**
 * @fileoverview Stable Agent Pulse normalization helpers for persisted interface session state.
 */

import {
  createDefaultAgentPulseState,
  normalizeAgentPulseContextualLexicalEvidence,
  normalizeRecentEmissions
} from "./sessionPulseMetadata";
import type {
  AgentPulseDecisionCode,
  AgentPulseMode,
  AgentPulseRouteStrategy,
  AgentPulseSessionState
} from "./sessionStateContracts";

/**
 * Normalizes persisted Agent Pulse session metadata into the stable runtime shape.
 */
export function normalizeAgentPulseSessionState(candidate: unknown): AgentPulseSessionState {
  const normalizedAgentPulseRaw =
    candidate && typeof candidate === "object" ? (candidate as Partial<AgentPulseSessionState>) : {};
  const defaultPulse = createDefaultAgentPulseState();
  const modeCandidate =
    typeof normalizedAgentPulseRaw.mode === "string"
      ? (normalizedAgentPulseRaw.mode as AgentPulseMode)
      : defaultPulse.mode;
  const routeStrategyCandidate =
    typeof normalizedAgentPulseRaw.routeStrategy === "string"
      ? (normalizedAgentPulseRaw.routeStrategy as AgentPulseRouteStrategy)
      : defaultPulse.routeStrategy;
  const lastDecisionCandidate =
    typeof normalizedAgentPulseRaw.lastDecisionCode === "string"
      ? (normalizedAgentPulseRaw.lastDecisionCode as AgentPulseDecisionCode)
      : defaultPulse.lastDecisionCode;

  return {
    optIn: typeof normalizedAgentPulseRaw.optIn === "boolean" ? normalizedAgentPulseRaw.optIn : defaultPulse.optIn,
    mode:
      modeCandidate === "private" || modeCandidate === "public" ? modeCandidate : defaultPulse.mode,
    routeStrategy:
      routeStrategyCandidate === "last_private_used" || routeStrategyCandidate === "current_conversation"
        ? routeStrategyCandidate
        : defaultPulse.routeStrategy,
    lastPulseSentAt: typeof normalizedAgentPulseRaw.lastPulseSentAt === "string" ? normalizedAgentPulseRaw.lastPulseSentAt : null,
    lastPulseReason: typeof normalizedAgentPulseRaw.lastPulseReason === "string" ? normalizedAgentPulseRaw.lastPulseReason : null,
    lastPulseTargetConversationId:
      typeof normalizedAgentPulseRaw.lastPulseTargetConversationId === "string"
        ? normalizedAgentPulseRaw.lastPulseTargetConversationId
        : null,
    lastDecisionCode:
      lastDecisionCandidate === "ALLOWED" ||
      lastDecisionCandidate === "DISABLED" ||
      lastDecisionCandidate === "OPT_OUT" ||
      lastDecisionCandidate === "NO_PRIVATE_ROUTE" ||
      lastDecisionCandidate === "NO_STALE_FACTS" ||
      lastDecisionCandidate === "NO_UNRESOLVED_COMMITMENTS" ||
      lastDecisionCandidate === "NO_CONTEXTUAL_LINKAGE" ||
      lastDecisionCandidate === "RELATIONSHIP_ROLE_SUPPRESSED" ||
      lastDecisionCandidate === "CONTEXT_DRIFT_SUPPRESSED" ||
      lastDecisionCandidate === "CONTEXTUAL_TOPIC_COOLDOWN" ||
      lastDecisionCandidate === "SESSION_DOMAIN_SUPPRESSED" ||
      lastDecisionCandidate === "QUIET_HOURS" ||
      lastDecisionCandidate === "RATE_LIMIT" ||
      lastDecisionCandidate === "NOT_EVALUATED" ||
      lastDecisionCandidate === "DYNAMIC_SENT" ||
      lastDecisionCandidate === "DYNAMIC_SUPPRESSED"
        ? lastDecisionCandidate
        : defaultPulse.lastDecisionCode,
    lastEvaluatedAt:
      typeof normalizedAgentPulseRaw.lastEvaluatedAt === "string"
        ? normalizedAgentPulseRaw.lastEvaluatedAt
        : null,
    lastContextualLexicalEvidence: normalizeAgentPulseContextualLexicalEvidence(
      normalizedAgentPulseRaw.lastContextualLexicalEvidence
    ),
    recentEmissions: normalizeRecentEmissions(normalizedAgentPulseRaw.recentEmissions),
    userStyleFingerprint:
      typeof normalizedAgentPulseRaw.userStyleFingerprint === "string"
        ? normalizedAgentPulseRaw.userStyleFingerprint
        : undefined,
    userTimezone:
      typeof normalizedAgentPulseRaw.userTimezone === "string"
        ? normalizedAgentPulseRaw.userTimezone
        : undefined
  };
}
