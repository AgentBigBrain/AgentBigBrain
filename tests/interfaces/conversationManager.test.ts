/**
 * @fileoverview Tests conversational proposal workflow and in-task continuity via queue/status/heartbeat behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ProfileMemoryIngestRequest } from "../../src/core/profileMemoryRuntime/contracts";
import { createEmptyConversationDomainContext } from "../../src/core/sessionContext";
import { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import { createEmptyEntityGraphV1 } from "../../src/core/stage6_86EntityGraph";
import type { TaskRunResult } from "../../src/core/types";
import {
  ConversationInboundMessage,
  ConversationManager as BaseConversationManager,
  type ConversationNotifierTransport
} from "../../src/interfaces/conversationManager";
import { buildConversationInboundUserInput } from "../../src/interfaces/mediaRuntime/mediaNormalization";
import { InterfaceSessionStore as BaseInterfaceSessionStore } from "../../src/interfaces/sessionStore";
import {
  buildConversationJobFixture,
  buildConversationSessionFixture
} from "../helpers/conversationFixtures";

/**
 * Uses the SQLite-backed test store so background worker persistence does not race JSON temp-file
 * renames on Windows under load.
 */
class InterfaceSessionStore extends BaseInterfaceSessionStore {
  constructor(statePath: string) {
    super(statePath, {
      backend: "sqlite",
      sqlitePath: statePath.replace(/\.json$/i, ".sqlite"),
      exportJsonOnWrite: false
    });
  }
}

/**
 * Tracks test-local manager instances so temp-directory cleanup can wait for real background
 * worker settlement before deleting persistence artifacts.
 */
class ConversationManager extends BaseConversationManager {
  private static readonly activeManagers = new Set<ConversationManager>();

  constructor(...args: ConstructorParameters<typeof BaseConversationManager>) {
    super(...args);
    ConversationManager.activeManagers.add(this);
  }

