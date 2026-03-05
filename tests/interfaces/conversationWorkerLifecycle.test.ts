/**
 * @fileoverview Tests deterministic queue-worker lifecycle helpers extracted from conversationManager.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import {
  buildFinalMessageForJob,
  executeRunningJob,
  isBlockedSystemJobOutcome,
  markQueuedJobRunning,
  persistExecutedJobOutcome,
  shouldSuppressWorkerHeartbeat,
  type ConversationNotifierTransport
} from "../../src/interfaces/conversationWorkerLifecycle";
import { type ConversationJob } from "../../src/interfaces/sessionStore";

/**
 * Builds a deterministic queued-job fixture used by worker-lifecycle tests.
 *
 * @param createdAt - Timestamp used to seed job fields.
 * @returns Queued conversation job fixture.
 */
function buildQueuedJob(createdAt: string): ConversationJob {
  return {
    id: "job-1",
    input: "run",
    executionInput: "run",
    createdAt,
    startedAt: null,
    completedAt: null,
    status: "queued",
    resultSummary: null,
    errorMessage: null,
    ackTimerGeneration: 0,
    ackEligibleAt: null,
    ackLifecycleState: "NOT_SENT",
    ackMessageId: null,
    ackSentAt: null,
    ackEditAttemptCount: 0,
    ackLastErrorCode: null,
    finalDeliveryOutcome: "not_attempted",
    finalDeliveryAttemptCount: 0,
    finalDeliveryLastErrorCode: null,
    finalDeliveryLastAttemptAt: null
  };
}

test("markQueuedJobRunning applies deterministic running defaults and session bindings", () => {
  const nowIso = "2026-03-03T00:00:00.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  const job = buildQueuedJob(nowIso);

  markQueuedJobRunning({
    session,
    job,
    ackDelayMs: 1_200,
    maxRecentJobs: 20
  });

  assert.equal(job.status, "running");
  assert.ok(job.startedAt);
  assert.ok(job.ackEligibleAt);
  assert.equal(job.finalDeliveryOutcome, "not_attempted");
  assert.equal(session.runningJobId, job.id);
  assert.equal(session.recentJobs[0]?.id, job.id);
});

test("executeRunningJob marks completed state and runs cleanup callback", async () => {
  const nowIso = "2026-03-03T00:00:00.000Z";
  const job = buildQueuedJob(nowIso);
  job.status = "running";
  job.startedAt = nowIso;

  let cleanupCalls = 0;
  let heartbeatCalls = 0;
  const notify: ConversationNotifierTransport = {
    capabilities: { supportsEdit: false, supportsNativeStreaming: false },
    send: async () => {
      heartbeatCalls += 1;
      return { ok: true, messageId: "hb-1", errorCode: null };
    }
  };

  await executeRunningJob({
    job,
    executeTask: async () => ({ summary: "Completed successfully." }),
    notify,
    heartbeatIntervalMs: 5,
    suppressHeartbeat: true,
    onExecutionSettled: () => {
      cleanupCalls += 1;
    }
  });

  assert.equal(job.status, "completed");
  assert.equal(job.resultSummary, "Completed successfully.");
  assert.equal(job.errorMessage, null);
  assert.equal(cleanupCalls, 1);
  assert.equal(heartbeatCalls, 0);
});

test("executeRunningJob marks failed state when execution throws", async () => {
  const nowIso = "2026-03-03T00:00:00.000Z";
  const job = buildQueuedJob(nowIso);
  job.status = "running";
  job.startedAt = nowIso;

  await executeRunningJob({
    job,
    executeTask: async () => {
      throw new Error("boom");
    },
    notify: {
      capabilities: { supportsEdit: false, supportsNativeStreaming: false },
      send: async () => ({ ok: true, messageId: "hb-1", errorCode: null })
    },
    heartbeatIntervalMs: 5,
    suppressHeartbeat: true,
    onExecutionSettled: () => undefined
  });

  assert.equal(job.status, "failed");
  assert.equal(job.resultSummary, null);
  assert.equal(job.errorMessage, "boom");
  assert.ok(job.completedAt);
});

