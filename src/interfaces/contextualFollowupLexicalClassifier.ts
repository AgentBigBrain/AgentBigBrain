/**
 * @fileoverview Deterministic contextual follow-up lexical classifier for cue detection and bounded candidate-token extraction with auditable metadata.
 */

import { sha256HexFromCanonicalJson } from "../core/normalizers/canonicalizationRules";

export type ContextualFollowupLexicalConfidenceTier = "HIGH" | "MED" | "LOW";

export interface ContextualFollowupLexicalClassification {
  cueDetected: boolean;
  candidateTokens: readonly string[];
  confidence: number;
  confidenceTier: ContextualFollowupLexicalConfidenceTier;
  matchedRuleId: string;
  rulepackVersion: string;
  rulepackFingerprint: string;
  conflict: boolean;
}

interface ContextualFollowupLexicalRuleContext {
  rulepackVersion: string;
  rulepackFingerprint: string;
  positiveCuePatterns: readonly RegExp[];
  negativeCuePatterns: readonly RegExp[];
  stopwords: ReadonlySet<string>;
  minTokenLength: number;
  maxCandidateTokens: number;
}

export const ContextualFollowupLexicalRulepackV1 = {
  version: "ContextualFollowupLexicalRulepackV1",
  positiveCuePatterns: [
    "follow[\\s-]?up",
    "check[\\s-]?in",
    "circle back",
    "\\bremind me\\b",
    "\\bstatus(?:\\s+update)?\\b",
    "\\bupdate me\\b",
    "\\bhow(?:'s| is)\\b",
    "\\bdid .*resolve\\b",
    "\\blater\\b"
  ] as const,
  negativeCuePatterns: [
    "\\b(?:do\\s+not|don't|stop|no)\\s+(?:follow[\\s-]?up|check[\\s-]?in|remind(?:er|ing)?)(?:\\b|\\s)",
    "\\bleave\\s+it\\s+alone\\b"
  ] as const,
  stopwords: [
    "the",
    "a",
    "an",
    "and",
    "or",
    "to",
    "for",
    "of",
    "on",
    "at",
    "in",
    "is",
    "are",
    "be",
    "it",
    "this",
    "that",
    "my",
    "your",
    "our",
    "with",
    "about",
    "just",
    "later",
    "follow",
    "followup",
    "check",
    "status",
    "update",
    "remind"
  ] as const,
  minTokenLength: 3,
  maxCandidateTokens: 10
} as const;

/**
 * Builds contextual followup lexical rule context for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of contextual followup lexical rule context consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `../core/normalizers/canonicalizationRules`.
 * @returns Computed `ContextualFollowupLexicalRuleContext` result.
 */
function createContextualFollowupLexicalRuleContext(): ContextualFollowupLexicalRuleContext {
  const positiveCuePatterns = [...ContextualFollowupLexicalRulepackV1.positiveCuePatterns];
  const negativeCuePatterns = [...ContextualFollowupLexicalRulepackV1.negativeCuePatterns];
  const stopwords = [...ContextualFollowupLexicalRulepackV1.stopwords].sort(
    (left, right) => left.localeCompare(right)
  );
  const rulepackFingerprint = sha256HexFromCanonicalJson({
    version: ContextualFollowupLexicalRulepackV1.version,
    positiveCuePatterns,
    negativeCuePatterns,
    stopwords,
    minTokenLength: ContextualFollowupLexicalRulepackV1.minTokenLength,
    maxCandidateTokens: ContextualFollowupLexicalRulepackV1.maxCandidateTokens
  });

  return {
    rulepackVersion: ContextualFollowupLexicalRulepackV1.version,
    rulepackFingerprint,
    positiveCuePatterns: positiveCuePatterns.map((pattern) => new RegExp(pattern, "i")),
    negativeCuePatterns: negativeCuePatterns.map((pattern) => new RegExp(pattern, "i")),
    stopwords: new Set(ContextualFollowupLexicalRulepackV1.stopwords),
    minTokenLength: ContextualFollowupLexicalRulepackV1.minTokenLength,
    maxCandidateTokens: ContextualFollowupLexicalRulepackV1.maxCandidateTokens
  };
}

const DEFAULT_RULE_CONTEXT = createContextualFollowupLexicalRuleContext();

/**
 * Normalizes for tokens into a stable shape for `contextualFollowupLexicalClassifier` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for for tokens so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeForTokens(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return Number(value.toFixed(4));
}

/**
 * Converts values into confidence tier form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for confidence tier deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `ContextualFollowupLexicalConfidenceTier` result.
 */
