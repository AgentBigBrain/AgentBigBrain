/**
 * @fileoverview Authority-record helpers for dynamic Agent Pulse evaluation.
 */

import {
  buildPulseAuthorityRequestId,
  buildPulseDecisionRecord,
  evaluatePulseAuthorityGateway,
  type PulseAuthorityGatewayRequest,
  type PulseAuthorityGatewayDecisionCode,
  type PulseDecisionRecordV1
} from "../proactiveRuntime/pulseAuthorityGateway";
import type { ProactiveInquiryCandidate } from "../../core/stage6_86/proactiveInquiryCandidates";
import type { PulseCandidateV1 } from "../../core/types";
import type { DynamicPulseEvaluationParams } from "./pulseDynamicEvaluation";

/**
 * Builds the delivery-authority request for an emitted dynamic pulse candidate.
 */
export function buildDynamicPulseGatewayRequest(input: {
  params: DynamicPulseEvaluationParams;
  candidate: PulseCandidateV1;
  proactiveInquiryCandidate: ProactiveInquiryCandidate;
}): PulseAuthorityGatewayRequest {
  const sourceRecallStatus = input.proactiveInquiryCandidate.evidencePolicy.sourceRecallStatus;
  return {
    requestId: buildPulseAuthorityRequestId({
      userId: input.params.controllerSession.userId,
      controllerSessionId: input.params.controllerSession.conversationId,
      targetSessionId: input.params.targetSession.conversationId,
      reasonCode: input.candidate.reasonCode,
      candidateId: input.candidate.candidateId,
      trigger: "interval",
      nowIso: input.params.nowIso
    }),
    userId: input.params.controllerSession.userId,
    controllerSessionId: input.params.controllerSession.conversationId,
    targetSessionId: input.params.targetSession.conversationId,
    targetVisibility: input.params.targetSession.conversationVisibility,
    reasonCode: input.candidate.reasonCode,
    candidateId: input.candidate.candidateId,
    trigger: "interval",
    nowIso: input.params.nowIso,
    baseDecision: input.params.preflightEvaluation.decision,
    dynamicReasonAllowed:
      input.params.config.dynamicReasonAllowlist?.includes(input.candidate.reasonCode) === true,
    candidateRisk: input.proactiveInquiryCandidate.risk,
    policyContext: {
      targetSessionVisibility: input.params.targetSession.conversationVisibility,
      userHasActiveMission: input.params.userSessions.some((session) => Boolean(session.runningJobId)),
      userHasQueuedMission: input.params.userSessions.some((session) => session.queuedJobs.length > 0),
      routeIsPublicSafe:
        input.params.targetSession.conversationVisibility !== "public" ||
        input.params.controllerSession.agentPulse.mode === "public",
      sourceEvidencePublicSafe: sourceRecallStatus !== "available",
      timezoneSource: input.params.targetSession.agentPulse.userTimezone
        ? "explicit_user_setting"
        : "unknown"
    },
    evidence: {
      evidenceRefs: input.candidate.evidenceRefs,
      sourceRecallRefs: input.proactiveInquiryCandidate.evidence.sourceRecallRefs,
      sourceRecallStatus,
      sourceRecallUsable: input.proactiveInquiryCandidate.evidencePolicy.sourceRecallUsable,
      containsPrivateMemoryEvidence: input.candidate.evidenceRefs.some((ref) =>
        ref.startsWith("open_loop_actor_scope:")
      ),
      containsRelationshipEvidence: input.candidate.reasonCode === "RELATIONSHIP_CLARIFICATION",
      containsIdentityEvidence: input.candidate.evidenceRefs.some((ref) =>
        ref.startsWith("open_loop_actor_scope:")
      )
    }
  };
}

/**
 * Builds a typed pulse decision record for dynamic-path suppressions before a prompt is queued.
 */
export function buildDynamicDecisionRecord(input: {
  params: DynamicPulseEvaluationParams;
  candidateId: string | null;
  reasonCode: string;
  baseDecision: {
    allowed: boolean;
    decisionCode: PulseAuthorityGatewayDecisionCode;
    suppressedBy: readonly string[];
    nextEligibleAtIso: string | null;
  };
  candidateProposed: boolean;
  decisionStatus?: PulseDecisionRecordV1["decisionStatus"];
}): PulseDecisionRecordV1 {
  const requestId = buildPulseAuthorityRequestId({
    userId: input.params.controllerSession.userId,
    controllerSessionId: input.params.controllerSession.conversationId,
    targetSessionId: input.params.targetSession.conversationId,
    reasonCode: input.reasonCode,
    candidateId: input.candidateId,
    trigger: "interval",
    nowIso: input.params.nowIso
  });
  const request = {
    requestId,
    userId: input.params.controllerSession.userId,
    controllerSessionId: input.params.controllerSession.conversationId,
    targetSessionId: input.params.targetSession.conversationId,
    targetVisibility: input.params.targetSession.conversationVisibility,
    reasonCode: input.reasonCode,
    candidateId: input.candidateId,
    trigger: "interval" as const,
    nowIso: input.params.nowIso,
    baseDecision: input.baseDecision,
    dynamicReasonAllowed: true,
    policyContext: {
      targetSessionVisibility: input.params.targetSession.conversationVisibility,
      userHasActiveMission: input.params.userSessions.some((session) => Boolean(session.runningJobId)),
      userHasQueuedMission: input.params.userSessions.some((session) => session.queuedJobs.length > 0),
      routeIsPublicSafe: input.params.targetSession.conversationVisibility !== "public",
      sourceEvidencePublicSafe: true,
      timezoneSource: input.params.targetSession.agentPulse.userTimezone
        ? "explicit_user_setting" as const
        : "unknown" as const
    },
    evidence: {
      evidenceRefs: [],
      sourceRecallRefs: [],
      sourceRecallStatus: "not_used" as const,
      sourceRecallUsable: false,
      containsPrivateMemoryEvidence: false,
      containsRelationshipEvidence: false,
      containsIdentityEvidence: false
    }
  };
  const decision = evaluatePulseAuthorityGateway(request);
  return buildPulseDecisionRecord({
    request,
    decision,
    candidateProposed: input.candidateProposed,
    decisionStatus: input.decisionStatus
  });
}
