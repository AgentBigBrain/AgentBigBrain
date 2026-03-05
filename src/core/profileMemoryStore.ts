/**
 * @fileoverview Persists encrypted local profile memory with deterministic temporal freshness and access controls.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  assessProfileFactFreshness,
  DEFAULT_PROFILE_STALE_AFTER_DAYS,
  extractProfileFactCandidatesFromUserInput,
  markStaleFactsAsUncertain,
  normalizeProfileKey,
  normalizeProfileValue,
  ProfileMutationAuditMetadataV1,
  normalizeProfileMemoryState,
  ProfileFactRecord,
  ProfileFactUpsertInput,
  ProfileMemoryState,
  upsertTemporalProfileFact
} from "./profileMemory";
import {
  classifyCommitmentSignal,
  CommitmentSignalClassification,
  createCommitmentSignalRuleContext
} from "./commitmentSignalClassifier";
import { buildQueryAwarePlanningContext } from "./profileMemoryPlanningContext";
import {
  assertProfileMemoryKeyLength,
  decodeProfileMemoryEncryptionKey,
  decryptProfileMemoryState,
  EncryptedProfileEnvelopeV1,
  encryptProfileMemoryState
} from "./profileMemoryCrypto";
import {
  AgentPulseDecision,
  AgentPulsePolicyConfig,
  AgentPulseReason,
  evaluateAgentPulsePolicy
} from "./agentPulse";
import { ensureEnvLoaded } from "./envLoader";

const PROFILE_MEMORY_DEFAULT_FILE = "runtime/profile_memory.secure.json";

export type ProfileAccessPurpose = "planning_context" | "operator_view" | "governor_review";

export interface ProfileAccessRequest {
  purpose: ProfileAccessPurpose;
  includeSensitive: boolean;
  explicitHumanApproval?: boolean;
  approvalId?: string;
  maxFacts?: number;
}

export interface ProfileReadableFact {
  factId: string;
  key: string;
  value: string;
  status: ProfileFactRecord["status"];
  sensitive: boolean;
  observedAt: string;
  lastUpdatedAt: string;
  confidence: number;
  mutationAudit?: ProfileMutationAuditMetadataV1;
}

export interface ProfileIngestResult {
  appliedFacts: number;
  supersededFacts: number;
}

export interface AgentPulseEvaluationRequest {
  nowIso: string;
  userOptIn: boolean;
  reason: AgentPulseReason;
  contextualLinkageConfidence?: number;
  lastPulseSentAtIso: string | null;
  overrideQuietHours?: boolean;
}

export type AgentPulseRelationshipRole =
  | "friend"
  | "acquaintance"
  | "distant_relative"
  | "work_peer"
  | "manager"
  | "employee"
  | "neighbor"
  | "unknown";

export type AgentPulseContextDriftDomain = "job" | "team" | "location" | "contact";

export interface AgentPulseRelationshipAssessment {
  role: AgentPulseRelationshipRole;
  roleFactId: string | null;
}

export interface AgentPulseContextDriftAssessment {
  detected: boolean;
  domains: AgentPulseContextDriftDomain[];
  requiresRevalidation: boolean;
}

export interface AgentPulseEvaluationResult {
  decision: AgentPulseDecision;
  staleFactCount: number;
  unresolvedCommitmentCount: number;
  unresolvedCommitmentTopics: string[];
  relationship: AgentPulseRelationshipAssessment;
  contextDrift: AgentPulseContextDriftAssessment;
}

/**
 * Builds empty state for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of empty state consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `normalizeProfileMemoryState` (import `normalizeProfileMemoryState`) from `./profileMemory`.
 * - Uses `ProfileMemoryState` (import `ProfileMemoryState`) from `./profileMemory`.
 * @returns Computed `ProfileMemoryState` result.
 */
function createEmptyState(): ProfileMemoryState {
  return normalizeProfileMemoryState({});
}


/**
 * Evaluates approval valid and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the approval valid policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param request - Structured input object for this operation.
 * @returns `true` when this check passes.
 */
function isApprovalValid(request: ProfileAccessRequest): boolean {
  return (
    request.explicitHumanApproval === true &&
    typeof request.approvalId === "string" &&
    request.approvalId.trim().length > 0
  );
}

/**
 * Evaluates read sensitive facts and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the read sensitive facts policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param request - Structured input object for this operation.
 * @returns `true` when this check passes.
 */
function canReadSensitiveFacts(request: ProfileAccessRequest): boolean {
  if (!request.includeSensitive) {
    return false;
  }
  if (request.purpose !== "operator_view") {
    return false;
  }
  return isApprovalValid(request);
}

/**
 * Evaluates active fact and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the active fact policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `ProfileFactRecord` (import `ProfileFactRecord`) from `./profileMemory`.
 *
 * @param fact - Value for fact.
 * @returns `true` when this check passes.
 */
function isActiveFact(fact: ProfileFactRecord): boolean {
  return fact.status !== "superseded" && fact.supersededAt === null;
}

/**
 * Evaluates unresolved commitment fact and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the unresolved commitment fact policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `ProfileFactRecord` (import `ProfileFactRecord`) from `./profileMemory`.
 *
 * @param fact - Value for fact.
 * @returns `true` when this check passes.
 */
