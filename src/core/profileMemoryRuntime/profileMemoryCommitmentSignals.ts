/**
 * @fileoverview Commitment-signal helpers shared by profile-memory runtime mutation flows.
 */

import {
  classifyCommitmentSignal,
  type CommitmentSignalClassification,
  createCommitmentSignalRuleContext
} from "../commitmentSignalClassifier";
import {
  type ProfileFactRecord,
  type ProfileMutationAuditMetadataV1
} from "../profileMemory";

const COMMITMENT_SIGNAL_RULE_CONTEXT = createCommitmentSignalRuleContext(null);

/**
 * Evaluates whether a profile fact is still active.
 *
 * @param fact - Profile fact under evaluation.
 * @returns `true` when the fact is active.
 */
export function isActiveFact(fact: ProfileFactRecord): boolean {
  return fact.status !== "superseded" && fact.supersededAt === null;
}

/**
 * Evaluates whether a signal classification indicates user-input resolution.
 *
 * @param classification - Commitment signal classification.
 * @returns `true` when the classification indicates user-input resolution.
 */
export function isUserInputResolutionClassification(
  classification: CommitmentSignalClassification
): boolean {
  return (
    classification.category === "TOPIC_RESOLUTION_CANDIDATE" ||
    classification.category === "GENERIC_RESOLUTION"
  );
}

/**
 * Evaluates whether a signal classification is a resolved marker.
 *
 * @param classification - Commitment signal classification.
 * @returns `true` when the classification indicates a resolved marker.
 */
export function isResolvedMarkerClassification(
  classification: CommitmentSignalClassification
): boolean {
  return classification.category === "RESOLVED_MARKER";
}

/**
 * Converts commitment classifications into mutation-audit metadata.
 *
 * @param classification - Commitment signal classification.
 * @returns Mutation-audit metadata for downstream writes.
 */
export function toCommitmentMutationAuditMetadata(
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
 * Classifies commitment signal for user input.
 *
 * @param userInput - Raw user text under ingestion.
 * @returns Commitment signal classification.
 */
export function classifyCommitmentSignalForUserInput(
  userInput: string
): CommitmentSignalClassification {
  return classifyCommitmentSignal(userInput, {
    mode: "user_input",
    ruleContext: COMMITMENT_SIGNAL_RULE_CONTEXT
  });
}

/**
 * Classifies commitment signal for fact values.
 *
 * @param value - Stored fact value.
 * @returns Commitment signal classification.
 */
export function classifyCommitmentSignalForFactValue(
  value: string
): CommitmentSignalClassification {
  return classifyCommitmentSignal(value, {
    mode: "fact_value",
    ruleContext: COMMITMENT_SIGNAL_RULE_CONTEXT
  });
}

/**
 * Evaluates whether a value indicates a resolved commitment marker.
 *
 * @param value - Stored fact value.
 * @returns `true` when the value indicates resolution.
 */
export function valueIndicatesResolvedCommitmentMarker(value: string): boolean {
  const classification = classifyCommitmentSignalForFactValue(value);
  return !classification.conflict && isResolvedMarkerClassification(classification);
}
