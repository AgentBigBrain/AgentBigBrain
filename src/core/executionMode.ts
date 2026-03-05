/**
 * @fileoverview Maps planned actions to execution modes (fast path vs escalation path).
 */

import { BrainConfig } from "./config";
import { ExecutionMode, PlannedAction } from "./types";

/**
 * Resolves execution mode from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of execution mode by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `BrainConfig` (import `BrainConfig`) from `./config`.
 * - Uses `ExecutionMode` (import `ExecutionMode`) from `./types`.
 * - Uses `PlannedAction` (import `PlannedAction`) from `./types`.
 *
 * @param action - Value for action.
 * @param config - Configuration or policy settings applied here.
 * @returns Computed `ExecutionMode` result.
 */
export function resolveExecutionMode(action: PlannedAction, config: BrainConfig): ExecutionMode {
  if (config.governance.escalationActionTypes.includes(action.type)) {
    return "escalation_path";
  }

  return "fast_path";
}