function toConfidenceTier(value: number): ContextualFollowupLexicalConfidenceTier {
  if (value >= 0.75) {
    return "HIGH";
  }
  if (value >= 0.55) {
    return "MED";
  }
  return "LOW";
}

/**
 * Converts values into classification form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for classification deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param cueDetected - Value for cue detected.
 * @param candidateTokens - Timestamp used for ordering, timeout, or recency decisions.
 * @param confidence - Stable identifier used to reference an entity or record.
 * @param matchedRuleId - Stable identifier used to reference an entity or record.
 * @param ruleContext - Message/text content processed by this function.
 * @param conflict - Value for conflict.
 * @returns Computed `ContextualFollowupLexicalClassification` result.
 */
function toClassification(
  cueDetected: boolean,
  candidateTokens: readonly string[],
  confidence: number,
  matchedRuleId: string,
  ruleContext: ContextualFollowupLexicalRuleContext,
  conflict: boolean
): ContextualFollowupLexicalClassification {
  const normalizedConfidence = clampConfidence(confidence);
  return {
    cueDetected,
    candidateTokens,
    confidence: normalizedConfidence,
    confidenceTier: toConfidenceTier(normalizedConfidence),
    matchedRuleId,
    rulepackVersion: ruleContext.rulepackVersion,
    rulepackFingerprint: ruleContext.rulepackFingerprint,
    conflict
  };
}

/**
 * Derives candidate tokens from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for candidate tokens in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param normalizedText - Message/text content processed by this function.
 * @param ruleContext - Message/text content processed by this function.
 * @returns Ordered collection produced by this step.
 */
function extractCandidateTokens(
  normalizedText: string,
  ruleContext: ContextualFollowupLexicalRuleContext
): readonly string[] {
  const unique = new Set<string>();
  for (const rawToken of normalizedText.split(" ")) {
    const token = rawToken.trim();
    if (!token || token.length < ruleContext.minTokenLength) {
      continue;
    }
    if (ruleContext.stopwords.has(token)) {
      continue;
    }
    unique.add(token);
    if (unique.size >= ruleContext.maxCandidateTokens) {
      break;
    }
  }
  return [...unique];
}

/**
 * Classifies contextual followup lexical cue with deterministic rule logic.
 *
 * **Why it exists:**
 * Centralizes classification thresholds for contextual followup lexical cue so scoring behavior does not drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @param ruleContext - Message/text content processed by this function.
 * @returns Computed `ContextualFollowupLexicalClassification` result.
 */
export function classifyContextualFollowupLexicalCue(
  text: string,
  ruleContext: ContextualFollowupLexicalRuleContext = DEFAULT_RULE_CONTEXT
): ContextualFollowupLexicalClassification {
  const normalizedText = text.trim();
  if (!normalizedText) {
    return toClassification(
      false,
      [],
      0,
      "contextual_followup_lexical_v1_empty_input",
      ruleContext,
      false
    );
  }

  const positiveCueMatchCount = ruleContext.positiveCuePatterns.filter((pattern) =>
    pattern.test(normalizedText)
  ).length;
  if (positiveCueMatchCount === 0) {
    return toClassification(
      false,
      [],
      0,
      "contextual_followup_lexical_v1_no_cue",
      ruleContext,
      false
    );
  }

  const hasNegativeCueSignal = ruleContext.negativeCuePatterns.some((pattern) =>
    pattern.test(normalizedText)
  );
  if (hasNegativeCueSignal) {
    return toClassification(
      false,
      [],
      0.2,
      "contextual_followup_lexical_v1_conflicting_positive_negative_cue",
      ruleContext,
      true
    );
  }

  const candidateTokens = extractCandidateTokens(
    normalizeForTokens(normalizedText),
    ruleContext
  );
  if (candidateTokens.length === 0) {
    return toClassification(
      true,
      [],
      0.35,
      "contextual_followup_lexical_v1_cue_without_candidate_tokens",
      ruleContext,
      true
    );
  }

  const confidence = 0.55
    + Math.min(0.2, candidateTokens.length * 0.04)
    + Math.min(0.2, positiveCueMatchCount * 0.08);
  return toClassification(
    true,
    candidateTokens,
    confidence,
    "contextual_followup_lexical_v1_cue_with_candidate_tokens",
    ruleContext,
    false
  );
}
