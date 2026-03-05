/**
 * @fileoverview Deterministic commitment-resolution signal classifier with tightening-only overrides and auditable rule metadata.
 */

export type CommitmentSignalCategory =
  | "TOPIC_RESOLUTION_CANDIDATE"
  | "GENERIC_RESOLUTION"
  | "RESOLVED_MARKER"
  | "NO_SIGNAL"
  | "UNCLEAR";

export type CommitmentSignalConfidenceTier = "HIGH" | "MED" | "LOW";

export type CommitmentSignalMode = "user_input" | "fact_value";

export interface CommitmentSignalClassification {
  category: CommitmentSignalCategory;
  confidenceTier: CommitmentSignalConfidenceTier;
  matchedRuleId: string;
  rulepackVersion: string;
  conflict: boolean;
}

export interface CommitmentSignalOverrideV1 {
  schemaVersion: 1;
  disableGenericResolution?: boolean;
  additionalConflictTokens?: readonly string[];
}

export interface CommitmentSignalRuleContext {
  rulepackVersion: string;
  disableGenericResolution: boolean;
  completionTokens: ReadonlySet<string>;
  completionPhrases: ReadonlySet<string>;
  genericResolutionPhrases: ReadonlySet<string>;
  unresolvedTokens: ReadonlySet<string>;
  unresolvedPhrases: ReadonlySet<string>;
  resolvedValueMarkers: ReadonlySet<string>;
}

export interface CommitmentSignalClassificationContext {
  mode: CommitmentSignalMode;
  ruleContext: CommitmentSignalRuleContext;
}

/**
 * Frozen deterministic baseline rulepack.
 * Locale posture: deterministic, locale-neutral baseline (English-first initially).
 */
export const CommitmentSignalRulepackV1 = Object.freeze({
  version: "CommitmentSignalRulepackV1",
  completionTokens: [
    "closed",
    "complete",
    "completed",
    "done",
    "finished",
    "resolved",
    "shipped"
  ],
  completionPhrases: [
    "turn off notifications",
    "turn off reminders",
    "stop notifications",
    "stop reminders",
    "disable notifications",
    "disable reminders"
  ],
  genericResolutionPhrases: [
    "all set",
    "no longer need help",
    "do not need help",
    "don't need help",
    "dont need help"
  ],
  unresolvedTokens: [
    "blocked",
    "incomplete",
    "open",
    "pending",
    "stuck",
    "todo",
    "unfinished",
    "unresolved"
  ],
  unresolvedPhrases: [
    "not complete",
    "not completed",
    "not done",
    "still pending",
    "still open"
  ],
  resolvedValueMarkers: [
    "closed",
    "complete",
    "completed",
    "done",
    "finished",
    "resolved",
    "shipped"
  ]
} as const);

const MAX_ADDITIONAL_CONFLICT_TOKENS = 24;
const MAX_ADDITIONAL_CONFLICT_TOKEN_LENGTH = 24;

/**
 * Normalizes whitespace into a stable shape for `commitmentSignalClassifier` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for whitespace so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Normalizes classifier text into a stable shape for `commitmentSignalClassifier` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for classifier text so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeClassifierText(value: string): string {
  return normalizeWhitespace(
    value
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}'\s]+/gu, " ")
      .replace(/[\u2019`]/g, "'")
  );
}

/**
 * Normalizes token into a stable shape for `commitmentSignalClassifier` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for token so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeToken(value: string): string {
  return value
    .replace(/'/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

/**
 * Tokenizes for rules for deterministic lexical analysis.
 *
 * **Why it exists:**
 * Maintains one token/segment boundary policy for for rules so lexical decisions stay stable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Ordered collection produced by this step.
 */
function tokenizeForRules(value: string): string[] {
  const normalized = normalizeClassifierText(value);
  if (!normalized) {
    return [];
  }
  return normalized
    .split(" ")
    .map((token) => normalizeToken(token))
    .filter((token) => token.length > 0);
}

/**
 * Converts values into token set form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for token set deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param values - Value for values.
 * @returns Computed `ReadonlySet<string>` result.
 */
function toTokenSet(values: readonly string[]): ReadonlySet<string> {
  return new Set(
    values
      .map((value) => normalizeToken(value))
      .filter((value) => value.length > 0)
      .sort((left, right) => left.localeCompare(right))
  );
}

/**
 * Converts values into phrase set form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for phrase set deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param values - Value for values.
 * @returns Computed `ReadonlySet<string>` result.
 */
