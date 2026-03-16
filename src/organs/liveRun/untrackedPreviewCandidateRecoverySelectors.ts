/**
 * @fileoverview Shared selector helpers for narrow non-preview holder recovery lanes.
 */

import type { UntrackedHolderCandidate } from "./untrackedPreviewCandidateInspection";

const MAX_CONTEXTUAL_LOCAL_NON_PREVIEW_CANDIDATES = 8;
const MAX_LOW_CONFIDENCE_CONTEXTUAL_CANDIDATES = 3;
const MAX_CONTEXTUAL_LOCAL_NON_PREVIEW_MANUAL_CLEANUP_CANDIDATES = 12;
const MAX_LOW_CONFIDENCE_CONTEXTUAL_MANUAL_CLEANUP_CANDIDATES = 4;
const MAX_GROUPED_CONTEXTUAL_LOCAL_NON_PREVIEW_MANUAL_CLEANUP_CANDIDATES = 18;
const MAX_REPEATED_FAMILY_CONTEXTUAL_LOCAL_NON_PREVIEW_MANUAL_CLEANUP_CANDIDATES = 24;
const MAX_LOW_CONFIDENCE_GROUPED_CONTEXTUAL_MANUAL_CLEANUP_CANDIDATES = 5;
const MAX_LOW_CONFIDENCE_REPEATED_FAMILY_CONTEXTUAL_MANUAL_CLEANUP_CANDIDATES = 6;
const MAX_GROUPED_CONTEXTUAL_MANUAL_CLEANUP_HOLDER_KIND_FAMILIES = 4;
const MAX_GROUPED_CONTEXTUAL_MANUAL_CLEANUP_PROCESS_NAMES = 7;
const MAX_NEARBY_LOCAL_PROCESS_CONTEXTUAL_CANDIDATES = 2;
const MAX_BROADER_NEARBY_LOCAL_PROCESS_CONTEXTUAL_CANDIDATES = 1;
const MAX_BROADER_NEARBY_LOCAL_PROCESS_TOTAL_CANDIDATES = 8;
const MAX_GROUPED_CONTEXTUAL_MANUAL_CLEANUP_NEARBY_LOCAL_PROCESS_CANDIDATES = 2;
const MAX_GROUPED_CONTEXTUAL_MANUAL_CLEANUP_TOTAL_CANDIDATES_WITH_TWO_NEARBY = 18;
const MAX_REPEATED_FAMILY_CONTEXTUAL_MANUAL_CLEANUP_NEARBY_LOCAL_PROCESS_CANDIDATES = 2;

/**
 * Returns whether one untracked candidate is a high-confidence exact-path non-preview holder.
 *
 * @param candidate - Parsed untracked-holder candidate from bounded local inspection.
 * @returns `true` when the candidate is a high-confidence exact-path non-preview holder.
 */
function isHighConfidenceExactNonPreviewTargetPathCandidate(
  candidate: Pick<UntrackedHolderCandidate, "confidence" | "reason" | "holderKind">
): boolean {
  return (
    candidate.confidence === "high" &&
    candidate.reason === "command_line_matches_target_path" &&
    candidate.holderKind !== "preview_server"
  );
}

/**
 * Returns whether one untracked candidate is still in the narrow local non-preview family that can
 * support a confirmation-gated shutdown lane.
 *
 * @param candidate - Parsed untracked-holder candidate from bounded local inspection.
 * @returns `true` when the candidate stays within the local bounded clarification family.
 */
function isClarificationSafeLocalNonPreviewCandidate(
  candidate: Pick<UntrackedHolderCandidate, "holderKind" | "reason">
): boolean {
  if (candidate.holderKind === "unknown_local_process") {
    return candidate.reason === "command_line_matches_target_path";
  }
  return (
    (candidate.holderKind === "editor_workspace" ||
      candidate.holderKind === "shell_workspace" ||
      candidate.holderKind === "sync_client") &&
    (candidate.reason === "command_line_matches_target_path" ||
      candidate.reason === "command_line_mentions_target_name")
  );
}

/**
 * Normalizes one candidate process name into a stable family key for broader contextual cleanup.
 *
 * @param processName - Candidate process name recovered from local inspection.
 * @returns Stable family key, or `null` when the candidate name is absent.
 */
function normalizeContextualProcessFamilyName(processName: string | null): string | null {
  if (!processName) {
    return null;
  }
  const normalized = processName.trim().replace(/\.exe$/i, "").toLowerCase();
  return normalized || null;
}

/**
 * Counts distinct named process families inside one broader local holder group.
 *
 * @param candidates - Parsed untracked-holder candidates from bounded local inspection.
 * @returns Number of distinct named process families.
 */
function countDistinctContextualProcessFamilyNames(
  candidates: readonly Pick<UntrackedHolderCandidate, "processName">[]
): number {
  return new Set(
    candidates
      .map((candidate) => normalizeContextualProcessFamilyName(candidate.processName))
      .filter((familyName): familyName is string => typeof familyName === "string")
  ).size;
}

