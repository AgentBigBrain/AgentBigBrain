/**
 * @fileoverview Canonical normalization helpers for profile-memory keys, values, and context labels.
 */

const SENSITIVE_KEYWORDS = [
  "address",
  "phone",
  "email",
  "ssn",
  "social_security",
  "dob",
  "birth",
  "location",
  "residence"
];

const PROFILE_KEY_ALIASES: Record<string, string> = {
  name: "identity.preferred_name",
  "full.name": "identity.preferred_name",
  nickname: "identity.preferred_name",
  "preferred.name": "identity.preferred_name"
};
const RELATIONSHIP_DESCRIPTOR_ALIASES: Record<string, string> = {
  guy: "acquaintance",
  person: "acquaintance",
  family: "relative",
  "family member": "relative",
  mom: "relative",
  mother: "relative",
  dad: "relative",
  father: "relative",
  son: "relative",
  daughter: "relative",
  parent: "relative",
  child: "relative",
  sibling: "relative",
  sister: "relative",
  brother: "relative",
  wife: "partner",
  husband: "partner",
  spouse: "partner",
  girlfriend: "partner",
  boyfriend: "partner",
  aunt: "relative",
  uncle: "relative",
  "distant relative": "relative",
  boss: "manager",
  supervisor: "manager",
  lead: "manager",
  "team lead": "manager",
  "direct report": "employee",
  coworker: "work_peer",
  colleague: "work_peer",
  teammate: "work_peer",
  "work peer": "work_peer",
  peer: "work_peer",
  neighbour: "neighbor"
};

const PLANNING_CONTEXT_PRIORITY_PREFIXES = [
  "identity.preferred_name",
  "identity.name",
  "name"
];

/**
 * Canonicalizes raw profile-fact keys into deterministic dotted form.
 *
 * @param input - Raw profile key string.
 * @returns Normalized key used by persistence and lookup logic.
 */
export function normalizeProfileKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.\s-]+/g, "")
    .replace(/[\s-]+/g, ".")
    .replace(/\.+/g, ".")
    .replace(/^\./, "")
    .replace(/\.$/, "");
}

/**
 * Applies alias mapping on top of normalized profile keys.
 *
 * @param input - Raw or partially normalized key.
 * @returns Canonical key used for storage comparisons.
 */
export function canonicalizeProfileKey(input: string): string {
  const normalized = normalizeProfileKey(input);
  return PROFILE_KEY_ALIASES[normalized] ?? normalized;
}

/**
 * Normalizes profile fact values by collapsing whitespace and trimming.
 *
 * @param input - Raw fact value text.
 * @returns Normalized value string.
 */
export function normalizeProfileValue(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

/**
 * Trims trailing clause punctuation after normalization.
 *
 * @param value - Raw clause text.
 * @returns Sanitized clause text.
 */
export function trimTrailingClausePunctuation(value: string): string {
  const normalized = normalizeProfileValue(value);
  let end = normalized.length;
  while (end > 0 && [",", ":", ";"].includes(normalized[end - 1]!)) {
    end -= 1;
  }
  return normalized.slice(0, end).trim();
}

/**
 * Normalizes a follow-up topic phrase into a stable key suffix.
 *
 * @param rawTopic - Topic text extracted from user input.
 * @returns Normalized topic key or an empty string.
 */
export function normalizeResolutionTopicKey(rawTopic: string): string {
  const normalizedTopic = normalizeProfileKey(rawTopic);
  if (!normalizedTopic) {
    return "";
  }

  const removableLeadingTokens = new Set(["the", "a", "an", "my", "then"]);
  const topicTokens = normalizedTopic
    .split(".")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);

  while (topicTokens.length > 0 && removableLeadingTokens.has(topicTokens[0])) {
    topicTokens.shift();
  }

  return topicTokens.join(".");
}

/**
 * Normalizes relationship descriptors for contact facts.
 *
 * @param value - Raw relationship descriptor.
 * @returns Lowercased normalized descriptor.
 */
export function normalizeRelationshipDescriptor(value: string): string {
  const normalized = normalizeProfileValue(value).toLowerCase();
  return RELATIONSHIP_DESCRIPTOR_ALIASES[normalized] ?? normalized;
}

/**
 * Computes a stable non-cryptographic hash for short context keys.
 *
 * @param input - Context text used to build the hash.
 * @returns Stable lowercase hexadecimal hash.
 */
export function stableContextHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Splits free-form text into normalized sentence-like segments.
 *
 * @param text - User text under analysis.
 * @returns Normalized segments suitable for context extraction.
 */
export function splitIntoContextSentences(text: string): string[] {
  return text
    .split(/[\n.!?]+/)
    .map((segment) => normalizeProfileValue(segment))
    .filter((segment) => segment.length >= 8);
}

/**
 * Converts a contact token such as `owen.joel` into display-form text.
 *
 * @param contactToken - Canonical contact token.
 * @returns Human-readable display name.
 */
export function displayNameFromContactToken(contactToken: string): string {
  return contactToken
    .split(".")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Flags sensitive profile keys deterministically.
 *
 * @param key - Candidate profile key.
 * @returns `true` when the key is sensitive.
 */
export function isSensitiveKey(key: string): boolean {
  const normalized = canonicalizeProfileKey(key);
  return SENSITIVE_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

/**
 * Computes deterministic planner-context ordering for profile facts.
 *
 * @param key - Candidate fact key.
 * @returns Lower values sort earlier.
 */
export function planningContextPriority(key: string): number {
  const normalized = canonicalizeProfileKey(key);
  const priority = PLANNING_CONTEXT_PRIORITY_PREFIXES.findIndex(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}.`)
  );
  return priority >= 0 ? priority : PLANNING_CONTEXT_PRIORITY_PREFIXES.length;
}
