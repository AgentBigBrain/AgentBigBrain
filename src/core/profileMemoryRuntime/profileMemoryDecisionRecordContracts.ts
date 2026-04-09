/**
 * @fileoverview Initial proof-facing decision-record contracts for temporal profile-memory flows.
 */

import type {
  ProfileMemoryAnswerModeFallback,
  ProfileMemoryEvidenceClass,
  ProfileMemoryGovernanceAction,
  ProfileMemoryGovernanceFamily,
  ProfileMemoryGovernanceReason
} from "./profileMemoryTruthGovernanceContracts";

export interface ProfileMemoryAsOfContract {
  asOfValidTime?: string;
  asOfObservedTime?: string;
}

export type ProfileMemoryQueryDecisionDisposition =
  | "selected_current_state"
  | "selected_supporting_history"
  | "ambiguous_contested"
  | "insufficient_evidence"
  | "needs_corroboration"
  | "quarantined";

export interface ProfileMemoryQueryDecisionRecord
  extends ProfileMemoryAsOfContract {
  family: ProfileMemoryGovernanceFamily;
  evidenceClass: ProfileMemoryEvidenceClass;
  governanceAction: ProfileMemoryGovernanceAction;
  governanceReason: ProfileMemoryGovernanceReason;
  disposition: ProfileMemoryQueryDecisionDisposition;
  answerModeFallback: ProfileMemoryAnswerModeFallback;
  candidateRefs: readonly string[];
  evidenceRefs: readonly string[];
}

export interface ProfileMemoryMutationDecisionRecord {
  family: ProfileMemoryGovernanceFamily;
  evidenceClass: ProfileMemoryEvidenceClass;
  governanceAction: ProfileMemoryGovernanceAction;
  governanceReason: ProfileMemoryGovernanceReason;
  candidateRefs: readonly string[];
  appliedWriteRefs: readonly string[];
}
