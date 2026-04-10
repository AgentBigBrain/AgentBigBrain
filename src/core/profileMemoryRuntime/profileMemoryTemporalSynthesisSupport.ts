/**
 * @fileoverview Shared helper glue for deterministic temporal profile-memory synthesis lanes.
 */

import { getProfileMemoryFamilyRegistryEntry } from "./profileMemoryFamilyRegistry";
import type {
  ProfileMemoryTemporalAnswerMode,
  ProfileMemoryTemporalClaimEvidence,
  ProfileMemoryTemporalClaimFamilySlice,
  ProfileMemoryTemporalEvidenceSlice,
  ProfileMemoryTemporalLaneKind,
  ProfileMemoryTemporalLaneMetadata,
  ProfileMemoryTemporalRejectionReason,
  ProfileMemoryTemporalRejectedClaimRecord
} from "./profileMemoryTemporalQueryContracts";

const SOURCE_TIER_WEIGHT = {
  explicit_user_statement: 4,
  validated_structured_candidate: 3,
  reconciliation_or_projection: 2,
  assistant_inference: 1
} as const;

/**
 * Parses one ISO timestamp into milliseconds and fails closed on malformed input.
 *
 * **Why it exists:**
 * Synthesis ranking and display ordering need one deterministic malformed-time fallback.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Optional ISO timestamp.
 * @returns Parsed milliseconds, or `0` when parsing fails.
 */