function isUnresolvedCommitmentFact(fact: ProfileFactRecord): boolean {
  if (!isActiveFact(fact)) {
    return false;
  }

  const key = fact.key.trim().toLowerCase();
  const unresolvedKeyPattern =
    /^(?:commitment|todo|task)(?:\.|$)|^follow(?:\.|)up[a-z0-9]*(?:\.|$)/;
  const unresolvedKey =
    key.startsWith("commitment.") ||
    key.startsWith("todo.") ||
    key.startsWith("followup.") ||
    unresolvedKeyPattern.test(key);
  if (!unresolvedKey) {
    return false;
  }

  return !valueIndicatesResolvedCommitmentMarker(fact.value);
}

/**
 * Counts stale active facts for downstream policy and scoring decisions.
 *
 * **Why it exists:**
 * Keeps `count stale active facts` behavior centralized so collaborating call sites stay consistent.
 *
 * **What it talks to:**
 * - Uses `assessProfileFactFreshness` (import `assessProfileFactFreshness`) from `./profileMemory`.
 * - Uses `ProfileMemoryState` (import `ProfileMemoryState`) from `./profileMemory`.
 *
 * @param state - Value for state.
 * @param staleAfterDays - Value for stale after days.
 * @param nowIso - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed numeric value.
 */
function countStaleActiveFacts(
  state: ProfileMemoryState,
  staleAfterDays: number,
  nowIso: string
): number {
  return state.facts.filter((fact) => {
    if (!isActiveFact(fact)) {
      return false;
    }
    return assessProfileFactFreshness(fact, staleAfterDays, nowIso).stale;
  }).length;
}

/**
 * Counts unresolved commitments for downstream policy and scoring decisions.
 *
 * **Why it exists:**
 * Keeps `count unresolved commitments` behavior centralized so collaborating call sites stay consistent.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryState` (import `ProfileMemoryState`) from `./profileMemory`.
 *
 * @param state - Value for state.
 * @returns Computed numeric value.
 */
function countUnresolvedCommitments(state: ProfileMemoryState): number {
  return state.facts.filter((fact) => isUnresolvedCommitmentFact(fact)).length;
}

const COMMITMENT_SIGNAL_RULE_CONTEXT = createCommitmentSignalRuleContext(null);

const SYSTEM_COMMITMENT_RECONCILIATION_TASK_ID = "profile_memory_reconciliation";

/**
 * Evaluates user input resolution classification and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the user input resolution classification policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `CommitmentSignalClassification` (import `CommitmentSignalClassification`) from `./commitmentSignalClassifier`.
 *
 * @param classification - Value for classification.
 * @returns `true` when this check passes.
 */
function isUserInputResolutionClassification(
  classification: CommitmentSignalClassification
): boolean {
  return (
    classification.category === "TOPIC_RESOLUTION_CANDIDATE" ||
    classification.category === "GENERIC_RESOLUTION"
  );
}

/**
 * Evaluates resolved marker classification and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the resolved marker classification policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `CommitmentSignalClassification` (import `CommitmentSignalClassification`) from `./commitmentSignalClassifier`.
 *
 * @param classification - Value for classification.
 * @returns `true` when this check passes.
 */
function isResolvedMarkerClassification(
  classification: CommitmentSignalClassification
): boolean {
  return classification.category === "RESOLVED_MARKER";
}

/**
 * Converts values into commitment mutation audit metadata form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for commitment mutation audit metadata deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses `CommitmentSignalClassification` (import `CommitmentSignalClassification`) from `./commitmentSignalClassifier`.
 * - Uses `ProfileMutationAuditMetadataV1` (import `ProfileMutationAuditMetadataV1`) from `./profileMemory`.
 *
 * @param classification - Value for classification.
 * @returns Computed `ProfileMutationAuditMetadataV1` result.
 */
function toCommitmentMutationAuditMetadata(
  classification: CommitmentSignalClassification
): ProfileMutationAuditMetadataV1 {
  return {
    classifier: "commitment_signal",
    category: classification.category,
    confidenceTier: classification.confidenceTier,
    matchedRuleId: classification.matchedRuleId,
    rulepackVersion: classification.rulepackVersion,
    conflict: classification.conflict
  };
}

/**
 * Classifies commitment signal for user input with deterministic rule logic.
 *
 * **Why it exists:**
 * Centralizes classification thresholds for commitment signal for user input so scoring behavior does not drift.
 *
 * **What it talks to:**
 * - Uses `classifyCommitmentSignal` (import `classifyCommitmentSignal`) from `./commitmentSignalClassifier`.
 * - Uses `CommitmentSignalClassification` (import `CommitmentSignalClassification`) from `./commitmentSignalClassifier`.
 *
 * @param userInput - Structured input object for this operation.
 * @returns Computed `CommitmentSignalClassification` result.
 */
function classifyCommitmentSignalForUserInput(
  userInput: string
): CommitmentSignalClassification {
  return classifyCommitmentSignal(userInput, {
    mode: "user_input",
    ruleContext: COMMITMENT_SIGNAL_RULE_CONTEXT
  });
}

/**
 * Classifies commitment signal for fact value with deterministic rule logic.
 *
 * **Why it exists:**
 * Centralizes classification thresholds for commitment signal for fact value so scoring behavior does not drift.
 *
 * **What it talks to:**
 * - Uses `classifyCommitmentSignal` (import `classifyCommitmentSignal`) from `./commitmentSignalClassifier`.
 * - Uses `CommitmentSignalClassification` (import `CommitmentSignalClassification`) from `./commitmentSignalClassifier`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `CommitmentSignalClassification` result.
 */
