import { resolveClarificationOptions } from "../../organs/languageUnderstanding/clarificationIntentRanking";
import { collectConversationChatTurnRawTokens } from "./chatTurnSignalAnalysis";
import type { ResolvedConversationIntentMode } from "./intentModeContracts";

const REVIEW_FEEDBACK_SEQUENCES: readonly (readonly string[])[] = [
  ["you", "did", "this", "wrong"],
  ["you", "did", "that", "wrong"],
  ["this", "is", "wrong"],
  ["fix", "what", "you", "did"],
  ["correct", "this"],
  ["correct", "that"],
  ["look", "at", "this", "screenshot"],
  ["look", "at", "the", "screenshot"]
] as const;

const BUILD_FORMAT_CLARIFY_VERBS = new Set([
  "build",
  "create",
  "make",
  "generate",
  "scaffold"
]);

const BUILD_FORMAT_CLARIFY_SINGLE_TARGETS = new Set([
  "page",
  "site",
  "website",
  "homepage"
]);
const BUILD_FORMAT_DESTINATION_TOKENS = new Set([
  "desktop",
  "directory",
  "folder",
  "path"
]);

const BUILD_FORMAT_CLARIFY_EXCLUDED_VERBS = new Set([
  "change",
  "edit",
  "update",
  "replace",
  "swap",
  "revise",
  "tweak",
  "adjust"
]);

const BUILD_FORMAT_CLARIFICATION_QUESTION =
  "Would you like that built as plain HTML, or as a framework app like Next.js or React?";

export const EXPLICIT_FRAMEWORK_MENTION_PATTERN =
  /\b(?:react|vite|next\.?js|nextjs|vue|svelte|angular)\b/i;
const EXPLICIT_BUILD_FORMAT_AMBIGUITY_PATTERN =
  /\b(?:plain\s+html|static\s+html|single[- ]file\s+html)\b[\s\S]{0,80}\b(?:or|vs\.?|versus)\b[\s\S]{0,80}\b(?:framework|react|next\.?js|nextjs|vite|vue|svelte|angular)\b|\b(?:split|unsure|unclear|deciding|torn)\b[\s\S]{0,80}\b(?:plain\s+html|static\s+html|framework|react|next\.?js|nextjs|vite|vue|svelte|angular)\b/i;
const EXPLICIT_WINDOWS_PATH_PATTERN = /[a-z]:\\/i;

/**
 * Evaluates whether token sequence.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @param sequence - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function hasTokenSequence(
  tokens: readonly string[],
  sequence: readonly string[]
): boolean {
  if (sequence.length === 0 || sequence.length > tokens.length) {
    return false;
  }
  for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (tokens[index + offset] !== sequence[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates whether review feedback shape.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `collectConversationChatTurnRawTokens` (import `collectConversationChatTurnRawTokens`) from `./chatTurnSignalAnalysis`.
 * @param userInput - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function hasReviewFeedbackShape(userInput: string): boolean {
  const tokens = collectConversationChatTurnRawTokens(userInput);
  return REVIEW_FEEDBACK_SEQUENCES.some((sequence) => hasTokenSequence(tokens, sequence));
}

/**
 * Evaluates whether ambiguous build format request shape.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `collectConversationChatTurnRawTokens` (import `collectConversationChatTurnRawTokens`) from `./chatTurnSignalAnalysis`.
 * @param userInput - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function hasAmbiguousBuildFormatRequestShape(userInput: string): boolean {
  const tokens = collectConversationChatTurnRawTokens(userInput);
  const hasBuildVerb = tokens.some((token) => BUILD_FORMAT_CLARIFY_VERBS.has(token));
  if (!hasBuildVerb) {
    return false;
  }
  if (tokens.some((token) => BUILD_FORMAT_CLARIFY_EXCLUDED_VERBS.has(token))) {
    return false;
  }
  return (
    hasTokenSequence(tokens, ["landing", "page"]) ||
    tokens.some((token) => BUILD_FORMAT_CLARIFY_SINGLE_TARGETS.has(token))
  );
}

/**
 * Evaluates whether format sensitive build destination shape.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `collectConversationChatTurnRawTokens` (import `collectConversationChatTurnRawTokens`) from `./chatTurnSignalAnalysis`.
 * @param userInput - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function hasFormatSensitiveBuildDestinationShape(userInput: string): boolean {
  const tokens = collectConversationChatTurnRawTokens(userInput);
  if (EXPLICIT_WINDOWS_PATH_PATTERN.test(userInput)) {
    return true;
  }
  return (
    hasTokenSequence(tokens, ["exact", "folder"]) ||
    hasTokenSequence(tokens, ["exact", "path"]) ||
    hasTokenSequence(tokens, ["exact", "directory"]) ||
    (tokens.includes("exact") &&
      tokens.some((token) => BUILD_FORMAT_DESTINATION_TOKENS.has(token)))
  );
}

/**
 * Evaluates whether explicit build format ambiguity cue.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param userInput - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function hasExplicitBuildFormatAmbiguityCue(userInput: string): boolean {
  return EXPLICIT_BUILD_FORMAT_AMBIGUITY_PATTERN.test(userInput);
}

/**
 * Builds build format clarification resolution.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `resolveClarificationOptions` (import `resolveClarificationOptions`) from `../../organs/languageUnderstanding/clarificationIntentRanking`.
 * - Uses `ResolvedConversationIntentMode` (import `ResolvedConversationIntentMode`) from `./intentModeContracts`.
 * @param matchedRuleId - Input consumed by this helper.
 * @param explanation - Input consumed by this helper.
 * @param confidence - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function buildBuildFormatClarificationResolution(
  matchedRuleId: string,
  explanation: string,
  confidence: ResolvedConversationIntentMode["confidence"] = "medium"
): ResolvedConversationIntentMode {
  return {
    mode: "clarify_build_format",
    confidence,
    matchedRuleId,
    explanation,
    semanticRouteId: "clarify_build_format",
    clarification: {
      kind: "build_format",
      matchedRuleId,
      renderingIntent: "build_format",
      question: BUILD_FORMAT_CLARIFICATION_QUESTION,
      options: resolveClarificationOptions("build_format")
    }
  };
}

/**
 * Ensures structured build format clarification.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ResolvedConversationIntentMode` (import `ResolvedConversationIntentMode`) from `./intentModeContracts`.
 * @param resolution - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function ensureStructuredBuildFormatClarification(
  resolution: ResolvedConversationIntentMode
): ResolvedConversationIntentMode {
  if (resolution.mode !== "clarify_build_format" || resolution.clarification) {
    return resolution;
  }
  return buildBuildFormatClarificationResolution(
    resolution.matchedRuleId,
    resolution.explanation,
    resolution.confidence
  );
}
