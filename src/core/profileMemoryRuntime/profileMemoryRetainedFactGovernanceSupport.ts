/**
 * @fileoverview Focused helpers for fail-closed retained flat-fact governance checks.
 */

import type { ProfileFactUpsertInput } from "../profileMemory";
import type { ProfileFactRecord, ProfileMutationAuditMetadataV1 } from "../profileMemory";
import { governProfileMemoryCandidates } from "./profileMemoryTruthGovernance";

/**
 * Evaluates whether one retained flat fact still belongs on compatibility and legacy-repair
 * surfaces after deterministic truth governance is re-applied during load normalization.
 *
 * **Why it exists:**
 * Live fact mutation already quarantines unsupported family/source combinations, so encrypted
 * reload should not keep those same facts alive just because they were persisted before stricter
 * source authority rules landed.
 *
 * **What it talks to:**
 * - Uses `governProfileMemoryCandidates` (import) from `./profileMemoryTruthGovernance`.
 *
 * @param candidate - Canonical retained fact candidate under evaluation.
 * @returns `true` when the fact remains in a non-quarantined governance lane.
 */
export function isRetainedFactSupportedByTruthGovernance(
  fact: Pick<ProfileFactRecord, "sensitive" | "observedAt" | "confidence">,
  normalizedFactKey: string,
  normalizedFactValue: string,
  normalizedFactSourceTaskId: string,
  normalizedFactSource: string,
  mutationAudit: ProfileMutationAuditMetadataV1 | null
): boolean {
  const candidate: ProfileFactUpsertInput = {
    key: normalizedFactKey,
    value: normalizedFactValue,
    sensitive: fact.sensitive,
    sourceTaskId: normalizedFactSourceTaskId,
    source: normalizedFactSource,
    observedAt: fact.observedAt,
    confidence: fact.confidence,
    mutationAudit
  };
  const decision = governProfileMemoryCandidates({
    factCandidates: [candidate],
    episodeCandidates: [],
    episodeResolutionCandidates: []
  }).factDecisions[0]?.decision;

  return Boolean(decision && decision.action !== "quarantine");
}
