/**
 * @fileoverview Deterministic clarification-option matching helpers for the conversation front
 * door.
 */

import type { ClarificationOptionId } from "../sessionStore";
import {
  collectConversationChatTurnRawTokens,
  normalizeConversationChatTurnWhitespace
} from "./chatTurnSignalAnalysis";

const AFFIRMATION_TOKENS = new Set(["yes", "yeah", "yep", "sure", "okay", "ok"]);
const NEGATION_TOKENS = new Set(["no", "nope", "nah", "cancel", "stop"]);

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
function hasTokenSequence(tokens: readonly string[], sequence: readonly string[]): boolean {
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
 * Evaluates whether any token sequence.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @param sequences - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function hasAnyTokenSequence(
  tokens: readonly string[],
  sequences: readonly (readonly string[])[]
): boolean {
  return sequences.some((sequence) => hasTokenSequence(tokens, sequence));
}

/**
 * Evaluates whether any token.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @param cues - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function hasAnyToken(tokens: readonly string[], cues: ReadonlySet<string>): boolean {
  return tokens.some((token) => cues.has(token));
}

/**
 * Evaluates whether plan answer.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function matchesPlanAnswer(tokens: readonly string[]): boolean {
  return (
    tokens.includes("plan")
    || tokens.includes("outline")
    || tokens.includes("proposal")
    || hasAnyTokenSequence(tokens, [
      ["plan", "it"],
      ["plan", "first"],
      ["walk", "me", "through"],
      ["talk", "me", "through"]
    ])
  );
}

/**
 * Evaluates whether build answer.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function matchesBuildAnswer(tokens: readonly string[]): boolean {
  return (
    hasAnyToken(tokens, new Set(["build", "create", "implement"]))
    || hasAnyTokenSequence(tokens, [
      ["build", "it"],
      ["make", "it"],
      ["go", "ahead", "with", "the", "real", "thing"]
    ])
  );
}

/**
 * Evaluates whether static html answer.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function matchesStaticHtmlAnswer(tokens: readonly string[]): boolean {
  return (
    hasAnyToken(tokens, new Set(["html"]))
    || hasAnyTokenSequence(tokens, [
      ["plain", "html"],
      ["static", "html"],
      ["single", "file", "html"],
      ["just", "html"]
    ])
  );
}

/**
 * Evaluates whether next js answer.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function matchesNextJsAnswer(tokens: readonly string[]): boolean {
  return (
    hasAnyToken(tokens, new Set(["nextjs", "next.js"]))
    || hasAnyTokenSequence(tokens, [
      ["next", "js"],
      ["next", "dot", "js"]
    ])
  );
}

/**
 * Evaluates whether react answer.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function matchesReactAnswer(tokens: readonly string[]): boolean {
  return (
    hasAnyToken(tokens, new Set(["react"]))
    || hasAnyTokenSequence(tokens, [
      ["react", "app"],
      ["react", "site"]
    ])
  );
}

/**
 * Evaluates whether explain answer.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function matchesExplainAnswer(tokens: readonly string[]): boolean {
  return (
    tokens.includes("explain")
    || hasAnyTokenSequence(tokens, [
      ["explain", "it"],
      ["talk", "me", "through"],
      ["walk", "me", "through"],
      ["show", "me", "why"]
    ])
  );
}

/**
 * Evaluates whether fix now answer.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function matchesFixNowAnswer(tokens: readonly string[]): boolean {
  return (
    hasAnyToken(tokens, new Set(["fix", "repair", "execute"]))
    || hasAnyTokenSequence(tokens, [
      ["fix", "it"],
      ["do", "it", "now"],
      ["just", "do", "it"],
      ["run", "it", "now"]
    ])
  );
}

/**
 * Evaluates whether skills answer.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function matchesSkillsAnswer(tokens: readonly string[]): boolean {
  return (
    hasAnyToken(tokens, new Set(["skills", "skill", "tools", "tool", "list", "show"]))
    || hasAnyTokenSequence(tokens, [["what", "do", "you", "know"]])
  );
}

/**
 * Evaluates whether continue recovery answer.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function matchesContinueRecoveryAnswer(tokens: readonly string[]): boolean {
  return (
    hasAnyToken(tokens, AFFIRMATION_TOKENS)
    || hasAnyTokenSequence(tokens, [
      ["go", "ahead"],
      ["please", "do"]
    ])
    || tokens.includes("continue")
    || tokens.includes("inspect")
    || tokens.includes("recover")
    || hasAnyTokenSequence(tokens, [
      ["try", "again"],
      ["look", "into"],
      ["look", "closer"]
    ])
  );
}

/**
 * Evaluates whether retry with shutdown answer.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function matchesRetryWithShutdownAnswer(tokens: readonly string[]): boolean {
  return (
    hasAnyToken(tokens, AFFIRMATION_TOKENS)
    || hasAnyTokenSequence(tokens, [
      ["go", "ahead"],
      ["please", "do"]
    ])
    || tokens.includes("retry")
    || hasAnyTokenSequence(tokens, [
      ["shut", "them", "down"],
      ["shut", "those", "down"],
      ["shut", "it", "down"],
      ["close", "them"],
      ["close", "those"],
      ["close", "it"],
      ["fix", "it"],
      ["do", "that"]
    ])
  );
}

/**
 * Evaluates whether cancel answer.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param tokens - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function matchesCancelAnswer(tokens: readonly string[]): boolean {
  return (
    hasAnyToken(tokens, NEGATION_TOKENS)
    || hasAnyTokenSequence(tokens, [
      ["never", "mind"],
      ["leave", "them", "alone"],
      ["leave", "those", "alone"],
      ["leave", "it", "alone"],
      ["where", "they", "are"],
      ["where", "it", "is"],
      ["do", "not"]
    ])
  );
}

/**
 * Tokenizes clarification reply.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `collectConversationChatTurnRawTokens` (import `collectConversationChatTurnRawTokens`) from `./chatTurnSignalAnalysis`.
 * - Uses `normalizeConversationChatTurnWhitespace` (import `normalizeConversationChatTurnWhitespace`) from `./chatTurnSignalAnalysis`.
 * @param userInput - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function tokenizeClarificationReply(userInput: string): {
  normalized: string;
  tokens: readonly string[];
} {
  const normalized = normalizeConversationChatTurnWhitespace(userInput);
  return {
    normalized,
    tokens: collectConversationChatTurnRawTokens(normalized)
  };
}

/**
 * Evaluates whether clarification option.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ClarificationOptionId` (import `ClarificationOptionId`) from `../sessionStore`.
 * @param optionId - Input consumed by this helper.
 * @param tokens - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function matchesClarificationOption(
  optionId: ClarificationOptionId,
  tokens: readonly string[]
): boolean {
  switch (optionId) {
    case "plan":
      return matchesPlanAnswer(tokens);
    case "build":
      return matchesBuildAnswer(tokens);
    case "static_html":
      return matchesStaticHtmlAnswer(tokens);
    case "nextjs":
      return matchesNextJsAnswer(tokens);
    case "react":
      return matchesReactAnswer(tokens);
    case "explain":
      return matchesExplainAnswer(tokens);
    case "fix_now":
      return matchesFixNowAnswer(tokens);
    case "skills":
      return matchesSkillsAnswer(tokens);
    case "continue_recovery":
      return matchesContinueRecoveryAnswer(tokens);
    case "retry_with_shutdown":
      return matchesRetryWithShutdownAnswer(tokens);
    case "cancel":
      return matchesCancelAnswer(tokens);
    default:
      return false;
  }
}

export const AFFIRMATION_RESPONSE_TOKENS = AFFIRMATION_TOKENS;
