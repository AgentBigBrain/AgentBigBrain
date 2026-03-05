/**
 * @fileoverview Deterministic Stage 6.86 pulse-candidate generation and suppression helpers for checkpoint 6.86.E.
 */

import {
  BridgeBlockCodeV1,
  BridgeConflictCodeV1,
  ConversationStackV1,
  EntityGraphV1,
  EntityNodeV1,
  PulseBlockCodeV1,
  PulseCandidateV1,
  PulseDecisionV1,
  PulseReasonCodeV1,
  STAGE_6_86_PULSE_REASON_CODES,
  ThreadFrameV1
} from "./types";
import { sha256HexFromCanonicalJson } from "./normalizers/canonicalizationRules";
import { isConversationStackV1 } from "./stage6_86ConversationStack";

const DEFAULT_PULSE_MAX_PER_DAY = 2;
const DEFAULT_PULSE_MIN_INTERVAL_MINUTES = 240;
const DEFAULT_PULSE_MAX_OPEN_LOOPS_SURFACED = 1;
const DEFAULT_CO_MENTION_THRESHOLD = 5;
const DEFAULT_CO_MENTION_WINDOW_DAYS = 90;
const DEFAULT_BRIDGE_COOLDOWN_DAYS = 14;
const DEFAULT_OPEN_LOOP_STALE_DAYS = 30;
const DEFAULT_STALE_FACT_REVALIDATION_DAYS = 90;
const DEFAULT_ENTITY_SALIENCE_THRESHOLD = 2;
const MAX_REASONABLE_COUNT = 32;
const MAX_REASONABLE_MINUTES = 24 * 60 * 7;
const MAX_REASONABLE_DAYS = 365;

const THREAD_STATE_SORT_WEIGHT: Record<ThreadFrameV1["state"], number> = {
  active: 0,
  paused: 1,
  resolved: 2
};

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

const SOURCE_REASON_WEIGHT: Record<PulseReasonCodeV1, number> = {
  OPEN_LOOP_RESUME: 0.72,
  RELATIONSHIP_CLARIFICATION: 0.69,
  TOPIC_DRIFT_RESUME: 0.58,
  STALE_FACT_REVALIDATION: 0.61,
  USER_REQUESTED_FOLLOWUP: 0.55,
  SAFETY_HOLD: 0.2
};

const REASON_ORDER = new Map<PulseReasonCodeV1, number>(
  STAGE_6_86_PULSE_REASON_CODES.map((reasonCode, index) => [reasonCode, index])
);

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
  graph: EntityGraphV1;
  stack: ConversationStackV1;
  observedAt: string;
  recentPulseHistory?: readonly PulseEmissionRecordV1[];
  activeMissionWorkExists?: boolean;
  privacyOptOutEntityKeys?: readonly string[];
}

export interface PulseCandidateDecisionV1 {
  candidate: PulseCandidateV1;
  decision: PulseDecisionV1;
}

export interface EvaluatePulseCandidatesResultV1 {
  orderedCandidates: readonly PulseCandidateV1[];
  decisions: readonly PulseCandidateDecisionV1[];
  emittedCandidate: PulseCandidateV1 | null;
}

