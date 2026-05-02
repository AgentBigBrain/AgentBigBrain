/**
 * @fileoverview Shared planner-action schema helpers used by model-boundary validation and planner normalization.
 */

import { ActionType } from "./types";
import { SHELL_TIMEOUT_MS_BOUNDS } from "./shellRuntimeProfile";
import {
  getPlannerActionAliasCompatibilityDiagnostic,
  getPlannerActionDefinition,
  isRegisteredPlannerActionType,
  normalizePlannerActionAlias,
  type PlannerActionAliasCompatibilityDiagnostic
} from "./actionDefinitionRegistry";

export { getPlannerActionAliasCompatibilityDiagnostic };
export type { PlannerActionAliasCompatibilityDiagnostic };

/**
 * Converts values into planner record form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for planner record deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `Record<string, unknown> | null` result.
 */
export function toPlannerRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Evaluates planner action type and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the planner action type policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `ActionType` (import `ActionType`) from `./types`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is ActionType` result.
 */
export function isPlannerActionType(value: unknown): value is ActionType {
  return isRegisteredPlannerActionType(value);
}

/**
 * Normalizes planner action type alias into a stable shape for `plannerActionSchema` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for planner action type alias so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `ActionType` (import `ActionType`) from `./types`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `ActionType | null` result.
 */
export function normalizePlannerActionTypeAlias(value: unknown): ActionType | null {
  return normalizePlannerActionAlias(value);
}

/**
 * Returns the default planner action description used when explicit config is absent.
 *
 * **Why it exists:**
 * Keeps fallback defaults for planner action description centralized so unset-config behavior is predictable.
 *
 * **What it talks to:**
 * - Uses `ActionType` (import `ActionType`) from `./types`.
 *
 * @param type - Value for type.
 * @returns Resulting string value.
 */
export function defaultPlannerActionDescription(type: ActionType): string {
  return getPlannerActionDefinition(type).description;
}

/**
 * Derives planner action candidates from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for planner action candidates in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param payload - Structured input object for this operation.
 * @returns Ordered collection produced by this step.
 */
export function extractPlannerActionCandidates(payload: unknown): unknown[] {
  const record = toPlannerRecord(payload);
  if (!record) {
    return [];
  }

  if (Array.isArray(record.actions)) {
    return record.actions;
  }

  if (record.action !== undefined) {
    return [record.action];
  }

  if (Array.isArray(record.steps)) {
    return record.steps;
  }

  return [];
}

/**
 * Normalizes planner action params into a stable shape for `plannerActionSchema` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for planner action params so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param actionRecord - Value for action record.
 * @param existingParams - Structured input object for this operation.
 * @returns Computed `Record<string, unknown>` result.
 */
export function normalizePlannerActionParams(
  actionRecord: Record<string, unknown>,
  existingParams: Record<string, unknown>
): Record<string, unknown> {
  const params = Object.fromEntries(
    Object.entries(existingParams).filter(([, value]) => value !== null && value !== undefined)
  );
  const stringFields = [
    "message",
    "text",
    "name",
    "kind",
    "code",
    "instructions",
    "markdownContent",
    "content",
    "reason",
    "path",
    "command",
    "cwd",
    "workdir",
    "requestedShellKind",
    "leaseId",
    "host",
    "url",
    "expectedTitle",
    "expectedText",
    "sessionId",
    "rootPath",
    "previewUrl",
    "browserSessionId",
    "previewProcessLeaseId"
  ] as const;
  for (const field of stringFields) {
    if (typeof actionRecord[field] === "string" && typeof params[field] !== "string") {
      params[field] = actionRecord[field];
    }
  }

  const numberFields = ["port", "timeoutMs", "expectedStatus", "pid"] as const;
  for (const field of numberFields) {
    if (typeof actionRecord[field] === "number" && typeof params[field] !== "number") {
      params[field] =
        field === "timeoutMs"
          ? normalizePlannerTimeoutMs(actionRecord[field])
          : actionRecord[field];
    }
  }

  if (typeof params.timeoutMs === "number") {
    params.timeoutMs = normalizePlannerTimeoutMs(params.timeoutMs);
  }

  return params;
}

/**
 * Clamps planner-supplied timeout values into the runtime-supported bounded integer range.
 */
function normalizePlannerTimeoutMs(timeoutMs: number): number {
  const roundedTimeoutMs = Math.round(timeoutMs);
  if (!Number.isFinite(roundedTimeoutMs)) {
    return SHELL_TIMEOUT_MS_BOUNDS.min;
  }
  if (roundedTimeoutMs < SHELL_TIMEOUT_MS_BOUNDS.min) {
    return SHELL_TIMEOUT_MS_BOUNDS.min;
  }
  if (roundedTimeoutMs > SHELL_TIMEOUT_MS_BOUNDS.max) {
    return SHELL_TIMEOUT_MS_BOUNDS.max;
  }
  return roundedTimeoutMs;
}