function classifyCommitmentSignalForFactValue(
  value: string
): CommitmentSignalClassification {
  return classifyCommitmentSignal(value, {
    mode: "fact_value",
    ruleContext: COMMITMENT_SIGNAL_RULE_CONTEXT
  });
}

/**
 * Implements value indicates resolved commitment marker behavior used by `profileMemoryStore`.
 *
 * **Why it exists:**
 * Keeps `value indicates resolved commitment marker` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns `true` when this check passes.
 */
function valueIndicatesResolvedCommitmentMarker(value: string): boolean {
  const classification = classifyCommitmentSignalForFactValue(value);
  return !classification.conflict && isResolvedMarkerClassification(classification);
}

/**
 * Reads unresolved commitment facts needed for this execution step.
 *
 * **Why it exists:**
 * Separates unresolved commitment facts read-path handling from orchestration and mutation code.
 *
 * **What it talks to:**
 * - Uses `ProfileFactRecord` (import `ProfileFactRecord`) from `./profileMemory`.
 * - Uses `ProfileMemoryState` (import `ProfileMemoryState`) from `./profileMemory`.
 *
 * @param state - Value for state.
 * @returns Ordered collection produced by this step.
 */
function listUnresolvedCommitmentFacts(state: ProfileMemoryState): ProfileFactRecord[] {
  return state.facts
    .filter((fact) => isUnresolvedCommitmentFact(fact))
    .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt));
}

/**
 * Normalizes commitment topic text into a stable shape for `profileMemoryStore` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for commitment topic text so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeCommitmentTopicText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Implements looks like sensitive topic text behavior used by `profileMemoryStore`.
 *
 * **Why it exists:**
 * Keeps `looks like sensitive topic text` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns `true` when this check passes.
 */
function looksLikeSensitiveTopicText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  if (/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(normalized)) {
    return true;
  }
  if (/\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/.test(normalized)) {
    return true;
  }
  return false;
}

/**
 * Implements topic from commitment key behavior used by `profileMemoryStore`.
 *
 * **Why it exists:**
 * Keeps `topic from commitment key` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param key - Lookup key or map field identifier.
 * @returns Computed `string | null` result.
 */
function topicFromCommitmentKey(key: string): string | null {
  const normalized = key.trim().toLowerCase();
  const followupPrefixed = normalized.match(/^follow(?:\.|)up[a-z0-9]*\.(.+)$/);
  if (followupPrefixed) {
    const topic = normalizeCommitmentTopicText(followupPrefixed[1]);
    return topic || null;
  }

  const genericPrefixed = normalized.match(/^(?:todo|task|commitment)\.(.+)$/);
  if (!genericPrefixed) {
    return null;
  }

  const topic = normalizeCommitmentTopicText(genericPrefixed[1]);
  if (!topic || topic === "item" || topic === "current" || topic === "status") {
    return null;
  }
  return topic;
}

/**
 * Implements topic from commitment value behavior used by `profileMemoryStore`.
 *
 * **Why it exists:**
 * Keeps `topic from commitment value` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `string | null` result.
 */
function topicFromCommitmentValue(value: string): string | null {
  const normalized = normalizeCommitmentTopicText(value);
  if (!normalized || looksLikeSensitiveTopicText(normalized)) {
    return null;
  }
  const words = normalized.split(" ").filter((word) => word.length > 0);
  if (words.length === 0) {
    return null;
  }
  return words.slice(0, 6).join(" ");
}

/**
 * Derives unresolved commitment topics from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for unresolved commitment topics in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryState` (import `ProfileMemoryState`) from `./profileMemory`.
 *
 * @param state - Value for state.
 * @param maxTopics - Numeric bound, counter, or index used by this logic.
 * @returns Ordered collection produced by this step.
 */
function extractUnresolvedCommitmentTopics(
  state: ProfileMemoryState,
  maxTopics = 3
): string[] {
  const unresolvedFacts = listUnresolvedCommitmentFacts(state).filter(
    (fact) => !fact.sensitive
  );

  const topics: string[] = [];
  const seenTopics = new Set<string>();
  for (const fact of unresolvedFacts) {
    const topic =
      topicFromCommitmentKey(fact.key) ?? topicFromCommitmentValue(fact.value);
    if (!topic) {
      continue;
    }
    if (seenTopics.has(topic)) {
      continue;
    }
    seenTopics.add(topic);
    topics.push(topic);
    if (topics.length >= Math.max(1, maxTopics)) {
      break;
    }
  }

  return topics;
}

/**
 * Builds inferred commitment resolution candidates for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of inferred commitment resolution candidates consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `normalizeProfileKey` (import `normalizeProfileKey`) from `./profileMemory`.
 * - Uses `ProfileFactUpsertInput` (import `ProfileFactUpsertInput`) from `./profileMemory`.
 * - Uses `ProfileMemoryState` (import `ProfileMemoryState`) from `./profileMemory`.
 *
 * @param state - Value for state.
 * @param userInput - Structured input object for this operation.
 * @param sourceTaskId - Stable identifier used to reference an entity or record.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Ordered collection produced by this step.
 */
