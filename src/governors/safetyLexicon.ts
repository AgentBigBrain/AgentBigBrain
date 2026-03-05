/**
 * @fileoverview Frozen deterministic safety lexicon classifiers shared by governors for abuse and destructive-command lexical signals.
 */

import { sha256HexFromCanonicalJson } from "../core/normalizers/canonicalizationRules";

export type SafetyLexiconCategory = "ABUSE_SIGNAL" | "DESTRUCTIVE_COMMAND_SIGNAL" | "NO_SIGNAL";
export type SafetyLexiconConfidenceTier = "HIGH" | "LOW";

export interface SafetyLexiconClassification {
  category: SafetyLexiconCategory;
  matchedRuleId: string;
  matchedToken: string | null;
  rulepackVersion: string;
  confidenceTier: SafetyLexiconConfidenceTier;
}

export interface SafetyLexiconRuleContext {
  rulepackVersion: string;
  rulepackFingerprint: string;
  abuseTerms: readonly string[];
  destructiveCommandTerms: readonly string[];
}

export const SafetyLexiconV1 = {
  version: "SafetyLexiconV1",
  abuseTerms: ["malware", "phishing", "dox", "harmful", "exploit"] as const,
  destructiveCommandTerms: ["rm -rf /", "del /f /s /q", "format c:", "mkfs", "shutdown -s"] as const
} as const;

/**
 * Builds safety lexicon rule context for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of safety lexicon rule context consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `../core/normalizers/canonicalizationRules`.
 * @returns Computed `SafetyLexiconRuleContext` result.
 */
export function createSafetyLexiconRuleContext(): SafetyLexiconRuleContext {
  const abuseTerms = [...SafetyLexiconV1.abuseTerms];
  const destructiveCommandTerms = [...SafetyLexiconV1.destructiveCommandTerms];
  const rulepackFingerprint = sha256HexFromCanonicalJson({
    version: SafetyLexiconV1.version,
    abuseTerms,
    destructiveCommandTerms
  });
  return {
    rulepackVersion: SafetyLexiconV1.version,
    rulepackFingerprint,
    abuseTerms,
    destructiveCommandTerms
  };
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
 * @param category - Value for category.
 * @param matchedRuleId - Stable identifier used to reference an entity or record.
 * @param matchedToken - Token value used for lexical parsing or matching.
 * @param rulepackVersion - Value for rulepack version.
 * @param confidenceTier - Stable identifier used to reference an entity or record.
 * @returns Computed `SafetyLexiconClassification` result.
 */
function toClassification(
  category: SafetyLexiconCategory,
  matchedRuleId: string,
  matchedToken: string | null,
  rulepackVersion: string,
  confidenceTier: SafetyLexiconConfidenceTier
): SafetyLexiconClassification {
  return {
    category,
    matchedRuleId,
    matchedToken,
    rulepackVersion,
    confidenceTier
  };
}

/**
 * Classifies safety abuse text with deterministic rule logic.
 *
 * **Why it exists:**
 * Centralizes classification thresholds for safety abuse text so scoring behavior does not drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param ruleContext - Message/text content processed by this function.
 * @returns Computed `SafetyLexiconClassification` result.
 */
export function classifySafetyAbuseText(
  value: string,
  ruleContext: SafetyLexiconRuleContext
): SafetyLexiconClassification {
  const normalized = value.toLowerCase();
  for (const term of ruleContext.abuseTerms) {
    if (normalized.includes(term)) {
      return toClassification(
        "ABUSE_SIGNAL",
        "safety_lexicon_v1_abuse_term_match",
        term,
        ruleContext.rulepackVersion,
        "HIGH"
      );
    }
  }
  return toClassification(
    "NO_SIGNAL",
    "safety_lexicon_v1_no_abuse_signal",
    null,
    ruleContext.rulepackVersion,
    "LOW"
  );
}

/**
 * Classifies safety destructive command text with deterministic rule logic.
 *
 * **Why it exists:**
 * Centralizes classification thresholds for safety destructive command text so scoring behavior does not drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param ruleContext - Message/text content processed by this function.
 * @returns Computed `SafetyLexiconClassification` result.
 */
export function classifySafetyDestructiveCommandText(
  value: string,
  ruleContext: SafetyLexiconRuleContext
): SafetyLexiconClassification {
  const normalized = value.toLowerCase();
  for (const term of ruleContext.destructiveCommandTerms) {
    if (normalized.includes(term)) {
      return toClassification(
        "DESTRUCTIVE_COMMAND_SIGNAL",
        "safety_lexicon_v1_destructive_command_match",
        term,
        ruleContext.rulepackVersion,
        "HIGH"
      );
    }
  }
  return toClassification(
    "NO_SIGNAL",
    "safety_lexicon_v1_no_destructive_command_signal",
    null,
    ruleContext.rulepackVersion,
    "LOW"
  );
}
