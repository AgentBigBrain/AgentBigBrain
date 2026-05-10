/**
 * @fileoverview Canonical deterministic Agent Pulse delivery-authority gateway.
 */

import { sha256HexFromCanonicalJson } from "../../core/normalizers/canonicalizationRules";
import type { AgentPulseDecisionCode } from "../sessionStore";

export type PulseAuthorityGatewayTrigger =
  | "interval"
  | "startup"
  | "manual_tick"
  | "runtime_action"
  | "test";

export type PulseAuthorityGatewayDecisionCode =
  | AgentPulseDecisionCode
  | "DAILY_CAP"
  | "REASON_NOT_ALLOWED"
  | "PUBLIC_PRIVACY_BLOCKED"
  | "ACTIVE_MISSION"
  | "SOURCE_RECALL_BLOCKED"
  | "RUNTIME_ACTION_NOT_SCHEDULER_AUTHORIZED"
  | "DEPENDENCY_UNAVAILABLE"
  | "SKIPPED_ACTIVE_WORK"
  | "BLOCKED_BY_POLICY";

export type PulseAuthorityGatewayTargetVisibility = "private" | "public" | "unknown";

export interface PulseAuthorityGatewayRequest {
  requestId: string;
  userId: string;
  controllerSessionId: string;
  targetSessionId: string | null;
  targetVisibility: PulseAuthorityGatewayTargetVisibility;
  reasonCode: string;
  candidateId: string | null;
  trigger: PulseAuthorityGatewayTrigger;
  nowIso: string;
  baseDecision?: {
    allowed: boolean;
    decisionCode: PulseAuthorityGatewayDecisionCode;
    suppressedBy: readonly string[];
    nextEligibleAtIso: string | null;
  } | null;
  dynamicReasonAllowed?: boolean;
  candidateRisk?: {
    privacyRisk: "none" | "private_only" | "sensitive" | "blocked";
    publicSafe: boolean;
    activeMissionSafe: boolean;
  };
  policyContext: {
    targetSessionVisibility: PulseAuthorityGatewayTargetVisibility;
    userHasActiveMission: boolean;
    userHasQueuedMission: boolean;
    routeIsPublicSafe: boolean;
    sourceEvidencePublicSafe: boolean;
    timezoneSource: "explicit_user_setting" | "provider_locale" | "system_default" | "unknown";
  };
  evidence: {
    evidenceRefs: readonly string[];
    sourceRecallRefs: readonly string[];
    sourceRecallStatus: "not_used" | "available" | "disabled" | "blocked" | "unavailable";
    sourceRecallUsable: boolean;
    containsPrivateMemoryEvidence: boolean;
    containsRelationshipEvidence: boolean;
    containsIdentityEvidence: boolean;
  };
}

export interface PulseAuthorityGatewayDecision {
  decisionId: string;
  requestId: string;
  allowed: boolean;
  decisionCode: PulseAuthorityGatewayDecisionCode;
  suppressedBy: readonly string[];
  nextEligibleAtIso: string | null;
  userVisibleDeliveryAllowed: boolean;
  proofCategory: "delivery_permission";
}

export interface PulseDecisionRecordV1 {
  decisionRecordId: string;
  requestId: string;
  userId: string;
  controllerSessionId: string | null;
  targetSessionId: string | null;
  trigger: PulseAuthorityGatewayTrigger;
  candidateId: string | null;
  candidateProposed: boolean;
  gatewayDecision: PulseAuthorityGatewayDecision;
  decisionStatus: "suppressed" | "allowed_for_queue" | "skipped" | "blocked" | "failed";
  rawPromptTextStored: false;
  createdAt: string;
}

export interface PulseSystemJobMetadata {
  kind: "agent_pulse";
  pulseId: string | null;
  candidateId: string | null;
  deliveryDecisionId: string;
  decisionRecordId: string;
  promptKind: "stage6_86_dynamic_pulse" | "legacy_pulse" | "semantic_inquiry_pulse";
  executionConstraint: "respond_only_pulse";
  allowedActionTypes: readonly ["respond"];
  sourceRecallTaskInputCaptureAllowed: false;
}

/**
 * Builds the stable request id used by the pulse gateway.
 */
export function buildPulseAuthorityRequestId(input: {
  userId: string;
  controllerSessionId: string;
  targetSessionId: string | null;
  reasonCode: string;
  candidateId: string | null;
  trigger: PulseAuthorityGatewayTrigger;
  nowIso: string;
}): string {
  const fingerprint = sha256HexFromCanonicalJson(input);
  return `pulse_gateway_request_${fingerprint.slice(0, 20)}`;
}

/**
 * Evaluates deterministic delivery authority for one proactive pulse attempt.
 */