function buildInferredCommitmentResolutionCandidates(
  state: ProfileMemoryState,
  userInput: string,
  sourceTaskId: string,
  observedAt: string
): ProfileFactUpsertInput[] {
  const classification = classifyCommitmentSignalForUserInput(userInput);
  if (!isUserInputResolutionClassification(classification) || classification.conflict) {
    return [];
  }

  const unresolvedFacts = listUnresolvedCommitmentFacts(state);
  if (unresolvedFacts.length === 0) {
    return [];
  }

  const normalizedInput = normalizeCommitmentTopicText(userInput);
  const unresolvedCandidates = unresolvedFacts.map((fact) => ({
    fact,
    topic: topicFromCommitmentKey(fact.key) ?? topicFromCommitmentValue(fact.value)
  }));
  const topicMatches = unresolvedCandidates.filter(
    (candidate) => candidate.topic && normalizedInput.includes(candidate.topic)
  );

  const targets =
    topicMatches.length > 0
      ? topicMatches
      : (classification.category === "GENERIC_RESOLUTION" &&
          unresolvedCandidates.length === 1
        ? unresolvedCandidates
        : []);

  const resolved: ProfileFactUpsertInput[] = [];
  const seenKeys = new Set<string>();
  for (const target of targets) {
    const normalizedKey = normalizeProfileKey(target.fact.key);
    if (!normalizedKey || seenKeys.has(normalizedKey)) {
      continue;
    }
    seenKeys.add(normalizedKey);
    resolved.push({
      key: normalizedKey,
      value: "resolved",
      sensitive: target.fact.sensitive,
      sourceTaskId,
      source: "user_input_pattern.followup_resolved_inferred",
      observedAt,
      confidence: 0.9,
      mutationAudit: toCommitmentMutationAuditMetadata(classification)
    });
  }

  return resolved;
}

/**
 * Derives topic tokens from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for topic tokens in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param topic - Value for topic.
 * @returns Ordered collection produced by this step.
 */
