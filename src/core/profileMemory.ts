/**
 * @fileoverview Defines temporal profile-memory models, deterministic extraction rules, and freshness/supersession helpers.
 */

import { makeId } from "./ids";

export const PROFILE_MEMORY_SCHEMA_VERSION = 1;
export const DEFAULT_PROFILE_STALE_AFTER_DAYS = 90;

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

const HEDGED_CONFIDENCE_PATTERNS = [
  "maybe",
  "might be",
  "not sure",
  "i think",
  "possibly"
];

const PROFILE_KEY_ALIASES: Record<string, string> = {
  name: "identity.preferred_name",
  "full.name": "identity.preferred_name",
  nickname: "identity.preferred_name",
  "preferred.name": "identity.preferred_name"
};

const PLANNING_CONTEXT_PRIORITY_PREFIXES = [
  "identity.preferred_name",
  "identity.name",
  "name"
];

export type ProfileFactStatus = "confirmed" | "uncertain" | "superseded";

export type ProfileMutationAuditClassifier = "commitment_signal";

export type ProfileMutationAuditCategory =
  | "TOPIC_RESOLUTION_CANDIDATE"
  | "GENERIC_RESOLUTION"
  | "RESOLVED_MARKER"
  | "NO_SIGNAL"
  | "UNCLEAR";

export type ProfileMutationAuditConfidenceTier = "HIGH" | "MED" | "LOW";

export interface ProfileMutationAuditMetadataV1 {
  classifier: ProfileMutationAuditClassifier;
  category: ProfileMutationAuditCategory;
  confidenceTier: ProfileMutationAuditConfidenceTier;
  matchedRuleId: string;
  rulepackVersion: string;
  conflict: boolean;
}

export interface ProfileFactRecord {
  id: string;
  key: string;
  value: string;
  sensitive: boolean;
  status: ProfileFactStatus;
  confidence: number;
  sourceTaskId: string;
  source: string;
  observedAt: string;
  confirmedAt: string | null;
  supersededAt: string | null;
  lastUpdatedAt: string;
  mutationAudit?: ProfileMutationAuditMetadataV1;
}

export interface ProfileMemoryState {
  schemaVersion: number;
  updatedAt: string;
  facts: ProfileFactRecord[];
}

export interface ProfileFactUpsertInput {
  key: string;
  value: string;
  sensitive: boolean;
  sourceTaskId: string;
  source: string;
  observedAt?: string;
  confidence?: number;
  mutationAudit?: ProfileMutationAuditMetadataV1 | null;
}

export interface ProfileUpsertResult {
  nextState: ProfileMemoryState;
  upsertedFact: ProfileFactRecord;
  supersededFactIds: string[];
}

export interface ProfileFreshnessAssessment {
  stale: boolean;
  ageDays: number;
}

/**
 * Creates a fresh in-memory profile state envelope.
 *
 * **Why it exists:**
 * Multiple bootstrap paths (missing file, parse failure fallback, tests) need one canonical empty
 * shape with schema/version fields aligned.
 *
 * **What it talks to:**
 * - Uses local schema constants and current timestamp only.
 * @returns Empty profile-memory state with current `updatedAt`.
 */
export function createEmptyProfileMemoryState(): ProfileMemoryState {
  return {
    schemaVersion: PROFILE_MEMORY_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    facts: []
  };
}

/**
 * Coerces a timestamp candidate to valid ISO format, falling back to `now`.
 *
 * **Why it exists:**
 * Persisted profile facts should always carry parseable ISO timestamps; invalid inputs are repaired
 * deterministically instead of propagating malformed dates.
 *
 * **What it talks to:**
 * - Local date parsing and `Date` ISO conversion.
 *
 * @param value - Candidate timestamp from persisted or inbound payloads.
 * @returns Valid ISO timestamp string.
 */
