/**
 * @fileoverview Builds memory-aware planner input by brokering query-scoped profile context with deterministic safety guards.
 */

import { createHash } from "node:crypto";

import { ProfileMemoryStore } from "../core/profileMemoryStore";
import {
  MemoryAccessAuditStore,
  MemoryAccessDomainLane
} from "../core/memoryAccessAudit";
import { ProfileMemoryStatus, TaskRequest } from "../core/types";

const CURRENT_USER_REQUEST_MARKER = "Current user request:";
const STRUCTURED_PROMPT_SCAFFOLD_HINTS = [
  "recent conversation context (oldest to newest):",
  "system-generated agent pulse check-in request.",
  "agent pulse request:",
  "[agentfriendmemorybroker]",
  "[agentfriendprofilecontext]",
  "[agentfriendprofilestatus]"
];
const SENSITIVE_PROFILE_CONTEXT_PATTERNS = [
  /email/i,
  /phone/i,
  /address/i,
  /\bssn\b/i,
  /social[_\s-]?security/i,
  /birth(date|day)?|dob/i,
  /api[_\s-]?key/i,
  /token/i,
  /password|secret/i,
  /credit|debit|card|bank|routing/i
];
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

type MemoryDomainLane = "profile" | "relationship" | "workflow" | "system_policy" | "unknown";
type DomainBoundaryDecision = "inject_profile_context" | "suppress_profile_context";

interface ProbingDetectorConfig {
  windowSize: number;
  minimumSampleSize: number;
  matchRatioThreshold: number;
  rapidSuccessionWindowMs: number;
  shortQueryMaxChars: number;
  shortQueryMaxWords: number;
}

interface ProbingSignalSnapshot {
  queryHash: string;
  observedAtMs: number;
  shortQuery: boolean;
  sensitivePatternOverlap: boolean;
  extractionIntent: boolean;
  rapidSuccession: boolean;
  probingSignatureMatched: boolean;
}

interface ProbingAssessment {
  detected: boolean;
  matchRatio: number;
  matchCount: number;
  windowSize: number;
  matchedSignals: string[];
}

interface MemoryAccessAuditAppendOptions {
  eventType?: "retrieval" | "PROBING_DETECTED";
  probeSignals?: readonly string[];
  probeWindowSize?: number;
  probeMatchCount?: number;
  probeMatchRatio?: number;
}

interface DomainLaneScores {
  profile: number;
  relationship: number;
  workflow: number;
  system_policy: number;
  unknown: number;
}

interface DomainBoundaryAssessment {
  lanes: MemoryDomainLane[];
  scores: DomainLaneScores;
  decision: DomainBoundaryDecision;
  reason: string;
}

interface ProfileContextSanitizationResult {
  sanitizedContext: string;
  redactedFieldCount: number;
}

export interface MemoryBrokerInputResult {
  userInput: string;
  profileMemoryStatus: ProfileMemoryStatus;
}

export interface MemoryBrokerOptions {
  probingDetector?: Partial<ProbingDetectorConfig>;
}

/**
 * Checks whether a profile-context line contains sensitive-field indicators.
 *
 * **Why it exists:**
 * Ensures sensitive profile fields are consistently redacted before planner/model egress.
 *
 * **What it talks to:**
 * - Local `SENSITIVE_PROFILE_CONTEXT_PATTERNS` regex list.
 *
 * @param line - Single text line being parsed or transformed.
 * @returns `true` when this check/policy condition passes.
 */
function lineIndicatesSensitiveProfileField(line: string): boolean {
  return SENSITIVE_PROFILE_CONTEXT_PATTERNS.some((pattern) => pattern.test(line));
}

/**
 * Constrains and sanitizes profile context for model egress to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for profile context for model egress before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param profileContext - Filesystem location used by this operation.
 * @returns Computed `ProfileContextSanitizationResult` result.
 */
