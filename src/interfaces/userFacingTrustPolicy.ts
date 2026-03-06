/**
 * @fileoverview Shared trust-policy helpers for user-facing rendering of executed vs simulated side effects.
 */

import { TaskRunResult } from "../core/types";
import {
  createTrustLexicalRuleContext,
  isSimulatedOutput,
  TrustRenderClassification
} from "./trustLexicalClassifier";

/**
 * Default lexical trust-rule context used by user-facing trust checks.
 */
export const DEFAULT_TRUST_LEXICAL_RULE_CONTEXT = createTrustLexicalRuleContext(null);

/**
 * Checks whether a real (non-simulated) approved shell action executed in this run.
 *
 * @param runResult - Full task execution result.
 * @returns `true` when at least one approved real shell action exists.
 */
export function hasApprovedRealShellExecution(runResult: TaskRunResult): boolean {
  return runResult.actionResults.some(
    (result) =>
      result.approved &&
      result.action.type === "shell_command" &&
      !isSimulatedOutput(result.output ?? "", DEFAULT_TRUST_LEXICAL_RULE_CONTEXT)
  );
}

/**
 * Checks whether a real (non-simulated) approved non-respond action executed in this run.
 *
 * @param runResult - Full task execution result.
 * @returns `true` when at least one approved real non-respond action exists.
 */
export function hasApprovedRealNonRespondExecution(runResult: TaskRunResult): boolean {
  return runResult.actionResults.some(
    (result) =>
      result.approved &&
      isSideEffectActionType(result.action.type) &&
      !isSimulatedOutput(result.output ?? "", DEFAULT_TRUST_LEXICAL_RULE_CONTEXT)
  );
}

/**
 * Checks whether a simulated approved shell action executed in this run.
 *
 * @param runResult - Full task execution result.
 * @returns `true` when at least one approved simulated shell action exists.
 */
export function hasApprovedSimulatedShellExecution(runResult: TaskRunResult): boolean {
  return runResult.actionResults.some(
    (result) =>
      result.approved &&
      result.action.type === "shell_command" &&
      isSimulatedOutput(result.output ?? "", DEFAULT_TRUST_LEXICAL_RULE_CONTEXT)
  );
}

/**
 * Checks whether a simulated approved non-respond action executed in this run.
 *
 * @param runResult - Full task execution result.
 * @returns `true` when at least one approved simulated non-respond action exists.
 */
export function hasApprovedSimulatedNonRespondExecution(runResult: TaskRunResult): boolean {
  return runResult.actionResults.some(
    (result) =>
      result.approved &&
      isSideEffectActionType(result.action.type) &&
      isSimulatedOutput(result.output ?? "", DEFAULT_TRUST_LEXICAL_RULE_CONTEXT)
  );
}

/**
 * Detects whether blocked side-effect actions are unmatched by any approved action type.
 *
 * @param runResult - Full task execution result.
 * @returns `true` when optimistic respond text could mask blocked side-effect work.
 */
export function hasBlockedUnmatchedAction(runResult: TaskRunResult): boolean {
  const approvedRespondExists = runResult.actionResults.some(
    (result) => result.approved && result.action.type === "respond"
  );
  if (!approvedRespondExists) {
    return false;
  }

  // Prevent optimistic respond text from masking blocked side-effect actions.
  // If an action type is blocked and no action of that same type was approved,
  // prefer a blocked-policy explanation over free-form respond text.
  const approvedActionTypes = new Set(
    runResult.actionResults
      .filter((result) => result.approved)
      .map((result) => result.action.type)
  );
  return runResult.actionResults.some((result) => {
    if (result.approved || result.action.type === "respond") {
      return false;
    }
    return !approvedActionTypes.has(result.action.type);
  });
}

/**
 * Rewrites approved respond output according to the trust-render decision.
 *
 * @param selectedRespondOutput - Candidate respond text selected from approved actions.
 * @param classification - Trust-render decision and lexical evidence.
 * @returns Trust-safe respond output.
 */
export function resolveTrustAwareRespondOutput(
  selectedRespondOutput: string,
  classification: TrustRenderClassification
): string {
  if (classification.decision === "RENDER_APPROVED") {
    return selectedRespondOutput;
  }
  if (classification.decision === "RENDER_SIMULATED") {
    if (isSimulatedOutput(selectedRespondOutput, DEFAULT_TRUST_LEXICAL_RULE_CONTEXT)) {
      return selectedRespondOutput;
    }
    return (
      "This run executed simulated side-effect actions only. I can provide a simulated result, " +
      "but no real side-effect action was executed."
    );
  }
  if (classification.decision === "RENDER_UNCERTAIN") {
    return resolveTrustUncertainMessage(classification);
  }
  return selectedRespondOutput;
}

/**
 * Builds a deterministic no-overclaim message for uncertain trust classifications.
 *
 * @param classification - Trust-render decision and lexical evidence.
 * @returns User-facing uncertainty message tied to the matched claim type.
 */
function resolveTrustUncertainMessage(classification: TrustRenderClassification): string {
  if (classification.evidence.matchedRuleId.includes("browser_claim")) {
    return (
      "I cannot claim that I opened your browser in this run because no approved device-control " +
      "action executed. I can guide you step by step to open it manually."
    );
  }
  if (classification.evidence.matchedRuleId.includes("side_effect_claim")) {
    return (
      "I cannot claim side-effect work completed in this run because no approved non-respond " +
      "action executed. I can show proposed steps and approval diffs, then wait for explicit approval."
    );
  }
  return (
    "I cannot verify those side-effect claims in this run because execution evidence is uncertain. " +
    "I can list approved actions and separate them from unexecuted steps."
  );
}

/**
 * Returns `true` for action types that represent governed side-effect execution.
 *
 * Read-only actions (`read_file`, `list_directory`) are intentionally excluded so
 * latency/workflow no-op fallback logic is not bypassed by non-side-effect probes.
 *
 * @param actionType - Action type from an execution result.
 * @returns `true` when this action type should count as side-effect execution.
 */
function isSideEffectActionType(actionType: string): boolean {
  return (
    actionType !== "respond" &&
    actionType !== "read_file" &&
    actionType !== "list_directory" &&
    actionType !== "check_process" &&
    actionType !== "probe_port" &&
    actionType !== "probe_http" &&
    actionType !== "verify_browser"
  );
}
