/**
 * @fileoverview Shared contracts and normalization helpers for the canonical Stage 6.86 pulse-candidate subsystem.
 */

import type { SourceAuthority } from "../sourceAuthority";
import {
  ConversationStackV1,
  EntityNodeV1,
  PulseDecisionV1,
  PulseProvenanceTierV1,
  PulseReasonCodeV1
} from "../types";

const MAX_REASONABLE_COUNT = 32;
const MAX_REASONABLE_MINUTES = 24 * 60 * 7;
const MAX_REASONABLE_DAYS = 365;

const PRIVACY_SENSITIVE_KEYWORDS = new Set([
  "health",
  "medical",
  "diagnosis",
  "therapy",
  "salary",
  "bank",
  "debt",
  "court",
  "legal",
  "immigration",
  "address",
  "phone",
  "password",
  "secret"
]);

const PRIVACY_SENSITIVE_ENTITY_TYPES = new Set(["person", "event"]);

export type PulseResponseOutcome = "engaged" | "ignored" | "dismissed" | null;

export interface PulseEmissionRecordV1 {
  emittedAt: string;
  reasonCode: PulseReasonCodeV1;
  candidateEntityRefs: readonly string[];
  responseOutcome?: PulseResponseOutcome;
  generatedSnippet?: string;
}

export interface EvaluatePulseCandidatesOptionsV1 {
  pulseMaxPerDay?: number;
  pulseMinIntervalMinutes?: number;
  pulseMaxOpenLoopsSurfaced?: number;
  coMentionThreshold?: number;
  coMentionWindowDays?: number;
  bridgeCooldownDays?: number;
  openLoopStaleDays?: number;
  staleFactRevalidationDays?: number;
  entitySalienceThreshold?: number;
}

export interface EvaluatePulseCandidatesInputV1 {
  graph: import("../types").EntityGraphV1;
  stack: ConversationStackV1;
  observedAt: string;
  recentPulseHistory?: readonly PulseEmissionRecordV1[];
  activeMissionWorkExists?: boolean;
  privacyOptOutEntityKeys?: readonly string[];
}

export interface PulseCandidateDecisionV1 {
  candidate: import("../types").PulseCandidateV1;
  decision: PulseDecisionV1;
}

export interface EvaluatePulseCandidatesResultV1 {
  orderedCandidates: readonly import("../types").PulseCandidateV1[];
  decisions: readonly PulseCandidateDecisionV1[];
  emittedCandidate: import("../types").PulseCandidateV1 | null;
}

export interface PulseCandidateDraftV1 {
  reasonCode: PulseReasonCodeV1;
  lastTouchedAt: string;
  threadKey: string | null;
  entityRefs: readonly string[];
  evidenceRefs: readonly string[];
  sourceAuthority: SourceAuthority;
  provenanceTier: PulseProvenanceTierV1;
  sensitive: boolean;
  scoreBreakdown: {
    recency: number;
    frequency: number;
    unresolvedImportance: number;
    sensitivityPenalty: number;
    cooldownPenalty: number;
  };
}

/**
 * Applies deterministic validity checks for valid iso timestamp.
 *
 * **Why it exists:**
 * Fails fast when valid iso timestamp is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fieldName - Value for field name.
 */
export function assertValidIsoTimestamp(value: string, fieldName: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ISO timestamp for ${fieldName}: ${value}`);
  }
}

/**
 * Normalizes whitespace into a stable shape for `stage6_86PulseCandidates` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for whitespace so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Normalizes string array into a stable shape for `stage6_86PulseCandidates` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for string array so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param values - Value for values.
 * @returns Ordered collection produced by this step.
 */
export function normalizeStringArray(values: readonly string[] | undefined): readonly string[] {
  if (!values) {
    return [];
  }
  const normalized = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const cleaned = normalizeWhitespace(value);
    if (!cleaned) {
      continue;
    }
    normalized.add(cleaned);
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

/**
 * Constrains and sanitizes ratio to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for ratio before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed numeric value.
 */
export function clampRatio(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Number(Math.min(1, Math.max(0, value)).toFixed(4));
}

/**
 * Constrains and sanitizes count to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for count before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns Computed numeric value.
 */
export function clampCount(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return fallback;
  }
  const parsed = Math.floor(value as number);
  return Math.max(1, Math.min(MAX_REASONABLE_COUNT, parsed));
}

/**
 * Constrains and sanitizes minutes to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for minutes before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns Computed numeric value.
 */
export function clampMinutes(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return fallback;
  }
  const parsed = Math.floor(value as number);
  return Math.max(1, Math.min(MAX_REASONABLE_MINUTES, parsed));
}

/**
 * Constrains and sanitizes days to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for days before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns Computed numeric value.
 */
export function clampDays(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return fallback;
  }
  const parsed = Math.floor(value as number);
  return Math.max(1, Math.min(MAX_REASONABLE_DAYS, parsed));
}

/**
 * Calculates days between for deterministic time-based decisions.
 *
 * **Why it exists:**
 * Keeps `days between` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param earlierIso - Timestamp used for ordering, timeout, or recency decisions.
 * @param laterIso - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed numeric value.
 */
export function daysBetween(earlierIso: string, laterIso: string): number {
  return Math.max(0, (Date.parse(laterIso) - Date.parse(earlierIso)) / (24 * 60 * 60 * 1_000));
}

/**
 * Derives recency signal from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for recency signal in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param lastTouchedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed numeric value.
 */
export function computeRecencySignal(lastTouchedAt: string, observedAt: string): number {
  const ageDays = daysBetween(lastTouchedAt, observedAt);
  const decay = Math.pow(0.5, ageDays / 30);
  return clampRatio(decay);
}

/**
 * Derives staleness signal from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for staleness signal in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param lastTouchedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @param staleDays - Value for stale days.
 * @returns Computed numeric value.
 */
export function computeStalenessSignal(
  lastTouchedAt: string,
  observedAt: string,
  staleDays: number
): number {
  const ageDays = daysBetween(lastTouchedAt, observedAt);
  if (ageDays <= staleDays) {
    return 0;
  }
  return clampRatio((ageDays - staleDays) / staleDays);
}

/**
 * Checks whether privacy keyword contains the required signal.
 *
 * **Why it exists:**
 * Makes privacy keyword containment checks explicit so threshold behavior is easy to audit.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns `true` when this check passes.
 */
export function containsPrivacyKeyword(value: string): boolean {
  const normalized = normalizeWhitespace(value).toLowerCase();
  if (!normalized) {
    return false;
  }
  for (const keyword of PRIVACY_SENSITIVE_KEYWORDS) {
    if (normalized.includes(keyword)) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates entity privacy sensitive and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the entity privacy sensitive policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `EntityNodeV1` (import `EntityNodeV1`) from `../types`.
 *
 * @param entity - Value for entity.
 * @param optOutKeys - Lookup key or map field identifier.
 * @returns `true` when this check passes.
 */
export function isEntityPrivacySensitive(
  entity: EntityNodeV1,
  optOutKeys: ReadonlySet<string>
): boolean {
  if (optOutKeys.has(entity.entityKey)) {
    return true;
  }
  if (PRIVACY_SENSITIVE_ENTITY_TYPES.has(entity.entityType)) {
    return true;
  }
  if (containsPrivacyKeyword(entity.canonicalName)) {
    return true;
  }
  return entity.aliases.some((alias) => containsPrivacyKeyword(alias));
}
