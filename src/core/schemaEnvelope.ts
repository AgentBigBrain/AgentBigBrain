/**
 * @fileoverview Schema-envelope helpers for deterministic V1 artifact wrapping and hash verification.
 */

import { canonicalJson, sha256HexFromCanonicalJson } from "./normalizers/canonicalizationRules";
import { SchemaEnvelopeV1 } from "./types";

/**
 * Creates a deterministic `SchemaEnvelopeV1` for a payload.
 */
export function createSchemaEnvelopeV1<TPayload>(
  schemaName: string,
  payload: TPayload,
  createdAt = new Date().toISOString()
): SchemaEnvelopeV1<TPayload> {
  return {
    schemaName,
    schemaVersion: "v1",
    createdAt,
    hash: sha256HexFromCanonicalJson(payload),
    payload
  };
}

/**
 * Validates envelope shape and verifies hash parity against canonical payload serialization.
 */
export function verifySchemaEnvelopeV1<TPayload>(
  envelope: SchemaEnvelopeV1<TPayload>
): boolean {
  if (
    typeof envelope.schemaName !== "string" ||
    envelope.schemaVersion !== "v1" ||
    typeof envelope.createdAt !== "string" ||
    typeof envelope.hash !== "string"
  ) {
    return false;
  }
  return envelope.hash === sha256HexFromCanonicalJson(envelope.payload);
}

/**
 * Type-guard for unknown values expected to be `SchemaEnvelopeV1`.
 */
export function isSchemaEnvelopeV1<TPayload = unknown>(
  value: unknown
): value is SchemaEnvelopeV1<TPayload> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<SchemaEnvelopeV1<TPayload>>;
  return (
    typeof candidate.schemaName === "string" &&
    candidate.schemaVersion === "v1" &&
    typeof candidate.createdAt === "string" &&
    typeof candidate.hash === "string" &&
    "payload" in candidate
  );
}

/**
 * Produces deterministic canonical JSON for envelope payloads.
 */
export function canonicalEnvelopePayloadJson<TPayload>(
  envelope: SchemaEnvelopeV1<TPayload>
): string {
  return canonicalJson(envelope.payload);
}
