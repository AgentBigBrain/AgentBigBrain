/**
 * @fileoverview Conversation draft and status rendering helpers shared by command and proposal flows.
 */

import { makeId } from "../core/ids";
import { findRecentJob } from "./conversationSessionMutations";
import { proposalPreview, renderPulseTargetConversation } from "./conversationManagerHelpers";
import {
  ConversationSession,
  PendingProposal
} from "./sessionStore";

/**
 * Renders the deterministic `/status` summary for a conversation session.
 *
 * **Why it exists:**
 * Keeps queue/worker/draft/pulse status formatting in one place so command and tests share the
 * same output contract.
 *
 * **What it talks to:**
 * - Uses `findRecentJob` to resolve running-job metadata.
 *
 * @param session - Session snapshot being rendered.
 * @returns Human-readable status block.
 */
export function renderConversationStatus(session: ConversationSession): string {
  const lines: string[] = [];
  lines.push(`Running job: ${session.runningJobId ?? "none"}`);
  lines.push(`Queued jobs: ${session.queuedJobs.length}`);
  if (session.runningJobId) {
    const runningJob = findRecentJob(session, session.runningJobId);
    if (runningJob) {
      lines.push(
        `Running ack: state=${runningJob.ackLifecycleState}, generation=${runningJob.ackTimerGeneration}, eligibleAt=${runningJob.ackEligibleAt ?? "none"}`
      );
      lines.push(
        `Running final delivery: outcome=${runningJob.finalDeliveryOutcome}, attempts=${runningJob.finalDeliveryAttemptCount}, lastError=${runningJob.finalDeliveryLastErrorCode ?? "none"}`
      );
    }
  }
  if (session.activeProposal) {
    lines.push(`Active draft: ${session.activeProposal.id}`);
  } else {
    lines.push("Active draft: none");
  }
  lines.push(`Conversation turns: ${session.conversationTurns.length}`);
  lines.push(
    `Agent Pulse: ${session.agentPulse.optIn ? "on" : "off"} ` +
    `(mode=${session.agentPulse.mode}, route=${session.agentPulse.routeStrategy})`
  );

  if (session.recentJobs.length > 0) {
    lines.push("Recent jobs:");
    for (const job of session.recentJobs.slice(0, 3)) {
      lines.push(`- ${job.id} (${job.status})`);
    }
  }

  return lines.join("\n");
}

/**
 * Renders deterministic Agent Pulse details for `/pulse status`.
 *
 * **Why it exists:**
 * Pulse mode and decision metadata are safety-relevant, so status output must stay stable and
 * explicit for user verification.
 *
 * **What it talks to:**
 * - Uses `renderPulseTargetConversation` to normalize target conversation display.
 *
 * @param session - Session snapshot containing pulse runtime fields.
 * @returns Human-readable pulse status block.
 */
export function renderAgentPulseStatus(session: ConversationSession): string {
  return [
    `Agent Pulse: ${session.agentPulse.optIn ? "on" : "off"}`,
    `Mode: ${session.agentPulse.mode}`,
    `Route strategy: ${session.agentPulse.routeStrategy}`,
    `Last decision: ${session.agentPulse.lastDecisionCode}`,
    `Last evaluated at: ${session.agentPulse.lastEvaluatedAt ?? "never"}`,
    `Last sent at: ${session.agentPulse.lastPulseSentAt ?? "never"}`,
    `Last reason: ${session.agentPulse.lastPulseReason ?? "none"}`,
    `Last target conversation: ${renderPulseTargetConversation(
      session.agentPulse.lastPulseTargetConversationId
    )}`
  ].join("\n");
}

/**
 * Clears transient pulse evaluation fields after pulse mode/opt-in changes.
 *
 * **Why it exists:**
 * Switching pulse settings should reset stale evaluation state so follow-up status reflects only
 * decisions made under the new configuration.
 *
 * **What it talks to:**
 * - Mutates `session.agentPulse` runtime decision fields.
 *
 * @param session - Session whose pulse runtime status should be reset.
 */
export function resetAgentPulseRuntimeStatus(session: ConversationSession): void {
  session.agentPulse.lastDecisionCode = "NOT_EVALUATED";
  session.agentPulse.lastEvaluatedAt = null;
  session.agentPulse.lastPulseReason = null;
  session.agentPulse.lastPulseTargetConversationId = null;
  session.agentPulse.lastContextualLexicalEvidence = null;
}

