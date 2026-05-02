/**
 * @fileoverview Deterministic planner action normalization and action-shape helpers.
 */

import { makeId } from "../../core/ids";
import { PlannedAction } from "../../core/types";
import {
  estimateActionCostUsd,
  estimateActionTypeBaseCostUsd
} from "../../core/actionCostPolicy";
import {
  defaultPlannerActionDescription,
  extractPlannerActionCandidates,
  isPlannerActionType,
  normalizePlannerActionParams,
  normalizePlannerActionTypeAlias,
  toPlannerRecord
} from "../../core/plannerActionSchema";

/**
 * Evaluates action type and returns a deterministic policy signal.
 */
export function isActionType(value: unknown): value is PlannedAction["type"] {
  return isPlannerActionType(value);
}

/**
 * Normalizes action type alias into a stable planner action type.
 */
export function normalizeActionTypeAlias(value: unknown): PlannedAction["type"] | null {
  return normalizePlannerActionTypeAlias(value);
}

/**
 * Derives cost for action from available runtime inputs.
 */
export function estimateCostForAction(type: PlannedAction["type"]): number {
  return estimateActionTypeBaseCostUsd(type);
}

/**
 * Returns the default description for action used when explicit config is absent.
 */
export function defaultDescriptionForAction(type: PlannedAction["type"]): string {
  return defaultPlannerActionDescription(type);
}

/**
 * Converts values into record form for consistent downstream use.
 */
export function toRecord(value: unknown): Record<string, unknown> | null {
  return toPlannerRecord(value);
}

/**
 * Derives action candidates from available runtime inputs.
 */
export function extractActionCandidates(output: unknown): unknown[] {
  return extractPlannerActionCandidates(output);
}

/**
 * Normalizes model actions into canonical deterministic actions.
 */
export function normalizeModelActions(actions: unknown): PlannedAction[] {
  if (!Array.isArray(actions)) {
    return [];
  }

  const normalized: PlannedAction[] = [];
  for (const item of actions) {
    const record = toRecord(item);
    if (!record) {
      continue;
    }
    const rawType = record.type ?? record.actionType ?? record.action ?? record.tool;
    const normalizedType = normalizeActionTypeAlias(rawType);
    if (!normalizedType || !isActionType(normalizedType)) {
      continue;
    }

    const description =
      typeof record.description === "string" && record.description.trim().length > 0
        ? record.description.trim()
        : defaultDescriptionForAction(normalizedType);

    const params = normalizePlannerActionParams(record, toRecord(record.params) ?? {});

    normalized.push({
      id: makeId("action"),
      type: normalizedType,
      description,
      params,
      estimatedCostUsd: estimateActionCostUsd({
        type: normalizedType,
        params
      })
    } as PlannedAction);
  }

  return normalized;
}

/**
 * Evaluates whether a respond action already carries user-facing text.
 */
export function hasRespondMessage(action: PlannedAction): boolean {
  if (action.type !== "respond") {
    return true;
  }

  const message = typeof action.params.message === "string" ? action.params.message.trim() : "";
  const text = typeof action.params.text === "string" ? action.params.text.trim() : "";
  return Boolean(message || text);
}
