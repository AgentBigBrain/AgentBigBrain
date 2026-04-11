/**
 * @fileoverview Shared bounded matching for natural-language references to tracked runtime targets.
 */

const GENERIC_REFERENCE_TOKENS = new Set([
  "a",
  "an",
  "and",
  "app",
  "browser",
  "build",
  "built",
  "city",
  "close",
  "did",
  "do",
  "does",
  "end",
  "for",
  "if",
  "in",
  "is",
  "it",
  "its",
  "just",
  "make",
  "made",
  "me",
  "my",
  "next",
  "nextjs",
  "of",
  "on",
  "open",
  "out",
  "page",
  "please",
  "preview",
  "project",
  "review",
  "run",
  "running",
  "same",
  "section",
  "server",
  "shut",
  "site",
  "still",
  "that",
  "the",
  "then",
  "this",
  "to",
  "up",
  "verify",
  "we",
  "worked",
  "workflow",
  "you"
]);

/** Normalizes one runtime-target reference candidate for bounded textual matching. */
function normalizeReferenceValue(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Tokenizes one runtime-target reference into non-generic matching terms. */
function tokenizeReferenceValue(value: string): readonly string[] {
  return normalizeReferenceValue(value)
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !GENERIC_REFERENCE_TOKENS.has(token));
}

/**
 * Evaluates whether one natural-language request names a tracked runtime target closely enough to
 * keep deterministic runtime continuity attached.
 *
 * @param request - Current natural-language request.
 * @param candidates - Candidate runtime target names remembered from bounded session/runtime state.
 * @returns `true` when one candidate matches uniquely and strongly enough.
 */
export function requestMatchesRuntimeTargetReference(
  request: string,
  candidates: readonly string[]
): boolean {
  const normalizedRequest = normalizeReferenceValue(request);
  if (!normalizedRequest) {
    return false;
  }

  const normalizedCandidates = [...new Set(
    candidates
      .map((candidate) => normalizeReferenceValue(candidate))
      .filter((candidate) => candidate.length >= 3)
  )];
  if (normalizedCandidates.length === 0) {
    return false;
  }

  const exactMatches = normalizedCandidates.filter((candidate) =>
    normalizedRequest.includes(candidate)
  );
  if (exactMatches.length === 1) {
    return true;
  }
  if (exactMatches.length > 1) {
    return false;
  }

  const requestTokenSet = new Set(tokenizeReferenceValue(normalizedRequest));
  let bestScore = 0;
  let bestMatchCount = 0;

  for (const candidate of normalizedCandidates) {
    const candidateTokens = [...new Set(tokenizeReferenceValue(candidate))];
    if (candidateTokens.length < 2) {
      continue;
    }
    const matchedTokenCount = candidateTokens.filter((token) =>
      requestTokenSet.has(token)
    ).length;
    const requiredTokenCount =
      candidateTokens.length <= 2
        ? candidateTokens.length
        : Math.max(2, candidateTokens.length - 1);
    if (matchedTokenCount < requiredTokenCount) {
      continue;
    }
    if (matchedTokenCount > bestScore) {
      bestScore = matchedTokenCount;
      bestMatchCount = 1;
      continue;
    }
    if (matchedTokenCount === bestScore) {
      bestMatchCount += 1;
    }
  }

  return bestScore > 0 && bestMatchCount === 1;
}
