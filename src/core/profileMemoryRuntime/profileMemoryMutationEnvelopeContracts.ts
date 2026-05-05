/**
 * @fileoverview Minimum mutation-envelope contract for canonical profile-memory writes.
 */

import type { ConversationDomainLane } from "../sessionContext";
import type { SourceRecallSourceRef } from "../sourceRecall/contracts";
import type { ProfileMemorySourceSurface } from "./contracts";
import type { ProfileMemoryMutationDecisionRecord } from "./profileMemoryDecisionRecordContracts";
import type {
  ProfileMemoryRetractionContract,
  ProfileMemoryRetractionRedactionState
} from "./profileMemoryRetractionContracts";

export interface ProfileMemoryMutationRequestCorrelation {
  conversationId?: string;
  turnId?: string;
  dominantLaneAtWrite?: ConversationDomainLane | null;
  threadKey?: string | null;
  sourceSurface: ProfileMemorySourceSurface;
  sourceFingerprint?: string;
  sourceRecallRefs?: readonly SourceRecallSourceRef[];
  normalizedInputIdentity?: string;
}

export interface ProfileMemoryMutationEnvelope {
  requestCorrelation: ProfileMemoryMutationRequestCorrelation;
  candidateRefs: readonly string[];
  governanceDecisions: readonly ProfileMemoryMutationDecisionRecord[];
  appliedWriteRefs: readonly string[];
  revisionLinkage?: string;
  rollbackHandle?: string;
  redactionState: ProfileMemoryRetractionRedactionState;
  retraction?: ProfileMemoryRetractionContract;
}
