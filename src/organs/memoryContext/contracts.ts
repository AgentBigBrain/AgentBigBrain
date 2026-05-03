/**
 * @fileoverview Shared contracts for memory-context query planning, context injection, and audit routing.
 */

import type { ConversationDomainContext, ProfileMemoryStatus } from "../../core/types";
import type { SourceAuthority } from "../../core/sourceAuthority";
import type {
  ProfileMemoryTemporalAnswerMode,
  ProfileMemoryTemporalLaneKind
} from "../../core/profileMemoryRuntime/profileMemoryTemporalQueryContracts";
import type {
  ProfileMemoryTemporalRelevanceScope,
  ProfileMemoryTemporalSemanticMode
} from "../../core/profileMemoryRuntime/profileMemoryTemporalQueryContracts";

export type MemoryDomainLane = "profile" | "relationship" | "workflow" | "system_policy" | "unknown";
export type DomainBoundaryDecision = "inject_profile_context" | "suppress_profile_context";
export type MemoryRetrievalMode =
  | "semantic_entity_match"
  | "vector_hybrid"
  | "keyword_only"
  | "recent_fallback"
  | "compatibility_token_overlap"
  | "legacy_inventory";
export type MemoryPlannerAuthority = "route_approved" | "evidence_only" | "none";

export interface ProbingDetectorConfig {
  windowSize: number;
  minimumSampleSize: number;
  matchRatioThreshold: number;
  rapidSuccessionWindowMs: number;
  shortQueryMaxChars: number;
  shortQueryMaxWords: number;
}

export interface ProbingSignalSnapshot {
  queryHash: string;
  observedAtMs: number;
  shortQuery: boolean;
  sensitivePatternOverlap: boolean;
  extractionIntent: boolean;
  rapidSuccession: boolean;
  probingSignatureMatched: boolean;
}

export interface ProbingAssessment {
  detected: boolean;
  matchRatio: number;
  matchCount: number;
  windowSize: number;
  matchedSignals: string[];
}

export interface ProbingRegistrationResult {
  assessment: ProbingAssessment;
  nextSignals: ProbingSignalSnapshot[];
}

export interface MemoryAccessAuditAppendOptions {
  eventType?: "retrieval" | "PROBING_DETECTED";
  storeLoadCount?: number;
  ingestOperationCount?: number;
  retrievalOperationCount?: number;
  synthesisOperationCount?: number;
  renderOperationCount?: number;
  promptMemoryOwnerCount?: number;
  promptMemorySurfaceCount?: number;
  mixedMemoryOwnerDecisionCount?: number;
  aliasSafetyDecisionCount?: number;
  identitySafetyDecisionCount?: number;
  selfIdentityParityCheckCount?: number;
  selfIdentityParityMismatchCount?: number;
  promptCutoverGateDecision?: "allow" | "block";
  promptCutoverGateReasons?: readonly string[];
  retrievedEpisodeCount?: number;
  probeSignals?: readonly string[];
  probeWindowSize?: number;
  probeMatchCount?: number;
  probeMatchRatio?: number;
}

export interface DomainLaneScores {
  profile: number;
  relationship: number;
  workflow: number;
  system_policy: number;
  unknown: number;
}

export interface DomainBoundaryAssessment {
  lanes: MemoryDomainLane[];
  scores: DomainLaneScores;
  decision: DomainBoundaryDecision;
  reason: string;
}

export interface ProfileContextSanitizationResult {
  sanitizedContext: string;
  redactedFieldCount: number;
}

export interface MemoryContextAuthorityMetadata {
  retrievalMode: MemoryRetrievalMode;
  sourceAuthority: SourceAuthority;
  plannerAuthority: MemoryPlannerAuthority;
  currentTruthAuthority: boolean;
}

export interface MemoryBrokerInputResult {
  userInput: string;
  profileMemoryStatus: ProfileMemoryStatus;
}

export interface MemoryBrokerBuildInputOptions {
  sessionDomainContext?: ConversationDomainContext | null;
}

export interface MemoryBrokerOptions {
  probingDetector?: Partial<ProbingDetectorConfig>;
}

export interface MemoryBoundaryLaneOutput {
  laneId: string;
  domainLane: MemoryDomainLane;
  semanticMode: ProfileMemoryTemporalSemanticMode;
  relevanceScope: ProfileMemoryTemporalRelevanceScope;
  scopedThreadKeys: readonly string[];
  answerMode: ProfileMemoryTemporalAnswerMode;
  dominantLane: ProfileMemoryTemporalLaneKind;
  supportingLanes: readonly ProfileMemoryTemporalLaneKind[];
  overflowNote: string | null;
  degradedNotes: readonly string[];
}
