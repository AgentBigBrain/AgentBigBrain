/**
 * @fileoverview Deterministic helpers for bounded profile-memory ingest provenance and replay-safe source IDs.
 */

import { createHash } from "node:crypto";

import type {
  ProfileMemoryIngestRequest,
  ProfileMemoryWriteProvenance,
  ProfileValidatedFactCandidateInput
} from "./contracts";

/**
 * Normalizes freeform source text into the bounded whitespace-stable form used by source
 * fingerprinting.
 *
 * @param value - Raw conversational source text.
 * @returns Trimmed text with internal whitespace collapsed.
 */
function normalizeProfileMemoryFingerprintText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Builds one deterministic fingerprint for the normalized conversational source payload.
 *
 * @param userInput - Optional raw user wording attached to the write.
 * @param validatedFactCandidates - Optional canonical validated candidates attached to the write.
 * @returns Stable bounded fingerprint used for provenance and later idempotency boundaries.
 */
export function buildProfileMemorySourceFingerprint(
  userInput?: string,
  validatedFactCandidates: readonly ProfileValidatedFactCandidateInput[] = []
): string {
  const canonicalPayload = JSON.stringify({
    userInput: normalizeProfileMemoryFingerprintText(userInput),
    validatedFactCandidates: validatedFactCandidates.map((candidate) => ({
      key: candidate.key.trim().toLowerCase(),
      candidateValue: normalizeProfileMemoryFingerprintText(candidate.candidateValue),
      sensitive: candidate.sensitive === true,
      source: candidate.source.trim().toLowerCase(),
      confidence:
        typeof candidate.confidence === "number"
          ? Number(candidate.confidence.toFixed(4))
          : null
    }))
  });
  return createHash("sha256")
    .update(canonicalPayload)
    .digest("hex")
    .slice(0, 32);
}

/**
 * Builds a deterministic per-turn identifier for conversational memory writes inside one
 * conversation stream.
 *
 * @param conversationId - Conversation session identifier.
 * @param receivedAt - Inbound turn timestamp.
 * @param sourceFingerprint - Stable normalized source fingerprint for the write payload.
 * @returns Stable bounded turn identifier.
 */
export function buildConversationProfileMemoryTurnId(
  conversationId: string,
  receivedAt: string,
  sourceFingerprint: string
): string {
  return `turn_${createHash("sha256")
    .update([conversationId.trim(), receivedAt.trim(), sourceFingerprint.trim()].join("\n"))
    .digest("hex")
    .slice(0, 24)}`;
}

/**
 * Ensures bounded ingest provenance always carries a normalized source fingerprint when the write
 * contract already has a provenance envelope.
 *
 * @param request - Raw ingest request entering the canonical seam.
 * @returns Same request shape with a normalized source fingerprint injected when provenance exists.
 */
export function normalizeProfileMemoryIngestRequest(
  request: ProfileMemoryIngestRequest
): ProfileMemoryIngestRequest {
  if (!request.provenance) {
    return request;
  }
  return {
    ...request,
    provenance: {
      ...request.provenance,
      sourceFingerprint:
        request.provenance.sourceFingerprint ??
        buildProfileMemorySourceFingerprint(
          request.userInput,
          request.validatedFactCandidates ?? []
        )
    }
  };
}

/**
 * Builds a deterministic synthetic source-task id from bounded ingest provenance when the write did
 * not already arrive through a canonical task boundary.
 *
 * @param provenance - Optional stream-local provenance attached to the write.
 * @returns Stable synthetic task id, or `null` when provenance is too sparse.
 */
export function buildProfileMemorySourceTaskIdFromProvenance(
  provenance: ProfileMemoryWriteProvenance | null | undefined
): string | null {
  if (!provenance?.turnId || !provenance.sourceSurface) {
    return null;
  }
  const stablePayload = JSON.stringify({
    conversationId: provenance.conversationId ?? null,
    turnId: provenance.turnId,
    dominantLaneAtWrite: provenance.dominantLaneAtWrite ?? null,
    threadKey: provenance.threadKey ?? null,
    sourceSurface: provenance.sourceSurface,
    sourceFingerprint: provenance.sourceFingerprint ?? null
  });
  return `profile_ingest_${provenance.sourceSurface}_${createHash("sha256")
    .update(stablePayload)
    .digest("hex")
    .slice(0, 24)}`;
}