function sanitizeProfileContextForModelEgress(
  profileContext: string
): ProfileContextSanitizationResult {
  let redactedFieldCount = 0;
  const sanitizedLines = profileContext
    .split(/\r?\n/)
    .map((line) => {
      if (!lineIndicatesSensitiveProfileField(line)) {
        return line;
      }

      redactedFieldCount += 1;
      const separatorIndex = line.indexOf(":");
      if (separatorIndex <= 0) {
        return "[REDACTED_PROFILE_FIELD]";
      }

      const key = line.slice(0, separatorIndex).trim();
      return `${key}: [REDACTED]`;
    });

  return {
    sanitizedContext: sanitizedLines.join("\n"),
    redactedFieldCount
  };
}

/**
 * Converts values into bounded positive integer form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for bounded positive integers deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Fallback value used when input is invalid.
 * @param max - Maximum allowed value.
 * @returns Computed numeric value.
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
 * Converts values into unit interval number form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for unit interval number deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Fallback value used when input is invalid.
 * @returns Computed numeric value.
 */
function toUnitInterval(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, Number(value)));
}

/**
 * Resolves probing detector config from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of probing detector config by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `ProbingDetectorConfig` result.
 */
function resolveProbingDetectorConfig(
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
 * Computes a deterministic query hash for probing-window state.
 *
 * **Why it exists:**
 * Keeps `hash query for probing` behavior centralized so collaborating call sites stay consistent.
 *
 * **What it talks to:**
 * - Uses `createHash` (import `createHash`) from `node:crypto`.
 *
 * @param value - Primary input consumed by this function.
 * @returns Resulting string value.
 */
function hashQueryForProbing(value: string): string {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

/**
 * Counts query words for short-query heuristics.
 *
 * **Why it exists:**
 * Keeps word-count logic deterministic so probing heuristics remain auditable.
 *
 * **What it talks to:**
 * - Local whitespace tokenization.
 *
 * @param value - Primary input consumed by this function.
 * @returns Numeric result used by downstream logic.
 */
function countQueryWords(value: string): number {
  return value
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0).length;
}

/**
 * Builds empty domain lane scores for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of empty domain lane scores consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @returns Computed `DomainLaneScores` result.
 */
function createEmptyDomainLaneScores(): DomainLaneScores {
  return {
    profile: 0,
    relationship: 0,
    workflow: 0,
    system_policy: 0,
    unknown: 0
  };
}

/**
 * Implements add lane score behavior used by `memoryBroker`.
 *
 * **Why it exists:**
 * Keeps `add lane score` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param scores - Value for scores.
 * @param lane - Value for lane.
 * @param delta - Value for delta.
 */
function addLaneScore(
  scores: DomainLaneScores,
  lane: Exclude<MemoryDomainLane, "unknown">,
  delta: number
): void {
  scores[lane] = Math.max(0, scores[lane] + Math.max(0, delta));
}

/**
 * Derives first non empty line from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for first non empty line in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Local line splitting/trimming operations.
 *
 * @param value - Primary input consumed by this function.
 * @returns First non-empty line, or empty string when none exists.
 */
function extractFirstNonEmptyLine(value: string): string {
  const firstLine = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return firstLine ?? "";
}

/**
 * Checks whether structured prompt scaffold contains the required signal.
 *
 * **Why it exists:**
 * Makes structured prompt scaffold containment checks explicit so threshold behavior is easy to audit.
 *
 * **What it talks to:**
 * - Local scaffold markers in `STRUCTURED_PROMPT_SCAFFOLD_HINTS`.
 *
 * @param value - Primary input consumed by this function.
 * @returns `true` when this check/policy condition passes.
 */
function containsStructuredPromptScaffold(value: string): boolean {
  const normalized = value.toLowerCase();
  return STRUCTURED_PROMPT_SCAFFOLD_HINTS.some((hint) => normalized.includes(hint));
}

/**
 * Derives current user request from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for current user request in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param userInput - Structured input object for this operation.
 * @returns Resulting string value.
 */
export function extractCurrentUserRequest(userInput: string): string {
  const normalized = userInput.trim();
  if (!normalized) {
    return "";
  }

  const markerIndex = normalized
    .toLowerCase()
    .lastIndexOf(CURRENT_USER_REQUEST_MARKER.toLowerCase());
  if (markerIndex < 0) {
    if (containsStructuredPromptScaffold(normalized)) {
      // Structured prompts may include historical user text; only trust the leading instruction line.
      const firstLine = extractFirstNonEmptyLine(normalized);
      return firstLine || normalized;
    }
    return normalized;
  }

  const extracted = normalized
    .slice(markerIndex + CURRENT_USER_REQUEST_MARKER.length)
    .trim();
  return extracted || normalized;
}

/**
 * Derives domain lane scores from request from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for domain lane scores from request in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param currentUserRequest - Structured input object for this operation.
 * @returns Computed `DomainLaneScores` result.
 */
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

/**
 * Executes profile context lane signals as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the profile context lane signals runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param baseScores - Value for base scores.
 * @param profileContext - Filesystem location used by this operation.
 * @returns Computed `DomainLaneScores` result.
 */
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
    if (
      line.startsWith("workflow.") ||
      line.startsWith("project.") ||
      line.startsWith("task.")
    ) {
      addLaneScore(scores, "workflow", 1);
    }
    if (
      line.startsWith("policy.") ||
      line.includes("governor") ||
      line.includes("constraint")
    ) {
      addLaneScore(scores, "system_policy", 1);
    }
  }

  return scores;
}