interface PulseCandidateDraftV1 {
  reasonCode: PulseReasonCodeV1;
  lastTouchedAt: string;
  threadKey: string | null;
  entityRefs: readonly string[];
  evidenceRefs: readonly string[];
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
function assertValidIsoTimestamp(value: string, fieldName: string): void {
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
function normalizeWhitespace(value: string): string {
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
function normalizeStringArray(values: readonly string[] | undefined): readonly string[] {
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
function clampRatio(value: number): number {
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
function clampCount(value: number | undefined, fallback: number): number {
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
function clampMinutes(value: number | undefined, fallback: number): number {
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
function clampDays(value: number | undefined, fallback: number): number {
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
function daysBetween(earlierIso: string, laterIso: string): number {
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
function computeRecencySignal(lastTouchedAt: string, observedAt: string): number {
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
function computeStalenessSignal(lastTouchedAt: string, observedAt: string, staleDays: number): number {
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
function containsPrivacyKeyword(value: string): boolean {
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
 * - Uses `EntityNodeV1` (import `EntityNodeV1`) from `./types`.
 *
 * @param entity - Value for entity.
 * @param optOutKeys - Lookup key or map field identifier.
 * @returns `true` when this check passes.
 */
function isEntityPrivacySensitive(entity: EntityNodeV1, optOutKeys: ReadonlySet<string>): boolean {
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

/**
 * Normalizes ordering and duplication for drafts.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for drafts in one place.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param drafts - Value for drafts.
 * @returns Ordered collection produced by this step.
 */
function sortDrafts(drafts: readonly PulseCandidateDraftV1[]): readonly PulseCandidateDraftV1[] {
  return [...drafts].sort((left, right) => {
    if (left.lastTouchedAt !== right.lastTouchedAt) {
      return right.lastTouchedAt.localeCompare(left.lastTouchedAt);
    }
    if (left.reasonCode !== right.reasonCode) {
      return left.reasonCode.localeCompare(right.reasonCode);
    }
    const leftRefs = left.entityRefs.join(",");
    const rightRefs = right.entityRefs.join(",");
    if (leftRefs !== rightRefs) {
      return leftRefs.localeCompare(rightRefs);
    }
    return (left.threadKey ?? "").localeCompare(right.threadKey ?? "");
  });
}

/**
 * Builds candidate id for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of candidate id consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `./normalizers/canonicalizationRules`.
 *
 * @param draft - Value for draft.
 * @returns Resulting string value.
 */
function buildCandidateId(draft: PulseCandidateDraftV1): string {
  const fingerprint = sha256HexFromCanonicalJson({
    reasonCode: draft.reasonCode,
    lastTouchedAt: draft.lastTouchedAt,
    threadKey: draft.threadKey,
    entityRefs: [...draft.entityRefs].sort((left, right) => left.localeCompare(right))
  });
  return `pulse_candidate_${fingerprint.slice(0, 20)}`;
}

/**
 * Converts values into pulse candidate form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for pulse candidate deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `./normalizers/canonicalizationRules`.
 * - Uses `PulseCandidateV1` (import `PulseCandidateV1`) from `./types`.
 *
 * @param draft - Value for draft.
 * @returns Computed `PulseCandidateV1` result.
 */
function toPulseCandidate(draft: PulseCandidateDraftV1): PulseCandidateV1 {
  const unresolvedImportance =
    draft.scoreBreakdown.unresolvedImportance + SOURCE_REASON_WEIGHT[draft.reasonCode] * 0.15;
  const score = clampRatio(
    draft.scoreBreakdown.recency * 0.35 +
    draft.scoreBreakdown.frequency * 0.25 +
    unresolvedImportance * 0.4 -
    draft.scoreBreakdown.sensitivityPenalty -
    draft.scoreBreakdown.cooldownPenalty
  );
  const candidateId = buildCandidateId(draft);
  const preHash = {
    candidateId,
    reasonCode: draft.reasonCode,
    score,
    scoreBreakdown: {
      recency: draft.scoreBreakdown.recency,
      frequency: draft.scoreBreakdown.frequency,
      unresolvedImportance: clampRatio(unresolvedImportance),
      sensitivityPenalty: draft.scoreBreakdown.sensitivityPenalty,
      cooldownPenalty: draft.scoreBreakdown.cooldownPenalty
    },
    lastTouchedAt: draft.lastTouchedAt,
    threadKey: draft.threadKey,
    entityRefs: draft.entityRefs,
    evidenceRefs: draft.evidenceRefs
  };
  const stableHash = sha256HexFromCanonicalJson(preHash);
  return {
    ...preHash,
    stableHash
  };
}

/**
 * Normalizes ordering and duplication for candidates.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for candidates in one place.
 *
 * **What it talks to:**
 * - Uses `PulseCandidateV1` (import `PulseCandidateV1`) from `./types`.
 *
 * @param candidates - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Ordered collection produced by this step.
 */
function sortCandidates(candidates: readonly PulseCandidateV1[]): readonly PulseCandidateV1[] {
  return [...candidates].sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }
    const leftPriority = REASON_ORDER.get(left.reasonCode) ?? Number.MAX_SAFE_INTEGER;
    const rightPriority = REASON_ORDER.get(right.reasonCode) ?? Number.MAX_SAFE_INTEGER;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }
    if (left.lastTouchedAt !== right.lastTouchedAt) {
      return right.lastTouchedAt.localeCompare(left.lastTouchedAt);
    }
    return left.stableHash.localeCompare(right.stableHash);
  });
}

/**
 * Builds high salience entity drafts for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of high salience entity drafts consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `./types`.
 * - Uses `PulseReasonCodeV1` (import `PulseReasonCodeV1`) from `./types`.
 *
 * @param graph - Value for graph.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @param entitySalienceThreshold - Value for entity salience threshold.
 * @param privacyOptOutEntityKeys - Lookup key or map field identifier.
 * @returns Ordered collection produced by this step.
 */
function buildHighSalienceEntityDrafts(
  graph: EntityGraphV1,
  observedAt: string,
  entitySalienceThreshold: number,
  privacyOptOutEntityKeys: ReadonlySet<string>
): readonly PulseCandidateDraftV1[] {
  return graph.entities
    .filter((entity) => entity.salience >= entitySalienceThreshold)
    .sort((left, right) => left.entityKey.localeCompare(right.entityKey))
    .map((entity) => {
      const privacySensitive = isEntityPrivacySensitive(entity, privacyOptOutEntityKeys);
      return {
        reasonCode: "USER_REQUESTED_FOLLOWUP" as PulseReasonCodeV1,
        lastTouchedAt: entity.lastSeenAt,
        threadKey: null,
        entityRefs: [entity.entityKey],
        evidenceRefs: normalizeStringArray(entity.evidenceRefs),
        scoreBreakdown: {
          recency: computeRecencySignal(entity.lastSeenAt, observedAt),
          frequency: clampRatio(entity.salience / 10),
          unresolvedImportance: 0.55,
          sensitivityPenalty: privacySensitive ? 0.35 : 0,
          cooldownPenalty: 0
        }
      };
    });
}

/**
 * Builds bridge candidate drafts for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of bridge candidate drafts consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `./types`.
 * - Uses `PulseReasonCodeV1` (import `PulseReasonCodeV1`) from `./types`.
 *
 * @param graph - Value for graph.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @param coMentionThreshold - Value for co mention threshold.
 * @param coMentionWindowDays - Value for co mention window days.
 * @param privacyOptOutEntityKeys - Lookup key or map field identifier.
 * @returns Ordered collection produced by this step.
 */
function buildBridgeCandidateDrafts(
  graph: EntityGraphV1,
  observedAt: string,
  coMentionThreshold: number,
  coMentionWindowDays: number,
  privacyOptOutEntityKeys: ReadonlySet<string>
): readonly PulseCandidateDraftV1[] {
  const entitiesByKey = new Map(graph.entities.map((entity) => [entity.entityKey, entity]));
  return graph.edges
    .filter((edge) => edge.relationType === "co_mentioned" && edge.status === "uncertain")
    .filter((edge) => edge.coMentionCount >= coMentionThreshold)
    .filter((edge) => daysBetween(edge.lastObservedAt, observedAt) <= coMentionWindowDays)
    .sort((left, right) => left.edgeKey.localeCompare(right.edgeKey))
    .map((edge) => {
      const sourceEntity = entitiesByKey.get(edge.sourceEntityKey);
      const targetEntity = entitiesByKey.get(edge.targetEntityKey);
      const privacySensitive =
        (sourceEntity ? isEntityPrivacySensitive(sourceEntity, privacyOptOutEntityKeys) : false) ||
        (targetEntity ? isEntityPrivacySensitive(targetEntity, privacyOptOutEntityKeys) : false);
      return {
        reasonCode: "RELATIONSHIP_CLARIFICATION" as PulseReasonCodeV1,
        lastTouchedAt: edge.lastObservedAt,
        threadKey: null,
        entityRefs: normalizeStringArray([edge.sourceEntityKey, edge.targetEntityKey]),
        evidenceRefs: normalizeStringArray(edge.evidenceRefs),
        scoreBreakdown: {
          recency: computeRecencySignal(edge.lastObservedAt, observedAt),
          frequency: clampRatio(edge.coMentionCount / (coMentionThreshold + 2)),
          unresolvedImportance: 0.68,
          sensitivityPenalty: privacySensitive ? 0.45 : 0,
          cooldownPenalty: 0
        }
      };
    });
}

/**
 * Builds open loop drafts for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of open loop drafts consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `ConversationStackV1` (import `ConversationStackV1`) from `./types`.
 *
 * @param stack - Value for stack.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @param openLoopStaleDays - Value for open loop stale days.
 * @param pulseMaxOpenLoopsSurfaced - Numeric bound, counter, or index used by this logic.
 * @param privacyOptOutEntityKeys - Lookup key or map field identifier.
 * @returns Ordered collection produced by this step.
 */
function buildOpenLoopDrafts(
  stack: ConversationStackV1,
  observedAt: string,
  openLoopStaleDays: number,
  pulseMaxOpenLoopsSurfaced: number,
  privacyOptOutEntityKeys: ReadonlySet<string>
): readonly PulseCandidateDraftV1[] {
  const allDrafts: PulseCandidateDraftV1[] = [];
  for (const thread of stack.threads) {
    for (const loop of thread.openLoops) {
      if (loop.status !== "open") {
        continue;
      }
      const staleSignal = computeStalenessSignal(loop.lastMentionedAt, observedAt, openLoopStaleDays);
      const privacySensitive =
        normalizeStringArray(loop.entityRefs).some((entityKey) => privacyOptOutEntityKeys.has(entityKey)) ||
        containsPrivacyKeyword(thread.topicLabel);
      allDrafts.push({
        reasonCode: "OPEN_LOOP_RESUME",
        lastTouchedAt: loop.lastMentionedAt,
        threadKey: thread.threadKey,
        entityRefs: normalizeStringArray(loop.entityRefs),
        evidenceRefs: normalizeStringArray([`thread:${thread.threadKey}:loop:${loop.loopId}`]),
        scoreBreakdown: {
          recency: computeRecencySignal(loop.lastMentionedAt, observedAt),
          frequency: clampRatio(1 / (1 + staleSignal)),
          unresolvedImportance: clampRatio(loop.priority + staleSignal * 0.3),
          sensitivityPenalty: privacySensitive ? 0.3 : 0,
          cooldownPenalty: 0
        }
      });
    }
  }

  const ordered = sortDrafts(allDrafts).map((draft) => toPulseCandidate(draft));
  const prioritized = sortCandidates(ordered)
    .slice(0, pulseMaxOpenLoopsSurfaced)
    .map((candidate) => ({
      reasonCode: candidate.reasonCode,
      lastTouchedAt: candidate.lastTouchedAt,
      threadKey: candidate.threadKey,
      entityRefs: candidate.entityRefs,
      evidenceRefs: candidate.evidenceRefs,
      scoreBreakdown: {
        recency: candidate.scoreBreakdown.recency,
        frequency: candidate.scoreBreakdown.frequency,
        unresolvedImportance: candidate.scoreBreakdown.unresolvedImportance,
        sensitivityPenalty: candidate.scoreBreakdown.sensitivityPenalty,
        cooldownPenalty: candidate.scoreBreakdown.cooldownPenalty
      }
    }));
  return prioritized;
}

/**
 * Builds topic drift drafts for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of topic drift drafts consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `ConversationStackV1` (import `ConversationStackV1`) from `./types`.
 *
 * @param stack - Value for stack.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Ordered collection produced by this step.
 */
function buildTopicDriftDrafts(
  stack: ConversationStackV1,
  observedAt: string
): readonly PulseCandidateDraftV1[] {
  const topicByKey = new Map(stack.topics.map((topic) => [topic.topicKey, topic]));
  return stack.threads
    .filter((thread) => thread.state === "paused")
    .sort((left, right) => left.threadKey.localeCompare(right.threadKey))
    .map((thread) => {
      const topic = topicByKey.get(thread.topicKey);
      const mentionCount = topic?.mentionCount ?? 1;
      return {
        reasonCode: "TOPIC_DRIFT_RESUME",
        lastTouchedAt: thread.lastTouchedAt,
        threadKey: thread.threadKey,
        entityRefs: [],
        evidenceRefs: normalizeStringArray([`thread:${thread.threadKey}:topic:${thread.topicKey}`]),
        scoreBreakdown: {
          recency: computeRecencySignal(thread.lastTouchedAt, observedAt),
          frequency: clampRatio(mentionCount / 8),
          unresolvedImportance: 0.48,
          sensitivityPenalty: containsPrivacyKeyword(thread.topicLabel) ? 0.25 : 0,
          cooldownPenalty: 0
        }
      };
    });
}

/**
 * Builds stale fact drafts for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of stale fact drafts consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `./types`.
 *
 * @param graph - Value for graph.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @param staleFactRevalidationDays - Stable identifier used to reference an entity or record.
 * @param privacyOptOutEntityKeys - Lookup key or map field identifier.
 * @returns Ordered collection produced by this step.
 */
function buildStaleFactDrafts(
  graph: EntityGraphV1,
  observedAt: string,
  staleFactRevalidationDays: number,
  privacyOptOutEntityKeys: ReadonlySet<string>
): readonly PulseCandidateDraftV1[] {
  const entitiesByKey = new Map(graph.entities.map((entity) => [entity.entityKey, entity]));
  return graph.edges
    .filter((edge) => edge.status === "confirmed")
    .filter((edge) => daysBetween(edge.lastObservedAt, observedAt) >= staleFactRevalidationDays)
    .sort((left, right) => left.edgeKey.localeCompare(right.edgeKey))
    .map((edge) => {
      const staleSignal = computeStalenessSignal(edge.lastObservedAt, observedAt, staleFactRevalidationDays);
      const sourceEntity = entitiesByKey.get(edge.sourceEntityKey);
      const targetEntity = entitiesByKey.get(edge.targetEntityKey);
      const privacySensitive =
        (sourceEntity ? isEntityPrivacySensitive(sourceEntity, privacyOptOutEntityKeys) : false) ||
        (targetEntity ? isEntityPrivacySensitive(targetEntity, privacyOptOutEntityKeys) : false);
      return {
        reasonCode: "STALE_FACT_REVALIDATION",
        lastTouchedAt: edge.lastObservedAt,
        threadKey: null,
        entityRefs: normalizeStringArray([edge.sourceEntityKey, edge.targetEntityKey]),
        evidenceRefs: normalizeStringArray(edge.evidenceRefs),
        scoreBreakdown: {
          recency: staleSignal,
          frequency: clampRatio(edge.coMentionCount / 10),
          unresolvedImportance: 0.61,
          sensitivityPenalty: privacySensitive ? 0.4 : 0,
          cooldownPenalty: 0
        }
      };
    });
}

/**
 * Evaluates global cooldown active and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the global cooldown active policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param history - Value for history.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @param pulseMinIntervalMinutes - Numeric bound, counter, or index used by this logic.
 * @returns `true` when this check passes.
 */
function isGlobalCooldownActive(
  history: readonly PulseEmissionRecordV1[],
  observedAt: string,
  pulseMinIntervalMinutes: number
): boolean {
  const latest = [...history]
    .filter((entry) => Number.isFinite(Date.parse(entry.emittedAt)))
    .sort((left, right) => right.emittedAt.localeCompare(left.emittedAt))[0];
  if (!latest) {
    return false;
  }
  return daysBetween(latest.emittedAt, observedAt) * 24 * 60 < pulseMinIntervalMinutes;
}

/**
 * Evaluates daily cap reached and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the daily cap reached policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param history - Value for history.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @param pulseMaxPerDay - Numeric bound, counter, or index used by this logic.
 * @returns `true` when this check passes.
 */
function isDailyCapReached(
  history: readonly PulseEmissionRecordV1[],
  observedAt: string,
  pulseMaxPerDay: number
): boolean {
  const emittedLastDay = history.filter((entry) => daysBetween(entry.emittedAt, observedAt) <= 1).length;
  return emittedLastDay >= pulseMaxPerDay;
}

/**
 * Evaluates bridge cooldown active and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the bridge cooldown active policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `PulseCandidateV1` (import `PulseCandidateV1`) from `./types`.
 *
 * @param history - Value for history.
 * @param candidate - Timestamp used for ordering, timeout, or recency decisions.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @param bridgeCooldownDays - Stable identifier used to reference an entity or record.
 * @returns `true` when this check passes.
 */
function isBridgeCooldownActive(
  history: readonly PulseEmissionRecordV1[],
  candidate: PulseCandidateV1,
  observedAt: string,
  bridgeCooldownDays: number
): boolean {
  if (candidate.reasonCode !== "RELATIONSHIP_CLARIFICATION" || candidate.entityRefs.length < 2) {
    return false;
  }
  const key = normalizeStringArray(candidate.entityRefs).join("|");
  return history.some((entry) => {
    if (entry.reasonCode !== "RELATIONSHIP_CLARIFICATION") {
      return false;
    }
    const entryKey = normalizeStringArray(entry.candidateEntityRefs).join("|");
    if (entryKey !== key) {
      return false;
    }
    return daysBetween(entry.emittedAt, observedAt) <= bridgeCooldownDays;
  });
}

/**
 * Implements candidate has privacy risk behavior used by `stage6_86PulseCandidates`.
 *
 * **Why it exists:**
 * Keeps `candidate has privacy risk` behavior centralized so collaborating call sites stay consistent.
 *
 * **What it talks to:**
 * - Uses `ConversationStackV1` (import `ConversationStackV1`) from `./types`.
 * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `./types`.
 * - Uses `PulseCandidateV1` (import `PulseCandidateV1`) from `./types`.
 *
 * @param candidate - Timestamp used for ordering, timeout, or recency decisions.
 * @param graph - Value for graph.
 * @param stack - Value for stack.
 * @param privacyOptOutEntityKeys - Lookup key or map field identifier.
 * @returns `true` when this check passes.
 */
function candidateHasPrivacyRisk(
  candidate: PulseCandidateV1,
  graph: EntityGraphV1,
  stack: ConversationStackV1,
  privacyOptOutEntityKeys: ReadonlySet<string>
): boolean {
  const entitiesByKey = new Map(graph.entities.map((entity) => [entity.entityKey, entity]));
  for (const entityKey of candidate.entityRefs) {
    if (privacyOptOutEntityKeys.has(entityKey)) {
      return true;
    }
    const entity = entitiesByKey.get(entityKey);
    if (entity && isEntityPrivacySensitive(entity, privacyOptOutEntityKeys)) {
      return true;
    }
  }

  if (!candidate.threadKey) {
    return false;
  }
  const thread = stack.threads.find((entry) => entry.threadKey === candidate.threadKey);
  if (!thread) {
    return false;
  }
  return containsPrivacyKeyword(thread.topicLabel);
}

/**
 * Builds suppress decision for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of suppress decision consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `BridgeBlockCodeV1` (import `BridgeBlockCodeV1`) from `./types`.
 * - Uses `PulseBlockCodeV1` (import `PulseBlockCodeV1`) from `./types`.
 * - Uses `PulseCandidateV1` (import `PulseCandidateV1`) from `./types`.
 * - Uses `PulseDecisionV1` (import `PulseDecisionV1`) from `./types`.
 *
 * @param candidate - Timestamp used for ordering, timeout, or recency decisions.
 * @param reason - Value for reason.
 * @returns Computed `PulseDecisionV1` result.
 */
function buildSuppressDecision(
  candidate: PulseCandidateV1,
  reason: PulseBlockCodeV1 | BridgeBlockCodeV1
): PulseDecisionV1 {
  return {
    decisionCode: "SUPPRESS",
    candidateId: candidate.candidateId,
    blockCode: "PULSE_BLOCKED",
    blockDetailReason: reason,
    evidenceRefs: candidate.evidenceRefs
  };
}

/**
 * Evaluates pulse candidates v1 and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the pulse candidates v1 policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `isConversationStackV1` (import `isConversationStackV1`) from `./stage6_86ConversationStack`.
 * - Uses `BridgeBlockCodeV1` (import `BridgeBlockCodeV1`) from `./types`.
 * - Uses `PulseBlockCodeV1` (import `PulseBlockCodeV1`) from `./types`.
 * - Uses `PulseCandidateV1` (import `PulseCandidateV1`) from `./types`.
 * - Uses `PulseDecisionV1` (import `PulseDecisionV1`) from `./types`.
 *
 * @param input - Structured input object for this operation.
 * @param options - Optional tuning knobs for this operation.
 * @returns Computed `EvaluatePulseCandidatesResultV1` result.
 */
export function evaluatePulseCandidatesV1(
  input: EvaluatePulseCandidatesInputV1,
  options: EvaluatePulseCandidatesOptionsV1 = {}
): EvaluatePulseCandidatesResultV1 {
  if (!isConversationStackV1(input.stack)) {
    throw new Error("Invalid ConversationStackV1 payload.");
  }
  assertValidIsoTimestamp(input.observedAt, "observedAt");

  const pulseMaxPerDay = clampCount(options.pulseMaxPerDay, DEFAULT_PULSE_MAX_PER_DAY);
  const pulseMinIntervalMinutes = clampMinutes(
    options.pulseMinIntervalMinutes,
    DEFAULT_PULSE_MIN_INTERVAL_MINUTES
  );
  const pulseMaxOpenLoopsSurfaced = clampCount(
    options.pulseMaxOpenLoopsSurfaced,
    DEFAULT_PULSE_MAX_OPEN_LOOPS_SURFACED
  );
  const coMentionThreshold = clampCount(options.coMentionThreshold, DEFAULT_CO_MENTION_THRESHOLD);
  const coMentionWindowDays = clampDays(options.coMentionWindowDays, DEFAULT_CO_MENTION_WINDOW_DAYS);
  const bridgeCooldownDays = clampDays(options.bridgeCooldownDays, DEFAULT_BRIDGE_COOLDOWN_DAYS);
  const openLoopStaleDays = clampDays(options.openLoopStaleDays, DEFAULT_OPEN_LOOP_STALE_DAYS);
  const staleFactRevalidationDays = clampDays(
    options.staleFactRevalidationDays,
    DEFAULT_STALE_FACT_REVALIDATION_DAYS
  );
  const entitySalienceThreshold = clampCount(
    options.entitySalienceThreshold,
    DEFAULT_ENTITY_SALIENCE_THRESHOLD
  );

  const privacyOptOutEntityKeys = new Set(normalizeStringArray(input.privacyOptOutEntityKeys));
  const history = (input.recentPulseHistory ?? [])
    .filter((entry) => Number.isFinite(Date.parse(entry.emittedAt)))
    .map((entry) => ({
      emittedAt: entry.emittedAt,
      reasonCode: entry.reasonCode,
      candidateEntityRefs: normalizeStringArray(entry.candidateEntityRefs)
    }))
    .sort((left, right) => left.emittedAt.localeCompare(right.emittedAt));

  const drafts = sortDrafts([
    ...buildHighSalienceEntityDrafts(
      input.graph,
      input.observedAt,
      entitySalienceThreshold,
      privacyOptOutEntityKeys
    ),
    ...buildBridgeCandidateDrafts(
      input.graph,
      input.observedAt,
      coMentionThreshold,
      coMentionWindowDays,
      privacyOptOutEntityKeys
    ),
    ...buildOpenLoopDrafts(
      input.stack,
      input.observedAt,
      openLoopStaleDays,
      pulseMaxOpenLoopsSurfaced,
      privacyOptOutEntityKeys
    ),
    ...buildTopicDriftDrafts(input.stack, input.observedAt),
    ...buildStaleFactDrafts(
      input.graph,
      input.observedAt,
      staleFactRevalidationDays,
      privacyOptOutEntityKeys
    )
  ]);

  const orderedCandidates = sortCandidates(drafts.map((draft) => toPulseCandidate(draft)));
  const decisions: PulseCandidateDecisionV1[] = [];
  let emittedCandidate: PulseCandidateV1 | null = null;
  const globalCooldownActive = isGlobalCooldownActive(history, input.observedAt, pulseMinIntervalMinutes);
  const dailyCapReached = isDailyCapReached(history, input.observedAt, pulseMaxPerDay);

  for (const candidate of orderedCandidates) {
    if (input.activeMissionWorkExists) {
      decisions.push({
        candidate,
        decision: buildSuppressDecision(candidate, "DERAILS_ACTIVE_MISSION")
      });
      continue;
    }

    if (candidateHasPrivacyRisk(candidate, input.graph, input.stack, privacyOptOutEntityKeys)) {
      const privacyReason: PulseBlockCodeV1 | BridgeBlockCodeV1 =
        candidate.reasonCode === "RELATIONSHIP_CLARIFICATION"
          ? "BRIDGE_PRIVACY_SENSITIVE"
          : "PRIVACY_SENSITIVE";
      decisions.push({
        candidate,
        decision: buildSuppressDecision(candidate, privacyReason)
      });
      continue;
    }

    if (isBridgeCooldownActive(history, candidate, input.observedAt, bridgeCooldownDays)) {
      decisions.push({
        candidate,
        decision: buildSuppressDecision(candidate, "BRIDGE_COOLDOWN_ACTIVE")
      });
      continue;
    }

    if (dailyCapReached || emittedCandidate !== null) {
      const capReason: PulseBlockCodeV1 | BridgeBlockCodeV1 =
        candidate.reasonCode === "RELATIONSHIP_CLARIFICATION"
          ? "BRIDGE_CAP_REACHED"
          : "PULSE_CAP_REACHED";
      decisions.push({
        candidate,
        decision: buildSuppressDecision(candidate, capReason)
      });
      continue;
    }

    if (globalCooldownActive) {
      decisions.push({
        candidate,
        decision: buildSuppressDecision(candidate, "PULSE_COOLDOWN_ACTIVE")
      });
      continue;
    }

    const emitDecision: PulseDecisionV1 = {
      decisionCode: "EMIT",
      candidateId: candidate.candidateId,
      blockCode: null,
      blockDetailReason: null,
      evidenceRefs: candidate.evidenceRefs
    };
    emittedCandidate = candidate;
    decisions.push({
      candidate,
      decision: emitDecision
    });
  }

  return {
    orderedCandidates,
    decisions,
    emittedCandidate
  };
}

/**
 * Builds bridge insufficient evidence conflict v1 for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of bridge insufficient evidence conflict v1 consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `BridgeConflictCodeV1` (import `BridgeConflictCodeV1`) from `./types`.
 * @returns Computed `BridgeConflictCodeV1` result.
 */
export function buildBridgeInsufficientEvidenceConflictV1(): BridgeConflictCodeV1 {
  return "INSUFFICIENT_EVIDENCE";
}