function safeIsoOrNow(value: string | undefined): string {
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
 * Normalizes confidence into a stable shape for `profileMemory` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for confidence so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed numeric value.
 */
function normalizeConfidence(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0.9;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

/**
 * Canonicalizes raw profile-fact keys into deterministic dotted form.
 *
 * **Why it exists:**
 * Key normalization prevents duplicate logical facts caused by casing/punctuation variants
 * (`preferred name`, `preferred-name`, `Preferred.Name`, etc.).
 *
 * **What it talks to:**
 * - Uses local regex normalization rules only.
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
 * **Why it exists:**
 * Multiple lexical forms can refer to the same canonical fact lane; alias mapping keeps writes
 * and reads unified.
 *
 * **What it talks to:**
 * - Calls `normalizeProfileKey`.
 * - Reads `PROFILE_KEY_ALIASES`.
 *
 * @param input - Raw or partially normalized key.
 * @returns Canonical key used for storage comparisons.
 */
function canonicalizeProfileKey(input: string): string {
  const normalized = normalizeProfileKey(input);
  return PROFILE_KEY_ALIASES[normalized] ?? normalized;
}

/**
 * Normalizes profile fact values by collapsing whitespace and trimming.
 *
 * **Why it exists:**
 * Value normalization keeps equality/supersession logic deterministic across minor formatting
 * differences in user phrasing.
 *
 * **What it talks to:**
 * - Local string normalization only.
 *
 * @param input - Raw fact value text.
 * @returns Normalized value string.
 */
export function normalizeProfileValue(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

/**
 * Constrains and sanitizes trailing clause punctuation to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for trailing clause punctuation before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function trimTrailingClausePunctuation(value: string): string {
  return normalizeProfileValue(value).replace(/[,:;]+$/g, "").trim();
}

/**
 * Normalizes resolution topic key into a stable shape for `profileMemory` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for resolution topic key so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param rawTopic - Value for raw topic.
 * @returns Resulting string value.
 */
function normalizeResolutionTopicKey(rawTopic: string): string {
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
 * Derives resolved followup facts from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for resolved followup facts in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @param sourceTaskId - Stable identifier used to reference an entity or record.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Ordered collection produced by this step.
 */
function extractResolvedFollowupFacts(
  text: string,
  sourceTaskId: string,
  observedAt: string
): ProfileFactUpsertInput[] {
  const candidates: ProfileFactUpsertInput[] = [];
  const resolutionPatterns = [
    /\b(?:i|we)\s+(?:no\s+longer\s+need\s+help\s+with|do\s+not\s+need\s+help\s+with|don't\s+need\s+help\s+with|am\s+all\s+set\s+with|are\s+all\s+set\s+with)\s+([^.!?\n]+?)(?=(?:\s+anymore\b)?(?:[.!?\n]|$))/gi,
    /\b(?:turn\s+off|stop|disable)\s+(?:the\s+)?(?:notifications?|reminders?)\s+(?:for|about)\s+([^.!?\n]+?)(?=(?:\s+anymore\b)?(?:[.!?\n]|$))/gi
  ];

  for (const pattern of resolutionPatterns) {
    for (const match of text.matchAll(pattern)) {
      const rawTopic = trimTrailingClausePunctuation(match[1] ?? "");
      const topicKey = normalizeResolutionTopicKey(rawTopic);
      if (!topicKey) {
        continue;
      }

      candidates.push({
        key: `followup.${topicKey}`,
        value: "resolved",
        sensitive: false,
        sourceTaskId,
        source: "user_input_pattern.followup_resolved",
        observedAt,
        confidence: toSentenceConfidence(match[0])
      });
    }
  }

  return candidates;
}

/**
 * Normalizes relationship descriptor into a stable shape for `profileMemory` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for relationship descriptor so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeRelationshipDescriptor(value: string): string {
  return normalizeProfileValue(value).toLowerCase();
}

/**
 * Implements stable context hash behavior used by `profileMemory`.
 *
 * **Why it exists:**
 * Keeps `stable context hash` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 * @returns Resulting string value.
 */
function stableContextHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Splits into context sentences into normalized segments for downstream parsing.
 *
 * **Why it exists:**
 * Maintains one token/segment boundary policy for into context sentences so lexical decisions stay stable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @returns Ordered collection produced by this step.
 */
function splitIntoContextSentences(text: string): string[] {
  return text
    .split(/[\n.!?]+/)
    .map((segment) => normalizeProfileValue(segment))
    .filter((segment) => segment.length >= 8);
}

/**
 * Implements display name from contact token behavior used by `profileMemory`.
 *
 * **Why it exists:**
 * Keeps `display name from contact token` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param contactToken - Token value used for lexical parsing or matching.
 * @returns Resulting string value.
 */
function displayNameFromContactToken(contactToken: string): string {
  return contactToken
    .split(".")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Derives context inferred contact tokens from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for context inferred contact tokens in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @returns Ordered collection produced by this step.
 */
function extractContextInferredContactTokens(text: string): string[] {
  const tokens = new Set<string>();
  const patterns = [
    /\b([A-Z][A-Za-z' -]{1,40}?)\s+and\s+i\b/gi,
    /\bi(?:'ve| have)?\s+known\s+([A-Z][A-Za-z' -]{1,40})\b/gi,
    /\bi\s+know\s+([A-Z][A-Za-z' -]{1,40})\b/gi
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const rawName = trimTrailingClausePunctuation(match[1] ?? "");
      const token = normalizeProfileKey(rawName);
      if (!token || token === "i") {
        continue;
      }
      tokens.add(token);
    }
  }

  return [...tokens];
}

/**
 * Derives contact context facts from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for contact context facts in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @param contactTokens - Token value used for lexical parsing or matching.
 * @param sourceTaskId - Stable identifier used to reference an entity or record.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Ordered collection produced by this step.
 */
function extractContactContextFacts(
  text: string,
  contactTokens: Set<string>,
  sourceTaskId: string,
  observedAt: string
): ProfileFactUpsertInput[] {
  const candidates: ProfileFactUpsertInput[] = [];
  if (contactTokens.size === 0) {
    return candidates;
  }

  const sentences = splitIntoContextSentences(text);
  for (const contactToken of contactTokens) {
    const displayName = displayNameFromContactToken(contactToken);
    const namePattern = new RegExp(`\\b${displayName}\\b`, "i");
    let addedContextCount = 0;

    for (const sentence of sentences) {
      if (!namePattern.test(sentence)) {
        continue;
      }
      const keySuffix = stableContextHash(`${contactToken}:${sentence}`);
      candidates.push({
        key: `contact.${contactToken}.context.${keySuffix}`,
        value: sentence,
        sensitive: false,
        sourceTaskId,
        source: "user_input_pattern.contact_context",
        observedAt,
        confidence: toSentenceConfidence(sentence)
      });
      addedContextCount += 1;
      if (addedContextCount >= 3) {
        break;
      }
    }
  }

  return candidates;
}

/**
 * Derives named contact facts from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for named contact facts in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @param sourceTaskId - Stable identifier used to reference an entity or record.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Ordered collection produced by this step.
 */
function extractNamedContactFacts(
  text: string,
  sourceTaskId: string,
  observedAt: string
): ProfileFactUpsertInput[] {
  const candidates: ProfileFactUpsertInput[] = [];
  const detectedContacts = new Set<string>();
  const contactPatterns = [
    /\b(?:went\s+to\s+school\s+with\s+)?(?:a\s+|an\s+|the\s+)?(friend|guy|person|coworker|colleague|manager|neighbor|relative|teammate|classmate)\s+named\s+([A-Za-z][A-Za-z' -]{1,40})(?=(?:\s+and\b)|,|[.!?\n]|$)/gi,
    /\bmy\s+(friend|coworker|colleague|manager|neighbor|relative|teammate|classmate)\s+is\s+([A-Za-z][A-Za-z' -]{1,40})(?=(?:\s+and\b)|,|[.!?\n]|$)/gi
  ];

  for (const pattern of contactPatterns) {
    for (const match of text.matchAll(pattern)) {
      const descriptor = normalizeRelationshipDescriptor(match[1]);
      const displayName = trimTrailingClausePunctuation(match[2]);
      const contactToken = normalizeProfileKey(displayName);
      if (!contactToken) {
        continue;
      }
      detectedContacts.add(contactToken);

      candidates.push({
        key: `contact.${contactToken}.name`,
        value: displayName,
        sensitive: false,
        sourceTaskId,
        source: "user_input_pattern.named_contact",
        observedAt,
        confidence: toSentenceConfidence(match[0])
      });
      candidates.push({
        key: `contact.${contactToken}.relationship`,
        value: descriptor,
        sensitive: false,
        sourceTaskId,
        source: "user_input_pattern.named_contact",
        observedAt,
        confidence: toSentenceConfidence(match[0])
      });

      if (match[0].toLowerCase().includes("went to school with")) {
        candidates.push({
          key: `contact.${contactToken}.school_association`,
          value: "went_to_school_together",
          sensitive: false,
          sourceTaskId,
          source: "user_input_pattern.school_association",
          observedAt,
          confidence: toSentenceConfidence(match[0])
        });
      }
    }
  }

  const workPeerPattern =
    /\b(?:i|we)\s+(?:used\s+to\s+)?work(?:ed|s)?\s+with\s+([A-Za-z][A-Za-z' -]{1,40})(?:\s+(?:at|for)\s+([^.!?\n,]+?))?(?=(?:\s+and\b)|,|[.!?\n]|$)/gi;
  for (const match of text.matchAll(workPeerPattern)) {
    let displayName = trimTrailingClausePunctuation(match[1]);
    let company = trimTrailingClausePunctuation(match[2] ?? "");
    if (!company) {
      const inlineAssociationSplit = displayName.split(/\s+(?:at|for)\s+/i);
      if (inlineAssociationSplit.length > 1) {
        displayName = trimTrailingClausePunctuation(inlineAssociationSplit[0]);
        company = trimTrailingClausePunctuation(
          inlineAssociationSplit.slice(1).join(" ")
        );
      }
    }

    const contactToken = normalizeProfileKey(displayName);
    if (!contactToken) {
      continue;
    }
    detectedContacts.add(contactToken);

    candidates.push({
      key: `contact.${contactToken}.name`,
      value: displayName,
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.work_with_contact",
      observedAt,
      confidence: toSentenceConfidence(match[0])
    });
    candidates.push({
      key: `contact.${contactToken}.relationship`,
      value: "work_peer",
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.work_with_contact",
      observedAt,
      confidence: toSentenceConfidence(match[0])
    });

    if (company) {
      candidates.push({
        key: `contact.${contactToken}.work_association`,
        value: company,
        sensitive: false,
        sourceTaskId,
        source: "user_input_pattern.work_with_contact",
        observedAt,
        confidence: toSentenceConfidence(match[0])
      });
    }
  }

  if (detectedContacts.size === 1) {
    const [contactToken] = [...detectedContacts];
    const workAssociationPattern =
      /\b(?:used\s+to\s+)?work(?:ed|s)?\s+with\s+me\s+(?:at|for)\s+([^.!?\n,]+?)(?=(?:\s+and\b)|,|[.!?\n]|$)/i;
    const workAssociationMatch = workAssociationPattern.exec(text);
    if (workAssociationMatch) {
      candidates.push({
        key: `contact.${contactToken}.relationship`,
        value: "work_peer",
        sensitive: false,
        sourceTaskId,
        source: "user_input_pattern.work_association",
        observedAt,
        confidence: toSentenceConfidence(workAssociationMatch[0])
      });
      candidates.push({
        key: `contact.${contactToken}.work_association`,
        value: trimTrailingClausePunctuation(workAssociationMatch[1]),
        sensitive: false,
        sourceTaskId,
        source: "user_input_pattern.work_association",
        observedAt,
        confidence: toSentenceConfidence(workAssociationMatch[0])
      });
    }
  }

  const inferredContactTokens = extractContextInferredContactTokens(text);
  for (const inferredToken of inferredContactTokens) {
    detectedContacts.add(inferredToken);
    candidates.push({
      key: `contact.${inferredToken}.name`,
      value: displayNameFromContactToken(inferredToken),
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.contact_entity_hint",
      observedAt,
      confidence: 0.75
    });
  }

  const contextFacts = extractContactContextFacts(
    text,
    detectedContacts,
    sourceTaskId,
    observedAt
  );
  for (const contextFact of contextFacts) {
    candidates.push(contextFact);
  }

  return candidates;
}

/**
 * Evaluates sensitive key and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the sensitive key policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param key - Lookup key or map field identifier.
 * @returns `true` when this check passes.
 */
export function isSensitiveKey(key: string): boolean {
  const normalized = canonicalizeProfileKey(key);
  return SENSITIVE_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

/**
 * Implements planning context priority behavior used by `profileMemory`.
 *
 * **Why it exists:**
 * Keeps `planning context priority` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param key - Lookup key or map field identifier.
 * @returns Computed numeric value.
 */
function planningContextPriority(key: string): number {
  const normalized = canonicalizeProfileKey(key);
  const priority = PLANNING_CONTEXT_PRIORITY_PREFIXES.findIndex(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix}.`)
  );
  return priority >= 0 ? priority : PLANNING_CONTEXT_PRIORITY_PREFIXES.length;
}

/**
 * Converts values into profile fact status form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for profile fact status deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param confidence - Stable identifier used to reference an entity or record.
 * @returns Computed `ProfileFactStatus` result.
 */
function toProfileFactStatus(confidence: number): ProfileFactStatus {
  return confidence >= 0.75 ? "confirmed" : "uncertain";
}

/**
 * Evaluates active fact and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the active fact policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param fact - Value for fact.
 * @returns `true` when this check passes.
 */
function isActiveFact(fact: ProfileFactRecord): boolean {
  return fact.status !== "superseded" && fact.supersededAt === null;
}

/**
 * Implements key and value match behavior used by `profileMemory`.
 *
 * **Why it exists:**
 * Keeps `key and value match` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param fact - Value for fact.
 * @param key - Lookup key or map field identifier.
 * @param value - Primary value processed by this function.
 * @returns `true` when this check passes.
 */
function keyAndValueMatch(
  fact: ProfileFactRecord,
  key: string,
  value: string
): boolean {
  return fact.key === key && normalizeProfileValue(fact.value) === value;
}

/**
 * Applies deterministic validity checks for upsert input.
 *
 * **Why it exists:**
 * Fails fast when upsert input is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 */
function assertUpsertInput(input: ProfileFactUpsertInput): void {
  if (normalizeProfileKey(input.key).length === 0) {
    throw new Error("Profile fact key cannot be empty.");
  }
  if (normalizeProfileValue(input.value).length === 0) {
    throw new Error("Profile fact value cannot be empty.");
  }
  if (input.sourceTaskId.trim().length === 0) {
    throw new Error("Profile fact sourceTaskId cannot be empty.");
  }
  if (input.source.trim().length === 0) {
    throw new Error("Profile fact source cannot be empty.");
  }
}

/**
 * Upserts one temporal profile fact and supersedes conflicting active facts on the same key.
 *
 * **Why it exists:**
 * Profile continuity depends on deterministic fact lifecycle rules: refresh matching active facts,
 * supersede stale/conflicting values, and emit one normalized record for the caller to persist.
 *
 * **What it talks to:**
 * - Uses `makeId` (import `makeId`) from `./ids`.
 *
 * @param state - Current profile state snapshot.
 * @param input - Validated profile fact candidate to apply.
 * @returns Next-state payload, chosen/upserted fact, and superseded fact IDs.
 */
export function upsertTemporalProfileFact(
  state: ProfileMemoryState,
  input: ProfileFactUpsertInput
): ProfileUpsertResult {
  assertUpsertInput(input);
  const key = canonicalizeProfileKey(input.key);
  const value = normalizeProfileValue(input.value);
  const confidence = normalizeConfidence(input.confidence);
  const observedAt = safeIsoOrNow(input.observedAt);
  const nowIso = new Date().toISOString();
  const status = toProfileFactStatus(confidence);

  const nextFacts: ProfileFactRecord[] = [];
  const supersededFactIds: string[] = [];
  let refreshedFact: ProfileFactRecord | null = null;

  for (const fact of state.facts) {
    if (!isActiveFact(fact) || fact.key !== key) {
      nextFacts.push(fact);
      continue;
    }

    if (keyAndValueMatch(fact, key, value)) {
      refreshedFact = {
        ...fact,
        status:
          fact.status === "confirmed" && status === "uncertain"
            ? "confirmed"
            : status,
        confidence: Math.max(fact.confidence, confidence),
        confirmedAt:
          status === "confirmed"
            ? fact.confirmedAt ?? nowIso
            : fact.confirmedAt,
        lastUpdatedAt: nowIso,
        mutationAudit: input.mutationAudit ?? fact.mutationAudit
      };
      nextFacts.push(refreshedFact);
      continue;
    }

    supersededFactIds.push(fact.id);
    nextFacts.push({
      ...fact,
      status: "superseded",
      supersededAt: nowIso,
      lastUpdatedAt: nowIso
    });
  }

  const upsertedFact =
    refreshedFact ??
    {
      id: makeId("profile_fact"),
      key,
      value,
      sensitive: input.sensitive,
      status,
      confidence,
      sourceTaskId: input.sourceTaskId,
      source: input.source,
      observedAt,
      confirmedAt: status === "confirmed" ? nowIso : null,
      supersededAt: null,
      lastUpdatedAt: nowIso,
      mutationAudit: input.mutationAudit ?? undefined
    };

  if (!refreshedFact) {
    nextFacts.push(upsertedFact);
  }

  return {
    nextState: {
      schemaVersion: PROFILE_MEMORY_SCHEMA_VERSION,
      updatedAt: nowIso,
      facts: nextFacts
    },
    upsertedFact,
    supersededFactIds
  };
}

/**
 * Computes freshness/staleness for one profile fact relative to a reference time.
 *
 * **Why it exists:**
 * Temporal profile memory needs deterministic age checks to downgrade stale confirmed facts and
 * drive pulse continuity behavior.
 *
 * **What it talks to:**
 * - Local timestamp arithmetic only.
 *
 * @param fact - Fact record to evaluate.
 * @param maxAgeDays - Maximum allowed age before the fact is considered stale.
 * @param nowIso - Reference timestamp for age calculation.
 * @returns Staleness flag plus computed age in whole days.
 */
export function assessProfileFactFreshness(
  fact: ProfileFactRecord,
  maxAgeDays: number,
  nowIso: string = new Date().toISOString()
): ProfileFreshnessAssessment {
  const observed = Date.parse(fact.observedAt);
  const now = Date.parse(nowIso);
  const ageDays = Math.max(0, Math.floor((now - observed) / 86_400_000));
  return {
    stale: ageDays > Math.max(0, maxAgeDays),
    ageDays
  };
}

/**
 * Downgrades stale confirmed facts to uncertain status.
 *
 * **Why it exists:**
 * Facts that age out should not remain fully trusted. This pass preserves the record but lowers
 * confidence/status so downstream planning and pulse decisions handle drift safely.
 *
 * **What it talks to:**
 * - Calls `isActiveFact` and `assessProfileFactFreshness`.
 *
 * @param state - Current profile state.
 * @param maxAgeDays - Staleness threshold in days.
 * @param nowIso - Reference timestamp for freshness checks.
 * @returns Updated state and IDs of facts that were downgraded.
 */
export function markStaleFactsAsUncertain(
  state: ProfileMemoryState,
  maxAgeDays: number,
  nowIso: string = new Date().toISOString()
): { nextState: ProfileMemoryState; updatedFactIds: string[] } {
  const updatedFactIds: string[] = [];
  const nextFacts = state.facts.map((fact): ProfileFactRecord => {
    if (!isActiveFact(fact) || fact.status !== "confirmed") {
      return fact;
    }
    const freshness = assessProfileFactFreshness(fact, maxAgeDays, nowIso);
    if (!freshness.stale) {
      return fact;
    }
    updatedFactIds.push(fact.id);
    return {
      ...fact,
      status: "uncertain",
      confidence: Math.min(fact.confidence, 0.5),
      lastUpdatedAt: nowIso
    };
  });

  if (updatedFactIds.length === 0) {
    return {
      nextState: state,
      updatedFactIds
    };
  }

  return {
    nextState: {
      schemaVersion: PROFILE_MEMORY_SCHEMA_VERSION,
      updatedAt: nowIso,
      facts: nextFacts
    },
    updatedFactIds
  };
}

/**
 * Converts values into sentence confidence form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for sentence confidence deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @returns Computed numeric value.
 */
function toSentenceConfidence(text: string): number {
  const normalized = text.toLowerCase();
  const hedged = HEDGED_CONFIDENCE_PATTERNS.some((pattern) =>
    normalized.includes(pattern)
  );
  return hedged ? 0.6 : 0.95;
}

/**
 * Extracts deterministic profile-fact candidates from raw user text.
 *
 * **Why it exists:**
 * Agent Friend memory ingestion should capture stable personal context (identity, preferences,
 * contact relationships, and resolved follow-up markers) without relying on nondeterministic model
 * extraction for these baseline patterns.
 *
 * **What it talks to:**
 * - Uses local regex extractors and normalization helpers in this module.
 *
 * @param userInput - Raw user utterance or wrapped execution input text.
 * @param sourceTaskId - Task id used for traceability on extracted facts.
 * @param observedAt - Observation timestamp applied to extracted candidates.
 * @returns Deduplicated fact candidates ready for upsert/reconciliation.
 */
export function extractProfileFactCandidatesFromUserInput(
  userInput: string,
  sourceTaskId: string,
  observedAt: string
): ProfileFactUpsertInput[] {
  const candidates: ProfileFactUpsertInput[] = [];
  const seen = new Set<string>();
  const text = userInput.trim();
  if (!text) {
    return candidates;
  }

  /**
   * Validates and de-duplicates one extracted fact candidate before enqueueing it.
   *
   * **Why it exists:**
   * Pattern extractors can emit overlapping matches; this keeps candidate output stable and avoids
   * duplicate upserts for the same normalized key/value pair.
   *
   * **What it talks to:**
   * - Calls `canonicalizeProfileKey` and `normalizeProfileValue`.
   * - Calls `isSensitiveKey` for final sensitivity tagging.
   *
   * @param candidate - Candidate fact from one extractor pattern.
   */
  const maybeAddCandidate = (candidate: ProfileFactUpsertInput): void => {
    const normalizedKey = canonicalizeProfileKey(candidate.key);
    const normalizedValue = normalizeProfileValue(candidate.value);
    if (!normalizedKey || !normalizedValue) {
      return;
    }
    const signature = `${normalizedKey}=${normalizedValue}`;
    if (seen.has(signature)) {
      return;
    }
    seen.add(signature);
    candidates.push({
      ...candidate,
      key: normalizedKey,
      value: normalizedValue,
      sensitive: candidate.sensitive || isSensitiveKey(normalizedKey)
    });
  };

  const namedContactFacts = extractNamedContactFacts(text, sourceTaskId, observedAt);
  for (const namedContactFact of namedContactFacts) {
    maybeAddCandidate(namedContactFact);
  }

  const resolvedFollowupFacts = extractResolvedFollowupFacts(
    text,
    sourceTaskId,
    observedAt
  );
  for (const resolvedFollowupFact of resolvedFollowupFacts) {
    maybeAddCandidate(resolvedFollowupFact);
  }

  const namePattern =
    /\bmy\s+name\s+(?:is|was|=)\s+([^.!?\n]+?)(?=(?:\s+and\b)|[.!?\n]|$)/i;
  const nameMatch = namePattern.exec(text);
  if (nameMatch) {
    maybeAddCandidate({
      key: "identity.preferred_name",
      value: trimTrailingClausePunctuation(nameMatch[1]),
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.name_phrase",
      observedAt,
      confidence: toSentenceConfidence(nameMatch[0])
    });
  }

  const callMePattern =
    /\b(?:you\s+can\s+)?call\s+me\s+([^.!?\n]+?)(?=(?:\s+and\b)|[.!?\n]|$)/i;
  const callMeMatch = callMePattern.exec(text);
  if (callMeMatch) {
    maybeAddCandidate({
      key: "identity.preferred_name",
      value: trimTrailingClausePunctuation(callMeMatch[1]),
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.call_me",
      observedAt,
      confidence: toSentenceConfidence(callMeMatch[0])
    });
  }

  const goByPattern =
    /\bi\s+go\s+by\s+([^.!?\n]+?)(?=(?:\s+and\b)|[.!?\n]|$)/i;
  const goByMatch = goByPattern.exec(text);
  if (goByMatch) {
    maybeAddCandidate({
      key: "identity.preferred_name",
      value: trimTrailingClausePunctuation(goByMatch[1]),
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.go_by",
      observedAt,
      confidence: toSentenceConfidence(goByMatch[0])
    });
  }

  const myFactPattern =
    /\bmy\s+([a-z][a-z0-9 _.'/-]{1,80}?)\s+is\s+([^.!?\n]+?)(?=(?:\s+and\s+my\s+[a-z])|[.!?\n]|$)/gi;
  for (const match of text.matchAll(myFactPattern)) {
    const rawKey = match[1];
    const value = match[2];
    const key = normalizeProfileKey(rawKey);
    maybeAddCandidate({
      key,
      value,
      sensitive: isSensitiveKey(key),
      sourceTaskId,
      source: "user_input_pattern.my_is",
      observedAt,
      confidence: toSentenceConfidence(match[0])
    });
  }

  const workPattern =
    /\bi\s+work\s+(?:at|for)\s+([^.!?\n]+?)(?=(?:\s+and\b)|[.!?\n]|$)/i;
  const workMatch = workPattern.exec(text);
  if (workMatch) {
    maybeAddCandidate({
      key: "employment.current",
      value: workMatch[1],
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.work_at",
      observedAt,
      confidence: toSentenceConfidence(workMatch[0])
    });
  }

  const jobPattern =
    /\bmy\s+(?:new\s+)?job\s+is\s+([^.!?\n]+?)(?=(?:\s+and\b)|[.!?\n]|$)/i;
  const jobMatch = jobPattern.exec(text);
  if (jobMatch) {
    maybeAddCandidate({
      key: "employment.current",
      value: jobMatch[1],
      sensitive: false,
      sourceTaskId,
      source: "user_input_pattern.job_is",
      observedAt,
      confidence: toSentenceConfidence(jobMatch[0])
    });
  }

  const residencePattern =
    /\bi\s+(?:live in|moved to)\s+([^.!?\n]+?)(?=(?:\s+and\b)|[.!?\n]|$)/i;
  const residenceMatch = residencePattern.exec(text);
  if (residenceMatch) {
    maybeAddCandidate({
      key: "residence.current",
      value: residenceMatch[1],
      sensitive: true,
      sourceTaskId,
      source: "user_input_pattern.residence",
      observedAt,
      confidence: toSentenceConfidence(residenceMatch[0])
    });
  }

  return candidates;
}

/**
 * Renders a bounded, non-sensitive profile context block for planner prompts.
 *
 * **Why it exists:**
 * Planning should reuse stable user context, but only active non-sensitive facts and with a fixed
 * ordering policy to keep prompt behavior deterministic and privacy-bounded.
 *
 * **What it talks to:**
 * - Uses fact-status/key-priority helpers in this module.
 *
 * @param state - Current normalized profile state.
 * @param maxFacts - Maximum number of facts to include.
 * @returns Multi-line bullet block or empty string when no eligible facts exist.
 */
export function buildPlanningContextFromProfile(
  state: ProfileMemoryState,
  maxFacts: number
): string {
  const activeFacts = state.facts
    .filter((fact) => isActiveFact(fact) && !fact.sensitive)
    .sort((left, right) => {
      const leftPriority = planningContextPriority(left.key);
      const rightPriority = planningContextPriority(right.key);
      if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
      }
      return Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt);
    })
    .slice(0, Math.max(0, maxFacts));

  if (activeFacts.length === 0) {
    return "";
  }

  return activeFacts
    .map(
      (fact) =>
        `- ${fact.key}: ${fact.value} (status=${fact.status}, observedAt=${fact.observedAt})`
    )
    .join("\n");
}

/**
 * Normalizes profile mutation audit metadata into a stable shape for `profileMemory` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for profile mutation audit metadata so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param raw - Value for raw.
 * @returns Computed `ProfileMutationAuditMetadataV1 | null` result.
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

/**
 * Normalizes unknown persisted payloads into a valid `ProfileMemoryState`.
 *
 * **Why it exists:**
 * Encrypted/profile storage can contain legacy or malformed data; this guard fail-safes into the
 * canonical schema and strips invalid records instead of leaking bad state to runtime logic.
 *
 * **What it talks to:**
 * - Uses `createEmptyProfileMemoryState`, `safeIsoOrNow`, and mutation-audit normalization helpers.
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