function toPhraseSet(values: readonly string[]): ReadonlySet<string> {
  return new Set(
    values
      .map((value) => normalizeClassifierText(value))
      .filter((value) => value.length > 0)
      .sort((left, right) => left.localeCompare(right))
  );
}

/**
 * Parses commitment signal override v1 and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for commitment signal override v1 so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param override - Stable identifier used to reference an entity or record.
 * @returns Ordered collection produced by this step.
 */
function parseCommitmentSignalOverrideV1(
  override: CommitmentSignalOverrideV1
): { disableGenericResolution: boolean; additionalConflictTokens: readonly string[] } {
  if (override.schemaVersion !== 1) {
    throw new Error("CommitmentSignalOverrideV1 schemaVersion must be 1.");
  }

  const disableGenericResolution = override.disableGenericResolution === true;
  const rawAdditionalTokens = override.additionalConflictTokens ?? [];
  if (!Array.isArray(rawAdditionalTokens)) {
    throw new Error("CommitmentSignalOverrideV1 additionalConflictTokens must be an array.");
  }
  if (rawAdditionalTokens.length > MAX_ADDITIONAL_CONFLICT_TOKENS) {
    throw new Error(
      `CommitmentSignalOverrideV1 additionalConflictTokens exceeds ${MAX_ADDITIONAL_CONFLICT_TOKENS}.`
    );
  }

  const additionalConflictTokens: string[] = [];
  for (const rawToken of rawAdditionalTokens) {
    if (typeof rawToken !== "string") {
      throw new Error("CommitmentSignalOverrideV1 additionalConflictTokens contains a non-string value.");
    }
    const normalized = normalizeToken(rawToken);
    if (!normalized) {
      throw new Error("CommitmentSignalOverrideV1 additionalConflictTokens contains an empty value.");
    }
    if (normalized.length > MAX_ADDITIONAL_CONFLICT_TOKEN_LENGTH) {
      throw new Error(
        `CommitmentSignalOverrideV1 additionalConflictToken exceeds ${MAX_ADDITIONAL_CONFLICT_TOKEN_LENGTH} chars.`
      );
    }
    additionalConflictTokens.push(normalized);
  }

  return {
    disableGenericResolution,
    additionalConflictTokens: [...new Set(additionalConflictTokens)].sort((left, right) =>
      left.localeCompare(right)
    )
  };
}

/**
 * Builds commitment signal rule context for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of commitment signal rule context consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param override - Stable identifier used to reference an entity or record.
 * @returns Computed `CommitmentSignalRuleContext` result.
 */
export function createCommitmentSignalRuleContext(
  override: CommitmentSignalOverrideV1 | null = null
): CommitmentSignalRuleContext {
  const baseContext: CommitmentSignalRuleContext = {
    rulepackVersion: CommitmentSignalRulepackV1.version,
    disableGenericResolution: false,
    completionTokens: toTokenSet(CommitmentSignalRulepackV1.completionTokens),
    completionPhrases: toPhraseSet(CommitmentSignalRulepackV1.completionPhrases),
    genericResolutionPhrases: toPhraseSet(CommitmentSignalRulepackV1.genericResolutionPhrases),
    unresolvedTokens: toTokenSet(CommitmentSignalRulepackV1.unresolvedTokens),
    unresolvedPhrases: toPhraseSet(CommitmentSignalRulepackV1.unresolvedPhrases),
    resolvedValueMarkers: toTokenSet(CommitmentSignalRulepackV1.resolvedValueMarkers)
  };
  if (!override) {
    return baseContext;
  }

  const parsed = parseCommitmentSignalOverrideV1(override);
  const unresolvedTokens = new Set(baseContext.unresolvedTokens);
  for (const token of parsed.additionalConflictTokens) {
    unresolvedTokens.add(token);
  }

  return {
    ...baseContext,
    disableGenericResolution: parsed.disableGenericResolution,
    unresolvedTokens
  };
}

/**
 * Evaluates any token and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the any token policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param tokens - Token value used for lexical parsing or matching.
 * @param allowed - Value for allowed.
 * @returns `true` when this check passes.
 */
function hasAnyToken(tokens: readonly string[], allowed: ReadonlySet<string>): boolean {
  return tokens.some((token) => allowed.has(token));
}

/**
 * Evaluates any phrase and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the any phrase policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param normalizedText - Message/text content processed by this function.
 * @param phrases - Value for phrases.
 * @returns `true` when this check passes.
 */
