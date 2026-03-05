/**
 * @fileoverview Provides deterministic immutable-target extraction helpers for hard policy checks.
 */

import { TaskRunResult } from "./types";

/**
 * Normalizes optional string values for immutable-target extraction.
 *
 * **Why it exists:**
 * Keeps optional target parsing deterministic when policy checks inspect action params.
 *
 * **What it talks to:**
 * - Local string operations only; no cross-module collaborators.
 *
 * @param value - Unknown metadata value that may contain a target string.
 * @returns Trimmed target string, or empty when missing/invalid.
 */
function normalizeTargetString(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

/**
 * Derives immutable-target text from a planned action.
 *
 * **Why it exists:**
 * Centralizes how policy checks interpret action target hints before immutable keyword scanning.
 *
 * **What it talks to:**
 * - Uses `TaskRunResult` action union from `./types`.
 *
 * @param action - Planned action whose target metadata may imply immutable-control-plane edits.
 * @returns Target text used for immutable-keyword checks, or empty when unavailable.
 */
export function extractImmutableTarget(
  action: TaskRunResult["plan"]["actions"][number]
): string {
  switch (action.type) {
    case "self_modify":
      return normalizeTargetString(action.params.target);
    case "shell_command":
      return normalizeTargetString(action.params.target);
    default:
      return "";
  }
}

/**
 * Checks whether action metadata explicitly flags immutable-target intent.
 *
 * **Why it exists:**
 * Keeps explicit immutable-touch detection consistent across policy paths.
 *
 * **What it talks to:**
 * - Uses `TaskRunResult` action union from `./types`.
 *
 * @param action - Planned action under immutable-policy review.
 * @returns `true` when action explicitly sets `touchesImmutable=true`.
 */
export function hasExplicitImmutableTouch(
  action: TaskRunResult["plan"]["actions"][number]
): boolean {
  return action.type === "self_modify" && action.params.touchesImmutable === true;
}
