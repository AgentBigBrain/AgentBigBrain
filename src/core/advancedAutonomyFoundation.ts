/**
 * @fileoverview Stage 6.5 advanced-autonomy foundations for first-principles validation, deterministic failure taxonomy, and workflow adaptation.
 */

import { makeId } from "./ids";
import {
  FailureTaxonomyCategory,
  FailureTaxonomySignal,
  FirstPrinciplesRubric,
  FirstPrinciplesValidationResult,
  TaskRunResult,
  WorkflowAdaptationResult,
  WorkflowObservation,
  WorkflowOutcome,
  WorkflowPattern
} from "./types";

const REASONING_FAILURE_PATTERNS = [
  "planner model returned no valid actions",
  "model output failed",
  "schema validation",
  "malformed",
  "parse",
  "reasoning"
];
const QUALITY_FAILURE_PATTERNS = [
  "low quality",
  "incomplete",
  "unclear",
  "generic",
  "not helpful"
];
const DEFAULT_DECAY_INTERVAL_DAYS = 7;
const DEFAULT_DECAY_STEP = 0.05;
const DEFAULT_SUCCESS_BOOST = 0.12;
const DEFAULT_FAILURE_PENALTY = 0.18;
const DEFAULT_SUPPRESSED_PENALTY = 0.08;
const DEFAULT_BASE_CONFIDENCE = 0.55;

interface WorkflowLearningOptions {
  decayIntervalDays?: number;
  decayStep?: number;
  successBoost?: number;
  failurePenalty?: number;
  suppressedPenalty?: number;
  baseConfidence?: number;
}

/**
 * Normalizes line items into a stable shape for `advancedAutonomyFoundation` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for line items so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param items - Value for items.
 * @returns Ordered collection produced by this step.
 */
function normalizeLineItems(items: readonly string[] | undefined): string[] {
  const normalized = (items ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return [...new Set(normalized)];
}

/**
 * Normalizes workflow key into a stable shape for `advancedAutonomyFoundation` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for workflow key so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeWorkflowKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Converts values into iso or now form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for iso or now deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function toIsoOrNow(value: string): string {
  const candidate = new Date(value);
  if (Number.isNaN(candidate.valueOf())) {
    return new Date().toISOString();
  }
  return candidate.toISOString();
}

/**
 * Constrains and sanitizes confidence to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for confidence before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed numeric value.
 */
function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Number(Math.max(0, Math.min(1, value)).toFixed(4));
}

/**
 * Calculates days between for deterministic time-based decisions.
 *
 * **Why it exists:**
 * Keeps `days between` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param fromIso - Timestamp used for ordering, timeout, or recency decisions.
 * @param toIso - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed numeric value.
 */
function daysBetween(fromIso: string, toIso: string): number {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  if (Number.isNaN(from.valueOf()) || Number.isNaN(to.valueOf())) {
    return 0;
  }
  const diffMs = Math.max(0, to.getTime() - from.getTime());
  return diffMs / (24 * 60 * 60 * 1000);
}

/**
 * Checks whether pattern contains the required signal.
 *
 * **Why it exists:**
 * Makes pattern containment checks explicit so threshold behavior is easy to audit.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @param patterns - Value for patterns.
 * @returns `true` when this check passes.
 */
function containsPattern(text: string, patterns: readonly string[]): boolean {
  const lowered = text.toLowerCase();
  return patterns.some((pattern) => lowered.includes(pattern));
}

/**
 * Converts values into sorted unique tags form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for sorted unique tags deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param existing - Value for existing.
 * @param next - Value for next.
 * @returns Ordered collection produced by this step.
 */
