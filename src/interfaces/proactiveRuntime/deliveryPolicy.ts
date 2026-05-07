/**
 * @fileoverview Canonical routing and delivery-selection helpers for proactive follow-up.
 */

import type { AgentPulseReason } from "../../core/agentPulse";
import type { ProactiveInquiryCandidate } from "../../core/stage6_86/proactiveInquiryCandidates";
import type { PulseEmissionRecordV1 } from "../../core/stage6_86PulseCandidates";
import type { ConversationSession } from "../sessionStore";
import type { ProactiveTargetSelection } from "./contracts";
import { shouldSuppressForPulseGap } from "./cooldownPolicy";

export type ProactiveInquirySuppressionReason =
  | "candidate_authority_invalid"
  | "low_expected_user_value"
  | "low_novelty"
  | "privacy_risk_blocked"
  | "public_route_private_evidence"
  | "active_mission_unsafe"
  | "source_recall_unusable"
  | "repeated_negative_outcome";

export interface ProactiveInquiryDeliveryPolicyInput {
  candidate: ProactiveInquiryCandidate;
  targetMode: ConversationSession["agentPulse"]["mode"];
  recentPulseHistory?: readonly PulseEmissionRecordV1[];
  minExpectedUserValue?: number;
  minNovelty?: number;
  maxRecentNegativeOutcomes?: number;
}

export interface ProactiveInquiryDeliveryPolicyDecision {
  allowed: boolean;
  suppressedBy: readonly ProactiveInquirySuppressionReason[];
}

/**
 * Returns true when a conversation key belongs to the active provider namespace.
 *
 * @param conversationKey - Stored conversation key.
 * @param provider - Active interface provider.
 * @returns `true` when the key belongs to the provider namespace.
 */
export function conversationBelongsToProvider(
  conversationKey: string,
  provider: "telegram" | "discord"
): boolean {
  return conversationKey.startsWith(`${provider}:`);
}

/**
 * Returns true when a session should be skipped for proactive evaluation.
 *
 * @param session - Session under evaluation.
 * @returns `true` when proactive work should be skipped.
 */
export function shouldSkipSessionForPulse(session: ConversationSession): boolean {
  if (!session.agentPulse.optIn) {
    return true;
  }
  if (Boolean(session.runningJobId) || session.queuedJobs.length > 0) {
    return true;
  }
  if (shouldSuppressForPulseGap(session.agentPulse.lastPulseSentAt)) {
    return true;
  }
  return false;
}

/**
 * Returns whether workflow-dominant active continuity should suppress a pulse reason.
 *
 * Explicit user-requested follow-ups and unresolved commitments still remain eligible.
 */
export function shouldSuppressPulseForSessionDomain(
  session: ConversationSession,
  reason: AgentPulseReason | "dynamic"
): boolean {
  if (session.domainContext.dominantLane !== "workflow") {
    return false;
  }

  const continuity = session.domainContext.continuitySignals;
  const hasActiveWorkflowContinuity =
    continuity.activeWorkspace || continuity.returnHandoff || continuity.modeContinuity;
  if (!hasActiveWorkflowContinuity) {
    return false;
  }

  return !(
    reason === "unresolved_commitment" ||
    reason === "user_requested_followup"
  );
}

/**
 * Sorts sessions from most recently updated to least recently updated.
 *
 * @param sessions - Sessions to sort.
 * @returns New array sorted by most recent update first.
 */
export function sortByMostRecentSessionUpdate(
  sessions: ConversationSession[]
): ConversationSession[] {
  return [...sessions].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  );
}

/**
 * Resolves the concrete session that should receive a proactive follow-up.
 *
 * @param controllerSession - Session whose opt-in/mode controls routing.
 * @param userSessions - All sessions for the same user.
 * @returns Concrete target session plus any suppression code.
 */
