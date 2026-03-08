/**
 * @fileoverview Implements deterministic worker-loop lifecycle helpers for conversation queue execution.
 */

import { assertAckInvariants } from "./ackStateMachine";
import { backfillPulseSnippet } from "./pulseEmissionLifecycle";
import { elapsedSeconds } from "./conversationManagerHelpers";
import {
  findRecentJob,
  recordAssistantTurn,
  upsertRecentJob
} from "./conversationSessionMutations";
import {
  ConversationJob,
  ConversationSession
} from "./sessionStore";
import type {
  ConversationNotifierTransport,
  ExecuteConversationTask
} from "./conversationRuntime/managerContracts";

export type {
  ConversationDeliveryResult,
  ConversationExecutionResult,
  ConversationNotifierCapabilities,
  ConversationNotifierTransport,
  ExecuteConversationTask
} from "./conversationRuntime/managerContracts";

/**
 * Evaluates notifier native-streaming support and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Worker heartbeat delivery chooses between persistent messages and Telegram draft streaming based on
 * this capability check to avoid duplicate transport branching logic.
 *
 * **What it talks to:**
 * - Reads notifier capabilities and optional `stream` transport method.
 *
 * @param notify - Transport used by the worker loop for progress delivery.
 * @returns `true` when native streaming is supported and callable.
 */
function canUseNativeStreaming(
  notify: ConversationNotifierTransport
): boolean {
  return notify.capabilities.supportsNativeStreaming && typeof notify.stream === "function";
}

/**
 * Builds a short request preview for worker progress messaging.
 *
 * **Why it exists:**
 * Generic "still working" pings are low-signal. This helper keeps progress updates anchored to
 * the actual request while bounding message length for chat transports.
 *
 * **What it talks to:**
 * - Reads `ConversationJob` input/executionInput fields.
 *
 * @param job - Running job whose request preview should be rendered.
 * @returns Bounded request summary for progress messages.
 */
function summarizeJobForProgress(job: ConversationJob): string {
  const rawText = (job.input || job.executionInput || "your request")
    .replace(/\s+/g, " ")
    .trim();
  if (!rawText) {
    return "your request";
  }
  return rawText.length > 100 ? `${rawText.slice(0, 100)}...` : rawText;
}

/**
 * Builds a human-first worker progress message.
 *
 * **Why it exists:**
 * Queue worker updates should sound like active help instead of idle telemetry while still making
 * elapsed-time context available during longer runs.
 *
 * **What it talks to:**
 * - Uses `summarizeJobForProgress` within this module.
 *
 * @param job - Running job being described.
 * @param elapsed - Optional elapsed-time value in seconds.
 * @returns Human-readable progress message.
 */
function buildWorkerProgressMessage(job: ConversationJob, elapsed?: number): string {
  const preview = summarizeJobForProgress(job);
  if (typeof elapsed === "number") {
    return `Working on your request: ${preview} (${elapsed}s elapsed)`;
  }
  return `Working on your request: ${preview}`;
}

export interface MarkQueuedJobRunningInput {
  session: ConversationSession;
  job: ConversationJob;
  ackDelayMs: number;
  maxRecentJobs: number;
}

/**
 * Marks a queued job as running and applies deterministic ack/final-delivery reset defaults.
 *
 * **Why it exists:**
 * Queue workers need one canonical mutation path before execution starts, otherwise status/ack
 * fields can drift between enqueue and execution surfaces.
 *
 * **What it talks to:**
 * - Mutates `ConversationJob` execution lifecycle fields.
 * - Mutates `ConversationSession.runningJobId`, `updatedAt`, and `recentJobs` via `upsertRecentJob`.
 *
 * @param input - Session/job context and lifecycle bounds for this transition.
 */
