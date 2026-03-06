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
    const lines = [
      envelope.shortMessage,
      "What happened: one or more governed actions were blocked before execution.",
      "Why it didn't execute: safety, governance, or runtime policy denied this request."
    ];
    if (envelope.nextStep) {
      lines.push(`What to do next: ${envelope.nextStep}`);
    }
    if (envelope.reasonCode) {
      lines.push(`Technical reason code: ${envelope.reasonCode}`);
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

  const whyLine =
    envelope.state === "UNSUPPORTED"
      ? "Why it didn't execute: this runtime path is unavailable for the requested operation."
      : "Why it didn't execute: no approved governed side-effect action completed in this run.";
  const lines = [
    envelope.shortMessage,
    envelope.state === "UNSUPPORTED"
      ? "What happened: the requested capability is not available in this runtime path."
      : "What happened: this run finished without executing the requested side effect.",
    whyLine
  ];
  if (envelope.nextStep) {
    lines.push(`What to do next: ${envelope.nextStep}`);
  }
  if (envelope.reasonCode) {
    lines.push(`Technical reason code: ${envelope.reasonCode}`);
  }
  return lines.join("\n");
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
