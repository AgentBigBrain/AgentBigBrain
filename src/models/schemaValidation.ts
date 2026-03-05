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
} from "../core/plannerActionSchema";

/**
 * Evaluates record and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the record policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `toPlannerRecord` (import `toPlannerRecord`) from `../core/plannerActionSchema`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is Record<string, unknown>` result.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return toPlannerRecord(value) !== null;
}

/**
 * Evaluates finite number and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the finite number policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is number` result.
 */
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Evaluates action type and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the action type policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `isPlannerActionType` (import `isPlannerActionType`) from `../core/plannerActionSchema`.
 *
 * @param value - Primary input consumed by this function.
 * @returns `true` when this check/policy condition passes.
 */
function isActionType(value: unknown): boolean {
  return isPlannerActionType(value);
}

/**
 * Applies deterministic validity checks for schema.
 *
 * **Why it exists:**
 * Fails fast when schema is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param condition - Value for condition.
 * @param schemaName - Value for schema name.
 * @param message - Message/text content processed by this function.
 */
function assertSchema(condition: boolean, schemaName: string, message: string): void {
  if (!condition) {
    throw new Error(`Model output failed ${schemaName} validation: ${message}`);
  }
}

/**
 * Applies deterministic validity checks for record payload.
 *
 * **Why it exists:**
 * Fails fast when record payload is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param schemaName - Value for schema name.
 * @param payload - Structured input object for this operation.
 * @returns Computed `Record<string, unknown>` result.
 */
function assertRecordPayload(schemaName: string, payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) {
    throw new Error(`Model output failed ${schemaName} validation: payload must be an object.`);
  }
  return payload;
}

/**
 * Normalizes planner action record into a stable shape for `schemaValidation` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for planner action record so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `defaultPlannerActionDescription` (import `defaultPlannerActionDescription`) from `../core/plannerActionSchema`.
 * - Uses `normalizePlannerActionParams` (import `normalizePlannerActionParams`) from `../core/plannerActionSchema`.
 * - Uses `normalizePlannerActionTypeAlias` (import `normalizePlannerActionTypeAlias`) from `../core/plannerActionSchema`.
 * - Uses `toPlannerRecord` (import `toPlannerRecord`) from `../core/plannerActionSchema`.
 *
 * @param action - Value for action.
 * @returns Computed `Record<string, unknown> | null` result.
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

  if (
    isFiniteNumber(actionRecord.estimatedCostUsd) &&
    actionRecord.estimatedCostUsd >= 0
  ) {
    normalizedAction.estimatedCostUsd = actionRecord.estimatedCostUsd;
  }

  return normalizedAction;
}

/**
 * Normalizes planner payload into a stable shape for `schemaValidation` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for planner payload so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `extractPlannerActionCandidates` (import `extractPlannerActionCandidates`) from `../core/plannerActionSchema`.
 *
 * @param payload - Structured input object for this operation.
 * @returns Computed `unknown` result.
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

/**
 * Applies deterministic validity checks for planner output.
 *
 * **Why it exists:**
 * Fails fast when planner output is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param schemaName - Value for schema name.
 * @param payload - Structured input object for this operation.
 */
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

/**
 * Applies deterministic validity checks for response output.
 *
 * **Why it exists:**
 * Fails fast when response output is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param schemaName - Value for schema name.
 * @param payload - Structured input object for this operation.
 */
function validateResponseOutput(schemaName: string, payload: unknown): void {
  const recordPayload = assertRecordPayload(schemaName, payload);
  assertSchema(typeof recordPayload.message === "string", schemaName, "`message` must be a string.");
}

/**
 * Applies deterministic validity checks for reflection output.
 *
 * **Why it exists:**
 * Fails fast when reflection output is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param schemaName - Value for schema name.
 * @param payload - Structured input object for this operation.
 */
function validateReflectionOutput(schemaName: string, payload: unknown): void {
  const recordPayload = assertRecordPayload(schemaName, payload);
  assertSchema(Array.isArray(recordPayload.lessons), schemaName, "`lessons` must be an array.");
  const lessons = recordPayload.lessons as unknown[];
  for (const lesson of lessons) {
    assertSchema(typeof lesson === "string", schemaName, "each `lessons` entry must be a string.");
  }
}

/**
 * Validates success reflection model output.
 * Ensures `lesson` is a string and `nearMiss` is either a string or null.
 */
function validateSuccessReflectionOutput(schemaName: string, payload: unknown): void {
  const recordPayload = assertRecordPayload(schemaName, payload);
  assertSchema(typeof recordPayload.lesson === "string", schemaName, "`lesson` must be a string.");
  assertSchema(
    recordPayload.nearMiss === null || typeof recordPayload.nearMiss === "string",
    schemaName,
    "`nearMiss` must be a string or null."
  );
}

/**
 * Applies deterministic validity checks for governor output.
 *
 * **Why it exists:**
 * Fails fast when governor output is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param schemaName - Value for schema name.
 * @param payload - Structured input object for this operation.
 */
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

/**
 * Applies deterministic validity checks for autonomous next step output.
 *
 * **Why it exists:**
 * Fails fast when autonomous next step output is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param schemaName - Value for schema name.
 * @param payload - Structured input object for this operation.
 */
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

/**
 * Applies deterministic validity checks for proactive goal output.
 *
 * **Why it exists:**
 * Fails fast when proactive goal output is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param schemaName - Value for schema name.
 * @param payload - Structured input object for this operation.
 */
function validateProactiveGoalOutput(schemaName: string, payload: unknown): void {
  const recordPayload = assertRecordPayload(schemaName, payload);
  assertSchema(
    typeof recordPayload.proactiveGoal === "string",
    schemaName,
    "`proactiveGoal` must be a string."
  );
  assertSchema(typeof recordPayload.reasoning === "string", schemaName, "`reasoning` must be a string.");
}

/**
 * Applies deterministic validity checks for intent interpretation output.
 *
 * **Why it exists:**
 * Fails fast when intent interpretation output is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param schemaName - Value for schema name.
 * @param payload - Structured input object for this operation.
 */
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

/**
 * Applies deterministic validity checks for structured model output.
 *
 * **Why it exists:**
 * Fails fast when structured model output is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param schemaName - Value for schema name.
 * @param payload - Structured input object for this operation.
 */
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
  }
}

/**
 * Normalizes structured model output into a stable shape for `schemaValidation` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for structured model output so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param schemaName - Value for schema name.
 * @param payload - Structured input object for this operation.
 * @returns Computed `unknown` result.
 */
export function normalizeStructuredModelOutput(schemaName: string, payload: unknown): unknown {
  if (schemaName === "planner_v1") {
    return normalizePlannerPayload(payload);
  }

  return payload;
}