export function markQueuedJobRunning(input: MarkQueuedJobRunningInput): void {
  const {
    session,
    job,
    ackDelayMs,
    maxRecentJobs
  } = input;
  const startedAt = new Date().toISOString();
  job.status = "running";
  job.startedAt = startedAt;
  job.completedAt = null;
  job.errorMessage = null;
  job.resultSummary = null;
  job.ackMessageId = null;
  job.ackSentAt = null;
  job.ackLastErrorCode = null;
  job.ackEditAttemptCount = 0;
  job.ackEligibleAt = new Date(Date.parse(startedAt) + ackDelayMs).toISOString();
  job.finalDeliveryOutcome = "not_attempted";
  job.finalDeliveryAttemptCount = 0;
  job.finalDeliveryLastErrorCode = null;
  job.finalDeliveryLastAttemptAt = null;
  session.runningJobId = job.id;
  session.updatedAt = startedAt;
  upsertRecentJob(session, job, maxRecentJobs);
}

/**
 * Determines whether worker heartbeat pings should be suppressed for a running job.
 *
 * **Why it exists:**
 * Autonomous/system jobs emit their own structured state and should not add generic
 * "Still working..." pings that can confuse users. Editable-ack transports suppress generic
 * heartbeats to avoid progress messages landing after final edited responses, and native-draft
 * transports suppress generic heartbeats to avoid long-lived draft placeholders.
 *
 * **What it talks to:**
 * - Reads `job.executionInput` and `job.isSystemJob`.
 * - Optionally reads notifier transport capabilities.
 *
 * @param job - Running job under evaluation.
 * @param autonomousExecutionPrefix - Prefix used to mark autonomous-loop execution input.
 * @param notify - Optional notifier transport capabilities for session-level suppression checks.
 * @returns `true` when heartbeat pings should be suppressed.
 */
export function shouldSuppressWorkerHeartbeat(
  job: ConversationJob,
  autonomousExecutionPrefix: string,
  notify?: ConversationNotifierTransport
): boolean {
  const isAutonomousJob =
    job.executionInput?.startsWith(autonomousExecutionPrefix) ?? false;
  const hasEditableAckTransport =
    notify?.capabilities.supportsEdit === true &&
    notify.capabilities.supportsNativeStreaming !== true;
  const hasNativeDraftStreamingTransport =
    notify?.capabilities.supportsNativeStreaming === true;
  return (
    isAutonomousJob ||
    job.isSystemJob === true ||
    hasEditableAckTransport ||
    hasNativeDraftStreamingTransport
  );
}

export interface ExecuteRunningJobInput {
  job: ConversationJob;
  executeTask: ExecuteConversationTask;
  notify: ConversationNotifierTransport;
  heartbeatIntervalMs: number;
  suppressHeartbeat: boolean;
  onExecutionSettled(): void;
}

/**
 * Runs one conversation job with optional heartbeat notifications and captures terminal status.
 *
 * **Why it exists:**
 * Worker-loop execution must consistently apply success/failure status semantics while cleaning up
 * timers/resources in `finally`, regardless of task outcomes.
 *
 * **What it talks to:**
 * - Calls runtime `executeTask` callback with execution input.
 * - Uses notifier `send()`/`stream()` for heartbeat pings when enabled.
 * - Invokes `onExecutionSettled` callback for timer cleanup.
 *
 * @param input - Running job, worker callbacks, and heartbeat controls.
 * @returns Promise resolving after status fields are updated and cleanup callback is invoked.
 */
export async function executeRunningJob(input: ExecuteRunningJobInput): Promise<void> {
  const {
    job,
    executeTask,
    notify,
    heartbeatIntervalMs,
    suppressHeartbeat,
    onExecutionSettled
  } = input;
  const useNativeStreaming = !suppressHeartbeat && canUseNativeStreaming(notify);

  if (useNativeStreaming) {
    void notify.stream!(buildWorkerProgressMessage(job)).catch(() => undefined);
  }

  const heartbeat = suppressHeartbeat
    ? null
    : setInterval(() => {
        if (job.status !== "running") {
          return;
        }
        const elapsed = elapsedSeconds(job.startedAt ?? job.createdAt);
        const progressText = buildWorkerProgressMessage(job, elapsed);
        if (useNativeStreaming) {
          void notify.stream!(progressText).catch(() => undefined);
          return;
        }
        void notify.send(progressText).catch(() => undefined);
      }, heartbeatIntervalMs);

  try {
    const result = await executeTask(job.executionInput ?? job.input, job.createdAt);
    job.status = "completed";
    job.completedAt = new Date().toISOString();
    job.resultSummary = result.summary;
    job.errorMessage = null;
  } catch (error) {
    job.status = "failed";
    job.completedAt = new Date().toISOString();
    job.resultSummary = null;
    job.errorMessage = (error as Error).message;
  } finally {
    if (heartbeat) {
      clearInterval(heartbeat);
    }
    onExecutionSettled();
  }
}

