/**
 * @fileoverview Deterministic Stage 6.86 bridge-question gating, rendering, and answer-resolution helpers for checkpoint 6.86.F.
 */

import {
  BridgeBlockCodeV1,
  BridgeCandidateV1,
  BridgeConflictCodeV1,
  BridgeQuestionV1,
  EntityGraphV1,
  PulseBlockCodeV1,
  PulseCandidateV1,
  PulseEmitActionParams,
  RelationTypeV1,
  Stage686BlockCodeV1,
  Stage686ConflictObjectV1
} from "../types";
import { promoteRelationEdgeWithConfirmation } from "./entityGraph";
import { sha256HexFromCanonicalJson } from "../normalizers/canonicalizationRules";

const DEFAULT_CO_MENTION_THRESHOLD = 5;
const DEFAULT_CO_MENTION_WINDOW_DAYS = 90;
const DEFAULT_BRIDGE_COOLDOWN_DAYS = 14;
const DEFAULT_BRIDGE_MAX_PER_CONVERSATION = 1;
const MAX_REASONABLE_COUNT = 32;
const MAX_REASONABLE_DAYS = 365;
const GLOBAL_CONVERSATION_KEY = "__global__";

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

type BridgeRelationTypeV1 = Exclude<RelationTypeV1, "co_mentioned" | "unknown">;

export interface BridgeInteractionRecordV1 {
  questionId: string;
  conversationKey: string;
  sourceEntityKey: string;
  targetEntityKey: string;
  askedAt: string;
  status: "asked" | "confirmed" | "deferred";
  cooldownUntil: string;
  deferralCount: number;
}

export interface EvaluateBridgeQuestionOptionsV1 {
  coMentionThreshold?: number;
  coMentionWindowDays?: number;
  bridgeCooldownDays?: number;
  bridgeMaxPerConversation?: number;
}

export interface EvaluateBridgeQuestionInputV1 {
  graph: EntityGraphV1;
  candidate: PulseCandidateV1;
  observedAt: string;
  recentBridgeHistory?: readonly BridgeInteractionRecordV1[];
  activeMissionWorkExists?: boolean;
  privacyOptOutEntityKeys?: readonly string[];
}

export interface EvaluateBridgeQuestionResultV1 {
  approved: boolean;
  blockCode: Extract<Stage686BlockCodeV1, "PULSE_BLOCKED"> | null;
  blockDetailReason: BridgeBlockCodeV1 | PulseBlockCodeV1 | null;
  conflict: Stage686ConflictObjectV1 | null;
  bridgeCandidate: BridgeCandidateV1 | null;
  bridgeQuestion: BridgeQuestionV1 | null;
  pulseEmitParams: PulseEmitActionParams | null;
}

export interface ResolveBridgeAnswerInputV1 {
  graph: EntityGraphV1;
  question: BridgeQuestionV1;
  observedAt: string;
  evidenceRef: string;
  answer: {
    kind: "confirmed" | "deferred";
    relationType?: BridgeRelationTypeV1;
  };
  recentBridgeHistory?: readonly BridgeInteractionRecordV1[];
  bridgeCooldownDays?: number;
}

export interface ResolveBridgeAnswerResultV1 {
  graph: EntityGraphV1;
  deniedConflictCode: BridgeConflictCodeV1 | null;
  historyRecord: BridgeInteractionRecordV1;
}

interface BridgeEdgeSnapshotV1 {
  sourceEntityKey: string;
  targetEntityKey: string;
  coMentionCount: number;
  lastObservedAt: string;
  evidenceRefs: readonly string[];
}

/**
 * Applies deterministic validity checks for valid iso timestamp.
 *
 * **Why it exists:**
 * Fails fast when valid iso timestamp is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - `Date.parse` for timestamp validation.
 *
 * @param value - Timestamp candidate in ISO string form.
 * @param fieldName - Field label used in error messages.
 */
function assertValidIsoTimestamp(value: string, fieldName: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error(`Invalid ISO timestamp for ${fieldName}: ${value}`);
  }
}

