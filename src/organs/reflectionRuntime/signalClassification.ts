/**
 * @fileoverview Deterministic reflection lesson-signal classification using the canonical reflection-runtime rulepack.
 */

import { TaskRunResult } from "../../core/types";
import {
  LessonSignalClassification,
  LessonSignalClassificationContext,
  LessonSignalConfidenceTier,
  LessonSignalRulepackV1,
  LessonSignalScores
} from "./contracts";

const LESSON_STOP_WORD_SET: ReadonlySet<string> = new Set<string>(
  LessonSignalRulepackV1.stopWords as readonly string[]
);
const GENERIC_REFLECTION_TOKEN_SET: ReadonlySet<string> = new Set<string>(
  LessonSignalRulepackV1.genericReflectionTokens as readonly string[]
);
const HIGH_SIGNAL_KEYWORD_SET: ReadonlySet<string> = new Set<string>(
  LessonSignalRulepackV1.highSignalKeywords as readonly string[]
);

/**
 * Canonicalizes raw lesson text before lexical signal analysis.
 *
 * **Why it exists:**
 * Rulepack comparisons assume stable whitespace so threshold decisions are reproducible.
 *
 * **What it talks to:**
 * - Local string normalization only.
 *
 * @param value - Candidate lesson text from reflection output.
 * @returns Trimmed single-space text used by downstream tokenization.
 */
export function normalizeLessonText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Tokenizes normalized lesson text using deterministic lexical rules.
 *
 * **Why it exists:**
 * Signal scoring depends on consistent token boundaries and stop-word removal.
 *
 * **What it talks to:**
 * - Calls `normalizeLessonText`.
 * - Reads `LessonSignalRulepackV1.minTokenLength` and `LESSON_STOP_WORD_SET`.
 *
 * @param value - Lesson text to tokenize.
 * @returns Lowercased filtered token list.
 */
function tokenizeLesson(value: string): string[] {
  return normalizeLessonText(value)
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length >= LessonSignalRulepackV1.minTokenLength)
    .filter((token) => !LESSON_STOP_WORD_SET.has(token));
}

/**
 * Recursively extracts lexical tokens from action parameter payloads.
 *
 * **Why it exists:**
 * Operational overlap checks need to inspect nested action params without unbounded recursion.
 *
 * **What it talks to:**
 * - Calls supplied `addTokens` callback.
 * - Traverses object/array payloads with a hard depth cap.
 *
 * @param value - Parameter payload node to inspect.
 * @param addTokens - Token sink callback.
 * @param depth - Current recursion depth (bounded to prevent runaway traversal).
 */
function collectValueTokens(
  value: unknown,
  addTokens: (value: string) => void,
  depth = 0
): void {
  if (depth > 2 || value == null) {
    return;
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    addTokens(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectValueTokens(item, addTokens, depth + 1);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      addTokens(key);
      collectValueTokens(nested, addTokens, depth + 1);
    }
  }
}

/**
 * Computes Jaccard similarity between two token sets.
 *
 * **Why it exists:**
 * Near-duplicate filtering uses set overlap rather than raw string equality.
 *
 * **What it talks to:**
 * - Local set math only.
 *
 * @param left - Candidate lesson tokens.
 * @param right - Existing lesson tokens.
 * @returns Similarity score in `[0, 1]`.
 */
function jaccardSimilarity(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersectionSize = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersectionSize += 1;
    }
  }

  const unionSize = new Set([...leftSet, ...rightSet]).size;
  if (unionSize === 0) {
    return 0;
  }
  return intersectionSize / unionSize;
}

/**
 * Builds lexical context from the task goal and user input.
 *
 * **Why it exists:**
 * Reflection lessons should stay tied to what the task was trying to accomplish.
 *
 * **What it talks to:**
 * - Reads `runResult.task.goal` and `runResult.task.userInput`.
 * - Calls `tokenizeLesson`.
 *
 * @param runResult - Completed task run payload.
 * @returns Token set representing goal/user-intent vocabulary.
 */
function extractGoalTokens(runResult: TaskRunResult): Set<string> {
  const tokens = new Set<string>();
  for (const token of tokenizeLesson(runResult.task.goal)) {
    tokens.add(token);
  }
  for (const token of tokenizeLesson(runResult.task.userInput)) {
    tokens.add(token);
  }
  return tokens;
}

/**
 * Builds lexical context from executed/blocked action details.
 *
 * **Why it exists:**
 * High-signal lessons frequently mention concrete action types, violations, and policy blockers.
 *
 * **What it talks to:**
 * - Reads action result fields from `TaskRunResult`.
 * - Calls `tokenizeLesson` and `collectValueTokens`.
 *
 * @param runResult - Completed task run payload.
 * @returns Token set representing operational evidence vocabulary.
 */
