/**
 * @fileoverview Deterministic trust and overclaim lexical classifier for user-facing render decisions, with frozen rulepack metadata and tightening-only overrides.
 */

import { sha256HexFromCanonicalJson } from "../core/normalizers/canonicalizationRules";

export type TrustRenderDecision =
  | "RENDER_APPROVED"
  | "RENDER_SIMULATED"
  | "RENDER_BLOCKED"
  | "RENDER_UNCERTAIN";
export type TrustLexicalConfidenceTier = "HIGH" | "MED" | "LOW";

export interface TrustRenderEvidence {
  matchedRuleId: string;
  rulepackVersion: string;
  confidenceTier: TrustLexicalConfidenceTier;
  conflict: boolean;
}

export interface TrustRenderClassification {
  decision: TrustRenderDecision;
  evidence: TrustRenderEvidence;
}

export interface TrustRenderDecisionInput {
  text: string;
  hasApprovedRealShellExecution: boolean;
  hasApprovedRealNonRespondExecution: boolean;
  hasBlockedUnmatchedAction: boolean;
  hasApprovedSimulatedShellExecution: boolean;
  hasApprovedSimulatedNonRespondExecution: boolean;
}

export interface TrustLexicalOverrideV1 {
  schemaVersion: 1;
  additionalBrowserExecutionClaimPatterns?: readonly string[];
  additionalSideEffectCompletionClaimPatterns?: readonly string[];
  additionalSimulatedOutputPatterns?: readonly string[];
}

export interface TrustLexicalRuleContext {
  rulepackVersion: string;
  rulepackFingerprint: string;
  browserExecutionClaimPatterns: readonly RegExp[];
  sideEffectCompletionClaimPatterns: readonly RegExp[];
  simulatedOutputPatterns: readonly RegExp[];
}

interface ParsedTrustLexicalOverrideV1 {
  additionalBrowserExecutionClaimPatterns: readonly string[];
  additionalSideEffectCompletionClaimPatterns: readonly string[];
  additionalSimulatedOutputPatterns: readonly string[];
}

const MAX_OVERRIDE_PATTERNS_PER_GROUP = 32;
const MAX_OVERRIDE_PATTERN_LENGTH = 160;

export const TrustLexicalRulepackV1 = {
  version: "TrustLexicalRulepackV1",
  browserExecutionClaimPatterns: [
    "\\b(?:i|we)\\s+(?:will|can|have|am|\\'m)?\\s*(?:now\\s+)?(?:open|launch|start)\\s+(?:your\\s+)?browser\\b",
    "\\b(?:opened|launched|started)\\s+(?:your\\s+)?browser\\b",
    "\\b(?:navigate|navigating|navigated)\\s+to\\s+(?:https?:\\/\\/)?[a-z0-9.-]+\\.[a-z]{2,}\\b",
    "\\bgo(?:ing)?\\s+to\\s+(?:https?:\\/\\/)?[a-z0-9.-]+\\.[a-z]{2,}\\b"
  ] as const,
  sideEffectCompletionClaimPatterns: [
    "\\bactions?\\s+that\\s+have\\s+already\\s+run\\b",
    "\\b(?:i|we)\\s+(?:have|\\'ve|already)?\\s*(?:scheduled|sent|written|deleted|created|exported|executed|ran)\\b",
    "\\b(?:has|have)\\s+been\\s+(?:scheduled|sent|written|deleted|created|exported|executed)\\b",
    "\\b(?:scheduled|sent|written|deleted|created|exported)\\s+(?:successfully|for\\s+you)\\b",
    "\\bordered\\s+mission\\s+timeline\\s+for\\s+the\\s+last\\s+run\\b"
  ] as const,
  simulatedOutputPatterns: [
    "\\bsimulated\\b",
    "\\bdry\\s*run\\b",
    "\\bpreview\\s+(?:only|mode)\\b",
    "\\brequires\\s+governance\\s+workflow\\b",
    "\\bdisabled\\s+by\\s+policy\\b"
  ] as const
} as const;

/**
 * Normalizes pattern list into a stable shape for `trustLexicalClassifier` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for pattern list so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param label - Value for label.
 * @returns Ordered collection produced by this step.
 */
