/**
 * @fileoverview Deterministic request extraction and probing assessment for memory brokerage.
 */

import { createHash } from "node:crypto";

import type {
  ProbingDetectorConfig,
  ProbingRegistrationResult,
  ProbingSignalSnapshot
} from "./contracts";
import { extractActiveRequestSegment } from "../../core/currentRequestExtraction";

const CURRENT_USER_REQUEST_MARKER = "Current user request:";
const STRUCTURED_PROMPT_SCAFFOLD_HINTS = [
  "recent conversation context (oldest to newest):",
  "system-generated agent pulse check-in request.",
  "agent pulse request:",
  "[agentfriendmemorybroker]",
  "[agentfriendprofilecontext]",
  "[agentfriendprofilestatus]"
] as const;
const PROBING_SENSITIVE_PATTERNS = [
  /\b(email|phone|address|dob|birthday|ssn|social[_\s-]?security)\b/i,
  /\b(api[_\s-]?key|token|password|secret)\b/i,
  /\b(bank|routing|credit|debit|card)\b/i
];
const PROBING_EXTRACTION_INTENT_PATTERNS = [
  /\b(show|dump|export|list|print|reveal)\b.*\b(memory|profile|details|data)\b/i,
  /\b(all|every)\b.*\b(memory|detail|fact|record)\b/i,
  /\bwho is\b/i,
  /\bwhat do you know about\b/i,
  /\btell me about\b/i
];
const DEFAULT_PROBING_WINDOW_SIZE = 10;
const DEFAULT_PROBING_MINIMUM_SAMPLE_SIZE = 5;
const DEFAULT_PROBING_MATCH_RATIO_THRESHOLD = 0.6;
const DEFAULT_PROBING_RAPID_SUCCESSION_WINDOW_MS = 45_000;
const DEFAULT_PROBING_SHORT_QUERY_MAX_CHARS = 72;
const DEFAULT_PROBING_SHORT_QUERY_MAX_WORDS = 14;
const MAX_PROBING_WINDOW_SIZE = 50;

/**
 * Normalizes a positive integer option with fallback and upper bound.
 *
 * @param value - Candidate numeric value.
 * @param fallback - Value used when the candidate is invalid.
 * @param max - Hard upper bound for the returned integer.
 * @returns Bounded positive integer.
 */
function toBoundedPositiveInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.trunc(value);
  if (normalized <= 0) {
    return fallback;
  }
  return Math.min(normalized, max);
}

/**
 * Normalizes a ratio option into the unit interval.
 *
 * @param value - Candidate ratio value.
 * @param fallback - Value used when the candidate is invalid.
 * @returns Ratio constrained to `[0, 1]`.
 */
function toUnitInterval(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, Number(value)));
}

/**
 * Hashes one query string for deterministic probing-window storage.
 *
 * @param value - Query text to hash.
 * @returns Stable lowercase SHA-256 digest.
 */
function hashQueryForProbing(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

/**
 * Counts non-empty whitespace-delimited words in a query.
 *
 * @param value - Raw query text.
 * @returns Word count.
 */
function countQueryWords(value: string): number {
  return value
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0).length;
}

/**
 * Returns the first non-empty trimmed line from a wrapped prompt.
 *
 * @param value - Candidate wrapped prompt.
 * @returns First non-empty line or an empty string.
 */
function extractFirstNonEmptyLine(value: string): string {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ?? "";
}

/**
 * Detects whether a prompt contains the known structured scaffold markers.
 *
 * @param value - Candidate wrapped prompt.
 * @returns `true` when the prompt matches the known scaffold.
 */
function containsStructuredPromptScaffold(value: string): boolean {
  const normalized = value.toLowerCase();
  return STRUCTURED_PROMPT_SCAFFOLD_HINTS.some((hint) => normalized.includes(hint));
}

/**
 * Extracts the active user request from wrapped planner input while avoiding history/profile leakage.
 *
 * @param userInput - Raw planner input or wrapped conversation payload.
 * @returns Current user request text suitable for downstream planner and broker logic.
 */
export function extractCurrentUserRequest(userInput: string): string {
  const normalized = userInput.trim();
  if (!normalized) {
    return "";
  }
  const markerIndex = normalized.toLowerCase().lastIndexOf(CURRENT_USER_REQUEST_MARKER.toLowerCase());
  if (markerIndex < 0) {
    const extractedActiveRequest = extractActiveRequestSegment(normalized);
    if (extractedActiveRequest !== normalized) {
      return extractedActiveRequest;
    }
    if (containsStructuredPromptScaffold(normalized)) {
      const firstLine = extractFirstNonEmptyLine(normalized);
      return firstLine || normalized;
    }
    return normalized;
  }

  return extractActiveRequestSegment(normalized) || normalized;
}

