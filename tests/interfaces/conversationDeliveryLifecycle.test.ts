/**
 * @fileoverview Tests deterministic ack timer and final-delivery lifecycle helpers extracted from conversationManager.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { canTransitionAckLifecycleState } from "../../src/interfaces/ackStateMachine";
import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import {
  deliverFinalMessage,
  handleAckTimerFire,
} from "../../src/interfaces/conversationDeliveryLifecycle";
import type { ConversationNotifierTransport } from "../../src/interfaces/conversationRuntime/managerContracts";
import {
  type ConversationAckLifecycleState,
  type ConversationJob,
  InterfaceSessionStore
} from "../../src/interfaces/sessionStore";

/**
 * Applies deterministic ack-lifecycle transitions with the same fallback behavior used by conversationManager.
 *
 * @param job - Job being updated.
 * @param nextState - Candidate next ack lifecycle state.
 * @param fallbackErrorCode - Error code persisted when transition is rejected.
 */
function applyAckLifecycleState(
  job: ConversationJob,
  nextState: ConversationAckLifecycleState,
  fallbackErrorCode: string
): void {
  if (job.ackLifecycleState === nextState) {
    return;
  }
  if (!canTransitionAckLifecycleState(job.ackLifecycleState, nextState)) {
    if (canTransitionAckLifecycleState(job.ackLifecycleState, "CANCELLED")) {
      job.ackLifecycleState = "CANCELLED";
    }
    job.ackLastErrorCode = fallbackErrorCode;
    return;
  }
  job.ackLifecycleState = nextState;
}

/**
 * Builds a running conversation-job fixture with deterministic ack/final-delivery defaults.
 *
 * @param nowIso - Timestamp used for seeded timestamps.
 * @returns Running conversation job fixture.
 */