  static async waitForAllManagersToGoIdle(timeoutMs = 30_000): Promise<void> {
    for (const manager of ConversationManager.activeManagers) {
      await manager.waitForIdle(timeoutMs);
    }
  }
}

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
 * Implements `buildVoiceMessage` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildVoiceMessage(transcript: string): ConversationInboundMessage {
  const media = {
    attachments: [
      {
        kind: "voice" as const,
        provider: "telegram" as const,
        fileId: "voice-1",
        fileUniqueId: "voice-1-uniq",
        mimeType: "audio/ogg",
        fileName: null,
        sizeBytes: 1024,
        caption: null,
        durationSeconds: 6,
        width: null,
        height: null,
        interpretation: {
          summary: `Voice note transcript: ${transcript}`,
          transcript,
          ocrText: null,
          confidence: 0.94,
          provenance: "fixture transcription",
          source: "fixture_catalog" as const,
          entityHints: []
        }
      }
    ]
  };

  return {
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
    text: buildConversationInboundUserInput("", media),
    media,
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
 * Builds a minimal governed task result for conversation-manager workflow tests.
 */
function buildTaskRunResult(
  userInput: string,
  summary: string,
  actionResults: TaskRunResult["actionResults"]
): TaskRunResult {
  return {
    task: {
      id: "task_fixture",
      agentId: "main-agent",
      goal: "Handle user request safely and efficiently.",
      userInput,
      createdAt: new Date().toISOString()
    },
    plan: {
      taskId: "task_fixture",
      plannerNotes: "fixture plan",
      actions: actionResults.map((result) => result.action)
    },
    actionResults,
    summary,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  };
}

/**
 * Builds an approved write-file result for workflow continuity tests.
 */
function buildApprovedWriteFileActionResult(
  actionId: string,
  filePath: string
): TaskRunResult["actionResults"][number] {
  return {
    action: {
      id: actionId,
      type: "write_file",
      description: "write file",
      params: {
        path: filePath,
        content: "<html></html>"
      },
      estimatedCostUsd: 0.05
    },
    mode: "escalation_path",
    approved: true,
    output: `Write success: ${filePath}`,
    executionStatus: "success",
    executionMetadata: {
      filePath
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Builds an approved open-browser result for workflow continuity tests.
 */
function buildApprovedOpenBrowserActionResult(
  actionId: string,
  sessionId: string,
  url: string,
  workspaceRootPath: string,
  linkedProcessLeaseId: string
): TaskRunResult["actionResults"][number] {
  return {
    action: {
      id: actionId,
      type: "open_browser",
      description: "open browser",
      params: {
        url,
        previewProcessLeaseId: linkedProcessLeaseId,
        rootPath: workspaceRootPath
      },
      estimatedCostUsd: 0.04
    },
    mode: "escalation_path",
    approved: true,
    output: `Opened ${url} in a visible browser window and left it open for you.`,
    executionStatus: "success",
    executionMetadata: {
      browserSession: true,
      browserSessionId: sessionId,
      browserSessionUrl: url,
      browserSessionStatus: "open",
      browserSessionVisibility: "visible",
      browserSessionControlAvailable: true,
      browserSessionWorkspaceRootPath: workspaceRootPath,
      browserSessionLinkedProcessLeaseId: linkedProcessLeaseId,
      browserSessionLinkedProcessCwd: workspaceRootPath,
      browserSessionLinkedProcessPid: 4242
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Builds an approved close-browser result for workflow continuity tests.
 */
function buildApprovedCloseBrowserActionResult(
  actionId: string,
  sessionId: string,
  url: string,
  workspaceRootPath: string,
  linkedProcessLeaseId: string
): TaskRunResult["actionResults"][number] {
  return {
    action: {
      id: actionId,
      type: "close_browser",
      description: "close browser",
      params: {
        sessionId
      },
      estimatedCostUsd: 0.03
    },
    mode: "escalation_path",
    approved: true,
    output: `Closed ${url}.`,
    executionStatus: "success",
    executionMetadata: {
      browserSession: true,
      browserSessionId: sessionId,
      browserSessionUrl: url,
      browserSessionStatus: "closed",
      browserSessionVisibility: "visible",
      browserSessionControlAvailable: false,
      browserSessionWorkspaceRootPath: workspaceRootPath,
      browserSessionLinkedProcessLeaseId: linkedProcessLeaseId,
      browserSessionLinkedProcessCwd: workspaceRootPath,
      browserSessionLinkedProcessPid: 4242
    },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

/**
 * Builds an approved shell/process result for local-runtime proof tests.
 */
function buildApprovedRunningShellActionResult(
  actionId: string,
  cwd: string,
  probeUrl: string,
  leaseId: string
): TaskRunResult["actionResults"][number] {
  return {
    action: {
      id: actionId,
      type: "shell_command",
      description: "start local process",
      params: {
        command: "python app.py",
        cwd
      },
      estimatedCostUsd: 0.03
    },
    mode: "escalation_path",
    approved: true,
    output: `Started local process in ${cwd}.`,
    executionStatus: "success",
    executionMetadata: {
      processCwd: cwd,
      processLeaseId: leaseId,
      processPid: 5050,
      processLifecycleStatus: "PROCESS_READY",
      probeUrl
    },
    blockedBy: [],
    violations: [],
    votes: []
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
  await ConversationManager.waitForAllManagersToGoIdle();
  await waitForSessionFileToGoIdle(tempDir);

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
 * Waits for JSON-backed conversation session writes to settle before temp-directory cleanup.
 *
 * @param tempDir - Test temp directory that owns `sessions.json`.
 * @returns Promise resolving once no active work or temp-write files remain, or after the bounded timeout.
 */
async function waitForSessionFileToGoIdle(tempDir: string): Promise<void> {
  const sessionPath = path.join(tempDir, "sessions.json");
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    let hasPendingTempWrites = false;
    try {
      const tempEntries = await readdir(tempDir);
      hasPendingTempWrites = tempEntries.some((entry) => entry.startsWith("sessions.json.tmp-"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (code === "ENOENT") {
        return;
      }
      throw error;
    }

    let hasActiveSessionWork = false;
    try {
      const raw = await readFile(sessionPath, "utf8");
      const parsed = JSON.parse(raw) as {
        conversations?: Record<
          string,
          { runningJobId?: string | null; queuedJobs?: unknown[] | null } | null
        >;
      };
      const conversations = Object.values(parsed.conversations ?? {});
      hasActiveSessionWork = conversations.some((session) => {
        if (!session) {
          return false;
        }
        const queuedJobs = Array.isArray(session.queuedJobs) ? session.queuedJobs.length : 0;
        return Boolean(session.runningJobId) || queuedJobs > 0;
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (code !== "ENOENT") {
        throw error;
      }
    }

    if (!hasPendingTempWrites && !hasActiveSessionWork) {
      await sleep(250);
      return;
    }

    await sleep(100);
  }
}

/**
 * Implements `waitFor` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const effectiveTimeoutMs = Math.max(timeoutMs, 12_000);
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > effectiveTimeoutMs) {
      throw new Error(`Timed out waiting for expected condition after ${effectiveTimeoutMs}ms.`);
    }
    await sleep(10);
  }
}

/**
 * Implements `waitForAsync` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function waitForAsync(predicate: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const effectiveTimeoutMs = Math.max(timeoutMs, 12_000);
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > effectiveTimeoutMs) {
      throw new Error(`Timed out waiting for expected async condition after ${effectiveTimeoutMs}ms.`);
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
    assert.ok(approveReply.includes("Execution started. I will keep you updated here while it runs."));

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
    assert.ok(approveReply.includes("Execution started. I will keep you updated here while it runs."));

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
    assert.equal(firstReply, "On it. I'll start with: run long task one");

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
    assert.ok(secondReply.includes("I got your request and added it"));

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
    assert.ok(statusDuringRun.includes("If you want the technical view behind this status, you can still run /status debug."));

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
      notifications.some(
        (message) =>
          message.startsWith("I'm working on that now") ||
          message.startsWith("I'm building the page") ||
          message.startsWith("I'm updating the current page") ||
          message.startsWith("I'm organizing the project folders") ||
          message.startsWith("I'm closing the tracked preview")
      )
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
    assert.equal(reply, "On it. I'll start with: run a long editable task");

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
    await store.setSession(
      buildConversationSessionFixture(
        {
          updatedAt: staleStartedAt,
          runningJobId: "job_stale_123",
          queuedJobs: [
            buildConversationJobFixture({
              id: "job_queued_1",
              input: "recover me",
              createdAt: staleStartedAt
            })
          ],
          agentPulse: {
            ...buildConversationSessionFixture().agentPulse,
            optIn: false
          }
        },
        {
          conversationId: "chat-1",
          receivedAt: staleStartedAt
        }
      )
    );

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

test("conversation manager handles promoted voice commands after media normalization", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-voice-command-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {
    allowAutonomousViaInterface: true,
    heartbeatIntervalMs: 25,
    maxRecentJobs: 20,
    staleRunningJobRecoveryMs: 60_000,
    maxConversationTurns: 40,
    maxContextTurnsForExecution: 10
  });
  try {
    const reply = await manager.handleMessage(
      buildVoiceMessage("BigBrain, command auto fix the planner test now"),
      async (input) => ({ summary: `executed ${input}` }),
      async () => undefined
    );

    assert.match(reply, /Starting autonomous loop for: fix the planner test now/);

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    assert.equal(
      session?.conversationTurns[session.conversationTurns.length - 1]?.text,
      "/auto fix the planner test now"
    );
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager answers natural-language skill discovery with the canonical inventory", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-skills-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(
    store,
    {
      heartbeatIntervalMs: 25,
      maxRecentJobs: 20,
      staleRunningJobRecoveryMs: 60_000,
      maxConversationTurns: 40,
      maxContextTurnsForExecution: 10
    },
    {
      listAvailableSkills: async () => [
        {
          name: "triage_planner_failure",
          description: "Inspect planner failures and summarize likely causes.",
          userSummary: "Reusable tool for planner failure triage.",
          verificationStatus: "verified",
          riskLevel: "low",
          tags: ["planner", "tests"],
          invocationHints: ["Ask me to run skill triage_planner_failure."],
          lifecycleStatus: "active",
          updatedAt: "2026-03-10T12:00:00.000Z"
        }
      ]
    }
  );

  try {
    const reply = await manager.handleMessage(
      buildMessage(
        "Before we jump back into the planner failure, tell me what reusable skills you already have available right now. I want to know which ones are safe to trust before I ask you to use one."
      ),
      async (input) => ({ summary: `executed ${input}` }),
      async () => undefined
    );

    assert.match(reply, /^Reusable skills I can lean on:/);
    assert.match(reply, /triage_planner_failure/);
    assert.match(reply, /planner failure triage/i);

    const toolsReply = await manager.handleMessage(
      buildMessage(
        "Before we go back to the failing planner work, can you show me what reusable tools you already have that you actually trust for this kind of fix? I do not want to rediscover the same approach again if a verified tool already exists."
      ),
      async (input) => ({ summary: `executed ${input}` }),
      async () => undefined
    );

    assert.equal(toolsReply, reply);
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
      buildMessage("/chat give me a lantern puzzle"),
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
    assert.equal(executedInputs[0], "give me a lantern puzzle");
    assert.ok(executedInputs[1].includes("Recent conversation context (oldest to newest):"));
    assert.ok(executedInputs[1].includes("- user: give me a lantern puzzle"));
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
    assert.equal(secondReply, "On it. I'll start with: plain text");

    await waitFor(
      () =>
        notifications.some((message) =>
          message.includes("render the approval diff in plain text")
        ),
      4_000
    );

    assert.equal(executedInputs.length, 2);
    assert.ok(
      executedInputs[1].includes("Recent conversation context (oldest to newest):")
    );
    assert.ok(
      executedInputs[1].includes(
        "- assistant: How would you like the exact approval diff rendered?"
      )
    );
    assert.ok(executedInputs[1].includes("Current user request:\nplain text"));

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    assert.ok(
      session?.recentJobs[0]?.input.includes("plain text")
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
        "- assistant: Please confirm if you would like to proceed with this approach."
      )
    );
    assert.ok(
      executedInputs[2].includes(
        "- Goal: Capture this browser workflow and block if selector drift appears."
      )
    );
    assert.equal(
      executedInputs[2].includes("- Goal: Which school did we attend?"),
      false
    );
    assert.ok(executedInputs[2].includes("Current user request:\nI confirm."));
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
    await store.setSession(
      buildConversationSessionFixture(
        {
          updatedAt: completedAt,
          recentJobs: [
            buildConversationJobFixture({
              id: "job_seed",
              input: "say hello",
              createdAt,
              startedAt: createdAt,
              completedAt,
              status: "completed",
              resultSummary: "Hello! How can I assist you today?",
              ackLifecycleState: "FINAL_SENT_NO_EDIT",
              finalDeliveryOutcome: "sent",
              finalDeliveryAttemptCount: 1,
              finalDeliveryLastAttemptAt: completedAt
            })
          ],
          agentPulse: {
            ...buildConversationSessionFixture().agentPulse,
            optIn: false
          }
        },
        {
          conversationId: "chat-1",
          receivedAt: createdAt
        }
      )
    );

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

test("conversation manager clears orphaned stale progress and stale queued jobs before direct chat", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-stale-queue-chat-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {
    heartbeatIntervalMs: 10,
    maxRecentJobs: 20,
    staleRunningJobRecoveryMs: 2_000,
    maxConversationTurns: 40,
    maxContextTurnsForExecution: 10
  }, {
    runDirectConversationTurn: async () => ({ summary: "Hi." })
  });
  const staleCreatedAt = "2026-03-20T00:00:00.000Z";

  try {
    await store.setSession(
      buildConversationSessionFixture(
        {
          updatedAt: staleCreatedAt,
          progressState: {
            status: "working",
            message: "I'm working on that now.",
            jobId: "job_orphaned",
            updatedAt: staleCreatedAt
          },
          queuedJobs: [
            buildConversationJobFixture({
              id: "job_queued_stale_1",
              input: "old queued request one",
              createdAt: staleCreatedAt
            }),
            buildConversationJobFixture({
              id: "job_queued_stale_2",
              input: "old queued request two",
              createdAt: staleCreatedAt
            })
          ],
          runningJobId: null
        },
        {
          conversationId: "chat-1",
          receivedAt: staleCreatedAt
        }
      )
    );

    const reply = await manager.handleMessage(
      buildMessageAt("Hi", "2026-03-26T12:06:30.000Z"),
      async () => {
        throw new Error("executeTask should not run for direct chat");
      },
      async () => {}
    );
    assert.equal(reply, "Hi.");

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    assert.equal(session?.progressState, null);
    assert.equal(session?.queuedJobs.length, 0);
    assert.ok(
      session?.recentJobs.some(
        (job) =>
          job.id === "job_queued_stale_1" &&
          job.status === "failed" &&
          job.errorMessage === "Recovered stale queued job after runtime interruption." &&
          job.recoveryTrace?.kind === "stale_session_recovery" &&
          job.recoveryTrace.status === "failed"
      )
    );
    assert.ok(
      session?.recentJobs.some(
        (job) =>
          job.id === "job_queued_stale_2" &&
          job.status === "failed" &&
          job.errorMessage === "Recovered stale queued job after runtime interruption." &&
          job.recoveryTrace?.kind === "stale_session_recovery" &&
          job.recoveryTrace.status === "failed"
      )
    );
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager keeps explicit pulse commands authoritative during workflow-heavy sessions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-pulse-workflow-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store);
  const conversationId = "telegram:chat-1:user-1";

  try {
    await store.setSession(
      buildConversationSessionFixture(
        {
          domainContext: {
            ...createEmptyConversationDomainContext(conversationId),
            dominantLane: "workflow",
            continuitySignals: {
              activeWorkspace: true,
              returnHandoff: true,
              modeContinuity: true
            },
            activeSince: "2026-03-07T11:00:00.000Z",
            lastUpdatedAt: "2026-03-07T12:00:00.000Z"
          },
          agentPulse: {
            ...buildConversationSessionFixture().agentPulse,
            optIn: true,
            lastDecisionCode: "SESSION_DOMAIN_SUPPRESSED"
          }
        },
        {
          conversationId: "chat-1",
          receivedAt: "2026-03-07T12:00:00.000Z"
        }
      )
    );

    const statusReply = await manager.handleMessage(
      buildMessage("/pulse status"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(statusReply.includes("Agent Pulse: on"));
    assert.ok(statusReply.includes("Last decision: SESSION_DOMAIN_SUPPRESSED"));

    const disableReply = await manager.handleMessage(
      buildMessage("/pulse off"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.ok(disableReply.includes("Agent Pulse is now OFF"));

    const session = await store.getSession(conversationId);
    assert.equal(session?.agentPulse.optIn, false);
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
    assert.equal(reply, "On it. I'll start with: please turn on and turn off pulse reminders");

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
  let interpreterCalls = 0;
  const manager = new ConversationManager(
    store,
    {},
    {
      interpretConversationIntent: async () => {
        interpreterCalls += 1;
        return {
          intentType: "pulse_control",
          pulseMode: "off",
          confidence: 0.93,
          rationale: "Nuanced wording implies stopping reminders.",
          source: "model"
        };
      }
    }
  );

  try {
    await manager.handleMessage(
      buildMessage("/pulse on"),
      async (input) => ({ summary: input }),
      async () => { }
    );

    const interpretedReply = await manager.handleMessage(
      buildMessage("Could you chill with those reminders for now?"),
      async (input) => ({ summary: input }),
      async () => { }
    );
    assert.equal(interpreterCalls, 1);
    assert.ok(/Agent Pulse/i.test(interpretedReply));

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
    assert.equal(reply, "On it. I'll start with: Could you chill with those for now?");

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

test("conversation manager keeps greetings and identity turns direct under saved handoff context", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-direct-greeting-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const conversationKey = "telegram:chat-1:user-1";
  let localResolverCalls = 0;
  const manager = new ConversationManager(
    store,
    {},
    {
      localIntentModelResolver: async () => {
        localResolverCalls += 1;
        return {
          source: "local_intent_model",
          mode: "status_or_recall",
          confidence: "medium",
          matchedRuleId: "local_intent_model_misread_casual_turn_as_handoff_status",
          explanation: "Incorrectly treated the conversational turn as saved-work recall.",
          clarification: null,
          semanticHint: "review_ready"
        };
      },
      runDirectConversationTurn: async (input) => {
        if (/Current user request:\nHi/i.test(input)) {
          return { summary: "Hey." };
        }
        if (/Current user request:\nAnd you are\?/i.test(input)) {
          return { summary: "I'm AgentBigBrain." };
        }
        throw new Error(`Unexpected direct conversation input: ${input}`);
      }
    }
  );

  await store.setSession(
    buildConversationSessionFixture({
      domainContext: {
        ...createEmptyConversationDomainContext(conversationKey),
        dominantLane: "workflow",
        continuitySignals: {
          activeWorkspace: true,
          returnHandoff: true,
          modeContinuity: true
        },
        activeSince: "2026-03-20T19:43:00.000Z",
        lastUpdatedAt: "2026-03-20T19:43:00.000Z"
      },
      modeContinuity: {
        activeMode: "build",
        source: "natural_intent",
        confidence: "HIGH",
        lastAffirmedAt: "2026-03-20T19:43:00.000Z",
        lastUserInput: "Build the landing page and leave it ready for review."
      },
      returnHandoff: {
        id: "handoff:blocked-job",
        status: "completed",
        goal: "Finish the drone-company landing page and leave it ready for review.",
        summary:
          "I couldn't execute that request in this run. What happened: one or more governed actions were blocked before execution. Why it didn't execute: a safety, governance, or runtime policy denied the requested side effect. What to do next: ask for the exact block code and approval diff, then retry with a narrower allowed action.",
        nextSuggestedStep: "Ask for the exact block code and approval diff, then retry with a narrower allowed action.",
        workspaceRootPath: "C:\\Users\\benac\\OneDrive\\Desktop\\Sample World",
        primaryArtifactPath: "C:\\Users\\benac\\OneDrive\\Desktop\\Sample World\\src\\index.css",
        previewUrl: "file:///C:/Users/benac/OneDrive/Desktop/drone-company-landing.html",
        changedPaths: [
          "C:\\Users\\benac\\OneDrive\\Desktop\\Sample World\\src\\index.css",
          "C:\\Users\\benac\\OneDrive\\Desktop\\Sample World\\src\\App.jsx"
        ],
        sourceJobId: "job-blocked",
        updatedAt: "2026-03-20T19:43:00.000Z"
      }
    })
  );

  try {
    const greetingReply = await manager.handleMessage(
      buildMessageAt("Hi", "2026-03-20T19:44:00.000Z"),
      async () => {
        throw new Error("executeTask should not run for a direct greeting");
      },
      async () => {}
    );
    assert.equal(greetingReply, "Hey.");
    assert.equal(/ready to review/i.test(greetingReply), false);

    const identityReply = await manager.handleMessage(
      {
        ...buildMessageAt("What's my name?", "2026-03-20T19:44:05.000Z"),
        transportIdentity: {
          provider: "telegram",
          username: "avery",
          displayName: null,
          givenName: "Avery",
          familyName: null,
          observedAt: "2026-03-20T19:44:05.000Z"
        }
      },
      async () => {
        throw new Error("executeTask should not run for direct identity recall");
      },
      async () => {}
    );
    assert.equal(
      identityReply,
      "Your Telegram profile shows Avery, but I don't have that saved as a confirmed name fact yet."
    );
    assert.equal(/ready to review/i.test(identityReply), false);
    assert.equal(localResolverCalls, 0);

    const assistantIdentityReply = await manager.handleMessage(
      buildMessageAt("And you are?", "2026-03-20T19:44:08.000Z"),
      async () => {
        throw new Error("executeTask should not run for assistant identity recall");
      },
      async () => {}
    );
    assert.equal(assistantIdentityReply, "I'm AgentBigBrain.");
    assert.equal(/ready to review/i.test(assistantIdentityReply), false);
    assert.equal(localResolverCalls, 0);

    const session = await store.getSession(conversationKey);
    assert.ok(session);
    assert.equal(session?.queuedJobs.length, 0);
    assert.equal(session?.runningJobId, null);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager uses bounded identity facts for self-identity direct chat", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-identity-facts-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(
    store,
    {},
    {
      queryContinuityFacts: async () => [
        {
          factId: "fact_identity_preferred_name",
          key: "identity.preferred_name",
          value: "Avery",
          status: "active",
          observedAt: "2026-03-20T17:45:00.000Z",
          lastUpdatedAt: "2026-03-20T17:45:00.000Z",
          confidence: 0.99
        }
      ],
      runDirectConversationTurn: async () => {
        throw new Error("runDirectConversationTurn should not run for deterministic self-identity replies");
      }
    }
  );

  try {
    const firstReply = await manager.handleMessage(
      buildMessageAt("Who am I?", "2026-03-20T17:46:00.000Z"),
      async () => {
        throw new Error("executeTask should not run for self-identity direct chat");
      },
      async () => {}
    );
    assert.equal(firstReply, "You're Avery.");

    const secondReply = await manager.handleMessage(
      buildMessageAt("You should know my name", "2026-03-20T17:46:05.000Z"),
      async () => {
        throw new Error("executeTask should not run for self-identity follow-up chat");
      },
      async () => {}
    );
    assert.equal(secondReply, "You're Avery.");

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    assert.equal(session?.queuedJobs.length, 0);
    assert.equal(session?.runningJobId, null);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager keeps direct who-am-i questions on the identity path even when only relationship facts exist", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-identity-vs-relationship-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(
    store,
    {},
    {
      queryContinuityFacts: async () => [
        {
          factId: "fact_relationship_manager_only",
          key: "relationship.manager_name",
          value: "Morgan",
          status: "active",
          observedAt: "2026-03-20T17:45:00.000Z",
          lastUpdatedAt: "2026-03-20T17:45:00.000Z",
          confidence: 0.9
        }
      ],
      runDirectConversationTurn: async () => {
        throw new Error("runDirectConversationTurn should not run for deterministic self-identity replies");
      }
    }
  );

  try {
    const reply = await manager.handleMessage(
      buildMessageAt("Do you know who I am?", "2026-03-20T17:46:00.000Z"),
      async () => {
        throw new Error("executeTask should not run for self-identity direct chat");
      },
      async () => {}
    );
    assert.equal(reply, "I don't know your name yet.");
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager keeps assistant-identity acknowledgements and objections conversational under queued workflow state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-assistant-identity-followup-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  let localResolverCalls = 0;
  let identityInterpretationCalls = 0;
  const directInputs: string[] = [];
  const manager = new ConversationManager(
    store,
    {},
    {
      localIntentModelResolver: async () => {
        localResolverCalls += 1;
        return {
          source: "local_intent_model",
          mode: "build",
          confidence: "high",
          matchedRuleId: "local_intent_model_misread_assistant_identity_followup_as_work",
          explanation: "Incorrectly treated the conversational follow-up as work.",
          clarification: null
        };
      },
      identityInterpretationResolver: async () => {
        identityInterpretationCalls += 1;
        return {
          source: "local_intent_model",
          kind: "assistant_identity_query",
          candidateValue: null,
          confidence: "high",
          shouldPersist: false,
          explanation: "Incorrectly treated the acknowledgement as another assistant-identity question."
        };
      },
      runDirectConversationTurn: async (input) => {
        directInputs.push(input);
        if (/Current user request:\nI know you are\./i.test(input)) {
          return { summary: "Okay." };
        }
        if (/Current user request:\nI didn't say to work on that\./i.test(input)) {
          return { summary: "Okay, I won't treat that as a new work request." };
        }
        throw new Error(`Unexpected direct conversation input: ${input}`);
      }
    }
  );

  try {
    await store.setSession(
      buildConversationSessionFixture({
        conversationTurns: [
          {
            role: "user",
            text: "Who are you?",
            at: "2026-03-25T23:42:00.000Z"
          },
          {
            role: "assistant",
            text: "I'm BigBrain.",
            at: "2026-03-25T23:42:01.000Z"
          }
        ],
        runningJobId: "job-running",
        queuedJobs: [
          buildConversationJobFixture({
            id: "job-queued-identity-followup",
            input: "finish the landing page",
            executionInput: "finish the landing page",
            createdAt: "2026-03-25T23:41:50.000Z"
          })
        ]
      })
    );

    const acknowledgementReply = await manager.handleMessage(
      buildMessageAt("I know you are.", "2026-03-25T23:42:05.000Z"),
      async () => {
        throw new Error("executeTask should not run for assistant-identity acknowledgement chat");
      },
      async () => {}
    );
    assert.equal(acknowledgementReply, "Okay.");

    const objectionReply = await manager.handleMessage(
      buildMessageAt("I didn't say to work on that.", "2026-03-25T23:42:08.000Z"),
      async () => {
        throw new Error("executeTask should not run for assistant-identity objection chat");
      },
      async () => {}
    );
    assert.equal(objectionReply, "Okay, I won't treat that as a new work request.");
    assert.equal(localResolverCalls, 0);
    assert.equal(identityInterpretationCalls, 0);
    assert.equal(directInputs.length, 2);

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    assert.equal(session?.queuedJobs.length, 1);
    assert.equal(session?.runningJobId, null);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager keeps question-like relationship recall off the queued continuation path after an assistant prompt", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-relationship-followup-chat-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {}, {
    runDirectConversationTurn: async (input) => {
      if (/Current user request:\nSo, yeah, who is Milo\?/i.test(input)) {
        return { summary: "Milo is the person you said used to work with you." };
      }
      throw new Error(`Unexpected direct conversation input: ${input}`);
    }
  });

  try {
    await store.setSession(
      buildConversationSessionFixture({
        conversationTurns: [
          {
            role: "assistant",
            text: "Do you want me to keep going there?",
            at: "2026-03-26T20:04:00.000Z"
          }
        ]
      })
    );

    const reply = await manager.handleMessage(
      buildMessageAt("So, yeah, who is Milo?", "2026-03-26T20:06:00.000Z"),
      async () => {
        throw new Error("executeTask should not run for question-like relationship recall chat");
      },
      async () => {}
    );
    assert.equal(reply, "Milo is the person you said used to work with you.");

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    assert.equal(session?.queuedJobs.length, 0);
    assert.equal(session?.runningJobId, null);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager keeps relationship recap and entity follow-up chat direct under stale build continuity", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-relationship-recap-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const conversationKey = "telegram:chat-1:user-1";
  let localResolverCalls = 0;
  const directInputs: string[] = [];
  const manager = new ConversationManager(
    store,
    {},
    {
      localIntentModelResolver: async () => {
        localResolverCalls += 1;
        return {
          source: "local_intent_model",
          mode: "build",
          confidence: "high",
          matchedRuleId: "local_intent_model_misread_relationship_recap_as_build_followup",
          explanation: "Incorrectly treated the relationship recap turn as build continuity.",
          clarification: null
        };
      },
      runDirectConversationTurn: async (input) => {
        directInputs.push(input);
        assert.doesNotMatch(input, /Current working mode from earlier in this chat:/i);
        if (/Current user request:\nCan you re explain all these relationships I just told you\?/i.test(input)) {
          return {
            summary:
              "You work at Northstar Creative and you own Lantern Studio.\n\nMilo is your boss at Northstar Creative, and Owen used to work for you at Lantern Studio."
          };
        }
        if (/Current user request:\nAnd Milo, who is he\?/i.test(input)) {
          return {
            summary: "Milo is your boss at Northstar Creative."
          };
        }
        throw new Error(`Unexpected direct conversation input: ${input}`);
      }
    }
  );

  await store.setSession(
    buildConversationSessionFixture({
      conversationTurns: [
        {
          role: "user",
          text: "Who am I?",
          at: "2026-03-26T15:35:00.000Z"
        },
        {
          role: "assistant",
          text: "You're Avery.",
          at: "2026-03-26T15:36:00.000Z"
        },
        {
          role: "user",
          text:
            "I work with a guy named Milo, and I used to work with a person named Owen. Milo is married, and Owen has a girlfriend. I work with Milo at Northstar Creative and I used to work with Owen at Lantern Studio.",
          at: "2026-03-26T15:37:00.000Z"
        },
        {
          role: "assistant",
          text: "Got it - you work with Milo at Northstar Creative, and you used to work with Owen at Lantern Studio.",
          at: "2026-03-26T15:37:05.000Z"
        },
        {
          role: "user",
          text: "I own Lantern Studio, but I also work at Northstar Creative.",
          at: "2026-03-26T15:37:15.000Z"
        },
        {
          role: "user",
          text: "Owen used to work for me, but Milo is my boss.",
          at: "2026-03-26T15:37:30.000Z"
        },
        {
          role: "assistant",
          text: "Got it. Owen used to work for you, and Milo is your boss.",
          at: "2026-03-26T15:38:00.000Z"
        }
      ],
      domainContext: {
        ...createEmptyConversationDomainContext(conversationKey),
        dominantLane: "workflow",
        continuitySignals: {
          activeWorkspace: true,
          returnHandoff: true,
          modeContinuity: true
        },
        activeSince: "2026-03-26T10:51:00.000Z",
        lastUpdatedAt: "2026-03-26T15:38:00.000Z"
      },
      modeContinuity: {
        activeMode: "build",
        source: "natural_intent",
        confidence: "HIGH",
        lastAffirmedAt: "2026-03-26T10:51:00.000Z",
        lastUserInput: "Build the Sky Drone Max landing page and leave it open in the browser."
      },
      returnHandoff: {
        id: "handoff:sky-drone-max",
        status: "stopped",
        goal: "Finish the Sky Drone Max landing page and leave it running in the browser.",
        summary:
          "I couldn't execute that request in this run. What happened: governance blocked the requested action. Why it didn't execute: Security governor rejected this request.",
        nextSuggestedStep: "Retry with a safer and narrower request.",
        workspaceRootPath: "C:\\Users\\benac\\OneDrive\\Desktop\\Sky Drone Max",
        primaryArtifactPath: "C:\\Users\\benac\\OneDrive\\Desktop\\Sky Drone Max\\src\\index.css",
        previewUrl: null,
        changedPaths: [
          "C:\\Users\\benac\\OneDrive\\Desktop\\Sky Drone Max\\src\\index.css",
          "C:\\Users\\benac\\OneDrive\\Desktop\\Sky Drone Max\\src\\App.jsx"
        ],
        sourceJobId: "job-sky-drone-max",
        updatedAt: "2026-03-26T10:55:00.000Z"
      },
      recentActions: [
        {
          id: "recent_task_summary_sky_drone_max",
          kind: "task_summary",
          label: "Sky Drone Max task summary",
          location: null,
          status: "failed",
          sourceJobId: "job-sky-drone-max",
          at: "2026-03-26T10:55:00.000Z",
          summary:
            "Latest completed task: Completed task with 0 approved action(s) and 2 blocked action(s) across 2 plan attempt(s). Recovery postmortem: MISSION_STOP_LIMIT_REACHED."
        },
        {
          id: "recent_file_index_css_sky_drone_max",
          kind: "file",
          label: "index.css",
          location: "C:\\Users\\benac\\OneDrive\\Desktop\\Sky Drone Max\\src\\index.css",
          status: "updated",
          sourceJobId: "job-sky-drone-max",
          at: "2026-03-26T10:54:50.000Z",
          summary: "Updated index.css for Sky Drone Max."
        }
      ]
    })
  );

  try {
    const relationshipReply = await manager.handleMessage(
      buildMessageAt(
        "Can you re explain all these relationships I just told you?",
        "2026-03-26T15:38:10.000Z"
      ),
      async () => {
        throw new Error("executeTask should not run for relationship recap chat");
      },
      async () => {}
    );
    assert.match(relationshipReply, /Milo is your boss at Northstar Creative/i);
    assert.doesNotMatch(relationshipReply, /governance blocked|Most recent actions/i);

    const miloReply = await manager.handleMessage(
      buildMessageAt("And Milo, who is he?", "2026-03-26T15:40:00.000Z"),
      async () => {
        throw new Error("executeTask should not run for relationship entity follow-up chat");
      },
      async () => {}
    );
    assert.equal(miloReply, "Milo is your boss at Northstar Creative.");
    assert.doesNotMatch(miloReply, /Most recent actions|MISSION_STOP_LIMIT_REACHED/i);

    assert.equal(localResolverCalls, 0);
    assert.equal(directInputs.length, 2);

    const session = await store.getSession(conversationKey);
    assert.ok(session);
    assert.equal(session?.queuedJobs.length, 0);
    assert.equal(session?.runningJobId, null);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager can answer self-identity from low-confidence transport identity hints", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-identity-transport-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {}, {
    runDirectConversationTurn: async () => {
      throw new Error("runDirectConversationTurn should not run for deterministic self-identity replies");
    }
  });

  try {
    const reply = await manager.handleMessage(
      {
        ...buildMessageAt("Who am I?", "2026-03-20T20:49:00.000Z"),
        transportIdentity: {
          provider: "telegram",
          username: "averybrooks",
          displayName: "Avery Brooks",
          givenName: "Avery",
          familyName: "Bena",
          observedAt: "2026-03-20T20:49:00.000Z"
        }
      },
      async () => {
        throw new Error("executeTask should not run for self-identity direct chat");
      },
      async () => {}
    );
    assert.equal(
      reply,
      "Your Telegram profile shows Avery Brooks, but I don't have that saved as a confirmed name fact yet."
    );

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    assert.equal(session?.transportIdentity?.givenName, "Avery");
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager persists direct self-identity declarations and recalls them later without queueing work", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-identity-declaration-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  let rememberedPreferredName: string | null = null;
  const manager = new ConversationManager(store, {}, {
    queryContinuityFacts: async () =>
      rememberedPreferredName
        ? [
            {
              factId: "fact_identity_preferred_name_runtime",
              key: "identity.preferred_name",
              value: rememberedPreferredName,
              status: "active",
              observedAt: "2026-03-20T23:10:00.000Z",
              lastUpdatedAt: "2026-03-20T23:10:00.000Z",
              confidence: 0.99
            }
          ]
        : [],
    rememberConversationProfileInput: async (input) => {
      const userInput = typeof input === "string" ? input : input.userInput ?? "";
      if (/my name is avery/i.test(userInput)) {
        rememberedPreferredName = "Avery";
        return true;
      }
      return false;
    },
    runDirectConversationTurn: async () => {
      throw new Error("runDirectConversationTurn should not run for deterministic identity declaration or recall replies");
    }
  });

  try {
    const initialReply = await manager.handleMessage(
      {
        ...buildMessageAt("What is my name?", "2026-03-20T23:09:00.000Z"),
        username: "avery_brooks"
      },
      async () => {
        throw new Error("executeTask should not run for self-identity direct chat");
      },
      async () => {}
    );
    assert.equal(
      initialReply,
      "Your Telegram username looks like Avery Brooks, but I don't have that saved as a confirmed name fact yet."
    );

    const declarationReply = await manager.handleMessage(
      {
        ...buildMessageAt("My name is Avery, yes.", "2026-03-20T23:10:00.000Z"),
        username: "avery_brooks"
      },
      async () => {
        throw new Error("executeTask should not run for self-identity declaration chat");
      },
      async () => {}
    );
    assert.equal(declarationReply, "Okay, I'll remember that you're Avery.");

    const recalledReply = await manager.handleMessage(
      {
        ...buildMessageAt("What is my name?", "2026-03-20T23:10:05.000Z"),
        username: "avery_brooks"
      },
      async () => {
        throw new Error("executeTask should not run for self-identity recall chat");
      },
      async () => {}
    );
    assert.equal(recalledReply, "You're Avery.");

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    assert.equal(session?.queuedJobs.length, 0);
    assert.equal(session?.runningJobId, null);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager uses model-assisted identity interpretation for ambiguous self-identity declarations and keeps mixed no-plus-identity recall off the worker path", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-identity-discourse-tail-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  let rememberedPreferredName: string | null = null;
  const rememberedInputs: unknown[] = [];
  const interpretedInputs: string[] = [];
  const manager = new ConversationManager(store, {}, {
    queryContinuityFacts: async () =>
      rememberedPreferredName
        ? [
            {
              factId: "fact_identity_preferred_name_discourse_tail",
              key: "identity.preferred_name",
              value: rememberedPreferredName,
              status: "active",
              observedAt: "2026-03-20T23:44:00.000Z",
              lastUpdatedAt: "2026-03-20T23:44:00.000Z",
              confidence: 0.99
            }
          ]
        : [],
    rememberConversationProfileInput: async (input) => {
      rememberedInputs.push(input);
      const preferredNameCandidate =
        typeof input === "string"
          ? /my name is avery/i.test(input)
            ? "Avery"
            : null
          : input.validatedFactCandidates?.find(
              (candidate) => candidate.key === "identity.preferred_name"
            )?.candidateValue ?? null;
      if (preferredNameCandidate === "Avery") {
        rememberedPreferredName = "Avery";
        return true;
      }
      return false;
    },
    identityInterpretationResolver: async (request) => {
      interpretedInputs.push(request.userInput);
      if (/my name is avery/i.test(request.userInput)) {
        return {
          source: "local_intent_model",
          kind: "self_identity_declaration",
          candidateValue: "Avery",
          confidence: "medium",
          shouldPersist: true,
          explanation: "The user is explicitly reaffirming their own name."
        };
      }
      return null;
    },
    runDirectConversationTurn: async () => {
      throw new Error("runDirectConversationTurn should not run for model-assisted identity declaration or mixed identity recall replies");
    }
  });

  try {
    const declarationReply = await manager.handleMessage(
      {
        ...buildMessageAt("I already told you my name is Avery several times.", "2026-03-20T23:44:00.000Z"),
        username: "avery_brooks"
      },
      async () => {
        throw new Error("executeTask should not run for self-identity declaration chat");
      },
      async () => {}
    );
    assert.equal(declarationReply, "Okay, I'll remember that you're Avery.");
    assert.deepEqual(interpretedInputs, [
      "I already told you my name is Avery several times."
    ]);
    assert.equal(rememberedInputs.length, 1);
    const rememberedRequest = rememberedInputs[0] as ProfileMemoryIngestRequest;
    assert.deepEqual(rememberedRequest.validatedFactCandidates, [
      {
        key: "identity.preferred_name",
        candidateValue: "Avery",
        source: "conversation.identity_interpretation",
        confidence: 0.95
      }
    ]);
    assert.equal(rememberedRequest.provenance?.conversationId, "telegram:chat-1:user-1");
    assert.equal(rememberedRequest.provenance?.dominantLaneAtWrite, "unknown");
    assert.equal(rememberedRequest.provenance?.threadKey, null);
    assert.equal(rememberedRequest.provenance?.sourceSurface, "conversation_profile_input");
    assert.match(rememberedRequest.provenance?.turnId ?? "", /^turn_[a-f0-9]{24}$/);
    assert.match(rememberedRequest.provenance?.sourceFingerprint ?? "", /^[a-f0-9]{32}$/);

    const recalledReply = await manager.handleMessage(
      {
        ...buildMessageAt("no what is my name", "2026-03-20T23:44:05.000Z"),
        username: "avery_brooks"
      },
      async () => {
        throw new Error("executeTask should not run for mixed no-plus-identity recall chat");
      },
      async () => {}
    );
    assert.equal(recalledReply, "You're Avery.");

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    assert.equal(session?.queuedJobs.length, 0);
    assert.equal(session?.runningJobId, null);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager forwards bounded conversational provenance on direct relationship updates", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-relationship-provenance-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const rememberedInputs: ProfileMemoryIngestRequest[] = [];
  const manager = new ConversationManager(store, {}, {
    rememberConversationProfileInput: async (input) => {
      if (typeof input === "string") {
        throw new Error("direct relationship update should use the bounded request contract");
      }
      rememberedInputs.push(input);
      return true;
    },
    runDirectConversationTurn: async () => ({
      summary: "Noted."
    })
  });

  try {
    const reply = await manager.handleMessage(
      buildMessageAt(
        "I work with Milo at Northstar Creative.",
        "2026-03-26T15:39:00.000Z"
      ),
      async () => {
        throw new Error("executeTask should not run for direct relationship-update chat");
      },
      async () => {}
    );

    assert.equal(reply, "Noted.");
    assert.equal(rememberedInputs.length, 1);
    assert.equal(rememberedInputs[0]?.userInput, "I work with Milo at Northstar Creative.");
    assert.equal(rememberedInputs[0]?.provenance?.conversationId, "telegram:chat-1:user-1");
    assert.equal(rememberedInputs[0]?.provenance?.dominantLaneAtWrite, "unknown");
    assert.equal(rememberedInputs[0]?.provenance?.threadKey, null);
    assert.equal(rememberedInputs[0]?.provenance?.sourceSurface, "conversation_profile_input");
    assert.match(rememberedInputs[0]?.provenance?.turnId ?? "", /^turn_[a-f0-9]{24}$/);
    assert.match(rememberedInputs[0]?.provenance?.sourceFingerprint ?? "", /^[a-f0-9]{32}$/);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager keeps mixed relationship-plus-build turns off the direct conversational memory seam", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-mixed-relationship-workflow-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  let rememberedInputCount = 0;
  const executedInputs: string[] = [];
  const notifications: string[] = [];
  const manager = new ConversationManager(store, {}, {
    rememberConversationProfileInput: async () => {
      rememberedInputCount += 1;
      return true;
    },
    runDirectConversationTurn: async () => {
      throw new Error("runDirectConversationTurn should not run for mixed relationship-plus-build requests");
    }
  });

  try {
    const reply = await manager.handleMessage(
      buildMessageAt(
        "Execute now and build the landing page. I work with Billy at Flare Web Design.",
        "2026-03-26T15:40:00.000Z"
      ),
      async (input) => {
        executedInputs.push(input);
        return {
          summary: "I started the landing page build."
        };
      },
      async (message) => {
        notifications.push(message);
      }
    );

    assert.match(reply, /On it\./i);
    await waitFor(
      () => notifications.some((message) => /landing page build/i.test(message)),
      4_000
    );

    assert.equal(rememberedInputCount, 0);
    assert.equal(executedInputs.length, 1);
    assert.match(
      executedInputs[0] ?? "",
      /Execute now and build the landing page\. I work with Billy at Flare Web Design\./
    );
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager reuses one continuity read session for direct chat contextual recall", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-continuity-session-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const conversationKey = "telegram:chat-1:user-1";
  let openedSessions = 0;
  let continuityEpisodeQueries = 0;
  let continuityFactQueries = 0;
  const directInputs: string[] = [];
  const manager = new ConversationManager(
    store,
    {},
    {
      queryContinuityEpisodes: async () => {
        throw new Error("raw continuity episode callback should not run when a session opener is available");
      },
      queryContinuityFacts: async () => {
        throw new Error("raw continuity fact callback should not run when a session opener is available");
      },
      openContinuityReadSession: async () => {
        openedSessions += 1;
        return {
          queryContinuityEpisodes: async () => {
            continuityEpisodeQueries += 1;
            return [
              {
                episodeId: "episode_owen_fall",
                title: "Owen fell down",
                summary: "Owen fell down a few weeks ago and the outcome never got resolved.",
                status: "unresolved",
                lastMentionedAt: "2026-02-14T15:00:00.000Z",
                entityRefs: ["Owen"],
                entityLinks: [
                  {
                    entityKey: "entity_owen",
                    canonicalName: "Owen"
                  }
                ],
                openLoopLinks: [
                  {
                    loopId: "loop_owen",
                    threadKey: "thread_owen",
                    status: "open",
                    priority: 0.8
                  }
                ]
              }
            ];
          },
          queryContinuityFacts: async () => {
            continuityFactQueries += 1;
            return [
              {
                factId: "fact_owen_relationship",
                key: "contact.owen.relationship",
                value: "work_peer",
                status: "active",
                observedAt: "2026-02-14T15:00:00.000Z",
                lastUpdatedAt: "2026-02-14T15:00:00.000Z",
                confidence: 0.82
              }
            ];
          }
        };
      },
      runDirectConversationTurn: async (input) => {
        directInputs.push(input);
        return {
          summary: "Owen seems better now."
        };
      }
    }
  );

  await store.setSession(
    buildConversationSessionFixture({
      conversationId: conversationKey,
      conversationTurns: [
        {
          role: "user",
          text: "Owen fell down a few weeks ago.",
          at: "2026-02-14T15:00:00.000Z"
        }
      ],
      conversationStack: {
        schemaVersion: "v1",
        updatedAt: "2026-03-26T15:38:00.000Z",
        activeThreadKey: "thread_current",
        threads: [
          {
            threadKey: "thread_current",
            topicKey: "general_chat",
            topicLabel: "General Chat",
            state: "active",
            resumeHint: "Current conversation.",
            openLoops: [],
            lastTouchedAt: "2026-03-26T15:38:00.000Z"
          },
          {
            threadKey: "thread_owen",
            topicKey: "owen_fall",
            topicLabel: "Owen Fall",
            state: "paused",
            resumeHint: "Owen fell down and you wanted to hear how it ended up.",
            openLoops: [
              {
                loopId: "loop_owen",
                threadKey: "thread_owen",
                entityRefs: ["owen"],
                createdAt: "2026-02-14T15:00:00.000Z",
                lastMentionedAt: "2026-02-14T15:00:00.000Z",
                priority: 0.8,
                status: "open"
              }
            ],
            lastTouchedAt: "2026-02-14T15:00:00.000Z"
          }
        ],
        topics: [
          {
            topicKey: "general_chat",
            label: "General Chat",
            firstSeenAt: "2026-03-26T15:38:00.000Z",
            lastSeenAt: "2026-03-26T15:38:00.000Z",
            mentionCount: 1
          },
          {
            topicKey: "owen_fall",
            label: "Owen Fall",
            firstSeenAt: "2026-02-14T15:00:00.000Z",
            lastSeenAt: "2026-02-14T15:00:00.000Z",
            mentionCount: 1
          }
        ]
      }
    })
  );

  try {
    const reply = await manager.handleMessage(
      buildMessageAt(
        "Chat with me about Owen for a minute. How is he doing lately?",
        "2026-03-26T15:39:00.000Z"
      ),
      async () => {
        throw new Error("executeTask should not run for direct chat contextual recall");
      },
      async () => {}
    );

    assert.equal(reply, "Owen seems better now.");
    assert.equal(openedSessions, 1);
    assert.equal(continuityEpisodeQueries, 2);
    assert.equal(continuityFactQueries, 1);
    assert.equal(directInputs.length, 1);
    assert.match(directInputs[0] ?? "", /Contextual recall opportunity \(optional\):/);
    assert.match(directInputs[0] ?? "", /Relevant situation: Owen fell down/i);

    const session = await store.getSession(conversationKey);
    assert.ok(session);
    assert.equal(session?.queuedJobs.length, 0);
    assert.equal(session?.runningJobId, null);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager remembers relationship updates through the direct chat seam and reuses them after workflow clutter", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-relationship-direct-memory-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const profileStore = new ProfileMemoryStore(
    path.join(tempDir, "profile_memory.secure.json"),
    Buffer.alloc(32, 91),
    90
  );
  const conversationKey = "telegram:chat-1:user-1";
  const directInputs: string[] = [];
  const manager = new ConversationManager(store, {
    maxConversationTurns: 50,
    maxContextTurnsForExecution: 10
  }, {
    rememberConversationProfileInput: async (input, receivedAt) => {
      const request = typeof input === "string"
        ? { userInput: input }
        : input;
      const result = await profileStore.ingestFromTaskInput(
        "task_conversation_relationship_direct_memory",
        request.userInput ?? "",
        receivedAt,
        {
          validatedFactCandidates: request.validatedFactCandidates
        }
      );
      return result.appliedFacts > 0;
    },
    queryContinuityFacts: async (request) =>
      profileStore.queryFactsForContinuity(
        createEmptyEntityGraphV1("2026-03-26T15:39:10.000Z"),
        request.stack,
        request
      ),
    runDirectConversationTurn: async (input) => {
      directInputs.push(input);
      if (/Current user request:\nI work with Milo at Northstar Creative\./i.test(input)) {
        return {
          summary: "Noted."
        };
      }
      if (/Current user request:\nSo, yeah, who is Milo\?/i.test(input)) {
        assert.doesNotMatch(input, /Current working mode from earlier in this chat:/i);
        assert.match(input, /Milo/i);
        return {
          summary: "Milo is your coworker at Northstar Creative."
        };
      }
      throw new Error(`Unexpected direct conversation input: ${input}`);
    }
  });

  try {
    await store.setSession(
      buildConversationSessionFixture({
        domainContext: {
          ...createEmptyConversationDomainContext(conversationKey),
          dominantLane: "workflow",
          continuitySignals: {
            activeWorkspace: true,
            returnHandoff: true,
            modeContinuity: true
          },
          activeSince: "2026-03-26T15:38:00.000Z",
          lastUpdatedAt: "2026-03-26T15:38:00.000Z"
        },
        modeContinuity: {
          activeMode: "build",
          source: "natural_intent",
          confidence: "HIGH",
          lastAffirmedAt: "2026-03-26T15:38:00.000Z",
          lastUserInput: "Build the Sky Drone Max landing page and leave it open in the browser."
        },
        returnHandoff: {
          id: "handoff:sky-drone-max",
          status: "stopped",
          goal: "Finish the Sky Drone Max landing page and leave it running in the browser.",
          summary: "The run stopped before it finished.",
          nextSuggestedStep: "Retry with a narrower request.",
          workspaceRootPath: "C:\\Users\\benac\\OneDrive\\Desktop\\Sky Drone Max",
          primaryArtifactPath: "C:\\Users\\benac\\OneDrive\\Desktop\\Sky Drone Max\\src\\App.jsx",
          previewUrl: null,
          changedPaths: [
            "C:\\Users\\benac\\OneDrive\\Desktop\\Sky Drone Max\\src\\App.jsx"
          ],
          sourceJobId: "job-sky-drone-max",
          updatedAt: "2026-03-26T15:38:00.000Z"
        }
      })
    );

    const statementReply = await manager.handleMessage(
      buildMessageAt(
        "I work with Milo at Northstar Creative.",
        "2026-03-26T15:39:00.000Z"
      ),
      async () => {
        throw new Error("executeTask should not run for direct relationship-update chat");
      },
      async () => {}
    );
    assert.equal(statementReply, "Noted.");

    const storedFacts = await profileStore.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });
    assert.equal(
      storedFacts.some(
        (fact) =>
          fact.key === "contact.milo.work_association" &&
          fact.value === "Northstar Creative"
      ),
      true
    );

    const recallReply = await manager.handleMessage(
      buildMessageAt("So, yeah, who is Milo?", "2026-03-26T15:39:10.000Z"),
      async () => {
        throw new Error("executeTask should not run for direct relationship recall chat");
      },
      async () => {}
    );
    assert.equal(recallReply, "Milo is your coworker at Northstar Creative.");
    assert.equal(directInputs.length, 2);

    const session = await store.getSession(conversationKey);
    assert.ok(session);
    assert.equal(session?.queuedJobs.length, 0);
    assert.equal(session?.runningJobId, null);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager fails closed for ambiguous identity declarations when the shared interpreter is unavailable", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-identity-no-model-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  let rememberCalls = 0;
  const manager = new ConversationManager(store, {}, {
    rememberConversationProfileInput: async () => {
      rememberCalls += 1;
      return false;
    },
    runDirectConversationTurn: async () => {
      throw new Error("runDirectConversationTurn should not run when ambiguous identity interpretation fails closed");
    }
  });

  try {
    const reply = await manager.handleMessage(
      {
        ...buildMessageAt("I already told you my name is Avery several times.", "2026-03-20T23:45:00.000Z"),
        username: "avery_brooks"
      },
      async () => {
        throw new Error("executeTask should not run for ambiguous self-identity declaration chat");
      },
      async () => {}
    );
    assert.equal(
      reply,
      "If you're telling me your name, say it in a short direct form like \"My name is Avery.\" and I'll remember it."
    );
    assert.equal(rememberCalls, 0);

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    assert.equal(session?.queuedJobs.length, 0);
    assert.equal(session?.runningJobId, null);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager fails closed for ambiguous identity declarations when the shared interpreter times out", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-identity-timeout-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  let rememberCalls = 0;
  let interpretationCalls = 0;
  const manager = new ConversationManager(store, {}, {
    rememberConversationProfileInput: async () => {
      rememberCalls += 1;
      return false;
    },
    identityInterpretationResolver: async () => {
      interpretationCalls += 1;
      throw new Error("Request timed out while waiting for the local identity interpreter.");
    },
    runDirectConversationTurn: async () => {
      throw new Error("runDirectConversationTurn should not run when ambiguous identity interpretation times out");
    }
  });

  try {
    const reply = await manager.handleMessage(
      {
        ...buildMessageAt("I already told you my name is Avery several times.", "2026-03-20T23:46:00.000Z"),
        username: "avery_brooks"
      },
      async () => {
        throw new Error("executeTask should not run for ambiguous self-identity declaration chat");
      },
      async () => {}
    );
    assert.equal(
      reply,
      "If you're telling me your name, say it in a short direct form like \"My name is Avery.\" and I'll remember it."
    );
    assert.equal(rememberCalls, 0);
    assert.equal(interpretationCalls, 1);

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    assert.equal(session?.queuedJobs.length, 0);
    assert.equal(session?.runningJobId, null);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager still fails closed for self-identity when only a generic username exists", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-identity-generic-handle-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {}, {
    runDirectConversationTurn: async () => {
      throw new Error("runDirectConversationTurn should not run for deterministic self-identity replies");
    }
  });

  try {
    const reply = await manager.handleMessage(
      {
        ...buildMessageAt("Who am I?", "2026-03-20T20:50:00.000Z"),
        transportIdentity: {
          provider: "telegram",
          username: "agentowner",
          displayName: null,
          givenName: null,
          familyName: null,
          observedAt: "2026-03-20T20:50:00.000Z"
        }
      },
      async () => {
        throw new Error("executeTask should not run for self-identity direct chat");
      },
      async () => {}
    );
    assert.equal(reply, "I don't know your name yet.");
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager reconciles one interpreted entity alias candidate through the bounded store callback without queueing work", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-entity-alias-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const receivedAt = "2026-03-21T09:00:10.000Z";
  const aliasMutations: Array<{
    entityKey: string;
    aliasCandidate: string;
    observedAt: string;
    evidenceRef: string;
  }> = [];
  let interpretationCalls = 0;
  await store.setSession(
    buildConversationSessionFixture(
      {
        updatedAt: "2026-03-21T09:00:00.000Z",
        conversationTurns: [
          {
            role: "user",
            text: "Sarah said the client meeting went badly.",
            at: "2026-03-21T08:59:00.000Z"
          },
          {
            role: "assistant",
            text: "If she comes up again, I can help you revisit that situation.",
            at: "2026-03-21T08:59:10.000Z"
          }
        ]
      },
      {
        conversationId: "chat-1",
        receivedAt: "2026-03-21T09:00:00.000Z"
      }
    )
  );
  const manager = new ConversationManager(store, {}, {
    runDirectConversationTurn: async () => ({ summary: "Okay." }),
    getEntityGraph: async () => ({
      schemaVersion: "v1",
      updatedAt: "2026-03-21T09:00:00.000Z",
      entities: [
        {
          entityKey: "entity_sarah",
          canonicalName: "Sarah",
          entityType: "person",
          disambiguator: null,
          domainHint: "relationship",
          aliases: ["Sarah"],
          firstSeenAt: "2026-03-21T08:59:00.000Z",
          lastSeenAt: "2026-03-21T08:59:00.000Z",
          salience: 2,
          evidenceRefs: ["trace:sarah"]
        },
        {
          entityKey: "entity_sarah_lee",
          canonicalName: "Sarah Lee",
          entityType: "person",
          disambiguator: null,
          domainHint: "relationship",
          aliases: ["Sarah Lee"],
          firstSeenAt: "2026-03-21T08:59:00.000Z",
          lastSeenAt: "2026-03-21T08:59:00.000Z",
          salience: 1,
          evidenceRefs: ["trace:sarah_lee"]
        }
      ],
      edges: []
    }),
    entityReferenceInterpretationResolver: async (request) => {
      interpretationCalls += 1;
      assert.equal(request.userInput, "I mean Sarah Connor, not Sarah Lee.");
      assert.equal(request.candidateEntities?.length, 2);
      return {
        source: "local_intent_model",
        kind: "entity_alias_candidate",
        selectedEntityKeys: ["entity_sarah"],
        aliasCandidate: "Sarah Connor",
        confidence: "medium",
        explanation: "The user is clarifying which Sarah they meant."
      };
    },
    reconcileEntityAliasCandidate: async (request) => {
      aliasMutations.push(request);
      return {
        acceptedAlias: request.aliasCandidate,
        rejectionReason: null
      };
    }
  });

  try {
    const reply = await manager.handleMessage(
      {
        ...buildMessageAt("I mean Sarah Connor, not Sarah Lee.", receivedAt),
        username: "agentowner"
      },
      async () => {
        throw new Error("executeTask should not run for bounded entity-alias clarification chat");
      },
      async () => {}
    );
    assert.equal(reply, "Okay.");
    assert.equal(interpretationCalls, 1);
    assert.equal(aliasMutations.length, 1);
    assert.deepEqual(aliasMutations[0], {
      entityKey: "entity_sarah",
      aliasCandidate: "Sarah Connor",
      observedAt: receivedAt,
      evidenceRef:
        "conversation.entity_alias_interpretation:telegram:chat-1:user-1:2026-03-21T09:00:10.000Z:entity_sarah"
    });

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    assert.equal(session?.queuedJobs.length, 0);
    assert.equal(session?.runningJobId, null);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager preserves browser workflow continuity through build, edit, chat, and close sequence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-browser-sequence-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {
    heartbeatIntervalMs: 10,
    ackDelayMs: 1,
    maxRecentJobs: 20,
    staleRunningJobRecoveryMs: 60_000,
    maxConversationTurns: 40,
    maxContextTurnsForExecution: 10
  }, {
    runDirectConversationTurn: async (input) => {
      if (/Current user request:\nWho are you\?/i.test(input)) {
        return { summary: "I'm BigBrain." };
      }
      throw new Error(`Unexpected direct conversation input: ${input}`);
    }
  });
  const notifications: string[] = [];
  const executedInputs: string[] = [];
  const workspaceRootPath = "C:\\Users\\testuser\\Desktop\\drone-company";
  const artifactPath = `${workspaceRootPath}\\index.html`;
  const previewUrl = "http://127.0.0.1:4173/index.html";
  const browserSessionId = "browser_session:drone-company";
  const previewLeaseId = "proc_preview_drone_company";

  try {
    const buildReply = await manager.handleMessage(
      buildMessageAt(
        "Execute now and build a landing page for air drones, save it in drone-company on my desktop, and leave it open for me.",
        "2026-03-20T17:47:00.000Z"
      ),
      async (input) => {
        executedInputs.push(input);
        return {
          summary: "I built the landing page and left the preview open for you.",
          taskRunResult: buildTaskRunResult(input, "I built the landing page and left the preview open for you.", [
            buildApprovedWriteFileActionResult("action_write_file_build", artifactPath),
            buildApprovedOpenBrowserActionResult(
              "action_open_browser_build",
              browserSessionId,
              previewUrl,
              workspaceRootPath,
              previewLeaseId
            )
          ])
        };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.match(buildReply, /On it\./i);

    await waitForAsync(async () => {
      const session = await store.getSession("telegram:chat-1:user-1");
      return session?.activeWorkspace?.browserSessionStatus === "open";
    }, 120_000);

    const afterBuild = await store.getSession("telegram:chat-1:user-1");
    assert.ok(afterBuild);
    assert.equal(afterBuild?.activeWorkspace?.rootPath, workspaceRootPath);
    assert.equal(afterBuild?.activeWorkspace?.browserSessionStatus, "open");
    assert.equal(afterBuild?.browserSessions[0]?.status, "open");

    const editReply = await manager.handleMessage(
      buildMessageAt("Change the hero section to a slider.", "2026-03-20T17:47:10.000Z"),
      async (input) => {
        executedInputs.push(input);
        return {
          summary: "I updated the hero section to a slider and kept the preview open.",
          taskRunResult: buildTaskRunResult(input, "I updated the hero section to a slider and kept the preview open.", [
            buildApprovedWriteFileActionResult("action_write_file_edit", artifactPath)
          ])
        };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.match(editReply, /On it\./i);

    await waitFor(
      () => notifications.some((message) => /hero section to a slider/i.test(message)),
      120_000
    );

    const afterEdit = await store.getSession("telegram:chat-1:user-1");
    assert.ok(afterEdit);
    assert.equal(afterEdit?.activeWorkspace?.browserSessionStatus, "open");
    assert.equal(afterEdit?.browserSessions[0]?.status, "open");

    const executedBeforeChat = executedInputs.length;
    const chatReply = await manager.handleMessage(
      buildMessageAt("Who are you?", "2026-03-20T17:47:20.000Z"),
      async () => {
        throw new Error("executeTask should not run for direct chat in workflow continuity");
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.equal(chatReply, "I'm BigBrain.");
    assert.equal(executedInputs.length, executedBeforeChat);

    const afterChat = await store.getSession("telegram:chat-1:user-1");
    assert.ok(afterChat);
    assert.equal(afterChat?.activeWorkspace?.browserSessionStatus, "open");
    assert.equal(afterChat?.browserSessions[0]?.status, "open");

    const closeReply = await manager.handleMessage(
      buildMessageAt("Close the landing page browser now.", "2026-03-20T17:47:30.000Z"),
      async (input) => {
        executedInputs.push(input);
        return {
          summary: "I closed the landing page preview.",
          taskRunResult: buildTaskRunResult(input, "I closed the landing page preview.", [
            buildApprovedCloseBrowserActionResult(
              "action_close_browser",
              browserSessionId,
              previewUrl,
              workspaceRootPath,
              previewLeaseId
            )
          ])
        };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.match(closeReply, /On it\./i);

    await waitForAsync(async () => {
      const session = await store.getSession("telegram:chat-1:user-1");
      return session?.activeWorkspace?.browserSessionStatus === "closed";
    }, 120_000);

    const afterClose = await store.getSession("telegram:chat-1:user-1");
    assert.ok(afterClose);
    assert.equal(afterClose?.activeWorkspace?.browserSessionStatus, "closed");
    assert.ok(
      afterClose?.activeWorkspace?.ownershipState === "stale" ||
      afterClose?.activeWorkspace?.ownershipState === "orphaned"
    );
    assert.equal(afterClose?.browserSessions[0]?.status, "closed");
    assert.equal(executedInputs.length, 3);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager preserves browser workflow continuity through multi-paragraph chat and unrelated Desktop organization", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-browser-multiparagraph-sequence-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {
    heartbeatIntervalMs: 10,
    ackDelayMs: 1,
    maxRecentJobs: 20,
    staleRunningJobRecoveryMs: 60_000,
    maxConversationTurns: 50,
    maxContextTurnsForExecution: 10
  }, {
    runDirectConversationTurn: async (input) => {
      if (/Current user request:\nBefore you change anything else, just talk with me for a minute about the tone\./i.test(input)) {
        return {
          summary:
            "The page already feels calm because the spacing gives each section room to breathe instead of pushing everything at once.\n\nIf we keep the preview open, we can make the hero more premium without losing that softer first impression."
        };
      }
      if (/Current user request:\nThanks\.\n\nBefore you close it, talk me through whether the call to action feels calmer now\./i.test(input)) {
        return {
          summary:
            "Yes, it feels calmer now because the call to action reads as an invitation instead of a push.\n\nThe softer phrasing and the open preview make it easy to judge the tone before we close the browser."
        };
      }
      throw new Error(`Unexpected direct conversation input: ${input}`);
    }
  });
  const notifications: string[] = [];
  const executedInputs: string[] = [];
  const workspaceRootPath = "C:\\Users\\testuser\\Desktop\\drone-company";
  const artifactPath = `${workspaceRootPath}\\index.html`;
  const cleanupManifestPath = "C:\\Users\\testuser\\Desktop\\drone-reference-cleanup\\manifest.txt";
  const previewUrl = "http://127.0.0.1:4173/index.html";
  const browserSessionId = "browser_session:drone-company";
  const previewLeaseId = "proc_preview_drone_company";

  try {
    const buildReply = await manager.handleMessage(
      buildMessageAt(
        "Execute now and build a landing page for air drones, save it in drone-company on my desktop, and leave it open for me.",
        "2026-03-25T23:47:00.000Z"
      ),
      async (input) => {
        executedInputs.push(input);
        return {
          summary: "I built the landing page and left the preview open for you.",
          taskRunResult: buildTaskRunResult(input, "I built the landing page and left the preview open for you.", [
            buildApprovedWriteFileActionResult("action_write_file_build_multiparagraph", artifactPath),
            buildApprovedOpenBrowserActionResult(
              "action_open_browser_build_multiparagraph",
              browserSessionId,
              previewUrl,
              workspaceRootPath,
              previewLeaseId
            )
          ])
        };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.match(buildReply, /On it\./i);

    await waitForAsync(async () => {
      const session = await store.getSession("telegram:chat-1:user-1");
      return session?.activeWorkspace?.browserSessionStatus === "open";
    }, 120_000);

    const executedBeforeFirstChat = executedInputs.length;
    const firstChatReply = await manager.handleMessage(
      buildMessageAt(
        "Before you change anything else, just talk with me for a minute about the tone.\n\nReply in two short paragraphs and keep the page open.",
        "2026-03-25T23:47:10.000Z"
      ),
      async () => {
        throw new Error("executeTask should not run for multi-paragraph chat during workflow continuity");
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.match(firstChatReply, /\n\n/);
    assert.equal(executedInputs.length, executedBeforeFirstChat);

    const afterFirstChat = await store.getSession("telegram:chat-1:user-1");
    assert.ok(afterFirstChat);
    assert.equal(afterFirstChat?.browserSessions[0]?.status, "open");

    const editReply = await manager.handleMessage(
      buildMessageAt("Change the hero section so it feels calmer and more premium.", "2026-03-25T23:47:20.000Z"),
      async (input) => {
        executedInputs.push(input);
        return {
          summary: "I updated the hero section and kept the preview open.",
          taskRunResult: buildTaskRunResult(input, "I updated the hero section and kept the preview open.", [
            buildApprovedWriteFileActionResult("action_write_file_edit_multiparagraph", artifactPath)
          ])
        };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.match(editReply, /On it\./i);
    await waitFor(
      () => notifications.some((message) => /updated the hero section/i.test(message)),
      120_000
    );

    const organizeReply = await manager.handleMessage(
      buildMessageAt(
        "While that's open, organize the loose drone reference notes on my Desktop into a folder called drone-reference-cleanup.",
        "2026-03-25T23:47:30.000Z"
      ),
      async (input) => {
        executedInputs.push(input);
        return {
          summary: "I organized the loose drone reference notes into drone-reference-cleanup on your Desktop.",
          taskRunResult: buildTaskRunResult(input, "I organized the loose drone reference notes into drone-reference-cleanup on your Desktop.", [
            buildApprovedWriteFileActionResult("action_write_file_desktop_cleanup_manifest", cleanupManifestPath)
          ])
        };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.match(organizeReply, /On it\./i);
    await waitFor(
      () => notifications.some((message) => /organized the loose drone reference notes/i.test(message)),
      120_000
    );
    assert.match(executedInputs[2] ?? "", /drone-reference-cleanup/i);

    const executedBeforeSecondChat = executedInputs.length;
    const secondChatReply = await manager.handleMessage(
      buildMessageAt(
        "Thanks.\n\nBefore you close it, talk me through whether the call to action feels calmer now.",
        "2026-03-25T23:47:40.000Z"
      ),
      async () => {
        throw new Error("executeTask should not run for the second multi-paragraph workflow conversation turn");
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.match(secondChatReply, /\n\n/);
    assert.equal(executedInputs.length, executedBeforeSecondChat);

    const afterSecondChat = await store.getSession("telegram:chat-1:user-1");
    assert.ok(afterSecondChat);
    assert.equal(
      afterSecondChat?.browserSessions.find((session) => session.id === browserSessionId)?.status,
      "open"
    );

    const closeReply = await manager.handleMessage(
      buildMessageAt("Close the landing page browser now.", "2026-03-25T23:47:50.000Z"),
      async (input) => {
        executedInputs.push(input);
        return {
          summary: "I closed the landing page preview.",
          taskRunResult: buildTaskRunResult(input, "I closed the landing page preview.", [
            buildApprovedCloseBrowserActionResult(
              "action_close_browser_multiparagraph",
              browserSessionId,
              previewUrl,
              workspaceRootPath,
              previewLeaseId
            )
          ])
        };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.match(closeReply, /On it\./i);

    await waitForAsync(async () => {
      const session = await store.getSession("telegram:chat-1:user-1");
      return session?.browserSessions.find((browserSession) => browserSession.id === browserSessionId)?.status === "closed";
    }, 120_000);
    assert.match(executedInputs[3] ?? "", /browser_session:drone-company|Close the landing page browser now/i);

    const afterClose = await store.getSession("telegram:chat-1:user-1");
    assert.ok(afterClose);
    assert.equal(
      afterClose?.browserSessions.find((session) => session.id === browserSessionId)?.status,
      "closed"
    );
    assert.equal(executedInputs.length, 4);
  } finally {
    await removeTempDirWithRetry(tempDir);
  }
});

test("conversation manager persists bounded recovery attribution for a Python workflow and surfaces it in status recall", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-conversation-python-recovery-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "sessions.json"));
  const manager = new ConversationManager(store, {
    heartbeatIntervalMs: 10,
    ackDelayMs: 1,
    maxRecentJobs: 20,
    staleRunningJobRecoveryMs: 60_000,
    maxConversationTurns: 50,
    maxContextTurnsForExecution: 10
  });
  const notifications: string[] = [];
  const workspaceRootPath = "C:\\Users\\testuser\\Desktop\\calm-drone-python";
  const artifactPath = `${workspaceRootPath}\\app.py`;
  const previewUrl = "http://127.0.0.1:5050/";
  const browserSessionId = "browser_session:calm-drone-python";
  const previewLeaseId = "proc_preview_calm_drone_python";
  const recoverySummary =
    "Recovered automatically after one bounded missing-dependency repair and retried the Python start step.";

  try {
    const reply = await manager.handleMessage(
      buildMessageAt(
        "Build now: create a small Calm Drone Python app on my Desktop and leave it running in the browser.",
        "2026-03-26T13:00:00.000Z"
      ),
      async (input, _receivedAt, onProgressUpdate) => {
        await onProgressUpdate?.({
          status: "retrying",
          message:
            "I found a missing dependency. I'm doing one bounded repair and then retrying the original step.",
          recoveryTrace: {
            kind: "structured_executor_recovery",
            status: "attempting",
            summary:
              "I found a missing dependency. I'm doing one bounded repair and then retrying the original step.",
            updatedAt: "2026-03-26T13:00:01.000Z",
            recoveryClass: "DEPENDENCY_MISSING",
            fingerprint: "dep-missing-calm-drone-python"
          }
        });
        await onProgressUpdate?.({
          status: "completed",
          message: "The Python app is running and the browser is open for review.",
          recoveryTrace: {
            kind: "structured_executor_recovery",
            status: "recovered",
            summary: recoverySummary,
            updatedAt: "2026-03-26T13:00:02.000Z",
            recoveryClass: "DEPENDENCY_MISSING",
            fingerprint: "dep-missing-calm-drone-python"
          }
        });
        return {
          summary: "I started the Calm Drone Python app and left it open in the browser.",
          taskRunResult: buildTaskRunResult(
            input,
            "I started the Calm Drone Python app and left it open in the browser.",
            [
              buildApprovedWriteFileActionResult("action_write_python_app", artifactPath),
              buildApprovedRunningShellActionResult(
                "action_start_python_app",
                workspaceRootPath,
                previewUrl,
                previewLeaseId
              ),
              buildApprovedOpenBrowserActionResult(
                "action_open_python_browser",
                browserSessionId,
                previewUrl,
                workspaceRootPath,
                previewLeaseId
              )
            ]
          )
        };
      },
      async (message) => {
        notifications.push(message);
      }
    );
    assert.match(reply, /On it\./i);

    await waitFor(
      () => notifications.some((message) => /Calm Drone Python app/i.test(message)),
      120_000
    );

    const session = await store.getSession("telegram:chat-1:user-1");
    assert.ok(session);
    assert.equal(session?.progressState?.status, "completed");
    assert.equal(session?.progressState?.recoveryTrace?.status, "recovered");
    assert.equal(
      session?.recentJobs[0]?.recoveryTrace?.recoveryClass,
      "DEPENDENCY_MISSING"
    );
    assert.equal(session?.recentJobs[0]?.recoveryTrace?.status, "recovered");

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
  const session = buildConversationSessionFixture(
    {
      updatedAt: recentEmission,
      agentPulse: {
        ...buildConversationSessionFixture().agentPulse,
        optIn: true,
        recentEmissions: [
          {
            emittedAt: recentEmission,
            reasonCode: "OPEN_LOOP_RESUME" as const,
            candidateEntityRefs: ["entity-project"]
          }
        ]
      }
    },
    {
      conversationId: "chat-1",
      receivedAt: recentEmission
    }
  );
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

  const session = buildConversationSessionFixture(
    {
      updatedAt: new Date().toISOString(),
      agentPulse: {
        ...buildConversationSessionFixture().agentPulse,
        optIn: false,
        recentEmissions: []
      }
    },
    {
      conversationId: "chat-1",
      receivedAt: new Date().toISOString()
    }
  );
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
