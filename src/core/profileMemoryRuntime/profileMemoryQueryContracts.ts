/**
 * @fileoverview Shared bounded profile-memory query contracts reused across continuity, planning,
 * and orchestration read seams.
 */

import type { ProfileMemoryQueryDecisionRecord } from "./profileMemoryDecisionRecordContracts";
import type { ProfileReadableFact } from "./contracts";
import type {
  ProfileMemoryTemporalRelevanceScope,
  ProfileMemoryTemporalSemanticMode,
  TemporalMemorySynthesis
} from "./profileMemoryTemporalQueryContracts";

export interface ProfileFactContinuityQueryRequest {
  entityHints: readonly string[];
  semanticMode?: ProfileMemoryTemporalSemanticMode;
  relevanceScope?: ProfileMemoryTemporalRelevanceScope;
  asOfValidTime?: string;
  asOfObservedTime?: string;
  maxFacts?: number;
}

export interface ProfileFactContinuityResult extends ReadonlyArray<ProfileReadableFact> {
  semanticMode: ProfileMemoryTemporalSemanticMode;
  relevanceScope: ProfileMemoryTemporalRelevanceScope;
  scopedThreadKeys: readonly string[];
  temporalSynthesis: TemporalMemorySynthesis | null;
}

export interface ProfileFactQueryInspectionRequest {
  queryInput: string;
  maxFacts?: number;
  asOfValidTime?: string;
  asOfObservedTime?: string;
}

export interface ProfileFactQueryInspectionResult {
  selectedFacts: readonly ProfileReadableFact[];
  decisionRecords: readonly ProfileMemoryQueryDecisionRecord[];
}
