/**
 * @fileoverview Canonical transport-identity normalization and low-confidence name-hint helpers.
 */

import type { ConversationTransportIdentityRecord } from "./sessionStateContracts";

const LETTER_PATTERN = /\p{L}/u;
const DIGIT_PATTERN = /\d/g;
const HANDLE_SEPARATOR_PATTERN = /[._-]+/g;
const CAMEL_BOUNDARY_PATTERN = /([a-z])([A-Z])/g;
const GENERIC_HANDLE_SUBSTRING_PATTERN =
  /(bot|admin|owner|agent|assistant|support|tester|test|user|guest|service|help|official)/i;
const GENERIC_NAME_TOKENS = new Set([
  "bot",
  "admin",
  "owner",
  "agent",
  "assistant",
  "support",
  "tester",
  "test",
  "user",
  "guest",
  "service",
  "help",
  "official"
]);

export interface ConversationTransportIdentityNameHint {
  value: string;
  source: "display_name" | "given_name" | "username";
  confidence: "low" | "medium";
  rawValue: string;
}

/**
 * Builds one normalized transport-identity record from provider ingress metadata.
 *
 * @param input - Provider identity fields captured from the inbound transport payload.
 * @returns Normalized transport identity, or `null` when no usable identity metadata exists.
 */
export function buildConversationTransportIdentityRecord(input: {
  provider: ConversationTransportIdentityRecord["provider"];
  username?: string | null;
  displayName?: string | null;
  givenName?: string | null;
  familyName?: string | null;
  observedAt: string;
}): ConversationTransportIdentityRecord | null {
  return normalizeConversationTransportIdentity({
    provider: input.provider,
    username: input.username ?? null,
    displayName: input.displayName ?? null,
    givenName: input.givenName ?? null,
    familyName: input.familyName ?? null,
    observedAt: input.observedAt
  });
}

/**
 * Normalizes optional transport identity persisted on the conversation session.
 *
 * @param raw - Unknown persisted transport identity.
 * @returns Stable runtime transport identity, or `null` when invalid/empty.
 */
export function normalizeConversationTransportIdentity(
  raw: Partial<ConversationTransportIdentityRecord> | null | undefined
): ConversationTransportIdentityRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  if (raw.provider !== "telegram" && raw.provider !== "discord") {
    return null;
  }
  if (typeof raw.observedAt !== "string" || raw.observedAt.trim().length === 0) {
    return null;
  }
  const username = normalizeTransportIdentityField(raw.username);
  const displayName = normalizeTransportIdentityField(raw.displayName);
  const givenName = normalizeTransportIdentityField(raw.givenName);
  const familyName = normalizeTransportIdentityField(raw.familyName);
  if (!username && !displayName && !givenName && !familyName) {
    return null;
  }
  return {
    provider: raw.provider,
    username,
    displayName,
    givenName,
    familyName,
    observedAt: raw.observedAt.trim()
  };
}

/**
 * Selects the strongest low-confidence human-name hint available from transport metadata.
 *
 * @param identity - Normalized transport identity attached to the current conversation.
 * @returns Best-effort name hint, or `null` when transport metadata is too weak or generic.
 */
export function selectConversationTransportIdentityNameHint(
  identity: ConversationTransportIdentityRecord | null
): ConversationTransportIdentityNameHint | null {
  if (!identity) {
    return null;
  }
  const displayName = sanitizeHumanDisplayName(identity.displayName);
  if (displayName) {
    return {
      value: displayName,
      source: "display_name",
      confidence: "medium",
      rawValue: identity.displayName ?? displayName
    };
  }
  const givenName = sanitizeHumanDisplayName(identity.givenName);
  if (givenName) {
    return {
      value: givenName,
      source: "given_name",
      confidence: "medium",
      rawValue: identity.givenName ?? givenName
    };
  }
  const usernameHint = renderHumanNameFromUsername(identity.username);
  if (!usernameHint) {
    return null;
  }
  return {
    value: usernameHint,
    source: "username",
    confidence: "low",
    rawValue: identity.username ?? usernameHint
  };
}

/**
 * Normalizes one optional transport identity field.
 *
 * @param value - Raw transport identity field.
 * @returns Trimmed string, or `null` when empty.
 */
function normalizeTransportIdentityField(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Returns whether a name-like string contains too many digits to be a reliable human name hint.
 *
 * @param value - Candidate display value.
 * @returns `true` when the candidate looks handle-like rather than name-like.
 */
function hasExcessiveDigits(value: string): boolean {
  return (value.match(DIGIT_PATTERN)?.length ?? 0) > 2;
}

/**
 * Normalizes a human-readable display-name candidate and rejects generic/service-like values.
 *
 * @param value - Candidate transport display value.
 * @returns Sanitized display name, or `null` when the value is too weak to reuse.
 */
function sanitizeHumanDisplayName(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (
    normalized.length < 2 ||
    normalized.length > 60 ||
    !LETTER_PATTERN.test(normalized) ||
    hasExcessiveDigits(normalized) ||
    /[@/_\\]/.test(normalized)
  ) {
    return null;
  }
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}]+|[^\p{L}'-]+$/gu, ""))
    .filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens.length > 4) {
    return null;
  }
  if (tokens.some((token) => isGenericNameToken(token))) {
    return null;
  }
  return tokens.map(toDisplayCase).join(" ");
}

/**
 * Renders a best-effort human-readable name from a provider username when the handle is plausible.
 *
 * @param username - Provider username/handle.
 * @returns Display-name candidate, or `null` when the handle is too generic or ambiguous.
 */
function renderHumanNameFromUsername(username: string | null): string | null {
  if (!username) {
    return null;
  }
  const normalized = username.trim().replace(/^@+/, "");
  if (
    normalized.length < 2 ||
    normalized.length > 40 ||
    !LETTER_PATTERN.test(normalized) ||
    hasExcessiveDigits(normalized) ||
    GENERIC_HANDLE_SUBSTRING_PATTERN.test(normalized)
  ) {
    return null;
  }
  const hasSeparators = /[._-]/.test(normalized);
  const hasCamelCase = CAMEL_BOUNDARY_PATTERN.test(normalized);
  if (!hasSeparators && !hasCamelCase && normalized === normalized.toLowerCase() && normalized.length > 10) {
    return null;
  }
  const spaced = normalized
    .replace(CAMEL_BOUNDARY_PATTERN, "$1 $2")
    .replace(HANDLE_SEPARATOR_PATTERN, " ");
  const tokens = spaced
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, ""))
    .filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens.length > 3) {
    return null;
  }
  if (tokens.some((token) => token.length < 2 || isGenericNameToken(token))) {
    return null;
  }
  return tokens.map(toDisplayCase).join(" ");
}

/**
 * Returns whether a token is obviously service/generic rather than a person name.
 *
 * @param token - Candidate name token.
 * @returns `true` when the token should be rejected as a person-name hint.
 */
function isGenericNameToken(token: string): boolean {
  return GENERIC_NAME_TOKENS.has(token.toLowerCase());
}

/**
 * Renders one token in title case for user-facing prompt context.
 *
 * @param token - Raw candidate token.
 * @returns Display-cased token.
 */
function toDisplayCase(token: string): string {
  if (token.toUpperCase() === token) {
    return token;
  }
  return `${token.charAt(0).toUpperCase()}${token.slice(1).toLowerCase()}`;
}
