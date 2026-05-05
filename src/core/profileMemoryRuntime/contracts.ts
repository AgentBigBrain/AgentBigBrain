/**
 * @fileoverview Shared contracts for profile-memory runtime access and pulse evaluation.
 */

import { type AgentPulseDecision, type AgentPulseReason } from "../agentPulse";
import { type ProfileFactRecord, type ProfileMutationAuditMetadataV1 } from "../profileMemory";
import type { ConversationDomainLane } from "../sessionContext";
import type { SourceAuthority } from "../sourceAuthority";
import type { SourceRecallSourceRef } from "../sourceRecall/contracts";
import type {
  CreateProfileEpisodeRecordInput,
  ProfileEpisodeRecord
} from "./profileMemoryEpisodeContracts";
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
  relationshipCandidate?: ProfileValidatedRelationshipCandidateMetadata;
}

export type ProfileSemanticRelationshipSubject = "current_user";

export type ProfileSemanticRelationshipLifecycle =
  | "current"
  | "historical"
  | "severed"
  | "uncertain";

export type ProfileSemanticRelationshipAmbiguity =
  | "none"
  | "ambiguous_subject"
  | "ambiguous_object"
  | "ambiguous_relation"
  | "ambiguous_lifecycle";

export type ProfileSemanticRelationshipSourceFamily =
  | "semantic_model"
  | "approved_review_path";

export interface ProfileSemanticRelationshipEvidenceSpan {
  text: string;
  startOffset?: number;
  endOffset?: number;
}

export interface ProfileValidatedRelationshipCandidateMetadata {
  subject: ProfileSemanticRelationshipSubject;
  objectDisplayName: string;
  objectQualifier?: string;
  relationLabel: string;
  lifecycle: ProfileSemanticRelationshipLifecycle;
  sourceFamily: ProfileSemanticRelationshipSourceFamily;
  ambiguity: ProfileSemanticRelationshipAmbiguity;
  evidenceSpan: ProfileSemanticRelationshipEvidenceSpan;
}

export interface ProfileSemanticRelationshipCandidateInput {
  subject: ProfileSemanticRelationshipSubject;
  objectDisplayName: string;
  objectQualifier?: string;
  relationLabel: string;
  lifecycle: ProfileSemanticRelationshipLifecycle;
  workAssociation?: string;
  sourceFamily: ProfileSemanticRelationshipSourceFamily;
  ambiguity?: ProfileSemanticRelationshipAmbiguity;
  evidenceSpan: ProfileSemanticRelationshipEvidenceSpan;
  confidence?: number;
  sensitive?: boolean;
}

export type ProfileMemoryIngestMemoryIntent =
  | "none"
  | "relationship_recall"
  | "profile_update"
  | "contextual_recall"
  | "document_derived_recall";

export type ProfileMemoryIngestSourceLane =
  | "direct_user_text"
  | "voice_transcript"
  | "image_ocr"
  | "image_summary"
  | "document_text"
  | "document_summary"
  | "validated_model_candidate";

export type ProfileMemoryIngestFragmentPolicy =
  | "current_truth_allowed"
  | "support_only"
  | "candidate_only"
  | "quarantine"
  | "ignore";

export type ProfileMemoryIngestPolicySource =
  | "semantic_route"
  | "exact_command"
  | "structured_candidate"
  | "legacy_compatibility";

export type ProfileMemorySourceAuthority = SourceAuthority;

export type ProfileMemoryReviewMutationSource =
  | "memory_review_command"
  | "projection_review_action";

export type ProfileMemorySourceSurface =
  | "conversation_profile_input"
  | "broker_task_ingest"
  | "memory_review_episode"
  | "memory_review_fact";

export interface ProfileMemoryIngestPolicy {
  memoryIntent: ProfileMemoryIngestMemoryIntent;
  sourceLane: ProfileMemoryIngestSourceLane;
  sourceSurface: ProfileMemorySourceSurface;
  allowExactSelfFactExtraction: boolean;
  allowDirectRelationshipExtraction: boolean;
  allowGenericProfileFactExtraction: boolean;
  allowCommitmentExtraction: boolean;
  allowEpisodeSupportExtraction: boolean;
  allowInferredResolution: boolean;
  fragmentPolicy: ProfileMemoryIngestFragmentPolicy;
  policySource: ProfileMemoryIngestPolicySource;
  sourceAuthority: ProfileMemorySourceAuthority;
}

export interface ProfileMemoryWriteProvenance {
  conversationId?: string;
  turnId?: string;
  dominantLaneAtWrite?: ConversationDomainLane | null;
  threadKey?: string | null;
  sourceSurface: ProfileMemorySourceSurface;
  sourceFingerprint?: string;
  sourceRecallRefs?: readonly SourceRecallSourceRef[];
}

export interface ProfileMediaIngestInput {
  directUserText: string;
  transcriptFragments: readonly string[];
  summaryFragments: readonly string[];
  ocrFragments: readonly string[];
  candidateOnlyFragments: readonly string[];
  allNarrativeFragments: readonly string[];
}

export interface ProfileMemoryIngestRequest {
  userInput?: string;
  validatedFactCandidates?: readonly ProfileValidatedFactCandidateInput[];
  additionalEpisodeCandidates?: readonly CreateProfileEpisodeRecordInput[];
  mediaIngest?: ProfileMediaIngestInput;
  provenance?: ProfileMemoryWriteProvenance;
  ingestPolicy?: ProfileMemoryIngestPolicy;
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
