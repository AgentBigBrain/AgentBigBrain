/**
 * @fileoverview Deterministic no-op and progress-placeholder policy helpers for user-facing output rendering.
 */

import { TaskRunResult } from "../core/types";
import { extractActiveRequestSegment } from "../core/currentRequestExtraction";
import {
  classifyRoutingIntentV1,
  RoutingMapClassificationV1
} from "./routingMap";
import {
  buildUserFacingEnvelopeV1,
  renderUserFacingEnvelopeV1
} from "./userFacingContracts";

const STAGE_REVIEW_PROGRESS_PROMPT_PATTERNS: readonly RegExp[] = [
  /\bclone-assisted\b/i,
  /\bnon-mergeable\s+clone\b/i,
  /\bdurable\s+checkpoint\b/i,
  /\bretry\s+budget\b/i,
  /\bmission\s+stop\s+limit\b/i,
  /\blatency\s+budgets?\b/i,
  /\bcache\s+paths?\b/i,
  /\bredacted\s+evidence\s+bundle\b/i,
  /\bworkflow\b.*\breplay\b/i
] as const;
const PROGRESS_PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /\bworking on it\b/i,
  /\bplease hold on(?: for a moment)?\b/i,
  /\bI will .*?\b(?:shortly|soon|in a moment)\b/i,
  /\bI will send (?:you\s+)?(?:the\s+)?result when (?:it|this) is done\b/i,
  /\bI (?:am|\'m)\s+(?:currently\s+)?(?:working|researching|building|processing|gathering)\b/i,
  /\bkeep you updated on the progress\b/i,
  /\bwhile I process this\b/i
] as const;
const FUTURE_PROMISE_PROGRESS_PATTERN =
  /^\s*(?:thank you[!,]?\s+)?(?:understood[!,]?\s+)?i\s+will\s+(?:keep|monitor|proceed|begin|capture|compile|retry|continue|generate|build|research|export|schedule|ensure|reuse|attempt|conduct)\b/i;
