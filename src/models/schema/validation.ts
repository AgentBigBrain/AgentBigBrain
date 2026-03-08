/**
 * @fileoverview Runtime schema validators for structured model outputs at the model-client boundary.
 */

import {
  defaultPlannerActionDescription,
  extractPlannerActionCandidates,
  isPlannerActionType,
  normalizePlannerActionParams,
  normalizePlannerActionTypeAlias,
  toPlannerRecord
} from "../../core/plannerActionSchema";
import type { KnownModelSchemaName } from "./contracts";

/** Returns `true` when the payload is a planner-compatible record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return toPlannerRecord(value) !== null;
}

/** Returns `true` when the payload is a finite number. */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Returns `true` when the payload is a valid planner action type. */
function isActionType(value: unknown): boolean {
  return isPlannerActionType(value);
}

/** Throws a deterministic schema error when a validation condition fails. */
function assertSchema(condition: boolean, schemaName: string, message: string): void {
  if (!condition) {
    throw new Error(`Model output failed ${schemaName} validation: ${message}`);
  }
}

/** Returns a record payload or throws a deterministic schema error. */
function assertRecordPayload(schemaName: string, payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new Error(`Model output failed ${schemaName} validation: payload must be an object.`);
  }
  return payload;
}

/**
 * Normalizes planner action record into a stable shape for the schema subsystem.
 *
 * @param action - Candidate action payload.
 * @returns Canonical planner action record, or `null` when the candidate is unusable.
 */
function normalizePlannerActionRecord(action: unknown): Record<string, unknown> | null {
  const actionRecord = toPlannerRecord(action);
  if (!actionRecord) {
    return null;
  }

  const normalizedType = normalizePlannerActionTypeAlias(
    actionRecord.type ?? actionRecord.actionType ?? actionRecord.action ?? actionRecord.tool
  );
  if (!normalizedType) {
    return null;
  }

  const normalizedAction: Record<string, unknown> = {
    type: normalizedType
  };

  if (typeof actionRecord.description === "string" && actionRecord.description.trim().length > 0) {
    normalizedAction.description = actionRecord.description.trim();
  } else {
    normalizedAction.description = defaultPlannerActionDescription(normalizedType);
  }

  const existingParams = toPlannerRecord(actionRecord.params) ?? {};
  normalizedAction.params = normalizePlannerActionParams(actionRecord, existingParams);

  if (isFiniteNumber(actionRecord.estimatedCostUsd) && actionRecord.estimatedCostUsd >= 0) {
    normalizedAction.estimatedCostUsd = actionRecord.estimatedCostUsd;
  }

  return normalizedAction;
}

/**
 * Normalizes planner payload into a stable shape for the schema subsystem.
 *
 * @param payload - Candidate planner payload.
 * @returns Canonical planner payload.
 */
function normalizePlannerPayload(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }

  const actions = extractPlannerActionCandidates(payload)
    .map((candidate) => normalizePlannerActionRecord(candidate))
    .filter((candidate): candidate is Record<string, unknown> => candidate !== null);

  const plannerNotes =
    typeof payload.plannerNotes === "string"
      ? payload.plannerNotes
      : typeof payload.notes === "string"
        ? payload.notes
        : "Planner output normalized at model boundary.";

  return {
    ...payload,
    plannerNotes,
    actions
  };
}

/** Applies deterministic validity checks for planner output. */
function validatePlannerOutput(schemaName: string, payload: unknown): void {
  const recordPayload = assertRecordPayload(schemaName, payload);
  assertSchema(
    typeof recordPayload.plannerNotes === "string",
    schemaName,
    "`plannerNotes` must be a string."
  );
  assertSchema(Array.isArray(recordPayload.actions), schemaName, "`actions` must be an array.");
  const actions = recordPayload.actions as unknown[];
  for (const action of actions) {
    if (!isRecord(action)) {
      throw new Error(`Model output failed ${schemaName} validation: each action must be an object.`);
    }
    assertSchema(
      isActionType(action.type),
      schemaName,
      "each action `type` must be a valid action type."
    );
    assertSchema(
      typeof action.description === "string",
      schemaName,
      "each action `description` must be a string."
    );
    assertSchema(
      action.params === undefined || isRecord(action.params),
      schemaName,
      "each action `params` must be an object when present."
    );
    assertSchema(
      action.estimatedCostUsd === undefined ||
      (isFiniteNumber(action.estimatedCostUsd) && action.estimatedCostUsd >= 0),
      schemaName,
      "each action `estimatedCostUsd` must be a non-negative number when present."
    );
  }
}