/**
 * Normalizes whitespace into a stable shape for `stage6_86BridgeQuestions` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for whitespace so call sites stay aligned.
 *
 * **What it talks to:**
 * - Local regex-based normalization only.
 *
 * @param value - Raw text value.
 * @returns Collapsed-and-trimmed text.
 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Normalizes entity pair into a stable shape for `stage6_86BridgeQuestions` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for entity pair so call sites stay aligned.
 *
 * **What it talks to:**
 * - Local lexical ordering with `localeCompare`.
 *
 * @param sourceEntityKey - First entity key in the candidate pair.
 * @param targetEntityKey - Second entity key in the candidate pair.
 * @returns Deterministically ordered tuple `[leftKey, rightKey]`.
 */
function normalizeEntityPair(sourceEntityKey: string, targetEntityKey: string): readonly [string, string] {
  if (sourceEntityKey.localeCompare(targetEntityKey) <= 0) {
    return [sourceEntityKey, targetEntityKey];
  }
  return [targetEntityKey, sourceEntityKey];
}

/**
 * Builds pair key for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of pair key consistent across call sites.
 *
 * **What it talks to:**
 * - `normalizeEntityPair` for stable pair ordering.
 *
 * @param sourceEntityKey - First entity key in the pair.
 * @param targetEntityKey - Second entity key in the pair.
 * @returns Stable pair key string (`left|right`).
 */
function buildPairKey(sourceEntityKey: string, targetEntityKey: string): string {
  const [left, right] = normalizeEntityPair(sourceEntityKey, targetEntityKey);
  return `${left}|${right}`;
}

/**
 * Constrains and sanitizes count to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for count before data flows to policy checks.
 *
 * **What it talks to:**
 * - Local numeric guards and `MAX_REASONABLE_COUNT`.
 *
 * @param value - Candidate count from options/input.
 * @param fallback - Default count used when input is invalid.
 * @returns Numeric result used by downstream logic.
 */
function clampCount(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value ?? Number.NaN)) {
    return fallback;
  }
  const parsed = Math.floor(value as number);
  return Math.max(1, Math.min(MAX_REASONABLE_COUNT, parsed));
}

/**
 * Constrains and sanitizes days to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for days before data flows to policy checks.
 *
 * **What it talks to:**
 * - Local numeric guards and `MAX_REASONABLE_DAYS`.
 *
 * @param value - Candidate day count from options/input.
 * @param fallback - Default day count used when input is invalid.
 * @returns Numeric result used by downstream logic.
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
 * - `Date.parse` timestamp math.
 *
 * @param earlierIso - Older/reference timestamp.
 * @param laterIso - Newer/comparison timestamp.
 * @returns Numeric result used by downstream logic.
 */
function daysBetween(earlierIso: string, laterIso: string): number {
  return Math.max(0, (Date.parse(laterIso) - Date.parse(earlierIso)) / (24 * 60 * 60 * 1_000));
}

/**
 * Adds whole days to an ISO timestamp and returns the resulting ISO string.
 *
 * **Why it exists:**
 * Cooldown windows in bridge policy are expressed in days.
 *
 * **What it talks to:**
 * - `Date.parse` and `Date#toISOString`.
 *
 * @param observedAt - Base timestamp for the offset.
 * @param days - Number of days to add.
 * @returns Future timestamp in ISO format.
 */
function addDays(observedAt: string, days: number): string {
  const observedAtMs = Date.parse(observedAt);
  const future = new Date(observedAtMs + days * 24 * 60 * 60 * 1_000);
  return future.toISOString();
}

/**
 * Converts values into conversation key form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for conversation key deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - `normalizeWhitespace` for stable thread-key text normalization.
 *
 * @param threadKey - Optional thread key from pulse/bridge context.
 * @returns Normalized key, or the global conversation sentinel when missing/blank.
 */
function toConversationKey(threadKey: string | null): string {
  const normalized = normalizeWhitespace(threadKey ?? "");
  return normalized || GLOBAL_CONVERSATION_KEY;
}

