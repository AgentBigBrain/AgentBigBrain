/**
 * @fileoverview Shared source-authority vocabulary for semantic evidence and memory gates.
 */

export type SourceAuthority =
  | "exact_command"
  | "explicit_user_statement"
  | "semantic_model"
  | "lexical_fallback"
  | "document_text"
  | "document_model_summary"
  | "media_transcript"
  | "media_model_summary"
  | "review_mutation"
  | "legacy_compatibility"
  | "unknown";

export interface NormalizeSourceAuthorityOptions {
  allowLegacyCompatibility?: boolean;
  fallbackAuthority?: SourceAuthority;
}

export const SOURCE_AUTHORITY_VALUES: readonly SourceAuthority[] = [
  "exact_command",
  "explicit_user_statement",
  "semantic_model",
  "lexical_fallback",
  "document_text",
  "document_model_summary",
  "media_transcript",
  "media_model_summary",
  "review_mutation",
  "legacy_compatibility",
  "unknown"
] as const;

const SOURCE_AUTHORITY_SET = new Set<SourceAuthority>(SOURCE_AUTHORITY_VALUES);

/**
 * Evaluates whether a value is a known source-authority label.
 *
 * @param value - Candidate source authority.
 * @returns `true` when the value is in the canonical authority vocabulary.
 */
export function isSourceAuthority(value: unknown): value is SourceAuthority {
  return typeof value === "string" && SOURCE_AUTHORITY_SET.has(value as SourceAuthority);
}

/**
 * Normalizes source authority for strict runtime paths.
 *
 * @param value - Candidate source authority.
 * @param options - Compatibility controls for legacy-only values.
 * @returns Canonical authority, or a fail-closed fallback when unknown or disallowed.
 */
export function normalizeSourceAuthority(
  value: unknown,
  options: NormalizeSourceAuthorityOptions = {}
): SourceAuthority {
  const fallbackAuthority = options.fallbackAuthority ?? "unknown";
  if (!isSourceAuthority(value)) {
    return fallbackAuthority;
  }
  if (value === "legacy_compatibility" && options.allowLegacyCompatibility !== true) {
    return fallbackAuthority;
  }
  return value;
}