export interface PersistJobOutcomeInput {
  session: ConversationSession;
  executedJob: ConversationJob;
  maxRecentJobs: number;
  maxConversationTurns: number;
}

/**
 * Persists completed worker outcome into session-ledger state and updates turn/pulse metadata.
 *
 * **Why it exists:**
 * Queue execution and delivery paths need one deterministic post-execution persistence rule set for
 * status updates, ack invariant checks, and conversation-context writes.
 *
 * **What it talks to:**
 * - Reads/writes `session.recentJobs` via `findRecentJob` and `upsertRecentJob`.
 * - Validates ack invariants with `assertAckInvariants`.
 * - Updates pulse + turn history via `backfillPulseSnippet` and `recordAssistantTurn`.
 *
 * @param input - Persisted session snapshot and completed in-memory job fields.
 * @returns Canonical persisted job record from session state.
 */
export function persistExecutedJobOutcome(input: PersistJobOutcomeInput): ConversationJob {
  const {
    session,
    executedJob,
    maxRecentJobs,
    maxConversationTurns
  } = input;
  const persistedRunningJob = findRecentJob(session, executedJob.id) ?? executedJob;
  persistedRunningJob.status = executedJob.status;
  persistedRunningJob.completedAt = executedJob.completedAt;
  persistedRunningJob.resultSummary = executedJob.resultSummary;
  persistedRunningJob.errorMessage = executedJob.errorMessage;

  const invariant = assertAckInvariants(persistedRunningJob);
  if (!invariant.ok) {
    persistedRunningJob.ackLastErrorCode = invariant.reasonCode ?? "ACK_INVARIANT_FAILED";
  }

  session.runningJobId = null;
  session.updatedAt = new Date().toISOString();
  upsertRecentJob(session, persistedRunningJob, maxRecentJobs);

  if (persistedRunningJob.status === "completed") {
    backfillPulseSnippet(session, persistedRunningJob);
  }
  if (persistedRunningJob.status === "completed" && persistedRunningJob.resultSummary) {
    recordAssistantTurn(
      session,
      persistedRunningJob.resultSummary,
      persistedRunningJob.completedAt ?? session.updatedAt,
      maxConversationTurns
    );
  }

  return persistedRunningJob;
}

/**
 * Detects the deterministic system-job blocked state that should suppress duplicate final delivery.
 *
 * @param job - Persisted job outcome being evaluated.
 * @returns `true` when this job already emitted blocked output and should skip final send/edit.
 */
export function isBlockedSystemJobOutcome(job: ConversationJob): boolean {
  return (
    job.isSystemJob === true &&
    job.status === "completed" &&
    typeof job.resultSummary === "string" &&
    job.resultSummary.includes("State: blocked")
  );
}

/**
 * Builds the final user-facing message text from a completed or failed conversation job.
 *
 * @param job - Persisted job outcome being rendered.
 * @param showCompletionPrefix - Whether to prepend "Done." to successful completions.
 * @returns Final message text passed to delivery lifecycle helpers.
 */
export function buildFinalMessageForJob(
  job: ConversationJob,
  showCompletionPrefix: boolean
): string {
  if (job.status === "completed") {
    const completionMessage = job.resultSummary ?? "";
    if (showCompletionPrefix) {
      return [
        "Done.",
        completionMessage
      ].filter(Boolean).join("\n");
    }
    return completionMessage.trim()
      ? completionMessage
      : "Request completed.";
  }
  return `Request failed: ${job.errorMessage ?? "Unknown error"}.`;
}