/**
 * Checks whether privacy keyword contains the required signal.
 *
 * **Why it exists:**
 * Makes privacy keyword containment checks explicit so threshold behavior is easy to audit.
 *
 * **What it talks to:**
 * - `PRIVACY_SENSITIVE_KEYWORDS` lexical set.
 *
 * @param value - Canonical name or alias text to inspect.
 * @returns `true` when this check/policy condition passes.
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
 * Finds bridge edge snapshot from available runtime state.
 *
 * **Why it exists:**
 * Keeps candidate selection logic for bridge edge snapshot centralized so outcomes stay consistent.
 *
 * **What it talks to:**
 * - `EntityGraphV1.edges` uncertain `co_mentioned` relationships.
 *
 * @param graph - Current relationship graph snapshot.
 * @param sourceEntityKey - First entity key in the target pair.
 * @param targetEntityKey - Second entity key in the target pair.
 * @returns Snapshot for the matching uncertain co-mention edge, or `null` when absent.
 */
function findBridgeEdgeSnapshot(
  graph: EntityGraphV1,
  sourceEntityKey: string,
  targetEntityKey: string
): BridgeEdgeSnapshotV1 | null {
  const pairKey = buildPairKey(sourceEntityKey, targetEntityKey);
  const edge = graph.edges.find((entry) => {
    if (entry.relationType !== "co_mentioned" || entry.status !== "uncertain") {
      return false;
    }
    const entryKey = buildPairKey(entry.sourceEntityKey, entry.targetEntityKey);
    return entryKey === pairKey;
  });
  if (!edge) {
    return null;
  }
  const [left, right] = normalizeEntityPair(edge.sourceEntityKey, edge.targetEntityKey);
  return {
    sourceEntityKey: left,
    targetEntityKey: right,
    coMentionCount: edge.coMentionCount,
    lastObservedAt: edge.lastObservedAt,
    evidenceRefs: [...edge.evidenceRefs].sort((a, b) => a.localeCompare(b))
  };
}

/**
 * Evaluates pair privacy sensitive and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the pair privacy sensitive policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - `EntityGraphV1.entities` metadata.
 * - Privacy-sensitive keyword/type allowlists and explicit opt-out keys.
 *
 * @param graph - Current relationship graph snapshot.
 * @param sourceEntityKey - First entity in the candidate pair.
 * @param targetEntityKey - Second entity in the candidate pair.
 * @param privacyOptOutEntityKeys - Set of entity keys explicitly excluded from bridge prompts.
 * @returns `true` when this check/policy condition passes.
 */
function isPairPrivacySensitive(
  graph: EntityGraphV1,
  sourceEntityKey: string,
  targetEntityKey: string,
  privacyOptOutEntityKeys: ReadonlySet<string>
): boolean {
  const entitiesByKey = new Map(graph.entities.map((entity) => [entity.entityKey, entity]));
  for (const entityKey of [sourceEntityKey, targetEntityKey]) {
    if (privacyOptOutEntityKeys.has(entityKey)) {
      return true;
    }
    const entity = entitiesByKey.get(entityKey);
    if (!entity) {
      return true;
    }
    if (PRIVACY_SENSITIVE_ENTITY_TYPES.has(entity.entityType)) {
      return true;
    }
    if (containsPrivacyKeyword(entity.canonicalName)) {
      return true;
    }
    if (entity.aliases.some((alias) => containsPrivacyKeyword(alias))) {
      return true;
    }
  }
  return false;
}

/**
 * Builds bridge conflict for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of bridge conflict consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `BridgeConflictCodeV1` (import `BridgeConflictCodeV1`) from `./types`.
 * - Uses `Stage686ConflictObjectV1` (import `Stage686ConflictObjectV1`) from `./types`.
 *
 * @param conflictCode - Typed bridge conflict category.
 * @param detail - Human-readable conflict detail.
 * @param observedAt - Timestamp when denial was evaluated.
 * @param evidenceRefs - Evidence references supporting the conflict decision.
 * @returns Structured Stage 6.86 conflict object.
 */
function buildBridgeConflict(
  conflictCode: BridgeConflictCodeV1,
  detail: string,
  observedAt: string,
  evidenceRefs: readonly string[]
): Stage686ConflictObjectV1 {
  return {
    conflictCode,
    detail,
    observedAt,
    evidenceRefs
  };
}