const TERMINAL_RESPONSE_SIGNAL_PATTERNS: readonly RegExp[] = [
  /\bmission diagnostics:\b/i,
  /\bsafety code\(s\):\b/i,
  /\brun skill success:\b/i,
  /\bskill status:\b/i
] as const;
const EXECUTION_REQUEST_PROMPT_PATTERNS: readonly RegExp[] = [
  /^\s*(build|create|schedule|capture|compile|run|export|retry|continue|generate|research)\b/i,
  /\bbefore\s+any\s+write\b/i,
  /\bshow\s+exact\s+approval\s+diff\b/i,
  /\bwait\s+for\s+step-level\s+approval\b/i,
  /\bkeep\b.*\blatency\s+budgets?\b/i,
  /\breuse\b.*\bcache\s+paths?\b/i
] as const;
const EXPLANATION_REQUEST_PROMPT_PATTERNS: readonly RegExp[] = [
  /^\s*how\s+(?:do|can)\s+i\b/i,
  /^\s*how\s+to\b/i,
  /^\s*explain\b/i,
  /^\s*what\s+is\b/i,
  /\bguide\s+me\b/i
] as const;
const INSTRUCTIONAL_HOWTO_RESPONSE_PATTERNS: readonly RegExp[] = [
  /\bfollow\s+these\s+steps\b/i,
  /\bto\s+(?:build|capture|create|set\s+up)\b[\s\S]{0,120}\bfollow\s+these\s+steps\b/i
] as const;
const CLARIFICATION_LOOP_RESPONSE_PATTERNS: readonly RegExp[] = [
  /\bi\s+understand\s+(?:that\s+)?you\s+want\b/i,
  /\bcould you please\b/i,
  /\bplease provide\b/i,
  /\bplease provide more information\b/i,
  /\bplease confirm\b/i,
  /\bplease let me know\b/i,
  /\bcan you clarify\b/i,
  /\bi need to clarify\b/i,
  /\bany specific details\b/i,
  /\bspecify\b/i
] as const;
const EXECUTION_NOOP_RESPONSE_PATTERNS: readonly RegExp[] = [
  /\b(?:i\s+cannot|i\s+can't|cannot|can't)\b[\s\S]{0,180}\b(?:execute|perform|run|complete|capture|compile|schedule|build)\b[\s\S]{0,120}\bin this run\b/i,
  /\bi\s+(?:could not|couldn't)\b[\s\S]{0,180}\b(?:execute|perform|run|complete|capture|compile|schedule|build)\b[\s\S]{0,120}\bin this run\b/i,
  /\bunable to\b[\s\S]{0,180}\b(?:execute|perform|run|complete|capture|compile|schedule|build)\b[\s\S]{0,120}\bin this run\b/i,
  /\b(?:i\s+cannot|i\s+can't|cannot|can't)\b[\s\S]{0,180}\b(?:execute|perform|run|complete|capture|compile|schedule|build)\b[\s\S]{0,180}\b(?:without\s+further\s+details|without\s+more\s+information|unless\s+you\s+provide|please\s+provide\s+more\s+information)\b/i
] as const;
const EXECUTION_CAPABILITY_LIMITATION_RESPONSE_PATTERNS: readonly RegExp[] = [
  /\bi\s+understand\s+(?:that\s+)?you\s+want\b[\s\S]{0,220}\b(?:cannot|can't)\b[\s\S]{0,220}\b(?:execute|perform|run|complete|capture|compile|schedule|build|export)\b/i,
  /\bi\s+can\s+assist\b[\s\S]{0,220}\bhowever\b[\s\S]{0,220}\b(?:cannot|can't)\b[\s\S]{0,220}\b(?:execute|perform|run|complete|capture|compile|schedule|build|export)\b/i,
  /\b(?:current\s+system\s+limitations|safety\s+polic(?:y|ies)\s+in\s+place)\b[\s\S]{0,220}\b(?:cannot|can't)\b[\s\S]{0,220}\b(?:execute|perform|run|complete|capture|compile|schedule|build|export)\b/i,
  /\b(?:cannot|can't)\b[\s\S]{0,200}\b(?:execute|retry|resume)\b[\s\S]{0,200}\b(?:side[-\s]?effects?|retry\s+actions?)\b[\s\S]{0,120}\b(?:directly|in\s+this\s+context)\b/i,
  /\b(?:cannot|can't)\s+execute\s+this\s+action\s+directly\b/i,
  /\b(?:cannot|can't)\s+execute\s+this\s+request\s+directly\b/i
] as const;
const NUMBERED_STEP_LINE_PATTERN = /^\s*\d+\.\s+/gm;
const OBSERVABILITY_BUNDLE_EXPORT_PROMPT_PATTERNS: readonly RegExp[] = [
  /\bexport\b[\s\S]{0,120}\bevidence\s+bundle\b/i,
  /\bredacted\s+evidence\s+bundle\b/i
] as const;

type ProgressPlaceholderFallbackCategory =
  | "build"
  | "research"
  | "workflow_replay"
  | "clone_workflow"
  | "recovery"
  | "latency"
  | "observability"
  | "communication";

/**
 * Returns a deterministic policy-explanation response for routing categories that require one.
 *
 * @param classification - Routing classification derived from the current user request.
 * @returns A policy explanation response, or `null` when no explanation override applies.
 */
export function resolveRoutingPolicyExplanation(
  classification: RoutingMapClassificationV1
): string | null {
  if (classification.category !== "CLONE_BLOCK_REASONS") {
    return null;
  }
  return [
    "Non-mergeable clone packet kinds are blocked to preserve deterministic safety and provenance.",
    "Blocked kinds: secrets, raw external text payloads, and uncontrolled executable instructions.",
    "Mergeable kinds: plan variants, selector strategies, test ideas, and lessons that pass governed merge rules.",
    "Next step: request explicit safe-packet merge criteria and rerun clone-assisted generation."
  ].join(" ");
}

/**
 * Returns deterministic no-op/unsupported responses for execution-surface routing categories.
 *
 * @param classification - Routing classification derived from the current user request.
 * @returns Rendered fallback response text, or `null` when no execution-surface fallback applies.
 */
export function resolveExecutionSurfaceFallbackFromRouting(
  classification: RoutingMapClassificationV1
): string | null {
  switch (classification.category) {
    case "SCHEDULE_FOCUS_BLOCKS":
      return renderUserFacingEnvelopeV1(
        buildUserFacingEnvelopeV1(
          "UNSUPPORTED",
          "I couldn't execute calendar scheduling in this run.",
          classification.fallbackReasonCode ?? "CALENDAR_PROPOSE_NOT_AVAILABLE",
          "Request a governed calendar propose step and approve the exact diff before any write."
        )
      );
    case "BUILD_SCAFFOLD":
      return buildDeterministicNoOpTemplate(
        classification.fallbackReasonCode ?? "BUILD_NO_SIDE_EFFECT_EXECUTED",
        "No governed build side-effect action was approved and executed in this run.",
        "Ask for the exact approval diff and approve the required build step, or request a guidance-only response."
      );
    case "CLONE_VARIANTS":
      return buildDeterministicNoOpTemplate(
        classification.fallbackReasonCode ?? "CLONE_WORKFLOW_NO_SIDE_EFFECT_EXECUTED",
        "No governed clone-workflow side-effect action executed in this run.",
        "Request clone-assisted plan generation with explicit safe-packet merge criteria, then rerun."
      );
    case "WORKFLOW_REPLAY":
      return buildDeterministicNoOpTemplate(
        classification.fallbackReasonCode ?? "WORKFLOW_REPLAY_NO_SIDE_EFFECT_EXECUTED",
        "No governed computer-use workflow action was approved and executed in this run.",
        "Request capture/compile/replay as governed actions and approve the required step-level diff."
      );
    case "RECOVERY_RESUME":
      return buildDeterministicNoOpTemplate(
        classification.fallbackReasonCode ?? "RECOVERY_NO_SIDE_EFFECT_EXECUTED",
        "No governed retry or resume side-effect action executed in this run.",
        "Request mission diagnostics or retry metadata for a concrete blocked step, then rerun recovery checks."
      );
    case "LATENCY_BUDGETS":
      return buildDeterministicNoOpTemplate(
        classification.fallbackReasonCode ?? "LATENCY_NO_SIDE_EFFECT_EXECUTED",
        "No governed latency-verification side-effect action executed in this run.",
        "Request phase-budget diagnostics for an active mission run or execute the latency checkpoint runner."
      );
    case "OBSERVABILITY_EXPORT":
      return buildDeterministicNoOpTemplate(
        classification.fallbackReasonCode ?? "OBSERVABILITY_NO_SIDE_EFFECT_EXECUTED",
        "No governed evidence-export side-effect action executed in this run.",
        "Run the stage evidence export command or request mission timeline diagnostics for the last completed run."
      );
    case "NONE":
    case "DIAGNOSTICS_STATUS":
    case "DIAGNOSTICS_APPROVAL_DIFF":
    case "CLONE_BLOCK_REASONS":
    default:
      return null;
  }
}

/**
 * Returns `true` when the prompt is execution-style rather than explanation-only.
 *
 * @param userInput - Raw task user input, potentially including conversation wrappers.
 * @returns `true` when execution-style intent patterns match.
 */
export function isExecutionStyleRequestPrompt(userInput: string): boolean {
  const normalized = extractCurrentRequestForDiagnostics(userInput);
  if (!normalized) {
    return false;
  }
  if (EXPLANATION_REQUEST_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  return EXECUTION_REQUEST_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Returns `true` when a response is primarily instructional "how-to" text.
 *
 * @param text - Candidate response text.
 * @returns `true` when instructional patterns/numbered steps indicate how-to guidance.
 */
export function isInstructionalHowToResponse(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  if (INSTRUCTIONAL_HOWTO_RESPONSE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  const numberedStepMatches = normalized.match(NUMBERED_STEP_LINE_PATTERN) ?? [];
  return numberedStepMatches.length >= 3;
}

/**
 * Returns `true` when a response appears to be a clarification loop prompt.
 *
 * @param text - Candidate response text.
 * @returns `true` when clarification-loop lexical patterns are present.
 */
export function isClarificationLoopResponse(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  return CLARIFICATION_LOOP_RESPONSE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Returns `true` when response text admits no execution occurred in the run.
 *
 * @param text - Candidate response text.
 * @returns `true` when execution no-op lexical patterns are present.
 */
export function isExecutionNoOpResponse(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  return EXECUTION_NOOP_RESPONSE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Returns `true` when response text describes capability limitations for execution.
 *
 * @param text - Candidate response text.
 * @returns `true` when capability-limitation lexical patterns are present.
 */
export function isExecutionCapabilityLimitationResponse(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  return EXECUTION_CAPABILITY_LIMITATION_RESPONSE_PATTERNS.some((pattern) =>
    pattern.test(normalized)
  );
}

/**
 * Detects progress-placeholder response text that should be replaced with deterministic fallback text.
 *
 * @param text - Candidate response text.
 * @param userInput - Raw task user input, potentially including conversation wrappers.
 * @returns `true` when the response is a progress placeholder.
 */
export function isProgressPlaceholderResponse(text: string, userInput: string): boolean {
  const normalized = text.trim();
  const promptText = extractCurrentRequestForDiagnostics(userInput);
  if (!normalized) {
    return false;
  }
  if (TERMINAL_RESPONSE_SIGNAL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return false;
  }
  if (PROGRESS_PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  if (
    FUTURE_PROMISE_PROGRESS_PATTERN.test(normalized) &&
    (STAGE_REVIEW_PROGRESS_PROMPT_PATTERNS.some((pattern) => pattern.test(promptText)) ||
      isExecutionStyleRequestPrompt(userInput))
  ) {
    return true;
  }
  return false;
}

/**
 * Produces deterministic fallback text when a response is only progress chatter.
 *
 * @param runResult - Full task execution result.
 * @param hasTechnicalOutcomeLine - Whether technical status lines will be appended.
 * @param hasApprovedRealNonRespondExecution - Whether real side-effect actions executed.
 * @returns Deterministic fallback response.
 */
export function resolveProgressPlaceholderFallback(
  runResult: TaskRunResult,
  hasTechnicalOutcomeLine: boolean,
  hasApprovedRealNonRespondExecution: boolean
): string {
  if (hasTechnicalOutcomeLine) {
    return "This run finished, but the drafted chat reply was only a progress update. Here is the deterministic execution status:";
  }

  if (hasApprovedRealNonRespondExecution) {
    return (
      "This run finished, but the drafted chat reply was only a progress update. " +
      "Side-effect actions executed through governed runtime paths."
    );
  }

  const category = resolveProgressPlaceholderFallbackCategory(runResult.task.userInput);
  switch (category) {
    case "research":
      return resolveResearchNoOpFallback(runResult.task.userInput);
    case "build":
      return buildDeterministicNoOpTemplate(
        "BUILD_NO_SIDE_EFFECT_EXECUTED",
        "No governed build side-effect action was approved and executed in this run.",
        "Ask for the exact approval diff and approve the required build step, or request a guidance-only response."
      );
    case "workflow_replay":
      return buildDeterministicNoOpTemplate(
        "WORKFLOW_REPLAY_NO_SIDE_EFFECT_EXECUTED",
        "No governed computer-use workflow action was approved and executed in this run.",
        "Request capture/compile/replay as governed actions and approve the required step-level diff."
      );
    case "clone_workflow":
      return buildDeterministicNoOpTemplate(
        "CLONE_WORKFLOW_NO_SIDE_EFFECT_EXECUTED",
        "No governed clone-workflow side-effect action executed in this run.",
        "Request clone-assisted plan generation with explicit safe-packet merge criteria, then rerun."
      );
    case "recovery":
      return buildDeterministicNoOpTemplate(
        "RECOVERY_NO_SIDE_EFFECT_EXECUTED",
        "No governed retry or resume side-effect action executed in this run.",
        "Request mission diagnostics or retry metadata for a concrete blocked step, then rerun recovery checks."
      );
    case "latency":
      return buildDeterministicNoOpTemplate(
        "LATENCY_NO_SIDE_EFFECT_EXECUTED",
        "No governed latency-verification side-effect action executed in this run.",
        "Request phase-budget diagnostics for an active mission run or execute the latency checkpoint runner."
      );
    case "observability":
      return buildDeterministicNoOpTemplate(
        "OBSERVABILITY_NO_SIDE_EFFECT_EXECUTED",
        "No governed evidence-export side-effect action executed in this run.",
        "Run the stage evidence export command or request mission timeline diagnostics for the last completed run."
      );
    case "communication":
    default:
      return buildDeterministicNoOpTemplate(
        "COMMUNICATION_NO_SIDE_EFFECT_EXECUTED",
        "No governed side-effect action executed in this run, so no finalized side-effect result can be reported.",
        "Use /status for current state, or request an approval diff and approve a governed action."
      );
  }
}

/**
 * Returns `true` when the active request explicitly asks to export a redacted evidence bundle.
 *
 * @param userInput - Raw task user input, potentially including conversation wrappers.
 * @returns `true` when bundle-export lexical patterns are present in the active request segment.
 */
export function isObservabilityBundleExportPrompt(userInput: string): boolean {
  const normalized = extractCurrentRequestForDiagnostics(userInput);
  if (!normalized) {
    return false;
  }
  return OBSERVABILITY_BUNDLE_EXPORT_PROMPT_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Extracts only the active request segment from wrapped interface input for policy matching.
 *
 * @param userInput - Raw task user input, potentially including conversation wrappers.
 * @returns Active request segment used by deterministic lexical policy checks.
 */
function extractCurrentRequestForDiagnostics(userInput: string): string {
  return extractActiveRequestSegment(userInput);
}

/**
 * Builds a deterministic no-op envelope with a caller-supplied reason.
 *
 * @param reasonCode - Typed no-op reason code.
 * @param reason - Human-readable reason text.
 * @param nextStep - Deterministic remediation guidance.
 * @returns Rendered `NO_OP` envelope text.
 */
function buildDeterministicNoOpTemplate(
  reasonCode: string,
  reason: string,
  nextStep: string
): string {
  return renderUserFacingEnvelopeV1(
    buildUserFacingEnvelopeV1(
      "NO_OP",
      "I couldn't execute that side-effect in this run.",
      reasonCode,
      nextStep
    )
  ).replace("- reason: I couldn't execute that side-effect in this run.", `- reason: ${reason}`);
}

/**
 * Derives deterministic fallback category for progress-placeholder replacement.
 *
 * @param userInput - Raw task user input, potentially including conversation wrappers.
 * @returns No-op fallback category used for response rewriting.
 */
function resolveProgressPlaceholderFallbackCategory(
  userInput: string
): ProgressPlaceholderFallbackCategory {
  const routingClassification = classifyRoutingIntentV1(userInput);
  switch (routingClassification.category) {
    case "BUILD_SCAFFOLD":
      return "build";
    case "CLONE_VARIANTS":
      return "clone_workflow";
    case "WORKFLOW_REPLAY":
      return "workflow_replay";
    case "RECOVERY_RESUME":
      return "recovery";
    case "LATENCY_BUDGETS":
      return "latency";
    case "OBSERVABILITY_EXPORT":
      return "observability";
    default:
      break;
  }

  const normalized = extractCurrentRequestForDiagnostics(userInput).toLowerCase();
  if (/\bclone-assisted\b|\bnon-mergeable\s+clone\b|\bclone\s+packet\b/.test(normalized)) {
    return "clone_workflow";
  }
  if (
    /\bdurable\s+checkpoint\b|\bretry\s+budget\b|\bmission\s+stop\s+limit\b|\bresume\b/.test(
      normalized
    )
  ) {
    return "recovery";
  }
  if (/\blatency\s+budgets?\b|\bphase\s+exceeded\b|\bcache\s+paths?\b/.test(normalized)) {
    return "latency";
  }
  if (/\bordered\s+mission\s+timeline\b|\bredacted\s+evidence\s+bundle\b/.test(normalized)) {
    return "observability";
  }
  if (/\b(build|scaffold|typescript\s+cli|runbook|tests?)\b/.test(normalized)) {
    return "build";
  }
  if (/\b(research|findings|sources?)\b/.test(normalized)) {
    return "research";
  }
  if (/\b(workflow|replay|capture|selector)\b/.test(normalized)) {
    return "workflow_replay";
  }
  return "communication";
}

/**
 * Provides research-specific deterministic no-op fallbacks.
 *
 * @param userInput - Raw task user input, potentially including conversation wrappers.
 * @returns Research no-op response text.
 */
function resolveResearchNoOpFallback(userInput: string): string {
  const normalized = extractCurrentRequestForDiagnostics(userInput).toLowerCase();
  if (/\bsandbox(?:ing)?\b/.test(normalized)) {
    return buildDeterministicNoOpTemplate(
      "RESEARCH_NO_SIDE_EFFECT_EXECUTED",
      "Live research execution did not complete in this run. Baseline deterministic sandboxing controls (not live-retrieved in this run): default-deny runtime policy, deterministic egress allowlists with typed deny codes, and receipt-linked audit trails.",
      "Provide approved sources or request governed retrieval, then rerun for finalized findings."
    );
  }
  return buildDeterministicNoOpTemplate(
    "RESEARCH_NO_SIDE_EFFECT_EXECUTED",
    "Live research execution did not complete in this run, so finalized findings are unavailable.",
    "Provide approved sources or request governed retrieval, then rerun for finalized findings with proof references."
  );
}
