/**
 * @fileoverview Deterministic preferred-name normalization and model-candidate validation.
 */

import type { ProfileFactUpsertInput } from "../profileMemory";
import type { ProfileValidatedFactCandidateInput } from "./contracts";
import {
  canonicalizeProfileKey,
  normalizeProfileValue,
  trimTrailingClausePunctuation
} from "./profileMemoryNormalization";

const PREFERRED_NAME_TOKEN_PATTERN = /^[\p{L}]+(?:['\u2019-][\p{L}]+)*$/u;
const PREFERRED_NAME_CONNECTOR_TOKENS = new Set([
  "al", "bin", "da", "de", "del", "di", "dos", "du", "el", "la", "le", "van", "von"
]);
const MAX_VALIDATED_PREFERRED_NAME_LENGTH = 60;

/**
 * Returns whether one token begins with an uppercase letter.
 *
 * @param token - Token under evaluation.
 * @returns `true` when the token begins with an uppercase letter.
 */
function startsUppercase(token: string): boolean {
  return /^\p{Lu}/u.test(token);
}

/**
 * Extracts the most plausible preferred-name span from one captured clause using token shape.
 *
 * @param value - Raw captured preferred-name clause.
 * @returns Sanitized preferred-name text.
 */
export function trimPreferredNameValue(value: string): string {
  const clauseHead = trimTrailingClausePunctuation(value)
    .split(/[,:;]/, 1)[0]
    ?.trim() ?? "";
  if (!clauseHead) {
    return "";
  }

  const tokens = clauseHead
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return "";
  }

  const accepted: string[] = [];
  for (const [index, token] of tokens.entries()) {
    if (!PREFERRED_NAME_TOKEN_PATTERN.test(token)) {
      break;
    }

    const normalizedToken = token.toLocaleLowerCase();
    if (index === 0) {
      accepted.push(token);
      continue;
    }

    if (PREFERRED_NAME_CONNECTOR_TOKENS.has(normalizedToken) || startsUppercase(token)) {
      accepted.push(token);
      continue;
    }

    const firstToken = accepted[0] ?? "";
    const allLowercaseTwoTokenName =
      tokens.length === 2 &&
      firstToken === firstToken.toLocaleLowerCase() &&
      token === normalizedToken;
    if (allLowercaseTwoTokenName) {
      accepted.push(token);
      continue;
    }

    break;
  }

  while (
    accepted.length > 0 &&
    PREFERRED_NAME_CONNECTOR_TOKENS.has(accepted[accepted.length - 1]!.toLocaleLowerCase())
  ) {
    accepted.pop();
  }

  if (accepted.length === 0 || accepted.length > 4) {
    return "";
  }

  return normalizeProfileValue(accepted.join(" "));
}

/**
 * Returns whether one preferred-name capture is actually workflow or clause phrasing.
 *
 * @param value - Trimmed preferred-name capture.
 * @returns `true` when the capture should be rejected as non-name phrasing.
 */
export function looksLikeCommandStylePreferredName(value: string): boolean {
  if (!value) {
    return true;
  }
  if (/^(?:when|if|once|after|before|until|unless|while)\b/i.test(value)) {
    return true;
  }

  const tokens = value.trim().split(/\s+/).filter(Boolean);
  return tokens.length === 0 || tokens.length > 4;
}

/**
 * Validates one preferred-name candidate proposed by a trusted upstream semantic interpreter.
 *
 * @param candidateValue - Model-proposed preferred name candidate.
 * @returns Canonical preferred name when the candidate is deterministic-safe, otherwise `null`.
 */
export function validatePreferredNameCandidateValue(candidateValue: string | null): string | null {
  const normalizedCandidate = normalizeProfileValue(candidateValue ?? "");
  if (
    !normalizedCandidate ||
    normalizedCandidate.length > MAX_VALIDATED_PREFERRED_NAME_LENGTH ||
    /[\\/]/.test(normalizedCandidate) ||
    /\b(?:https?:\/\/|file:\/\/\/)\b/i.test(normalizedCandidate) ||
    /[`$=<>{}\[\]()]/.test(normalizedCandidate)
  ) {
    return null;
  }

  const extractedPreferredName = trimPreferredNameValue(normalizedCandidate);
  return extractedPreferredName === normalizedCandidate ? normalizedCandidate : null;
}

/**
 * Converts validated semantic-interpreter candidates into canonical profile-memory upsert inputs.
 *
 * @param validatedCandidates - Pre-validated semantic candidates proposed by higher-level runtime code.
 * @param sourceTaskId - Task id used for provenance on accepted candidates.
 * @param observedAt - Observation timestamp attached to accepted candidates.
 * @returns Canonical fact candidates safe for the normal fact-upsert path.
 */
export function buildValidatedProfileFactCandidates(
  validatedCandidates: readonly ProfileValidatedFactCandidateInput[],
  sourceTaskId: string,
  observedAt: string
): readonly ProfileFactUpsertInput[] {
  const normalizedCandidates: ProfileFactUpsertInput[] = [];
  for (const candidate of validatedCandidates) {
    if (canonicalizeProfileKey(candidate.key) !== "identity.preferred_name") {
      continue;
    }
    const validatedPreferredName = validatePreferredNameCandidateValue(candidate.candidateValue);
    if (!validatedPreferredName) {
      continue;
    }
    normalizedCandidates.push({
      key: "identity.preferred_name",
      value: validatedPreferredName,
      sensitive: candidate.sensitive === true,
      sourceTaskId,
      source: candidate.source,
      observedAt,
      confidence: candidate.confidence ?? 0.95
    });
  }
  return normalizedCandidates;
}
