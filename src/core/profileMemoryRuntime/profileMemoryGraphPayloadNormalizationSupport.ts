/**
 * @fileoverview Fail-closed raw payload normalization helpers for retained additive graph records.
 */

import type {
  ProfileMemoryGraphClaimPayloadV1,
  ProfileMemoryGraphEventPayloadV1,
  ProfileMemoryGraphObservationPayloadV1,
  ProfileMemoryGraphRedactionState,
  ProfileMemoryGraphSourceTier,
  ProfileMemoryGraphTimePrecision,
  ProfileMemoryGraphTimeSource
} from "./profileMemoryGraphContracts";

const INVALID_PROFILE_MEMORY_GRAPH_ENUM_CANDIDATE = Symbol(
  "INVALID_PROFILE_MEMORY_GRAPH_ENUM_CANDIDATE"
);

/**
 * Repairs one raw retained observation payload candidate into the bounded canonical contract.
 *
 * @param value - Unknown persisted observation payload candidate.
 * @returns Canonical observation payload, or `null` when required fields stay invalid.
 */
export function normalizeProfileMemoryGraphObservationPayloadCandidate(
  value: unknown
): ProfileMemoryGraphObservationPayloadV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<ProfileMemoryGraphObservationPayloadV1>;
  const sourceTier = normalizeProfileMemoryGraphSourceTierCandidate(candidate.sourceTier);
  const timePrecision = normalizeProfileMemoryGraphTimePrecisionCandidate(
    candidate.timePrecision
  );
  const timeSource = normalizeProfileMemoryGraphTimeSourceCandidate(candidate.timeSource);
  const redactionState = normalizeOptionalProfileMemoryGraphRedactionStateCandidate(
    candidate.redactionState
  );

  if (
    typeof candidate.observationId !== "string" ||
    !isNullableString(candidate.stableRefId) ||
    !isNullableString(candidate.family) ||
    !isNullableString(candidate.normalizedKey) ||
    !isNullableString(candidate.normalizedValue) ||
    redactionState === INVALID_PROFILE_MEMORY_GRAPH_ENUM_CANDIDATE ||
    !isOptionalNullableString(candidate.redactedAt) ||
    typeof candidate.sensitive !== "boolean" ||
    !isNullableString(candidate.sourceTaskId) ||
    typeof candidate.sourceFingerprint !== "string" ||
    sourceTier === null ||
    typeof candidate.assertedAt !== "string" ||
    typeof candidate.observedAt !== "string" ||
    timePrecision === null ||
    timeSource === null ||
    !isStringArray(candidate.entityRefIds)
  ) {
    return null;
  }

  return {
    observationId: candidate.observationId,
    stableRefId: candidate.stableRefId,
    family: candidate.family,
    normalizedKey: candidate.normalizedKey,
    normalizedValue: candidate.normalizedValue,
    ...(redactionState === undefined ? {} : { redactionState }),
    ...(candidate.redactedAt === undefined ? {} : { redactedAt: candidate.redactedAt }),
    sensitive: candidate.sensitive,
    sourceTaskId: candidate.sourceTaskId,
    sourceFingerprint: candidate.sourceFingerprint,
    sourceTier,
    assertedAt: candidate.assertedAt,
    observedAt: candidate.observedAt,
    timePrecision,
    timeSource,
    entityRefIds: candidate.entityRefIds
  };
}

/**
 * Repairs one raw retained claim payload candidate into the bounded canonical contract.
 *
 * @param value - Unknown persisted claim payload candidate.
 * @returns Canonical claim payload, or `null` when required fields stay invalid.
 */
