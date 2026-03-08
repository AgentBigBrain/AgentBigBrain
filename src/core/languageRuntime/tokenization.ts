/**
 * @fileoverview Canonical deterministic tokenization for non-safety language handling.
 */

import type { TokenizationRequest } from "./contracts";
import { getStopWordsForLanguageDomain } from "./stopWordPolicy";

const LANGUAGE_TOKEN_PATTERN = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;

/**
 * Normalizes one token into a stable lower-case term.
 *
 * @param value - Raw token candidate.
 * @returns Stable normalized token.
 */
export function normalizeLanguageToken(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/**
 * Tokenizes free-form text for one bounded deterministic language domain.
 *
 * @param request - Tokenization request.
 * @returns Stable unique normalized terms.
 */
export function tokenizeLanguageTerms(request: TokenizationRequest): readonly string[] {
  const matches = request.text.match(LANGUAGE_TOKEN_PATTERN) ?? [];
  const stopWords = getStopWordsForLanguageDomain(request.domain, request.profileId);
  const minTokenLength = request.minTokenLength ?? 3;
  const maxTokens = request.maxTokens ?? Number.POSITIVE_INFINITY;
  const normalized = new Set<string>();

  for (const match of matches) {
    const token = normalizeLanguageToken(match);
    if (token.length < minTokenLength || stopWords.has(token)) {
      continue;
    }
    normalized.add(token);
    if (normalized.size >= maxTokens) {
      break;
    }
  }

  return [...normalized];
}
