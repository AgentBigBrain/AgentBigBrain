/**
 * @fileoverview Deterministic domain-boundary scoring for memory brokerage.
 */

import { hasConversationalProfileUpdateSignal } from "../../core/profileMemoryRuntime/profileMemoryConversationalSignals";
import type { ConversationDomainContext } from "../../core/types";
import type {
  DomainBoundaryAssessment,
  DomainLaneScores,
  MemoryDomainLane
} from "./contracts";

/**
 * Creates the zeroed lane-score structure used during domain-boundary assessment.
 *
 * @returns Empty lane score record.
 */
function createEmptyDomainLaneScores(): DomainLaneScores {
  return {
    profile: 0,
    relationship: 0,
    workflow: 0,
    system_policy: 0,
    unknown: 0
  };
}

/**
 * Adds a non-negative delta to one scored domain lane.
 *
 * @param scores - Mutable lane score record.
 * @param lane - Lane to adjust.
 * @param delta - Score delta to apply.
 */
function addLaneScore(
  scores: DomainLaneScores,
  lane: Exclude<MemoryDomainLane, "unknown">,
  delta: number
): void {
  scores[lane] = Math.max(0, scores[lane] + Math.max(0, delta));
}

/**
 * Scores domain lanes from the active user request alone.
 *
 * @param currentUserRequest - Current user request under evaluation.
 * @returns Baseline lane scores derived from lexical evidence.
 */
function inferDomainLaneScoresFromRequest(currentUserRequest: string): DomainLaneScores {
  const normalized = currentUserRequest.toLowerCase();
  const scores = createEmptyDomainLaneScores();
  if (/\b(my|i|mine|myself)\b/.test(normalized)) {
    addLaneScore(scores, "profile", 1);
  }
  if (
    /\b(friend|employee|coworker|colleague|teammate|classmate|peer|work\s+peer|boss|manager|supervisor|team\s+lead|direct\s+report|neighbor|neighbour|relative|distant\s+relative|family(?:\s+members?)?|cousin|aunt|uncle|mom|mother|dad|father|son|daughter|parent|child|sibling|sister|brother|roommate|spouse|wife|husband|girlfriend|boyfriend|partner|married|contact|relationship)\b/.test(
      normalized
    ) ||
    /\bwho is\b/.test(normalized) ||
    /\b(he|she|they)\b/.test(normalized)
  ) {
    addLaneScore(scores, "relationship", 3);
  }
  if (
    /\b(name|called|call me|i go by|favorite|prefer|birthday|age|live|moved|job|work at)\b/.test(
      normalized
    )
  ) {
    addLaneScore(scores, "profile", 2);
  }
  if (
    /\b(workflow|deploy|deployment|script|build|task|project|workspace|repo|code)\b/.test(
      normalized
    )
  ) {
    addLaneScore(scores, "workflow", 3);
  }
  if (
    /\b(governor|policy|safety|constraint|allowlist|approval|compliance)\b/.test(normalized)
  ) {
    addLaneScore(scores, "system_policy", 3);
  }

  return scores;
}

/**
 * Returns whether one shared session-domain snapshot carries active continuity state.
 *
 * @param sessionDomainContext - Persisted shared domain context.
 * @returns `true` when any continuity flag is active.
 */
function hasSessionContinuity(
  sessionDomainContext: ConversationDomainContext | null | undefined
): boolean {
  return sessionDomainContext?.continuitySignals.activeWorkspace === true ||
    sessionDomainContext?.continuitySignals.returnHandoff === true ||
    sessionDomainContext?.continuitySignals.modeContinuity === true;
}

/**
 * Returns whether a routing mode should reinforce workflow continuity.
 *
 * @param mode - Candidate routing mode.
 * @returns `true` when the mode is one of the workflow-bearing modes.
 */
function isWorkflowRoutingMode(mode: string): boolean {
  return mode === "plan" || mode === "build" || mode === "autonomous" || mode === "review";
}

/**
 * Adds bounded domain-lane signals from shared session context onto request scoring.
 *
 * @param baseScores - Request-only lane scores.
 * @param sessionDomainContext - Optional shared domain context.
 * @returns Updated lane scores.
 */
function applySessionDomainLaneSignals(
  baseScores: DomainLaneScores,
  sessionDomainContext: ConversationDomainContext | null | undefined
): DomainLaneScores {
  if (!sessionDomainContext || sessionDomainContext.dominantLane === "unknown") {
    return baseScores;
  }

  const scores: DomainLaneScores = { ...baseScores };
  const continuityActive = hasSessionContinuity(sessionDomainContext);
  switch (sessionDomainContext.dominantLane) {
    case "profile":
      addLaneScore(scores, "profile", continuityActive ? 2 : 1);
      break;
    case "relationship":
      addLaneScore(scores, "relationship", continuityActive ? 2 : 1);
      break;
    case "workflow":
      addLaneScore(scores, "workflow", continuityActive ? 2 : 1);
      break;
    case "system_policy":
      addLaneScore(scores, "system_policy", continuityActive ? 2 : 1);
      break;
    default:
      break;
  }

  const recentRoutingModes = sessionDomainContext.recentRoutingSignals
    .slice(-2)
    .map((signal) => signal.mode);
  if (recentRoutingModes.some((mode) => isWorkflowRoutingMode(mode))) {
    addLaneScore(scores, "workflow", 1);
  }
  if (
    recentRoutingModes.some((mode) => ["chat", "explain", "status_or_recall"].includes(mode)) &&
    (sessionDomainContext.dominantLane === "profile" ||
      sessionDomainContext.dominantLane === "relationship")
  ) {
    addLaneScore(scores, sessionDomainContext.dominantLane, 1);
  }

  return scores;
}

