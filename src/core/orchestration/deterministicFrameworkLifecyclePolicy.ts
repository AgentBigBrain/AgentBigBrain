/**
 * @fileoverview Shared orchestration policy for bounded deterministic framework live lifecycles.
 */

import { type TaskRunResult } from "../types";

/**
 * Returns whether a plan should preserve the full bounded deterministic framework live lifecycle.
 */
export function shouldPreserveDeterministicFrameworkLifecycleActions(
  plan: TaskRunResult["plan"],
  maxActionsPerTask: number
): boolean {
  if (plan.actions.length <= maxActionsPerTask) {
    return false;
  }
  if (!/deterministic_framework_build_(?:fallback|timeout_fallback)=/i.test(plan.plannerNotes)) {
    return false;
  }
  return plan.actions.some(
    (action) =>
      action.type === "start_process" ||
      action.type === "probe_http" ||
      action.type === "verify_browser" ||
      action.type === "open_browser"
  );
}

/**
 * Resolves the mission action limit for one plan while preserving bounded deterministic framework
 * live lifecycle steps.
 */
export function resolveDeterministicFrameworkLifecycleActionLimit(
  plan: TaskRunResult["plan"],
  maxActionsPerTask: number
): number {
  return shouldPreserveDeterministicFrameworkLifecycleActions(plan, maxActionsPerTask)
    ? Math.max(maxActionsPerTask, plan.actions.length)
    : maxActionsPerTask;
}