function buildRunningJob(nowIso: string): ConversationJob {
  return {
    id: "job-1",
    input: "hello",
    executionInput: "hello",
    createdAt: nowIso,
    startedAt: nowIso,
    completedAt: null,
    status: "running",
    resultSummary: null,
    errorMessage: null,
    isSystemJob: false,
    ackTimerGeneration: 0,
    ackEligibleAt: new Date(Date.now() - 1000).toISOString(),
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

test("handleAckTimerFire sends delayed ack and persists SENT lifecycle metadata", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-cm-delivery-ack-"));
  const sessionPath = path.join(tempDir, "sessions.json");
  const store = new InterfaceSessionStore(sessionPath);
  const nowIso = "2026-03-03T00:00:00.000Z";
  const sessionKey = "telegram:chat-delivery:user-1";
  const runningJob = buildRunningJob(nowIso);
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-delivery",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = runningJob.id;
  session.recentJobs = [runningJob];
  session.updatedAt = nowIso;
  await store.setSession(session);

  const notify: ConversationNotifierTransport = {
    capabilities: { supportsEdit: true, supportsNativeStreaming: false },
    send: async () => ({ ok: true, messageId: "ack-message-1", errorCode: null }),
    edit: async () => ({ ok: true, messageId: "ack-message-1", errorCode: null })
  };

  try {
    await handleAckTimerFire({
      sessionKey,
      timerRecord: { jobId: runningJob.id, generation: 0 },
      notify,
      store,
      maxRecentJobs: 20,
      canUseAckTimerForSession: () => true,
      setAckLifecycleState: applyAckLifecycleState
    });

    const updated = await store.getSession(sessionKey);
    assert.ok(updated);
    const updatedJob = updated!.recentJobs.find((job) => job.id === runningJob.id);
    assert.ok(updatedJob);
    assert.equal(updatedJob!.ackLifecycleState, "SENT");
    assert.equal(updatedJob!.ackMessageId, "ack-message-1");
    assert.equal(updatedJob!.ackLastErrorCode, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("deliverFinalMessage edits ack message when editable and marks final delivery sent", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-cm-delivery-final-"));
  const sessionPath = path.join(tempDir, "sessions.json");
  const store = new InterfaceSessionStore(sessionPath);
  const nowIso = "2026-03-03T00:00:00.000Z";
  const sessionKey = "telegram:chat-delivery:user-2";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-delivery",
    userId: "user-2",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.recentJobs = [
    {
      ...buildRunningJob(nowIso),
      id: "job-2",
      status: "completed",
      completedAt: nowIso,
      resultSummary: "Done.",
      ackLifecycleState: "SENT",
      ackMessageId: "ack-edit-1",
      ackSentAt: nowIso
    }
  ];
  await store.setSession(session);

  const editMessages: string[] = [];
  const notify: ConversationNotifierTransport = {
    capabilities: { supportsEdit: true, supportsNativeStreaming: false },
    send: async () => ({ ok: true, messageId: "fallback-send", errorCode: null }),
    edit: async (_messageId: string, message: string) => {
      editMessages.push(message);
      return { ok: true, messageId: "ack-edit-1", errorCode: null };
    }
  };

  try {
    await deliverFinalMessage({
      sessionKey,
      jobId: "job-2",
      finalMessage: "Final response text",
      notify,
      store,
      maxRecentJobs: 20,
      canUseAckTimerForSession: () => true,
      setAckLifecycleState: applyAckLifecycleState
    });

    const updated = await store.getSession(sessionKey);
    assert.ok(updated);
    const updatedJob = updated!.recentJobs.find((job) => job.id === "job-2");
    assert.ok(updatedJob);
    assert.equal(editMessages.length > 1, true);
    assert.equal(editMessages[editMessages.length - 1], "Final response text");
    assert.equal(updatedJob!.ackLifecycleState, "REPLACED");
    assert.equal(updatedJob!.finalDeliveryOutcome, "sent");
    assert.equal(updatedJob!.finalDeliveryAttemptCount, 1);
    assert.equal(updatedJob!.finalDeliveryLastErrorCode, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("deliverFinalMessage retries editable preview rate-limit updates and avoids fallback send when full text is delivered", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-cm-delivery-preview-retry-"));
  const sessionPath = path.join(tempDir, "sessions.json");
  const store = new InterfaceSessionStore(sessionPath);
  const nowIso = "2026-03-03T00:00:00.000Z";
  const sessionKey = "telegram:chat-delivery:user-2b";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-delivery",
    userId: "user-2b",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.recentJobs = [
    {
      ...buildRunningJob(nowIso),
      id: "job-2b",
      status: "completed",
      completedAt: nowIso,
      resultSummary: "Done.",
      ackLifecycleState: "SENT",
      ackMessageId: "ack-edit-2",
      ackSentAt: nowIso
    }
  ];
  await store.setSession(session);

  const editMessages: string[] = [];
  const sendMessages: string[] = [];
  let shouldRateLimitFirstAttempt = true;
  const notify: ConversationNotifierTransport = {
    capabilities: { supportsEdit: true, supportsNativeStreaming: false },
    send: async (message: string) => {
      sendMessages.push(message);
      return { ok: true, messageId: "fallback-send", errorCode: null };
    },
    edit: async (_messageId: string, message: string) => {
      editMessages.push(message);
      if (shouldRateLimitFirstAttempt) {
        shouldRateLimitFirstAttempt = false;
        return { ok: false, messageId: null, errorCode: "TELEGRAM_RATE_LIMITED" };
      }
      return { ok: true, messageId: "ack-edit-2", errorCode: null };
    }
  };

  try {
    await deliverFinalMessage({
      sessionKey,
      jobId: "job-2b",
      finalMessage: "One two",
      notify,
      store,
      maxRecentJobs: 20,
      canUseAckTimerForSession: () => true,
      setAckLifecycleState: applyAckLifecycleState
    });

    const updated = await store.getSession(sessionKey);
    assert.ok(updated);
    const updatedJob = updated!.recentJobs.find((job) => job.id === "job-2b");
    assert.ok(updatedJob);
    assert.equal(editMessages.length >= 3, true);
    assert.equal(editMessages[editMessages.length - 1], "One two");
    assert.deepEqual(sendMessages, []);
    assert.equal(updatedJob!.ackLifecycleState, "REPLACED");
    assert.equal(updatedJob!.finalDeliveryOutcome, "sent");
    assert.equal(updatedJob!.finalDeliveryAttemptCount, 1);
    assert.equal(updatedJob!.finalDeliveryLastErrorCode, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("deliverFinalMessage streams native draft preview before persistent final send", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-cm-delivery-native-stream-"));
  const sessionPath = path.join(tempDir, "sessions.json");
  const store = new InterfaceSessionStore(sessionPath);
  const nowIso = "2026-03-03T00:00:00.000Z";
  const sessionKey = "telegram:chat-delivery:user-3";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-delivery",
    userId: "user-3",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.recentJobs = [
    {
      ...buildRunningJob(nowIso),
      id: "job-3",
      status: "completed",
      completedAt: nowIso,
      resultSummary: "Done."
    }
  ];
  await store.setSession(session);

  const streamMessages: string[] = [];
  const sendMessages: string[] = [];
  const notify: ConversationNotifierTransport = {
    capabilities: { supportsEdit: false, supportsNativeStreaming: true },
    send: async (message: string) => {
      sendMessages.push(message);
      return { ok: true, messageId: "final-send-1", errorCode: null };
    },
    stream: async (message: string) => {
      streamMessages.push(message);
      return { ok: true, messageId: null, errorCode: null };
    }
  };

  try {
    await deliverFinalMessage({
      sessionKey,
      jobId: "job-3",
      finalMessage: "This final message should appear incrementally before final persistence.",
      notify,
      store,
      maxRecentJobs: 20,
      canUseAckTimerForSession: () => false,
      setAckLifecycleState: applyAckLifecycleState
    });

    const updated = await store.getSession(sessionKey);
    assert.ok(updated);
    const updatedJob = updated!.recentJobs.find((job) => job.id === "job-3");
    assert.ok(updatedJob);

    assert.equal(streamMessages.length > 1, true);
    assert.equal(streamMessages[0].length <= 2, true);
    assert.equal(
      streamMessages.every((message, index, collection) =>
        index === 0 || message.length > collection[index - 1].length
      ),
      true
    );
    assert.notEqual(
      streamMessages[streamMessages.length - 1],
      "This final message should appear incrementally before final persistence."
    );
    assert.deepEqual(sendMessages, [
      "This final message should appear incrementally before final persistence."
    ]);
    assert.equal(updatedJob!.ackLifecycleState, "FINAL_SENT_NO_EDIT");
    assert.equal(updatedJob!.finalDeliveryOutcome, "sent");
    assert.equal(updatedJob!.finalDeliveryAttemptCount, 1);
    assert.equal(updatedJob!.finalDeliveryLastErrorCode, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