/**
 * Promotes exact-path non-preview holders into stronger targeted-confirmation candidates when the
 * runtime has a single-process command-line path match for a local editor, shell, or sync holder.
 *
 * @param candidate - Parsed untracked-holder candidate.
 * @returns Candidate with refined confidence when the evidence is strong enough.
 */
export function promoteExactNonPreviewTargetPathCandidate(
  candidate: UntrackedHolderCandidate
): UntrackedHolderCandidate {
  if (
    candidate.confidence === "medium" &&
    candidate.reason === "command_line_matches_target_path" &&
    (candidate.holderKind === "editor_workspace" ||
      candidate.holderKind === "shell_workspace" ||
      candidate.holderKind === "sync_client")
  ) {
    return {
      ...candidate,
      confidence: "high"
    };
  }
  return candidate;
}

/**
 * Selects one dominant exact-path non-preview candidate when weaker non-preview noise is still
 * present.
 *
 * @param candidates - Parsed untracked-holder candidates from bounded local inspection.
 * @returns The one dominant exact-path non-preview holder, or `null` when the evidence is broader.
 */
export function selectDominantExactNonPreviewTargetPathCandidate(
  candidates: readonly UntrackedHolderCandidate[]
): UntrackedHolderCandidate | null {
  const exactCandidates = selectExactNonPreviewTargetPathCandidates(candidates);
  if (exactCandidates.length !== 1) {
    return null;
  }
  return exactCandidates[0];
}

/**
 * Selects all exact-path high-confidence non-preview holders when the evidence is still narrow
 * enough to stay on a targeted confirmation path.
 *
 * @param candidates - Parsed untracked-holder candidates from bounded local inspection.
 * @returns Exact-path high-confidence non-preview holders, or an empty array when the evidence is broader.
 */
export function selectExactNonPreviewTargetPathCandidates(
  candidates: readonly UntrackedHolderCandidate[]
): readonly UntrackedHolderCandidate[] {
  const exactCandidates = candidates.filter((candidate) =>
    isHighConfidenceExactNonPreviewTargetPathCandidate(candidate)
  );
  if (exactCandidates.length === 0) {
    return [];
  }
  const remainingCandidates = candidates.filter(
    (candidate) =>
      !exactCandidates.some((exactCandidate) => exactCandidate.pid === candidate.pid)
  );
  if (remainingCandidates.some((candidate) => candidate.holderKind === "preview_server")) {
    return [];
  }
  return exactCandidates;
}

/**
 * Selects a small non-preview holder set that is narrow enough for a confirmation-gated shutdown
 * even when the evidence is still only "likely" rather than exact.
 *
 * @param candidates - Parsed untracked-holder candidates from bounded local inspection.
 * @returns Small likely non-preview holder set, or an empty array when the evidence is broader.
 */
export function selectClarificationSafeLikelyNonPreviewCandidates(
  candidates: readonly UntrackedHolderCandidate[]
): readonly UntrackedHolderCandidate[] {
  if (
    candidates.length < 2 ||
    candidates.length > MAX_CONTEXTUAL_LOCAL_NON_PREVIEW_CANDIDATES
  ) {
    return [];
  }
  const clarificationSafeCandidates = candidates.filter(
    (candidate) => isClarificationSafeLocalNonPreviewCandidate(candidate)
  );
  if (clarificationSafeCandidates.length !== candidates.length) {
    return [];
  }
  const nearbyLocalProcessCandidates = clarificationSafeCandidates.filter(
    (candidate) => candidate.holderKind === "unknown_local_process"
  );
  if (
    nearbyLocalProcessCandidates.length > MAX_NEARBY_LOCAL_PROCESS_CONTEXTUAL_CANDIDATES ||
    (nearbyLocalProcessCandidates.length > MAX_BROADER_NEARBY_LOCAL_PROCESS_CONTEXTUAL_CANDIDATES &&
      clarificationSafeCandidates.length > 4) ||
    (nearbyLocalProcessCandidates.length > 0 &&
      clarificationSafeCandidates.length > MAX_BROADER_NEARBY_LOCAL_PROCESS_TOTAL_CANDIDATES)
  ) {
    return [];
  }
  if (
    clarificationSafeCandidates.some((candidate) =>
      isHighConfidenceExactNonPreviewTargetPathCandidate(candidate)
    )
  ) {
    return [];
  }
  const nonLowConfidenceCandidates = clarificationSafeCandidates.filter(
    (candidate) => candidate.confidence !== "low"
  );
  if (clarificationSafeCandidates.length <= 4) {
    if (nonLowConfidenceCandidates.length !== clarificationSafeCandidates.length) {
      return [];
    }
    return clarificationSafeCandidates;
  }
  const lowConfidenceCount =
    clarificationSafeCandidates.length - nonLowConfidenceCandidates.length;
  const requiredNonLowConfidenceCandidates =
    clarificationSafeCandidates.length <= 6 ? 3 : 4;
  if (
    nonLowConfidenceCandidates.length < requiredNonLowConfidenceCandidates ||
    lowConfidenceCount > MAX_LOW_CONFIDENCE_CONTEXTUAL_CANDIDATES
  ) {
    return [];
  }
  return clarificationSafeCandidates;
}