function extractTopicTokens(topic: string): string[] {
  return normalizeCommitmentTopicText(topic)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

/**
 * Implements topics likely match behavior used by `profileMemoryStore`.
 *
 * **Why it exists:**
 * Keeps `topics likely match` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param sourceTopic - Value for source topic.
 * @param targetTopic - Value for target topic.
 * @returns `true` when this check passes.
 */
function topicsLikelyMatch(sourceTopic: string, targetTopic: string): boolean {
  const sourceTokens = extractTopicTokens(sourceTopic);
  const targetTokens = extractTopicTokens(targetTopic);
  if (sourceTokens.length === 0 || targetTokens.length === 0) {
    return false;
  }

  const sourceSet = new Set(sourceTokens);
  const targetSet = new Set(targetTokens);
  const sourceSubset = sourceTokens.every((token) => targetSet.has(token));
  const targetSubset = targetTokens.every((token) => sourceSet.has(token));
  return sourceSubset || targetSubset;
}

interface ProfileFactCandidateApplyResult {
  nextState: ProfileMemoryState;
  appliedFacts: number;
  supersededFacts: number;
}

/**
 * Executes profile fact candidates as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the profile fact candidates runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `ProfileFactUpsertInput` (import `ProfileFactUpsertInput`) from `./profileMemory`.
 * - Uses `ProfileMemoryState` (import `ProfileMemoryState`) from `./profileMemory`.
 * - Uses `upsertTemporalProfileFact` (import `upsertTemporalProfileFact`) from `./profileMemory`.
 *
 * @param state - Value for state.
 * @param candidates - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed `ProfileFactCandidateApplyResult` result.
 */
function applyProfileFactCandidates(
  state: ProfileMemoryState,
  candidates: ProfileFactUpsertInput[]
): ProfileFactCandidateApplyResult {
  const dedupedCandidates = dedupeProfileFactCandidates(candidates);
  if (dedupedCandidates.length === 0) {
    return {
      nextState: state,
      appliedFacts: 0,
      supersededFacts: 0
    };
  }

  let nextState = state;
  let supersededFacts = 0;
  for (const candidate of dedupedCandidates) {
    const upserted = upsertTemporalProfileFact(nextState, candidate);
    nextState = upserted.nextState;
    supersededFacts += upserted.supersededFactIds.length;
  }

  return {
    nextState,
    appliedFacts: dedupedCandidates.length,
    supersededFacts
  };
}

/**
 * Builds state reconciliation resolution candidates for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of state reconciliation resolution candidates consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `normalizeProfileKey` (import `normalizeProfileKey`) from `./profileMemory`.
 * - Uses `ProfileFactUpsertInput` (import `ProfileFactUpsertInput`) from `./profileMemory`.
 * - Uses `ProfileMemoryState` (import `ProfileMemoryState`) from `./profileMemory`.
 *
 * @param state - Value for state.
 * @param observedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Ordered collection produced by this step.
 */
function buildStateReconciliationResolutionCandidates(
  state: ProfileMemoryState,
  observedAt: string
): ProfileFactUpsertInput[] {
  const unresolvedFacts = listUnresolvedCommitmentFacts(state);
  if (unresolvedFacts.length === 0) {
    return [];
  }

  const resolvedTopicEntries = state.facts
    .filter((fact) => isActiveFact(fact) && !isUnresolvedCommitmentFact(fact))
    .flatMap((fact) => {
      const classification = classifyCommitmentSignalForFactValue(fact.value);
      if (!isResolvedMarkerClassification(classification) || classification.conflict) {
        return [];
      }
      const topic = normalizeCommitmentTopicText(fact.key);
      if (topic.length === 0) {
        return [];
      }
      return [{
        topic,
        classification
      }];
    });
  if (resolvedTopicEntries.length === 0) {
    return [];
  }

  const candidates: ProfileFactUpsertInput[] = [];
  const seenKeys = new Set<string>();
  for (const unresolvedFact of unresolvedFacts) {
    const unresolvedTopic =
      topicFromCommitmentKey(unresolvedFact.key) ??
      topicFromCommitmentValue(unresolvedFact.value);
    if (!unresolvedTopic) {
      continue;
    }

    const matchedResolvedEntry = resolvedTopicEntries.find((entry) =>
      topicsLikelyMatch(unresolvedTopic, entry.topic)
    );
    if (!matchedResolvedEntry) {
      continue;
    }

    const normalizedKey = normalizeProfileKey(unresolvedFact.key);
    if (!normalizedKey || seenKeys.has(normalizedKey)) {
      continue;
    }
    seenKeys.add(normalizedKey);
    candidates.push({
      key: normalizedKey,
      value: "resolved",
      sensitive: unresolvedFact.sensitive,
      sourceTaskId: SYSTEM_COMMITMENT_RECONCILIATION_TASK_ID,
      source: "profile_state_reconciliation.followup_resolved",
      observedAt,
      confidence: 0.9,
      mutationAudit: toCommitmentMutationAuditMetadata(matchedResolvedEntry.classification)
    });
  }

  return candidates;
}

/**
 * Normalizes ordering and duplication for profile fact candidates.
 *
 * **Why it exists:**
 * Maintains stable ordering and deduplication rules for profile fact candidates in one place.
 *
 * **What it talks to:**
 * - Uses `normalizeProfileKey` (import `normalizeProfileKey`) from `./profileMemory`.
 * - Uses `normalizeProfileValue` (import `normalizeProfileValue`) from `./profileMemory`.
 * - Uses `ProfileFactUpsertInput` (import `ProfileFactUpsertInput`) from `./profileMemory`.
 *
 * @param candidates - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Ordered collection produced by this step.
 */
function dedupeProfileFactCandidates(
  candidates: ProfileFactUpsertInput[]
): ProfileFactUpsertInput[] {
  const deduped: ProfileFactUpsertInput[] = [];
  const seen = new Set<string>();

  for (const candidate of candidates) {
    const normalizedKey = normalizeProfileKey(candidate.key);
    const normalizedValue = normalizeProfileValue(candidate.value);
    if (!normalizedKey || !normalizedValue) {
      continue;
    }
    const signature = `${normalizedKey}=${normalizedValue.toLowerCase()}`;
    if (seen.has(signature)) {
      continue;
    }
    seen.add(signature);
    deduped.push({
      ...candidate,
      key: normalizedKey,
      value: normalizedValue
    });
  }

  return deduped;
}

const RELATIONSHIP_FACT_KEY_HINTS = [
  "relationship",
  "friend",
  "acquaintance",
  "relative",
  "manager",
  "employee",
  "coworker",
  "colleague",
  "teammate",
  "peer",
  "neighbor",
  "boss",
  "supervisor",
  "report"
];

const RELATIONSHIP_ROLE_ALIASES: Record<
  Exclude<AgentPulseRelationshipRole, "unknown">,
  string[]
> = {
  friend: ["friend"],
  acquaintance: ["acquaintance"],
  distant_relative: [
    "distant_relative",
    "distant relative",
    "relative",
    "cousin",
    "aunt",
    "uncle"
  ],
  work_peer: ["work_peer", "work peer", "coworker", "colleague", "teammate", "peer"],
  manager: ["manager", "boss", "supervisor", "team lead", "lead"],
  employee: ["employee", "direct report", "report"],
  neighbor: ["neighbor", "neighbour"]
};

const RELATIONSHIP_ROLE_SUPPRESSION_SET = new Set<AgentPulseRelationshipRole>([
  "acquaintance",
  "distant_relative"
]);

/**
 * Normalizes fact text into a stable shape for `profileMemoryStore` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for fact text so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeFactText(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s-]+/g, " ");
}

/**
 * Derives relationship role from text from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for relationship role from text in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `Exclude<AgentPulseRelationshipRole, "unknown"> | undefined` result.
 */
function inferRelationshipRoleFromText(
  value: string
): Exclude<AgentPulseRelationshipRole, "unknown"> | undefined {
  const normalized = normalizeFactText(value);
  const roles = Object.entries(RELATIONSHIP_ROLE_ALIASES) as Array<
    [Exclude<AgentPulseRelationshipRole, "unknown">, string[]]
  >;
  for (const [role, aliases] of roles) {
    if (aliases.some((alias) => normalized.includes(normalizeFactText(alias)))) {
      return role;
    }
  }
  return undefined;
}

/**
 * Derives relationship role from fact from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for relationship role from fact in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses `ProfileFactRecord` (import `ProfileFactRecord`) from `./profileMemory`.
 *
 * @param fact - Value for fact.
 * @returns Computed `Exclude<AgentPulseRelationshipRole, "unknown"> | undefined` result.
 */
function inferRelationshipRoleFromFact(
  fact: ProfileFactRecord
): Exclude<AgentPulseRelationshipRole, "unknown"> | undefined {
  const normalizedKey = fact.key.trim().toLowerCase();
  const keyLooksRelationshipSpecific = RELATIONSHIP_FACT_KEY_HINTS.some((hint) =>
    normalizedKey.includes(hint)
  );
  if (!keyLooksRelationshipSpecific && !normalizedKey.startsWith("relationship.")) {
    return undefined;
  }

  return (
    inferRelationshipRoleFromText(normalizedKey) ||
    inferRelationshipRoleFromText(fact.value)
  );
}

/**
 * Implements assess relationship role behavior used by `profileMemoryStore`.
 *
 * **Why it exists:**
 * Keeps `assess relationship role` behavior centralized so collaborating call sites stay consistent.
 *
 * **What it talks to:**
 * - Uses `ProfileMemoryState` (import `ProfileMemoryState`) from `./profileMemory`.
 *
 * @param state - Value for state.
 * @returns Computed `AgentPulseRelationshipAssessment` result.
 */
function assessRelationshipRole(
  state: ProfileMemoryState
): AgentPulseRelationshipAssessment {
  const activeFacts = state.facts
    .filter((fact) => isActiveFact(fact))
    .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt));

  for (const fact of activeFacts) {
    const role = inferRelationshipRoleFromFact(fact);
    if (!role) {
      continue;
    }
    return {
      role,
      roleFactId: fact.id
    };
  }

  return {
    role: "unknown",
    roleFactId: null
  };
}