/**
 * Builds denied bridge result for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of denied bridge result consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `BridgeBlockCodeV1` (import `BridgeBlockCodeV1`) from `./types`.
 * - Uses `BridgeConflictCodeV1` (import `BridgeConflictCodeV1`) from `./types`.
 * - Uses `PulseBlockCodeV1` (import `PulseBlockCodeV1`) from `./types`.
 *
 * @param reason - Block reason code surfaced to pulse policy.
 * @param conflictCode - Bridge-specific conflict category.
 * @param detail - Human-readable detail for audit/debug output.
 * @param observedAt - Timestamp when denial was evaluated.
 * @param evidenceRefs - Evidence refs attached to the denied outcome.
 * @returns Standard denied bridge-evaluation result payload.
 */
function buildDeniedBridgeResult(
  reason: BridgeBlockCodeV1 | PulseBlockCodeV1,
  conflictCode: BridgeConflictCodeV1,
  detail: string,
  observedAt: string,
  evidenceRefs: readonly string[]
): EvaluateBridgeQuestionResultV1 {
  return {
    approved: false,
    blockCode: "PULSE_BLOCKED",
    blockDetailReason: reason,
    conflict: buildBridgeConflict(conflictCode, detail, observedAt, evidenceRefs),
    bridgeCandidate: null,
    bridgeQuestion: null,
    pulseEmitParams: null
  };
}

/**
 * Counts conversation bridge events for downstream policy and scoring decisions.
 *
 * **Why it exists:**
 * Keeps `count conversation bridge events` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Local `BridgeInteractionRecordV1` history filtering.
 *
 * @param history - Prior bridge interaction records.
 * @param conversationKey - Conversation bucket to count against cap rules.
 * @returns Numeric result used by downstream logic.
 */
function countConversationBridgeEvents(
  history: readonly BridgeInteractionRecordV1[],
  conversationKey: string
): number {
  return history.filter((entry) => {
    return (
      entry.conversationKey === conversationKey &&
      (entry.status === "asked" || entry.status === "confirmed" || entry.status === "deferred")
    );
  }).length;
}

/**
 * Reads pair deferral count needed for this execution step.
 *
 * **Why it exists:**
 * Separates pair deferral count read-path handling from orchestration and mutation code.
 *
 * **What it talks to:**
 * - Local history sorting/filtering for pair-specific bridge records.
 *
 * @param history - Prior bridge interaction records.
 * @param sourceEntityKey - First entity key in the pair.
 * @param targetEntityKey - Second entity key in the pair.
 * @returns Numeric result used by downstream logic.
 */
function getPairDeferralCount(
  history: readonly BridgeInteractionRecordV1[],
  sourceEntityKey: string,
  targetEntityKey: string
): number {
  const pairKey = buildPairKey(sourceEntityKey, targetEntityKey);
  const matches = history
    .filter((entry) => buildPairKey(entry.sourceEntityKey, entry.targetEntityKey) === pairKey)
    .sort((left, right) => right.askedAt.localeCompare(left.askedAt));
  if (!matches[0]) {
    return 0;
  }
  return Math.max(0, Math.floor(matches[0].deferralCount));
}

/**
 * Evaluates bridge cooldown active and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the bridge cooldown active policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Pair-key normalization and local history cooldown timestamps.
 *
 * @param history - Prior bridge interaction records.
 * @param sourceEntityKey - First entity key in the pair.
 * @param targetEntityKey - Second entity key in the pair.
 * @param observedAt - Candidate emission timestamp.
 * @returns `true` when this check/policy condition passes.
 */
function isBridgeCooldownActive(
  history: readonly BridgeInteractionRecordV1[],
  sourceEntityKey: string,
  targetEntityKey: string,
  observedAt: string
): boolean {
  const pairKey = buildPairKey(sourceEntityKey, targetEntityKey);
  return history.some((entry) => {
    if (buildPairKey(entry.sourceEntityKey, entry.targetEntityKey) !== pairKey) {
      return false;
    }
    return Date.parse(entry.cooldownUntil) >= Date.parse(observedAt);
  });
}

