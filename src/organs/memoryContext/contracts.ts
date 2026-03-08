/**
 * @fileoverview Shared contracts for memory-context query planning, context injection, and audit routing.
 */

import type { ProfileMemoryStatus } from "../../core/types";

export type MemoryDomainLane = "profile" | "relationship" | "workflow" | "system_policy" | "unknown";
export type DomainBoundaryDecision = "inject_profile_context" | "suppress_profile_context";

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

export interface MemoryBrokerInputResult {
  userInput: string;
  profileMemoryStatus: ProfileMemoryStatus;
}

export interface MemoryBrokerOptions {
  probingDetector?: Partial<ProbingDetectorConfig>;
}