/**
 * Converts values into context drift domain form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for context drift domain deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param factKey - Lookup key or map field identifier.
 * @returns Computed `AgentPulseContextDriftDomain | null` result.
 */
function toContextDriftDomain(factKey: string): AgentPulseContextDriftDomain | null {
  const normalized = factKey.trim().toLowerCase();
  if (normalized.startsWith("team.") || normalized.includes(".team")) {
    return "team";
  }
  if (normalized.startsWith("employment.") || normalized.includes("job")) {
    return "job";
  }
  if (
    normalized.startsWith("residence.") ||
    normalized.startsWith("location.") ||
    normalized.includes(".location")
  ) {
    return "location";
  }
  if (
    normalized.startsWith("contact.") ||
    normalized.includes("email") ||
    normalized.includes("phone")
  ) {
    return "contact";
  }
  return null;
}

/**
 * Assesses profile-domain context drift signals from current fact states.
 *
 * **Why it exists:**
 * Pulse decisions should avoid nudging users when relationship/contact/location context has drifted
 * into uncertain/superseded territory and likely needs revalidation.
 *
 * **What it talks to:**
 * - Uses profile fact-key domain mapping and active/superseded status checks.
 *
 * @param state - Current normalized profile state.
 * @returns Drift assessment with affected domains and revalidation requirement.
 */
function assessContextDrift(
  state: ProfileMemoryState
): AgentPulseContextDriftAssessment {
  const domains = new Set<AgentPulseContextDriftDomain>();
  for (const fact of state.facts) {
    const domain = toContextDriftDomain(fact.key);
    if (!domain) {
      continue;
    }

    const supersededSignal = fact.status === "superseded";
    const uncertainActiveSignal = isActiveFact(fact) && fact.status === "uncertain";
    if (supersededSignal || uncertainActiveSignal) {
      domains.add(domain);
    }
  }

  const sortedDomains = [...domains].sort();
  return {
    detected: sortedDomains.length > 0,
    domains: sortedDomains,
    requiresRevalidation: sortedDomains.length > 0
  };
}

/**
 * Applies relationship/context-aware suppression on top of base pulse policy decisions.
 *
 * **Why it exists:**
 * Even when baseline pulse policy allows a nudge, relationship role or context drift may require a
 * stricter fail-closed suppression to avoid awkward or unsafe follow-up behavior.
 *
 * **What it talks to:**
 * - Uses `AgentPulseDecision` (import `AgentPulseDecision`) from `./agentPulse`.
 *
 * @param baseDecision - Result from core pulse policy evaluation.
 * @param request - Pulse evaluation request metadata.
 * @param relationship - Relationship-role assessment derived from profile facts.
 * @param contextDrift - Drift assessment derived from profile fact status/domain signals.
 * @returns Final pulse decision after relationship/context nudging rules.
 */
function applyRelationshipAwareTemporalNudging(
  baseDecision: AgentPulseDecision,
  request: AgentPulseEvaluationRequest,
  relationship: AgentPulseRelationshipAssessment,
  contextDrift: AgentPulseContextDriftAssessment
): AgentPulseDecision {
  if (!baseDecision.allowed) {
    return baseDecision;
  }

  if (
    request.reason === "unresolved_commitment" &&
    RELATIONSHIP_ROLE_SUPPRESSION_SET.has(relationship.role)
  ) {
    return {
      allowed: false,
      decisionCode: "RELATIONSHIP_ROLE_SUPPRESSED",
      suppressedBy: [`relationship.role.${relationship.role}`],
      nextEligibleAtIso: null
    };
  }

  if (
    request.reason === "unresolved_commitment" &&
    contextDrift.detected &&
    relationship.role === "unknown"
  ) {
    return {
      allowed: false,
      decisionCode: "CONTEXT_DRIFT_SUPPRESSED",
      suppressedBy: [
        "context_drift.requires_revalidation",
        ...contextDrift.domains.map((domain) => `context_drift.${domain}`)
      ],
      nextEligibleAtIso: null
    };
  }

  return baseDecision;
}

export class ProfileMemoryStore {
  /**
   * Creates the encrypted profile-memory persistence service.
   *
   * **Why it exists:**
   * Runtime profile features (planning context, fact reads, pulse continuity) need one deterministic
   * service that enforces key length, storage path, and stale-fact policy.
   *
   * **What it talks to:**
   * - Validates encryption key length via `assertProfileMemoryKeyLength`.
   */
  constructor(
    private readonly filePath: string,
    private readonly encryptionKey: Buffer,
    private readonly staleAfterDays: number = DEFAULT_PROFILE_STALE_AFTER_DAYS
  ) {
    assertProfileMemoryKeyLength(encryptionKey);
  }

