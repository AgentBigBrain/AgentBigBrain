/**
 * @fileoverview Shared contracts for profile-memory runtime access and pulse evaluation.
 */

import { type AgentPulseDecision, type AgentPulseReason } from "../agentPulse";
import { type ProfileFactRecord, type ProfileMutationAuditMetadataV1 } from "../profileMemory";
import type { ConversationDomainLane } from "../sessionContext";
import type { ProfileEpisodeRecord } from "./profileMemoryEpisodeContracts";

export type ProfileAccessPurpose = "planning_context" | "operator_view" | "governor_review";

export interface ProfileAccessRequest {
  purpose: ProfileAccessPurpose;
  includeSensitive: boolean;
  explicitHumanApproval?: boolean;
  approvalId?: string;
  maxFacts?: number;
  maxEpisodes?: number;
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

export interface ProfileReadableEpisode {
  episodeId: string;
  title: string;
  summary: string;
  status: ProfileEpisodeRecord["status"];
  sensitive: boolean;
  sourceKind: ProfileEpisodeRecord["sourceKind"];
  observedAt: string;
  lastMentionedAt: string;
  lastUpdatedAt: string;
  resolvedAt: string | null;
  confidence: number;
  entityRefs: string[];
  openLoopRefs: string[];
  tags: string[];
}

export interface ProfilePulseRelevantEpisode {
  episodeId: string;
  title: string;
  summary: string;
  status: ProfileEpisodeRecord["status"];
  lastMentionedAt: string;
  ageDays: number;
}

export interface ProfileIngestResult {
  appliedFacts: number;
  supersededFacts: number;
}

export interface ProfileValidatedFactCandidateInput {
  key: string;
  candidateValue: string;
  sensitive?: boolean;
  source: string;
  confidence?: number;
}

export interface ProfileMemoryIngestRequest {
  userInput?: string;
  validatedFactCandidates?: readonly ProfileValidatedFactCandidateInput[];
}

export interface AgentPulseEvaluationRequest {
  nowIso: string;
  userOptIn: boolean;
  reason: AgentPulseReason;
  contextualLinkageConfidence?: number;
  lastPulseSentAtIso: string | null;
  overrideQuietHours?: boolean;
  sessionDominantLane?: ConversationDomainLane | null;
  sessionHasActiveWorkflowContinuity?: boolean;
  overrideSessionDomainSuppression?: boolean;
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
  relevantEpisodes: ProfilePulseRelevantEpisode[];
  relationship: AgentPulseRelationshipAssessment;
  contextDrift: AgentPulseContextDriftAssessment;
}
