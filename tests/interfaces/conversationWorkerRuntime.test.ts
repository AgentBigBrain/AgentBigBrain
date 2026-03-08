/**
 * @fileoverview Covers canonical conversation worker-runtime helpers below the stable manager entrypoint.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ConversationNotifierTransport } from "../../src/interfaces/conversationRuntime/managerContracts";
import {
  enqueueConversationSystemJob,
  processConversationQueue,
  type SessionWorkerBinding
} from "../../src/interfaces/conversationRuntime/conversationWorkerRuntime";
import {
  type ConversationJob,
  type ConversationSession,
  InterfaceSessionStore
} from "../../src/interfaces/sessionStore";

/**
 * Builds a minimal persisted conversation session for worker-runtime tests.
 */
function buildSession(
  conversationId: string,
  overrides: Partial<ConversationSession> = {}
): ConversationSession {
  const nowIso = "2026-03-07T15:00:00.000Z";
  return {
    conversationId,
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
    updatedAt: nowIso,
    activeProposal: null,
    runningJobId: null,
    queuedJobs: [],
    recentJobs: [],
    conversationTurns: [],
    agentPulse: {
      optIn: true,
      mode: "private",
      routeStrategy: "last_private_used",
      lastPulseSentAt: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: null,
      lastDecisionCode: "NOT_EVALUATED",
      lastEvaluatedAt: null
    },
    ...overrides
  };
}

/**
 * Builds a queued conversation job for worker-runtime execution tests.
 */
function buildQueuedJob(overrides: Partial<ConversationJob> = {}): ConversationJob {
  return {
    id: "job-1",
    input: "run runtime test",
    executionInput: "run runtime test",
    createdAt: "2026-03-07T15:00:00.000Z",
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
    finalDeliveryLastAttemptAt: null,
    ...overrides
  };
}

test("enqueueConversationSystemJob normalizes input, marks system jobs, and requests worker start", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-worker-runtime-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const conversationKey = "telegram:chat-1:user-1";
  let bindingCount = 0;
  let startCount = 0;

  try {
    await store.setSession(buildSession(conversationKey));

    const enqueued = await enqueueConversationSystemJob({
      conversationKey,
      systemInput: "  Ask one concise check-in question.  ",
      receivedAt: "2026-03-07T15:00:05.000Z",
      executeTask: async (input) => ({ summary: input }),
      notify: async () => undefined,
      store,
      config: {
        maxContextTurnsForExecution: 8
      },
      setWorkerBinding: () => {
        bindingCount += 1;
      },
      startWorkerIfNeeded: async () => {
        startCount += 1;
      }
    });

    const session = await store.getSession(conversationKey);
    assert.equal(enqueued, true);
    assert.equal(bindingCount, 1);
    assert.equal(startCount, 1);
    assert.ok(session);
    assert.equal(session?.queuedJobs.length, 1);
    assert.equal(session?.queuedJobs[0]?.isSystemJob, true);
    assert.equal(session?.queuedJobs[0]?.input, "Ask one concise check-in question.");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("processConversationQueue drains a queued job and persists the final delivery outcome", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-process-runtime-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const conversationKey = "telegram:chat-1:user-1";
  const notifications: string[] = [];
  const ackTimers = new Map<string, NodeJS.Timeout>();
  const workerBindings = new Map<string, SessionWorkerBinding>();
  const notify: ConversationNotifierTransport = {
    capabilities: {
      supportsEdit: false,
      supportsNativeStreaming: false
    },
    send: async (message) => {
      notifications.push(message);
      return {
        ok: true,
        messageId: `message-${notifications.length}`,
        errorCode: null
      };
    }
  };

  try {
    await store.setSession(
      buildSession(conversationKey, {
        queuedJobs: [buildQueuedJob()]
      })
    );

    await processConversationQueue({
      sessionKey: conversationKey,
      executeTask: async () => ({ summary: "completed runtime slice" }),
      notify,
      store,
      config: {
        ackDelayMs: 5_000,
        heartbeatIntervalMs: 10,
        maxRecentJobs: 20,
        maxConversationTurns: 20,
        showCompletionPrefix: false
      },
      ackTimers,
      workerBindings,
      autonomousExecutionPrefix: "[AUTONOMOUS_LOOP_GOAL]"
    });

    const session = await store.getSession(conversationKey);
    assert.ok(session);
    assert.equal(session?.runningJobId, null);
    assert.equal(session?.queuedJobs.length, 0);
    assert.equal(session?.recentJobs[0]?.status, "completed");
    assert.equal(session?.recentJobs[0]?.finalDeliveryOutcome, "sent");
    assert.ok(notifications.some((message) => message.includes("completed runtime slice")));
    assert.equal(ackTimers.size, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