  /**
   * Builds a `ProfileMemoryStore` from environment configuration.
   *
   * **Why it exists:**
   * Startup wiring needs one place that interprets enable/disable flags, key requirements, and
   * stale-threshold defaults before constructing the store.
   *
   * **What it talks to:**
   * - Uses `ensureEnvLoaded` (import `ensureEnvLoaded`) from `./envLoader`.
   * - Uses `DEFAULT_PROFILE_STALE_AFTER_DAYS` (import `DEFAULT_PROFILE_STALE_AFTER_DAYS`) from `./profileMemory`.
   * - Uses `decodeProfileMemoryEncryptionKey` (import `decodeProfileMemoryEncryptionKey`) from `./profileMemoryCrypto`.
   *
   * @param env - Environment source (defaults to process env).
   * @returns Configured store instance, or `undefined` when profile memory is disabled.
   */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): ProfileMemoryStore | undefined {
    if (env === process.env) {
      ensureEnvLoaded();
    }

    const enabled = (env.BRAIN_PROFILE_MEMORY_ENABLED ?? "false").trim().toLowerCase();
    if (!["1", "true", "yes", "on"].includes(enabled)) {
      return undefined;
    }

    const keyRaw = env.BRAIN_PROFILE_ENCRYPTION_KEY;
    if (!keyRaw) {
      throw new Error(
        "Profile memory is enabled but BRAIN_PROFILE_ENCRYPTION_KEY is missing."
      );
    }

    const staleAfterDays = Number(env.BRAIN_PROFILE_STALE_AFTER_DAYS);
    const normalizedStaleAfterDays =
      Number.isFinite(staleAfterDays) && staleAfterDays > 0
        ? Math.floor(staleAfterDays)
        : DEFAULT_PROFILE_STALE_AFTER_DAYS;

    return new ProfileMemoryStore(
      env.BRAIN_PROFILE_MEMORY_PATH?.trim() || PROFILE_MEMORY_DEFAULT_FILE,
      decodeProfileMemoryEncryptionKey(keyRaw),
      normalizedStaleAfterDays
    );
  }

  /**
   * Loads encrypted profile memory, applies deterministic reconciliation, and returns state.
   *
   * **Why it exists:**
   * Profile reads are not a pure file fetch: stale-fact downgrades and commitment reconciliation
   * can mutate state and must be persisted immediately to keep subsequent reads consistent.
   *
   * **What it talks to:**
   * - Uses `markStaleFactsAsUncertain` (import `markStaleFactsAsUncertain`) from `./profileMemory`.
   * - Uses `ProfileMemoryState` (import `ProfileMemoryState`) from `./profileMemory`.
   * - Uses `decryptProfileMemoryState` (import `decryptProfileMemoryState`) from `./profileMemoryCrypto`.
   * - Uses `EncryptedProfileEnvelopeV1` (import `EncryptedProfileEnvelopeV1`) from `./profileMemoryCrypto`.
   * - Uses `readFile` (import `readFile`) from `node:fs/promises`.
   * @returns Normalized profile state, persisted if reconciliation made deterministic changes.
   */
  async load(): Promise<ProfileMemoryState> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const envelope = JSON.parse(raw) as EncryptedProfileEnvelopeV1;
      const state = decryptProfileMemoryState(envelope, this.encryptionKey);
      const staleResult = markStaleFactsAsUncertain(
        state,
        this.staleAfterDays
      );
      let nextState = staleResult.nextState;
      let shouldPersist = staleResult.updatedFactIds.length > 0;

      const reconciliationCandidates = buildStateReconciliationResolutionCandidates(
        nextState,
        new Date().toISOString()
      );
      const reconciliationResult = applyProfileFactCandidates(
        nextState,
        reconciliationCandidates
      );
      if (reconciliationResult.appliedFacts > 0) {
        nextState = reconciliationResult.nextState;
        shouldPersist = true;
      }

      if (shouldPersist) {
        await this.save(nextState);
      }
      return nextState;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return createEmptyState();
      }
      throw error;
    }
  }

  /**
   * Extracts and applies profile-memory mutations from one task/user input.
   *
   * **Why it exists:**
   * Ingestion combines multiple deterministic candidate sources (pattern extraction + commitment
   * resolution inference) and persists the merged result as one atomic update path.
   *
   * **What it talks to:**
   * - Uses `extractProfileFactCandidatesFromUserInput` (import `extractProfileFactCandidatesFromUserInput`) from `./profileMemory`.
   *
   * @param taskId - Task identifier attached to generated fact metadata.
   * @param userInput - Raw user text to mine for profile candidates.
   * @param observedAt - Observation timestamp for generated candidates.
   * @returns Counts of applied and superseded facts.
   */
  async ingestFromTaskInput(
    taskId: string,
    userInput: string,
    observedAt: string
  ): Promise<ProfileIngestResult> {
    const state = await this.load();
    const extractedCandidates = extractProfileFactCandidatesFromUserInput(
      userInput,
      taskId,
      observedAt
    );
    const inferredResolutionCandidates = buildInferredCommitmentResolutionCandidates(
      state,
      userInput,
      taskId,
      observedAt
    );
    const candidates = [
      ...extractedCandidates,
      ...inferredResolutionCandidates
    ];
    const applyResult = applyProfileFactCandidates(state, candidates);
    if (applyResult.appliedFacts === 0) {
      return {
        appliedFacts: 0,
        supersededFacts: 0
      };
    }

    await this.save(applyResult.nextState);
    return {
      appliedFacts: applyResult.appliedFacts,
      supersededFacts: applyResult.supersededFacts
    };
  }

  /**
   * Builds planner-facing profile context with query-aware ranking/selection.
   *
   * **Why it exists:**
   * Planner prompts should include only a bounded, relevant subset of active non-sensitive facts,
   * and that selection should remain deterministic for similar query inputs.
   *
   * **What it talks to:**
   * - Uses `buildQueryAwarePlanningContext` (import `buildQueryAwarePlanningContext`) from `./profileMemoryPlanningContext`.
   *
   * @param maxFacts - Maximum number of facts to include in returned context.
   * @param queryInput - Current user/planner query used for relevance scoring.
   * @returns Rendered profile context block for planner prompt injection.
   */
  async getPlanningContext(maxFacts = 6, queryInput = ""): Promise<string> {
    const state = await this.load();
    return buildQueryAwarePlanningContext(state, maxFacts, queryInput);
  }

  /**
   * Evaluates Agent Pulse eligibility using profile-derived continuity signals.
   *
   * **Why it exists:**
   * Pulse decisions combine policy-level gates with profile-specific continuity context (staleness,
   * unresolved commitments, relationship role, and context drift). This method composes those
   * signals into one deterministic decision payload.
   *
   * **What it talks to:**
   * - Uses `AgentPulsePolicyConfig` (import `AgentPulsePolicyConfig`) from `./agentPulse`.
   * - Uses `evaluateAgentPulsePolicy` (import `evaluateAgentPulsePolicy`) from `./agentPulse`.
   *
   * @param policy - Global pulse policy configuration.
   * @param request - Per-evaluation request context and reason metadata.
   * @returns Decision + supporting continuity diagnostics for traceability.
   */
  async evaluateAgentPulse(
    policy: AgentPulsePolicyConfig,
    request: AgentPulseEvaluationRequest
  ): Promise<AgentPulseEvaluationResult> {
    const state = await this.load();
    const staleFactCount = countStaleActiveFacts(state, this.staleAfterDays, request.nowIso);
    const unresolvedCommitmentCount = countUnresolvedCommitments(state);
    const unresolvedCommitmentTopics = extractUnresolvedCommitmentTopics(state);
    const relationship = assessRelationshipRole(state);
    const contextDrift = assessContextDrift(state);

    const baseDecision = evaluateAgentPulsePolicy(policy, {
      nowIso: request.nowIso,
      userOptIn: request.userOptIn,
      reason: request.reason,
      staleFactCount,
      unresolvedCommitmentCount,
      contextualLinkageConfidence: request.contextualLinkageConfidence,
      lastPulseSentAtIso: request.lastPulseSentAtIso,
      overrideQuietHours: request.overrideQuietHours === true
    });
    const decision = applyRelationshipAwareTemporalNudging(
      baseDecision,
      request,
      relationship,
      contextDrift
    );

    return {
      decision,
      staleFactCount,
      unresolvedCommitmentCount,
      unresolvedCommitmentTopics,
      relationship,
      contextDrift
    };
  }

  /**
   * Returns readable profile facts under approval-aware sensitivity gating.
   *
   * **Why it exists:**
   * Interfaces and operators need fact visibility, but sensitive facts must stay hidden unless the
   * access request carries explicit valid approval metadata.
   *
   * **What it talks to:**
   * - Uses sensitivity gating helpers and active-fact filtering in this module.
   *
   * @param request - Access request with purpose/approval/maxFacts controls.
   * @returns Sorted readable fact entries filtered by sensitivity rules.
   */
  async readFacts(request: ProfileAccessRequest): Promise<ProfileReadableFact[]> {
    const state = await this.load();
    const activeFacts = state.facts
      .filter((fact) => isActiveFact(fact))
      .sort((left, right) => Date.parse(right.lastUpdatedAt) - Date.parse(left.lastUpdatedAt));

    const sensitiveAllowed = canReadSensitiveFacts(request);
    const maxFacts = Math.max(1, request.maxFacts ?? 20);
    const readable = activeFacts
      .filter((fact) => sensitiveAllowed || !fact.sensitive)
      .slice(0, maxFacts)
      .map((fact) => ({
        factId: fact.id,
        key: fact.key,
        value: fact.value,
        status: fact.status,
        sensitive: fact.sensitive,
        observedAt: fact.observedAt,
        lastUpdatedAt: fact.lastUpdatedAt,
        confidence: fact.confidence,
        mutationAudit: fact.mutationAudit
      }));

    return readable;
  }

  /**
   * Encrypts and persists profile state to local storage.
   *
   * **Why it exists:**
   * All profile writes must go through one path so encryption envelope format and directory/write
   * behavior remain consistent across ingestion, reconciliation, and pulse flows.
   *
   * **What it talks to:**
   * - Uses `ProfileMemoryState` (import `ProfileMemoryState`) from `./profileMemory`.
   * - Uses `encryptProfileMemoryState` (import `encryptProfileMemoryState`) from `./profileMemoryCrypto`.
   * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
   * - Uses `writeFile` (import `writeFile`) from `node:fs/promises`.
   * - Uses `path` (import `default`) from `node:path`.
   *
   * @param state - Normalized profile state to persist.
   * @returns Promise resolving when encrypted state is flushed to disk.
   */
  private async save(state: ProfileMemoryState): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const envelope = encryptProfileMemoryState(state, this.encryptionKey);
    await writeFile(this.filePath, JSON.stringify(envelope, null, 2), "utf8");
  }
}
