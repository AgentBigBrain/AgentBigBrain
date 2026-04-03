/**
 * @fileoverview Derives bounded session-domain hints and turn-level domain updates from routing.
 */

import type {
  ConversationDomainLane,
  ConversationDomainRoutingMode,
  ConversationDomainSignalWindowUpdate
} from "../../core/sessionContext";
import { applyDomainSignalWindow, isConversationDomainContextMeaningful } from "../../core/sessionContext";
import type { LocalIntentModelSessionHints } from "../../organs/languageUnderstanding/localIntentModelContracts";
import type { RoutingMapClassificationV1 } from "../routingMap";
import type { ConversationIntentMode, ConversationSession } from "../sessionStore";
import { isRelationshipConversationRecallTurn } from "./chatTurnSignals";

const PROFILE_LANE_PATTERNS: readonly RegExp[] = [
  /\b(?:my name is|call me|i go by)\b/i,
  /\b(?:remember that i|i prefer|my favorite)\b/i,
  /\b(?:my birthday|i live|i moved|my job|i work at)\b/i
] as const;

const RELATIONSHIP_LANE_PATTERNS: readonly RegExp[] = [
  /\b(?:my )?(?:friend|employee|coworker|colleague|teammate|classmate|peer|work\s+peer|boss|manager|supervisor|team\s+lead|direct\s+report|neighbor|neighbour|relative|distant\s+relative|family(?:\s+members?)?|cousin|aunt|uncle|mom|mother|dad|father|son|daughter|parent|child|sibling|sister|brother|roommate|spouse|wife|husband|girlfriend|boyfriend|partner|married|contact)\b/i,
  /\bwho is\b/i
] as const;

const WORKFLOW_LANE_PATTERNS: readonly RegExp[] = [
  /\b(?:workflow|deploy|deployment|script|build|task|project|workspace|repo|repository|code)\b/i
] as const;

const WORKFLOW_ACTION_PATTERNS: readonly RegExp[] = [
  /\b(?:create|build|make|generate|scaffold|set up|setup|spin up|fix|implement|edit|change|update|run|execute|ship|deploy|open|close|reopen|resume|continue|move|organize|clean up)\b/i
] as const;

const WORKFLOW_ARTIFACT_PATTERNS: readonly RegExp[] = [
  /\b(?:app|application|site|website|frontend|backend|api|cli|browser|tab|window|page|preview|folder|file|desktop|draft)\b/i
] as const;

const BROWSER_CONTROL_PATTERNS: readonly RegExp[] = [
  /\b(?:browser|tab|window|page|preview)\b/i,
  /\b(?:open|close|reopen|leave)\b/i
] as const;

const SYSTEM_POLICY_LANE_PATTERNS: readonly RegExp[] = [
  /\b(?:governor|policy|safety|constraint|allowlist|approval|compliance)\b/i,
  /\bapproval diff\b/i,
  /\bblocked by policy\b/i
] as const;

const WORKFLOW_ROUTING_MODES = new Set<ConversationDomainRoutingMode>([
  "plan",
  "build",
  "autonomous",
  "review"
]);

const WORKFLOW_CONTINUITY_MODES = new Set<ConversationIntentMode>([
  "plan",
  "build",
  "autonomous",
  "review"
]);

interface ConversationDomainLaneSignalCandidate {
  lane: ConversationDomainLane;
  source: "keyword" | "routing_mode" | "continuity_state";
  weight: number;
}

/**
 * Builds the bounded domain hints exposed to deterministic intent resolution and the local model.
 *
 * @param session - Current conversation session carrying continuity and domain state.
 * @returns Minimal session-domain hints used for routing disambiguation.
 */
export function buildConversationDomainSessionHints(
  session: ConversationSession
): Pick<
  LocalIntentModelSessionHints,
  | "hasActiveWorkspace"
  | "domainDominantLane"
  | "domainContinuityActive"
  | "workflowContinuityActive"
> {
  const workflowContinuityActive = hasWorkflowContinuity(session);
  return {
    hasActiveWorkspace: session.activeWorkspace !== null,
    domainDominantLane: session.domainContext.dominantLane,
    domainContinuityActive:
      workflowContinuityActive ||
      session.modeContinuity !== null ||
      session.domainContext.continuitySignals.activeWorkspace ||
      session.domainContext.continuitySignals.returnHandoff ||
      session.domainContext.continuitySignals.modeContinuity,
    workflowContinuityActive
  };
}

/**
 * Returns whether ambiguous autonomy wording should still promote into autonomous mode.
 *
 * @param userInput - Current user input under deterministic intent resolution.
 * @param routingClassification - Deterministic routing classification for the same input.
 * @param sessionHints - Bounded persisted session hints supplied to intent resolution.
 * @returns `true` when ambiguous autonomy wording still has enough workflow context to promote.
 */
