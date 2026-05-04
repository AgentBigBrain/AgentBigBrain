/**
 * @fileoverview Deterministic metadata merge helpers for workflow-pattern lifecycle updates.
 */

import type { WorkflowObservation, WorkflowPattern } from "../types";

/**
 * Normalizes optional strings into nullable persisted values.
 *
 * @param value - Candidate string value.
 * @returns Trimmed string or `null` when empty/unset.
 */
function toNullableString(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * Merges evidence refs without duplicating ids.
 *
 * @param existing - Existing evidence refs.
 * @param next - Incoming evidence refs.
 * @returns Deduplicated evidence refs.
 */
function mergeEvidenceRefs(
  existing: readonly string[] | undefined,
  next: readonly string[] | undefined
): readonly string[] | undefined {
  const refs = [...(existing ?? []), ...(next ?? [])]
    .map((ref) => ref.trim())
    .filter((ref) => ref.length > 0);
  return refs.length > 0 ? [...new Set(refs)] : undefined;
}

/**
 * Applies richer observation metadata to a workflow pattern without changing its core counters.
 *
 * @param pattern - Existing or newly adapted workflow pattern.
 * @param observation - Observation providing the latest metadata snapshot.
 * @returns Workflow pattern enriched with the latest structured observation metadata.
 */
export function applyWorkflowObservationMetadata(
  pattern: WorkflowPattern,
  observation: WorkflowObservation
): WorkflowPattern {
  return {
    ...pattern,
    executionStyle: observation.executionStyle ?? pattern.executionStyle,
    actionSequenceShape: observation.actionSequenceShape ?? pattern.actionSequenceShape,
    approvalPosture: observation.approvalPosture ?? pattern.approvalPosture,
    verificationProofPresent:
      observation.verificationProofPresent ?? pattern.verificationProofPresent,
    costBand: observation.costBand ?? pattern.costBand,
    latencyBand: observation.latencyBand ?? pattern.latencyBand,
    dominantFailureMode:
      observation.dominantFailureMode === undefined
        ? pattern.dominantFailureMode
        : toNullableString(observation.dominantFailureMode),
    recoveryPath:
      observation.recoveryPath === undefined
        ? pattern.recoveryPath
        : toNullableString(observation.recoveryPath),
    linkedSkillName:
      observation.linkedSkillName === undefined
        ? pattern.linkedSkillName
        : toNullableString(observation.linkedSkillName),
    linkedSkillVerificationStatus:
      observation.linkedSkillVerificationStatus ?? pattern.linkedSkillVerificationStatus,
    evidenceRefs: mergeEvidenceRefs(pattern.evidenceRefs, observation.evidenceRefs)
  };
}
