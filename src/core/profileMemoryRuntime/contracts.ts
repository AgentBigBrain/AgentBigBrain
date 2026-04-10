/**
 * @fileoverview Shared contracts for profile-memory runtime access and pulse evaluation.
 */

import { type AgentPulseDecision, type AgentPulseReason } from "../agentPulse";
import { type ProfileFactRecord, type ProfileMutationAuditMetadataV1 } from "../profileMemory";
import type { ConversationDomainLane } from "../sessionContext";
import type { ProfileEpisodeRecord } from "./profileMemoryEpisodeContracts";
import type { ProfileMemoryMutationEnvelope } from "./profileMemoryMutationEnvelopeContracts";
import type {
  ProfileMemoryAsOfContract,
  ProfileMemoryQueryDecisionRecord
} from "./profileMemoryDecisionRecordContracts";

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
  mutationEnvelope?: ProfileMemoryMutationEnvelope;
}

export interface ProfileEpisodeReviewMutationResult {
  episode: ProfileReadableEpisode | null;
  mutationEnvelope?: ProfileMemoryMutationEnvelope;
}

export interface ProfileFactReviewEntry {
  fact: ProfileReadableFact;
  decisionRecord: ProfileMemoryQueryDecisionRecord;
}

export interface ProfileFactPlanningInspectionEntry {
  fact: ProfileReadableFact;
  decisionRecord: ProfileMemoryQueryDecisionRecord;
}

export interface ProfileFactPlanningInspectionRequest extends ProfileMemoryAsOfContract {
  queryInput?: string;
  maxFacts?: number;
}

export interface ProfileFactPlanningInspectionResult extends ProfileMemoryAsOfContract {
  entries: readonly ProfileFactPlanningInspectionEntry[];
  hiddenDecisionRecords: readonly ProfileMemoryQueryDecisionRecord[];
}

export interface ProfileFactReviewRequest extends ProfileMemoryAsOfContract {
  queryInput?: string;
  maxFacts?: number;
  includeSensitive?: boolean;
  explicitHumanApproval?: boolean;
  approvalId?: string;
}

export interface ProfileFactReviewResult extends ProfileMemoryAsOfContract {
  entries: readonly ProfileFactReviewEntry[];
  hiddenDecisionRecords: readonly ProfileMemoryQueryDecisionRecord[];
}

export type ProfileFactReviewMutationAction = "correct" | "forget";

export interface ProfileFactReviewMutationRequest {
  factId: string;
  action: ProfileFactReviewMutationAction;
  replacementValue?: string;
  note?: string;
  nowIso: string;
  sourceTaskId: string;
  sourceText: string;
}

export interface ProfileFactReviewMutationResult {
  fact: ProfileReadableFact | null;
  mutationEnvelope?: ProfileMemoryMutationEnvelope;
}

export interface ProfileMemoryRequestTelemetry {
  storeLoadCount: number;
  ingestOperationCount: number;
  retrievalOperationCount: number;
  synthesisOperationCount: number;
  renderOperationCount: number;
  promptMemoryOwnerCount: number;
  promptMemorySurfaceCount: number;
  mixedMemoryOwnerDecisionCount: number;
  aliasSafetyDecisionCount: number;
  identitySafetyDecisionCount: number;
  selfIdentityParityCheckCount: number;
  selfIdentityParityMismatchCount: number;
}

export interface ProfileValidatedFactCandidateInput {
  key: string;
  candidateValue: string;
  sensitive?: boolean;
  source: string;
  confidence?: number;
}

export type ProfileMemorySourceSurface =
  | "conversation_profile_input"
  | "broker_task_ingest"
  | "memory_review_episode"
  | "memory_review_fact";

export interface ProfileMemoryWriteProvenance {
  conversationId?: string;
  turnId?: string;
  dominantLaneAtWrite?: ConversationDomainLane | null;
  threadKey?: string | null;
  sourceSurface: ProfileMemorySourceSurface;
  sourceFingerprint?: string;
}

export interface ProfileMemoryIngestRequest {
  userInput?: string;
  validatedFactCandidates?: readonly ProfileValidatedFactCandidateInput[];
  provenance?: ProfileMemoryWriteProvenance;
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
  | "partner"
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
