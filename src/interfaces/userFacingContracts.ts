/**
 * @fileoverview Defines deterministic user-facing envelope and truth-policy helpers for Stage 6.85 rendering.
 */

import { TaskRunResult } from "../core/types";

export type UserFacingEnvelopeStateV1 =
  | "OK"
  | "NO_OP"
  | "BLOCKED"
  | "UNSUPPORTED"
  | "AWAITING_APPROVAL";

export interface UserFacingEnvelopeV1 {
  schema: "UserFacingEnvelopeV1";
  state: UserFacingEnvelopeStateV1;
  reasonCode: string | null;
  shortMessage: string;
  nextStep: string | null;
  diagnosticsRef: string | null;
}

/**
 * Builds an immutable UserFacingEnvelopeV1 object.
 */
export function buildUserFacingEnvelopeV1(
  state: UserFacingEnvelopeStateV1,
  shortMessage: string,
  reasonCode: string | null,
  nextStep: string | null,
  diagnosticsRef: string | null = null
): UserFacingEnvelopeV1 {
  return {
    schema: "UserFacingEnvelopeV1",
    state,
    reasonCode,
    shortMessage: shortMessage.trim(),
    nextStep: nextStep ? nextStep.trim() : null,
    diagnosticsRef
  };
}

/**
 * Renders UserFacingEnvelopeV1 to deterministic user-facing text.
 */
export function renderUserFacingEnvelopeV1(envelope: UserFacingEnvelopeV1): string {
  if (envelope.state === "OK") {
    return envelope.nextStep
      ? `${envelope.shortMessage}\nNext step: ${envelope.nextStep}`
      : envelope.shortMessage;
  }

  if (envelope.state === "BLOCKED") {
    const lines = [envelope.shortMessage];
    if (envelope.reasonCode) {
      lines.push(`Reason code: ${envelope.reasonCode}`);
    }
    if (envelope.nextStep) {
      lines.push(`Next step: ${envelope.nextStep}`);
    }
    return lines.join("\n");
  }

  if (envelope.state === "AWAITING_APPROVAL") {
    const lines = [envelope.shortMessage];
    if (envelope.nextStep) {
      lines.push(`Next step: ${envelope.nextStep}`);
    }
    return lines.join("\n");
  }

  const safeReasonCode = envelope.reasonCode ?? "NO_OP_UNSPECIFIED";
  const safeNextStep = envelope.nextStep ?? "Request a governed next step and retry.";
  return [
    envelope.shortMessage,
    "No-op outcome:",
    `- reasonCode: ${safeReasonCode}`,
    `- reason: ${envelope.shortMessage}`,
    `- nextStep: ${safeNextStep}`
  ].join("\n");
}

/**
 * Applies TruthPolicyV1 wording invariants to run summaries so blocked outcomes never claim completion.
 */
export function applyTruthPolicyV1ToOutcomeSummary(
  summary: string,
  runResult: TaskRunResult
): string {
  const approvedCount = runResult.actionResults.filter((result) => result.approved).length;
  const blockedCount = runResult.actionResults.filter((result) => !result.approved).length;
  if (blockedCount === 0) {
    return summary;
  }

  const normalized = summary.trim();
  if (!/^completed task with\s+/i.test(normalized)) {
    return summary;
  }

  const detailTail = normalized.replace(/^completed task with\s+/i, "");
  if (approvedCount === 0) {
    return `Task ended blocked with ${detailTail}`;
  }
  return `Task ended with mixed outcomes: ${detailTail}`;
}