function hasAnyPhrase(normalizedText: string, phrases: ReadonlySet<string>): boolean {
  for (const phrase of phrases) {
    if (normalizedText.includes(phrase)) {
      return true;
    }
  }
  return false;
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
 * @param confidenceTier - Stable identifier used to reference an entity or record.
 * @param matchedRuleId - Stable identifier used to reference an entity or record.
 * @param rulepackVersion - Value for rulepack version.
 * @param conflict - Value for conflict.
 * @returns Computed `CommitmentSignalClassification` result.
 */
function toClassification(
  category: CommitmentSignalCategory,
  confidenceTier: CommitmentSignalConfidenceTier,
  matchedRuleId: string,
  rulepackVersion: string,
  conflict: boolean
): CommitmentSignalClassification {
  return {
    category,
    confidenceTier,
    matchedRuleId,
    rulepackVersion,
    conflict
  };
}

/**
 * Classifies commitment signal with deterministic rule logic.
 *
 * **Why it exists:**
 * Centralizes classification thresholds for commitment signal so scoring behavior does not drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @param context - Message/text content processed by this function.
 * @returns Computed `CommitmentSignalClassification` result.
 */
export function classifyCommitmentSignal(
  text: string,
  context: CommitmentSignalClassificationContext
): CommitmentSignalClassification {
  const normalizedText = normalizeClassifierText(text);
  const tokens = tokenizeForRules(text);
  if (tokens.length === 0) {
    return toClassification(
      "NO_SIGNAL",
      "LOW",
      "commitment_signal_v1_empty_input",
      context.ruleContext.rulepackVersion,
      false
    );
  }

  const hasCompletionToken = hasAnyToken(tokens, context.ruleContext.completionTokens);
  const hasCompletionPhrase = hasAnyPhrase(normalizedText, context.ruleContext.completionPhrases);
  const hasGenericResolutionPhrase = hasAnyPhrase(
    normalizedText,
    context.ruleContext.genericResolutionPhrases
  );
  const hasUnresolvedToken = hasAnyToken(tokens, context.ruleContext.unresolvedTokens);
  const hasUnresolvedPhrase = hasAnyPhrase(normalizedText, context.ruleContext.unresolvedPhrases);
  const hasUnresolvedSignal = hasUnresolvedToken || hasUnresolvedPhrase;

  if (context.mode === "fact_value") {
    const hasResolvedMarker = hasAnyToken(tokens, context.ruleContext.resolvedValueMarkers);
    const conflict = hasResolvedMarker && hasUnresolvedSignal;
    if (conflict) {
      return toClassification(
        "UNCLEAR",
        "LOW",
        "commitment_signal_v1_fact_value_conflict",
        context.ruleContext.rulepackVersion,
        true
      );
    }
    if (!hasResolvedMarker) {
      return toClassification(
        "NO_SIGNAL",
        "LOW",
        "commitment_signal_v1_fact_value_no_resolved_marker",
        context.ruleContext.rulepackVersion,
        false
      );
    }
    return toClassification(
      "RESOLVED_MARKER",
      "HIGH",
      "commitment_signal_v1_fact_value_resolved_marker",
      context.ruleContext.rulepackVersion,
      false
    );
  }

  const hasCompletionSignal = hasCompletionToken || hasCompletionPhrase || hasGenericResolutionPhrase;
  const conflict = hasCompletionSignal && hasUnresolvedSignal;
  if (conflict) {
    return toClassification(
      "UNCLEAR",
      "LOW",
      "commitment_signal_v1_user_input_conflict",
      context.ruleContext.rulepackVersion,
      true
    );
  }

  if (hasGenericResolutionPhrase && !context.ruleContext.disableGenericResolution) {
    return toClassification(
      "GENERIC_RESOLUTION",
      hasCompletionToken || hasCompletionPhrase ? "HIGH" : "MED",
      "commitment_signal_v1_user_input_generic_resolution",
      context.ruleContext.rulepackVersion,
      false
    );
  }

  if (hasCompletionToken || hasCompletionPhrase) {
    return toClassification(
      "TOPIC_RESOLUTION_CANDIDATE",
      "HIGH",
      "commitment_signal_v1_user_input_topic_resolution_candidate",
      context.ruleContext.rulepackVersion,
      false
    );
  }

  return toClassification(
    "NO_SIGNAL",
    "LOW",
    "commitment_signal_v1_user_input_no_resolution_signal",
    context.ruleContext.rulepackVersion,
    false
  );
}
