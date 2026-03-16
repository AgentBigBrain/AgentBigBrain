/**
 * @fileoverview Tests canonical persistence of structured conversation execution progress updates.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import { InterfaceSessionStore } from "../../src/interfaces/sessionStore";
import { persistConversationExecutionProgress } from "../../src/interfaces/conversationRuntime/conversationWorkerProgressPersistence";

test("persistConversationExecutionProgress stores human progress states and clears terminal job bindings", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "abb-progress-persist-"));
  try {
    const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
    const session = buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-progress-1",
      userId: "user-1",
      username: "owner",
      conversationVisibility: "private",
      receivedAt: "2026-03-15T12:00:00.000Z"
    });
    session.runningJobId = "job-progress-1";
    session.recentJobs = [
      {
        id: "job-progress-1",
        input: "continue the autonomous task",
        executionInput: "[AUTONOMOUS_LOOP_GOAL] continue the autonomous task",
        createdAt: "2026-03-15T12:00:00.000Z",
        startedAt: "2026-03-15T12:00:01.000Z",
        completedAt: null,
        status: "running",
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
      }
    ];
    await store.setSession(session);
    const sessionKey = session.conversationId;

    await persistConversationExecutionProgress(
      sessionKey,
      "job-progress-1",
      {
        status: "starting",
        message: "I'm taking this end to end now."
      },
      store
    );
    let persisted = await store.getSession(sessionKey);
    assert.equal(persisted?.progressState?.status, "starting");
    assert.equal(persisted?.progressState?.message, "I'm taking this end to end now.");
    assert.equal(persisted?.progressState?.jobId, "job-progress-1");

    await persistConversationExecutionProgress(
      sessionKey,
      "job-progress-1",
      {
        status: "retrying",
        message: "I found the exact tracked holders causing the blocker, and I'm retrying with only that narrow shutdown path."
      },
      store
    );
    persisted = await store.getSession(sessionKey);
    assert.equal(persisted?.progressState?.status, "retrying");
    assert.equal(persisted?.progressState?.jobId, "job-progress-1");

    await persistConversationExecutionProgress(
      sessionKey,
      "job-progress-1",
      {
        status: "verifying",
        message: "I'm verifying the remaining proof before I mark this goal complete."
      },
      store
    );
    persisted = await store.getSession(sessionKey);
    assert.equal(persisted?.progressState?.status, "verifying");
    assert.equal(persisted?.progressState?.jobId, "job-progress-1");

    await persistConversationExecutionProgress(
      sessionKey,
      "job-progress-1",
      {
        status: "waiting_for_user",
        message: "I need your confirmation before I stop that specific process."
      },
      store
    );
    persisted = await store.getSession(sessionKey);
    assert.equal(persisted?.progressState?.status, "waiting_for_user");
    assert.equal(persisted?.progressState?.jobId, null);

    await persistConversationExecutionProgress(
      sessionKey,
      "job-progress-1",
      {
        status: "stopped",
        message: "I stopped because I still could not prove a safe exact holder to shut down automatically."
      },
      store
    );
    persisted = await store.getSession(sessionKey);
    assert.equal(persisted?.progressState?.status, "stopped");
    assert.equal(persisted?.progressState?.jobId, null);

    await persistConversationExecutionProgress(
      sessionKey,
      "job-progress-1",
      {
        status: "completed",
        message: "I finished the goal and verified what changed."
      },
      store
    );
    persisted = await store.getSession(sessionKey);
    assert.equal(persisted?.progressState?.status, "completed");
    assert.equal(persisted?.progressState?.jobId, null);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("persistConversationExecutionProgress ignores updates for jobs that are no longer current", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "abb-progress-ignore-"));
  try {
    const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
    const session = buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-progress-2",
      userId: "user-1",
      username: "owner",
      conversationVisibility: "private",
      receivedAt: "2026-03-15T12:05:00.000Z"
    });
    session.progressState = {
      status: "waiting_for_user",
      message: "pick this back up when you're ready, and I'll continue from the saved checkpoint",
      jobId: null,
      updatedAt: "2026-03-15T12:05:05.000Z"
    };
    session.recentJobs = [
      {
        id: "job-progress-2",
        input: "continue the autonomous task",
        executionInput: "[AUTONOMOUS_LOOP_GOAL] continue the autonomous task",
        createdAt: "2026-03-15T12:05:00.000Z",
        startedAt: "2026-03-15T12:05:01.000Z",
        completedAt: "2026-03-15T12:05:04.000Z",
        status: "completed",
        resultSummary: "Paused and waiting for user.",
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
      }
    ];
    await store.setSession(session);
    const sessionKey = session.conversationId;

    await persistConversationExecutionProgress(
      sessionKey,
      "job-progress-2",
      {
        status: "retrying",
        message: "This stale retry update should be ignored."
      },
      store
    );

    const persisted = await store.getSession(sessionKey);
    assert.deepEqual(persisted?.progressState, session.progressState);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