/**
 * Adds lane signals inferred from the rendered brokered memory-context payload.
 *
 * @param baseScores - Existing lane scores.
 * @param memoryContext - Sanitized brokered memory payload.
 * @returns Updated lane scores.
 */
function applyProfileContextLaneSignals(
  baseScores: DomainLaneScores,
  memoryContext: string
): DomainLaneScores {
  const scores: DomainLaneScores = { ...baseScores };
  const lines = memoryContext
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    if (line.startsWith("contact.") || line.includes(".relationship:")) {
      addLaneScore(scores, "relationship", 1);
    }
    if (
      line.startsWith("identity.") ||
      line.startsWith("employment.") ||
      line.startsWith("residence.") ||
      line.startsWith("location.")
    ) {
      addLaneScore(scores, "profile", 1);
    }
    if (line.startsWith("workflow.") || line.startsWith("project.") || line.startsWith("task.")) {
      addLaneScore(scores, "workflow", 1);
    }
    if (line.startsWith("policy.") || line.includes("governor") || line.includes("constraint")) {
      addLaneScore(scores, "system_policy", 1);
    }
    if (line.startsWith("- situation:") || line.startsWith("episode.")) {
      addLaneScore(scores, "relationship", 1);
    }
  }

  return scores;
}

/**
 * Orders the dominant domain lanes from a scored boundary assessment.
 *
 * @param scores - Lane scores to rank.
 * @returns Ordered dominant lanes or `unknown` when no signal exists.
 */
function selectDomainLanes(scores: DomainLaneScores): MemoryDomainLane[] {
  const laneOrder: MemoryDomainLane[] = ["profile", "relationship", "workflow", "system_policy"];
  const positiveLanes = laneOrder
    .filter((lane) => scores[lane] > 0)
    .sort((left, right) => {
      if (scores[left] === scores[right]) {
        return laneOrder.indexOf(left) - laneOrder.indexOf(right);
      }
      return scores[right] - scores[left];
    });

  if (positiveLanes.length === 0) {
    return ["unknown"];
  }

  return positiveLanes;
}

/**
 * Assesses whether profile context should be injected or suppressed for the current request.
 *
 * @param currentUserRequest - Active user request used for lane scoring.
 * @param memoryContext - Sanitized brokered memory-context payload, if available.
 * @param sessionDomainContext - Optional shared domain context used to bias the decision.
 * @returns Deterministic lane scores plus the inject/suppress decision.
 */
export function assessDomainBoundary(
  currentUserRequest: string,
  memoryContext: string,
  sessionDomainContext?: ConversationDomainContext | null
): DomainBoundaryAssessment {
  const requestScores = inferDomainLaneScoresFromRequest(currentUserRequest);
  const sessionAwareRequestScores = applySessionDomainLaneSignals(requestScores, sessionDomainContext);
  const scores = applyProfileContextLaneSignals(sessionAwareRequestScores, memoryContext);
  const lanes = selectDomainLanes(scores);
  const profileSignal = scores.profile + scores.relationship;
  const nonProfileSignal = scores.workflow + scores.system_policy;
  const requestProfileSignal = requestScores.profile + requestScores.relationship;
  const requestNonProfileSignal = requestScores.workflow + requestScores.system_policy;
  const workflowSessionContinuity =
    sessionDomainContext?.dominantLane === "workflow" && hasSessionContinuity(sessionDomainContext);
  if (profileSignal <= 0) {
    return {
      lanes,
      scores,
      decision: "suppress_profile_context",
      reason: "no_profile_signal"
    };
  }

  if (
    workflowSessionContinuity &&
    requestNonProfileSignal > 0 &&
    nonProfileSignal > profileSignal
  ) {
    return {
      lanes,
      scores,
      decision: "suppress_profile_context",
      reason: "workflow_session_continuity"
    };
  }

  if (nonProfileSignal - profileSignal >= 3) {
    return {
      lanes,
      scores,
      decision: "suppress_profile_context",
      reason: "non_profile_dominant_request"
    };
  }

  return {
    lanes,
    scores,
    decision: "inject_profile_context",
    reason:
      nonProfileSignal > 0
        ? "cross_domain_allowed_with_profile_signal"
        : "profile_context_relevant"
  };
}

/**
 * Returns whether broker-side profile-memory ingestion should be skipped for the current request.
 *
 * @param currentUserRequest - Active user request used for bounded memory-ingest gating.
 * @param sessionDomainContext - Optional shared session context used to reinforce workflow continuity.
 * @returns `true` when the request is clearly workflow/system-oriented and should not write profile memory.
 */
export function shouldSkipProfileMemoryIngest(
  currentUserRequest: string,
  sessionDomainContext?: ConversationDomainContext | null
): boolean {
  const requestScores = inferDomainLaneScoresFromRequest(currentUserRequest);
  const requestHasConversationalProfileUpdate =
    hasConversationalProfileUpdateSignal(currentUserRequest);
  if (requestHasConversationalProfileUpdate) {
    return false;
  }
  const requestProfileSignal = requestScores.profile + requestScores.relationship;
  const requestNonProfileSignal = requestScores.workflow + requestScores.system_policy;
  const sessionAwareScores = applySessionDomainLaneSignals(requestScores, sessionDomainContext);
  const profileSignal = sessionAwareScores.profile + sessionAwareScores.relationship;
  const nonProfileSignal = sessionAwareScores.workflow + sessionAwareScores.system_policy;
  const workflowSessionContinuity =
    sessionDomainContext?.dominantLane === "workflow" && hasSessionContinuity(sessionDomainContext);
  if (nonProfileSignal >= 3 && nonProfileSignal > profileSignal) {
    return true;
  }
  return workflowSessionContinuity && requestNonProfileSignal > 0 && nonProfileSignal > profileSignal;
}
