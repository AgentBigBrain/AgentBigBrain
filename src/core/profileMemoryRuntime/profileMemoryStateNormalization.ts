/**
 * @fileoverview Canonical profile-memory state normalization helpers for persisted envelopes.
 */

import type {
  ProfileFactRecord,
  ProfileMemoryState,
  ProfileMutationAuditMetadataV1
} from "../profileMemory";
import {
  createEmptyProfileMemoryState,
  PROFILE_MEMORY_SCHEMA_VERSION
} from "./profileMemoryState";

/**
 * Coerces a timestamp candidate to valid ISO format, falling back to `now`.
 *
 * @param value - Candidate timestamp from persisted or inbound payloads.
 * @returns Valid ISO timestamp string.
 */
export function safeIsoOrNow(value: string | undefined): string {
  if (typeof value !== "string") {
    return new Date().toISOString();
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return new Date().toISOString();
  }

  return new Date(parsed).toISOString();
}

/**
 * Normalizes unknown persisted payloads into a valid `ProfileMemoryState`.
 *
 * @param raw - Parsed JSON candidate from storage.
 * @returns Canonical profile state with filtered/normalized facts.
 */
export function normalizeProfileMemoryState(raw: unknown): ProfileMemoryState {
  const empty = createEmptyProfileMemoryState();
  if (!raw || typeof raw !== "object") {
    return empty;
  }

  const candidate = raw as Partial<ProfileMemoryState>;
  const facts = Array.isArray(candidate.facts)
    ? candidate.facts.flatMap((fact): ProfileFactRecord[] => {
      if (!fact || typeof fact !== "object") {
        return [];
      }
      const typedFact = fact as ProfileFactRecord;
      const mutationAudit = normalizeProfileMutationAuditMetadata(typedFact.mutationAudit);
      return (
        typeof typedFact.id === "string" &&
          typeof typedFact.key === "string" &&
          typeof typedFact.value === "string" &&
          typeof typedFact.sensitive === "boolean" &&
          (typedFact.status === "confirmed" ||
            typedFact.status === "uncertain" ||
            typedFact.status === "superseded") &&
          typeof typedFact.sourceTaskId === "string" &&
          typeof typedFact.source === "string" &&
          typeof typedFact.observedAt === "string" &&
          typeof typedFact.lastUpdatedAt === "string"
      )
        ? [{
          ...typedFact,
          mutationAudit: mutationAudit ?? undefined
        }]
        : [];
    })
    : [];

  return {
    schemaVersion: PROFILE_MEMORY_SCHEMA_VERSION,
    updatedAt: safeIsoOrNow(candidate.updatedAt),
    facts
  };
}

/**
 * Normalizes profile mutation audit metadata into a stable shape.
 *
 * @param raw - Unknown audit metadata payload.
 * @returns Normalized audit metadata, or `null` when invalid.
 */
function normalizeProfileMutationAuditMetadata(
  raw: unknown
): ProfileMutationAuditMetadataV1 | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const candidate = raw as Partial<ProfileMutationAuditMetadataV1>;
  if (candidate.classifier !== "commitment_signal") {
    return null;
  }
  if (
    candidate.category !== "TOPIC_RESOLUTION_CANDIDATE" &&
    candidate.category !== "GENERIC_RESOLUTION" &&
    candidate.category !== "RESOLVED_MARKER" &&
    candidate.category !== "NO_SIGNAL" &&
    candidate.category !== "UNCLEAR"
  ) {
    return null;
  }
  if (
    candidate.confidenceTier !== "HIGH" &&
    candidate.confidenceTier !== "MED" &&
    candidate.confidenceTier !== "LOW"
  ) {
    return null;
  }
  if (
    typeof candidate.matchedRuleId !== "string" ||
    typeof candidate.rulepackVersion !== "string" ||
    typeof candidate.conflict !== "boolean"
  ) {
    return null;
  }

  return {
    classifier: candidate.classifier,
    category: candidate.category,
    confidenceTier: candidate.confidenceTier,
    matchedRuleId: candidate.matchedRuleId,
    rulepackVersion: candidate.rulepackVersion,
    conflict: candidate.conflict
  };
}