/**
 * Creates a new proposal draft and stores it in session state.
 *
 * **Why it exists:**
 * Proposal mode requires deterministic draft creation (ID, timestamps, preview text, status) before
 * any approval/execute transition can occur.
 *
 * **What it talks to:**
 * - Uses `makeId` for draft identifiers.
 * - Uses `proposalPreview` for user-facing preview text.
 * - Mutates `session.activeProposal` and `session.updatedAt`.
 *
 * @param session - Session receiving the new draft.
 * @param input - Raw draft input text from the user.
 * @param receivedAt - Timestamp applied to draft/session updates.
 * @param maxProposalInputChars - Hard size limit for draft text.
 * @returns User-facing creation response.
 */
export function createProposalDraft(
  session: ConversationSession,
  input: string,
  receivedAt: string,
  maxProposalInputChars: number
): string {
  const normalizedInput = input.trim();
  if (normalizedInput.length > maxProposalInputChars) {
    return `Proposal is too long. Limit is ${maxProposalInputChars} characters.`;
  }

  const proposal: PendingProposal = {
    id: makeId("proposal"),
    originalInput: normalizedInput,
    currentInput: normalizedInput,
    createdAt: receivedAt,
    updatedAt: receivedAt,
    status: "pending"
  };
  session.activeProposal = proposal;
  session.updatedAt = receivedAt;

  return [
    `Draft ${proposal.id} created.`,
    `Preview: ${proposalPreview(proposal)}`,
    "Ask questions in plain language, or use /adjust, /approve, /cancel."
  ].join("\n");
}

/**
 * Renders deterministic draft metadata for `/draft` responses.
 *
 * **Why it exists:**
 * Draft status formatting is reused in multiple paths and should remain identical.
 *
 * **What it talks to:**
 * - Uses `proposalPreview`.
 *
 * @param proposal - Draft proposal to render.
 * @returns Human-readable draft status block.
 */
export function renderProposalDraftStatus(proposal: PendingProposal): string {
  return [
    `Draft ${proposal.id} (${proposal.status})`,
    `Created: ${proposal.createdAt}`,
    `Updated: ${proposal.updatedAt}`,
    `Preview: ${proposalPreview(proposal)}`
  ].join("\n");
}

/**
 * Applies a user adjustment to the active draft with deterministic size enforcement.
 *
 * **Why it exists:**
 * Draft changes should preserve a plain-text audit trail while preventing unbounded draft growth.
 *
 * **What it talks to:**
 * - Mutates `session.activeProposal` and `session.updatedAt`.
 * - Uses `proposalPreview` for response text.
 *
 * @param session - Session containing the active draft.
 * @param adjustment - User-provided adjustment text.
 * @param receivedAt - Timestamp for mutation tracking.
 * @param maxProposalInputChars - Hard size limit for updated draft text.
 * @returns User-facing adjustment result.
 */
export function adjustProposalDraft(
  session: ConversationSession,
  adjustment: string,
  receivedAt: string,
  maxProposalInputChars: number
): string {
  const active = session.activeProposal;
  if (!active) {
    return "No active draft to adjust. Use /propose <task> first.";
  }

  const updated = `${active.currentInput}\nAdjustment requested by user: ${adjustment.trim()}`.trim();
  if (updated.length > maxProposalInputChars) {
    return `Cannot apply adjustment because draft would exceed ${maxProposalInputChars} characters.`;
  }

  active.currentInput = updated;
  active.updatedAt = receivedAt;
  session.updatedAt = receivedAt;

  return [
    `Draft ${active.id} updated.`,
    `Preview: ${proposalPreview(active)}`,
    "Continue with more questions/adjustments, or approve when ready."
  ].join("\n");
}

/**
 * Cancels the active draft and clears session draft state.
 *
 * **Why it exists:**
 * Proposal lifecycle needs an explicit cancellation path that records terminal draft status and
 * clears execution readiness.
 *
 * **What it talks to:**
 * - Mutates `session.activeProposal` and `session.updatedAt`.
 *
 * @param session - Mutable session state being updated.
 * @param receivedAt - Cancellation timestamp.
 * @returns User-facing cancellation result.
 */
export function cancelProposalDraft(session: ConversationSession, receivedAt: string): string {
  const active = session.activeProposal;
  if (!active) {
    return "No active draft to cancel.";
  }

  active.status = "cancelled";
  active.updatedAt = receivedAt;
  session.activeProposal = null;
  session.updatedAt = receivedAt;
  return `Draft ${active.id} cancelled.`;
}