/**
 * Resolves domain lanes from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of domain lanes by keeping rules in one function.
 *
 * **What it talks to:**
 * - Local lane ordering/tie-break rules.
 *
 * @param scores - Aggregated lane scores from request + profile context.
 * @returns Ordered collection produced by this step.
 */
function selectDomainLanes(scores: DomainLaneScores): MemoryDomainLane[] {
  const laneOrder: MemoryDomainLane[] = [
    "profile",
    "relationship",
    "workflow",
    "system_policy"
  ];
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
 * Implements assess domain boundary behavior used by `memoryBroker`.
 *
 * **Why it exists:**
 * Keeps `assess domain boundary` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param currentUserRequest - Structured input object for this operation.
 * @param profileContext - Filesystem location used by this operation.
 * @returns Computed `DomainBoundaryAssessment` result.
 */
function assessDomainBoundary(
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

/**
 * Transforms domain lane scores into a stable output representation.
 *
 * **Why it exists:**
 * Keeps `render domain lane scores` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Local string formatting for audit metadata.
 *
 * @param scores - Aggregated lane scores to serialize.
 * @returns Compact score string for broker metadata packets.
 */
function renderDomainLaneScores(scores: DomainLaneScores): string {
  return [
    `profile:${scores.profile}`,
    `relationship:${scores.relationship}`,
    `workflow:${scores.workflow}`,
    `system_policy:${scores.system_policy}`,
    `unknown:${scores.unknown}`
  ].join(",");
}

/**
 * Builds suppressed context packet for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of suppressed context packet consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `TaskRequest` (import `TaskRequest`) from `../core/types`.
 *
 * @param task - Original task request whose input is being augmented.
 * @param lanes - Dominant domain lanes derived by boundary assessment.
 * @param scores - Lane scores used to explain suppression behavior.
 * @param reason - Typed suppression reason code.
 * @returns Planner-input packet with explicit profile-context suppression metadata.
 */
function buildSuppressedContextPacket(
  task: TaskRequest,
  lanes: MemoryDomainLane[],
  scores: DomainLaneScores,
  reason: string
): string {
  return [
    task.userInput,
    "",
    "[AgentFriendMemoryBroker]",
    "retrievalMode=query_aware",
    `domainLanes=${lanes.join(",")}`,
    `domainLaneScores=${renderDomainLaneScores(scores)}`,
    "domainBoundaryDecision=suppress_profile_context",
    `domainBoundaryReason=${reason}`,
    "",
    "[AgentFriendProfileContext]",
    "suppressed=true"
  ].join("\n");
}

/**
 * Builds injected context packet for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of injected context packet consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `TaskRequest` (import `TaskRequest`) from `../core/types`.
 *
 * @param task - Value for task.
 * @param lanes - Value for lanes.
 * @param scores - Value for scores.
 * @param reason - Value for reason.
 * @param context - Message/text content processed by this function.
 * @returns Resulting string value.
 */
function buildInjectedContextPacket(
  task: TaskRequest,
  lanes: MemoryDomainLane[],
  scores: DomainLaneScores,
  reason: string,
  context: string
): string {
  return [
    task.userInput,
    "",
    "[AgentFriendMemoryBroker]",
    "retrievalMode=query_aware",
    `domainLanes=${lanes.join(",")}`,
    `domainLaneScores=${renderDomainLaneScores(scores)}`,
    "domainBoundaryDecision=inject_profile_context",
    `domainBoundaryReason=${reason}`,
    "",
    "[AgentFriendProfileContext]",
    context
  ].join("\n");
}

/**
 * Counts retrieved profile facts for downstream policy and scoring decisions.
 *
 * **Why it exists:**
 * Keeps `count retrieved profile facts` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Local line filtering rules for profile-context payloads.
 *
 * @param profileContext - Retrieved profile-context packet text.
 * @returns Numeric result used by downstream logic.
 */
function countRetrievedProfileFacts(profileContext: string): number {
  return profileContext
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("[")) // metadata headers
    .filter((line) => line.includes(":"))
    .length;
}

/**
 * Converts values into audit domain lanes form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for audit domain lanes deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses `MemoryAccessDomainLane` (import `MemoryAccessDomainLane`) from `../core/memoryAccessAudit`.
 *
 * @param lanes - Broker domain lanes to map into audit-store lane type.
 * @returns Ordered collection produced by this step.
 */
function toAuditDomainLanes(lanes: readonly MemoryDomainLane[]): MemoryAccessDomainLane[] {
  return lanes.map((lane) => lane as MemoryAccessDomainLane);
}

export class MemoryBrokerOrgan {
  private readonly probingDetectorConfig: ProbingDetectorConfig;
  private readonly recentProbeSignals: ProbingSignalSnapshot[] = [];

  /**
   * Initializes `MemoryBrokerOrgan` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
 * **What it talks to:**
 * - Uses `MemoryAccessAuditStore` (import `MemoryAccessAuditStore`) from `../core/memoryAccessAudit`.
 * - Uses `ProfileMemoryStore` (import `ProfileMemoryStore`) from `../core/profileMemoryStore`.
 *
 * @param profileMemoryStore - Optional profile-memory store dependency for ingestion/retrieval.
 * @param memoryAccessAuditStore - Append-only audit store for memory access traces.
 * @param options - Optional deterministic probing-detector tuning values.
 */
  constructor(
    private readonly profileMemoryStore?: ProfileMemoryStore,
    private readonly memoryAccessAuditStore = new MemoryAccessAuditStore(),
    options?: MemoryBrokerOptions
  ) {
    this.probingDetectorConfig = resolveProbingDetectorConfig(options?.probingDetector);
  }

  /**
   * Builds probing signal snapshot for this module's runtime flow.
   *
   * **Why it exists:**
   * Keeps construction of probing signal snapshot consistent across call sites.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param query - User request query used for retrieval.
   * @param observedAtMs - Timestamp used for ordering, timeout, or recency decisions.
   * @returns Computed `ProbingSignalSnapshot` result.
   */
  private buildProbingSignalSnapshot(
    query: string,
    observedAtMs: number
  ): ProbingSignalSnapshot {
    const normalizedQuery = query.trim().toLowerCase();
    const priorSignal = this.recentProbeSignals[this.recentProbeSignals.length - 1];
    const wordCount = countQueryWords(normalizedQuery);
    const shortQuery =
      normalizedQuery.length > 0 &&
      (normalizedQuery.length <= this.probingDetectorConfig.shortQueryMaxChars ||
        wordCount <= this.probingDetectorConfig.shortQueryMaxWords);
    const sensitivePatternOverlap = PROBING_SENSITIVE_PATTERNS.some((pattern) =>
      pattern.test(normalizedQuery)
    );
    const extractionIntent = PROBING_EXTRACTION_INTENT_PATTERNS.some((pattern) =>
      pattern.test(normalizedQuery)
    );
    const rapidSuccession =
      priorSignal !== undefined &&
      observedAtMs - priorSignal.observedAtMs <= this.probingDetectorConfig.rapidSuccessionWindowMs;
    const probingSignatureMatched =
      sensitivePatternOverlap ||
      (shortQuery && extractionIntent) ||
      (shortQuery && rapidSuccession) ||
      (extractionIntent && rapidSuccession);

    return {
      queryHash: hashQueryForProbing(normalizedQuery),
      observedAtMs,
      shortQuery,
      sensitivePatternOverlap,
      extractionIntent,
      rapidSuccession,
      probingSignatureMatched
    };
  }

  /**
   * Registers probing signal and returns deterministic window assessment.
   *
   * **Why it exists:**
   * Keeps sliding-window probing policy deterministic so suppression behavior is auditable.
   *
   * **What it talks to:**
   * - Uses local class state `recentProbeSignals`.
   *
   * @param query - User request query used for retrieval.
   * @returns Computed `ProbingAssessment` result.
   */
  private registerAndAssessProbing(query: string): ProbingAssessment {
    const signal = this.buildProbingSignalSnapshot(query, Date.now());
    this.recentProbeSignals.push(signal);
    if (this.recentProbeSignals.length > this.probingDetectorConfig.windowSize) {
      this.recentProbeSignals.splice(
        0,
        this.recentProbeSignals.length - this.probingDetectorConfig.windowSize
      );
    }

    const windowSignals = this.recentProbeSignals.slice(-this.probingDetectorConfig.windowSize);
    const matchCount = windowSignals.filter((entry) => entry.probingSignatureMatched).length;
    const matchRatio = windowSignals.length === 0 ? 0 : matchCount / windowSignals.length;
    const detected =
      windowSignals.length >= this.probingDetectorConfig.minimumSampleSize &&
      matchRatio > this.probingDetectorConfig.matchRatioThreshold;
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
      detected,
      matchRatio,
      matchCount,
      windowSize: windowSignals.length,
      matchedSignals
    };
  }

  /**
   * Persists memory access audit with deterministic state semantics.
   *
 * **Why it exists:**
 * Centralizes memory access audit mutations for auditability and replay.
 *
 * **What it talks to:**
 * - Uses `MemoryAccessAuditStore.appendEvent` through injected `memoryAccessAuditStore`.
 *
 * @param taskId - Stable identifier used to reference an entity or record.
 * @param query - User request query used for retrieval.
 * @param retrievedCount - Numeric bound, counter, or index used by this logic.
 * @param redactedCount - Numeric bound, counter, or index used by this logic.
 * @param lanes - Domain lanes attributed to this retrieval.
 * @param options - Optional typed event metadata for specialized audit records.
 * @returns Promise resolving to void.
 */
  private async appendMemoryAccessAudit(
    taskId: string,
    query: string,
    retrievedCount: number,
    redactedCount: number,
    lanes: readonly MemoryDomainLane[],
    options?: MemoryAccessAuditAppendOptions
  ): Promise<void> {
    try {
      await this.memoryAccessAuditStore.appendEvent({
        taskId,
        query,
        retrievedCount,
        redactedCount,
        domainLanes: toAuditDomainLanes(lanes),
        eventType: options?.eventType,
        probeSignals: options?.probeSignals,
        probeWindowSize: options?.probeWindowSize,
        probeMatchCount: options?.probeMatchCount,
        probeMatchRatio: options?.probeMatchRatio
      });
    } catch (error) {
      console.error(
        `[MemoryBroker] non-fatal memory-access-audit append failure for task ${taskId}: ${(error as Error).message}`
      );
    }
  }

  /**
   * Builds planner input for this module's runtime flow.
   *
   * **Why it exists:**
   * Keeps construction of planner input consistent across call sites.
   *
 * **What it talks to:**
 * - Uses `TaskRequest` (import `TaskRequest`) from `../core/types`.
 *
 * @param task - Incoming task request to enrich with brokered profile context.
 * @returns Promise resolving to MemoryBrokerInputResult.
 */
  async buildPlannerInput(task: TaskRequest): Promise<MemoryBrokerInputResult> {
    if (!this.profileMemoryStore) {
      return {
        userInput: task.userInput,
        profileMemoryStatus: "disabled"
      };
    }

    const currentUserRequest = extractCurrentUserRequest(task.userInput);
    const probingAssessment = this.registerAndAssessProbing(currentUserRequest);
    try {
      await this.profileMemoryStore.ingestFromTaskInput(
        task.id,
        currentUserRequest,
        task.createdAt
      );
      const profileContext = await this.profileMemoryStore.getPlanningContext(
        6,
        currentUserRequest
      );
      if (!profileContext) {
        const domainBoundary = assessDomainBoundary(currentUserRequest, "");
        await this.appendMemoryAccessAudit(
          task.id,
          currentUserRequest,
          0,
          0,
          domainBoundary.lanes
        );
        if (probingAssessment.detected) {
          await this.appendMemoryAccessAudit(task.id, currentUserRequest, 0, 0, domainBoundary.lanes, {
            eventType: "PROBING_DETECTED",
            probeSignals: probingAssessment.matchedSignals,
            probeWindowSize: probingAssessment.windowSize,
            probeMatchCount: probingAssessment.matchCount,
            probeMatchRatio: probingAssessment.matchRatio
          });
        }
        return {
          userInput: task.userInput,
          profileMemoryStatus: "available"
        };
      }

      const sanitizedProfileContext = sanitizeProfileContextForModelEgress(profileContext);
      const assessedDomainBoundary = assessDomainBoundary(
        currentUserRequest,
        sanitizedProfileContext.sanitizedContext
      );
      const domainBoundary: DomainBoundaryAssessment = probingAssessment.detected
        ? {
            ...assessedDomainBoundary,
            decision: "suppress_profile_context",
            reason: "probing_detected"
          }
        : assessedDomainBoundary;
      const retrievedCount = countRetrievedProfileFacts(profileContext);
      await this.appendMemoryAccessAudit(
        task.id,
        currentUserRequest,
        retrievedCount,
        sanitizedProfileContext.redactedFieldCount,
        domainBoundary.lanes
      );
      if (probingAssessment.detected) {
        await this.appendMemoryAccessAudit(
          task.id,
          currentUserRequest,
          retrievedCount,
          sanitizedProfileContext.redactedFieldCount,
          domainBoundary.lanes,
          {
            eventType: "PROBING_DETECTED",
            probeSignals: probingAssessment.matchedSignals,
            probeWindowSize: probingAssessment.windowSize,
            probeMatchCount: probingAssessment.matchCount,
            probeMatchRatio: probingAssessment.matchRatio
          }
        );
      }
      if (domainBoundary.decision === "suppress_profile_context") {
        return {
          userInput: buildSuppressedContextPacket(
            task,
            domainBoundary.lanes,
            domainBoundary.scores,
            domainBoundary.reason
          ),
          profileMemoryStatus: "available"
        };
      }

      const egressGuardFooter =
        sanitizedProfileContext.redactedFieldCount > 0
          ? `\n[AgentFriendProfileEgressGuard]\nredactedSensitiveFields=${sanitizedProfileContext.redactedFieldCount}`
          : "";
      const brokeredContext = `${sanitizedProfileContext.sanitizedContext}${egressGuardFooter}`;

      return {
        userInput: buildInjectedContextPacket(
          task,
          domainBoundary.lanes,
          domainBoundary.scores,
          domainBoundary.reason,
          brokeredContext
        ),
        profileMemoryStatus: "available"
      };
    } catch (error) {
      console.error(
        `[MemoryBroker] non-fatal profile-memory brokerage failure for task ${task.id}: ${(error as Error).message}`
      );
      return {
        userInput: [
          task.userInput,
          "",
          "[AgentFriendProfileStatus]",
          "mode=degraded_unavailable",
          "reason=profile_memory_unavailable"
        ].join("\n"),
        profileMemoryStatus: "degraded_unavailable"
      };
    }
  }
}