/** Applies deterministic validity checks for response output. */
function validateResponseOutput(schemaName: string, payload: unknown): void {
  const recordPayload = assertRecordPayload(schemaName, payload);
  assertSchema(typeof recordPayload.message === "string", schemaName, "`message` must be a string.");
}

/** Applies deterministic validity checks for reflection output. */
function validateReflectionOutput(schemaName: string, payload: unknown): void {
  const recordPayload = assertRecordPayload(schemaName, payload);
  assertSchema(Array.isArray(recordPayload.lessons), schemaName, "`lessons` must be an array.");
  const lessons = recordPayload.lessons as unknown[];
  for (const lesson of lessons) {
    assertSchema(typeof lesson === "string", schemaName, "each `lessons` entry must be a string.");
  }
}

/** Applies deterministic validity checks for success reflection output. */
function validateSuccessReflectionOutput(schemaName: string, payload: unknown): void {
  const recordPayload = assertRecordPayload(schemaName, payload);
  assertSchema(typeof recordPayload.lesson === "string", schemaName, "`lesson` must be a string.");
  assertSchema(
    recordPayload.nearMiss === null || typeof recordPayload.nearMiss === "string",
    schemaName,
    "`nearMiss` must be a string or null."
  );
}

/** Applies deterministic validity checks for governor output. */
function validateGovernorOutput(schemaName: string, payload: unknown): void {
  const recordPayload = assertRecordPayload(schemaName, payload);
  assertSchema(typeof recordPayload.approve === "boolean", schemaName, "`approve` must be a boolean.");
  assertSchema(typeof recordPayload.reason === "string", schemaName, "`reason` must be a string.");
  assertSchema(
    isFiniteNumber(recordPayload.confidence) &&
    recordPayload.confidence >= 0 &&
    recordPayload.confidence <= 1,
    schemaName,
    "`confidence` must be a number in [0,1]."
  );
}

/** Applies deterministic validity checks for autonomous next-step output. */
function validateAutonomousNextStepOutput(schemaName: string, payload: unknown): void {
  const recordPayload = assertRecordPayload(schemaName, payload);
  assertSchema(
    typeof recordPayload.isGoalMet === "boolean",
    schemaName,
    "`isGoalMet` must be a boolean."
  );
  assertSchema(
    typeof recordPayload.nextUserInput === "string",
    schemaName,
    "`nextUserInput` must be a string."
  );
  assertSchema(typeof recordPayload.reasoning === "string", schemaName, "`reasoning` must be a string.");
}

/** Applies deterministic validity checks for proactive-goal output. */
function validateProactiveGoalOutput(schemaName: string, payload: unknown): void {
  const recordPayload = assertRecordPayload(schemaName, payload);
  assertSchema(
    typeof recordPayload.proactiveGoal === "string",
    schemaName,
    "`proactiveGoal` must be a string."
  );
  assertSchema(typeof recordPayload.reasoning === "string", schemaName, "`reasoning` must be a string.");
}

/** Applies deterministic validity checks for intent-interpretation output. */
function validateIntentInterpretationOutput(schemaName: string, payload: unknown): void {
  const recordPayload = assertRecordPayload(schemaName, payload);
  assertSchema(
    recordPayload.intentType === "pulse_control" || recordPayload.intentType === "none",
    schemaName,
    "`intentType` must be `pulse_control` or `none`."
  );
  assertSchema(
    recordPayload.mode === null ||
    recordPayload.mode === "on" ||
    recordPayload.mode === "off" ||
    recordPayload.mode === "private" ||
    recordPayload.mode === "public" ||
    recordPayload.mode === "status",
    schemaName,
    "`mode` must be one of on/off/private/public/status/null."
  );
  assertSchema(
    isFiniteNumber(recordPayload.confidence) &&
    recordPayload.confidence >= 0 &&
    recordPayload.confidence <= 1,
    schemaName,
    "`confidence` must be a number in [0,1]."
  );
  assertSchema(typeof recordPayload.rationale === "string", schemaName, "`rationale` must be a string.");
}