export function shouldPromoteAmbiguousAutonomousExecution(
  userInput: string,
  routingClassification: RoutingMapClassificationV1 | null,
  sessionHints: LocalIntentModelSessionHints | null
): boolean {
  const workflowContinuityActive = sessionHints?.workflowContinuityActive === true;
  if (workflowContinuityActive) {
    return true;
  }
  if (sessionHints?.domainDominantLane === "workflow") {
    return true;
  }
  if (routingClassification?.routeType === "execution_surface") {
    return true;
  }
  return hasWorkflowKeywordEvidence(userInput, workflowContinuityActive);
}

/**
 * Returns whether an ambiguous autonomy cue is contextual enough to justify one bounded
 * autonomy-boundary interpretation attempt after deterministic promotion fails.
 *
 * @param routingClassification - Deterministic routing classification for the same turn.
 * @param sessionHints - Bounded persisted session hints supplied to intent resolution.
 * @returns `true` when the turn carries enough workflow or domain context for the bounded task.
 */
export function shouldAttemptAutonomyBoundaryInterpretation(
  routingClassification: RoutingMapClassificationV1 | null,
  sessionHints: LocalIntentModelSessionHints | null
): boolean {
  if (routingClassification?.routeType === "execution_surface") {
    return true;
  }
  return (
    sessionHints?.workflowContinuityActive === true ||
    sessionHints?.domainContinuityActive === true ||
    sessionHints?.domainDominantLane === "workflow" ||
    sessionHints?.domainDominantLane === "profile" ||
    sessionHints?.domainDominantLane === "relationship"
  );
}

/**
 * Builds one bounded domain-context update from a routing outcome.
 *
 * @param session - Current conversation session receiving the update.
 * @param userInput - Current raw user input for the turn.
 * @param receivedAt - ISO timestamp for the turn.
 * @param routingClassification - Deterministic routing classification for the same input.
 * @param routingMode - Final routing mode for this turn when known.
 * @returns Canonical bounded domain update for session persistence.
 */
export function buildConversationDomainSignalWindowForTurn(
  session: ConversationSession,
  userInput: string,
  receivedAt: string,
  routingClassification: RoutingMapClassificationV1 | null,
  routingMode: ConversationDomainRoutingMode | null
): ConversationDomainSignalWindowUpdate {
  const workflowContinuityActive = hasWorkflowContinuity(session);
  const laneSignals = toLaneSignals(
    dedupeLaneSignalCandidates([
      ...inferKeywordLaneSignals(userInput, workflowContinuityActive),
      ...inferRoutingLaneSignals(
        session,
        userInput,
        routingClassification,
        routingMode,
        workflowContinuityActive
      )
    ]),
    receivedAt
  );

  return {
    observedAt: receivedAt,
    laneSignals,
    routingSignals:
      routingMode === null
        ? []
        : [
            {
              mode: routingMode,
              observedAt: receivedAt
            }
          ],
    continuitySignals: {
      activeWorkspace: session.activeWorkspace !== null,
      returnHandoff: session.returnHandoff !== null,
      modeContinuity: session.modeContinuity !== null
    }
  };
}

/**
 * Applies one canonical routing-derived domain update directly to the current session.
 *
 * @param session - Current conversation session receiving the domain update.
 * @param userInput - Current raw user input for the turn.
 * @param receivedAt - ISO timestamp for the turn.
 * @param routingClassification - Deterministic routing classification for the same input.
 * @param routingMode - Final routing mode for this turn when known.
 */
export function applyConversationDomainSignalWindowForTurn(
  session: ConversationSession,
  userInput: string,
  receivedAt: string,
  routingClassification: RoutingMapClassificationV1 | null,
  routingMode: ConversationDomainRoutingMode | null
): void {
  session.domainContext = applyDomainSignalWindow(
    session.domainContext,
    buildConversationDomainSignalWindowForTurn(
      session,
      userInput,
      receivedAt,
      routingClassification,
      routingMode
    )
  );
}

/**
 * Returns whether the session currently carries meaningful domain hints that should be surfaced.
 *
 * @param session - Current conversation session.
 * @returns `true` when domain hints or live continuity are present.
 */
export function hasConversationDomainSessionHints(session: ConversationSession): boolean {
  return (
    session.activeWorkspace !== null ||
    session.returnHandoff !== null ||
    session.modeContinuity !== null ||
    isConversationDomainContextMeaningful(session.domainContext)
  );
}

/** Returns whether the current session has live or persisted workflow continuity. */
function hasWorkflowContinuity(session: ConversationSession): boolean {
  if (session.activeWorkspace !== null || session.returnHandoff !== null) {
    return true;
  }
  if (session.modeContinuity && WORKFLOW_CONTINUITY_MODES.has(session.modeContinuity.activeMode)) {
    return true;
  }
  return (
    session.domainContext.dominantLane === "workflow" &&
    (session.domainContext.continuitySignals.activeWorkspace ||
      session.domainContext.continuitySignals.returnHandoff ||
      session.domainContext.continuitySignals.modeContinuity)
  );
}

