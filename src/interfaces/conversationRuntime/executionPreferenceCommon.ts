/**
 * @fileoverview Shared token helpers for deterministic execution-preference extraction.
 */

import {
  collectConversationChatTurnRawTokens,
  normalizeConversationChatTurnWhitespace
} from "./chatTurnSignalAnalysis";
import { hasTokenSequence } from "./chatTurnSignalShapes";

const NEGATION_PREFIX_SEQUENCES: readonly (readonly string[])[] = [
  ["do", "not"],
  ["don't"],
  ["dont"]
] as const;
const POLITE_PREFIX_TOKENS = new Set(["okay", "please"]);
const REQUEST_LEAD_SEQUENCES: readonly (readonly string[])[] = [
  ["can", "you"],
  ["could", "you"],
  ["would", "you"],
  ["will", "you"],
  ["please"]
] as const;
const PREAMBLE_TOKENS = new Set(["hey", "hi", "thanks", "thank", "that", "this", "helps"]);
const DIRECT_EDIT_OBJECT_BLOCKERS = new Set(["me", "us"]);
const NON_DIRECT_REQUEST_ACTION_TOKENS = new Set([
  "build",
  "create",
  "generate",
  "implement",
  "make",
  "run",
  "scaffold",
  "ship"
]);

export const hasAnyTokenSequence = (
  tokens: readonly string[],
  sequences: readonly (readonly string[])[]
): boolean => sequences.some((sequence) => hasTokenSequence(tokens, sequence));

export const hasAnyToken = (
  tokens: readonly string[],
  cues: ReadonlySet<string>
): boolean => tokens.some((token) => cues.has(token));

export const tokenizeExecutionPreferenceInput = (
  value: string
): {
  normalized: string;
  tokens: readonly string[];
} => {
  const normalized = normalizeConversationChatTurnWhitespace(value);
  return {
    normalized,
    tokens: collectConversationChatTurnRawTokens(normalized)
  };
};

export const startsWithImperativeAction = (
  tokens: readonly string[],
  actionTokens: ReadonlySet<string>
): boolean => {
  let index = 0;
  while (
    index < tokens.length &&
    (POLITE_PREFIX_TOKENS.has(tokens[index]!) || PREAMBLE_TOKENS.has(tokens[index]!))
  ) {
    index += 1;
  }
  const action = tokens[index] ?? "";
  return actionTokens.has(action);
};

export const hasNegatedAction = (
  tokens: readonly string[],
  actionToken: string
): boolean =>
  NEGATION_PREFIX_SEQUENCES.some((prefix) =>
    hasTokenSequence(tokens, [...prefix, actionToken])
  );

const findSequenceEndIndex = (
  tokens: readonly string[],
  sequences: readonly (readonly string[])[]
): number | null => {
  for (let index = 0; index < tokens.length; index += 1) {
    for (const sequence of sequences) {
      if (index + sequence.length > tokens.length) {
        continue;
      }
      let matched = true;
      for (let offset = 0; offset < sequence.length; offset += 1) {
        if (tokens[index + offset] !== sequence[offset]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return index + sequence.length;
      }
    }
  }
  return null;
};

export const hasLeadRequestForAction = (
  tokens: readonly string[],
  actionTokens: ReadonlySet<string>
): boolean => {
  const leadEndIndex = findSequenceEndIndex(tokens, REQUEST_LEAD_SEQUENCES);
  if (leadEndIndex === null) {
    return false;
  }
  for (
    let index = leadEndIndex;
    index < Math.min(tokens.length, leadEndIndex + 5);
    index += 1
  ) {
    const token = tokens[index] ?? "";
    if (NON_DIRECT_REQUEST_ACTION_TOKENS.has(token)) {
      return false;
    }
    if (!actionTokens.has(token)) {
      continue;
    }
    const nextToken = tokens[index + 1] ?? "";
    if (DIRECT_EDIT_OBJECT_BLOCKERS.has(nextToken)) {
      return false;
    }
    return true;
  }
  return false;
};

export const directEditTargetsConversation = (tokens: readonly string[]): boolean =>
  DIRECT_EDIT_OBJECT_BLOCKERS.has(tokens[1] ?? "");
