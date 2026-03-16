/**
 * @fileoverview Canonical clarification-option helpers for human-centric execution ambiguity.
 */

import type { ActiveClarificationOption } from "../../interfaces/sessionStore";
import type { ExecutionIntentClarificationResolution } from "../../interfaces/conversationRuntime/executionIntentClarification";

const PLAN_OR_BUILD_OPTIONS: readonly ActiveClarificationOption[] = [
  { id: "plan", label: "Plan it first" },
  { id: "build", label: "Build it now" }
] as const;

const EXPLAIN_OR_EXECUTE_OPTIONS: readonly ActiveClarificationOption[] = [
  { id: "explain", label: "Explain it first" },
  { id: "fix_now", label: "Fix it now" }
] as const;

/**
 * Returns the canonical user-facing clarification options for one execution-intent ambiguity mode.
 *
 * @param mode - Clarification ambiguity family returned by the deterministic execution-intent matcher.
 * @returns Stable clarification options for persisted clarification state.
 */
export function resolveClarificationOptions(
  mode: ExecutionIntentClarificationResolution["mode"]
): readonly ActiveClarificationOption[] {
  switch (mode) {
    case "plan_or_build":
      return PLAN_OR_BUILD_OPTIONS;
    case "explain_or_execute":
      return EXPLAIN_OR_EXECUTE_OPTIONS;
    default:
      return [];
  }
}