/** Returns whether the current user input carries direct workflow lexical evidence. */
function hasWorkflowKeywordEvidence(
  userInput: string,
  workflowContinuityActive: boolean
): boolean {
  const normalized = userInput.trim();
  if (!normalized) {
    return false;
  }
  if (WORKFLOW_LANE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  if (
    WORKFLOW_ACTION_PATTERNS.some((pattern) => pattern.test(normalized)) &&
    WORKFLOW_ARTIFACT_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return true;
  }
  return (
    workflowContinuityActive &&
    BROWSER_CONTROL_PATTERNS.every((pattern) => pattern.test(normalized))
  );
}

/** Infers bounded keyword-origin lane candidates from the current user input. */
function inferKeywordLaneSignals(
  userInput: string,
  workflowContinuityActive: boolean
): ConversationDomainLaneSignalCandidate[] {
  const normalized = userInput.trim();
  if (!normalized) {
    return [];
  }

  const laneCandidates: ConversationDomainLaneSignalCandidate[] = [];
  if (PROFILE_LANE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    laneCandidates.push({
      lane: "profile",
      source: "keyword",
      weight: 2
    });
  }
  if (RELATIONSHIP_LANE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    laneCandidates.push({
      lane: "relationship",
      source: "keyword",
      weight: 3
    });
  } else if (isRelationshipConversationRecallTurn(normalized)) {
    laneCandidates.push({
      lane: "relationship",
      source: "keyword",
      weight: 3
    });
  }
  if (WORKFLOW_LANE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    laneCandidates.push({
      lane: "workflow",
      source: "keyword",
      weight: 3
    });
  } else if (
    WORKFLOW_ACTION_PATTERNS.some((pattern) => pattern.test(normalized)) &&
    WORKFLOW_ARTIFACT_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    laneCandidates.push({
      lane: "workflow",
      source: "keyword",
      weight: 2
    });
  } else if (
    workflowContinuityActive &&
    BROWSER_CONTROL_PATTERNS.every((pattern) => pattern.test(normalized))
  ) {
    laneCandidates.push({
      lane: "workflow",
      source: "keyword",
      weight: 2
    });
  }
  if (SYSTEM_POLICY_LANE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    laneCandidates.push({
      lane: "system_policy",
      source: "keyword",
      weight: 3
    });
  }
  return laneCandidates;
}

/** Infers routing-origin or continuity-origin lane candidates from the final routing outcome. */
function inferRoutingLaneSignals(
  session: ConversationSession,
  userInput: string,
  routingClassification: RoutingMapClassificationV1 | null,
  routingMode: ConversationDomainRoutingMode | null,
  workflowContinuityActive: boolean
): ConversationDomainLaneSignalCandidate[] {
  const laneCandidates: ConversationDomainLaneSignalCandidate[] = [];
  if (
    routingClassification?.routeType === "policy_explanation" ||
    SYSTEM_POLICY_LANE_PATTERNS.some((pattern) => pattern.test(userInput))
  ) {
    laneCandidates.push({
      lane: "system_policy",
      source: "routing_mode",
      weight: 3
    });
  } else if (
    routingClassification?.routeType === "execution_surface" ||
    routingClassification?.routeType === "diagnostics" ||
    (routingMode !== null && WORKFLOW_ROUTING_MODES.has(routingMode))
  ) {
    laneCandidates.push({
      lane: "workflow",
      source: "routing_mode",
      weight: routingMode === "autonomous" ? 3 : 2
    });
  }

  if (
    workflowContinuityActive &&
    (routingMode === null ||
      routingMode === "chat" ||
      routingMode === "discover_available_capabilities" ||
      routingMode === "status_or_recall" ||
      routingMode === "unclear" ||
      session.domainContext.dominantLane === "workflow")
  ) {
    laneCandidates.push({
      lane: "workflow",
      source: "continuity_state",
      weight: 1
    });
  }

  return laneCandidates;
}

/** Deduplicates lane candidates so the bounded per-turn update stays compact and deterministic. */
function dedupeLaneSignalCandidates(
  candidates: readonly ConversationDomainLaneSignalCandidate[]
): ConversationDomainLaneSignalCandidate[] {
  const deduped = new Map<string, ConversationDomainLaneSignalCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.source}:${candidate.lane}`;
    const existing = deduped.get(key);
    if (!existing || candidate.weight > existing.weight) {
      deduped.set(key, candidate);
    }
  }
  return [...deduped.values()].sort((left, right) => right.weight - left.weight);
}

/** Converts transient lane candidates into the persisted bounded signal shape. */
function toLaneSignals(
  candidates: readonly ConversationDomainLaneSignalCandidate[],
  observedAt: string
): ConversationDomainSignalWindowUpdate["laneSignals"] {
  return candidates.map((candidate) => ({
    lane: candidate.lane,
    observedAt,
    source: candidate.source,
    weight: candidate.weight
  }));
}
