/**
 * @fileoverview Covers stale-running-job recovery below the stable ingress coordinator.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ConversationSessionRecoveryDependencies } from "../../src/interfaces/conversationRuntime/contracts";
import { recoverStaleRunningJobIfNeeded } from "../../src/interfaces/conversationRuntime/sessionRecovery";
import type {
  ConversationJob,
  ConversationSession
} from "../../src/interfaces/sessionStore";
import { buildConversationSessionFixture } from "../helpers/conversationFixtures";

function buildSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return buildConversationSessionFixture(overrides, {
    conversationId: "chat-1",
    receivedAt: "2026-03-07T18:00:00.000Z"
  });
}

function buildQueuedJob(id: string): ConversationJob {
  return {
    id,
    input: `input-${id}`,
    executionInput: `input-${id}`,
    createdAt: "2026-03-07T17:58:00.000Z",
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

function buildDependencies(
  overrides: Partial<ConversationSessionRecoveryDependencies> = {}
): ConversationSessionRecoveryDependencies {
  return {
    config: {
      staleRunningJobRecoveryMs: 2_000,
      maxRecentJobs: 20
    },
    isWorkerActive: () => false,
    clearAckTimer: () => undefined,
    ...overrides
  };
}

test("recoverStaleRunningJobIfNeeded marks stale jobs failed and clears running state", () => {
  const session = buildSession({
    updatedAt: "2026-03-07T17:55:00.000Z",
    runningJobId: "job-1",
    recentJobs: [
      {
        ...buildQueuedJob("job-1"),
        status: "running",
        startedAt: "2026-03-07T17:55:00.000Z"
      }
    ],
    queuedJobs: [buildQueuedJob("job-2")]
  });
  let clearedSessionKey = "";

  recoverStaleRunningJobIfNeeded({
    sessionKey: "telegram:chat-1:user-1",
    session,
    nowIso: "2026-03-07T18:00:00.000Z",
    deps: buildDependencies({
      clearAckTimer: (sessionKey) => {
        clearedSessionKey = sessionKey;
      }
    })
  });

  assert.equal(clearedSessionKey, "telegram:chat-1:user-1");
  assert.equal(session.runningJobId, null);
  assert.equal(session.updatedAt, "2026-03-07T18:00:00.000Z");
  const recoveredJob = session.recentJobs.find((job) => job.id === "job-1");
  assert.ok(recoveredJob);
  assert.equal(recoveredJob?.status, "failed");
  assert.equal(recoveredJob?.ackLifecycleState, "CANCELLED");
  assert.equal(recoveredJob?.finalDeliveryLastErrorCode, "STALE_RUNNING_JOB_RECOVERED");
});

test("recoverStaleRunningJobIfNeeded leaves active workers untouched", () => {
  const session = buildSession({
    updatedAt: "2026-03-07T17:55:00.000Z",
    runningJobId: "job-1",
    recentJobs: [
      {
        ...buildQueuedJob("job-1"),
        status: "running",
        startedAt: "2026-03-07T17:55:00.000Z"
      }
    ]
  });

  recoverStaleRunningJobIfNeeded({
    sessionKey: "telegram:chat-1:user-1",
    session,
    nowIso: "2026-03-07T18:00:00.000Z",
    deps: buildDependencies({
      isWorkerActive: () => true,
      clearAckTimer: () => {
        throw new Error("clearAckTimer should not run when worker is active");
      }
    })
  });

  assert.equal(session.runningJobId, "job-1");
  assert.equal(session.recentJobs[0]?.status, "running");
});
