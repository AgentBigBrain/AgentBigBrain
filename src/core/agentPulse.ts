/**
 * @fileoverview Deterministic Agent Pulse policy for opt-in proactive check-ins with quiet-hour and rate-limit controls.
 */

import type { ConversationDomainLane } from "./sessionContext";

export type AgentPulseReason =
  | "stale_fact_revalidation"
  | "unresolved_commitment"
  | "user_requested_followup"
  | "contextual_followup";

export interface AgentPulsePolicyConfig {
  enabled: boolean;
  timezoneOffsetMinutes: number;
  quietHoursStartHourLocal: number;
  quietHoursEndHourLocal: number;
  minIntervalMinutes: number;
}

export interface AgentPulseEvaluationInput {
  nowIso: string;
  userOptIn: boolean;
  reason: AgentPulseReason;
  staleFactCount: number;
  unresolvedCommitmentCount: number;
  contextualLinkageConfidence?: number;
  lastPulseSentAtIso: string | null;
  overrideQuietHours: boolean;
  sessionDominantLane?: ConversationDomainLane | null;
  sessionHasActiveWorkflowContinuity?: boolean;
  overrideSessionDomainSuppression?: boolean;
}

export interface AgentPulseDecision {
  allowed: boolean;
  decisionCode:
    | "ALLOWED"
    | "DISABLED"
    | "OPT_OUT"
    | "NO_STALE_FACTS"
    | "NO_UNRESOLVED_COMMITMENTS"
    | "NO_CONTEXTUAL_LINKAGE"
    | "RELATIONSHIP_ROLE_SUPPRESSED"
    | "CONTEXT_DRIFT_SUPPRESSED"
    | "CONTEXTUAL_TOPIC_COOLDOWN"
    | "SESSION_DOMAIN_SUPPRESSED"
    | "QUIET_HOURS"
    | "RATE_LIMIT";
  suppressedBy: string[];
  nextEligibleAtIso: string | null;
}

/**
 * Clamps any numeric hour into the inclusive local-hour range `[0, 23]`.
 *
 * **Why it exists:**
 * Pulse policy reads hour values from runtime config and must remain deterministic even when
 * values are malformed or out-of-range.
 *
 * **What it talks to:**
 * - Uses numeric guards (`Number.isFinite`, `Math.floor`).
 *
 * @param value - Candidate hour value from policy or computation.
 * @returns Safe hour value within local-day bounds.
 */
function clampHour(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const floored = Math.floor(value);
  if (floored < 0) {
    return 0;
  }
  if (floored > 23) {
    return 23;
  }
  return floored;
}

/**
 * Computes local hour for policy checks from UTC timestamp and explicit offset.
 *
 * **Why it exists:**
 * Quiet-hour suppression is timezone-aware and should not rely on host locale state.
 * This helper keeps conversion deterministic by using the configured offset.
 *
 * **What it talks to:**
 * - Uses JavaScript `Date` UTC APIs.
 *
 * @param nowMs - Current UTC timestamp in milliseconds.
 * @param timezoneOffsetMinutes - Local offset from UTC in minutes.
 * @returns Local hour in `[0, 23]`.
 */
function resolveLocalHour(nowMs: number, timezoneOffsetMinutes: number): number {
  const offsetMs = Math.floor(timezoneOffsetMinutes) * 60_000;
  const localNow = new Date(nowMs + offsetMs);
  return localNow.getUTCHours();
}

/**
 * Evaluates whether the current local hour falls inside configured quiet hours.
 *
 * **Why it exists:**
 * Agent Pulse must suppress proactive outreach during quiet windows, including overnight windows
 * that cross midnight.
 *
 * **What it talks to:**
 * - Calls `clampHour` to normalize configured start/end values.
 *
 * @param localHour - Current local hour.
 * @param quietHoursStartHourLocal - Quiet window start hour.
 * @param quietHoursEndHourLocal - Quiet window end hour.
 * @returns `true` when pulse should be suppressed for quiet-hours policy.
 */
function isInQuietHours(
  localHour: number,
  quietHoursStartHourLocal: number,
  quietHoursEndHourLocal: number
): boolean {
  const start = clampHour(quietHoursStartHourLocal);
  const end = clampHour(quietHoursEndHourLocal);

  if (start === end) {
    return false;
  }
  if (start < end) {
    return localHour >= start && localHour < end;
  }
  return localHour >= start || localHour < end;
}

