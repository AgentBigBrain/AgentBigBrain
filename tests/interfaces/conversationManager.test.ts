/**
 * @fileoverview Tests conversational proposal workflow and in-task continuity via queue/status/heartbeat behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ConversationInboundMessage,
  ConversationManager,
  type ConversationNotifierTransport
} from "../../src/interfaces/conversationManager";
import { InterfaceSessionStore } from "../../src/interfaces/sessionStore";

/**
 * Implements `buildMessage` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildMessage(text: string): ConversationInboundMessage {
  return {
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
    text,
    receivedAt: new Date().toISOString()
  };
}

/**
 * Implements `buildMessageAt` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildMessageAt(text: string, receivedAt: string): ConversationInboundMessage {
  return {
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
    text,
    receivedAt
  };
}

/**
 * Implements `sleep` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Implements `removeTempDirWithRetry` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function removeTempDirWithRetry(tempDir: string): Promise<void> {
  // Queue workers can still flush a final session write after reply text is returned.
  // Delay cleanup briefly so atomic temp-file writes settle before directory removal.
  await sleep(400);

  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      await rm(tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!["ENOTEMPTY", "EPERM", "EBUSY", "ENOENT"].includes(code)) {
        throw error;
      }
      await sleep(attempt * 50);
    }
  }

  await rm(tempDir, { recursive: true, force: true });
}

/**
 * Implements `waitFor` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for expected condition.");
    }
    await sleep(10);
  }
}

/**
 * Implements `waitForAsync` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Timed out waiting for expected async condition.");
    }
    await sleep(10);
  }
}

test("conversation manager supports propose -> ask -> adjust -> approve flow", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {
    maxProposalInputChars: 5_000,
    heartbeatIntervalMs: 25,
    maxRecentJobs: 20,
    staleRunningJobRecoveryMs: 60_000,
    maxConversationTurns: 40,
    maxContextTurnsForExecution: 10
  });
  const executedInputs: string[] = [];
  const notifications: string[] = [];

  try {
    const proposeReply = await manager.handleMessage(
      buildMessage("/propose watch my email every hour and summarize urgent items"),
      async (input) => {
        executedInputs.push(input);
        return { summary: `executed: ${input}` };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.ok(proposeReply.includes("Draft"));

    const questionReply = await manager.handleMessage(
      buildMessage("What permissions will this need?"),
      async (input) => {
        executedInputs.push(input);
        return { summary: "It would require mailbox read access." };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.ok(questionReply.includes("mailbox read access"));
    assert.ok(questionReply.includes("pending"));

    const adjustReply = await manager.handleMessage(
      buildMessage("adjust also label invoices in a separate folder"),
      async (input) => {
        executedInputs.push(input);
        return { summary: `executed: ${input}` };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.ok(adjustReply.includes("updated"));

    const approveReply = await manager.handleMessage(
      buildMessage("approve"),
      async (input) => {
        executedInputs.push(input);
        return { summary: "approved execution summary" };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.ok(approveReply.includes("Draft"));
    assert.ok(approveReply.includes("Execution started. Use /status for live state."));

    await waitFor(
      () => notifications.some((message) => message.includes("approved execution summary")),
      2_000
    );

    const finalSession = await store.getSession("telegram:chat-1:user-1");
    assert.ok(finalSession);
    assert.equal(finalSession?.activeProposal, null);
    const lastExecutionInput = executedInputs[executedInputs.length - 1];
    assert.ok(lastExecutionInput.includes("Adjustment requested by user"));
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager applies proposal-reply classifier intents for adjust and approve aliases", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-proposal-classifier-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {
    maxProposalInputChars: 5_000,
    heartbeatIntervalMs: 10,
    maxRecentJobs: 20,
    staleRunningJobRecoveryMs: 60_000,
    maxConversationTurns: 40,
    maxContextTurnsForExecution: 10
  });
  const notifications: string[] = [];

  try {
    await manager.handleMessage(
      buildMessage("/propose schedule focused work blocks"),
      async (input) => ({ summary: input }),
      async () => { }
    );

    const adjustReply = await manager.handleMessage(
      buildMessage("change this to weekdays only"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(adjustReply.includes("Draft"));
    assert.ok(adjustReply.includes("updated"));

    const approveReply = await manager.handleMessage(
      buildMessage("go ahead"),
      async () => ({ summary: "approved by classifier intent" }),
      async (message) => {
        notifications.push(message);
      }
    );
    assert.ok(approveReply.includes("approved"));
    assert.ok(approveReply.includes("Execution started. Use /status for live state."));

    await waitFor(
      () => notifications.some((message) => message.includes("approved by classifier intent")),
      4_000
    );

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    const classifierEvents = session?.classifierEvents ?? [];
    assert.ok(
      classifierEvents.some((event) => event.matchedRuleId === "proposal_reply_v1_adjust_lead_token")
    );
    assert.ok(
      classifierEvents.some((event) => event.matchedRuleId === "proposal_reply_v1_short_approve")
    );
    assert.ok(
      classifierEvents.every((event) => event.rulepackVersion === "FollowUpRulepackV1")
    );
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager keeps session responsive with job queue status and heartbeat while work is active", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-queue-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {
    maxProposalInputChars: 5_000,
    heartbeatIntervalMs: 10,
    maxRecentJobs: 20,
    staleRunningJobRecoveryMs: 60_000,
    maxConversationTurns: 40,
    maxContextTurnsForExecution: 10
  });
  const notifications: string[] = [];

  try {
    const firstReply = await manager.handleMessage(
      buildMessage("run long task one"),
      async (input) => {
        await sleep(75);
        return { summary: `completed ${input}` };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.equal(firstReply.trim(), "");

    const secondReply = await manager.handleMessage(
      buildMessage("run follow-up task two"),
      async (input) => {
        await sleep(75);
        return { summary: `completed ${input}` };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.ok(secondReply.includes("Queued your request."));

    const statusDuringRun = await manager.handleMessage(
      buildMessage("/status"),
      async (input) => ({ summary: input }),
      async (message) => {
        notifications.push(message);
      }
    );
    assert.match(
      statusDuringRun,
      /Current status: (I'm working on a request right now\.|\d+ request(?:s)? (?:is|are) waiting to start\.)/
    );
    assert.match(
      statusDuringRun,
      /Queue: ((\d+ request|\d+ requests) waiting after the current run|(\d+ request|\d+ requests) waiting to start|no other requests waiting)\./
    );
    assert.ok(statusDuringRun.includes("Need delivery or lifecycle details? Use /status debug."));

    const debugStatusDuringRun = await manager.handleMessage(
      buildMessage("/status debug"),
      async (input) => ({ summary: input }),
      async (message) => {
        notifications.push(message);
      }
    );
    assert.ok(debugStatusDuringRun.includes("Debug status:"));
    assert.ok(debugStatusDuringRun.includes("Running job:"));
    assert.match(debugStatusDuringRun, /Queued jobs:\s*\d+/);

    await waitForAsync(async () => {
      const session = await store.getSession("telegram:chat-1:user-1");
      if (!session) {
        return false;
      }
      return session.runningJobId === null && session.queuedJobs.length === 0;
    }, 120_000);

    const statusAfterRun = await manager.handleMessage(
      buildMessage("/status"),
      async (input) => ({ summary: input }),
      async (message) => {
        notifications.push(message);
      }
    );

    assert.ok(statusAfterRun.includes("Current status: Nothing is running right now."));
    assert.ok(statusAfterRun.includes("Queue: empty."));
    assert.ok(
      notifications.some((message) => message.startsWith("Working on your request:"))
    );
    assert.ok(notifications.some((message) => message.toLowerCase().includes("completed")));
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager suppresses generic heartbeats for editable telegram transports", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-no-heartbeat-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {
    heartbeatIntervalMs: 10,
    ackDelayMs: 1,
    maxRecentJobs: 20,
    staleRunningJobRecoveryMs: 60_000,
    maxConversationTurns: 40,
    maxContextTurnsForExecution: 10
  });
  const notifications: string[] = [];
  let nextMessageId = 1;
  const notifier: ConversationNotifierTransport = {
    capabilities: { supportsEdit: true, supportsNativeStreaming: false },
    send: async (message: string) => {
      notifications.push(`send:${message}`);
      const messageId = String(nextMessageId);
      nextMessageId += 1;
      return { ok: true, messageId, errorCode: null };
    },
    edit: async (_messageId: string, message: string) => {
      notifications.push(`edit:${message}`);
      return { ok: true, messageId: "1", errorCode: null };
    }
  };

  try {
    const reply = await manager.handleMessage(
      buildMessage("run a long editable task"),
      async (input) => {
        await sleep(60);
        return { summary: `completed ${input}` };
      },
      notifier
    );
    assert.equal(reply.trim(), "");

    await waitForAsync(async () => {
      const session = await store.getSession("telegram:chat-1:user-1");
      if (!session) {
        return false;
      }
      const targetJob = session.recentJobs.find((job) => job.input === "run a long editable task");
      return (
        session.runningJobId === null &&
        session.queuedJobs.length === 0 &&
        targetJob !== undefined &&
        targetJob.finalDeliveryOutcome !== "not_attempted"
      );
    }, 120_000);

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    const targetJob = session?.recentJobs.find((job) => job.input === "run a long editable task");
    assert.ok(targetJob);
    assert.equal(targetJob?.status, "completed");
    assert.equal(targetJob?.finalDeliveryOutcome, "sent");

    assert.equal(
      notifications.some((message) => message.includes("Working on your request:")),
      false
    );
    assert.equal(notifications.length > 0, true);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager can include completion prefix when enabled for debugging", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-prefix-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {
    showCompletionPrefix: true
  });
  const notifications: string[] = [];

  try {
    await manager.handleMessage(
      buildMessage("/chat send a short acknowledgement"),
      async () => ({ summary: "Acknowledged." }),
      async (message) => {
        notifications.push(message);
      }
    );

    await waitFor(
      () => notifications.some((message) => message.startsWith("Done.\nAcknowledged.")),
      4_000
    );
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager cancels active proposal", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-cancel-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store);

  try {
    await manager.handleMessage(
      buildMessage("/propose organize docs folder"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    const reply = await manager.handleMessage(
      buildMessage("/cancel"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(reply.includes("cancelled"));

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    assert.equal(session?.activeProposal, null);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager recovers stale running job and resumes queued work", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-stale-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {
    maxProposalInputChars: 5_000,
    heartbeatIntervalMs: 10,
    maxRecentJobs: 20,
    staleRunningJobRecoveryMs: 2_000,
    maxConversationTurns: 40,
    maxContextTurnsForExecution: 10
  });
  const notifications: string[] = [];
  const now = Date.now();
  const staleStartedAt = new Date(now - 120_000).toISOString();
  const receivedAt = new Date(now).toISOString();

  try {
    await store.setSession({
      conversationId: "telegram:chat-1:user-1",
      userId: "user-1",
      username: "agentowner",
      conversationVisibility: "private",
      updatedAt: staleStartedAt,
      activeProposal: null,
      runningJobId: "job_stale_123",
      queuedJobs: [
        {
          id: "job_queued_1",
          input: "recover me",
          createdAt: staleStartedAt,
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
        }
      ],
      recentJobs: [],
      conversationTurns: [],
      agentPulse: {
        optIn: false,
        mode: "private",
        routeStrategy: "last_private_used",
        lastPulseSentAt: null,
        lastPulseReason: null,
        lastPulseTargetConversationId: null,
        lastDecisionCode: "NOT_EVALUATED",
        lastEvaluatedAt: null
      }
    });

    const statusReply = await manager.handleMessage(
      buildMessageAt("/status", receivedAt),
      async (input) => ({ summary: `completed ${input}` }),
      async (message) => {
        notifications.push(message);
      }
    );
    assert.ok(statusReply.includes("Current status: 1 request is waiting to start."));
    assert.ok(statusReply.includes("Queue: 1 request waiting to start."));

    await waitFor(
      () => notifications.some((message) => message.includes("completed recover me")),
      4_000
    );

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    assert.equal(session?.runningJobId, null);
    assert.equal(session?.queuedJobs.length, 0);
    assert.ok(session?.recentJobs.some((job) => job.id === "job_stale_123" && job.status === "failed"));
    assert.ok(session?.recentJobs.some((job) => job.id === "job_queued_1" && job.status === "completed"));
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager keeps detailed lifecycle state behind /status debug and rejects unknown status modes", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-status-debug-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store);

  try {
    const usageReply = await manager.handleMessage(
      buildMessage("/status verbose"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.equal(usageReply, "Usage: /status [debug]");
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager uses prior turns for follow-up conversational requests", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-context-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {
    maxProposalInputChars: 5_000,
    heartbeatIntervalMs: 10,
    maxRecentJobs: 20,
    staleRunningJobRecoveryMs: 60_000,
    maxConversationTurns: 20,
    maxContextTurnsForExecution: 8
  });
  const executedInputs: string[] = [];
  const notifications: string[] = [];

  try {
    await manager.handleMessage(
      buildMessage("/chat give me a flare puzzle"),
      async (input) => {
        executedInputs.push(input);
        return { summary: "Puzzle 1: I glow in code reviews. What am I?" };
      },
      async (message) => {
        notifications.push(message);
      }
    );

    await waitFor(
      () =>
        notifications.some((message) =>
          message.includes("Puzzle 1: I glow in code reviews. What am I?")
        ),
      4_000
    );

    await manager.handleMessage(
      buildMessage("/chat make another"),
      async (input) => {
        executedInputs.push(input);
        return { summary: "Puzzle 2: I patch bugs before sunrise. What am I?" };
      },
      async (message) => {
        notifications.push(message);
      }
    );

    await waitFor(
      () =>
        notifications.some((message) =>
          message.includes("Puzzle 2: I patch bugs before sunrise. What am I?")
        ),
      4_000
    );

    assert.equal(executedInputs.length, 2);
    assert.equal(executedInputs[0], "give me a flare puzzle");
    assert.ok(executedInputs[1].includes("Recent conversation context (oldest to newest):"));
    assert.ok(executedInputs[1].includes("- user: give me a flare puzzle"));
    assert.ok(executedInputs[1].includes("- assistant: Puzzle 1: I glow in code reviews. What am I?"));
    assert.ok(executedInputs[1].includes("Current user request:"));
    assert.ok(executedInputs[1].includes("make another"));

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    assert.equal(session?.conversationTurns.length, 4);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager resolves short follow-up answers against the prior assistant question", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-followup-answer-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {
    maxProposalInputChars: 5_000,
    heartbeatIntervalMs: 10,
    maxRecentJobs: 20,
    staleRunningJobRecoveryMs: 60_000,
    maxConversationTurns: 20,
    maxContextTurnsForExecution: 8
  });
  const notifications: string[] = [];
  const executedInputs: string[] = [];

  try {
    const firstReply = await manager.handleMessage(
      buildMessage("/chat Schedule 3 focus blocks and show exact approval diff before any write."),
      async (input) => {
        executedInputs.push(input);
        return { summary: "How would you like the exact approval diff rendered?" };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.equal(firstReply.trim(), "");

    await waitFor(
      () =>
        notifications.some((message) =>
          message.includes("How would you like the exact approval diff rendered?")
        ),
      4_000
    );

    const secondReply = await manager.handleMessage(
      buildMessage("plain text"),
      async (input) => {
        executedInputs.push(input);
        return { summary: "Acknowledged. I will render the approval diff in plain text." };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.equal(secondReply.trim(), "");

    await waitFor(
      () =>
        notifications.some((message) =>
          message.includes("render the approval diff in plain text")
        ),
      4_000
    );

    assert.equal(executedInputs.length, 2);
    assert.ok(
      executedInputs[1].includes("Follow-up user response to prior assistant clarification.")
    );
    assert.ok(
      executedInputs[1].includes(
        "Previous assistant question: How would you like the exact approval diff rendered?"
      )
    );
    assert.ok(executedInputs[1].includes("User follow-up answer: plain text"));

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    const classifierEvents = session?.classifierEvents ?? [];
    assert.ok(
      classifierEvents.some(
        (event) =>
          event.classifier === "follow_up" &&
          event.matchedRuleId === "follow_up_v1_contextual_short_reply" &&
          event.rulepackVersion === "FollowUpRulepackV1"
      )
    );
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager resolves short follow-up answers against latest assistant clarification prompts without question marks", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-followup-clarification-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {
    maxProposalInputChars: 5_000,
    heartbeatIntervalMs: 10,
    maxRecentJobs: 20,
    staleRunningJobRecoveryMs: 60_000,
    maxConversationTurns: 20,
    maxContextTurnsForExecution: 8
  });
  const notifications: string[] = [];
  const executedInputs: string[] = [];

  try {
    await manager.handleMessage(
      buildMessage("/chat Which school did we attend?"),
      async (input) => {
        executedInputs.push(input);
        return { summary: "Could you please specify which school you are asking about?" };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    await waitFor(
      () =>
        notifications.some((message) =>
          message.includes("specify which school")
        ),
      4_000
    );

    await manager.handleMessage(
      buildMessage("/chat Capture this browser workflow and block if selector drift appears."),
      async (input) => {
        executedInputs.push(input);
        return {
          summary:
            "Please confirm if you would like to proceed with this approach."
        };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    await waitFor(
      () =>
        notifications.some((message) =>
          message.includes("Please confirm if you would like to proceed with this approach.")
        ),
      4_000
    );

    await manager.handleMessage(
      buildMessage("I confirm."),
      async (input) => {
        executedInputs.push(input);
        return { summary: "Acknowledged. Proceeding with the capture workflow." };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    await waitFor(
      () =>
        notifications.some((message) =>
          message.includes("Proceeding with the capture workflow.")
        ),
      4_000
    );

    assert.equal(executedInputs.length, 3);
    assert.ok(
      executedInputs[2].includes(
        "Previous assistant question: Please confirm if you would like to proceed with this approach."
      )
    );
    assert.equal(
      executedInputs[2].includes(
        "Previous assistant question: Could you please specify which school you are asking about?"
      ),
      false
    );
    assert.ok(executedInputs[2].includes("User follow-up answer: I confirm."));
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager adds deterministic turn-local status-update guidance for first-person status facts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-status-update-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {
    maxProposalInputChars: 5_000,
    heartbeatIntervalMs: 10,
    maxRecentJobs: 20,
    staleRunningJobRecoveryMs: 60_000,
    maxConversationTurns: 20,
    maxContextTurnsForExecution: 8
  });
  const notifications: string[] = [];
  const executedInputs: string[] = [];

  try {
    const firstReply = await manager.handleMessage(
      buildMessage("/chat my followup.tax filing is pending."),
      async (input) => {
        executedInputs.push(input);
        return { summary: "Noted. Tax filing remains pending." };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.equal(firstReply.trim(), "");

    await waitFor(
      () =>
        notifications.some((message) =>
          message.includes("Tax filing remains pending")
        ),
      4_000
    );

    assert.equal(executedInputs.length, 1);
    assert.ok(executedInputs[0].includes("Turn-local status update (authoritative for this turn):"));
    assert.ok(executedInputs[0].includes("User stated: my followup.tax filing is pending."));
    assert.ok(executedInputs[0].includes("do not assert an older contradictory status as fact"));
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager backfills turn context from recent jobs when turns are empty", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-backfill-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {
    maxProposalInputChars: 5_000,
    heartbeatIntervalMs: 10,
    maxRecentJobs: 20,
    staleRunningJobRecoveryMs: 60_000,
    maxConversationTurns: 20,
    maxContextTurnsForExecution: 8
  });
  const notifications: string[] = [];
  const executedInputs: string[] = [];
  const createdAt = new Date("2026-02-22T22:30:51.084Z").toISOString();
  const completedAt = new Date("2026-02-22T22:30:56.187Z").toISOString();

  try {
    await store.setSession({
      conversationId: "telegram:chat-1:user-1",
      userId: "user-1",
      username: "agentowner",
      conversationVisibility: "private",
      updatedAt: completedAt,
      activeProposal: null,
      runningJobId: null,
      queuedJobs: [],
      recentJobs: [
        {
          id: "job_seed",
          input: "say hello",
          createdAt,
          startedAt: createdAt,
          completedAt,
          status: "completed",
          resultSummary: "Hello! How can I assist you today?",
          errorMessage: null,
          ackTimerGeneration: 0,
          ackEligibleAt: null,
          ackLifecycleState: "FINAL_SENT_NO_EDIT",
          ackMessageId: null,
          ackSentAt: null,
          ackEditAttemptCount: 0,
          ackLastErrorCode: null,
          finalDeliveryOutcome: "sent",
          finalDeliveryAttemptCount: 1,
          finalDeliveryLastErrorCode: null,
          finalDeliveryLastAttemptAt: completedAt
        }
      ],
      conversationTurns: [],
      agentPulse: {
        optIn: false,
        mode: "private",
        routeStrategy: "last_private_used",
        lastPulseSentAt: null,
        lastPulseReason: null,
        lastPulseTargetConversationId: null,
        lastDecisionCode: "NOT_EVALUATED",
        lastEvaluatedAt: null
      }
    });

    await manager.handleMessage(
      buildMessage("/chat what did you just ask me"),
      async (input) => {
        executedInputs.push(input);
        return { summary: "I asked: How can I assist you today?" };
      },
      async (message) => {
        notifications.push(message);
      }
    );

    await waitFor(
      () => notifications.some((message) => message.includes("I asked: How can I assist you today?")),
      4_000
    );

    assert.equal(executedInputs.length, 1);
    assert.ok(executedInputs[0].includes("- user: say hello"));
    assert.ok(executedInputs[0].includes("- assistant: Hello! How can I assist you today?"));
    assert.ok(executedInputs[0].includes("Current user request:"));
    assert.ok(executedInputs[0].includes("what did you just ask me"));
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager supports pulse opt-in command flow", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-pulse-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store);

  try {
    const initialStatus = await manager.handleMessage(
      buildMessage("/pulse status"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(initialStatus.includes("Agent Pulse: off"));

    const enableReply = await manager.handleMessage(
      buildMessage("/pulse on"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(enableReply.includes("Agent Pulse is now ON"));
    assert.ok(enableReply.includes("Mode: private"));
    assert.ok(enableReply.includes("Last decision: NOT_EVALUATED"));
    assert.ok(enableReply.includes("Last target conversation: none"));

    const publicReply = await manager.handleMessage(
      buildMessage("/pulse public"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(publicReply.includes("Agent Pulse is now PUBLIC"));
    assert.ok(publicReply.includes("Mode: public"));
    assert.ok(publicReply.includes("Last decision: NOT_EVALUATED"));
    assert.ok(publicReply.includes("Last reason: none"));

    const privateReply = await manager.handleMessage(
      buildMessage("/pulse private"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(privateReply.includes("Agent Pulse is now PRIVATE"));
    assert.ok(privateReply.includes("Mode: private"));

    const disableReply = await manager.handleMessage(
      buildMessage("/pulse off"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(disableReply.includes("Agent Pulse is now OFF"));
    assert.ok(disableReply.includes("Last decision: NOT_EVALUATED"));
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager supports live checkpoint review command via injected runner", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-review-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(
    store,
    {},
    {
      runCheckpointReview: async (checkpointId) => {
        if (checkpointId === "6.11") {
          return {
            checkpointId: "6.11",
            overallPass: true,
            artifactPath: "runtime/evidence/stage6_5_6_11_live_check_output.json",
            summaryLines: [
              "Spawn within limits: allowed (atlas-1001, milkyway-1002)",
              "Limit blocks: limit=CLONE_LIMIT_REACHED depth=CLONE_DEPTH_EXCEEDED budget=CLONE_BUDGET_EXCEEDED"
            ]
          };
        }
        if (checkpointId === "6.13") {
          return {
            checkpointId: "6.13",
            overallPass: true,
            artifactPath: "runtime/evidence/stage6_5_6_13_live_check_output.json",
            summaryLines: [
              "Confidence trace: tax=0.78 -> 0.80 -> 0.25 new=0.67",
              "Supersession: ids=workflow_pattern_old_tax at=2026-02-27T00:00:00.000Z status=superseded"
            ]
          };
        }
        if (checkpointId === "6.85.a") {
          return {
            checkpointId: "6.85.A",
            overallPass: true,
            artifactPath: "runtime/evidence/stage6_85_playbooks_report.json",
            summaryLines: [
              "Selected playbook: playbook_build",
              "Selection score: 0.9812 fallbackScenario=fallback"
            ]
          };
        }
        return null;
      }
    }
  );

  try {
    const reviewReply = await manager.handleMessage(
      buildMessage("/review 6.11"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(reviewReply.includes("Checkpoint 6.11 live review: PASS"));
    assert.ok(reviewReply.includes("atlas-1001"));
    assert.ok(reviewReply.includes("Artifact: runtime/evidence/stage6_5_6_11_live_check_output.json"));

    const workflowReviewReply = await manager.handleMessage(
      buildMessage("/review 6.13"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(workflowReviewReply.includes("Checkpoint 6.13 live review: PASS"));
    assert.ok(workflowReviewReply.includes("Confidence trace"));
    assert.ok(
      workflowReviewReply.includes("Artifact: runtime/evidence/stage6_5_6_13_live_check_output.json")
    );

    const stage685ReviewReply = await manager.handleMessage(
      buildMessage("/review 6.85.A"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(stage685ReviewReply.includes("Checkpoint 6.85.A live review: PASS"));
    assert.ok(stage685ReviewReply.includes("Selected playbook"));
    assert.ok(stage685ReviewReply.includes("Artifact: runtime/evidence/stage6_85_playbooks_report.json"));

    const unsupportedReply = await manager.handleMessage(
      buildMessage("/review 6.12"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(unsupportedReply.includes("Unsupported checkpoint '6.12'"));
    assert.ok(unsupportedReply.includes("Currently supported: 6.11, 6.13"));
    assert.ok(unsupportedReply.includes("6.85.A"));
    assert.equal(unsupportedReply.includes("6.17"), false);

    const helpReply = await manager.handleMessage(
      buildMessage("/help"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(helpReply.includes("/review <checkpoint-id>"));
    assert.ok(helpReply.includes("supports 6.11, 6.13, 6.75, 6.85.A-6.85.H"));
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager returns updated review command usage when checkpoint id is omitted", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-review-usage-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(
    store,
    {},
    {
      runCheckpointReview: async () => ({
        checkpointId: "6.11",
        overallPass: true,
        artifactPath: "runtime/evidence/stage6_5_6_11_live_check_output.json",
        summaryLines: []
      })
    }
  );

  try {
    const usageReply = await manager.handleMessage(
      buildMessage("/review"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(
      usageReply.includes(
        "Usage: /review <checkpoint-id>. Example: /review 6.11, /review 6.75, or /review 6.85.A"
      )
    );
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager redacts pulse target conversation id in status output", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-pulse-redact-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store);
  const rawTarget = "discord:803848302859649046:492154595246735361";

  try {
    await manager.handleMessage(
      buildMessage("/pulse on"),
      async (input) => ({ summary: input }),
      async () => { }
    );

    await manager.updateAgentPulseState("telegram:chat-1:user-1", {
      lastDecisionCode: "RATE_LIMIT",
      lastEvaluatedAt: new Date().toISOString(),
      lastPulseReason: "unresolved_commitment",
      lastPulseTargetConversationId: rawTarget
    });

    const status = await manager.handleMessage(
      buildMessage("/pulse status"),
      async (input) => ({ summary: input }),
      async () => { }
    );

    assert.ok(status.includes("Last target conversation: discord:redacted"));
    assert.equal(status.includes(rawTarget), false);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager supports natural-language pulse mode commands", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-pulse-natural-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store);

  try {
    const privateReply = await manager.handleMessage(
      buildMessage("turn on private"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(privateReply.includes("Agent Pulse is now PRIVATE"));

    const publicReply = await manager.handleMessage(
      buildMessage("turn on public"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(publicReply.includes("Agent Pulse is now PUBLIC"));

    const offReply = await manager.handleMessage(
      buildMessage("turn off pulse"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(offReply.includes("Agent Pulse is now OFF"));

    const naturalOffReply = await manager.handleMessage(
      buildMessage("turn off notifications for the vet"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(naturalOffReply.includes("Agent Pulse is now OFF"));

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    const pulseClassifierEvents = (session?.classifierEvents ?? []).filter(
      (event) => event.classifier === "pulse_lexical"
    );
    assert.ok(pulseClassifierEvents.length >= 3);
    assert.ok(
      pulseClassifierEvents.every(
        (event) =>
          event.rulepackVersion === "PulseLexicalRulepackV1" &&
          (event.confidenceTier === "HIGH" ||
            event.confidenceTier === "MED" ||
            event.confidenceTier === "LOW")
      )
    );
    assert.ok(
      pulseClassifierEvents.some(
        (event) => event.matchedRuleId === "pulse_lexical_v1_pattern_off"
      )
    );
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager fails closed on conflicting pulse lexical commands and records classifier telemetry", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-pulse-conflict-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const notifications: string[] = [];
  const manager = new ConversationManager(
    store,
    {},
    {
      interpretConversationIntent: async () => ({
        intentType: "pulse_control",
        pulseMode: "on",
        confidence: 0.99,
        rationale: "model fallback should not run after lexical conflict",
        source: "model"
      })
    }
  );

  try {
    await manager.handleMessage(
      buildMessage("/pulse on"),
      async (input) => ({ summary: input }),
      async (message) => {
        notifications.push(message);
      }
    );

    const reply = await manager.handleMessage(
      buildMessage("please turn on and turn off pulse reminders"),
      async () => ({ summary: "Conflict was routed as normal chat input." }),
      async (message) => {
        notifications.push(message);
      }
    );
    assert.equal(reply.trim(), "");

    await waitFor(
      () => notifications.some((message) => message.includes("Conflict was routed as normal chat input.")),
      4_000
    );

    const status = await manager.handleMessage(
      buildMessage("/pulse status"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(status.includes("Agent Pulse: on"));

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    const pulseClassifierConflictEvent = (session?.classifierEvents ?? []).find(
      (event) =>
        event.classifier === "pulse_lexical" &&
        event.matchedRuleId === "pulse_lexical_v1_conflicting_on_and_off"
    );
    assert.ok(pulseClassifierConflictEvent);
    assert.equal(pulseClassifierConflictEvent?.rulepackVersion, "PulseLexicalRulepackV1");
    assert.equal(pulseClassifierConflictEvent?.confidenceTier, "LOW");
    assert.equal(pulseClassifierConflictEvent?.conflict, true);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager uses injected intent interpreter for nuanced pulse-control phrasing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-pulse-intent-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(
    store,
    {},
    {
      interpretConversationIntent: async () => ({
        intentType: "pulse_control",
        pulseMode: "off",
        confidence: 0.93,
        rationale: "Nuanced wording implies stopping reminders.",
        source: "model"
      })
    }
  );

  try {
    await manager.handleMessage(
      buildMessage("/pulse on"),
      async (input) => ({ summary: input }),
      async () => { }
    );

    const interpretedReply = await manager.handleMessage(
      buildMessage("Could you chill with those for now?"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(interpretedReply.includes("Agent Pulse is now OFF"));

    const status = await manager.handleMessage(
      buildMessage("/pulse status"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(status.includes("Agent Pulse: off"));
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager fails closed when injected intent interpreter throws", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-pulse-intent-throw-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const notifications: string[] = [];
  const manager = new ConversationManager(
    store,
    {},
    {
      interpretConversationIntent: async () => {
        throw new Error("intent interpreter unavailable");
      }
    }
  );

  try {
    await manager.handleMessage(
      buildMessage("/pulse on"),
      async (input) => ({ summary: input }),
      async (message) => {
        notifications.push(message);
      }
    );

    const reply = await manager.handleMessage(
      buildMessage("Could you chill with those for now?"),
      async () => ({ summary: "No pulse command interpreted." }),
      async (message) => {
        notifications.push(message);
      }
    );
    assert.equal(reply.trim(), "");

    await waitFor(
      () => notifications.some((message) => message.includes("No pulse command interpreted.")),
      4_000
    );

    const status = await manager.handleMessage(
      buildMessage("/pulse status"),
      async (input) => ({ summary: input }),
      async (message) => {
        notifications.push(message);
      }
    );
    assert.ok(status.includes("Agent Pulse: on"));
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager can enqueue system jobs for proactive pulse flow", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-systemjob-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {
    maxProposalInputChars: 5_000,
    heartbeatIntervalMs: 10,
    maxRecentJobs: 20,
    staleRunningJobRecoveryMs: 60_000,
    maxConversationTurns: 40,
    maxContextTurnsForExecution: 10
  });
  const notifications: string[] = [];
  const executedInputs: string[] = [];

  try {
    await manager.handleMessage(
      buildMessage("/chat hello there"),
      async (input) => {
        executedInputs.push(input);
        return { summary: "hello back" };
      },
      async (message) => {
        notifications.push(message);
      }
    );

    await waitFor(
      () => notifications.some((message) => message.includes("hello back")),
      4_000
    );

    const enqueued = await manager.enqueueSystemJob(
      "telegram:chat-1:user-1",
      "Reason code: stale_fact_revalidation. Ask one concise check-in question.",
      new Date().toISOString(),
      async (input) => {
        executedInputs.push(input);
        return { summary: "Quick check-in: any updates I should know?" };
      },
      async (message) => {
        notifications.push(message);
      }
    );

    assert.equal(enqueued, true);
    await waitFor(
      () => notifications.some((message) => message.includes("Quick check-in")),
      4_000
    );

    assert.ok(
      executedInputs.some((input) => input.includes("System-generated Agent Pulse check-in request."))
    );
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("handleMessage backfills pulse response outcome as engaged when user replies within window", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-cm-pulse-backfill-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));

  const recentEmission = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const session = {
    conversationId: "telegram:chat-1:user-1",
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private" as const,
    updatedAt: recentEmission,
    activeProposal: null,
    runningJobId: null,
    queuedJobs: [],
    recentJobs: [],
    conversationTurns: [],
    agentPulse: {
      optIn: true,
      mode: "private" as const,
      routeStrategy: "last_private_used" as const,
      lastPulseSentAt: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: null,
      lastDecisionCode: "NOT_EVALUATED" as const,
      lastEvaluatedAt: null,
      recentEmissions: [
        {
          emittedAt: recentEmission,
          reasonCode: "OPEN_LOOP_RESUME" as const,
          candidateEntityRefs: ["entity-project"]
        }
      ]
    }
  };
  await store.setSession(session);

  const manager = new ConversationManager(store);
  try {
    await manager.handleMessage(
      {
        provider: "telegram",
        conversationId: "chat-1",
        userId: "user-1",
        username: "agentowner",
        conversationVisibility: "private",
        text: "Yeah the project is going well",
        receivedAt: new Date().toISOString()
      },
      async () => ({ summary: "Good to hear!" }),
      async () => {}
    );

    const loaded = await store.getSession("telegram:chat-1:user-1");
    assert.ok(loaded);
    const emissions = loaded!.agentPulse.recentEmissions ?? [];
    assert.equal(emissions.length, 1);
    assert.equal(emissions[0].responseOutcome, "engaged");
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("enqueueSystemJob marks job as system job and suppresses blocked result delivery", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-cm-systemjob-suppress-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {
    maxProposalInputChars: 5_000,
    heartbeatIntervalMs: 10,
    maxRecentJobs: 20,
    staleRunningJobRecoveryMs: 60_000,
    maxConversationTurns: 40,
    maxContextTurnsForExecution: 10
  });
  const notifications: string[] = [];
  const executedInputs: string[] = [];

  try {
    await manager.handleMessage(
      buildMessage("/chat hello there"),
      async (input) => {
        executedInputs.push(input);
        return { summary: "hello back" };
      },
      async (message) => {
        notifications.push(message);
      }
    );

    await waitFor(
      () => notifications.some((message) => message.includes("hello back")),
      4_000
    );

    const blockedSummary = [
      "I couldn't execute that request in this run.",
      "",
      "Run summary:",
      "- State: blocked",
      "- What will run: respond",
      "- What ran: none"
    ].join("\n");

    const enqueued = await manager.enqueueSystemJob(
      "telegram:chat-1:user-1",
      "Reason code: stale_fact_revalidation. Ask one concise check-in question.",
      new Date().toISOString(),
      async (input) => {
        executedInputs.push(input);
        return { summary: blockedSummary };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.equal(enqueued, true);

    await sleep(2_000);

    assert.equal(
      notifications.some((message) => message.includes("State: blocked")),
      false,
      "Blocked system job result should not be delivered to the user"
    );

    const loaded = await store.getSession("telegram:chat-1:user-1");
    assert.ok(loaded);
    const systemJob = loaded!.recentJobs.find(
      (job) => job.isSystemJob === true
    );
    assert.ok(systemJob, "System job should exist in recent jobs");
    assert.equal(systemJob!.finalDeliveryOutcome, "sent");
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("handleMessage detects timezone from user message and stores in session", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-cm-tz-detect-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));

  const session = {
    conversationId: "telegram:chat-1:user-1",
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private" as const,
    updatedAt: new Date().toISOString(),
    activeProposal: null,
    runningJobId: null,
    queuedJobs: [],
    recentJobs: [],
    conversationTurns: [],
    agentPulse: {
      optIn: false,
      mode: "private" as const,
      routeStrategy: "last_private_used" as const,
      lastPulseSentAt: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: null,
      lastDecisionCode: "NOT_EVALUATED" as const,
      lastEvaluatedAt: null,
      recentEmissions: []
    }
  };
  await store.setSession(session);

  const manager = new ConversationManager(store);
  try {
    await manager.handleMessage(
      {
        provider: "telegram",
        conversationId: "chat-1",
        userId: "user-1",
        username: "agentowner",
        conversationVisibility: "private",
        text: "I'm in EST by the way",
        receivedAt: new Date().toISOString()
      },
      async () => ({ summary: "Got it!" }),
      async () => {}
    );

    const loaded = await store.getSession("telegram:chat-1:user-1");
    assert.ok(loaded);
    assert.equal(loaded!.agentPulse.userTimezone, "America/New_York");
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});
