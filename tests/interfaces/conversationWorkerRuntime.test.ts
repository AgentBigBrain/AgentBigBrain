/**
 * @fileoverview Covers canonical conversation worker-runtime helpers below the stable manager entrypoint.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createDefaultSourceRecallRetentionPolicy } from "../../src/core/sourceRecall/sourceRecallRetention";
import { SourceRecallStore } from "../../src/core/sourceRecall/sourceRecallStore";
import type { TaskRunResult } from "../../src/core/types";
import type { ConversationNotifierTransport } from "../../src/interfaces/conversationRuntime/managerContracts";
import { buildConversationJobPrincipalSnapshotFromAccess } from "../../src/interfaces/conversationRuntime/conversationJobPrincipalSnapshot";
import {
  enqueueConversationSystemJob,
  processConversationQueue,
  type SessionWorkerBinding
} from "../../src/interfaces/conversationRuntime/conversationWorkerRuntime";
import { buildPulseSystemJobMetadata } from "../../src/interfaces/proactiveRuntime/pulseAuthorityGateway";
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
import { buildTestOwnerTaskPrincipalAccess } from "../helpers/principalAccess";

const TEST_OWNER_PRINCIPAL_ACCESS = buildTestOwnerTaskPrincipalAccess();

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
    principalSnapshot: buildConversationJobPrincipalSnapshotFromAccess(TEST_OWNER_PRINCIPAL_ACCESS),
    ...overrides
  });
}

/**
 * Builds the explicit production-scope policy for assistant/task Source Recall capture tests.
 */
function buildAssistantTaskCapturePolicy() {
  return {
    ...createDefaultSourceRecallRetentionPolicy(),
    enabled: true,
    captureEnabled: true,
    encryptedPayloadsAvailable: true,
    sourceKindCaptureAllowlist: ["assistant_turn", "task_input", "task_summary"] as const,
    captureClassAllowlist: ["assistant_output", "operational_output"] as const
  };
}

/**
 * Builds a task result containing one approved non-respond action for pulse constraint tests.
 */