/**
 * Parses an ISO timestamp and throws on invalid input.
 *
 * **Why it exists:**
 * Pulse decisions depend on strict timestamp arithmetic (quiet hours and rate limits).
 * Failing fast on invalid timestamps prevents silent drift in suppression logic.
 *
 * **What it talks to:**
 * - Uses `Date.parse`.
 *
 * @param value - ISO timestamp candidate.
 * @returns Parsed epoch milliseconds.
 * @throws Error when the timestamp is invalid.
 */
function parseIsoToMs(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ISO timestamp: ${value}`);
  }
  return parsed;
}

/**
 * Applies deterministic Agent Pulse gating rules for one pulse candidate.
 *
 * **Why it exists:**
 * This is the central policy evaluator that enforces opt-in, reason prerequisites, quiet-hours,
 * and min-interval suppression before any proactive message can be sent.
 *
 * **What it talks to:**
 * - Calls `parseIsoToMs` for strict timestamp parsing.
 * - Calls `resolveLocalHour` + `isInQuietHours` for local quiet-hour suppression.
 * - Uses policy inputs (`enabled`, `minIntervalMinutes`, reason-specific counters).
 *
 * @param policy - Runtime pulse policy configuration.
 * @param input - Candidate-specific runtime context.
 * @returns Structured allow/suppress decision with code and next eligible time when rate-limited.
 */
export function evaluateAgentPulsePolicy(
  policy: AgentPulsePolicyConfig,
  input: AgentPulseEvaluationInput
): AgentPulseDecision {
  if (!policy.enabled) {
    return {
      allowed: false,
      decisionCode: "DISABLED",
      suppressedBy: ["policy.disabled"],
      nextEligibleAtIso: null
    };
  }

  if (!input.userOptIn) {
    return {
      allowed: false,
      decisionCode: "OPT_OUT",
      suppressedBy: ["user.opt_out"],
      nextEligibleAtIso: null
    };
  }

  if (input.reason === "stale_fact_revalidation" && input.staleFactCount <= 0) {
    return {
      allowed: false,
      decisionCode: "NO_STALE_FACTS",
      suppressedBy: ["reason.requires_stale_fact"],
      nextEligibleAtIso: null
    };
  }

  if (input.reason === "unresolved_commitment" && input.unresolvedCommitmentCount <= 0) {
    return {
      allowed: false,
      decisionCode: "NO_UNRESOLVED_COMMITMENTS",
      suppressedBy: ["reason.requires_unresolved_commitment"],
      nextEligibleAtIso: null
    };
  }

  if (
    input.reason === "contextual_followup" &&
    (input.contextualLinkageConfidence ?? 0) <= 0
  ) {
    return {
      allowed: false,
      decisionCode: "NO_CONTEXTUAL_LINKAGE",
      suppressedBy: ["reason.requires_contextual_linkage"],
      nextEligibleAtIso: null
    };
  }

  if (
    input.overrideSessionDomainSuppression !== true &&
    input.sessionDominantLane === "workflow" &&
    input.sessionHasActiveWorkflowContinuity === true &&
    (input.reason === "stale_fact_revalidation" || input.reason === "contextual_followup")
  ) {
    return {
      allowed: false,
      decisionCode: "SESSION_DOMAIN_SUPPRESSED",
      suppressedBy: ["session.domain.workflow"],
      nextEligibleAtIso: null
    };
  }

  const nowMs = parseIsoToMs(input.nowIso);
  if (!input.overrideQuietHours) {
    const localHour = resolveLocalHour(nowMs, policy.timezoneOffsetMinutes);
    if (
      isInQuietHours(
        localHour,
        policy.quietHoursStartHourLocal,
        policy.quietHoursEndHourLocal
      )
    ) {
      return {
        allowed: false,
        decisionCode: "QUIET_HOURS",
        suppressedBy: ["policy.quiet_hours"],
        nextEligibleAtIso: null
      };
    }
  }

  const minIntervalMs = Math.max(0, Math.floor(policy.minIntervalMinutes)) * 60_000;
  if (input.lastPulseSentAtIso && minIntervalMs > 0) {
    const lastPulseMs = parseIsoToMs(input.lastPulseSentAtIso);
    const elapsedMs = nowMs - lastPulseMs;
    if (elapsedMs < minIntervalMs) {
      return {
        allowed: false,
        decisionCode: "RATE_LIMIT",
        suppressedBy: ["policy.min_interval"],
        nextEligibleAtIso: new Date(lastPulseMs + minIntervalMs).toISOString()
      };
    }
  }

  return {
    allowed: true,
    decisionCode: "ALLOWED",
    suppressedBy: [],
    nextEligibleAtIso: null
  };
}