/**
 * Selects a broader but still-local non-preview holder family that should stay on contextual
 * manual-cleanup wording after it exceeds the confirmation lane.
 *
 * @param candidates - Parsed untracked-holder candidates from bounded local inspection.
 * @returns Broader local non-preview holder set, or an empty array when the evidence is too noisy.
 */
export function selectContextualManualCleanupLikelyNonPreviewCandidates(
  candidates: readonly UntrackedHolderCandidate[]
): readonly UntrackedHolderCandidate[] {
  if (
    candidates.length <= MAX_CONTEXTUAL_LOCAL_NON_PREVIEW_CANDIDATES ||
    candidates.length > MAX_REPEATED_FAMILY_CONTEXTUAL_LOCAL_NON_PREVIEW_MANUAL_CLEANUP_CANDIDATES
  ) {
    return [];
  }
  const withinBaseContextualRange =
    candidates.length <= MAX_CONTEXTUAL_LOCAL_NON_PREVIEW_MANUAL_CLEANUP_CANDIDATES;
  const withinGroupedContextualRange =
    candidates.length <= MAX_GROUPED_CONTEXTUAL_LOCAL_NON_PREVIEW_MANUAL_CLEANUP_CANDIDATES;
  const contextualCandidates = candidates.filter((candidate) =>
    isClarificationSafeLocalNonPreviewCandidate(candidate)
  );
  if (contextualCandidates.length !== candidates.length) {
    return [];
  }
  if (
    contextualCandidates.some((candidate) =>
      isHighConfidenceExactNonPreviewTargetPathCandidate(candidate)
    )
  ) {
    return [];
  }
  const nearbyLocalProcessCandidates = contextualCandidates.filter(
    (candidate) => candidate.holderKind === "unknown_local_process"
  );
  const maxNearbyLocalProcessCandidates = withinBaseContextualRange
    ? MAX_NEARBY_LOCAL_PROCESS_CONTEXTUAL_CANDIDATES
    : contextualCandidates.length <=
          MAX_GROUPED_CONTEXTUAL_MANUAL_CLEANUP_TOTAL_CANDIDATES_WITH_TWO_NEARBY
      ? MAX_GROUPED_CONTEXTUAL_MANUAL_CLEANUP_NEARBY_LOCAL_PROCESS_CANDIDATES
      : contextualCandidates.length <=
            MAX_REPEATED_FAMILY_CONTEXTUAL_LOCAL_NON_PREVIEW_MANUAL_CLEANUP_CANDIDATES
        ? MAX_REPEATED_FAMILY_CONTEXTUAL_MANUAL_CLEANUP_NEARBY_LOCAL_PROCESS_CANDIDATES
      : MAX_BROADER_NEARBY_LOCAL_PROCESS_CONTEXTUAL_CANDIDATES;
  if (
    nearbyLocalProcessCandidates.length > maxNearbyLocalProcessCandidates
  ) {
    return [];
  }
  const nonLowConfidenceCandidates = contextualCandidates.filter(
    (candidate) => candidate.confidence !== "low"
  );
  const lowConfidenceCount =
    contextualCandidates.length - nonLowConfidenceCandidates.length;
  if (withinBaseContextualRange) {
    if (
      lowConfidenceCount > MAX_LOW_CONFIDENCE_CONTEXTUAL_MANUAL_CLEANUP_CANDIDATES ||
      nonLowConfidenceCandidates.length <
        contextualCandidates.length -
          MAX_LOW_CONFIDENCE_CONTEXTUAL_MANUAL_CLEANUP_CANDIDATES
    ) {
      return [];
    }
    return contextualCandidates;
  }
  const distinctHolderKindFamilies = new Set(
    contextualCandidates.map((candidate) => candidate.holderKind)
  );
  if (
    distinctHolderKindFamilies.size >
    MAX_GROUPED_CONTEXTUAL_MANUAL_CLEANUP_HOLDER_KIND_FAMILIES
  ) {
    return [];
  }
  if (
    countDistinctContextualProcessFamilyNames(contextualCandidates) >
    MAX_GROUPED_CONTEXTUAL_MANUAL_CLEANUP_PROCESS_NAMES
  ) {
    return [];
  }
  const maxLowConfidenceCandidates = withinGroupedContextualRange
    ? MAX_LOW_CONFIDENCE_GROUPED_CONTEXTUAL_MANUAL_CLEANUP_CANDIDATES
    : MAX_LOW_CONFIDENCE_REPEATED_FAMILY_CONTEXTUAL_MANUAL_CLEANUP_CANDIDATES;
  if (
    lowConfidenceCount > maxLowConfidenceCandidates ||
    nonLowConfidenceCandidates.length <
      contextualCandidates.length -
        maxLowConfidenceCandidates
  ) {
    return [];
  }
  return contextualCandidates;
}
