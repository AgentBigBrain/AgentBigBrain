/**
 * @fileoverview Shared trust-policy helpers for user-facing rendering of executed vs simulated side effects.
 */

import { ActionRunResult, TaskRunResult } from "../../core/types";
import { extractFirstPersonStatusUpdate } from "../diagnosticsPromptPolicy";
import {
  createTrustLexicalRuleContext,
  isSimulatedOutput,
  TrustRenderClassification
} from "../trustLexicalClassifier";

const STATUS_CONTRADICTION_CUE_PATTERNS: readonly RegExp[] = [
  /\b(?:my\s+records?|records?|memory|earlier)\b.*\b(?:show|shows|indicate|indicates)\b/i,
  /\bit\s+seems\s+there\s+might\s+be\s+a\s+misunderstanding\b/i
] as const;

/**
 * Default lexical trust-rule context used by user-facing trust checks.
 */
export const DEFAULT_TRUST_LEXICAL_RULE_CONTEXT = createTrustLexicalRuleContext(null);

/**
 * Returns `true` when an approved action has concrete execution evidence in this run.
 *
 * Legacy fixtures may omit `executionStatus`; treat that as a successful execution so existing
 * evidence-based rendering remains stable while still excluding explicit runtime failures.
 */
function didApprovedActionExecute(result: ActionRunResult): boolean {
  return (
    result.approved &&
    (result.executionStatus === undefined || result.executionStatus === "success")
  );
}

/**
 * Checks whether a real (non-simulated) approved shell action executed in this run.
 */
export function hasApprovedRealShellExecution(runResult: TaskRunResult): boolean {
  return runResult.actionResults.some(
    (result) =>
      didApprovedActionExecute(result) &&
      result.action.type === "shell_command" &&
      !isSimulatedOutput(result.output ?? "", DEFAULT_TRUST_LEXICAL_RULE_CONTEXT)
  );
}

/**
 * Checks whether a real (non-simulated) approved non-respond action executed in this run.
 */
export function hasApprovedRealNonRespondExecution(runResult: TaskRunResult): boolean {
  return runResult.actionResults.some(
    (result) =>
      didApprovedActionExecute(result) &&
      isSideEffectActionType(result.action.type) &&
      !isSimulatedOutput(result.output ?? "", DEFAULT_TRUST_LEXICAL_RULE_CONTEXT)
  );
}

/**
 * Checks whether a simulated approved shell action executed in this run.
 */
export function hasApprovedSimulatedShellExecution(runResult: TaskRunResult): boolean {
  return runResult.actionResults.some(
    (result) =>
      didApprovedActionExecute(result) &&
      result.action.type === "shell_command" &&
      isSimulatedOutput(result.output ?? "", DEFAULT_TRUST_LEXICAL_RULE_CONTEXT)
  );
}

/**
 * Checks whether a simulated approved non-respond action executed in this run.
 */
export function hasApprovedSimulatedNonRespondExecution(runResult: TaskRunResult): boolean {
  return runResult.actionResults.some(
    (result) =>
      didApprovedActionExecute(result) &&
      isSideEffectActionType(result.action.type) &&
      isSimulatedOutput(result.output ?? "", DEFAULT_TRUST_LEXICAL_RULE_CONTEXT)
  );
}

/**
 * Detects whether blocked side-effect actions are unmatched by any approved action type.
 */
export function hasBlockedUnmatchedAction(runResult: TaskRunResult): boolean {
  const approvedRespondExists = runResult.actionResults.some(
    (result) => result.approved && result.action.type === "respond"
  );
  if (!approvedRespondExists) {
    return false;
  }

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
 * Normalizes respond text when the user supplied a first-person status update that conflicts with it.
 */
export function resolveStatusContradictionSafeOutput(
  runResult: TaskRunResult,
  selectedRespondOutput: string
): string {
  const statusUpdate = extractFirstPersonStatusUpdate(runResult.task.userInput);
  if (!statusUpdate) {
    return selectedRespondOutput;
  }
  const hasContradictionCue = STATUS_CONTRADICTION_CUE_PATTERNS.some((pattern) =>
    pattern.test(selectedRespondOutput)
  );
  if (!hasContradictionCue) {
    return selectedRespondOutput;
  }

  return [
    `Noted: ${statusUpdate}.`,
    "I will treat this as the latest status for this turn.",
    "If needed, I can help with the next step."
  ].join(" ");
}

/**
 * Builds a deterministic no-overclaim message for uncertain trust classifications.
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