/**
 * Builds question id for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of question id consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `./normalizers/canonicalizationRules`.
 *
 * @param sourceEntityKey - First entity key in the bridge pair.
 * @param targetEntityKey - Second entity key in the bridge pair.
 * @param candidateId - Pulse candidate id backing this bridge question.
 * @param observedAt - Timestamp when the question is being emitted.
 * @returns Deterministic bridge question id derived from canonical hash input.
 */
function buildQuestionId(
  sourceEntityKey: string,
  targetEntityKey: string,
  candidateId: string,
  observedAt: string
): string {
  const fingerprint = sha256HexFromCanonicalJson({
    sourceEntityKey,
    targetEntityKey,
    candidateId,
    observedAt
  });
  return `bridge_q_${fingerprint.slice(0, 20)}`;
}

/**
 * Builds bridge prompt for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of bridge prompt consistent across call sites.
 *
 * **What it talks to:**
 * - Local deterministic prompt template only.
 *
 * @param sourceLabel - Human-readable label for source entity.
 * @param targetLabel - Human-readable label for target entity.
 * @returns Neutral, option-based bridge clarification prompt.
 */
function buildBridgePrompt(sourceLabel: string, targetLabel: string): string {
  return (
    `I noticed ${sourceLabel} and ${targetLabel} come up together. ` +
    "How would you describe their relationship: coworker, friend, family, project_related, other, or not related?"
  );
}

/**
 * Normalizes ordering and duplication for evidence refs.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for evidence refs in one place.
 *
 * **What it talks to:**
 * - `normalizeWhitespace` and local set-based deduplication.
 *
 * @param left - First evidence-ref list.
 * @param right - Second evidence-ref list.
 * @returns Ordered collection produced by this step.
 */
function mergeEvidenceRefs(left: readonly string[], right: readonly string[]): readonly string[] {
  return [...new Set([...left, ...right].map((entry) => normalizeWhitespace(entry)).filter(Boolean))].sort(
    (a, b) => a.localeCompare(b)
  );
}

/**
 * Migrates relation edge by pair fallback to the next deterministic lifecycle state.
 *
 * **Why it exists:**
 * Centralizes relation edge by pair fallback state-transition logic to keep evolution deterministic and reviewable.
 *
 * **What it talks to:**
 * - Uses `EntityGraphV1` (import `EntityGraphV1`) from `./types`.
 *
 * @param graph - Current entity graph snapshot.
 * @param sourceEntityKey - First entity key in the target pair.
 * @param targetEntityKey - Second entity key in the target pair.
 * @param relationType - User-confirmed relationship type to promote.
 * @param observedAt - Confirmation timestamp.
 * @param evidenceRef - Evidence reference for the promotion write.
 * @returns Updated graph plus promotion status.
 */
function promoteRelationEdgeByPairFallback(
  graph: EntityGraphV1,
  sourceEntityKey: string,
  targetEntityKey: string,
  relationType: BridgeRelationTypeV1,
  observedAt: string,
  evidenceRef: string
): { graph: EntityGraphV1; promoted: boolean } {
  const targetPairKey = buildPairKey(sourceEntityKey, targetEntityKey);
  let promoted = false;
  const nextEdges = graph.edges.map((edge) => {
    if (buildPairKey(edge.sourceEntityKey, edge.targetEntityKey) !== targetPairKey) {
      return edge;
    }
    promoted = true;
    return {
      ...edge,
      relationType,
      status: "confirmed" as const,
      lastObservedAt: observedAt,
      evidenceRefs: mergeEvidenceRefs(edge.evidenceRefs, [evidenceRef])
    };
  });

  if (!promoted) {
    return {
      graph,
      promoted: false
    };
  }

  return {
    graph: {
      ...graph,
      updatedAt: observedAt,
      edges: [...nextEdges].sort((left, right) => left.edgeKey.localeCompare(right.edgeKey))
    },
    promoted: true
  };
}