function toSortedUniqueTags(
  existing: readonly string[],
  next: readonly string[]
): readonly string[] {
  return [...new Set([...existing, ...next].map((item) => item.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Computes the next confidence value for this runtime flow.
 *
 * **Why it exists:**
 * Keeps candidate selection logic for confidence centralized so outcomes stay consistent.
 *
 * **What it talks to:**
 * - Uses `WorkflowOutcome` (import `WorkflowOutcome`) from `./types`.
 *
 * @param current - Value for current.
 * @param outcome - Value for outcome.
 * @param options - Optional tuning knobs for this operation.
 * @returns Computed numeric value.
 */
function nextConfidence(
  current: number,
  outcome: WorkflowOutcome,
  options: WorkflowLearningOptions
): number {
  if (outcome === "success") {
    return clampConfidence(current + (options.successBoost ?? DEFAULT_SUCCESS_BOOST));
  }
  if (outcome === "failure") {
    return clampConfidence(current - (options.failurePenalty ?? DEFAULT_FAILURE_PENALTY));
  }
  return clampConfidence(current - (options.suppressedPenalty ?? DEFAULT_SUPPRESSED_PENALTY));
}

/**
 * Implements decay pattern confidence behavior used by `advancedAutonomyFoundation`.
 *
 * **Why it exists:**
 * Keeps `decay pattern confidence` behavior centralized so collaborating call sites stay consistent.
 *
 * **What it talks to:**
 * - Uses `WorkflowPattern` (import `WorkflowPattern`) from `./types`.
 *
 * @param pattern - Value for pattern.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @param options - Optional tuning knobs for this operation.
 * @returns Computed `WorkflowPattern` result.
 */
function decayPatternConfidence(
  pattern: WorkflowPattern,
  observedAt: string,
  options: WorkflowLearningOptions
): WorkflowPattern {
  if (pattern.status !== "active") {
    return pattern;
  }

  const intervalDays = options.decayIntervalDays ?? DEFAULT_DECAY_INTERVAL_DAYS;
  const elapsedDays = daysBetween(pattern.lastSeenAt, observedAt);
  if (elapsedDays < intervalDays) {
    return pattern;
  }

  const steps = Math.floor(elapsedDays / intervalDays);
  if (steps <= 0) {
    return pattern;
  }

  const decayStep = options.decayStep ?? DEFAULT_DECAY_STEP;
  return {
    ...pattern,
    confidence: clampConfidence(pattern.confidence - steps * decayStep)
  };
}

/**
 * Builds first principles rubric for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of first principles rubric consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `FirstPrinciplesRubric` (import `FirstPrinciplesRubric`) from `./types`.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `FirstPrinciplesRubric` result.
 */
export function createFirstPrinciplesRubric(
  input: Partial<FirstPrinciplesRubric>
): FirstPrinciplesRubric {
  return {
    facts: normalizeLineItems(input.facts),
    assumptions: normalizeLineItems(input.assumptions),
    constraints: normalizeLineItems(input.constraints),
    unknowns: normalizeLineItems(input.unknowns),
    minimalPlan: (input.minimalPlan ?? "").trim()
  };
}

/**
 * Applies deterministic validity checks for first principles rubric.
 *
 * **Why it exists:**
 * Fails fast when first principles rubric is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses `FirstPrinciplesRubric` (import `FirstPrinciplesRubric`) from `./types`.
 * - Uses `FirstPrinciplesValidationResult` (import `FirstPrinciplesValidationResult`) from `./types`.
 *
 * @param rubric - Value for rubric.
 * @returns Computed `FirstPrinciplesValidationResult` result.
 */
export function validateFirstPrinciplesRubric(
  rubric: FirstPrinciplesRubric
): FirstPrinciplesValidationResult {
  const violationCodes: string[] = [];
  if (rubric.facts.length === 0) {
    violationCodes.push("FIRST_PRINCIPLES_FACTS_REQUIRED");
  }
  if (rubric.assumptions.length === 0) {
    violationCodes.push("FIRST_PRINCIPLES_ASSUMPTIONS_REQUIRED");
  }
  if (rubric.constraints.length === 0) {
    violationCodes.push("FIRST_PRINCIPLES_CONSTRAINTS_REQUIRED");
  }
  if (rubric.unknowns.length === 0) {
    violationCodes.push("FIRST_PRINCIPLES_UNKNOWNS_REQUIRED");
  }
  if (rubric.minimalPlan.length < 12) {
    violationCodes.push("FIRST_PRINCIPLES_MINIMAL_PLAN_REQUIRED");
  }

  return {
    valid: violationCodes.length === 0,
    violationCodes: violationCodes.sort((left, right) => left.localeCompare(right))
  };
}

/**
 * Classifies failure taxonomy with deterministic rule logic.
 *
 * **Why it exists:**
 * Centralizes classification thresholds for failure taxonomy so scoring behavior does not drift.
 *
 * **What it talks to:**
 * - Uses `FailureTaxonomyCategory` (import `FailureTaxonomyCategory`) from `./types`.
 * - Uses `FailureTaxonomySignal` (import `FailureTaxonomySignal`) from `./types`.
 *
 * @param signal - Value for signal.
 * @returns Computed `FailureTaxonomyCategory` result.
 */
export function classifyFailureTaxonomy(signal: FailureTaxonomySignal): FailureTaxonomyCategory {
  if (signal.humanFeedbackOnly) {
    return "human_feedback";
  }
  if (signal.blockCategory === "constraints" || signal.violationCodes.length > 0) {
    return "constraint";
  }
  if (containsPattern(signal.summary, REASONING_FAILURE_PATTERNS)) {
    return "reasoning";
  }
  if (!signal.objectivePass) {
    return "objective";
  }
  if (containsPattern(signal.summary, QUALITY_FAILURE_PATTERNS)) {
    return "quality";
  }
  return "quality";
}

/**
 * Builds failure taxonomy signal from run for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of failure taxonomy signal from run consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `FailureTaxonomySignal` (import `FailureTaxonomySignal`) from `./types`.
 * - Uses `TaskRunResult` (import `TaskRunResult`) from `./types`.
 *
 * @param runResult - Result object inspected or transformed in this step.
 * @param humanFeedbackOnly - Value for human feedback only.
 * @returns Computed `FailureTaxonomySignal` result.
 */
export function buildFailureTaxonomySignalFromRun(
  runResult: TaskRunResult,
  humanFeedbackOnly = false
): FailureTaxonomySignal {
  const blockedResults = runResult.actionResults.filter((result) => !result.approved);
  const violationCodes = blockedResults.flatMap((result) =>
    result.violations.map((violation) => violation.code)
  );
  const approvedSafeActions = runResult.actionResults.filter(
    (result) => result.approved && result.violations.length === 0
  ).length;
  const objectivePass = approvedSafeActions > 0 && blockedResults.length === 0;

  const blockCategory =
    violationCodes.length > 0
      ? "constraints"
      : blockedResults.length > 0
        ? "governance"
        : runResult.summary.toLowerCase().includes("failed")
          ? "runtime"
          : "none";

  return {
    blockCategory,
    violationCodes,
    objectivePass,
    humanFeedbackOnly,
    summary: runResult.summary
  };
}

/**
 * Implements adapt workflow patterns behavior used by `advancedAutonomyFoundation`.
 *
 * **Why it exists:**
 * Defines public behavior from `advancedAutonomyFoundation.ts` for other modules/tests.
 *
 * **What it talks to:**
 * - Uses `makeId` (import `makeId`) from `./ids`.
 * - Uses `WorkflowAdaptationResult` (import `WorkflowAdaptationResult`) from `./types`.
 * - Uses `WorkflowObservation` (import `WorkflowObservation`) from `./types`.
 * - Uses `WorkflowPattern` (import `WorkflowPattern`) from `./types`.
 *
 * @param existingPatterns - Value for existing patterns.
 * @param observation - Value for observation.
 * @param options - Optional tuning knobs for this operation.
 * @returns Computed `WorkflowAdaptationResult` result.
 */
export function adaptWorkflowPatterns(
  existingPatterns: readonly WorkflowPattern[],
  observation: WorkflowObservation,
  options: WorkflowLearningOptions = {}
): WorkflowAdaptationResult {
  const observedAt = toIsoOrNow(observation.observedAt);
  const workflowKey = normalizeWorkflowKey(observation.workflowKey);
  const normalizedSupersedes = new Set(
    normalizeLineItems(observation.supersedesKeys).map((key) => normalizeWorkflowKey(key))
  );
  const normalizedContextTags = normalizeLineItems(observation.contextTags);

  const supersededPatternIds: string[] = [];
  const decayedPatterns = existingPatterns.map((pattern) =>
    decayPatternConfidence(pattern, observedAt, options)
  );

  const mutatedPatterns: WorkflowPattern[] = decayedPatterns.map(
    (pattern): WorkflowPattern => {
    if (
      pattern.status === "active" &&
      normalizedSupersedes.has(normalizeWorkflowKey(pattern.workflowKey))
    ) {
      supersededPatternIds.push(pattern.id);
      return {
        ...pattern,
        status: "superseded",
        supersededAt: observedAt,
        confidence: clampConfidence(Math.min(pattern.confidence, 0.25))
      };
    }
    return pattern;
    }
  );

  const patternIndex = mutatedPatterns.findIndex(
    (pattern) =>
      pattern.status === "active" &&
      normalizeWorkflowKey(pattern.workflowKey) === workflowKey
  );

  let updatedPattern: WorkflowPattern;
  if (patternIndex === -1) {
    const baseConfidence = clampConfidence(options.baseConfidence ?? DEFAULT_BASE_CONFIDENCE);
    updatedPattern = {
      id: makeId("workflow_pattern"),
      workflowKey,
      status: "active",
      confidence: nextConfidence(baseConfidence, observation.outcome, options),
      firstSeenAt: observedAt,
      lastSeenAt: observedAt,
      supersededAt: null,
      domainLane: observation.domainLane.trim() || "unknown",
      successCount: observation.outcome === "success" ? 1 : 0,
      failureCount: observation.outcome === "failure" ? 1 : 0,
      suppressedCount: observation.outcome === "suppressed" ? 1 : 0,
      contextTags: normalizedContextTags
    };
    mutatedPatterns.push(updatedPattern);
  } else {
    const current = mutatedPatterns[patternIndex];
    updatedPattern = {
      ...current,
      lastSeenAt: observedAt,
      confidence: nextConfidence(current.confidence, observation.outcome, options),
      successCount: current.successCount + (observation.outcome === "success" ? 1 : 0),
      failureCount: current.failureCount + (observation.outcome === "failure" ? 1 : 0),
      suppressedCount: current.suppressedCount + (observation.outcome === "suppressed" ? 1 : 0),
      contextTags: toSortedUniqueTags(current.contextTags, normalizedContextTags)
    };
    mutatedPatterns[patternIndex] = updatedPattern;
  }

  return {
    patterns: mutatedPatterns,
    updatedPattern,
    supersededPatternIds
  };
}