export function normalizeProfileMemoryGraphClaimPayloadCandidate(
  value: unknown
): ProfileMemoryGraphClaimPayloadV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<ProfileMemoryGraphClaimPayloadV1>;
  const sourceTier = normalizeProfileMemoryGraphSourceTierCandidate(candidate.sourceTier);
  const timePrecision = normalizeProfileMemoryGraphTimePrecisionCandidate(
    candidate.timePrecision
  );
  const timeSource = normalizeProfileMemoryGraphTimeSourceCandidate(candidate.timeSource);
  const redactionState = normalizeOptionalProfileMemoryGraphRedactionStateCandidate(
    candidate.redactionState
  );

  if (
    typeof candidate.claimId !== "string" ||
    !isNullableString(candidate.stableRefId) ||
    typeof candidate.family !== "string" ||
    typeof candidate.normalizedKey !== "string" ||
    !isNullableString(candidate.normalizedValue) ||
    redactionState === INVALID_PROFILE_MEMORY_GRAPH_ENUM_CANDIDATE ||
    !isOptionalNullableString(candidate.redactedAt) ||
    typeof candidate.sensitive !== "boolean" ||
    !isNullableString(candidate.sourceTaskId) ||
    typeof candidate.sourceFingerprint !== "string" ||
    sourceTier === null ||
    typeof candidate.assertedAt !== "string" ||
    !isNullableString(candidate.validFrom) ||
    !isNullableString(candidate.validTo) ||
    !isNullableString(candidate.endedAt) ||
    !isNullableString(candidate.endedByClaimId) ||
    timePrecision === null ||
    timeSource === null ||
    !isStringArray(candidate.derivedFromObservationIds) ||
    !isStringArray(candidate.projectionSourceIds) ||
    !isStringArray(candidate.entityRefIds) ||
    typeof candidate.active !== "boolean"
  ) {
    return null;
  }

  return {
    claimId: candidate.claimId,
    stableRefId: candidate.stableRefId,
    family: candidate.family,
    normalizedKey: candidate.normalizedKey,
    normalizedValue: candidate.normalizedValue,
    ...(redactionState === undefined ? {} : { redactionState }),
    ...(candidate.redactedAt === undefined ? {} : { redactedAt: candidate.redactedAt }),
    sensitive: candidate.sensitive,
    sourceTaskId: candidate.sourceTaskId,
    sourceFingerprint: candidate.sourceFingerprint,
    sourceTier,
    assertedAt: candidate.assertedAt,
    validFrom: candidate.validFrom,
    validTo: candidate.validTo,
    endedAt: candidate.endedAt,
    endedByClaimId: candidate.endedByClaimId,
    timePrecision,
    timeSource,
    derivedFromObservationIds: candidate.derivedFromObservationIds,
    projectionSourceIds: candidate.projectionSourceIds,
    entityRefIds: candidate.entityRefIds,
    active: candidate.active
  };
}

/**
 * Repairs one raw retained event payload candidate into the bounded canonical contract.
 *
 * @param value - Unknown persisted event payload candidate.
 * @returns Canonical event payload, or `null` when required fields stay invalid.
 */
export function normalizeProfileMemoryGraphEventPayloadCandidate(
  value: unknown
): ProfileMemoryGraphEventPayloadV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<ProfileMemoryGraphEventPayloadV1>;
  const sourceTier = normalizeProfileMemoryGraphSourceTierCandidate(candidate.sourceTier);
  const timePrecision = normalizeProfileMemoryGraphTimePrecisionCandidate(
    candidate.timePrecision
  );
  const timeSource = normalizeProfileMemoryGraphTimeSourceCandidate(candidate.timeSource);
  const redactionState = normalizeOptionalProfileMemoryGraphRedactionStateCandidate(
    candidate.redactionState
  );

  if (
    typeof candidate.eventId !== "string" ||
    !isNullableString(candidate.stableRefId) ||
    !isNullableString(candidate.family) ||
    typeof candidate.title !== "string" ||
    typeof candidate.summary !== "string" ||
    redactionState === INVALID_PROFILE_MEMORY_GRAPH_ENUM_CANDIDATE ||
    !isOptionalNullableString(candidate.redactedAt) ||
    typeof candidate.sensitive !== "boolean" ||
    !isNullableString(candidate.sourceTaskId) ||
    typeof candidate.sourceFingerprint !== "string" ||
    sourceTier === null ||
    typeof candidate.assertedAt !== "string" ||
    typeof candidate.observedAt !== "string" ||
    !isNullableString(candidate.validFrom) ||
    !isNullableString(candidate.validTo) ||
    timePrecision === null ||
    timeSource === null ||
    !isStringArray(candidate.derivedFromObservationIds) ||
    !isStringArray(candidate.projectionSourceIds) ||
    !isStringArray(candidate.entityRefIds)
  ) {
    return null;
  }

  return {
    eventId: candidate.eventId,
    stableRefId: candidate.stableRefId,
    family: candidate.family,
    title: candidate.title,
    summary: candidate.summary,
    ...(redactionState === undefined ? {} : { redactionState }),
    ...(candidate.redactedAt === undefined ? {} : { redactedAt: candidate.redactedAt }),
    sensitive: candidate.sensitive,
    sourceTaskId: candidate.sourceTaskId,
    sourceFingerprint: candidate.sourceFingerprint,
    sourceTier,
    assertedAt: candidate.assertedAt,
    observedAt: candidate.observedAt,
    validFrom: candidate.validFrom,
    validTo: candidate.validTo,
    timePrecision,
    timeSource,
    derivedFromObservationIds: candidate.derivedFromObservationIds,
    projectionSourceIds: candidate.projectionSourceIds,
    entityRefIds: candidate.entityRefIds
  };
}

