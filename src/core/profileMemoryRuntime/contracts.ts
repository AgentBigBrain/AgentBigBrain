/**
 * @fileoverview Shared contracts for profile-memory runtime access and pulse evaluation.
 */

import { type AgentPulseDecision, type AgentPulseReason } from "../agentPulse";
import { type ProfileFactRecord, type ProfileMutationAuditMetadataV1 } from "../profileMemory";

export type ProfileAccessPurpose = "planning_context" | "operator_view" | "governor_review";

export interface ProfileAccessRequest {
  purpose: ProfileAccessPurpose;
  includeSensitive: boolean;
  explicitHumanApproval?: boolean;
  approvalId?: string;
  maxFacts?: number;
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

export interface ProfileIngestResult {
  appliedFacts: number;
  supersededFacts: number;
}

export interface AgentPulseEvaluationRequest {
  nowIso: string;
  userOptIn: boolean;
  reason: AgentPulseReason;
  contextualLinkageConfidence?: number;
  lastPulseSentAtIso: string | null;
  overrideQuietHours?: boolean;
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
  relationship: AgentPulseRelationshipAssessment;
  contextDrift: AgentPulseContextDriftAssessment;
}