export function getIsoTimeMs(value: string | null | undefined): number {
  if (typeof value !== "string") {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Builds a deterministic score tuple for current-claim selection.
 *
 * **Why it exists:**
 * Singular-family arbitration must use one centralized decision order where authority comes first
 * and corroboration depth plus recency only act as salience among still-eligible candidates.
 *
 * **What it talks to:**
 * - Uses `getIsoTimeMs` (import `getIsoTimeMs`) from `./profileMemoryTemporalSynthesisSupport`.
 *
 * @param claim - Claim candidate under scoring.
 * @returns Stable score tuple.
 */
export function scoreClaim(
  claim: ProfileMemoryTemporalClaimEvidence
): readonly [number, number, number, string] {
  return [
    SOURCE_TIER_WEIGHT[claim.sourceTier],
    claim.supportingObservationIds.length,
    getIsoTimeMs(claim.validFrom ?? claim.assertedAt),
    claim.claimId
  ];
}

/**
 * Compares two claims by synthesis winner score.
 *
 * **Why it exists:**
 * Family-lane arbitration needs one stable descending comparator that preserves the bounded
 * authority-first then salience ranking order instead of ad hoc inline comparisons.
 *
 * **What it talks to:**
 * - Uses `scoreClaim` (import `scoreClaim`) from `./profileMemoryTemporalSynthesisSupport`.
 *
 * @param left - Left claim candidate.
 * @param right - Right claim candidate.
 * @returns Negative when the left claim should sort first.
 */
export function compareClaimScore(
  left: ProfileMemoryTemporalClaimEvidence,
  right: ProfileMemoryTemporalClaimEvidence
): number {
  const leftScore = scoreClaim(left);
  const rightScore = scoreClaim(right);
  if (leftScore[0] !== rightScore[0]) {
    return rightScore[0] - leftScore[0];
  }
  if (leftScore[1] !== rightScore[1]) {
    return rightScore[1] - leftScore[1];
  }
  if (leftScore[2] !== rightScore[2]) {
    return rightScore[2] - leftScore[2];
  }
  return leftScore[3].localeCompare(rightScore[3]);
}

/**
 * Compares two claims by display chronology.
 *
 * **Why it exists:**
 * Historical and preserve-prior summaries need one stable chronological ordering rule.
 *
 * **What it talks to:**
 * - Uses `getIsoTimeMs` (import `getIsoTimeMs`) from `./profileMemoryTemporalSynthesisSupport`.
 *
 * @param left - Left claim candidate.
 * @param right - Right claim candidate.
 * @returns Negative when the left claim should display first.
 */
export function compareClaimDisplayOrder(
  left: ProfileMemoryTemporalClaimEvidence,
  right: ProfileMemoryTemporalClaimEvidence
): number {
  const leftTime = getIsoTimeMs(left.validFrom ?? left.assertedAt);
  const rightTime = getIsoTimeMs(right.validFrom ?? right.assertedAt);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return left.claimId.localeCompare(right.claimId);
}

/**
 * Formats one current-state claim line for synthesis output.
 *
 * **Why it exists:**
 * The canonical synthesis surface keeps current-state line formatting centralized so compatibility
 * adapters cannot drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param family - Claim family label.
 * @param claim - Current claim candidate.
 * @returns Formatted current-state line.
 */
export function formatClaimLine(
  family: string,
  claim: ProfileMemoryTemporalClaimEvidence
): string {
  return `${family}: ${claim.normalizedValue ?? "(ended)"}`;
}

/**
 * Formats one historical claim line for synthesis output.
 *
 * **Why it exists:**
 * Historical context needs an explicit marker so current and historical lanes remain distinct in
 * downstream prompts.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param family - Claim family label.
 * @param claim - Historical claim candidate.
 * @returns Formatted historical line.
 */
export function formatHistoricalClaimLine(
  family: string,
  claim: ProfileMemoryTemporalClaimEvidence
): string {
  return `${family} (historical): ${claim.normalizedValue ?? "(ended)"}`;
}

/**
 * Formats one event line for synthesis output.
 *
 * **Why it exists:**
 * Event-history output needs one shared text rule across current and historical event lanes.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param title - Event title.
 * @param summary - Event summary.
 * @returns Formatted event line.
 */
export function formatEventLine(title: string, summary: string): string {
  return `${title}: ${summary}`;
}

/**
 * Builds one rejected-claim record for lane metadata.
 *
 * **Why it exists:**
 * Rejection metadata needs a single constructor so reasoning stays typed and compact.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param claimId - Rejected claim id.
 * @param reason - Typed rejection reason.
 * @returns Rejected-claim metadata record.
 */
export function buildRejectedClaim(
  claimId: string,
  reason: ProfileMemoryTemporalRejectionReason
): ProfileMemoryTemporalRejectedClaimRecord {
  return { claimId, reason };
}

/**
 * Converts the dominant synthesis lane into the public answer mode.
 *
 * **Why it exists:**
 * The synthesis contract exposes answer modes, but internal arbitration works with lane kinds.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param dominantLane - Winning synthesis lane.
 * @returns Public answer mode.
 */
export function inferLaneAnswerMode(
  dominantLane: ProfileMemoryTemporalLaneKind
): ProfileMemoryTemporalAnswerMode {
  switch (dominantLane) {
    case "current_state":
      return "current";
    case "historical_context":
      return "historical";
    case "contradiction_notes":
      return "ambiguous";
    case "quarantined_identity":
      return "quarantined_identity";
    default:
      return "insufficient_evidence";
  }
}

/**
 * Synthesizes one family lane into current, historical, contradiction, and metadata surfaces.
 *
 * **Why it exists:**
 * Family-level arbitration is the most complex part of temporal synthesis, so it lives behind one
 * helper that can be tested and reused without bloating the entrypoint.
 *
 * **What it talks to:**
 * - Uses `getProfileMemoryFamilyRegistryEntry` (import `getProfileMemoryFamilyRegistryEntry`) from `./profileMemoryFamilyRegistry`.
 * - Uses local helpers within this module.
 *
 * @param focusStableRefId - Stable ref id owning the family lane.
 * @param resolution - Stable-ref resolution state.
 * @param familySlice - Bounded claim-family evidence slice.
 * @returns Synthesized family-lane text plus metadata.
 */
export function synthesizeFamilyLane(
  focusStableRefId: string,
  resolution: ProfileMemoryTemporalEvidenceSlice["focusEntities"][number]["resolution"],
  familySlice: ProfileMemoryTemporalClaimFamilySlice
): {
  currentStateLines: readonly string[];
  historicalLines: readonly string[];
  contradictionLines: readonly string[];
  laneMetadata: ProfileMemoryTemporalLaneMetadata;
} {
  const familyEntry = getProfileMemoryFamilyRegistryEntry(familySlice.family);
  const currentClaims = familySlice.claims
    .filter((claim) => familySlice.lifecycleBuckets.current.includes(claim.claimId))
    .sort(compareClaimScore);
  const historicalClaims = familySlice.claims
    .filter((claim) =>
      familySlice.lifecycleBuckets.historical.includes(claim.claimId) ||
      familySlice.lifecycleBuckets.ended.includes(claim.claimId)
    )
    .sort(compareClaimScore);
  const rejectedClaims: ProfileMemoryTemporalRejectedClaimRecord[] = [];
  const supportingObservationIds = new Set<string>();
  let dominantLane: ProfileMemoryTemporalLaneKind = "insufficient_evidence";
  let chosenClaimId: string | null = null;
  const currentStateLines: string[] = [];
  const historicalLines: string[] = [];
  const contradictionLines: string[] = [];

  if (resolution === "quarantined") {
    dominantLane = "quarantined_identity";
    return {
      currentStateLines,
      historicalLines,
      contradictionLines,
      laneMetadata: {
        laneId: `${focusStableRefId}:${familySlice.family}`,
        focusStableRefId,
        family: familySlice.family,
        answerMode: "quarantined_identity",
        dominantLane,
        supportingLanes: [],
        chosenClaimId,
        supportingObservationIds: [],
        rejectedClaims: familySlice.claims.map((claim) =>
          buildRejectedClaim(claim.claimId, "quarantined_identity")
        ),
        lifecycleBuckets: familySlice.lifecycleBuckets,
        degradedNotes: []
      }
    };
  }

  if (currentClaims.length > 0 && !familyEntry.currentStateEligible) {
    for (const claim of currentClaims) {
      rejectedClaims.push(buildRejectedClaim(claim.claimId, "not_current_state_eligible"));
    }
  } else if (
    currentClaims.length > 0 &&
    familyEntry.corroborationMode !== "not_required" &&
    resolution !== "resolved_current"
  ) {
    for (const claim of currentClaims) {
      rejectedClaims.push(buildRejectedClaim(claim.claimId, "corroboration_required"));
    }
  } else if (familyEntry.cardinality === "multi") {
    dominantLane = currentClaims.length > 0 ? "current_state" : historicalClaims.length > 0
      ? "historical_context"
      : "insufficient_evidence";
    for (const claim of currentClaims) {
      currentStateLines.push(formatClaimLine(familySlice.family, claim));
      for (const observationId of claim.supportingObservationIds) {
        supportingObservationIds.add(observationId);
      }
    }
    for (const claim of historicalClaims) {
      historicalLines.push(formatHistoricalClaimLine(familySlice.family, claim));
    }
    if (currentClaims.length === 0 && historicalClaims.length === 0) {
      dominantLane = "insufficient_evidence";
    }
  } else if (currentClaims.length === 1) {
    const chosen = currentClaims[0]!;
    chosenClaimId = chosen.claimId;
    dominantLane = "current_state";
    currentStateLines.push(formatClaimLine(familySlice.family, chosen));
    for (const observationId of chosen.supportingObservationIds) {
      supportingObservationIds.add(observationId);
    }
  } else if (currentClaims.length > 1) {
    const [topClaim, secondClaim, ...restClaims] = currentClaims;
    if (SOURCE_TIER_WEIGHT[topClaim!.sourceTier] > SOURCE_TIER_WEIGHT[secondClaim!.sourceTier]) {
      chosenClaimId = topClaim!.claimId;
      dominantLane = "current_state";
      currentStateLines.push(formatClaimLine(familySlice.family, topClaim!));
      for (const observationId of topClaim!.supportingObservationIds) {
        supportingObservationIds.add(observationId);
      }
      for (const claim of [secondClaim!, ...restClaims]) {
        rejectedClaims.push(buildRejectedClaim(claim.claimId, "lower_source_authority"));
      }
      contradictionLines.push(
        `${familySlice.family} has competing current values; keeping ${topClaim!.normalizedValue ?? "(ended)"} over lower-authority alternatives`
      );
    } else if (familyEntry.displacementPolicy === "preserve_prior_on_conflict") {
      const priorWinner = [...currentClaims].sort(compareClaimDisplayOrder)[0]!;
      chosenClaimId = priorWinner.claimId;
      dominantLane = "current_state";
      currentStateLines.push(formatClaimLine(familySlice.family, priorWinner));
      for (const observationId of priorWinner.supportingObservationIds) {
        supportingObservationIds.add(observationId);
      }
      for (const claim of currentClaims) {
        if (claim.claimId !== priorWinner.claimId) {
          rejectedClaims.push(buildRejectedClaim(claim.claimId, "prior_winner_retained"));
        }
      }
      contradictionLines.push(
        `${familySlice.family} has competing current values; keeping prior current value ${priorWinner.normalizedValue ?? "(ended)"} until stronger evidence lands`
      );
    } else if (familyEntry.displacementPolicy === "replace_authoritative_successor") {
      chosenClaimId = topClaim!.claimId;
      dominantLane = "current_state";
      currentStateLines.push(formatClaimLine(familySlice.family, topClaim!));
      for (const observationId of topClaim!.supportingObservationIds) {
        supportingObservationIds.add(observationId);
      }
      for (const claim of [secondClaim!, ...restClaims]) {
        rejectedClaims.push(buildRejectedClaim(claim.claimId, "authoritative_successor"));
      }
    } else {
      const orderedConflictValues = [...currentClaims]
        .sort(compareClaimDisplayOrder)
        .map((claim) => claim.normalizedValue ?? "(ended)");
      dominantLane = "contradiction_notes";
      contradictionLines.push(
        `${familySlice.family} has competing current values: ${orderedConflictValues.join(", ")}`
      );
      for (const claim of currentClaims) {
        rejectedClaims.push(buildRejectedClaim(claim.claimId, "ambiguous_singular_conflict"));
      }
    }
  }

  for (const claim of historicalClaims) {
    historicalLines.push(formatHistoricalClaimLine(familySlice.family, claim));
    if (!rejectedClaims.some((entry) => entry.claimId === claim.claimId)) {
      rejectedClaims.push(buildRejectedClaim(claim.claimId, "historical_only"));
    }
  }
  if (currentStateLines.length === 0 && dominantLane === "insufficient_evidence" && historicalLines.length > 0) {
    dominantLane = "historical_context";
  }

  return {
    currentStateLines,
    historicalLines,
    contradictionLines,
    laneMetadata: {
      laneId: `${focusStableRefId}:${familySlice.family}`,
      focusStableRefId,
      family: familySlice.family,
      answerMode: inferLaneAnswerMode(dominantLane),
      dominantLane,
      supportingLanes: [
        ...(historicalLines.length > 0 ? ["historical_context" as const] : []),
        ...(contradictionLines.length > 0 ? ["contradiction_notes" as const] : [])
      ],
      chosenClaimId,
      supportingObservationIds: [...supportingObservationIds].sort((left, right) => left.localeCompare(right)),
      rejectedClaims,
      lifecycleBuckets: familySlice.lifecycleBuckets,
      degradedNotes: []
    }
  };
}