/**
 * Checks whether one raw candidate is a nullable string.
 *
 * @param value - Unknown raw value.
 * @returns `true` when the value is `string | null`.
 */
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * Checks whether one raw candidate is an optional nullable string.
 *
 * @param value - Unknown raw value.
 * @returns `true` when the value is `undefined | string | null`.
 */
function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || isNullableString(value);
}

/**
 * Checks whether one raw candidate is an array of strings.
 *
 * @param value - Unknown raw value.
 * @returns `true` when every entry is a string.
 */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Trims one raw graph source-tier candidate into the bounded canonical vocabulary.
 *
 * @param value - Unknown raw source-tier candidate.
 * @returns Canonical source tier, or `null` when invalid.
 */
function normalizeProfileMemoryGraphSourceTierCandidate(
  value: unknown
): ProfileMemoryGraphSourceTier | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "explicit_user_statement" ||
    trimmed === "validated_structured_candidate" ||
    trimmed === "reconciliation_or_projection" ||
    trimmed === "assistant_inference"
    ? trimmed
    : null;
}

/**
 * Trims one raw graph time-precision candidate into the bounded canonical vocabulary.
 *
 * @param value - Unknown raw precision candidate.
 * @returns Canonical precision, or `null` when invalid.
 */
function normalizeProfileMemoryGraphTimePrecisionCandidate(
  value: unknown
): ProfileMemoryGraphTimePrecision | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "instant" || trimmed === "day" || trimmed === "unknown"
    ? trimmed
    : null;
}

/**
 * Trims one raw graph time-source candidate into the bounded canonical vocabulary.
 *
 * @param value - Unknown raw time-source candidate.
 * @returns Canonical time source, or `null` when invalid.
 */
function normalizeProfileMemoryGraphTimeSourceCandidate(
  value: unknown
): ProfileMemoryGraphTimeSource | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "observed_at" ||
    trimmed === "asserted_at" ||
    trimmed === "user_stated" ||
    trimmed === "inferred" ||
    trimmed === "system_generated"
    ? trimmed
    : null;
}

/**
 * Trims one optional raw graph redaction-state candidate into the bounded canonical vocabulary.
 *
 * @param value - Unknown raw redaction-state candidate.
 * @returns Canonical redaction state, `undefined` when absent, or an invalid sentinel.
 */
function normalizeOptionalProfileMemoryGraphRedactionStateCandidate(
  value: unknown
): ProfileMemoryGraphRedactionState | undefined | typeof INVALID_PROFILE_MEMORY_GRAPH_ENUM_CANDIDATE {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    return INVALID_PROFILE_MEMORY_GRAPH_ENUM_CANDIDATE;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed === "not_requested" || trimmed === "redacted"
    ? trimmed
    : INVALID_PROFILE_MEMORY_GRAPH_ENUM_CANDIDATE;
}