function extractOperationalTokens(runResult: TaskRunResult): Set<string> {
  const tokens = new Set<string>();
  const addTokens = (value: string): void => {
    for (const token of tokenizeLesson(value)) {
      tokens.add(token);
    }
  };

  for (const result of runResult.actionResults) {
    addTokens(result.action.type);
    addTokens(result.action.description);
    collectValueTokens(result.action.params, addTokens);
    for (const blockedBy of result.blockedBy) {
      addTokens(blockedBy);
    }
    for (const violation of result.violations) {
      addTokens(violation.code);
      addTokens(violation.message);
    }
  }
  return tokens;
}

/**
 * Counts how many lesson tokens overlap with a given context token set.
 *
 * **Why it exists:**
 * Goal/operational relevance is scored by lexical overlap while excluding known generic tokens.
 *
 * **What it talks to:**
 * - Local set-membership checks only.
 *
 * @param lessonTokens - Tokens extracted from candidate lesson text.
 * @param contextTokens - Tokens from goal or operational context.
 * @param excludedTokens - Tokens ignored during overlap counting.
 * @returns Integer overlap count.
 */
function countTokenOverlap(
  lessonTokens: readonly string[],
  contextTokens: ReadonlySet<string>,
  excludedTokens: ReadonlySet<string>
): number {
  let overlapCount = 0;
  for (const token of lessonTokens) {
    if (excludedTokens.has(token)) {
      continue;
    }
    if (contextTokens.has(token)) {
      overlapCount += 1;
    }
  }
  return overlapCount;
}

/**
 * Checks whether tokenized lesson text contains any non-generic signal terms.
 *
 * **Why it exists:**
 * Generic "be clear/helpful" lessons should not persist unless concrete operational signal exists.
 *
 * **What it talks to:**
 * - Reads `GENERIC_REFLECTION_TOKEN_SET`.
 *
 * @param tokens - Candidate lesson tokens.
 * @returns `true` when at least one substantive token is present.
 */
function hasSubstantiveSignalToken(tokens: readonly string[]): boolean {
  return tokens.some((token) => !GENERIC_REFLECTION_TOKEN_SET.has(token) && token.length >= 5);
}

/**
 * Detects known low-signal reflection phrasing patterns.
 *
 * **Why it exists:**
 * Certain broad coaching phrases are noise for long-term memory and should be rejected early.
 *
 * **What it talks to:**
 * - Reads `LessonSignalRulepackV1.lowSignalLessonPatterns`.
 *
 * @param lesson - Normalized lesson text.
 * @returns `true` when lesson matches a blocked low-signal pattern.
 */
function hasLowSignalPattern(lesson: string): boolean {
  return LessonSignalRulepackV1.lowSignalLessonPatterns.some((pattern) => pattern.test(lesson));
}

/**
 * Detects presence of allowlisted high-signal operational keywords.
 *
 * **Why it exists:**
 * Keywords like `constraint`, `governance`, and `rollback` should strongly bias toward persistence.
 *
 * **What it talks to:**
 * - Reads `HIGH_SIGNAL_KEYWORD_SET`.
 *
 * @param tokens - Candidate lesson tokens.
 * @returns `true` when at least one high-signal keyword is present.
 */
function hasHighSignalKeyword(tokens: readonly string[]): boolean {
  return tokens.some((token) => HIGH_SIGNAL_KEYWORD_SET.has(token));
}

/**
 * Finds the highest lexical similarity between candidate and existing lessons.
 *
 * **Why it exists:**
 * Prevents near-duplicate lesson persistence while allowing novel operational insights.
 *
 * **What it talks to:**
 * - Calls `tokenizeLesson` and `jaccardSimilarity`.
 *
 * @param lessonTokens - Candidate lesson tokens.
 * @param existingLessons - Existing persisted lesson strings.
 * @returns Maximum similarity score observed against existing lessons.
 */
function resolveMaxSimilarity(
  lessonTokens: readonly string[],
  existingLessons: readonly string[]
): number {
  let maxSimilarity = 0;
  for (const existing of existingLessons) {
    const existingTokens = tokenizeLesson(existing);
    if (existingTokens.length === 0) {
      continue;
    }
    const similarity = jaccardSimilarity(lessonTokens, existingTokens);
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
    }
  }
  return maxSimilarity;
}

/**
 * Constructs the typed classifier output envelope for persistence decisions.
 *
 * **Why it exists:**
 * Keeps `classifyLessonSignal` focused on rule evaluation while this helper centralizes output
 * shape, category derivation, and rulepack version stamping.
 *
 * **What it talks to:**
 * - Reads `LessonSignalRulepackV1.version`.
 *
 * @param allowPersist - Persistence verdict from rule evaluation.
 * @param confidenceTier - Confidence tier attached to the matched rule.
 * @param matchedRuleId - Deterministic rule identifier.
 * @param blockReason - Typed denial reason when persistence is blocked.
 * @param scores - Scoring diagnostics attached to the decision.
 * @returns Fully shaped classification payload.
 */