/**
 * Evaluates bridge question emission v1 and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the bridge question emission v1 policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `BridgeCandidateV1` (import `BridgeCandidateV1`) from `./types`.
 * - Uses `BridgeQuestionV1` (import `BridgeQuestionV1`) from `./types`.
 * - Uses `PulseEmitActionParams` (import `PulseEmitActionParams`) from `./types`.
 *
 * @param input - Graph/candidate context for one potential bridge prompt decision.
 * @param options - Optional threshold/cooldown/cap overrides (tightened by clamp guards).
 * @returns Approved bridge payload or a typed denied result with conflict metadata.
 */
export function evaluateBridgeQuestionEmissionV1(
  input: EvaluateBridgeQuestionInputV1,
  options: EvaluateBridgeQuestionOptionsV1 = {}
): EvaluateBridgeQuestionResultV1 {
  assertValidIsoTimestamp(input.observedAt, "observedAt");
  const coMentionThreshold = clampCount(options.coMentionThreshold, DEFAULT_CO_MENTION_THRESHOLD);
  const coMentionWindowDays = clampDays(options.coMentionWindowDays, DEFAULT_CO_MENTION_WINDOW_DAYS);
  const bridgeCooldownDays = clampDays(options.bridgeCooldownDays, DEFAULT_BRIDGE_COOLDOWN_DAYS);
  const bridgeMaxPerConversation = clampCount(
    options.bridgeMaxPerConversation,
    DEFAULT_BRIDGE_MAX_PER_CONVERSATION
  );
  const history = [...(input.recentBridgeHistory ?? [])]
    .filter((entry) => Number.isFinite(Date.parse(entry.askedAt)))
    .filter((entry) => Number.isFinite(Date.parse(entry.cooldownUntil)))
    .sort((left, right) => left.askedAt.localeCompare(right.askedAt));

  if (input.candidate.reasonCode !== "RELATIONSHIP_CLARIFICATION") {
    return buildDeniedBridgeResult(
      "BRIDGE_INSUFFICIENT_EVIDENCE",
      "INSUFFICIENT_EVIDENCE",
      "Bridge emission requires a RELATIONSHIP_CLARIFICATION pulse candidate.",
      input.observedAt,
      input.candidate.evidenceRefs
    );
  }
  if (input.candidate.entityRefs.length < 2) {
    return buildDeniedBridgeResult(
      "BRIDGE_INSUFFICIENT_EVIDENCE",
      "INSUFFICIENT_EVIDENCE",
      "Bridge emission requires exactly two entity refs.",
      input.observedAt,
      input.candidate.evidenceRefs
    );
  }

  const [sourceEntityKey, targetEntityKey] = normalizeEntityPair(
    input.candidate.entityRefs[0],
    input.candidate.entityRefs[1]
  );
  const bridgeEdge = findBridgeEdgeSnapshot(input.graph, sourceEntityKey, targetEntityKey);
  if (!bridgeEdge) {
    return buildDeniedBridgeResult(
      "BRIDGE_INSUFFICIENT_EVIDENCE",
      "INSUFFICIENT_EVIDENCE",
      "No uncertain co-mention edge exists for bridge pair.",
      input.observedAt,
      input.candidate.evidenceRefs
    );
  }
  if (bridgeEdge.coMentionCount < coMentionThreshold) {
    return buildDeniedBridgeResult(
      "BRIDGE_INSUFFICIENT_EVIDENCE",
      "INSUFFICIENT_EVIDENCE",
      "Bridge threshold not met for co-mention count.",
      input.observedAt,
      bridgeEdge.evidenceRefs
    );
  }
  if (daysBetween(bridgeEdge.lastObservedAt, input.observedAt) > coMentionWindowDays) {
    return buildDeniedBridgeResult(
      "BRIDGE_INSUFFICIENT_EVIDENCE",
      "INSUFFICIENT_EVIDENCE",
      "Bridge co-mention signal is outside allowed recency window.",
      input.observedAt,
      bridgeEdge.evidenceRefs
    );
  }
  if (input.activeMissionWorkExists) {
    return buildDeniedBridgeResult(
      "DERAILS_ACTIVE_MISSION",
      "DERAILS_ACTIVE_MISSION",
      "Bridge prompt suppressed because active mission work exists.",
      input.observedAt,
      input.candidate.evidenceRefs
    );
  }

  const privacyOptOutEntityKeys = new Set(
    (input.privacyOptOutEntityKeys ?? [])
      .map((entry) => normalizeWhitespace(entry))
      .filter((entry) => entry.length > 0)
  );
  if (isPairPrivacySensitive(input.graph, sourceEntityKey, targetEntityKey, privacyOptOutEntityKeys)) {
    return buildDeniedBridgeResult(
      "BRIDGE_PRIVACY_SENSITIVE",
      "PRIVACY_SENSITIVE",
      "Bridge prompt suppressed due privacy-sensitive entities.",
      input.observedAt,
      input.candidate.evidenceRefs
    );
  }

  const conversationKey = toConversationKey(input.candidate.threadKey);
  if (isBridgeCooldownActive(history, sourceEntityKey, targetEntityKey, input.observedAt)) {
    return buildDeniedBridgeResult(
      "BRIDGE_COOLDOWN_ACTIVE",
      "COOLDOWN_ACTIVE",
      "Bridge prompt suppressed because bridge cooldown is active for this pair.",
      input.observedAt,
      input.candidate.evidenceRefs
    );
  }

  if (countConversationBridgeEvents(history, conversationKey) >= bridgeMaxPerConversation) {
    return buildDeniedBridgeResult(
      "BRIDGE_CAP_REACHED",
      "CAP_REACHED",
      "Bridge prompt suppressed because per-conversation bridge cap is reached.",
      input.observedAt,
      input.candidate.evidenceRefs
    );
  }

  const entitiesByKey = new Map(input.graph.entities.map((entity) => [entity.entityKey, entity]));
  const sourceLabel = entitiesByKey.get(sourceEntityKey)?.canonicalName ?? sourceEntityKey;
  const targetLabel = entitiesByKey.get(targetEntityKey)?.canonicalName ?? targetEntityKey;
  const questionId = buildQuestionId(sourceEntityKey, targetEntityKey, input.candidate.candidateId, input.observedAt);
  const cooldownUntil = addDays(input.observedAt, bridgeCooldownDays);
  const question: BridgeQuestionV1 = {
    questionId,
    sourceEntityKey,
    targetEntityKey,
    prompt: buildBridgePrompt(sourceLabel, targetLabel),
    createdAt: input.observedAt,
    cooldownUntil,
    threadKey: input.candidate.threadKey,
    evidenceRefs: [...new Set([...bridgeEdge.evidenceRefs, ...input.candidate.evidenceRefs])].sort((a, b) =>
      a.localeCompare(b)
    ),
    sourceAuthority: input.candidate.sourceAuthority,
    provenanceTier: input.candidate.provenanceTier,
    sensitive: input.candidate.sensitive,
    activeMissionSuppressed: false
  };
  const bridgeCandidate: BridgeCandidateV1 = {
    candidateId: input.candidate.candidateId,
    sourceEntityKey,
    targetEntityKey,
    coMentionCount: bridgeEdge.coMentionCount,
    lastObservedAt: bridgeEdge.lastObservedAt,
    evidenceRefs: bridgeEdge.evidenceRefs,
    sourceAuthority: input.candidate.sourceAuthority,
    provenanceTier: input.candidate.provenanceTier,
    sensitive: input.candidate.sensitive,
    activeMissionSuppressed: false
  };
  const pulseEmitParams: PulseEmitActionParams = {
    kind: "bridge_question",
    reasonCode: "RELATIONSHIP_CLARIFICATION",
    threadKey: input.candidate.threadKey ?? undefined,
    entityRefs: [sourceEntityKey, targetEntityKey],
    evidenceRefs: question.evidenceRefs,
    sourceAuthority: input.candidate.sourceAuthority,
    provenanceTier: input.candidate.provenanceTier,
    sensitive: input.candidate.sensitive,
    activeMissionSuppressed: false,
    questionId,
    prompt: question.prompt,
    cooldownUntil,
    conversationKey
  };

  return {
    approved: true,
    blockCode: null,
    blockDetailReason: null,
    conflict: null,
    bridgeCandidate,
    bridgeQuestion: question,
    pulseEmitParams
  };
}

