/**
 * @fileoverview Applies deterministic invocation-name policy so interface messages are processed only when explicitly addressed.
 */

export interface InvocationPolicyConfig {
  requireNameCall: boolean;
  aliases: string[];
}

export interface InvocationPolicyDecision {
  accepted: boolean;
  normalizedText: string;
  matchedAlias: string | null;
  reason: "ALIAS_NOT_REQUIRED" | "ALIAS_MATCHED" | "ALIAS_REQUIRED" | "EMPTY_AFTER_ALIAS";
}

const VOCATIVE_GREETING_TOKENS = new Set([
  "hello",
  "hi",
  "hey",
  "yo",
  "morning",
  "afternoon",
  "evening"
]);

/**
 * Normalizes alias into a stable shape for `invocationPolicy` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for alias so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeAlias(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

/**
 * Normalizes a token for alias-comparison while allowing trailing punctuation in vocative forms.
 *
 * @param value - Raw token value from the user message.
 * @returns Alias-comparison-safe token.
 */
function normalizeAliasToken(value: string): string {
  return normalizeAlias(value).replace(/[,:;.!?\-]+$/g, "");
}

/**
 * Normalizes aliases into a stable shape for `invocationPolicy` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for aliases so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param aliases - Value for aliases.
 * @returns Ordered collection produced by this step.
 */
function normalizeAliases(aliases: string[]): string[] {
  const deduped = new Set<string>();
  for (const alias of aliases) {
    const normalized = normalizeAlias(alias);
    if (!normalized) {
      continue;
    }
    deduped.add(normalized);
  }
  return Array.from(deduped);
}

/**
 * Derives alias match from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for alias match in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param trimmedText - Message/text content processed by this function.
 * @param alias - Value for alias.
 * @returns Computed `{ matched: boolean; remainder: string }` result.
 */
function extractAliasMatch(
  trimmedText: string,
  alias: string
): { matched: boolean; remainder: string } {
  const vocativeMatch = extractVocativeAliasMatch(trimmedText, alias);
  if (vocativeMatch.matched) {
    return vocativeMatch;
  }

  const lowerText = trimmedText.toLowerCase();
  const directPrefix = alias;
  const atPrefix = `@${alias}`;

  const prefixes = [directPrefix, atPrefix];
  for (const prefix of prefixes) {
    if (!lowerText.startsWith(prefix)) {
      continue;
    }

    const nextCharacter = trimmedText.charAt(prefix.length);
    const boundaryAllowed =
      nextCharacter.length === 0 || /[\s,:;.!?\-]/.test(nextCharacter);
    if (!boundaryAllowed) {
      continue;
    }

    const remainder = trimmedText
      .slice(prefix.length)
      .replace(/^[\s,:;.!?\-]+/, "")
      .trim();
    return {
      matched: true,
      remainder
    };
  }

  return {
    matched: false,
    remainder: ""
  };
}

/**
 * Accepts bounded greeting-plus-alias forms like `Hi BigBrain` or `Hey, BigBrain, ...`.
 *
 * This keeps the name-call gate human-friendly without turning any arbitrary in-sentence alias
 * mention into an accepted invocation.
 *
 * @param trimmedText - User message trimmed for invocation matching.
 * @param alias - Normalized invocation alias.
 * @returns Matched state plus normalized remainder text.
 */
function extractVocativeAliasMatch(
  trimmedText: string,
  alias: string
): { matched: boolean; remainder: string } {
  const normalizedText = trimmedText.trim();
  if (!normalizedText) {
    return { matched: false, remainder: "" };
  }

  const rawTokens = normalizedText.split(/\s+/);
  if (rawTokens.length < 2) {
    return { matched: false, remainder: "" };
  }

  const aliasTokenIndex = rawTokens.findIndex((token) => normalizeAliasToken(token) === alias);
  if (aliasTokenIndex <= 0) {
    return { matched: false, remainder: "" };
  }

  const leadingTokens = rawTokens.slice(0, aliasTokenIndex);
  const leadingNormalized = leadingTokens
    .map((token) => normalizeAliasToken(token))
    .filter((token) => token.length > 0);
  if (
    leadingNormalized.length === 0 ||
    leadingNormalized.length > 3 ||
    leadingNormalized.some((token) => !VOCATIVE_GREETING_TOKENS.has(token))
  ) {
    return { matched: false, remainder: "" };
  }

  const aliasToken = rawTokens[aliasTokenIndex];
  const aliasTail = aliasToken.slice(aliasToken.toLowerCase().indexOf(alias) + alias.length);
  if (aliasTail && !/^[,:;.!?\-]+$/.test(aliasTail)) {
    return { matched: false, remainder: "" };
  }

  const remainderTokens = rawTokens.filter((_, index) => index !== aliasTokenIndex);
  const remainder = remainderTokens.join(" ").trim();
  return {
    matched: true,
    remainder
  };
}

/**
 * Executes invocation policy as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the invocation policy runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @param policy - Configuration or policy settings applied here.
 * @returns Computed `InvocationPolicyDecision` result.
 */
export function applyInvocationPolicy(
  text: string,
  policy: InvocationPolicyConfig
): InvocationPolicyDecision {
  const trimmedText = text.trim();
  if (!policy.requireNameCall) {
    return {
      accepted: trimmedText.length > 0,
      normalizedText: trimmedText,
      matchedAlias: null,
      reason: "ALIAS_NOT_REQUIRED"
    };
  }

  const aliases = normalizeAliases(policy.aliases);
  for (const alias of aliases) {
    const match = extractAliasMatch(trimmedText, alias);
    if (!match.matched) {
      continue;
    }

    if (!match.remainder) {
      return {
        accepted: false,
        normalizedText: "",
        matchedAlias: alias,
        reason: "EMPTY_AFTER_ALIAS"
      };
    }

    return {
      accepted: true,
      normalizedText: match.remainder,
      matchedAlias: alias,
      reason: "ALIAS_MATCHED"
    };
  }

  return {
    accepted: false,
    normalizedText: "",
    matchedAlias: null,
    reason: "ALIAS_REQUIRED"
  };
}