/**
 * Resolves deterministic probing-detector config with bounded numeric coercion.
 *
 * @param input - Optional probing-detector overrides.
 * @returns Normalized probing-detector config.
 */
export function resolveProbingDetectorConfig(
  input?: Partial<ProbingDetectorConfig>
): ProbingDetectorConfig {
  const windowSize = toBoundedPositiveInteger(
    input?.windowSize,
    DEFAULT_PROBING_WINDOW_SIZE,
    MAX_PROBING_WINDOW_SIZE
  );
  const minimumSampleSize = toBoundedPositiveInteger(
    input?.minimumSampleSize,
    DEFAULT_PROBING_MINIMUM_SAMPLE_SIZE,
    windowSize
  );
  return {
    windowSize,
    minimumSampleSize,
    matchRatioThreshold: toUnitInterval(
      input?.matchRatioThreshold,
      DEFAULT_PROBING_MATCH_RATIO_THRESHOLD
    ),
    rapidSuccessionWindowMs: toBoundedPositiveInteger(
      input?.rapidSuccessionWindowMs,
      DEFAULT_PROBING_RAPID_SUCCESSION_WINDOW_MS,
      300_000
    ),
    shortQueryMaxChars: toBoundedPositiveInteger(
      input?.shortQueryMaxChars,
      DEFAULT_PROBING_SHORT_QUERY_MAX_CHARS,
      256
    ),
    shortQueryMaxWords: toBoundedPositiveInteger(
      input?.shortQueryMaxWords,
      DEFAULT_PROBING_SHORT_QUERY_MAX_WORDS,
      128
    )
  };
}

/**
 * Registers one query into the probing window and returns the new deterministic assessment.
 *
 * @param query - Active user request under evaluation.
 * @param priorSignals - Existing sliding window of probing signals.
 * @param config - Normalized probing-detector config.
 * @param observedAtMs - Optional timestamp override for deterministic tests.
 * @returns Updated probing assessment plus the next retained signal window.
 */
export function registerAndAssessProbing(
  query: string,
  priorSignals: readonly ProbingSignalSnapshot[],
  config: ProbingDetectorConfig,
  observedAtMs = Date.now()
): ProbingRegistrationResult {
  const normalizedQuery = query.trim().toLowerCase();
  const priorSignal = priorSignals[priorSignals.length - 1];
  const wordCount = countQueryWords(normalizedQuery);
  const shortQuery =
    normalizedQuery.length > 0 &&
    (normalizedQuery.length <= config.shortQueryMaxChars || wordCount <= config.shortQueryMaxWords);
  const sensitivePatternOverlap = PROBING_SENSITIVE_PATTERNS.some((pattern) =>
    pattern.test(normalizedQuery)
  );
  const extractionIntent = PROBING_EXTRACTION_INTENT_PATTERNS.some((pattern) =>
    pattern.test(normalizedQuery)
  );
  const rapidSuccession =
    priorSignal !== undefined && observedAtMs - priorSignal.observedAtMs <= config.rapidSuccessionWindowMs;
  const probingSignatureMatched =
    sensitivePatternOverlap ||
    (shortQuery && extractionIntent) ||
    (shortQuery && rapidSuccession) ||
    (extractionIntent && rapidSuccession);

  const signal: ProbingSignalSnapshot = {
    queryHash: hashQueryForProbing(normalizedQuery),
    observedAtMs,
    shortQuery,
    sensitivePatternOverlap,
    extractionIntent,
    rapidSuccession,
    probingSignatureMatched
  };

  const nextSignals = [...priorSignals, signal].slice(-config.windowSize);
  const matchCount = nextSignals.filter((entry) => entry.probingSignatureMatched).length;
  const matchRatio = nextSignals.length === 0 ? 0 : matchCount / nextSignals.length;
  const detected =
    nextSignals.length >= config.minimumSampleSize && matchRatio > config.matchRatioThreshold;
  const matchedSignals: string[] = [];
  if (signal.shortQuery) {
    matchedSignals.push("short_query");
  }
  if (signal.sensitivePatternOverlap) {
    matchedSignals.push("sensitive_pattern_overlap");
  }
  if (signal.extractionIntent) {
    matchedSignals.push("extraction_intent");
  }
  if (signal.rapidSuccession) {
    matchedSignals.push("rapid_succession");
  }
  if (!signal.probingSignatureMatched) {
    matchedSignals.push("signature_not_matched");
  }

  return {
    assessment: {
      detected,
      matchRatio,
      matchCount,
      windowSize: nextSignals.length,
      matchedSignals
    },
    nextSignals
  };
}
