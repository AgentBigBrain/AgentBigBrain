/**
 * @fileoverview Commitment-resolution and candidate-apply helpers for profile-memory runtime mutations.
 */

import {
  type ProfileFactUpsertInput,
  type ProfileMemoryState
} from "../profileMemory";
import { upsertTemporalProfileFact } from "./profileMemoryFactLifecycle";
import {
  normalizeProfileKey,
  normalizeProfileValue
} from "./profileMemoryNormalization";
import {
  classifyCommitmentSignalForFactValue,
  classifyCommitmentSignalForUserInput,
  isActiveFact,
  isResolvedMarkerClassification,
  isUserInputResolutionClassification,
  toCommitmentMutationAuditMetadata
} from "./profileMemoryCommitmentSignals";
import {
  isUnresolvedCommitmentFact,
  listUnresolvedCommitmentFacts,
  normalizeCommitmentTopicText,
  topicFromCommitmentKey,
  topicFromCommitmentValue,
  topicsLikelyMatch
} from "./profileMemoryCommitmentTopics";

const SYSTEM_COMMITMENT_RECONCILIATION_TASK_ID = "profile_memory_reconciliation";

export interface ProfileFactCandidateApplyResult {
  nextState: ProfileMemoryState;
  appliedFacts: number;
  supersededFacts: number;
}

/**
 * Counts unresolved active commitments in normalized profile state.
 *
 * @param state - Loaded profile-memory state.
 * @returns Active unresolved commitment count.
 */
export function countUnresolvedCommitments(state: ProfileMemoryState): number {
  return state.facts.filter((fact) => isUnresolvedCommitmentFact(fact)).length;
}

/**
 * Extracts non-sensitive unresolved commitment topics for pulse grounding.
 *
 * @param state - Loaded profile-memory state.
 * @param maxTopics - Maximum number of topics to return.
 * @returns Ordered unresolved commitment topics.
 */
export function extractUnresolvedCommitmentTopics(
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
    if (!topic || seenTopics.has(topic)) {
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
 * Builds inferred resolution candidates from user input that closes unresolved commitments.
 *
 * @param state - Loaded profile-memory state.
 * @param userInput - Raw user text under ingestion.
 * @param sourceTaskId - Task identifier for generated mutation metadata.
 * @param observedAt - Observation timestamp for generated mutations.
 * @returns Resolution candidates inferred from matching unresolved commitments.
 */
export function buildInferredCommitmentResolutionCandidates(
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
 * Applies normalized profile-fact candidates with deterministic deduplication.
 *
 * @param state - Loaded profile-memory state.
 * @param candidates - Profile-fact upsert candidates to apply.
 * @returns Next state plus applied/superseded counts.
 */
export function applyProfileFactCandidates(
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
  let appliedFacts = 0;
  let supersededFacts = 0;
  for (const candidate of dedupedCandidates) {
    const upserted = upsertTemporalProfileFact(nextState, candidate);
    nextState = upserted.nextState;
    if (upserted.applied) {
      appliedFacts += 1;
    }
    supersededFacts += upserted.supersededFactIds.length;
  }

  return {
    nextState,
    appliedFacts,
    supersededFacts
  };
}

/**
 * Builds deterministic reconciliation candidates when active resolved facts contradict unresolved commitments.
 *
 * @param state - Loaded profile-memory state.
 * @param observedAt - Observation timestamp used for generated mutations.
 * @returns Reconciliation resolution candidates.
 */
export function buildStateReconciliationResolutionCandidates(
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
 * Deduplicates normalized profile-fact candidates.
 *
 * @param candidates - Candidate writes to normalize and deduplicate.
 * @returns Deduplicated candidates.
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
