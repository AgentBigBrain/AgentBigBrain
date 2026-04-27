/**
 * @fileoverview Exact-source allowlists for deterministic profile-memory truth governance.
 */

export const MEMORY_REVIEW_FACT_CORRECTION_SOURCE = "memory_review.fact_correction";

export const ALLOWED_EXPLICIT_CONTACT_NAME_SOURCES = new Set([
  "user_input_pattern.named_contact",
  "user_input_pattern.direct_contact_relationship",
  "user_input_pattern.direct_contact_relationship_historical",
  "user_input_pattern.direct_contact_relationship_severed",
  "user_input_pattern.work_with_contact",
  "user_input_pattern.work_with_contact_historical",
  "user_input_pattern.work_with_contact_severed"
]);

export const ALLOWED_EXPLICIT_CURRENT_CONTACT_RELATIONSHIP_SOURCES = new Set([
  "user_input_pattern.named_contact",
  "user_input_pattern.direct_contact_relationship",
  "user_input_pattern.work_with_contact",
  "user_input_pattern.work_association"
]);

export const ALLOWED_EXPLICIT_CURRENT_CONTACT_WORK_ASSOCIATION_SOURCES = new Set([
  "user_input_pattern.direct_contact_relationship",
  "user_input_pattern.work_with_contact",
  "user_input_pattern.work_association"
]);

export const ALLOWED_EXPLICIT_CURRENT_CONTACT_GENERIC_ASSOCIATION_SOURCES = new Set([
  "user_input_pattern.organization_association",
  "user_input_pattern.location_association"
]);

export const ALLOWED_EXPLICIT_CONTACT_CONTEXT_SOURCES = new Set([
  "user_input_pattern.contact_context"
]);

export const ALLOWED_EXPLICIT_EPISODE_SOURCES = new Set([
  "user_input_pattern.episode_candidate"
]);

export const ALLOWED_ASSISTANT_INFERENCE_EPISODE_SOURCES = new Set([
  "language_understanding.episode_extraction"
]);

export type ProfileMemorySourceFamily =
  | "explicit_user_pattern"
  | "structured_conversation"
  | "language_understanding"
  | "document_or_media_derivation"
  | "reconciliation_projection"
  | "memory_review"
  | "unknown";

const DOCUMENT_OR_MEDIA_DERIVED_SOURCE_PREFIXES = [
  "document.",
  "media.document.",
  "media.ocr.",
  "media.summary.",
  "language_understanding.document.",
  "language_understanding.media."
] as const;

/**
 * Classifies profile-memory candidate source strings into broad policy families.
 *
 * @param source - Candidate source string.
 * @returns Source family used by truth-governance gates.
 */
export function classifyProfileMemorySourceFamily(source: string): ProfileMemorySourceFamily {
  const normalizedSource = source.trim().toLowerCase();
  if (!normalizedSource) {
    return "unknown";
  }
  if (normalizedSource === MEMORY_REVIEW_FACT_CORRECTION_SOURCE) {
    return "memory_review";
  }
  if (DOCUMENT_OR_MEDIA_DERIVED_SOURCE_PREFIXES.some((prefix) => normalizedSource.startsWith(prefix))) {
    return "document_or_media_derivation";
  }
  if (normalizedSource.startsWith("user_input_pattern.")) {
    return "explicit_user_pattern";
  }
  if (normalizedSource.startsWith("conversation.")) {
    return "structured_conversation";
  }
  if (normalizedSource.startsWith("profile_state_reconciliation.")) {
    return "reconciliation_projection";
  }
  if (normalizedSource.startsWith("language_understanding.")) {
    return "language_understanding";
  }
  return "unknown";
}

/**
 * Returns whether a source family is document/media-derived and must not create durable memory
 * authority without a more specific future policy.
 *
 * @param source - Candidate source string.
 * @returns `true` when the source must remain candidate-only or quarantined.
 */
export function isDocumentOrMediaDerivedProfileMemorySource(source: string): boolean {
  return classifyProfileMemorySourceFamily(source) === "document_or_media_derivation";
}
