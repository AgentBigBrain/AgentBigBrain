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

export const ALLOWED_EXPLICIT_CONTACT_CONTEXT_SOURCES = new Set([
  "user_input_pattern.contact_context"
]);

export const ALLOWED_EXPLICIT_EPISODE_SOURCES = new Set([
  "user_input_pattern.episode_candidate"
]);

export const ALLOWED_ASSISTANT_INFERENCE_EPISODE_SOURCES = new Set([
  "language_understanding.episode_extraction"
]);
