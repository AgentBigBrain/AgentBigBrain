/**
 * @fileoverview Canonical Stage 6.85 observability helpers for mission timelines, failure explainers, and bounded evidence-bundle profiles.
 */

import { toSortedUnique } from "../cryptoUtils";
import { MissionTimelineV1, Stage685BlockCode, WorkflowConflictCodeV1 } from "../types";

/**
 * Builds a deterministically ordered mission timeline.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `MissionTimelineV1` result.
 */
export function buildMissionTimelineV1(input: MissionTimelineV1): MissionTimelineV1 {
  const sortedEvents = [...input.events].sort((left, right) => {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
    return left.observedAt.localeCompare(right.observedAt);
  });
  return {
    missionId: input.missionId,
    events: sortedEvents
  };
}

/**
 * Explains Stage 6.85 failures using deterministic remediation text.
 *
 * @param input - Structured input object for this operation.
 * @returns Ordered collection produced by this step.
 */
export function explainFailureDeterministically(input: {
  blockCode: Stage685BlockCode;
  conflictCode: WorkflowConflictCodeV1 | null;
}): { summary: string; remediation: readonly string[] } {
  if (input.blockCode === "WORKFLOW_DRIFT_DETECTED") {
    const conflict = input.conflictCode ?? "UNKNOWN_CONFLICT";
    const remediationMap: Record<WorkflowConflictCodeV1, string> = {
      SELECTOR_NOT_FOUND: "Recapture workflow or patch selector mapping with approval.",
      ASSERTION_FAILED: "Update assertions and replay after approved patch.",
      WINDOW_NOT_FOCUSED: "Restore window focus and replay from last approved step.",
      NAVIGATION_MISMATCH: "Re-align navigation target and re-run compile+replay.",
      CAPTURE_SCHEMA_UNSUPPORTED: "Recapture workflow using supported capture schema."
    };
    return {
      summary: `Workflow drift detected: ${conflict}.`,
      remediation:
        input.conflictCode === null
          ? ["Review workflow drift metadata and recapture before replay."]
          : [remediationMap[input.conflictCode]]
    };
  }
  return {
    summary: `Unhandled block code: ${input.blockCode}.`,
    remediation: ["Review deterministic block telemetry and resolve before retry."]
  };
}

/**
 * Builds a bounded profile for redacted evidence bundles.
 *
 * @param input - Structured input object for this operation.
 * @returns Ordered collection produced by this step.
 */
export function buildRedactedEvidenceBundleProfile(input: {
  artifactPaths: readonly string[];
  redactedFieldNames: readonly string[];
}): {
  artifactPaths: readonly string[];
  redactedFieldNames: readonly string[];
  redactionCount: number;
} {
  const artifactPaths = toSortedUnique(input.artifactPaths);
  const redactedFieldNames = toSortedUnique(input.redactedFieldNames);
  return {
    artifactPaths,
    redactedFieldNames,
    redactionCount: redactedFieldNames.length
  };
}
