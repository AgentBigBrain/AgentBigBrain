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
import {
  buildConversationJobFixture,
  buildConversationSessionFixture,
  buildConversationWorkerRuntimeConfig
} from "../helpers/conversationFixtures";

/**
 * Builds a minimal persisted conversation session for worker-runtime tests.
 */
function buildSession(
  conversationId: string,
  overrides: Partial<ConversationSession> = {}
): ConversationSession {
  return buildConversationSessionFixture(
    {
      updatedAt: "2026-03-07T15:00:00.000Z",
      agentPulse: {
        ...buildConversationSessionFixture().agentPulse,
        optIn: true
      },
      ...overrides
    },
    {
      conversationId,
      receivedAt: "2026-03-07T15:00:00.000Z"
    }
  );
}

/**
 * Builds a queued conversation job for worker-runtime execution tests.
 */
function buildQueuedJob(overrides: Partial<ConversationJob> = {}): ConversationJob {
  return buildConversationJobFixture({
    createdAt: "2026-03-07T15:00:00.000Z",
    input: "run runtime test",
    executionInput: "run runtime test",
    ...overrides
  });
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
      config: buildConversationWorkerRuntimeConfig({
        ackDelayMs: 5_000,
        heartbeatIntervalMs: 10,
        maxRecentJobs: 20,
        maxConversationTurns: 20
      }),
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

test("processConversationQueue uses a persistent editable status message and still sends the final reply separately", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-process-status-panel-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const conversationKey = "telegram:chat-1:user-1";
  const deliveries: Array<{ kind: "send" | "edit"; message: string; messageId?: string }> = [];
  const ackTimers = new Map<string, NodeJS.Timeout>();
  const workerBindings = new Map<string, SessionWorkerBinding>();
  const notify: ConversationNotifierTransport = {
    capabilities: {
      supportsEdit: true,
      supportsNativeStreaming: false
    },
    send: async (message) => {
      const messageId = `message-${deliveries.length + 1}`;
      deliveries.push({ kind: "send", message, messageId });
      return {
        ok: true,
        messageId,
        errorCode: null
      };
    },
    edit: async (messageId, message) => {
      deliveries.push({ kind: "edit", messageId, message });
      return {
        ok: true,
        messageId,
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
      executeTask: async (_input, _receivedAt, onProgressUpdate) => {
        await onProgressUpdate?.({
          status: "verifying",
          message: "Checking the generated page before finishing."
        });
        return { summary: "completed runtime slice" };
      },
      notify,
      store,
      config: buildConversationWorkerRuntimeConfig({
        ackDelayMs: 5_000,
        heartbeatIntervalMs: 10,
        maxRecentJobs: 20,
        maxConversationTurns: 20
      }),
      ackTimers,
      workerBindings,
      autonomousExecutionPrefix: "[AUTONOMOUS_LOOP_GOAL]"
    });

    const session = await store.getSession(conversationKey);
    assert.ok(session);
    assert.equal(session?.recentJobs[0]?.status, "completed");
    assert.equal(session?.recentJobs[0]?.finalDeliveryOutcome, "sent");
    assert.equal(ackTimers.size, 0);
    assert.equal(deliveries[0]?.kind, "send");
    assert.match(deliveries[0]?.message ?? "", /Status: Thinking/);
    assert.equal(deliveries[1]?.kind, "edit");
    assert.match(deliveries[1]?.message ?? "", /Status: Verifying/);
    assert.equal(deliveries[2]?.kind, "send");
    assert.equal(deliveries[2]?.message, "completed runtime slice");
    assert.equal(deliveries[3]?.kind, "edit");
    assert.match(deliveries[3]?.message ?? "", /Status: Done/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("processConversationQueue automatically retries exact tracked folder recovery once before asking the user", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-process-recovery-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const conversationKey = "telegram:chat-1:user-1";
  const notifications: string[] = [];
  const executionInputs: string[] = [];
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
  let callCount = 0;

  try {
    await store.setSession(
      buildSession(conversationKey, {
        queuedJobs: [
          buildQueuedJob({
            input: 'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
            executionInput:
              'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.'
          })
        ]
      })
    );

    await processConversationQueue({
      sessionKey: conversationKey,
      executeTask: async (input) => {
        executionInputs.push(input);
        callCount += 1;
        if (callCount === 1) {
          return {
            summary: "I couldn't finish organizing those folders in this run.",
            taskRunResult: {
              task: {
                id: "task-recovery-1",
                agentId: "main-agent",
                goal: 'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
                userInput:
                  'Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.',
                createdAt: "2026-03-13T20:00:00.000Z"
              },
              plan: {
                taskId: "task-recovery-1",
                plannerNotes: "Inspect and repair.",
                actions: [
                  {
                    id: "action-move-1",
                    type: "shell_command",
                    description: "Move matching folders.",
                    params: {
                      command: "Move-Item"
                    },
                    estimatedCostUsd: 0.08
                  },
                  {
                    id: "action-inspect-1",
                    type: "inspect_workspace_resources",
                    description: "Inspect matching workspace resources.",
                    params: {
                      rootPath: "C:\\Users\\test\\Desktop\\drone-company"
                    },
                    estimatedCostUsd: 0.04
                  }
                ]
              },
              actionResults: [
                {
                  action: {
                    id: "action-move-1",
                    type: "shell_command",
                    description: "Move matching folders.",
                    params: {
                      command: "Move-Item"
                    },
                    estimatedCostUsd: 0.08
                  },
                  mode: "escalation_path",
                  approved: false,
                  output:
                    "Move-Item : The process cannot access the file because it is being used by another process.",
                  executionStatus: "failed",
                  executionFailureCode: "ACTION_EXECUTION_FAILED",
                  blockedBy: [],
                  violations: [],
                  votes: []
                },
                {
                  action: {
                    id: "action-inspect-1",
                    type: "inspect_workspace_resources",
                    description: "Inspect matching workspace resources.",
                    params: {
                      rootPath: "C:\\Users\\test\\Desktop\\drone-company"
                    },
                    estimatedCostUsd: 0.04
                  },
                  mode: "escalation_path",
                  approved: true,
                  output: "Inspection results for C:\\Users\\test\\Desktop\\drone-company.",
                  executionStatus: "success",
                  executionMetadata: {
                    runtimeOwnershipInspection: true,
                    inspectionRecommendedNextAction: "stop_exact_tracked_holders",
                    inspectionPreviewProcessLeaseIds: "proc_preview_1,proc_preview_2"
                  },
                  blockedBy: [],
                  violations: [],
                  votes: []
                }
              ],
              summary: "I couldn't finish organizing those folders in this run.",
              startedAt: "2026-03-13T20:00:00.000Z",
              completedAt: "2026-03-13T20:00:02.000Z"
            }
          };
        }
        return {
          summary: "I shut down the tracked preview holders and finished organizing the folders."
        };
      },
      notify,
      store,
      config: {
        ackDelayMs: 5_000,
        heartbeatIntervalMs: 10,
        maxRecentJobs: 20,
        maxRecentActions: 12,
        maxBrowserSessions: 6,
        maxPathDestinations: 8,
        maxConversationTurns: 20,
        showCompletionPrefix: false
      },
      ackTimers,
      workerBindings,
      autonomousExecutionPrefix: "[AUTONOMOUS_LOOP_GOAL]"
    });

    const session = await store.getSession(conversationKey);
    assert.ok(session);
    assert.equal(callCount, 2);
    assert.match(executionInputs[1] ?? "", /\[AUTOMATIC_TRACKED_WORKSPACE_RECOVERY\]/);
    assert.match(executionInputs[1] ?? "", /leaseId="proc_preview_1"/i);
    assert.match(executionInputs[1] ?? "", /leaseId="proc_preview_2"/i);
    assert.equal(session?.activeClarification ?? null, null);
    assert.equal(session?.queuedJobs.length, 0);
    assert.equal(session?.runningJobId, null);
    assert.ok(
      notifications.some((message) =>
        message.includes("I'm shutting down just those tracked holders and retrying now.")
      )
    );
    assert.ok(
      notifications.some((message) =>
        message.includes("I shut down the tracked preview holders and finished organizing the folders.")
      )
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