export function evaluatePulseAuthorityGateway(
  request: PulseAuthorityGatewayRequest
): PulseAuthorityGatewayDecision {
  const suppressedBy: string[] = [];
  let decisionCode: PulseAuthorityGatewayDecisionCode = "ALLOWED";
  let nextEligibleAtIso: string | null = null;

  if (request.baseDecision && !request.baseDecision.allowed) {
    decisionCode = request.baseDecision.decisionCode;
    suppressedBy.push(...request.baseDecision.suppressedBy);
    nextEligibleAtIso = request.baseDecision.nextEligibleAtIso;
  }

  if (request.dynamicReasonAllowed === false) {
    if (suppressedBy.length === 0) {
      decisionCode = "REASON_NOT_ALLOWED";
    }
    suppressedBy.push("policy.dynamic_reason_not_allowed");
  }

  if (request.policyContext.userHasActiveMission || request.policyContext.userHasQueuedMission) {
    if (suppressedBy.length === 0) {
      decisionCode = "ACTIVE_MISSION";
    }
    suppressedBy.push("policy.user_active_or_queued_mission");
  }

  if (
    request.targetVisibility === "public" &&
    (
      !request.policyContext.routeIsPublicSafe ||
      !request.policyContext.sourceEvidencePublicSafe ||
      request.evidence.containsPrivateMemoryEvidence ||
      request.evidence.containsRelationshipEvidence ||
      request.evidence.containsIdentityEvidence ||
      request.evidence.sourceRecallRefs.length > 0 ||
      request.candidateRisk?.privacyRisk === "private_only" ||
      request.candidateRisk?.privacyRisk === "sensitive" ||
      request.candidateRisk?.privacyRisk === "blocked"
    )
  ) {
    if (suppressedBy.length === 0) {
      decisionCode = "PUBLIC_PRIVACY_BLOCKED";
    }
    suppressedBy.push("policy.public_route_private_evidence");
  }

  if (
    request.evidence.sourceRecallStatus === "blocked" ||
    request.evidence.sourceRecallStatus === "unavailable" ||
    (
      request.evidence.sourceRecallStatus === "disabled" &&
      request.evidence.sourceRecallRefs.length > 0
    ) ||
    (request.evidence.sourceRecallStatus === "available" && !request.evidence.sourceRecallUsable)
  ) {
    if (suppressedBy.length === 0) {
      decisionCode = "SOURCE_RECALL_BLOCKED";
    }
    suppressedBy.push("policy.source_recall_unusable");
  }

  if (request.candidateRisk?.activeMissionSafe === false) {
    if (suppressedBy.length === 0) {
      decisionCode = "ACTIVE_MISSION";
    }
    suppressedBy.push("candidate.active_mission_unsafe");
  }

  const allowed = suppressedBy.length === 0;
  const stableDecision = {
    requestId: request.requestId,
    decisionCode,
    suppressedBy: [...suppressedBy].sort(),
    nowIso: request.nowIso
  };
  return {
    decisionId: `pulse_gateway_decision_${sha256HexFromCanonicalJson(stableDecision).slice(0, 20)}`,
    requestId: request.requestId,
    allowed,
    decisionCode: allowed ? "ALLOWED" : decisionCode,
    suppressedBy,
    nextEligibleAtIso,
    userVisibleDeliveryAllowed: allowed,
    proofCategory: "delivery_permission"
  };
}

/**
 * Builds a bounded decision record for suppression, skip, and allow evidence.
 */
export function buildPulseDecisionRecord(input: {
  request: PulseAuthorityGatewayRequest;
  decision: PulseAuthorityGatewayDecision;
  candidateProposed: boolean;
  decisionStatus?: PulseDecisionRecordV1["decisionStatus"];
}): PulseDecisionRecordV1 {
  const decisionStatus =
    input.decisionStatus ??
    (input.decision.allowed ? "allowed_for_queue" : "suppressed");
  const fingerprint = sha256HexFromCanonicalJson({
    requestId: input.request.requestId,
    decisionId: input.decision.decisionId,
    decisionStatus,
    createdAt: input.request.nowIso
  });
  return {
    decisionRecordId: `pulse_decision_record_${fingerprint.slice(0, 20)}`,
    requestId: input.request.requestId,
    userId: input.request.userId,
    controllerSessionId: input.request.controllerSessionId,
    targetSessionId: input.request.targetSessionId,
    trigger: input.request.trigger,
    candidateId: input.request.candidateId,
    candidateProposed: input.candidateProposed,
    gatewayDecision: input.decision,
    decisionStatus,
    rawPromptTextStored: false,
    createdAt: input.request.nowIso
  };
}

/**
 * Builds the typed metadata attached to queued Agent Pulse system jobs.
 */
export function buildPulseSystemJobMetadata(input: {
  pulseId: string | null;
  candidateId: string | null;
  deliveryDecisionId: string;
  decisionRecordId: string;
  promptKind: PulseSystemJobMetadata["promptKind"];
}): PulseSystemJobMetadata {
  return {
    kind: "agent_pulse",
    pulseId: input.pulseId,
    candidateId: input.candidateId,
    deliveryDecisionId: input.deliveryDecisionId,
    decisionRecordId: input.decisionRecordId,
    promptKind: input.promptKind,
    executionConstraint: "respond_only_pulse",
    allowedActionTypes: ["respond"],
    sourceRecallTaskInputCaptureAllowed: false
  };
}