function buildSideEffectTaskRunResult(): TaskRunResult {
  return {
    task: {
      id: "task-pulse-side-effect",
      agentId: "main-agent",
      goal: "Do side-effect work from a pulse.",
      userInput: "Pulse should respond only.",
      createdAt: "2026-05-09T12:00:00.000Z"
    },
    plan: {
      taskId: "task-pulse-side-effect",
      plannerNotes: "Synthetic side-effect plan.",
      actions: [
        {
          id: "action-pulse-write",
          type: "write_file",
          description: "Write a file.",
          params: {
            path: "synthetic.txt",
            content: "not allowed"
          },
          estimatedCostUsd: 0.01
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action-pulse-write",
          type: "write_file",
          description: "Write a file.",
          params: {
            path: "synthetic.txt",
            content: "not allowed"
          },
          estimatedCostUsd: 0.01
        },
        mode: "fast_path",
        approved: true,
        output: "Wrote synthetic.txt",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    summary: "Wrote synthetic.txt",
    startedAt: "2026-05-09T12:00:00.000Z",
    completedAt: "2026-05-09T12:00:01.000Z"
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
  const workerLastSeenAt = new Map<string, string>();
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
      workerLastSeenAt,
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

test("processConversationQueue captures task input and summary as operational Source Recall evidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-process-source-recall-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const sourceRecallStore = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const conversationKey = "telegram:chat-1:user-1";
  const notifications: string[] = [];
  const ackTimers = new Map<string, NodeJS.Timeout>();
  const workerLastSeenAt = new Map<string, string>();
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
        queuedJobs: [
          buildQueuedJob({
            id: "job-source-recall-task",
            input: "Run the synthetic source recall task.",
            executionInput: "Expanded execution prompt must not be captured."
          })
        ]
      })
    );

    await processConversationQueue({
      sessionKey: conversationKey,
      executeTask: async () => ({
        summary: "Completed the synthetic source recall task."
      }),
      notify,
      store,
      sourceRecallCapture: {
        policy: buildAssistantTaskCapturePolicy(),
        writer: sourceRecallStore,
        capturedAt: "2026-05-03T14:30:00.000Z"
      },
      config: buildConversationWorkerRuntimeConfig({
        ackDelayMs: 5_000,
        heartbeatIntervalMs: 10,
        maxRecentJobs: 20,
        maxConversationTurns: 20
      }),
      ackTimers,
      workerLastSeenAt,
      workerBindings,
      autonomousExecutionPrefix: "[AUTONOMOUS_LOOP_GOAL]"
    });

    const records = await sourceRecallStore.listSourceRecords();
    assert.deepEqual(
      records
        .map((record) => `${record.sourceKind}:${record.sourceRole}:${record.captureClass}`)
        .sort(),
      [
        "assistant_turn:assistant:assistant_output",
        "task_input:runtime:operational_output",
        "task_summary:runtime:operational_output"
      ]
    );
    const chunks = (
      await Promise.all(
        records.map((record) => sourceRecallStore.listChunksForRecord(record.sourceRecordId))
      )
    ).flat();
    assert.equal(
      chunks.some((chunk) => chunk.text.includes("Expanded execution prompt")),
      false
    );
    assert.equal(chunks.some((chunk) => chunk.authority.currentTruthAuthority), false);
    assert.equal(chunks.some((chunk) => chunk.authority.approvalAuthority), false);
    assert.equal(chunks.some((chunk) => chunk.authority.completionProofAuthority), false);
    assert.ok(chunks.some((chunk) => chunk.text === "Run the synthetic source recall task."));
    assert.ok(chunks.some((chunk) => chunk.text === "Completed the synthetic source recall task."));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("processConversationQueue excludes Agent Pulse prompts from Source Recall task input", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-pulse-source-recall-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const sourceRecallStore = new SourceRecallStore({
    sqlitePath: path.join(tempDir, "source_recall.sqlite"),
    testOnlyAllowPlaintextStorage: true
  });
  const conversationKey = "telegram:chat-1:user-1";
  const ackTimers = new Map<string, NodeJS.Timeout>();
  const workerLastSeenAt = new Map<string, string>();
  const workerBindings = new Map<string, SessionWorkerBinding>();
  const notify: ConversationNotifierTransport = {
    capabilities: {
      supportsEdit: false,
      supportsNativeStreaming: false
    },
    send: async () => ({
      ok: true,
      messageId: "message-1",
      errorCode: null
    })
  };

  try {
    await store.setSession(
      buildSession(conversationKey, {
        queuedJobs: [
          buildQueuedJob({
            id: "job-source-recall-pulse",
            input: "System-generated Agent Pulse check-in request.\nAgent Pulse request: ask now.",
            executionInput: "Internal pulse execution prompt must not be captured.",
            isSystemJob: true,
            pulseMetadata: buildPulseSystemJobMetadata({
              pulseId: "pulse_source_recall_test",
              candidateId: "candidate_source_recall_test",
              deliveryDecisionId: "decision_source_recall_test",
              decisionRecordId: "decision_record_source_recall_test",
              promptKind: "stage6_86_dynamic_pulse"
            })
          })
        ]
      })
    );

    await processConversationQueue({
      sessionKey: conversationKey,
      executeTask: async () => ({
        summary: "Pulse response summary."
      }),
      notify,
      store,
      sourceRecallCapture: {
        policy: buildAssistantTaskCapturePolicy(),
        writer: sourceRecallStore,
        capturedAt: "2026-05-03T14:30:00.000Z"
      },
      config: buildConversationWorkerRuntimeConfig({
        ackDelayMs: 5_000,
        heartbeatIntervalMs: 10,
        maxRecentJobs: 20,
        maxConversationTurns: 20
      }),
      ackTimers,
      workerLastSeenAt,
      workerBindings,
      autonomousExecutionPrefix: "[AUTONOMOUS_LOOP_GOAL]"
    });

    const records = await sourceRecallStore.listSourceRecords();
    const sourceKinds = records.map((record) => record.sourceKind).sort();
    assert.deepEqual(sourceKinds, ["assistant_turn", "task_summary"]);
    const chunks = (
      await Promise.all(
        records.map((record) => sourceRecallStore.listChunksForRecord(record.sourceRecordId))
      )
    ).flat();
    assert.equal(
      chunks.some((chunk) => chunk.text.includes("Agent Pulse request: ask now")),
      false
    );
    assert.ok(chunks.some((chunk) => chunk.text === "Pulse response summary."));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("processConversationQueue blocks side-effect results for Agent Pulse jobs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-pulse-respond-only-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const conversationKey = "telegram:chat-1:user-1";
  const notifications: string[] = [];
  const ackTimers = new Map<string, NodeJS.Timeout>();
  const workerLastSeenAt = new Map<string, string>();
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
        queuedJobs: [
          buildQueuedJob({
            id: "job-pulse-respond-only",
            input: "System-generated Agent Pulse check-in request.",
            executionInput: "System-generated Agent Pulse check-in request.",
            isSystemJob: true,
            pulseMetadata: buildPulseSystemJobMetadata({
              pulseId: "pulse_respond_only_test",
              candidateId: "candidate_respond_only_test",
              deliveryDecisionId: "decision_respond_only_test",
              decisionRecordId: "decision_record_respond_only_test",
              promptKind: "stage6_86_dynamic_pulse"
            })
          })
        ]
      })
    );

    await processConversationQueue({
      sessionKey: conversationKey,
      executeTask: async () => ({
        summary: "Wrote synthetic.txt",
        taskRunResult: buildSideEffectTaskRunResult()
      }),
      notify,
      store,
      config: buildConversationWorkerRuntimeConfig({
        ackDelayMs: 5_000,
        heartbeatIntervalMs: 10,
        maxRecentJobs: 20,
        maxConversationTurns: 20
      }),
      ackTimers,
      workerLastSeenAt,
      workerBindings,
      autonomousExecutionPrefix: "[AUTONOMOUS_LOOP_GOAL]"
    });

    const session = await store.getSession(conversationKey);
    assert.ok(session);
    assert.equal(session.recentJobs[0]?.status, "failed");
    assert.match(session.recentJobs[0]?.errorMessage ?? "", /respond-only/i);
    assert.equal(notifications.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("processConversationQueue clears ghost running state when terminal persistence fails once after execution", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-process-runtime-recovery-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const conversationKey = "telegram:chat-1:user-1";
  const notifications: string[] = [];
  const ackTimers = new Map<string, NodeJS.Timeout>();
  const workerLastSeenAt = new Map<string, string>();
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

    const originalSetSession = store.setSession.bind(store);
    let injectedFailureConsumed = false;
    store.setSession = async (session) => {
      const shouldInjectFailure =
        !injectedFailureConsumed &&
        session.conversationId === conversationKey &&
        session.runningJobId === null &&
        session.recentJobs[0]?.status === "completed";
      if (shouldInjectFailure) {
        injectedFailureConsumed = true;
        throw new Error("Injected post-execution persistence failure.");
      }
      await originalSetSession(session);
    };

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
      workerLastSeenAt,
      workerBindings,
      autonomousExecutionPrefix: "[AUTONOMOUS_LOOP_GOAL]"
    });

    const session = await store.getSession(conversationKey);
    assert.equal(injectedFailureConsumed, true);
    assert.ok(session);
    assert.equal(session?.runningJobId, null);
    assert.equal(session?.progressState, null);
    assert.equal(session?.queuedJobs.length, 0);
    assert.equal(session?.recentJobs[0]?.status, "completed");
    assert.equal(session?.recentJobs[0]?.resultSummary, "completed runtime slice");
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
  const workerLastSeenAt = new Map<string, string>();
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
      workerLastSeenAt,
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

test("processConversationQueue keeps the persistent status panel blocked when an autonomous run stops before finishing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-process-status-panel-stopped-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const conversationKey = "telegram:chat-1:user-1";
  const deliveries: Array<{ kind: "send" | "edit"; message: string; messageId?: string }> = [];
  const ackTimers = new Map<string, NodeJS.Timeout>();
  const workerLastSeenAt = new Map<string, string>();
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
        queuedJobs: [buildQueuedJob({ executionInput: "[AUTONOMOUS_LOOP_GOAL] blocked runtime test" })]
      })
    );

    await processConversationQueue({
      sessionKey: conversationKey,
      executeTask: async (_input, _receivedAt, onProgressUpdate) => {
        await onProgressUpdate?.({
          status: "verifying",
          message: "Checking the generated page before finishing."
        });
        return {
          summary:
            "I started this, but the run stopped before it finished after 5 iteration(s). Deterministic recovery stopped for TARGET_NOT_RUNNING: The deterministic restart-and-reverify budget is exhausted for this run. Next step: inspect the failing step and retry with a narrower request if the same error repeats. Approved 18, blocked 7."
        };
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
      workerLastSeenAt,
      workerBindings,
      autonomousExecutionPrefix: "[AUTONOMOUS_LOOP_GOAL]"
    });

    const session = await store.getSession(conversationKey);
    assert.ok(session);
    assert.equal(session?.recentJobs[0]?.status, "completed");
    assert.equal(session?.recentJobs[0]?.finalDeliveryOutcome, "sent");
    assert.equal(deliveries[2]?.kind, "send");
    assert.match(deliveries[2]?.message ?? "", /run stopped before it finished/i);
    assert.equal(deliveries[3]?.kind, "edit");
    assert.match(deliveries[3]?.message ?? "", /Status: Blocked/);
    assert.match(deliveries[3]?.message ?? "", /hit a blocker before it could finish/i);
    assert.doesNotMatch(deliveries[3]?.message ?? "", /Status: Done/);
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
  const workerLastSeenAt = new Map<string, string>();
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
            input: 'Please organize the sample-company project folders you made earlier into a folder called sample-web-projects.',
            executionInput:
              'Please organize the sample-company project folders you made earlier into a folder called sample-web-projects.'
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
                goal: 'Please organize the sample-company project folders you made earlier into a folder called sample-web-projects.',
                userInput:
                  'Please organize the sample-company project folders you made earlier into a folder called sample-web-projects.',
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
                      rootPath: "C:\\Users\\test\\Desktop\\sample-company"
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
                      rootPath: "C:\\Users\\test\\Desktop\\sample-company"
                    },
                    estimatedCostUsd: 0.04
                  },
                  mode: "escalation_path",
                  approved: true,
                  output: "Inspection results for C:\\Users\\test\\Desktop\\sample-company.",
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
      workerLastSeenAt,
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
