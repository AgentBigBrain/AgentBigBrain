/**
 * @fileoverview Conversation draft and status rendering helpers shared by command and proposal flows.
 */

import { makeId } from "../core/ids";
import { findRecentJob } from "./conversationSessionMutations";
import {
  normalizeWhitespace,
  proposalPreview,
  renderPulseTargetConversation
} from "./conversationManagerHelpers";
import {
  ConversationJob,
  ConversationSession,
  PendingProposal
} from "./sessionStore";

const STATUS_JOB_PREVIEW_MAX_CHARS = 96;

/**
 * Builds a pluralized request count phrase for status output.
 *
 * **Why it exists:**
 * Keeps human-facing queue text consistent so status replies do not drift across idle, queued, and
 * running states.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param count - Request count being described.
 * @returns Human-readable request-count phrase.
 */
function formatRequestCount(count: number): string {
  return `${count} request${count === 1 ? "" : "s"}`;
}

/**
 * Converts one job into a short human-readable subject for status summaries.
 *
 * **Why it exists:**
 * Status output should talk about the work in plain language without leaking internal placeholder
 * markers or overlong raw prompts.
 *
 * **What it talks to:**
 * - Uses `normalizeWhitespace` from `./conversationManagerHelpers`.
 *
 * @param job - Job being summarized for a user-facing status line.
 * @returns Short deterministic job subject.
 */
function summarizeConversationJobSubject(job: ConversationJob): string {
  if (job.isSystemJob) {
    return "an Agent Pulse check-in";
  }
  if (job.input === "__recovered_stale_job__") {
    return "a recovered interrupted job";
  }

  const normalized = normalizeWhitespace(job.input);
  if (!normalized) {
    return "a request";
  }
  if (normalized.length <= STATUS_JOB_PREVIEW_MAX_CHARS) {
    return normalized;
  }
  return `${normalized.slice(0, STATUS_JOB_PREVIEW_MAX_CHARS - 3)}...`;
}

/**
 * Builds the primary human-first status headline for the current session state.
 *
 * **Why it exists:**
 * Keeps the first status line focused on what the user most needs to know right now instead of raw
 * job-control metadata.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param runningJob - Currently running job when one exists.
 * @param queuedCount - Number of queued jobs still waiting.
 * @returns Human-readable status headline.
 */
function buildConversationStatusHeadline(
  runningJob: ConversationJob | null,
  queuedCount: number
): string {
  if (runningJob) {
    return "Current status: I'm working on a request right now.";
  }
  if (queuedCount > 0) {
    return `Current status: ${formatRequestCount(queuedCount)} ${queuedCount === 1 ? "is" : "are"} waiting to start.`;
  }
  return "Current status: Nothing is running right now.";
}

/**
 * Builds the human-facing queue summary for the current session state.
 *
 * **Why it exists:**
 * Separates queue wording from the raw queue counters so default `/status` stays readable while
 * still communicating backlog state precisely.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param runningJob - Currently running job when one exists.
 * @param queuedCount - Number of queued jobs still waiting.
 * @returns Human-readable queue summary sentence.
 */
function buildConversationQueueSummary(
  runningJob: ConversationJob | null,
  queuedCount: number
): string {
  if (runningJob && queuedCount > 0) {
    return `Queue: ${formatRequestCount(queuedCount)} waiting after the current run.`;
  }
  if (runningJob) {
    return "Queue: no other requests waiting.";
  }
  if (queuedCount > 0) {
    return `Queue: ${formatRequestCount(queuedCount)} waiting to start.`;
  }
  return "Queue: empty.";
}

/**
 * Builds recent-activity bullet lines for the human-first status view.
 *
 * **Why it exists:**
 * Recent jobs provide useful context, but the default status surface should summarize them in plain
 * language instead of exposing raw ids and transport metadata.
 *
 * **What it talks to:**
 * - Uses `summarizeConversationJobSubject` in this module.
 *
 * @param session - Session snapshot being rendered.
 * @param runningJobId - Optional running-job id excluded from duplicate recent-activity bullets.
 * @returns Bullet lines suitable for the default `/status` output.
 */
function buildRecentActivityLines(
  session: ConversationSession,
  runningJobId: string | null
): string[] {
  const visibleRecentJobs = session.recentJobs
    .filter((job) => job.id !== runningJobId)
    .slice(0, 3);

  const lines: string[] = [];
  for (const job of visibleRecentJobs) {
    const subject = summarizeConversationJobSubject(job);
    if (job.status === "completed") {
      lines.push(`- Completed: ${subject}`);
      continue;
    }
    if (job.status === "failed") {
      lines.push(`- Stopped: ${subject}`);
      continue;
    }
    if (job.status === "running") {
      lines.push(`- Still running: ${subject}`);
    }
  }
  return lines;
}

/**
 * Renders the deterministic `/status` summary for a conversation session.
 *
 * **Why it exists:**
 * Keeps the default `/status` surface human-first so normal operators see what is happening
 * without parsing delivery-lifecycle internals.
 *
 * **What it talks to:**
 * - Uses `findRecentJob` to resolve running-job metadata.
 * - Uses `proposalPreview` from `./conversationManagerHelpers`.
 * - Uses local human-first status helpers within this module.
 *
 * @param session - Session snapshot being rendered.
 * @returns Human-readable status block.
 */
export function renderConversationStatus(session: ConversationSession): string {
  const runningJob = session.runningJobId
    ? findRecentJob(session, session.runningJobId) ?? null
    : null;
  const lines: string[] = [];
  lines.push(buildConversationStatusHeadline(runningJob, session.queuedJobs.length));
  if (runningJob) {
    lines.push(`Working on: ${summarizeConversationJobSubject(runningJob)}`);
  } else if (session.queuedJobs.length > 0) {
    lines.push(`Next up: ${summarizeConversationJobSubject(session.queuedJobs[0])}`);
  }
  lines.push(buildConversationQueueSummary(runningJob, session.queuedJobs.length));
  if (session.activeProposal) {
    lines.push("Draft: ready for approval.");
    lines.push(`Draft preview: ${proposalPreview(session.activeProposal)}`);
  } else {
    lines.push("Draft: none.");
  }
  lines.push(
    `Agent Pulse: ${session.agentPulse.optIn ? `on (${session.agentPulse.mode} mode)` : "off"}.`
  );
  lines.push(
    `Model backend: ${session.modelBackendOverride ?? "process default"}${
      session.codexAuthProfileId ? ` (Codex profile ${session.codexAuthProfileId})` : ""
    }.`
  );

  const recentActivityLines = buildRecentActivityLines(session, runningJob?.id ?? null);
  if (recentActivityLines.length > 0) {
    lines.push("Recent activity:");
    lines.push(...recentActivityLines);
  }

  lines.push("If you want the technical view behind this status, you can still run /status debug.");
  return lines.join("\n");
}

/**
 * Renders the detailed operator/debug `/status` summary for a conversation session.
 *
 * **Why it exists:**
 * Preserves the full delivery/ack/job-lifecycle view for troubleshooting without forcing every
 * normal `/status` request to read operator-centric metadata.
 *
 * **What it talks to:**
 * - Uses `findRecentJob` to resolve running-job metadata.
 *
 * @param session - Session snapshot being rendered.
 * @returns Detailed debug status block.
 */
export function renderConversationStatusDebug(session: ConversationSession): string {
  const lines: string[] = [];
  lines.push("Debug status:");
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
  lines.push(`Model backend override: ${session.modelBackendOverride ?? "none"}`);
  lines.push(`Codex profile override: ${session.codexAuthProfileId ?? "none"}`);
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
