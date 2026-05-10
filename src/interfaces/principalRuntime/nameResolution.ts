/**
 * @fileoverview Request-scoped name resolution for principal/subject-aware direct replies.
 */

import type { MemorySubjectRef, PrincipalContext } from "./principalAccess";

export type NameResolutionScope = "current_speaker" | "session_only" | "collision" | "none";
export type NameResolutionCandidateSource =
  | "same_subject_profile_fact"
  | "transport_display_name"
  | "transport_given_name"
  | "transport_username"
  | "transport_first_token";

export interface NameResolutionCandidate {
  value: string;
  source: NameResolutionCandidateSource;
  confidence: string;
  subjectRef: MemorySubjectRef | null;
  publicSafeLabel: string;
}

export interface NameResolutionResult {
  scope: NameResolutionScope;
  matchedName: string | null;
  matchedSource: NameResolutionCandidateSource | null;
  confidence: string | null;
  publicSafeLabel: string;
  currentSpeakerSubjectRef: MemorySubjectRef | null;
  ownerSubjectRef: MemorySubjectRef | null;
  sameNameCollision: boolean;
  accessClass: "owner_private" | "speaker_private" | "shared_public" | "session_only";
  factsTrustedForCurrentSpeaker: boolean;
  authorityNote: "reference_only";
}

export interface NameResolutionFact {
  key: string;
  value: string;
  confidence: number;
}

export interface NameResolutionTransportHint {
  value: string;
  source: "display_name" | "given_name" | "username";
  confidence: string;
}

export interface ResolveCurrentSpeakerNameResolutionInput {
  userInput: string;
  principalContext: PrincipalContext | null | undefined;
  identityFacts: readonly NameResolutionFact[];
  transportHint: NameResolutionTransportHint | null;
  factsTrustedForCurrentSpeaker: boolean;
}

/**
 * Resolves whether the current request names the current speaker without granting memory or action
 * authority.
 */
export function resolveCurrentSpeakerNameResolution(
  input: ResolveCurrentSpeakerNameResolutionInput
): NameResolutionResult {
  const currentSpeakerSubjectRef = input.principalContext?.subject.speakerSubjectRef ?? null;
  const ownerSubjectRef = input.principalContext?.subject.ownerSubjectRef ?? null;
  const candidates = collectNameResolutionCandidates({
    currentSpeakerSubjectRef,
    identityFacts: input.factsTrustedForCurrentSpeaker ? input.identityFacts : [],
    transportHint: input.transportHint
  });
  const matchedCandidate = selectMentionedNameResolutionCandidate(input.userInput, candidates);
  if (!matchedCandidate) {
    return buildEmptyNameResolution(input.principalContext ?? null, input.factsTrustedForCurrentSpeaker);
  }
  const accessClass = resolveNameResolutionAccessClass(input.principalContext ?? null);
  return {
    scope: accessClass === "shared_public" ? "session_only" : "current_speaker",
    matchedName: matchedCandidate.value,
    matchedSource: matchedCandidate.source,
    confidence: matchedCandidate.confidence,
    publicSafeLabel: matchedCandidate.publicSafeLabel,
    currentSpeakerSubjectRef,
    ownerSubjectRef,
    sameNameCollision: false,
    accessClass,
    factsTrustedForCurrentSpeaker: input.factsTrustedForCurrentSpeaker,
    authorityNote: "reference_only"
  };
}

/**
 * Implements `collectNameResolutionCandidates` behavior within this module.
 */
