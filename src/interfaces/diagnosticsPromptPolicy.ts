/**
 * @fileoverview Applies deterministic diagnostics and verification prompt routing policy for user-facing summaries.
 */

import { extractActiveRequestSegment } from "../core/currentRequestExtraction";
import {
  isVerificationClaimPrompt,
  resolveVerificationCategoryFromPrompt
} from "../core/verificationPromptClassifier";
import { TaskRunResult, VerificationCategoryV1 } from "../core/types";
import {
  classifyRoutingIntentV1,
  isDiagnosticsRoutingClassification
} from "./routingMap";

const MISSION_DIAGNOSTIC_PROMPT_PATTERNS: readonly RegExp[] = [
  /\bwhat\s+will\s+run\b/i,
  /\bwhat\s+ran\b/i,
  /\bordered\s+mission\s+timeline\b/i
] as const;
const APPROVAL_FLOW_PROMPT_PATTERNS: readonly RegExp[] = [
  /\bapproval\s+diff\b/i,
  /\bstep-level\s+approval\b/i,
  /\bwait(?:ing)?\s+for\s+approval\b/i
] as const;
const FIRST_PERSON_STATUS_UPDATE_CAPTURE_PATTERN =
  /\b(my\s+[a-z0-9][a-z0-9_.\-/\s]{0,120}\s+is\s+[a-z0-9][^.!?\n]{0,120})/i;

/**
 * Extracts the active request segment used for diagnostics decisions.
 *
 * **Why it exists:**
 * Keeps diagnostics prompt checks pinned to the active request segment, not historical wrapper context.
 *
 * **What it talks to:**
 * - Uses `extractActiveRequestSegment` from `../core/currentRequestExtraction`.
 *
 * @param userInput - Wrapped runtime input string that may include conversation context markers.
 * @returns Active request segment used by diagnostics and verification checks.
 */
function extractCurrentRequestForDiagnostics(userInput: string): string {
  return extractActiveRequestSegment(userInput);
}

/**
 * Checks whether prompt should trigger mission diagnostics rendering.
 *
 * **Why it exists:**
 * Keeps mission-diagnostics detection deterministic across user-facing rendering paths.
 *
 * **What it talks to:**
 * - Uses routing-map diagnostics classification (`classifyRoutingIntentV1`, `isDiagnosticsRoutingClassification`).
 * - Uses shared verification-claim classification (`isVerificationClaimPrompt`).
 *
 * @param userInput - Wrapped runtime input string for the current request.
 * @returns `true` when diagnostics output should be rendered.
 */
export function containsMissionDiagnosticPrompt(userInput: string): boolean {
  const textToCheck = extractCurrentRequestForDiagnostics(userInput);
  if (MISSION_DIAGNOSTIC_PROMPT_PATTERNS.some((pattern) => pattern.test(textToCheck))) {
    return true;
  }
  const routingClassification = classifyRoutingIntentV1(textToCheck);
  if (isDiagnosticsRoutingClassification(routingClassification)) {
    return true;
  }
  return isVerificationClaimPrompt(textToCheck);
}

/**
 * Checks whether prompt asks for approval-flow details.
 *
 * **Why it exists:**
 * Keeps approval-diff and step-approval detection deterministic for diagnostics composition.
 *
 * **What it talks to:**
 * - Uses local approval-flow regex patterns.
 *
 * @param userInput - Wrapped runtime input string for the current request.
 * @returns `true` when approval-flow diagnostics should be included.
 */
export function containsApprovalFlowPrompt(userInput: string): boolean {
  const textToCheck = extractCurrentRequestForDiagnostics(userInput);
  return APPROVAL_FLOW_PROMPT_PATTERNS.some((pattern) => pattern.test(textToCheck));
}

/**
 * Extracts first-person status statement from the active request segment.
 *
 * **Why it exists:**
 * Supports contradiction-safe rendering by preferring user-authored status updates in the same turn.
 *
 * **What it talks to:**
 * - Uses local first-person status capture regex.
 *
 * @param userInput - Wrapped runtime input string for the current request.
 * @returns Extracted status clause, or `null` when no status statement is present.
 */
export function extractFirstPersonStatusUpdate(userInput: string): string | null {
  const normalized = extractCurrentRequestForDiagnostics(userInput);
  const match = FIRST_PERSON_STATUS_UPDATE_CAPTURE_PATTERN.exec(normalized);
  if (!match) {
    return null;
  }
  const extracted = match[1]?.replace(/\s+/g, " ").trim() ?? "";
  return extracted.length > 0 ? extracted : null;
}

/**
 * Resolves Stage 6.85 verification category for a wrapped prompt.
 *
 * **Why it exists:**
 * Ensures user-facing diagnostics and task-runner verification gates classify prompts with the same category rules.
 *
 * **What it talks to:**
 * - Uses shared verification category classifier (`resolveVerificationCategoryFromPrompt`).
 *
 * @param userInput - Wrapped runtime input string for the current request.
 * @returns Deterministic verification category for Stage 6.85 gate evaluation.
 */
export function resolveVerificationCategoryForPrompt(
  userInput: string
): VerificationCategoryV1 {
  const promptText = extractCurrentRequestForDiagnostics(userInput);
  return resolveVerificationCategoryFromPrompt(promptText);
}

/**
 * Checks whether diagnostics path should evaluate Stage 6.85 verification gate.
 *
 * **Why it exists:**
 * Keeps verification-gate rendering activation deterministic for explicit claim prompts and blocked gate outcomes.
 *
 * **What it talks to:**
 * - Uses shared verification-claim classifier (`isVerificationClaimPrompt`).
 * - Uses `TaskRunResult` action outcomes for blocked-code inspection.
 *
 * @param runResult - Completed task result used to compute user-facing diagnostics.
 * @returns `true` when verification-gate diagnostics should be evaluated and rendered.
 */
export function shouldEvaluateVerificationGateForDiagnostics(
  runResult: TaskRunResult
): boolean {
  const currentRequest = extractCurrentRequestForDiagnostics(runResult.task.userInput);
  if (isVerificationClaimPrompt(currentRequest)) {
    return true;
  }
  return runResult.actionResults.some(
    (result) =>
      result.blockedBy.includes("VERIFICATION_GATE_FAILED") ||
      result.violations.some((violation) => violation.code === "VERIFICATION_GATE_FAILED")
  );
}
