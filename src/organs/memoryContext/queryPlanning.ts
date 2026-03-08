/**
 * @fileoverview Deterministic current-request extraction, probing assessment, and domain-boundary scoring for memory brokerage.
 */

import { createHash } from "node:crypto";

import type {
  DomainBoundaryAssessment, DomainLaneScores, MemoryDomainLane, ProbingDetectorConfig,
  ProbingRegistrationResult, ProbingSignalSnapshot
} from "./contracts";

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

/** Normalizes a positive integer option with fallback and upper bound. */
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

/** Normalizes a ratio option into the unit interval. */
function toUnitInterval(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, Number(value)));
}

/** Hashes one query string for deterministic probing-window storage. */
function hashQueryForProbing(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

/** Counts non-empty whitespace-delimited words in a query. */
function countQueryWords(value: string): number {
  return value
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0).length;
}

/** Creates the zeroed lane-score structure used during domain-boundary assessment. */
function createEmptyDomainLaneScores(): DomainLaneScores {
  return {
    profile: 0,
    relationship: 0,
    workflow: 0,
    system_policy: 0,
    unknown: 0
  };
}

/** Adds a non-negative delta to one scored domain lane. */
function addLaneScore(
  scores: DomainLaneScores,
  lane: Exclude<MemoryDomainLane, "unknown">,
  delta: number
): void {
  scores[lane] = Math.max(0, scores[lane] + Math.max(0, delta));
}

/** Returns the first non-empty trimmed line from a wrapped prompt. */
function extractFirstNonEmptyLine(value: string): string {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ?? "";
}

/** Detects whether a prompt contains the known structured scaffold markers. */
function containsStructuredPromptScaffold(value: string): boolean {
  const normalized = value.toLowerCase();
  return STRUCTURED_PROMPT_SCAFFOLD_HINTS.some((hint) => normalized.includes(hint));
}

/** Scores domain lanes from the active user request alone. */
function inferDomainLaneScoresFromRequest(currentUserRequest: string): DomainLaneScores {
  const normalized = currentUserRequest.toLowerCase();
  const scores = createEmptyDomainLaneScores();

  if (/\b(my|i|me|mine|myself)\b/.test(normalized)) {
    addLaneScore(scores, "profile", 2);
  }

  if (
    /\b(friend|coworker|colleague|manager|neighbor|relative|teammate|contact|relationship)\b/.test(
      normalized
    ) ||
    /\bwho is\b/.test(normalized) ||
    /\b(he|she|they)\b/.test(normalized)
  ) {
    addLaneScore(scores, "relationship", 3);
  }

  if (
    /\b(name|called|call me|i go by|favorite|prefer|birthday|age|live|moved|job|work at)\b/.test(
      normalized
    )
  ) {
    addLaneScore(scores, "profile", 2);
  }

  if (
    /\b(workflow|deploy|deployment|script|build|task|project|workspace|repo|code)\b/.test(
      normalized
    )
  ) {
    addLaneScore(scores, "workflow", 3);
  }

  if (
    /\b(governor|policy|safety|constraint|allowlist|approval|compliance)\b/.test(normalized)
  ) {
    addLaneScore(scores, "system_policy", 3);
  }

  return scores;
}

/** Adds lane signals inferred from the rendered profile-context payload. */
function applyProfileContextLaneSignals(
  baseScores: DomainLaneScores,
  profileContext: string
): DomainLaneScores {
  const scores: DomainLaneScores = { ...baseScores };
  const lines = profileContext
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    if (line.startsWith("contact.") || line.includes(".relationship:")) {
      addLaneScore(scores, "relationship", 1);
    }
    if (
      line.startsWith("identity.") ||
      line.startsWith("employment.") ||
      line.startsWith("residence.") ||
      line.startsWith("location.")
    ) {
      addLaneScore(scores, "profile", 1);
    }
    if (line.startsWith("workflow.") || line.startsWith("project.") || line.startsWith("task.")) {
      addLaneScore(scores, "workflow", 1);
    }
    if (line.startsWith("policy.") || line.includes("governor") || line.includes("constraint")) {
      addLaneScore(scores, "system_policy", 1);
    }
  }

  return scores;
}

/** Orders the dominant domain lanes from a scored boundary assessment. */
function selectDomainLanes(scores: DomainLaneScores): MemoryDomainLane[] {
  const laneOrder: MemoryDomainLane[] = ["profile", "relationship", "workflow", "system_policy"];
  const positiveLanes = laneOrder
    .filter((lane) => scores[lane] > 0)
    .sort((left, right) => {
      if (scores[left] === scores[right]) {
        return laneOrder.indexOf(left) - laneOrder.indexOf(right);
      }
      return scores[right] - scores[left];
    });

  if (positiveLanes.length === 0) {
    return ["unknown"];
  }

  return positiveLanes;
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
    if (containsStructuredPromptScaffold(normalized)) {
      const firstLine = extractFirstNonEmptyLine(normalized);
      return firstLine || normalized;
    }
    return normalized;
  }

  const extracted = normalized.slice(markerIndex + CURRENT_USER_REQUEST_MARKER.length).trim();
  return extracted || normalized;
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

/**
 * Assesses whether profile context should be injected or suppressed for the current request.
 *
 * @param currentUserRequest - Active user request used for lane scoring.
 * @param profileContext - Sanitized profile-context payload, if available.
 * @returns Deterministic lane scores plus the inject/suppress decision.
 */
export function assessDomainBoundary(
  currentUserRequest: string,
  profileContext: string
): DomainBoundaryAssessment {
  const requestScores = inferDomainLaneScoresFromRequest(currentUserRequest);
  const scores = applyProfileContextLaneSignals(requestScores, profileContext);
  const lanes = selectDomainLanes(scores);
  const profileSignal = scores.profile + scores.relationship;
  const nonProfileSignal = scores.workflow + scores.system_policy;
  if (profileSignal <= 0) {
    return {
      lanes,
      scores,
      decision: "suppress_profile_context",
      reason: "no_profile_signal"
    };
  }

  if (nonProfileSignal - profileSignal >= 3) {
    return {
      lanes,
      scores,
      decision: "suppress_profile_context",
      reason: "non_profile_dominant_request"
    };
  }

  return {
    lanes,
    scores,
    decision: "inject_profile_context",
    reason:
      nonProfileSignal > 0
        ? "cross_domain_allowed_with_profile_signal"
        : "profile_context_relevant"
  };
}