function collectNameResolutionCandidates(input: {
  currentSpeakerSubjectRef: MemorySubjectRef | null;
  identityFacts: readonly NameResolutionFact[];
  transportHint: NameResolutionTransportHint | null;
}): readonly NameResolutionCandidate[] {
  const candidates: NameResolutionCandidate[] = [];
  const seen = new Set<string>();
  for (const fact of input.identityFacts) {
    pushNameResolutionCandidate(candidates, seen, {
      value: fact.value,
      source: "same_subject_profile_fact",
      confidence: fact.confidence.toFixed(2),
      subjectRef: input.currentSpeakerSubjectRef,
      publicSafeLabel: "you in this session"
    });
  }
  if (input.transportHint) {
    const source = normalizeTransportHintSource(input.transportHint.source);
    pushNameResolutionCandidate(candidates, seen, {
      value: input.transportHint.value,
      source,
      confidence: input.transportHint.confidence,
      subjectRef: input.currentSpeakerSubjectRef,
      publicSafeLabel: "you in this session"
    });
    const firstToken = input.transportHint.value.replace(/\s+/g, " ").trim().split(" ")[0];
    if (firstToken && tokenizeNameResolutionText(firstToken)[0]?.length >= 2) {
      pushNameResolutionCandidate(candidates, seen, {
        value: firstToken,
        source: "transport_first_token",
        confidence: input.transportHint.confidence,
        subjectRef: input.currentSpeakerSubjectRef,
        publicSafeLabel: "you in this session"
      });
    }
  }
  return candidates.slice(0, 6);
}

/**
 * Implements `pushNameResolutionCandidate` behavior within this module.
 */
function pushNameResolutionCandidate(
  target: NameResolutionCandidate[],
  seen: Set<string>,
  candidate: NameResolutionCandidate
): void {
  const normalizedValue = candidate.value.replace(/\s+/g, " ").trim();
  const signature = tokenizeNameResolutionText(normalizedValue).join(" ");
  if (!normalizedValue || !signature || seen.has(signature)) {
    return;
  }
  seen.add(signature);
  target.push({
    ...candidate,
    value: normalizedValue
  });
}

/**
 * Implements `selectMentionedNameResolutionCandidate` behavior within this module.
 */
function selectMentionedNameResolutionCandidate(
  userInput: string,
  candidates: readonly NameResolutionCandidate[]
): NameResolutionCandidate | null {
  const inputTokens = tokenizeNameResolutionText(userInput);
  return candidates.find((candidate) =>
    hasTokenSequence(inputTokens, tokenizeNameResolutionText(candidate.value))
  ) ?? null;
}

/**
 * Implements `tokenizeNameResolutionText` behavior within this module.
 */
function tokenizeNameResolutionText(value: string): readonly string[] {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * Implements `hasTokenSequence` behavior within this module.
 */
function hasTokenSequence(
  inputTokens: readonly string[],
  candidateTokens: readonly string[]
): boolean {
  if (candidateTokens.length === 0 || candidateTokens.length > inputTokens.length) {
    return false;
  }
  for (let index = 0; index <= inputTokens.length - candidateTokens.length; index += 1) {
    if (candidateTokens.every((token, offset) => inputTokens[index + offset] === token)) {
      return true;
    }
  }
  return false;
}

/**
 * Implements `normalizeTransportHintSource` behavior within this module.
 */
function normalizeTransportHintSource(
  source: NameResolutionTransportHint["source"]
): NameResolutionCandidateSource {
  return source === "display_name"
    ? "transport_display_name"
    : source === "given_name"
      ? "transport_given_name"
      : "transport_username";
}

/**
 * Implements `resolveNameResolutionAccessClass` behavior within this module.
 */
function resolveNameResolutionAccessClass(
  principalContext: PrincipalContext | null
): NameResolutionResult["accessClass"] {
  if (!principalContext) {
    return "session_only";
  }
  if (principalContext.route.visibility === "public") {
    return "shared_public";
  }
  if (principalContext.actor.principalRole === "owner") {
    return "owner_private";
  }
  return "speaker_private";
}

/**
 * Implements `buildEmptyNameResolution` behavior within this module.
 */
function buildEmptyNameResolution(
  principalContext: PrincipalContext | null,
  factsTrustedForCurrentSpeaker: boolean
): NameResolutionResult {
  return {
    scope: "none",
    matchedName: null,
    matchedSource: null,
    confidence: null,
    publicSafeLabel: "you in this session",
    currentSpeakerSubjectRef: principalContext?.subject.speakerSubjectRef ?? null,
    ownerSubjectRef: principalContext?.subject.ownerSubjectRef ?? null,
    sameNameCollision: false,
    accessClass: resolveNameResolutionAccessClass(principalContext),
    factsTrustedForCurrentSpeaker,
    authorityNote: "reference_only"
  };
}