/** Applies deterministic validity checks for language episode extraction output. */
function validateLanguageEpisodeExtractionOutput(schemaName: string, payload: unknown): void {
  const recordPayload = assertRecordPayload(schemaName, payload);
  assertSchema(Array.isArray(recordPayload.episodes), schemaName, "`episodes` must be an array.");
  const episodes = recordPayload.episodes as unknown[];
  assertSchema(episodes.length <= 2, schemaName, "`episodes` must contain at most two entries.");
  for (const episode of episodes) {
    const episodeRecord = assertRecordPayload(schemaName, episode);
    assertSchema(
      typeof episodeRecord.subjectName === "string" && episodeRecord.subjectName.trim().length > 0,
      schemaName,
      "each episode `subjectName` must be a non-empty string."
    );
    assertSchema(
      typeof episodeRecord.eventSummary === "string" && episodeRecord.eventSummary.trim().length > 0,
      schemaName,
      "each episode `eventSummary` must be a non-empty string."
    );
    assertSchema(
      typeof episodeRecord.supportingSnippet === "string" &&
      episodeRecord.supportingSnippet.trim().length > 0,
      schemaName,
      "each episode `supportingSnippet` must be a non-empty string."
    );
    assertSchema(
      episodeRecord.status === "unresolved" ||
      episodeRecord.status === "partially_resolved" ||
      episodeRecord.status === "resolved" ||
      episodeRecord.status === "outcome_unknown" ||
      episodeRecord.status === "no_longer_relevant",
      schemaName,
      "each episode `status` must be a valid profile episode status."
    );
    assertSchema(
      isFiniteNumber(episodeRecord.confidence) &&
      episodeRecord.confidence >= 0 &&
      episodeRecord.confidence <= 1,
      schemaName,
      "each episode `confidence` must be a number in [0,1]."
    );
    assertSchema(
      Array.isArray(episodeRecord.tags) &&
      (episodeRecord.tags as unknown[]).every((tag) => typeof tag === "string"),
      schemaName,
      "each episode `tags` must be a string array."
    );
  }
}

/** Applies deterministic validity checks for structured model output. */
export function validateStructuredModelOutput(schemaName: string, payload: unknown): void {
  if (schemaName === "planner_v1") {
    validatePlannerOutput(schemaName, payload);
    return;
  }

  if (schemaName === "response_v1") {
    validateResponseOutput(schemaName, payload);
    return;
  }

  if (schemaName === "reflection_v1") {
    validateReflectionOutput(schemaName, payload);
    return;
  }

  if (schemaName === "reflection_success_v1") {
    validateSuccessReflectionOutput(schemaName, payload);
    return;
  }

  if (schemaName === "governor_v1") {
    validateGovernorOutput(schemaName, payload);
    return;
  }

  if (schemaName === "autonomous_next_step_v1") {
    validateAutonomousNextStepOutput(schemaName, payload);
    return;
  }

  if (schemaName === "proactive_goal_v1") {
    validateProactiveGoalOutput(schemaName, payload);
    return;
  }

  if (schemaName === "intent_interpretation_v1") {
    validateIntentInterpretationOutput(schemaName, payload);
    return;
  }

  if (schemaName === "language_episode_extraction_v1") {
    validateLanguageEpisodeExtractionOutput(schemaName, payload);
  }
}

/** Normalizes structured model output into a stable shape for downstream model clients. */
export function normalizeStructuredModelOutput(
  schemaName: KnownModelSchemaName | string,
  payload: unknown
): unknown {
  if (schemaName === "planner_v1") {
    return normalizePlannerPayload(payload);
  }

  return payload;
}
