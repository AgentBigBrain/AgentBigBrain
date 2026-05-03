/**
 * @fileoverview Exact-source allowlists for deterministic profile-memory truth governance.
 */

export const MEMORY_REVIEW_FACT_CORRECTION_SOURCE = "memory_review.fact_correction";

export const SEMANTIC_RELATIONSHIP_CURRENT_SOURCE = "conversation.relationship_interpretation";
export const SEMANTIC_RELATIONSHIP_HISTORICAL_SOURCE =
  "conversation.relationship_interpretation_historical";
export const SEMANTIC_RELATIONSHIP_SEVERED_SOURCE =
  "conversation.relationship_interpretation_severed";
export const SEMANTIC_RELATIONSHIP_UNCERTAIN_SOURCE =
  "conversation.relationship_interpretation_uncertain";
export const SEMANTIC_EPISODE_CANDIDATE_SOURCE = "conversation.episode_interpretation";

export const SEMANTIC_RELATIONSHIP_SOURCES = new Set([
  SEMANTIC_RELATIONSHIP_CURRENT_SOURCE,
  SEMANTIC_RELATIONSHIP_HISTORICAL_SOURCE,
  SEMANTIC_RELATIONSHIP_SEVERED_SOURCE,
  SEMANTIC_RELATIONSHIP_UNCERTAIN_SOURCE
]);

export const STRUCTURED_RELATIONSHIP_NAME_SOURCES = new Set([
  SEMANTIC_RELATIONSHIP_CURRENT_SOURCE,
  SEMANTIC_RELATIONSHIP_HISTORICAL_SOURCE,
  SEMANTIC_RELATIONSHIP_SEVERED_SOURCE,
  SEMANTIC_RELATIONSHIP_UNCERTAIN_SOURCE
]);

export const STRUCTURED_CURRENT_RELATIONSHIP_SOURCES = new Set([
  SEMANTIC_RELATIONSHIP_CURRENT_SOURCE
]);

export const STRUCTURED_HISTORICAL_RELATIONSHIP_SOURCES = new Set([
  SEMANTIC_RELATIONSHIP_HISTORICAL_SOURCE
]);

export const STRUCTURED_SEVERED_RELATIONSHIP_SOURCES = new Set([
  SEMANTIC_RELATIONSHIP_SEVERED_SOURCE
]);

export const STRUCTURED_UNCERTAIN_RELATIONSHIP_SOURCES = new Set([
  SEMANTIC_RELATIONSHIP_UNCERTAIN_SOURCE
]);

export const ALLOWED_EXPLICIT_CONTACT_NAME_SOURCES = new Set([
  "user_input_pattern.named_contact",
  "user_input_pattern.direct_contact_relationship_historical",
  "user_input_pattern.direct_contact_relationship_severed",
  "user_input_pattern.work_with_contact_historical",
  "user_input_pattern.work_with_contact_severed"
]);

export const ALLOWED_EXPLICIT_CURRENT_CONTACT_RELATIONSHIP_SOURCES = new Set([
  "user_input_pattern.named_contact"
]);

export const ALLOWED_EXPLICIT_CURRENT_CONTACT_WORK_ASSOCIATION_SOURCES = new Set<string>();

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

/**
 * Returns whether a source belongs to the typed semantic relationship candidate lane.
 *
 * @param source - Candidate source string.
 * @returns `true` when the source is one of the governed semantic relationship sources.
 */
export function isSemanticRelationshipCandidateSource(source: string): boolean {
  return SEMANTIC_RELATIONSHIP_SOURCES.has(source.trim().toLowerCase());
}

export type ProfileMemorySourceFamily =
  | "explicit_user_statement"
  | "conversation_context"
  | "document_text_extraction"
  | "document_model_summary"
  | "media_model_summary"
  | "lexical_relationship_pattern"
  | "lexical_episode_pattern"
  | "reconciliation_projection"
  | "memory_review"
  | "unknown";

export type ProfileMemorySourceDefaultAuthority =
  | "durable_narrow_fact"
  | "support_only"
  | "candidate_only"
  | "review_override"
  | "quarantine";