function normalizePatternList(
  value: readonly string[] | undefined,
  label: string
): readonly string[] {
  if (!value) {
    return [];
  }
  if (value.length > MAX_OVERRIDE_PATTERNS_PER_GROUP) {
    throw new Error(
      `Trust lexical override '${label}' exceeds ${MAX_OVERRIDE_PATTERNS_PER_GROUP} patterns.`
    );
  }

  const normalized: string[] = [];
  for (const rawPattern of value) {
    if (typeof rawPattern !== "string") {
      throw new Error(`Trust lexical override '${label}' contains a non-string pattern.`);
    }
    const trimmed = rawPattern.trim();
    if (!trimmed) {
      throw new Error(`Trust lexical override '${label}' contains an empty pattern.`);
    }
    if (trimmed.length > MAX_OVERRIDE_PATTERN_LENGTH) {
      throw new Error(
        `Trust lexical override '${label}' pattern exceeds ${MAX_OVERRIDE_PATTERN_LENGTH} chars.`
      );
    }
    normalized.push(trimmed);
  }

  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

/**
 * Parses trust lexical override v1 and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for trust lexical override v1 so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param override - Stable identifier used to reference an entity or record.
 * @returns Computed `ParsedTrustLexicalOverrideV1` result.
 */
function parseTrustLexicalOverrideV1(override: TrustLexicalOverrideV1): ParsedTrustLexicalOverrideV1 {
  if (override.schemaVersion !== 1) {
    throw new Error("Trust lexical override schemaVersion must be 1.");
  }
  return {
    additionalBrowserExecutionClaimPatterns: normalizePatternList(
      override.additionalBrowserExecutionClaimPatterns,
      "additionalBrowserExecutionClaimPatterns"
    ),
    additionalSideEffectCompletionClaimPatterns: normalizePatternList(
      override.additionalSideEffectCompletionClaimPatterns,
      "additionalSideEffectCompletionClaimPatterns"
    ),
    additionalSimulatedOutputPatterns: normalizePatternList(
      override.additionalSimulatedOutputPatterns,
      "additionalSimulatedOutputPatterns"
    )
  };
}

/**
 * Compiles pattern list into deterministic output artifacts.
 *
 * **Why it exists:**
 * Centralizes pattern list state-transition logic to keep evolution deterministic and reviewable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param patterns - Value for patterns.
 * @returns Ordered collection produced by this step.
 */
function compilePatternList(patterns: readonly string[]): readonly RegExp[] {
  return patterns.map((pattern) => new RegExp(pattern, "i"));
}

/**
 * Evaluates pattern match and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the pattern match policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @param patterns - Value for patterns.
 * @returns `true` when this check passes.
 */
function hasPatternMatch(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
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
 * @param decision - Value for decision.
 * @param matchedRuleId - Stable identifier used to reference an entity or record.
 * @param confidenceTier - Stable identifier used to reference an entity or record.
 * @param rulepackVersion - Value for rulepack version.
 * @param conflict - Value for conflict.
 * @returns Computed `TrustRenderClassification` result.
 */
function toClassification(
  decision: TrustRenderDecision,
  matchedRuleId: string,
  confidenceTier: TrustLexicalConfidenceTier,
  rulepackVersion: string,
  conflict: boolean
): TrustRenderClassification {
  return {
    decision,
    evidence: {
      matchedRuleId,
      rulepackVersion,
      confidenceTier,
      conflict
    }
  };
}

/**
 * Builds trust lexical rule context for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of trust lexical rule context consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `../core/normalizers/canonicalizationRules`.
 *
 * @param override - Stable identifier used to reference an entity or record.
 * @returns Computed `TrustLexicalRuleContext` result.
 */
export function createTrustLexicalRuleContext(
  override: TrustLexicalOverrideV1 | null = null
): TrustLexicalRuleContext {
  const parsedOverride = override ? parseTrustLexicalOverrideV1(override) : null;
  const browserExecutionClaimPatterns = [
    ...TrustLexicalRulepackV1.browserExecutionClaimPatterns,
    ...(parsedOverride?.additionalBrowserExecutionClaimPatterns ?? [])
  ];
  const sideEffectCompletionClaimPatterns = [
    ...TrustLexicalRulepackV1.sideEffectCompletionClaimPatterns,
    ...(parsedOverride?.additionalSideEffectCompletionClaimPatterns ?? [])
  ];
  const simulatedOutputPatterns = [
    ...TrustLexicalRulepackV1.simulatedOutputPatterns,
    ...(parsedOverride?.additionalSimulatedOutputPatterns ?? [])
  ];
  const rulepackFingerprint = sha256HexFromCanonicalJson({
    version: TrustLexicalRulepackV1.version,
    browserExecutionClaimPatterns,
    sideEffectCompletionClaimPatterns,
    simulatedOutputPatterns
  });

  return {
    rulepackVersion: TrustLexicalRulepackV1.version,
    rulepackFingerprint,
    browserExecutionClaimPatterns: compilePatternList(browserExecutionClaimPatterns),
    sideEffectCompletionClaimPatterns: compilePatternList(sideEffectCompletionClaimPatterns),
    simulatedOutputPatterns: compilePatternList(simulatedOutputPatterns)
  };
}

/**
 * Evaluates simulated output and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the simulated output policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @param ruleContext - Message/text content processed by this function.
 * @returns `true` when this check passes.
 */
export function isSimulatedOutput(
  text: string,
  ruleContext: TrustLexicalRuleContext
): boolean {
  return hasPatternMatch(text, ruleContext.simulatedOutputPatterns);
}

/**
 * Classifies trust render decision with deterministic rule logic.
 *
 * **Why it exists:**
 * Centralizes classification thresholds for trust render decision so scoring behavior does not drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 * @param ruleContext - Message/text content processed by this function.
 * @returns Computed `TrustRenderClassification` result.
 */
export function classifyTrustRenderDecision(
  input: TrustRenderDecisionInput,
  ruleContext: TrustLexicalRuleContext
): TrustRenderClassification {
  const normalizedText = input.text.trim();
  if (!normalizedText) {
    return toClassification(
      "RENDER_UNCERTAIN",
      "trust_lexical_v1_empty_output",
      "LOW",
      ruleContext.rulepackVersion,
      false
    );
  }

  if (input.hasBlockedUnmatchedAction) {
    return toClassification(
      "RENDER_BLOCKED",
      "trust_lexical_v1_blocked_unmatched_action",
      "MED",
      ruleContext.rulepackVersion,
      false
    );
  }

  const hasBrowserClaim = hasPatternMatch(
    normalizedText,
    ruleContext.browserExecutionClaimPatterns
  );
  const hasSideEffectClaim = hasPatternMatch(
    normalizedText,
    ruleContext.sideEffectCompletionClaimPatterns
  );

  if (hasBrowserClaim && hasSideEffectClaim) {
    const browserSupported = input.hasApprovedRealShellExecution;
    const sideEffectSupported = input.hasApprovedRealNonRespondExecution;
    if (browserSupported && sideEffectSupported) {
      return toClassification(
        "RENDER_APPROVED",
        "trust_lexical_v1_browser_and_side_effect_claim_with_execution",
        "HIGH",
        ruleContext.rulepackVersion,
        false
      );
    }
    if (!browserSupported && !sideEffectSupported) {
      if (
        input.hasApprovedSimulatedShellExecution ||
        input.hasApprovedSimulatedNonRespondExecution
      ) {
        return toClassification(
          "RENDER_SIMULATED",
          "trust_lexical_v1_browser_and_side_effect_claim_simulated",
          "MED",
          ruleContext.rulepackVersion,
          false
        );
      }
      return toClassification(
        "RENDER_UNCERTAIN",
        "trust_lexical_v1_browser_and_side_effect_claim_without_execution",
        "HIGH",
        ruleContext.rulepackVersion,
        false
      );
    }
    return toClassification(
      "RENDER_UNCERTAIN",
      "trust_lexical_v1_conflicting_claim_requirements",
      "LOW",
      ruleContext.rulepackVersion,
      true
    );
  }

  if (hasSideEffectClaim) {
    if (input.hasApprovedRealNonRespondExecution) {
      return toClassification(
        "RENDER_APPROVED",
        "trust_lexical_v1_side_effect_claim_with_execution",
        "HIGH",
        ruleContext.rulepackVersion,
        false
      );
    }
    if (input.hasApprovedSimulatedNonRespondExecution) {
      return toClassification(
        "RENDER_SIMULATED",
        "trust_lexical_v1_side_effect_claim_simulated_execution",
        "MED",
        ruleContext.rulepackVersion,
        false
      );
    }
    return toClassification(
      "RENDER_UNCERTAIN",
      "trust_lexical_v1_side_effect_claim_without_execution",
      "HIGH",
      ruleContext.rulepackVersion,
      false
    );
  }

  if (hasBrowserClaim) {
    if (input.hasApprovedRealShellExecution) {
      return toClassification(
        "RENDER_APPROVED",
        "trust_lexical_v1_browser_claim_with_shell_execution",
        "HIGH",
        ruleContext.rulepackVersion,
        false
      );
    }
    if (input.hasApprovedSimulatedShellExecution) {
      return toClassification(
        "RENDER_SIMULATED",
        "trust_lexical_v1_browser_claim_simulated_shell_execution",
        "MED",
        ruleContext.rulepackVersion,
        false
      );
    }
    return toClassification(
      "RENDER_UNCERTAIN",
      "trust_lexical_v1_browser_claim_without_shell_execution",
      "HIGH",
      ruleContext.rulepackVersion,
      false
    );
  }

  return toClassification(
    "RENDER_APPROVED",
    "trust_lexical_v1_no_claim",
    "LOW",
    ruleContext.rulepackVersion,
    false
  );
}