export function selectPulseTargetSession(
  controllerSession: ConversationSession,
  userSessions: ConversationSession[]
): ProactiveTargetSelection {
  if (controllerSession.agentPulse.mode === "private") {
    const privateSessions = sortByMostRecentSessionUpdate(
      userSessions.filter((candidate) => candidate.conversationVisibility === "private")
    );
    if (privateSessions.length === 0) {
      return {
        targetSession: null,
        suppressionCode: "NO_PRIVATE_ROUTE"
      };
    }
    return {
      targetSession: privateSessions[0],
      suppressionCode: null
    };
  }

  const currentSession = userSessions.find(
    (candidate) => candidate.conversationId === controllerSession.conversationId
  );
  return {
    targetSession: currentSession ?? controllerSession,
    suppressionCode: null
  };
}

/**
 * Evaluates deterministic delivery permission for semantic proactive inquiry candidates.
 *
 * @param input - Candidate, route mode, recent outcomes, and thresholds.
 * @returns Deterministic allow/suppress decision.
 */
export function evaluateProactiveInquiryDeliveryPolicy(
  input: ProactiveInquiryDeliveryPolicyInput
): ProactiveInquiryDeliveryPolicyDecision {
  const minExpectedUserValue = input.minExpectedUserValue ?? 0.35;
  const minNovelty = input.minNovelty ?? 0.2;
  const maxRecentNegativeOutcomes = input.maxRecentNegativeOutcomes ?? 2;
  const suppressedBy: ProactiveInquirySuppressionReason[] = [];

  if (!candidateAuthorityIsNonAuthorizing(input.candidate)) {
    suppressedBy.push("candidate_authority_invalid");
  }
  if (input.candidate.expectedUserValue < minExpectedUserValue) {
    suppressedBy.push("low_expected_user_value");
  }
  if (input.candidate.novelty < minNovelty) {
    suppressedBy.push("low_novelty");
  }
  if (input.candidate.risk.privacyRisk === "blocked") {
    suppressedBy.push("privacy_risk_blocked");
  }
  if (
    input.targetMode === "public" &&
    (input.candidate.risk.privacyRisk !== "none" || !input.candidate.risk.publicSafe)
  ) {
    suppressedBy.push("public_route_private_evidence");
  }
  if (!input.candidate.risk.activeMissionSafe) {
    suppressedBy.push("active_mission_unsafe");
  }
  if (
    input.candidate.evidencePolicy.sourceRecallStatus === "available" &&
    !input.candidate.evidencePolicy.sourceRecallUsable
  ) {
    suppressedBy.push("source_recall_unusable");
  }
  if (countRecentNegativeOutcomes(input.recentPulseHistory ?? [], input.candidate) >= maxRecentNegativeOutcomes) {
    suppressedBy.push("repeated_negative_outcome");
  }

  return {
    allowed: suppressedBy.length === 0,
    suppressedBy
  };
}

/**
 * Returns whether candidate authority flags remain non-authorizing.
 *
 * @param candidate - Candidate to inspect.
 * @returns `true` when no authority flag grants permission.
 */
function candidateAuthorityIsNonAuthorizing(candidate: ProactiveInquiryCandidate): boolean {
  return (
    candidate.authority.outreachAuthority === false &&
    candidate.authority.deliveryPermission === false &&
    candidate.authority.memoryWriteAuthority === false &&
    candidate.authority.truthAuthority === false &&
    candidate.authority.approvalAuthority === false
  );
}

/**
 * Counts recent negative outcomes for same inquiry/topic shape.
 *
 * @param recentPulseHistory - Recent emissions.
 * @param candidate - Candidate under evaluation.
 * @returns Count of ignored, dismissed, negative, or muted outcomes.
 */
function countRecentNegativeOutcomes(
  recentPulseHistory: readonly PulseEmissionRecordV1[],
  candidate: ProactiveInquiryCandidate
): number {
  return recentPulseHistory.filter((emission) => {
    if (emission.responseOutcome !== "ignored" &&
      emission.responseOutcome !== "dismissed" &&
      emission.responseOutcome !== "negative" &&
      emission.responseOutcome !== "muted") {
      return false;
    }
    const priorInquiry = emission.proactiveInquiryCandidate;
    if (!priorInquiry) {
      return Boolean(candidate.sourcePulseCandidateId) && emission.candidateId === candidate.sourcePulseCandidateId;
    }
    return (
      priorInquiry.inquiryType === candidate.inquiryType &&
      priorInquiry.questionPlan.allowedTopic === candidate.questionPlan.allowedTopic
    );
  }).length;
}
