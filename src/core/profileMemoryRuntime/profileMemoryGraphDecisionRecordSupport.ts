/**
 * @fileoverview Bounded durable decision-record helpers for graph-backed profile memory.
 */

import { sha256HexFromCanonicalJson } from "../normalizers/canonicalizationRules";
import type { ProfileMemoryGraphDecisionRecordV1 } from "./profileMemoryGraphContracts";

const MAX_PROFILE_MEMORY_GRAPH_DECISION_RECORDS = 128;

/**
 * Appends one deterministic durable decision record to the bounded personal-memory graph trail.
 *
 * @param existing - Current durable decision records.
 * @param input - Canonical decision payload for the rewritten stable-ref lane.
 * @returns Stable bounded decision-record trail.
 */
export function appendProfileMemoryGraphDecisionRecord(
  existing: readonly ProfileMemoryGraphDecisionRecordV1[],
  input: Omit<ProfileMemoryGraphDecisionRecordV1, "decisionId">
): ProfileMemoryGraphDecisionRecordV1[] {
  const decisionPayload = {
    action: input.action,
    recordedAt: input.recordedAt,
    fromStableRefId: input.fromStableRefId,
    toStableRefId: input.toStableRefId,
    sourceTaskId: input.sourceTaskId,
    sourceFingerprint: input.sourceFingerprint,
    mutationEnvelopeHash: input.mutationEnvelopeHash,
    observationIds: [...input.observationIds].sort((left, right) => left.localeCompare(right)),
    claimIds: [...input.claimIds].sort((left, right) => left.localeCompare(right)),
    eventIds: [...input.eventIds].sort((left, right) => left.localeCompare(right))
  };
  const decisionRecord = {
    decisionId: `profile_memory_graph_decision_${sha256HexFromCanonicalJson(decisionPayload).slice(0, 24)}`,
    ...decisionPayload
  };
  return existing.some((record) => record.decisionId === decisionRecord.decisionId)
    ? [...existing]
    : [...existing, decisionRecord].slice(-MAX_PROFILE_MEMORY_GRAPH_DECISION_RECORDS);
}