test("executeRunningJob uses native streaming heartbeat path when supported", async () => {
  const nowIso = "2026-03-03T00:00:00.000Z";
  const job = buildQueuedJob(nowIso);
  job.status = "running";
  job.startedAt = nowIso;

  let sendCalls = 0;
  let streamCalls = 0;
  await executeRunningJob({
    job,
    executeTask: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { summary: "native stream complete" };
    },
    notify: {
      capabilities: { supportsEdit: false, supportsNativeStreaming: true },
      send: async () => {
        sendCalls += 1;
        return { ok: true, messageId: "send-1", errorCode: null };
      },
      stream: async () => {
        streamCalls += 1;
        return { ok: true, messageId: null, errorCode: null };
      }
    },
    heartbeatIntervalMs: 5,
    suppressHeartbeat: false,
    onExecutionSettled: () => undefined
  });

  assert.equal(job.status, "completed");
  assert.equal(sendCalls, 0);
  assert.ok(streamCalls >= 1);
});

test("shouldSuppressWorkerHeartbeat suppresses autonomous and system jobs", () => {
  const nowIso = "2026-03-03T00:00:00.000Z";
  const autonomousJob: ConversationJob = {
    ...buildQueuedJob(nowIso),
    executionInput: "[AUTONOMOUS_LOOP_GOAL] keep going",
    isSystemJob: false
  };
  const systemJob: ConversationJob = {
    ...buildQueuedJob(nowIso),
    executionInput: "regular",
    isSystemJob: true
  };

  assert.equal(
    shouldSuppressWorkerHeartbeat(autonomousJob, "[AUTONOMOUS_LOOP_GOAL]"),
    true
  );
  assert.equal(
    shouldSuppressWorkerHeartbeat(systemJob, "[AUTONOMOUS_LOOP_GOAL]"),
    true
  );
});

test("shouldSuppressWorkerHeartbeat suppresses editable and native draft streaming transports", () => {
  const nowIso = "2026-03-03T00:00:00.000Z";
  const job: ConversationJob = {
    ...buildQueuedJob(nowIso),
    executionInput: "regular",
    isSystemJob: false
  };

  const editableNotifier: ConversationNotifierTransport = {
    capabilities: { supportsEdit: true, supportsNativeStreaming: false },
    send: async () => ({ ok: true, messageId: "1", errorCode: null })
  };
  const streamingNotifier: ConversationNotifierTransport = {
    capabilities: { supportsEdit: false, supportsNativeStreaming: true },
    send: async () => ({ ok: true, messageId: null, errorCode: null }),
    stream: async () => ({ ok: true, messageId: null, errorCode: null })
  };

  assert.equal(
    shouldSuppressWorkerHeartbeat(job, "[AUTONOMOUS_LOOP_GOAL]", editableNotifier),
    true
  );
  assert.equal(
    shouldSuppressWorkerHeartbeat(job, "[AUTONOMOUS_LOOP_GOAL]", streamingNotifier),
    true
  );
});

test("persistExecutedJobOutcome writes canonical recent-job state and assistant turn history", () => {
  const nowIso = "2026-03-03T00:00:00.000Z";
  const completedAt = "2026-03-03T00:00:02.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-2",
    userId: "user-2",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-1";

  const queued = buildQueuedJob(nowIso);
  const running = {
    ...queued,
    status: "running" as const,
    startedAt: nowIso
  };
  session.recentJobs = [running];

  const executedJob: ConversationJob = {
    ...running,
    status: "completed",
    completedAt,
    resultSummary: "All set.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    maxRecentJobs: 20,
    maxConversationTurns: 40
  });

  assert.equal(session.runningJobId, null);
  assert.equal(persisted.status, "completed");
  assert.equal(persisted.resultSummary, "All set.");
  assert.equal(session.recentJobs[0]?.id, "job-1");
  assert.equal(session.conversationTurns.at(-1)?.role, "assistant");
  assert.equal(session.conversationTurns.at(-1)?.text, "All set.");
  assert.equal(buildFinalMessageForJob(persisted, false), "All set.");
  assert.equal(buildFinalMessageForJob(
    {
      ...persisted,
      status: "failed",
      errorMessage: "No route"
    },
    false
  ), "Request failed: No route.");
});

test("isBlockedSystemJobOutcome only matches completed blocked system outputs", () => {
  const nowIso = "2026-03-03T00:00:00.000Z";
  const blocked = {
    ...buildQueuedJob(nowIso),
    status: "completed" as const,
    isSystemJob: true,
    resultSummary: "State: blocked (policy)."
  };
  const normal = {
    ...buildQueuedJob(nowIso),
    status: "completed" as const,
    isSystemJob: true,
    resultSummary: "Done."
  };

  assert.equal(isBlockedSystemJobOutcome(blocked), true);
  assert.equal(isBlockedSystemJobOutcome(normal), false);
});