function buildClassification(
  allowPersist: boolean,
  confidenceTier: LessonSignalConfidenceTier,
  matchedRuleId: string,
  blockReason: LessonSignalClassification["blockReason"],
  scores: LessonSignalScores
): LessonSignalClassification {
  return {
    allowPersist,
    category: allowPersist ? "ALLOW" : "REJECT",
    confidenceTier,
    matchedRuleId,
    rulepackVersion: LessonSignalRulepackV1.version,
    blockReason,
    scores
  };
}

/**
 * Runs the deterministic lesson-signal rulepack and returns a persistence decision.
 *
 * **Why it exists:**
 * Reflection memory must reject vague or duplicate lessons while preserving concrete operational
 * learning signals that improve future planning/governance behavior.
 *
 * **What it talks to:**
 * - Calls normalization/tokenization helpers and overlap/similarity checks in this module.
 * - Reads thresholds and patterns from `LessonSignalRulepackV1`.
 *
 * @param lesson - Candidate reflection lesson text.
 * @param context - Runtime context (run result, source mode, existing lessons).
 * @returns Typed allow/reject decision with rule and scoring metadata.
 */
export function classifyLessonSignal(
  lesson: string,
  context: LessonSignalClassificationContext
): LessonSignalClassification {
  const normalizedLesson = normalizeLessonText(lesson);
  const lessonTokens = tokenizeLesson(normalizedLesson);
  const scores: LessonSignalScores = {
    tokenCount: lessonTokens.length,
    goalOverlap: 0,
    operationalOverlap: 0,
    maxSimilarity: 0
  };

  if (normalizedLesson.length < LessonSignalRulepackV1.minLessonLength) {
    return buildClassification(
      false,
      "HIGH",
      "lesson_signal_v1_too_short",
      "LESSON_TOO_SHORT",
      scores
    );
  }

  if (hasLowSignalPattern(normalizedLesson)) {
    return buildClassification(
      false,
      "HIGH",
      "lesson_signal_v1_low_signal_pattern",
      "LOW_SIGNAL_PATTERN",
      scores
    );
  }

  if (lessonTokens.length === 0 || !hasSubstantiveSignalToken(lessonTokens)) {
    return buildClassification(
      false,
      "MED",
      "lesson_signal_v1_no_substantive_signal_token",
      "NO_SUBSTANTIVE_SIGNAL_TOKEN",
      scores
    );
  }

  const operationalTokens = extractOperationalTokens(context.runResult);
  scores.operationalOverlap = countTokenOverlap(
    lessonTokens,
    operationalTokens,
    GENERIC_REFLECTION_TOKEN_SET
  );

  const goalTokens = extractGoalTokens(context.runResult);
  scores.goalOverlap = countTokenOverlap(
    lessonTokens,
    goalTokens,
    GENERIC_REFLECTION_TOKEN_SET
  );

  let allowRuleId = "";
  let allowConfidenceTier: LessonSignalConfidenceTier = "MED";

  if (hasHighSignalKeyword(lessonTokens)) {
    allowRuleId = "lesson_signal_v1_allow_high_signal_keyword";
    allowConfidenceTier = "HIGH";
  } else if (scores.operationalOverlap >= LessonSignalRulepackV1.minOperationalOverlap) {
    allowRuleId = "lesson_signal_v1_allow_operational_overlap";
    allowConfidenceTier = "HIGH";
  } else if (
    context.source === "success" &&
    scores.goalOverlap >= LessonSignalRulepackV1.minSuccessGoalOverlap
  ) {
    allowRuleId = "lesson_signal_v1_allow_goal_overlap_success";
  } else if (
    context.source === "failure" &&
    scores.goalOverlap >= LessonSignalRulepackV1.minFailureGoalOverlap
  ) {
    allowRuleId = "lesson_signal_v1_allow_goal_overlap_failure";
  } else {
    return buildClassification(
      false,
      "LOW",
      context.source === "success"
        ? "lesson_signal_v1_goal_overlap_below_success_threshold"
        : "lesson_signal_v1_goal_overlap_below_failure_threshold",
      "INSUFFICIENT_GOAL_OVERLAP",
      scores
    );
  }

  scores.maxSimilarity = resolveMaxSimilarity(lessonTokens, context.existingLessons);
  if (scores.maxSimilarity >= LessonSignalRulepackV1.lessonSimilarityThreshold) {
    return buildClassification(
      false,
      "HIGH",
      "lesson_signal_v1_near_duplicate",
      "NEAR_DUPLICATE",
      scores
    );
  }

  return buildClassification(true, allowConfidenceTier, allowRuleId, null, scores);
}