export const PROFILE_MEMORY_SOURCE_FAMILY_DEFAULT_AUTHORITY: Record<
  ProfileMemorySourceFamily,
  ProfileMemorySourceDefaultAuthority
> = {
  explicit_user_statement: "durable_narrow_fact",
  conversation_context: "support_only",
  document_text_extraction: "candidate_only",
  document_model_summary: "candidate_only",
  media_model_summary: "candidate_only",
  lexical_relationship_pattern: "candidate_only",
  lexical_episode_pattern: "candidate_only",
  reconciliation_projection: "quarantine",
  memory_review: "review_override",
  unknown: "quarantine"
};

const DOCUMENT_TEXT_EXTRACTION_SOURCE_PREFIXES = [
  "document.text.",
  "document.raw_text.",
  "media.document.text.",
  "media.document.raw_text."
] as const;

const DOCUMENT_MODEL_SUMMARY_SOURCE_PREFIXES = [
  "document.summary.",
  "document.model_summary.",
  "media.document.summary.",
  "language_understanding.document."
] as const;

const MEDIA_MODEL_SUMMARY_SOURCE_PREFIXES = [
  "media.ocr.",
  "media.summary.",
  "language_understanding.media."
] as const;

const LEXICAL_RELATIONSHIP_SOURCE_NAMES = new Set([
  "user_input_pattern.named_contact",
  "user_input_pattern.direct_contact_relationship",
  "user_input_pattern.direct_contact_relationship_historical",
  "user_input_pattern.direct_contact_relationship_severed",
  "user_input_pattern.work_with_contact",
  "user_input_pattern.work_with_contact_historical",
  "user_input_pattern.work_with_contact_severed",
  "user_input_pattern.work_association",
  "user_input_pattern.work_association_historical",
  "user_input_pattern.organization_association",
  "user_input_pattern.location_association",
  "user_input_pattern.school_association",
  "user_input_pattern.contact_context",
  "user_input_pattern.contact_entity_hint"
]);

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
  if (DOCUMENT_TEXT_EXTRACTION_SOURCE_PREFIXES.some((prefix) => normalizedSource.startsWith(prefix))) {
    return "document_text_extraction";
  }
  if (DOCUMENT_MODEL_SUMMARY_SOURCE_PREFIXES.some((prefix) => normalizedSource.startsWith(prefix))) {
    return "document_model_summary";
  }
  if (MEDIA_MODEL_SUMMARY_SOURCE_PREFIXES.some((prefix) => normalizedSource.startsWith(prefix))) {
    return "media_model_summary";
  }
  if (normalizedSource.startsWith("user_input_pattern.")) {
    if (normalizedSource.startsWith("user_input_pattern.episode")) {
      return "lexical_episode_pattern";
    }
    if (LEXICAL_RELATIONSHIP_SOURCE_NAMES.has(normalizedSource)) {
      return "lexical_relationship_pattern";
    }
    return "explicit_user_statement";
  }
  if (normalizedSource.startsWith("conversation.")) {
    return "conversation_context";
  }
  if (normalizedSource.startsWith("profile_state_reconciliation.")) {
    return "reconciliation_projection";
  }
  if (normalizedSource.startsWith("language_understanding.")) {
    return "conversation_context";
  }
  return "unknown";
}

/**
 * Returns the default authority attached to a profile-memory source family before family-specific
 * governance rules decide whether a candidate can be persisted.
 *
 * @param source - Candidate source string.
 * @returns Default authority for the source family.
 */
export function getProfileMemorySourceDefaultAuthority(
  source: string
): ProfileMemorySourceDefaultAuthority {
  return PROFILE_MEMORY_SOURCE_FAMILY_DEFAULT_AUTHORITY[classifyProfileMemorySourceFamily(source)];
}

/**
 * Returns whether a source family is document/media-derived and must not create durable memory
 * authority without a more specific future policy.
 *
 * @param source - Candidate source string.
 * @returns `true` when the source must remain candidate-only or quarantined.
 */
export function isDocumentOrMediaDerivedProfileMemorySource(source: string): boolean {
  const family = classifyProfileMemorySourceFamily(source);
  return (
    family === "document_text_extraction" ||
    family === "document_model_summary" ||
    family === "media_model_summary"
  );
}