/**
 * Resolves bridge question answer v1 from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of bridge question answer v1 by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `promoteRelationEdgeWithConfirmation` (import `promoteRelationEdgeWithConfirmation`) from `./stage6_86EntityGraph`.
 *
 * @param input - Bridge question answer context (graph, question, answer, history, evidence).
 * @returns Updated graph outcome plus history record and optional denial conflict code.
 */
export function resolveBridgeQuestionAnswerV1(
  input: ResolveBridgeAnswerInputV1
): ResolveBridgeAnswerResultV1 {
  assertValidIsoTimestamp(input.observedAt, "observedAt");
  const bridgeCooldownDays = clampDays(input.bridgeCooldownDays, DEFAULT_BRIDGE_COOLDOWN_DAYS);
  const history = [...(input.recentBridgeHistory ?? [])]
    .filter((entry) => Number.isFinite(Date.parse(entry.askedAt)))
    .filter((entry) => Number.isFinite(Date.parse(entry.cooldownUntil)))
    .sort((left, right) => left.askedAt.localeCompare(right.askedAt));

  const [sourceEntityKey, targetEntityKey] = normalizeEntityPair(
    input.question.sourceEntityKey,
    input.question.targetEntityKey
  );
  const conversationKey = toConversationKey(input.question.threadKey ?? null);
  const priorDeferrals = getPairDeferralCount(history, sourceEntityKey, targetEntityKey);

  if (input.answer.kind === "confirmed") {
    if (!input.answer.relationType) {
      return {
        graph: input.graph,
        deniedConflictCode: "INSUFFICIENT_EVIDENCE",
        historyRecord: {
          questionId: input.question.questionId,
          conversationKey,
          sourceEntityKey,
          targetEntityKey,
          askedAt: input.observedAt,
          status: "deferred",
          cooldownUntil: addDays(input.observedAt, bridgeCooldownDays * 2),
          deferralCount: priorDeferrals + 1
        }
      };
    }
    const promoted = promoteRelationEdgeWithConfirmation(input.graph, {
      sourceEntityKey,
      targetEntityKey,
      relationType: input.answer.relationType,
      explicitUserConfirmation: true,
      observedAt: input.observedAt,
      evidenceRef: input.evidenceRef
    });
    const fallbackPromotion =
      !promoted.promoted && promoted.deniedConflictCode === "INSUFFICIENT_EVIDENCE"
        ? promoteRelationEdgeByPairFallback(
          input.graph,
          sourceEntityKey,
          targetEntityKey,
          input.answer.relationType,
          input.observedAt,
          input.evidenceRef
        )
        : {
          graph: promoted.graph,
          promoted: promoted.promoted
        };
    const finalGraph = fallbackPromotion.graph;
    const finalPromoted = fallbackPromotion.promoted;
    return {
      graph: finalGraph,
      deniedConflictCode: finalPromoted ? null : promoted.deniedConflictCode,
      historyRecord: {
        questionId: input.question.questionId,
        conversationKey,
        sourceEntityKey,
        targetEntityKey,
        askedAt: input.observedAt,
        status: finalPromoted ? "confirmed" : "deferred",
        cooldownUntil: addDays(input.observedAt, bridgeCooldownDays),
        deferralCount: priorDeferrals
      }
    };
  }

  const nextDeferralCount = priorDeferrals + 1;
  const backoffDays = bridgeCooldownDays * (1 + nextDeferralCount);
  return {
    graph: input.graph,
    deniedConflictCode: null,
    historyRecord: {
      questionId: input.question.questionId,
      conversationKey,
      sourceEntityKey,
      targetEntityKey,
      askedAt: input.observedAt,
      status: "deferred",
      cooldownUntil: addDays(input.observedAt, backoffDays),
      deferralCount: nextDeferralCount
    }
  };
}
