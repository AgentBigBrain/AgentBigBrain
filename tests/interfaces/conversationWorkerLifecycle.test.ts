/**
 * @fileoverview Tests deterministic queue-worker lifecycle helpers extracted from conversationManager.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

function lastItem<TItem>(items: readonly TItem[]): TItem | undefined {
  return items[items.length - 1];
}

import type { TaskRunResult } from "../../src/core/types";
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
import { buildAutonomousConversationExecutionResult } from "../../src/interfaces/autonomousConversationExecutionResult";
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

test("markQueuedJobRunning seeds human-first progress text instead of echoing the raw request", () => {
  const nowIso = "2026-03-15T21:00:00.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-worker-progress-text",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  const job: ConversationJob = {
    ...buildQueuedJob(nowIso),
    input: "Every folder with the name beginning in drone-company should go in drone-folder on my desktop.",
    executionInput:
      "[AUTONOMOUS_LOOP_GOAL] Every folder with the name beginning in drone-company should go in drone-folder on my desktop."
  };

  markQueuedJobRunning({
    session,
    job,
    ackDelayMs: 1_200,
    maxRecentJobs: 20
  });

  assert.equal(
    session.progressState?.message,
    "I'm organizing the project folders and checking what can be moved safely."
  );
  assert.equal(session.progressState?.status, "working");
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
    sessionKey: "session-test",
    job,
    executeTask: async () => ({ summary: "Completed successfully." }),
    notify,
    heartbeatIntervalMs: 5,
    suppressHeartbeat: true,
    onExecutionSettled: () => {
      cleanupCalls += 1;
    }
  });

  assert.equal(
    (
      await executeRunningJob({
    sessionKey: "session-test",
        job: {
          ...job,
          id: "job-2",
          status: "running",
          startedAt: nowIso,
          resultSummary: null,
          errorMessage: null
        },
        executeTask: async () => ({ summary: "Completed successfully." }),
        notify,
        heartbeatIntervalMs: 5,
        suppressHeartbeat: true,
        onExecutionSettled: () => undefined
      })
    )?.summary,
    "Completed successfully."
  );
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

  const result = await executeRunningJob({
    sessionKey: "session-test",
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

  assert.equal(result, null);
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
    sessionKey: "session-test",
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

test("executeRunningJob forwards structured progress updates from the execution runtime", async () => {
  const nowIso = "2026-03-03T00:00:00.000Z";
  const job = buildQueuedJob(nowIso);
  job.status = "running";
  job.startedAt = nowIso;

  const progressUpdates: Array<{ status: string; message: string }> = [];
  await executeRunningJob({
    sessionKey: "session-test",
    job,
    executeTask: async (_input, _receivedAt, onProgressUpdate) => {
      await onProgressUpdate?.({
        status: "retrying",
        message: "Retrying with exact tracked holder shutdown."
      });
      await onProgressUpdate?.({
        status: "verifying",
        message: "Verifying the local preview before finishing."
      });
      return { summary: "Completed successfully." };
    },
    notify: {
      capabilities: { supportsEdit: false, supportsNativeStreaming: false },
      send: async () => ({ ok: true, messageId: "hb-1", errorCode: null })
    },
    heartbeatIntervalMs: 5,
    suppressHeartbeat: true,
    onProgressUpdate: async (update) => {
      progressUpdates.push(update);
    },
    onExecutionSettled: () => undefined
  });

  assert.deepEqual(progressUpdates, [
    {
      status: "retrying",
      message: "Retrying with exact tracked holder shutdown."
    },
    {
      status: "verifying",
      message: "Verifying the local preview before finishing."
    }
  ]);
});

test("persistExecutedJobOutcome turns a paused autonomous run into a waiting checkpoint", () => {
  const nowIso = "2026-03-03T00:00:00.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.progressState = {
    status: "stopped",
    message: "stopping here and keeping the latest checkpoint ready so you can pick it back up later",
    jobId: null,
    updatedAt: "2026-03-03T00:00:01.000Z"
  };
  session.activeWorkspace = {
    id: "workspace:drone-company",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
    previewUrl: "http://127.0.0.1:4177/index.html",
    browserSessionId: "browser-1",
    browserSessionIds: ["browser-1"],
    browserSessionStatus: "open",
    browserProcessPid: 999,
    previewProcessLeaseId: "lease-1",
    previewProcessLeaseIds: ["lease-1"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
    lastKnownPreviewProcessPid: 1234,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_and_preview",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
    sourceJobId: "job-1",
    updatedAt: "2026-03-03T00:00:01.000Z"
  };

  const job: ConversationJob = {
    ...buildQueuedJob(nowIso),
    status: "completed",
    startedAt: "2026-03-03T00:00:01.000Z",
    completedAt: "2026-03-03T00:00:10.000Z",
    resultSummary: "Autonomous task stopped after 1 iteration(s). 3 approved, 0 blocked. Why it stopped: Stopped because you cancelled the run.",
    pauseRequestedAt: "2026-03-03T00:00:05.000Z"
  };

  persistExecutedJobOutcome({
    session,
    executedJob: job,
    executionResult: { summary: job.resultSummary ?? "" },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 20
  });

  assert.deepEqual(session.progressState, {
    status: "waiting_for_user",
    message: "pick this back up when you're ready, and I'll continue from the saved checkpoint",
    jobId: "job-1",
    updatedAt: session.updatedAt
  });
  assert.equal(session.returnHandoff?.status, "waiting_for_user");
  assert.equal(
    session.returnHandoff?.nextSuggestedStep,
    "pick this back up when you're ready, and I'll continue from the saved checkpoint"
  );
  assert.equal(session.returnHandoff?.workspaceRootPath, "C:\\Users\\testuser\\Desktop\\drone-company");
  assert.equal(session.domainContext.dominantLane, "workflow");
  assert.equal(session.domainContext.continuitySignals.activeWorkspace, true);
  assert.equal(session.domainContext.continuitySignals.returnHandoff, true);
  assert.equal(lastItem(session.domainContext.recentLaneHistory)?.lane, "workflow");
  assert.equal(lastItem(session.domainContext.recentLaneHistory)?.source, "continuity_state");
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
    executionResult: {
      summary: "All set.",
      taskRunResult: {
        task: {
          id: "task-1",
          goal: "Create a file and leave the app open.",
          userInput: "Create a file and leave the app open.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-1",
          plannerNotes: "stub",
          actions: [
            {
              id: "action-1",
              type: "write_file",
              description: "write file",
              params: {},
              estimatedCostUsd: 0.01
            },
            {
              id: "action-2",
              type: "verify_browser",
              description: "verify browser",
              params: {},
              estimatedCostUsd: 0.01
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-1",
              type: "write_file",
              description: "write file",
              params: {},
              estimatedCostUsd: 0.01
            },
            mode: "fast_path",
            approved: true,
            output: "Wrote landing page.",
            executionStatus: "success",
            blockedBy: [],
            violations: [],
            votes: [],
            executionMetadata: {
              writeFilePath: "C:\\Users\\testuser\\Desktop\\123\\index.html",
              filePath: "C:\\Users\\testuser\\Desktop\\123\\index.html"
            }
          },
          {
            action: {
              id: "action-2",
              type: "verify_browser",
              description: "verify browser",
              params: {},
              estimatedCostUsd: 0.01
            },
            mode: "fast_path",
            approved: true,
            output: "Verified browser.",
            executionStatus: "success",
            blockedBy: [],
            violations: [],
            votes: [],
            executionMetadata: {
              browserVerifyUrl: "http://localhost:3000"
            }
          }
        ],
        summary: "All set.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(session.runningJobId, null);
  assert.equal(persisted.status, "completed");
  assert.equal(persisted.resultSummary, "All set.");
  assert.equal(session.recentJobs[0]?.id, "job-1");
  assert.equal(session.progressState, null);
  assert.ok(
    session.recentActions.some(
      (action) => action.location === "C:\\Users\\testuser\\Desktop\\123\\index.html"
    )
  );
  assert.ok(
    session.pathDestinations.some(
      (destination) =>
        destination.resolvedPath === "C:\\Users\\testuser\\Desktop\\123\\index.html"
    )
  );
  assert.equal(session.activeWorkspace?.rootPath, "C:\\Users\\testuser\\Desktop\\123");
  assert.equal(
    session.activeWorkspace?.primaryArtifactPath,
    "C:\\Users\\testuser\\Desktop\\123\\index.html"
  );
  assert.deepEqual(session.activeWorkspace?.lastChangedPaths, [
    "C:\\Users\\testuser\\Desktop\\123\\index.html"
  ]);
  assert.equal(session.returnHandoff?.status, "completed");
  assert.equal(session.returnHandoff?.workspaceRootPath, "C:\\Users\\testuser\\Desktop\\123");
  assert.equal(session.returnHandoff?.summary, "All set.");
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.role,
    "assistant"
  );
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    "All set."
  );
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

test("persistExecutedJobOutcome promotes scaffold shell workspace roots into active workspace continuity", () => {
  const nowIso = "2026-03-27T03:10:00.000Z";
  const completedAt = "2026-03-27T03:10:05.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-shell-workspace-root",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-shell-workspace-root";
  const runningJob: ConversationJob = {
    ...buildQueuedJob(nowIso),
    id: "job-shell-workspace-root",
    status: "running",
    startedAt: nowIso
  };
  session.recentJobs = [runningJob];

  persistExecutedJobOutcome({
    session,
    executedJob: {
      ...runningJob,
      status: "completed",
      completedAt,
      resultSummary:
        "Autonomous task completed after 1 iteration(s). I finished the goal with 2 approved action(s) and 0 blocked.",
      errorMessage: null
    },
    executionResult: {
      summary:
        "Autonomous task completed after 1 iteration(s). I finished the goal with 2 approved action(s) and 0 blocked.",
      taskRunResult: {
        task: {
          id: "task-shell-workspace-root",
          goal: "Create the React workspace and stop after install.",
          userInput: "Create the React workspace and stop after install.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-shell-workspace-root",
          plannerNotes: "Scaffold and install.",
          actions: [
            {
              id: "action-shell-scaffold",
              type: "shell_command",
              description: "Scaffold the workspace.",
              params: {
                command: "npm create vite@latest Drone Preview App -- --template react",
                cwd: "C:\\Users\\testuser\\Desktop"
              },
              estimatedCostUsd: 0.2
            },
            {
              id: "action-shell-install",
              type: "shell_command",
              description: "Install dependencies.",
              params: {
                command: "npm install",
                cwd: "C:\\Users\\testuser\\Desktop\\Drone Preview App"
              },
              estimatedCostUsd: 0.2
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-shell-scaffold",
              type: "shell_command",
              description: "Scaffold the workspace.",
              params: {
                command: "npm create vite@latest Drone Preview App -- --template react",
                cwd: "C:\\Users\\testuser\\Desktop"
              },
              estimatedCostUsd: 0.2
            },
            mode: "escalation_path",
            approved: true,
            output: "Shell success: scaffolded the React app.",
            executionStatus: "success",
            blockedBy: [],
            violations: [],
            votes: [],
            executionMetadata: {
              directoryPath: "C:\\Users\\testuser\\Desktop\\Drone Preview App"
            }
          },
          {
            action: {
              id: "action-shell-install",
              type: "shell_command",
              description: "Install dependencies.",
              params: {
                command: "npm install",
                cwd: "C:\\Users\\testuser\\Desktop\\Drone Preview App"
              },
              estimatedCostUsd: 0.2
            },
            mode: "escalation_path",
            approved: true,
            output: "Shell success: installed dependencies.",
            executionStatus: "success",
            blockedBy: [],
            violations: [],
            votes: [],
            executionMetadata: {
              directoryPath: "C:\\Users\\testuser\\Desktop\\Drone Preview App"
            }
          }
        ],
        summary:
          "Autonomous task completed after 1 iteration(s). I finished the goal with 2 approved action(s) and 0 blocked.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(session.activeWorkspace?.rootPath, "C:\\Users\\testuser\\Desktop\\Drone Preview App");
  assert.equal(session.activeWorkspace?.primaryArtifactPath, null);
  assert.equal(session.activeWorkspace?.previewUrl, null);
  assert.equal(session.activeWorkspace?.ownershipState, "stale");
  assert.ok(
    session.pathDestinations.some(
      (destination) =>
        destination.resolvedPath === "C:\\Users\\testuser\\Desktop\\Drone Preview App"
    )
  );
  assert.equal(session.returnHandoff?.workspaceRootPath, "C:\\Users\\testuser\\Desktop\\Drone Preview App");
});

test("persistExecutedJobOutcome reanchors primary artifact and changed paths when a no-write relaunch switches to an older workspace", () => {
  const nowIso = "2026-04-11T11:56:10.000Z";
  const completedAt = "2026-04-11T11:56:20.864Z";
  const detroitThreeRoot = "C:\\Users\\testuser\\Desktop\\Detroit City Three";
  const detroitTwoRoot = "C:\\Users\\testuser\\Desktop\\Detroit City Two";
  const detroitTwoPagePath = `${detroitTwoRoot}\\app\\page.js`;
  const detroitTwoStylesPath = `${detroitTwoRoot}\\app\\globals.css`;
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-detroit-two-relaunch",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-detroit-two-relaunch";
  session.activeWorkspace = {
    id: "workspace:detroit-three",
    label: "Current project workspace",
    rootPath: detroitThreeRoot,
    primaryArtifactPath: `${detroitThreeRoot}\\app\\globals.css`,
    previewUrl: "http://127.0.0.1:56895/",
    browserSessionId: "browser_session:detroit_three",
    browserSessionIds: ["browser_session:detroit_three"],
    browserSessionStatus: "closed",
    browserProcessPid: 5484,
    previewProcessLeaseId: "proc_detroit_three",
    previewProcessLeaseIds: ["proc_detroit_three"],
    previewProcessCwd: detroitThreeRoot,
    lastKnownPreviewProcessPid: 43228,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: [
      `${detroitThreeRoot}\\app\\globals.css`,
      `${detroitThreeRoot}\\app\\page.js`
    ],
    sourceJobId: "job-detroit-three-build",
    updatedAt: "2026-04-11T11:40:10.105Z"
  };
  session.recentActions = [
    {
      id: "job-detroit-two-build:file:page",
      kind: "file",
      label: "page.js",
      location: detroitTwoPagePath,
      status: "updated",
      sourceJobId: "job-detroit-two-build",
      at: "2026-04-11T11:20:00.000Z",
      summary: "Updated the Detroit City Two page."
    },
    {
      id: "job-detroit-two-build:file:globals",
      kind: "file",
      label: "globals.css",
      location: detroitTwoStylesPath,
      status: "updated",
      sourceJobId: "job-detroit-two-build",
      at: "2026-04-11T11:19:59.000Z",
      summary: "Updated the Detroit City Two stylesheet."
    },
    {
      id: "job-detroit-three-build:file:globals",
      kind: "file",
      label: "globals.css",
      location: `${detroitThreeRoot}\\app\\globals.css`,
      status: "updated",
      sourceJobId: "job-detroit-three-build",
      at: "2026-04-11T11:19:58.000Z",
      summary: "Updated the Detroit City Three stylesheet."
    }
  ];
  const runningJob: ConversationJob = {
    ...buildQueuedJob(nowIso),
    id: "job-detroit-two-relaunch",
    input: 'Start up "Detroit City Two" on the desktop and put it up in the browser for me.',
    executionInput:
      'Start up "Detroit City Two" on the desktop and put it up in the browser for me.',
    status: "running",
    startedAt: nowIso
  };
  session.recentJobs = [runningJob];

  persistExecutedJobOutcome({
    session,
    executedJob: {
      ...runningJob,
      status: "completed",
      completedAt,
      resultSummary:
        "Autonomous task completed after 1 iteration(s). I finished the goal with 3 approved action(s) and 2 blocked.",
      errorMessage: null
    },
    executionResult: {
      summary:
        "Autonomous task completed after 1 iteration(s). I finished the goal with 3 approved action(s) and 2 blocked.",
      taskRunResult: {
        task: {
          id: "task-detroit-two-relaunch",
          goal: 'Start up "Detroit City Two" on the desktop and put it up in the browser for me.',
          userInput: 'Start up "Detroit City Two" on the desktop and put it up in the browser for me.',
          createdAt: nowIso
        },
        plan: {
          taskId: "task-detroit-two-relaunch",
          plannerNotes: "Launch the existing project without rewriting files.",
          actions: [
            {
              id: "action-start",
              type: "start_process",
              description: "Start Detroit City Two.",
              params: {
                command: "npm run dev -- --hostname 127.0.0.1 --port 3000",
                cwd: detroitTwoRoot
              },
              estimatedCostUsd: 0.2
            },
            {
              id: "action-open",
              type: "open_browser",
              description: "Open the Detroit City Two preview.",
              params: {
                url: "http://127.0.0.1:3000/",
                rootPath: detroitTwoRoot,
                previewProcessLeaseId: "proc_detroit_two_relaunch"
              },
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-start",
              type: "start_process",
              description: "Start Detroit City Two.",
              params: {
                command: "npm run dev -- --hostname 127.0.0.1 --port 3000",
                cwd: detroitTwoRoot
              },
              estimatedCostUsd: 0.2
            },
            mode: "fast_path",
            approved: true,
            output: "Process started.",
            executionStatus: "success",
            blockedBy: [],
            violations: [],
            votes: [],
            executionMetadata: {
              processCwd: detroitTwoRoot,
              processLeaseId: "proc_detroit_two_relaunch",
              processLifecycleStatus: "PROCESS_STARTED",
              processPid: 41308
            }
          },
          {
            action: {
              id: "action-open",
              type: "open_browser",
              description: "Open the Detroit City Two preview.",
              params: {
                url: "http://127.0.0.1:3000/",
                rootPath: detroitTwoRoot,
                previewProcessLeaseId: "proc_detroit_two_relaunch"
              },
              estimatedCostUsd: 0.03
            },
            mode: "fast_path",
            approved: true,
            output: "Opened the preview.",
            executionStatus: "success",
            blockedBy: [],
            violations: [],
            votes: [],
            executionMetadata: {
              browserSessionId: "browser_session:detroit_two_relaunch",
              browserSessionUrl: "http://127.0.0.1:3000/",
              browserSessionStatus: "open",
              browserSessionVisibility: "visible",
              browserSessionControllerKind: "playwright_managed",
              browserSessionControlAvailable: true,
              browserSessionBrowserProcessPid: 3908,
              browserSessionWorkspaceRootPath: detroitTwoRoot,
              browserSessionLinkedProcessLeaseId: "proc_detroit_two_relaunch",
              browserSessionLinkedProcessCwd: detroitTwoRoot,
              browserSessionLinkedProcessPid: 41308
            }
          }
        ],
        summary:
          "Autonomous task completed after 1 iteration(s). I finished the goal with 3 approved action(s) and 2 blocked.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(session.activeWorkspace?.rootPath, detroitTwoRoot);
  assert.equal(session.activeWorkspace?.primaryArtifactPath, detroitTwoPagePath);
  assert.deepEqual(session.activeWorkspace?.lastChangedPaths, [
    detroitTwoPagePath,
    detroitTwoStylesPath
  ]);
  assert.equal(session.returnHandoff?.workspaceRootPath, detroitTwoRoot);
  assert.equal(session.returnHandoff?.primaryArtifactPath, detroitTwoPagePath);
  assert.deepEqual(session.returnHandoff?.changedPaths, [
    detroitTwoPagePath,
    detroitTwoStylesPath
  ]);
});

test("persistExecutedJobOutcome discovers a stable primary artifact from the relaunched workspace root when prior file ledgers aged out", () => {
  const nowIso = "2026-04-11T13:55:50.000Z";
  const completedAt = "2026-04-11T13:56:00.326Z";
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "abb-detroit-two-relaunch-"));
  const detroitTwoRoot = path.join(tempRoot, "Detroit City Two");
  const detroitTwoAppRoot = path.join(detroitTwoRoot, "app");
  const detroitTwoPagePath = path.join(detroitTwoAppRoot, "page.js");
  const detroitTwoStylesPath = path.join(detroitTwoAppRoot, "globals.css");

  mkdirSync(detroitTwoAppRoot, { recursive: true });
  writeFileSync(detroitTwoPagePath, "export default function Page() { return null; }\n", "utf8");
  writeFileSync(detroitTwoStylesPath, ":root { color: #111; }\n", "utf8");

  try {
    const session = buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-detroit-two-relaunch-pruned-ledgers",
      userId: "user-1",
      username: "owner",
      conversationVisibility: "private",
      receivedAt: nowIso
    });
    const runningJob: ConversationJob = {
      ...buildQueuedJob(nowIso),
      id: "job-detroit-two-relaunch-pruned-ledgers",
      input: 'Now I want to switch to "Detroit City Two" and open it in the browser again.',
      executionInput:
        'Now I want to switch to "Detroit City Two" and open it in the browser again.',
      status: "running",
      startedAt: nowIso
    };

    session.runningJobId = runningJob.id;
    session.recentJobs = [runningJob];
    session.activeWorkspace = {
      id: "workspace:detroit-three",
      label: "Current project workspace",
      rootPath: path.join(tempRoot, "Detroit City Three"),
      primaryArtifactPath: path.join(tempRoot, "Detroit City Three", "app", "globals.css"),
      previewUrl: "http://localhost:54611/",
      browserSessionId: "browser_session:detroit_three",
      browserSessionIds: ["browser_session:detroit_three"],
      browserSessionStatus: "closed",
      browserProcessPid: 50672,
      previewProcessLeaseId: "proc_detroit_three",
      previewProcessLeaseIds: ["proc_detroit_three"],
      previewProcessCwd: path.join(tempRoot, "Detroit City Three"),
      lastKnownPreviewProcessPid: 49068,
      stillControllable: false,
      ownershipState: "stale",
      previewStackState: "detached",
      lastChangedPaths: [
        path.join(tempRoot, "Detroit City Three", "app", "globals.css")
      ],
      sourceJobId: "job-detroit-three-build",
      updatedAt: "2026-04-11T13:54:51.463Z"
    };
    session.pathDestinations = [
      {
        id: "path:process:detroit-two",
        label: "Process working folder",
        resolvedPath: detroitTwoRoot,
        sourceJobId: runningJob.id,
        updatedAt: completedAt,
        at: completedAt
      }
    ];

    persistExecutedJobOutcome({
      session,
      executedJob: {
        ...runningJob,
        status: "completed",
        completedAt,
        resultSummary:
          "Autonomous task completed after 2 iteration(s). I finished the goal with 3 approved action(s) and 3 blocked.",
        errorMessage: null
      },
      executionResult: {
        summary:
          "Autonomous task completed after 2 iteration(s). I finished the goal with 3 approved action(s) and 3 blocked.",
        taskRunResult: {
          task: {
            id: "task-detroit-two-relaunch-pruned-ledgers",
            goal: 'Launch "Detroit City Two" from the desktop and open it in the browser.',
            userInput:
              'Launch "Detroit City Two" from the desktop and open it in the browser.',
            createdAt: nowIso
          },
          plan: {
            taskId: "task-detroit-two-relaunch-pruned-ledgers",
            plannerNotes: "Relaunch the existing project without rewriting files.",
            actions: [
              {
                id: "action-start",
                type: "start_process",
                description: "Start Detroit City Two.",
                params: {
                  command: "npm run dev -- --hostname 127.0.0.1 --port 3000",
                  cwd: detroitTwoRoot
                },
                estimatedCostUsd: 0.2
              },
              {
                id: "action-open",
                type: "open_browser",
                description: "Open the Detroit City Two preview.",
                params: {
                  url: "http://localhost:50312/",
                  rootPath: detroitTwoRoot,
                  previewProcessLeaseId: "proc_detroit_two_relaunch"
                },
                estimatedCostUsd: 0.03
              }
            ]
          },
          actionResults: [
            {
              action: {
                id: "action-start",
                type: "start_process",
                description: "Start Detroit City Two.",
                params: {
                  command: "npm run dev -- --hostname 127.0.0.1 --port 3000",
                  cwd: detroitTwoRoot
                },
                estimatedCostUsd: 0.2
              },
              mode: "fast_path",
              approved: true,
              output: "Process started.",
              executionStatus: "success",
              blockedBy: [],
              violations: [],
              votes: [],
              executionMetadata: {
                processCwd: detroitTwoRoot,
                processLeaseId: "proc_detroit_two_relaunch",
                processLifecycleStatus: "PROCESS_STARTED",
                processPid: 41308
              }
            },
            {
              action: {
                id: "action-open",
                type: "open_browser",
                description: "Open the Detroit City Two preview.",
                params: {
                  url: "http://localhost:50312/",
                  rootPath: detroitTwoRoot,
                  previewProcessLeaseId: "proc_detroit_two_relaunch"
                },
                estimatedCostUsd: 0.03
              },
              mode: "fast_path",
              approved: true,
              output: "Opened the preview.",
              executionStatus: "success",
              blockedBy: [],
              violations: [],
              votes: [],
              executionMetadata: {
                browserSessionId: "browser_session:detroit_two_relaunch",
                browserSessionUrl: "http://localhost:50312/",
                browserSessionStatus: "open",
                browserSessionVisibility: "visible",
                browserSessionControllerKind: "playwright_managed",
                browserSessionControlAvailable: true,
                browserSessionBrowserProcessPid: 3908,
                browserSessionWorkspaceRootPath: detroitTwoRoot,
                browserSessionLinkedProcessLeaseId: "proc_detroit_two_relaunch",
                browserSessionLinkedProcessCwd: detroitTwoRoot,
                browserSessionLinkedProcessPid: 41308
              }
            }
          ],
          summary:
            "Autonomous task completed after 2 iteration(s). I finished the goal with 3 approved action(s) and 3 blocked.",
          startedAt: nowIso,
          completedAt
        }
      },
      maxRecentJobs: 20,
      maxRecentActions: 12,
      maxBrowserSessions: 6,
      maxPathDestinations: 8,
      maxConversationTurns: 40
    });

    assert.equal(session.activeWorkspace?.rootPath, detroitTwoRoot);
    assert.equal(session.activeWorkspace?.primaryArtifactPath, detroitTwoPagePath);
    assert.deepEqual(session.activeWorkspace?.lastChangedPaths, [
      detroitTwoPagePath,
      detroitTwoStylesPath
    ]);
    assert.equal(session.returnHandoff?.workspaceRootPath, detroitTwoRoot);
    assert.equal(session.returnHandoff?.primaryArtifactPath, detroitTwoPagePath);
    assert.deepEqual(session.returnHandoff?.changedPaths, [
      detroitTwoPagePath,
      detroitTwoStylesPath
    ]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("persistExecutedJobOutcome retains every live preview lease for the current workspace when the browser session links only the newest one", () => {
  const nowIso = "2026-03-18T11:15:50.157Z";
  const completedAt = "2026-03-18T11:16:56.905Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-multi-preview-leases",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  const job: ConversationJob = {
    ...buildQueuedJob(nowIso),
    id: "job-open-preview",
    input: "Reuse AI Drone City, open the preview, and leave it open.",
    executionInput: "Reuse AI Drone City, open the preview, and leave it open.",
    startedAt: nowIso,
    status: "running",
    ackEligibleAt: nowIso
  };

  persistExecutedJobOutcome({
    session,
    executedJob: {
      ...job,
      status: "completed",
      completedAt,
      resultSummary: "Opened the AI Drone City preview and left it open.",
      errorMessage: null
    },
    executionResult: {
      summary: "Opened the AI Drone City preview and left it open.",
      taskRunResult: {
        task: {
          id: "task-open-preview",
          goal: "Open the AI Drone City preview and leave it open.",
          userInput: "Reuse AI Drone City, open the preview, and leave it open.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-open-preview",
          plannerNotes: "Start the repaired preview and keep it open.",
          actions: [
            {
              id: "action-start-preview-old",
              type: "start_process",
              description: "Start the earlier preview attempt.",
              params: {
                command: "npm run preview -- --host 127.0.0.1 --port 4173",
                cwd: "C:\\Users\\testuser\\Desktop\\AI Drone City"
              },
              estimatedCostUsd: 0.08
            },
            {
              id: "action-start-preview-new",
              type: "start_process",
              description: "Restart the preview with the repaired workspace.",
              params: {
                command: "npm run preview -- --host 127.0.0.1 --port 4173",
                cwd: "C:\\Users\\testuser\\Desktop\\AI Drone City"
              },
              estimatedCostUsd: 0.08
            },
            {
              id: "action-open-browser",
              type: "open_browser",
              description: "Open the running preview in a browser window.",
              params: {
                url: "http://127.0.0.1:4173/",
                rootPath: "C:\\Users\\testuser\\Desktop\\AI Drone City"
              },
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-start-preview-old",
              type: "start_process",
              description: "Start the earlier preview attempt.",
              params: {
                command: "npm run preview -- --host 127.0.0.1 --port 4173",
                cwd: "C:\\Users\\testuser\\Desktop\\AI Drone City"
              },
              estimatedCostUsd: 0.08
            },
            mode: "escalation_path",
            approved: true,
            output: "Process started: lease proc_preview_1.",
            executionStatus: "success",
            executionMetadata: {
              processLeaseId: "proc_preview_1",
              processLifecycleStatus: "PROCESS_STARTED",
              processCwd: "C:\\Users\\testuser\\Desktop\\AI Drone City",
              processPid: 43125
            },
            blockedBy: [],
            violations: [],
            votes: []
          },
          {
            action: {
              id: "action-start-preview-new",
              type: "start_process",
              description: "Restart the preview with the repaired workspace.",
              params: {
                command: "npm run preview -- --host 127.0.0.1 --port 4173",
                cwd: "C:\\Users\\testuser\\Desktop\\AI Drone City"
              },
              estimatedCostUsd: 0.08
            },
            mode: "escalation_path",
            approved: true,
            output: "Process started: lease proc_preview_2.",
            executionStatus: "success",
            executionMetadata: {
              processLeaseId: "proc_preview_2",
              processLifecycleStatus: "PROCESS_STARTED",
              processCwd: "C:\\Users\\testuser\\Desktop\\AI Drone City",
              processPid: 43126
            },
            blockedBy: [],
            violations: [],
            votes: []
          },
          {
            action: {
              id: "action-open-browser",
              type: "open_browser",
              description: "Open the running preview in a browser window.",
              params: {
                url: "http://127.0.0.1:4173/",
                rootPath: "C:\\Users\\testuser\\Desktop\\AI Drone City"
              },
              estimatedCostUsd: 0.03
            },
            mode: "escalation_path",
            approved: true,
            output: "The existing browser window for http://127.0.0.1:4173/ is already open and was brought forward.",
            executionStatus: "success",
            executionMetadata: {
              browserSession: true,
              browserSessionId: "browser_session:ai-drone-city",
              browserSessionUrl: "http://127.0.0.1:4173/",
              browserSessionStatus: "open",
              browserSessionVisibility: "visible",
              browserSessionControllerKind: "playwright_managed",
              browserSessionControlAvailable: true,
              browserSessionBrowserProcessPid: 42057,
              browserSessionWorkspaceRootPath: "C:\\Users\\testuser\\Desktop\\AI Drone City",
              browserSessionLinkedProcessLeaseId: "proc_preview_2",
              browserSessionLinkedProcessCwd: "C:\\Users\\testuser\\Desktop\\AI Drone City",
              browserSessionLinkedProcessPid: 43126
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "Opened the AI Drone City preview and left it open.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(session.activeWorkspace?.previewProcessLeaseId, "proc_preview_2");
  assert.deepEqual(
    session.activeWorkspace?.previewProcessLeaseIds,
    ["proc_preview_2", "proc_preview_1"]
  );
  assert.equal(session.activeWorkspace?.previewStackState, "browser_and_preview");
});

test("persistExecutedJobOutcome lets a new React workspace replace stale single-file preview continuity", () => {
  const nowIso = "2026-03-17T23:58:00.000Z";
  const completedAt = "2026-03-17T23:58:07.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-react-workspace-reset",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-react-workspace-reset";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-react-workspace-reset",
      input: "Create a new landing page on my desktop in React.",
      executionInput: "Create a new landing page on my desktop in React.",
      status: "running",
      startedAt: nowIso
    }
  ];
  session.browserSessions = [
    {
      id: "browser_session:old-static-preview",
      label: "Old landing page preview",
      url: "file:///C:/Users/testuser/Desktop/drone-company-landing.html",
      status: "closed",
      openedAt: "2026-03-17T23:40:00.000Z",
      closedAt: "2026-03-17T23:41:00.000Z",
      sourceJobId: "job-old-static-preview",
      visibility: "visible",
      controllerKind: "playwright_managed",
      controlAvailable: false,
      browserProcessPid: 42057,
      workspaceRootPath: "C:\\Users\\testuser\\Desktop",
      linkedProcessLeaseId: null,
      linkedProcessCwd: "C:\\Users\\testuser\\Desktop",
      linkedProcessPid: null
    }
  ];
  session.activeWorkspace = {
    id: "workspace:old-static-preview",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company-landing.html",
    previewUrl: "file:///C:/Users/testuser/Desktop/drone-company-landing.html",
    browserSessionId: "browser_session:old-static-preview",
    browserSessionIds: ["browser_session:old-static-preview"],
    browserSessionStatus: "closed",
    browserProcessPid: 42057,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop",
    lastKnownPreviewProcessPid: null,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company-landing.html"],
    sourceJobId: "job-old-static-preview",
    updatedAt: "2026-03-17T23:41:00.000Z"
  };

  persistExecutedJobOutcome({
    session,
    executedJob: {
      ...session.recentJobs[0]!,
      status: "completed",
      completedAt,
      resultSummary: "Created the React landing page files.",
      errorMessage: null
    },
    executionResult: {
      summary: "Created the React landing page files.",
      taskRunResult: {
        task: {
          id: "task-react-workspace-reset",
          goal: "Create a new landing page on the Desktop in React.",
          userInput: "Create a new landing page on my desktop in React.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-react-workspace-reset",
          plannerNotes: "Write the React app source files.",
          actions: [
            {
              id: "action-write-react-app",
              type: "write_file",
              description: "Write App.jsx",
              params: {},
              estimatedCostUsd: 0.03
            },
            {
              id: "action-write-react-css",
              type: "write_file",
              description: "Write index.css",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-write-react-app",
              type: "write_file",
              description: "Write App.jsx",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "escalation_path",
            approved: true,
            output: "Wrote App.jsx.",
            executionStatus: "success",
            executionMetadata: {
              filePath: "C:\\Users\\testuser\\Desktop\\React Landing Page\\src\\App.jsx"
            },
            blockedBy: [],
            violations: [],
            votes: []
          },
          {
            action: {
              id: "action-write-react-css",
              type: "write_file",
              description: "Write index.css",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "escalation_path",
            approved: true,
            output: "Wrote index.css.",
            executionStatus: "success",
            executionMetadata: {
              filePath: "C:\\Users\\testuser\\Desktop\\React Landing Page\\src\\index.css"
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "Created the React landing page files.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    session.activeWorkspace?.rootPath,
    "C:\\Users\\testuser\\Desktop\\React Landing Page"
  );
  assert.ok(
    session.activeWorkspace?.primaryArtifactPath ===
      "C:\\Users\\testuser\\Desktop\\React Landing Page\\src\\App.jsx" ||
    session.activeWorkspace?.primaryArtifactPath ===
      "C:\\Users\\testuser\\Desktop\\React Landing Page\\src\\index.css"
  );
  assert.equal(session.activeWorkspace?.previewUrl, null);
  assert.equal(session.activeWorkspace?.browserSessionId, null);
  assert.deepEqual(session.activeWorkspace?.browserSessionIds, []);
  assert.deepEqual(session.activeWorkspace?.previewProcessLeaseIds, []);
  assert.deepEqual(
    [...(session.activeWorkspace?.lastChangedPaths ?? [])].sort(),
    [
      "C:\\Users\\testuser\\Desktop\\React Landing Page\\src\\App.jsx",
      "C:\\Users\\testuser\\Desktop\\React Landing Page\\src\\index.css"
    ].sort()
  );
});

test("persistExecutedJobOutcome reanchors static file preview continuity from current artifact paths when browser metadata keeps the old workspace root", () => {
  const nowIso = "2026-04-13T10:38:15.000Z";
  const completedAt = "2026-04-13T10:38:21.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-static-file-reanchor",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-static-file-reanchor";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-static-file-reanchor",
      input: "Create River Glass and open the exact local static file preview.",
      executionInput: "Create River Glass and open the exact local static file preview.",
      status: "running",
      startedAt: nowIso
    }
  ];
  session.activeWorkspace = {
    id: "workspace:foundry-echo",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\Foundry Echo",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\Foundry Echo\\index.html",
    previewUrl: "file:///C:/Users/testuser/Desktop/Foundry%20Echo/index.html",
    browserSessionId: "browser_session:foundry-echo",
    browserSessionIds: ["browser_session:foundry-echo"],
    browserSessionStatus: "closed",
    browserProcessPid: 42057,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: null,
    lastKnownPreviewProcessPid: null,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\Foundry Echo\\index.html"],
    sourceJobId: "job-foundry-echo",
    updatedAt: "2026-04-13T10:36:34.000Z"
  };

  persistExecutedJobOutcome({
    session,
    executedJob: {
      ...session.recentJobs[0]!,
      status: "completed",
      completedAt,
      resultSummary: "Opened the River Glass local file preview and left it open.",
      errorMessage: null
    },
    executionResult: {
      summary: "Opened the River Glass local file preview and left it open.",
      taskRunResult: {
        task: {
          id: "task-static-file-reanchor",
          goal: "Create River Glass and open the exact local static file preview.",
          userInput: "Create River Glass and open the exact local static file preview.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-static-file-reanchor",
          plannerNotes: "Write the new static page and open the exact file preview.",
          actions: [
            {
              id: "action-write-river-glass",
              type: "write_file",
              description: "Write River Glass index.html.",
              params: {},
              estimatedCostUsd: 0.03
            },
            {
              id: "action-open-river-glass",
              type: "open_browser",
              description: "Open the exact River Glass local file preview.",
              params: {
                url: "file:///C:/Users/testuser/Desktop/River%20Glass/index.html",
                rootPath: "C:\\Users\\testuser\\Desktop\\Foundry Echo"
              },
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-write-river-glass",
              type: "write_file",
              description: "Write River Glass index.html.",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "escalation_path",
            approved: true,
            output: "Wrote River Glass index.html.",
            executionStatus: "success",
            executionMetadata: {
              filePath: "C:\\Users\\testuser\\Desktop\\River Glass\\index.html"
            },
            blockedBy: [],
            violations: [],
            votes: []
          },
          {
            action: {
              id: "action-open-river-glass",
              type: "open_browser",
              description: "Open the exact River Glass local file preview.",
              params: {
                url: "file:///C:/Users/testuser/Desktop/River%20Glass/index.html",
                rootPath: "C:\\Users\\testuser\\Desktop\\Foundry Echo"
              },
              estimatedCostUsd: 0.03
            },
            mode: "escalation_path",
            approved: true,
            output: "Opened the River Glass local file preview and left it open.",
            executionStatus: "success",
            executionMetadata: {
              browserSession: true,
              browserSessionId: "browser_session:river-glass",
              browserSessionUrl: "file:///C:/Users/testuser/Desktop/River%20Glass/index.html",
              browserSessionStatus: "open",
              browserSessionVisibility: "visible",
              browserSessionControllerKind: "os_default",
              browserSessionControlAvailable: false,
              browserSessionBrowserProcessPid: 51234,
              browserSessionWorkspaceRootPath: "C:\\Users\\testuser\\Desktop\\Foundry Echo",
              browserSessionLinkedProcessLeaseId: null,
              browserSessionLinkedProcessCwd: "C:\\Users\\testuser\\Desktop\\Foundry Echo",
              browserSessionLinkedProcessPid: null
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "Opened the River Glass local file preview and left it open.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(session.activeWorkspace?.rootPath, "C:\\Users\\testuser\\Desktop\\River Glass");
  assert.equal(
    session.activeWorkspace?.primaryArtifactPath,
    "C:\\Users\\testuser\\Desktop\\River Glass\\index.html"
  );
  assert.equal(
    session.activeWorkspace?.previewUrl,
    "file:///C:/Users/testuser/Desktop/River%20Glass/index.html"
  );
  assert.equal(session.activeWorkspace?.browserSessionId, "browser_session:river-glass");
  assert.deepEqual(session.activeWorkspace?.lastChangedPaths, [
    "C:\\Users\\testuser\\Desktop\\River Glass\\index.html"
  ]);
});

test("persistExecutedJobOutcome preserves autonomous-loop ledgers from the aggregated task result", () => {
  const nowIso = "2026-03-13T12:00:00.000Z";
  const completedAt = "2026-03-13T12:00:03.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-autonomous-1",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-1";

  const runningJob: ConversationJob = {
    ...buildQueuedJob(nowIso),
    status: "running",
    startedAt: nowIso
  };
  session.recentJobs = [runningJob];

  const executedJob: ConversationJob = {
    ...runningJob,
    status: "completed",
    completedAt,
    resultSummary: "Autonomous task completed after 1 iteration.",
    errorMessage: null
  };

  const latestTaskRunResult: TaskRunResult = {
    task: {
      id: "task-autonomous-1",
      goal: "Build the landing page and leave it open.",
      userInput: "Build the landing page and leave it open.",
      createdAt: nowIso
    },
    plan: {
      taskId: "task-autonomous-1",
      plannerNotes: "Write the file and open the verified preview.",
      actions: []
    },
    actionResults: [
      {
        action: {
          id: "action-open-browser",
          type: "open_browser",
          description: "Open the verified preview in a visible browser window.",
          params: {
            url: "http://127.0.0.1:4177/index.html"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Opened the page in your browser.",
        executionStatus: "success",
        executionMetadata: {
          browserSessionId: "browser_session:landing-page",
          browserSessionUrl: "http://127.0.0.1:4177/index.html",
          browserSessionStatus: "open",
          browserSessionBrowserProcessPid: 42055
        },
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    summary: "Opened the preview in your browser.",
    startedAt: "2026-03-13T12:00:01.000Z",
    completedAt
  };

  const executionResult = buildAutonomousConversationExecutionResult(
    "Autonomous task completed after 1 iteration.",
    latestTaskRunResult,
    [
      {
        action: {
          id: "action-write-file",
          type: "write_file",
          description: "Write the landing page file.",
          params: {
            path: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
            content: "<!doctype html><title>Drone Company</title>"
          },
          estimatedCostUsd: 0.05
        },
        mode: "escalation_path",
        approved: true,
        output: "Write success: C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
        executionStatus: "success",
        executionMetadata: {
          filePath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html"
        },
        blockedBy: [],
        violations: [],
        votes: []
      },
      ...latestTaskRunResult.actionResults
    ],
    "2026-03-13T12:00:01.000Z",
    completedAt
  );

  persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult,
    maxRecentJobs: 10,
    maxRecentActions: 10,
    maxBrowserSessions: 5,
    maxPathDestinations: 5,
    maxConversationTurns: 20
  });

  assert.equal(session.runningJobId, null);
  assert.ok(
    session.recentActions.some((action) =>
      action.kind === "file" &&
      action.location === "C:\\Users\\testuser\\Desktop\\drone-company\\index.html"
    )
  );
  assert.ok(
    session.browserSessions.some((browserSession) =>
      browserSession.url === "http://127.0.0.1:4177/index.html" &&
      browserSession.status === "open"
    )
  );
  assert.ok(
    session.pathDestinations.some((destination) =>
      destination.resolvedPath === "C:\\Users\\testuser\\Desktop\\drone-company\\index.html"
    )
  );
  assert.equal(
    session.activeWorkspace?.rootPath,
    "C:\\Users\\testuser\\Desktop\\drone-company"
  );
  assert.equal(
    session.activeWorkspace?.previewUrl,
    "http://127.0.0.1:4177/index.html"
  );
  assert.equal(
    session.activeWorkspace?.browserSessionId,
    "browser_session:landing-page"
  );
  assert.deepEqual(session.activeWorkspace?.browserSessionIds, [
    "browser_session:landing-page"
  ]);
  assert.equal(session.activeWorkspace?.browserProcessPid, 42055);
  assert.equal(session.activeWorkspace?.stillControllable, true);
  assert.equal(session.activeWorkspace?.ownershipState, "tracked");
  assert.equal(session.activeWorkspace?.previewStackState, "browser_only");
});

test("persistExecutedJobOutcome downgrades remembered preview control to stale when the browser closes and the preview lease stops", () => {
  const nowIso = "2026-03-14T21:00:00.000Z";
  const completedAt = "2026-03-14T21:00:04.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-close-preview-stale",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-close-preview";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-close-preview",
      input: "Close the landing page so we can work on something else.",
      executionInput: "Close the landing page so we can work on something else.",
      status: "running",
      startedAt: nowIso
    }
  ];
  session.browserSessions = [
    {
      id: "browser_session:landing-page",
      label: "Landing page preview",
      url: "http://127.0.0.1:4177/index.html",
      status: "open",
      openedAt: "2026-03-14T20:55:00.000Z",
      closedAt: null,
      sourceJobId: "job-open-preview",
      visibility: "visible",
      controllerKind: "playwright_managed",
      controlAvailable: true,
      browserProcessPid: 42055,
      linkedProcessLeaseId: "proc_preview_drone",
      linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
      linkedProcessPid: 43125
    }
  ];
  session.activeWorkspace = {
    id: "workspace:drone-company",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
    previewUrl: "http://127.0.0.1:4177/index.html",
    browserSessionId: "browser_session:landing-page",
    browserSessionIds: ["browser_session:landing-page"],
    browserSessionStatus: "open",
    browserProcessPid: 42055,
    previewProcessLeaseId: "proc_preview_drone",
    previewProcessLeaseIds: ["proc_preview_drone"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
    lastKnownPreviewProcessPid: 43125,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_and_preview",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
    sourceJobId: "job-open-preview",
    updatedAt: "2026-03-14T20:55:00.000Z"
  };

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "Closed the browser and stopped the preview server.",
    errorMessage: null
  };

  persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "Closed the browser and stopped the preview server.",
      taskRunResult: {
        task: {
          id: "task-close-preview-stale",
          goal: "Close the preview stack",
          userInput: "Close the landing page so we can work on something else.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-close-preview-stale",
          plannerNotes: "Close the browser and stop the linked preview process.",
          actions: [
            {
              id: "action-close-browser",
              type: "close_browser",
              description: "Close the tracked landing page preview.",
              params: {
                sessionId: "browser_session:landing-page"
              },
              estimatedCostUsd: 0.03
            },
            {
              id: "action-stop-preview",
              type: "stop_process",
              description: "Stop the linked preview process.",
              params: {
                leaseId: "proc_preview_drone"
              },
              estimatedCostUsd: 0.08
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-close-browser",
              type: "close_browser",
              description: "Close the tracked landing page preview.",
              params: {
                sessionId: "browser_session:landing-page"
              },
              estimatedCostUsd: 0.03
            },
            mode: "escalation_path",
            approved: true,
            output: "Closed the browser window for http://127.0.0.1:4177/index.html.",
            executionStatus: "success",
            executionMetadata: {
              browserSession: true,
              browserSessionId: "browser_session:landing-page",
              browserSessionUrl: "http://127.0.0.1:4177/index.html",
              browserSessionStatus: "closed",
              browserSessionVisibility: "visible",
              browserSessionControllerKind: "playwright_managed",
              browserSessionControlAvailable: false,
              browserSessionBrowserProcessPid: 42055,
              browserSessionLinkedProcessLeaseId: "proc_preview_drone",
              browserSessionLinkedProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
              browserSessionLinkedProcessPid: 43125
            },
            blockedBy: [],
            violations: [],
            votes: []
          },
          {
            action: {
              id: "action-stop-preview",
              type: "stop_process",
              description: "Stop the linked preview process.",
              params: {
                leaseId: "proc_preview_drone"
              },
              estimatedCostUsd: 0.08
            },
            mode: "escalation_path",
            approved: true,
            output: "Process stopped: lease proc_preview_drone.",
            executionStatus: "success",
            executionMetadata: {
              processLeaseId: "proc_preview_drone",
              processLifecycleStatus: "PROCESS_STOPPED",
              processCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
              processPid: 43125
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "Closed the browser and stopped the preview server.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(session.activeWorkspace?.rootPath, "C:\\Users\\testuser\\Desktop\\drone-company");
  assert.equal(session.activeWorkspace?.stillControllable, false);
  assert.equal(session.activeWorkspace?.ownershipState, "stale");
  assert.equal(session.activeWorkspace?.previewStackState, "detached");
  assert.equal(session.activeWorkspace?.browserSessionStatus, "closed");
  assert.equal(session.activeWorkspace?.previewProcessLeaseId, "proc_preview_drone");
  assert.deepEqual(session.activeWorkspace?.previewProcessLeaseIds, ["proc_preview_drone"]);
});

test("persistExecutedJobOutcome converts locked folder organization failures into a recovery clarification", () => {
  const nowIso = "2026-03-13T15:00:00.000Z";
  const completedAt = "2026-03-13T15:00:03.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-1",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-1";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
        task: {
          id: "task-recovery-1",
          goal: "Organize folders",
          userInput:
            "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-recovery-1",
          plannerNotes: "Move the folders into the target directory.",
          actions: [
            {
              id: "action-move-1",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
              estimatedCostUsd: 0.08
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-move-1",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
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
          }
        ],
        summary: "I couldn't finish organizing those folders in this run.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    persisted.resultSummary,
    "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?"
  );
  assert.equal(session.activeClarification?.kind, "task_recovery");
  assert.equal(
    session.activeClarification?.options.map((option) => option.id).join(","),
    "continue_recovery,cancel"
  );
  assert.deepEqual(session.progressState, {
    status: "waiting_for_user",
    message:
      "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?",
    jobId: null,
    updatedAt: completedAt
  });
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?"
  );
});

test("persistExecutedJobOutcome does not turn wrapped artifact-edit follow-ups into folder-recovery clarifications", () => {
  const nowIso = "2026-03-14T19:05:21.666Z";
  const completedAt = "2026-03-14T19:06:50.329Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-edit-follow-up",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-edit-follow-up";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-edit-follow-up",
      input: "change the hero image to a slider instead of the landing page",
      executionInput: [
        "You are in an ongoing conversation with the same user.",
        "Recent conversation context (oldest to newest):",
        "- user: Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
        "- assistant: I moved most of them already.",
        "",
        "Current tracked workspace in this chat:",
        "- Root path: C:\\Users\\testuser\\Desktop\\drone-company",
        "",
        "Current user request:",
        "change the hero image to a slider instead of the landing page"
      ].join("\n"),
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I updated the hero to a slider and kept the preview aligned.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I updated the hero to a slider and kept the preview aligned.",
      taskRunResult: {
        task: {
          id: "task-recovery-edit-follow-up",
          goal: "Update the existing landing page hero.",
          userInput: session.recentJobs[0]!.executionInput ?? "",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-recovery-edit-follow-up",
          plannerNotes: "Update the tracked landing page artifact.",
          actions: [
            {
              id: "action-write-index",
              type: "write_file",
              description: "Update the tracked index.html with a slider hero.",
              params: {},
              estimatedCostUsd: 0.08
            },
            {
              id: "action-move-noise",
              type: "shell_command",
              description: "Transient shell noise from earlier workspace context.",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-write-index",
              type: "write_file",
              description: "Update the tracked index.html with a slider hero.",
              params: {},
              estimatedCostUsd: 0.08
            },
            mode: "escalation_path",
            approved: true,
            output: "Write success: C:\\Users\\testuser\\Desktop\\drone-company\\index.html (3049 chars)",
            blockedBy: [],
            violations: [],
            votes: []
          },
          {
            action: {
              id: "action-move-noise",
              type: "shell_command",
              description: "Transient shell noise from earlier workspace context.",
              params: {},
              estimatedCostUsd: 0.03
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
          }
        ],
        summary: "I updated the hero to a slider and kept the preview aligned.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    persisted.resultSummary,
    "I updated the hero to a slider and kept the preview aligned."
  );
  assert.equal(session.activeClarification, null);
  assert.equal(session.progressState, null);
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    "I updated the hero to a slider and kept the preview aligned."
  );
});

test("persistExecutedJobOutcome keeps shutdown-and-retry clarification only for exact tracked holder evidence", () => {
  const nowIso = "2026-03-13T15:10:00.000Z";
  const completedAt = "2026-03-13T15:10:03.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-2",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-2";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-2",
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
        task: {
          id: "task-recovery-2",
          goal: "Organize folders",
          userInput:
            "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-recovery-2",
          plannerNotes: "Move the folders into the target directory.",
          actions: [
            {
              id: "action-move-2",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
              estimatedCostUsd: 0.08
            },
            {
              id: "action-inspect-2",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-move-2",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
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
              id: "action-inspect-2",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "fast_path",
            approved: true,
            output: "Inspection found exact tracked preview holders.",
            executionStatus: "success",
            executionMetadata: {
              runtimeOwnershipInspection: true,
              inspectionRecommendedNextAction: "stop_exact_tracked_holders",
              inspectionPreviewProcessLeaseIds: "proc_preview_1"
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "I couldn't finish organizing those folders in this run.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    session.activeClarification?.options.map((option) => option.id).join(","),
    "retry_with_shutdown,cancel"
  );
});

test("persistExecutedJobOutcome reports stale-only recovery findings with a bounded retry clarification", () => {
  const nowIso = "2026-03-13T15:20:00.000Z";
  const completedAt = "2026-03-13T15:20:03.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-3",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-3";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-3",
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
        task: {
          id: "task-recovery-3",
          goal: "Organize folders",
          userInput:
            "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-recovery-3",
          plannerNotes: "Inspect the old workspace state after the move failed.",
          actions: [
            {
              id: "action-move-3",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
              estimatedCostUsd: 0.08
            },
            {
              id: "action-inspect-3",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-move-3",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
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
              id: "action-inspect-3",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "fast_path",
            approved: true,
            output: "Inspection found only stale assistant-owned workspace records.",
            executionStatus: "success",
            executionMetadata: {
              runtimeOwnershipInspection: true,
              inspectionOwnershipClassification: "stale_tracked",
              inspectionRecommendedNextAction: "collect_more_evidence",
              inspectionStalePreviewProcessLeaseIds: "proc_preview_old_1",
              inspectionStaleBrowserSessionIds: "browser_session:old_preview"
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "I couldn't finish organizing those folders in this run.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

    assert.equal(
      persisted.resultSummary,
      "I checked the old assistant resources tied to that workspace, and they are already stale. I can retry the move once now in case the lock already cleared."
    );
    assert.equal(session.activeClarification?.kind, "task_recovery");
    assert.equal(session.activeClarification?.matchedRuleId, "post_execution_stale_holder_records_only");
    assert.equal(
      session.activeClarification?.options.map((option) => option.id).join(","),
      "continue_recovery,cancel"
    );
    assert.deepEqual(session.progressState, {
      status: "waiting_for_user",
      message:
        "I checked the old assistant resources tied to that workspace, and they are already stale. I can retry the move once now in case the lock already cleared.",
      jobId: null,
      updatedAt: completedAt
    });
    assert.equal(
      session.conversationTurns[session.conversationTurns.length - 1]?.text,
      "I checked the old assistant resources tied to that workspace, and they are already stale. I can retry the move once now in case the lock already cleared."
    );
  });

test("persistCompletedJobState explains orphaned assistant browser cleanup requirements without persisting a clarification", async () => {
  const nowIso = "2026-03-14T20:10:00.000Z";
  const completedAt = "2026-03-14T20:10:05.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-orphaned-browser",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-worker-orphaned-browser";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-worker-orphaned-browser",
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
      task: {
        id: "task-worker-orphaned-browser",
        goal: "Organize folders",
        userInput:
          "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
        createdAt: nowIso
      },
      plan: {
        taskId: "task-worker-orphaned-browser",
        plannerNotes: "stub",
        actions: [
          {
            id: "action-move-orphaned",
            type: "shell_command",
            description: "Move matching drone-company folders into the new root.",
            params: {},
            estimatedCostUsd: 0.08
          },
          {
            id: "action-inspect-orphaned",
            type: "inspect_workspace_resources",
            description: "Inspect the workspace holder state.",
            params: {},
            estimatedCostUsd: 0.03
          }
        ]
      },
      actionResults: [
        {
          action: {
            id: "action-move-orphaned",
            type: "shell_command",
            description: "Move matching drone-company folders into the new root.",
            params: {},
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
            id: "action-inspect-orphaned",
            type: "inspect_workspace_resources",
            description: "Inspect the workspace holder state.",
            params: {},
            estimatedCostUsd: 0.03
          },
          mode: "fast_path",
          approved: true,
          output: "Inspection found old assistant browser windows still tied to the workspace.",
          executionStatus: "success",
          executionMetadata: {
            runtimeOwnershipInspection: true,
            inspectionOwnershipClassification: "orphaned_attributable",
            inspectionRecommendedNextAction: "manual_orphaned_browser_cleanup",
            inspectionOrphanedBrowserSessionIds: "browser_session:old_preview"
          },
          blockedBy: [],
          violations: [],
          votes: []
        }
      ],
      summary: "I couldn't finish organizing those folders in this run.",
      startedAt: nowIso,
      completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    persisted.resultSummary,
    "I found older assistant browser windows still tied to that workspace, but I no longer have direct runtime control over them. You may need to close those windows manually before I can continue, because I still do not have a live holder I can shut down safely from here."
  );
  assert.equal(session.activeClarification, null);
  assert.equal(session.progressState, null);
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    "I found older assistant browser windows still tied to that workspace, but I no longer have direct runtime control over them. You may need to close those windows manually before I can continue, because I still do not have a live holder I can shut down safely from here."
  );
});

test("persistCompletedJobState turns one high-confidence non-preview holder into a targeted recovery clarification", async () => {
  const nowIso = "2026-03-14T20:15:00.000Z";
  const completedAt = "2026-03-14T20:15:05.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-exact-non-preview-holder",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-worker-exact-non-preview-holder";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-worker-exact-non-preview-holder",
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
        task: {
          id: "task-worker-exact-non-preview-holder",
          goal: "Organize folders",
          userInput:
            "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-worker-exact-non-preview-holder",
          plannerNotes: "Inspect the workspace holder state.",
          actions: [
            {
              id: "action-move-exact-non-preview",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
              estimatedCostUsd: 0.08
            },
            {
              id: "action-inspect-exact-non-preview",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-move-exact-non-preview",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
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
              id: "action-inspect-exact-non-preview",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "fast_path",
            approved: true,
            output: "Inspection found one high-confidence local editor process still tied to the blocked folders.",
            executionStatus: "success",
            executionMetadata: {
              runtimeOwnershipInspection: true,
              inspectionOwnershipClassification: "orphaned_attributable",
              inspectionRecommendedNextAction: "clarify_before_exact_non_preview_shutdown",
              inspectionUntrackedCandidatePids: "8840",
              inspectionUntrackedCandidateKinds: "editor_workspace",
              inspectionUntrackedCandidateNames: "Code.exe",
              inspectionUntrackedCandidateConfidences: "high",
              inspectionUntrackedCandidateReasons: "command_line_matches_target_path"
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "I couldn't finish organizing those folders in this run.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    persisted.resultSummary,
    "I found one high-confidence local holder still tied to those folders: Code (pid 8840). It still looks like an editor or IDE process is holding them. If you want, I can stop just that process and retry the move. Do you want me to do that?"
  );
  assert.equal(session.activeClarification?.kind, "task_recovery");
  assert.equal(
    session.activeClarification?.matchedRuleId,
    "post_execution_exact_non_preview_holder_recovery_clarification"
  );
  assert.equal(
    session.activeClarification?.options.map((option) => option.id).join(","),
    "retry_with_shutdown,cancel"
  );
  assert.match(
    session.activeClarification?.recoveryInstruction ?? "",
    /\[WORKSPACE_RECOVERY_STOP_EXACT\]/i
  );
  assert.match(
    session.activeClarification?.recoveryInstruction ?? "",
    /Code \(pid 8840\)/i
  );
  assert.deepEqual(session.progressState, {
    status: "waiting_for_user",
    message:
      "I found one high-confidence local holder still tied to those folders: Code (pid 8840). It still looks like an editor or IDE process is holding them. If you want, I can stop just that process and retry the move. Do you want me to do that?",
    jobId: null,
    updatedAt: completedAt
  });
});

test("persistCompletedJobState turns one high-confidence sync holder into a targeted recovery clarification", async () => {
  const nowIso = "2026-03-14T20:18:00.000Z";
  const completedAt = "2026-03-14T20:18:05.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-sync-exact-holder",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-worker-sync-exact-holder";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-worker-sync-exact-holder",
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
        task: {
          id: "task-worker-sync-exact-holder",
          goal: "Organize folders",
          userInput:
            "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-worker-sync-exact-holder",
          plannerNotes: "Inspect the workspace holder state.",
          actions: [
            {
              id: "action-move-sync-exact-holder",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
              estimatedCostUsd: 0.08
            },
            {
              id: "action-inspect-sync-exact-holder",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-move-sync-exact-holder",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
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
              id: "action-inspect-sync-exact-holder",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "fast_path",
            approved: true,
            output: "Inspection found one high-confidence sync holder still tied to the blocked folders.",
            executionStatus: "success",
            executionMetadata: {
              runtimeOwnershipInspection: true,
              inspectionOwnershipClassification: "orphaned_attributable",
              inspectionRecommendedNextAction: "clarify_before_exact_non_preview_shutdown",
              inspectionUntrackedCandidatePids: "8850",
              inspectionUntrackedCandidateKinds: "sync_client",
              inspectionUntrackedCandidateNames: "OneDrive.exe",
              inspectionUntrackedCandidateConfidences: "high",
              inspectionUntrackedCandidateReasons: "command_line_matches_target_path"
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "I couldn't finish organizing those folders in this run.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    persisted.resultSummary,
    "I found one high-confidence local holder still tied to those folders: OneDrive (pid 8850). It still looks like a local sync process is holding them. If you want, I can stop just that process and retry the move. Do you want me to do that?"
  );
  assert.equal(session.activeClarification?.kind, "task_recovery");
  assert.equal(
    session.activeClarification?.matchedRuleId,
    "post_execution_exact_non_preview_holder_recovery_clarification"
  );
  assert.match(
    session.activeClarification?.recoveryInstruction ?? "",
    /OneDrive \(pid 8850\)/i
  );
  assert.deepEqual(session.progressState, {
    status: "waiting_for_user",
    message:
      "I found one high-confidence local holder still tied to those folders: OneDrive (pid 8850). It still looks like a local sync process is holding them. If you want, I can stop just that process and retry the move. Do you want me to do that?",
    jobId: null,
    updatedAt: completedAt
  });
});

test("persistCompletedJobState turns a small likely editor and shell holder set into a shutdown clarification", async () => {
  const nowIso = "2026-03-14T20:19:00.000Z";
  const completedAt = "2026-03-14T20:19:05.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-likely-non-preview",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-worker-likely-non-preview";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-worker-likely-non-preview",
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
        task: {
          id: "task-worker-likely-non-preview",
          goal: "Organize folders",
          userInput:
            "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-worker-likely-non-preview",
          plannerNotes: "Inspect the workspace holder state.",
          actions: [
            {
              id: "action-move-likely-non-preview",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
              estimatedCostUsd: 0.08
            },
            {
              id: "action-inspect-likely-non-preview",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-move-likely-non-preview",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
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
              id: "action-inspect-likely-non-preview",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "fast_path",
            approved: true,
            output:
              "Inspection found a small likely local editor and shell holder set still tied to the blocked folders.",
            executionStatus: "success",
            executionMetadata: {
              runtimeOwnershipInspection: true,
              inspectionOwnershipClassification: "orphaned_attributable",
              inspectionRecommendedNextAction:
                "clarify_before_likely_non_preview_shutdown",
              inspectionUntrackedCandidatePids: "8810,8811",
              inspectionUntrackedCandidateKinds: "editor_workspace,shell_workspace",
              inspectionUntrackedCandidateNames: "Code.exe|explorer.exe",
              inspectionUntrackedCandidateConfidences: "medium,medium",
              inspectionUntrackedCandidateReasons:
                "command_line_mentions_target_name|command_line_mentions_target_name"
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "I couldn't finish organizing those folders in this run.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    persisted.resultSummary,
    "I couldn't move those folders yet because a small set of likely local editor or shell holders still looks tied to them. Examples: Code, explorer. Candidate pids: 8810, 8811. They are not exact tracked runtime resources, so I still need your confirmation before I stop just those likely processes and retry the move. Do you want me to do that?"
  );
  assert.equal(session.activeClarification?.kind, "task_recovery");
  assert.equal(
    session.activeClarification?.matchedRuleId,
    "post_execution_likely_non_preview_holder_recovery_clarification"
  );
  assert.equal(
    session.activeClarification?.options.map((option) => option.id).join(","),
    "retry_with_shutdown,cancel"
  );
  assert.match(
    session.activeClarification?.recoveryInstruction ?? "",
    /pid=8810, pid=8811/i
  );
  assert.deepEqual(session.progressState, {
    status: "waiting_for_user",
    message:
      "I couldn't move those folders yet because a small set of likely local editor or shell holders still looks tied to them. Examples: Code, explorer. Candidate pids: 8810, 8811. They are not exact tracked runtime resources, so I still need your confirmation before I stop just those likely processes and retry the move. Do you want me to do that?",
    jobId: null,
    updatedAt: completedAt
  });
});

test("persistCompletedJobState explains non-preview holder cleanup requirements without persisting a clarification", async () => {
  const nowIso = "2026-03-14T20:20:00.000Z";
  const completedAt = "2026-03-14T20:20:05.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-non-preview-holder",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-worker-non-preview-holder";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-worker-non-preview-holder",
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
        task: {
          id: "task-worker-non-preview-holder",
          goal: "Organize folders",
          userInput:
            "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-worker-non-preview-holder",
          plannerNotes: "Inspect the workspace holder state.",
          actions: [
            {
              id: "action-move-non-preview",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
              estimatedCostUsd: 0.08
            },
            {
              id: "action-inspect-non-preview",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-move-non-preview",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
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
              id: "action-inspect-non-preview",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "fast_path",
            approved: true,
            output: "Inspection found a likely local editor process still tied to the blocked folders.",
            executionStatus: "success",
            executionMetadata: {
              runtimeOwnershipInspection: true,
              inspectionOwnershipClassification: "orphaned_attributable",
              inspectionRecommendedNextAction: "manual_non_preview_holder_cleanup",
              inspectionUntrackedCandidatePids: "8810",
              inspectionUntrackedCandidateKinds: "editor_workspace",
              inspectionUntrackedCandidateNames: "Code.exe"
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "I couldn't finish organizing those folders in this run.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    persisted.resultSummary,
    "I couldn't move those folders yet because they still look busy in an editor or IDE process, not an exact tracked preview holder. Examples: Code. I should not shut that down automatically from this runtime evidence alone. Close Code if that project is still open there, then ask me to retry the move."
  );
  assert.equal(session.activeClarification, null);
  assert.equal(session.progressState, null);
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    "I couldn't move those folders yet because they still look busy in an editor or IDE process, not an exact tracked preview holder. Examples: Code. I should not shut that down automatically from this runtime evidence alone. Close Code if that project is still open there, then ask me to retry the move."
  );
});

test("persistCompletedJobState keeps a bounded mixed editor shell and sync holder set on the clarification lane", async () => {
  const nowIso = "2026-03-14T20:21:00.000Z";
  const completedAt = "2026-03-14T20:21:05.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-mixed-likely-holder",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-worker-mixed-likely-holder";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-worker-mixed-likely-holder",
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
        task: {
          id: "task-worker-mixed-likely-holder",
          goal: "Organize folders",
          userInput:
            "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-worker-mixed-likely-holder",
          plannerNotes: "Inspect the workspace holder state.",
          actions: [
            {
              id: "action-move-mixed-likely-holder",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
              estimatedCostUsd: 0.08
            },
            {
              id: "action-inspect-mixed-likely-holder",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-move-mixed-likely-holder",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
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
              id: "action-inspect-mixed-likely-holder",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "fast_path",
            approved: true,
            output:
              "Inspection found a bounded local holder set across editor, shell, and sync processes still tied to the blocked folders.",
            executionStatus: "success",
            executionMetadata: {
              runtimeOwnershipInspection: true,
              inspectionOwnershipClassification: "orphaned_attributable",
              inspectionRecommendedNextAction:
                "clarify_before_likely_non_preview_shutdown",
              inspectionUntrackedCandidatePids: "8830,8831,8832",
              inspectionUntrackedCandidateKinds:
                "editor_workspace,shell_workspace,sync_client",
              inspectionUntrackedCandidateNames: "Code.exe|explorer.exe|OneDrive.exe",
              inspectionUntrackedCandidateConfidences: "medium,medium,medium",
              inspectionUntrackedCandidateReasons:
                "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name"
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "I couldn't finish organizing those folders in this run.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    persisted.resultSummary,
    "I couldn't move those folders yet because a small inspected local holder set across editor, shell, or sync processes still looks tied to them. Examples: Code, explorer, OneDrive. Candidate pids: 8830, 8831, 8832. They are not exact tracked runtime resources, so I still need your confirmation before I stop just those likely processes and retry the move. Do you want me to do that?"
  );
  assert.equal(session.activeClarification?.kind, "task_recovery");
  assert.equal(
    session.activeClarification?.matchedRuleId,
    "post_execution_likely_non_preview_holder_recovery_clarification"
  );
  assert.match(
    session.activeClarification?.recoveryInstruction ?? "",
    /pid=8830, pid=8831, pid=8832/i
  );
  assert.deepEqual(session.progressState, {
    status: "waiting_for_user",
    message:
      "I couldn't move those folders yet because a small inspected local holder set across editor, shell, or sync processes still looks tied to them. Examples: Code, explorer, OneDrive. Candidate pids: 8830, 8831, 8832. They are not exact tracked runtime resources, so I still need your confirmation before I stop just those likely processes and retry the move. Do you want me to do that?",
    jobId: null,
    updatedAt: completedAt
  });
});

test("persistCompletedJobState explains sync-holder cleanup requirements with a targeted next step", async () => {
  const nowIso = "2026-03-14T20:22:00.000Z";
  const completedAt = "2026-03-14T20:22:05.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-sync-holder",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-worker-sync-holder";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-worker-sync-holder",
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
        task: {
          id: "task-worker-sync-holder",
          goal: "Organize folders",
          userInput:
            "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-worker-sync-holder",
          plannerNotes: "Inspect the workspace holder state.",
          actions: [
            {
              id: "action-move-sync-holder",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
              estimatedCostUsd: 0.08
            },
            {
              id: "action-inspect-sync-holder",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-move-sync-holder",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
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
              id: "action-inspect-sync-holder",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "fast_path",
            approved: true,
            output: "Inspection found a likely local sync process still tied to the blocked folders.",
            executionStatus: "success",
            executionMetadata: {
              runtimeOwnershipInspection: true,
              inspectionOwnershipClassification: "orphaned_attributable",
              inspectionRecommendedNextAction: "manual_non_preview_holder_cleanup",
              inspectionUntrackedCandidatePids: "8830",
              inspectionUntrackedCandidateKinds: "sync_client",
              inspectionUntrackedCandidateNames: "OneDrive.exe"
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "I couldn't finish organizing those folders in this run.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    persisted.resultSummary,
    "I couldn't move those folders yet because they still look busy in a local sync process, not an exact tracked preview holder. Examples: OneDrive. I should not shut that down automatically from this runtime evidence alone. Pause or let OneDrive finish with that folder, then ask me to retry the move."
  );
  assert.equal(session.activeClarification, null);
  assert.equal(session.progressState, null);
});

test("persistCompletedJobState keeps a bounded nearby-process holder set on clarification instead of manual cleanup", async () => {
  const nowIso = "2026-03-14T20:24:00.000Z";
  const completedAt = "2026-03-14T20:24:05.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-nearby-holder",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-worker-nearby-holder";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-worker-nearby-holder",
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
        task: {
          id: "task-worker-nearby-holder",
          goal: "Organize folders",
          userInput:
            "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-worker-nearby-holder",
          plannerNotes: "Inspect the workspace holder state.",
          actions: [
            {
              id: "action-move-nearby-holder",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
              estimatedCostUsd: 0.08
            },
            {
              id: "action-inspect-nearby-holder",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-move-nearby-holder",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
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
              id: "action-inspect-nearby-holder",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "fast_path",
            approved: true,
            output:
              "Inspection found a bounded local holder set across editor, shell, and a nearby local process still tied to the blocked folders.",
            executionStatus: "success",
            executionMetadata: {
              runtimeOwnershipInspection: true,
              inspectionOwnershipClassification: "orphaned_attributable",
              inspectionRecommendedNextAction:
                "clarify_before_likely_non_preview_shutdown",
              inspectionUntrackedCandidatePids: "8830,8831,8832",
              inspectionUntrackedCandidateKinds:
                "editor_workspace,shell_workspace,unknown_local_process",
              inspectionUntrackedCandidateNames:
                "Code.exe|explorer.exe|AcmeDesktopHelper.exe",
              inspectionUntrackedCandidateConfidences: "medium,medium,medium",
              inspectionUntrackedCandidateReasons:
                "command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path"
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "I couldn't finish organizing those folders in this run.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    persisted.resultSummary,
    "I couldn't move those folders yet because a small inspected local holder set across editor, shell, or nearby local processes still looks tied to them. Examples: Code, explorer, AcmeDesktopHelper. Candidate pids: 8830, 8831, 8832. They are not exact tracked runtime resources, so I still need your confirmation before I stop just those likely processes and retry the move. Do you want me to do that?"
  );
  assert.equal(session.activeClarification?.kind, "task_recovery");
  assert.equal(
    session.activeClarification?.matchedRuleId,
    "post_execution_likely_non_preview_holder_recovery_clarification"
  );
  assert.match(
    session.activeClarification?.recoveryInstruction ?? "",
    /pid=8830, pid=8831, pid=8832/i
  );
  assert.deepEqual(session.progressState, {
    status: "waiting_for_user",
    message:
      "I couldn't move those folders yet because a small inspected local holder set across editor, shell, or nearby local processes still looks tied to them. Examples: Code, explorer, AcmeDesktopHelper. Candidate pids: 8830, 8831, 8832. They are not exact tracked runtime resources, so I still need your confirmation before I stop just those likely processes and retry the move. Do you want me to do that?",
    jobId: null,
    updatedAt: completedAt
  });
});

test("persistCompletedJobState keeps a broader nearby-process holder set on clarification instead of manual cleanup", async () => {
  const nowIso = "2026-03-14T20:25:00.000Z";
  const completedAt = "2026-03-14T20:25:05.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-broader-nearby-holder",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-worker-broader-nearby-holder";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-worker-broader-nearby-holder",
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
        task: {
          id: "task-worker-broader-nearby-holder",
          goal: "Organize folders",
          userInput:
            "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-worker-broader-nearby-holder",
          plannerNotes: "Inspect the workspace holder state.",
          actions: [
            {
              id: "action-move-broader-nearby-holder",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
              estimatedCostUsd: 0.08
            },
            {
              id: "action-inspect-broader-nearby-holder",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-move-broader-nearby-holder",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
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
              id: "action-inspect-broader-nearby-holder",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "fast_path",
            approved: true,
            output:
              "Inspection found a broader local holder set across editor, shell, and a nearby local process still tied to the blocked folders.",
            executionStatus: "success",
            executionMetadata: {
              runtimeOwnershipInspection: true,
              inspectionOwnershipClassification: "orphaned_attributable",
              inspectionRecommendedNextAction:
                "clarify_before_likely_non_preview_shutdown",
              inspectionUntrackedCandidatePids: "8840,8841,8842,8843,8844",
              inspectionUntrackedCandidateKinds:
                "editor_workspace,shell_workspace,shell_workspace,editor_workspace,unknown_local_process",
              inspectionUntrackedCandidateNames:
                "Code.exe|explorer.exe|powershell.exe|Code.exe|AcmeDesktopHelper.exe",
              inspectionUntrackedCandidateConfidences: "medium,medium,medium,low,medium",
              inspectionUntrackedCandidateReasons:
                "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path"
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "I couldn't finish organizing those folders in this run.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    persisted.resultSummary,
    "I couldn't move those folders yet because a broader inspected local holder set across editor, shell, or nearby local processes still looks tied to them. Examples: Code, explorer, powershell. Candidate pids: 8840, 8841, 8842, 8843, 8844. They are not exact tracked runtime resources, so I still need your confirmation before I stop just those likely processes and retry the move. Do you want me to do that?"
  );
  assert.equal(session.activeClarification?.kind, "task_recovery");
  assert.equal(
    session.activeClarification?.matchedRuleId,
    "post_execution_likely_non_preview_holder_recovery_clarification"
  );
  assert.match(
    session.activeClarification?.recoveryInstruction ?? "",
    /pid=8840, pid=8841, pid=8842, pid=8843, pid=8844/i
  );
  assert.deepEqual(session.progressState, {
    status: "waiting_for_user",
    message:
      "I couldn't move those folders yet because a broader inspected local holder set across editor, shell, or nearby local processes still looks tied to them. Examples: Code, explorer, powershell. Candidate pids: 8840, 8841, 8842, 8843, 8844. They are not exact tracked runtime resources, so I still need your confirmation before I stop just those likely processes and retry the move. Do you want me to do that?",
    jobId: null,
    updatedAt: completedAt
  });
});

test("persistCompletedJobState keeps a broader sync-plus-nearby holder set on clarification instead of manual cleanup", async () => {
  const nowIso = "2026-03-04T00:00:00.000Z";
  const completedAt = "2026-03-04T00:06:00.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-broader-sync-nearby-holder",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job_completed_broader_sync_nearby_holder";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job_completed_broader_sync_nearby_holder",
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
        task: {
          id: "task-worker-broader-sync-nearby-holder",
          goal: "Organize folders",
          userInput:
            "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-worker-broader-sync-nearby-holder",
          plannerNotes: "Inspect the workspace holder state.",
          actions: [
            {
              id: "action-move-broader-sync-nearby-holder",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
              estimatedCostUsd: 0.08
            },
            {
              id: "action-inspect-broader-sync-nearby-holder",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-move-broader-sync-nearby-holder",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
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
              id: "action-inspect-broader-sync-nearby-holder",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "fast_path",
            approved: true,
            output:
              "Inspection found a broader local holder set across editor, shell, sync, and a nearby local process still tied to the blocked folders.",
            executionStatus: "success",
            executionMetadata: {
              runtimeOwnershipInspection: true,
              inspectionOwnershipClassification: "orphaned_attributable",
              inspectionRecommendedNextAction:
                "clarify_before_likely_non_preview_shutdown",
              inspectionUntrackedCandidatePids: "8850,8851,8852,8853,8854,8855",
              inspectionUntrackedCandidateKinds:
                "editor_workspace,shell_workspace,shell_workspace,editor_workspace,sync_client,unknown_local_process",
              inspectionUntrackedCandidateNames:
                "Code.exe|explorer.exe|powershell.exe|Code.exe|OneDrive.exe|AcmeDesktopHelper.exe",
              inspectionUntrackedCandidateConfidences:
                "medium,medium,medium,low,medium,medium",
              inspectionUntrackedCandidateReasons:
                "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path"
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "I couldn't finish organizing those folders in this run.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    persisted.resultSummary,
    "I couldn't move those folders yet because a broader inspected local holder set across editor, shell, sync, or nearby local processes still looks tied to them. Examples: Code, explorer, powershell. Candidate pids: 8850, 8851, 8852, 8853, 8854, 8855. They are not exact tracked runtime resources, so I still need your confirmation before I stop just those likely processes and retry the move. Do you want me to do that?"
  );
  assert.equal(session.activeClarification?.kind, "task_recovery");
  assert.equal(
    session.activeClarification?.matchedRuleId,
    "post_execution_likely_non_preview_holder_recovery_clarification"
  );
  assert.match(
    session.activeClarification?.recoveryInstruction ?? "",
    /pid=8850, pid=8851, pid=8852, pid=8853, pid=8854, pid=8855/i
  );
  assert.deepEqual(session.progressState, {
    status: "waiting_for_user",
    message:
      "I couldn't move those folders yet because a broader inspected local holder set across editor, shell, sync, or nearby local processes still looks tied to them. Examples: Code, explorer, powershell. Candidate pids: 8850, 8851, 8852, 8853, 8854, 8855. They are not exact tracked runtime resources, so I still need your confirmation before I stop just those likely processes and retry the move. Do you want me to do that?",
    jobId: null,
    updatedAt: completedAt
  });
});

test("persistCompletedJobState keeps a broader seven-holder sync-plus-nearby set on clarification instead of manual cleanup", async () => {
  const nowIso = "2026-03-04T00:10:00.000Z";
  const completedAt = "2026-03-04T00:16:00.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-broader-seven-sync-nearby-holder",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job_completed_broader_seven_sync_nearby_holder";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job_completed_broader_seven_sync_nearby_holder",
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
        task: {
          id: "task-worker-broader-seven-sync-nearby-holder",
          goal: "Organize folders",
          userInput:
            "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-worker-broader-seven-sync-nearby-holder",
          plannerNotes: "Inspect the workspace holder state.",
          actions: [
            {
              id: "action-move-broader-seven-sync-nearby-holder",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
              estimatedCostUsd: 0.08
            },
            {
              id: "action-inspect-broader-seven-sync-nearby-holder",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-move-broader-seven-sync-nearby-holder",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
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
              id: "action-inspect-broader-seven-sync-nearby-holder",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "fast_path",
            approved: true,
            output:
              "Inspection found a broader local holder set across editor, shell, sync, and a nearby local process still tied to the blocked folders.",
            executionStatus: "success",
            executionMetadata: {
              runtimeOwnershipInspection: true,
              inspectionOwnershipClassification: "orphaned_attributable",
              inspectionRecommendedNextAction:
                "clarify_before_likely_non_preview_shutdown",
              inspectionUntrackedCandidatePids: "8860,8861,8862,8863,8864,8865,8866",
              inspectionUntrackedCandidateKinds:
                "editor_workspace,shell_workspace,shell_workspace,editor_workspace,sync_client,shell_workspace,unknown_local_process",
              inspectionUntrackedCandidateNames:
                "Code.exe|explorer.exe|powershell.exe|Code.exe|OneDrive.exe|cmd.exe|AcmeDesktopHelper.exe",
              inspectionUntrackedCandidateConfidences:
                "medium,medium,medium,low,medium,low,medium",
              inspectionUntrackedCandidateReasons:
                "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path"
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "I couldn't finish organizing those folders in this run.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    persisted.resultSummary,
    "I couldn't move those folders yet because a broader inspected local holder set across editor, shell, sync, or nearby local processes still looks tied to them. Examples: Code, explorer, powershell. Candidate pids: 8860, 8861, 8862, 8863, 8864, 8865, 8866. They are not exact tracked runtime resources, so I still need your confirmation before I stop just those likely processes and retry the move. Do you want me to do that?"
  );
  assert.equal(session.activeClarification?.kind, "task_recovery");
  assert.equal(
    session.activeClarification?.matchedRuleId,
    "post_execution_likely_non_preview_holder_recovery_clarification"
  );
  assert.match(
    session.activeClarification?.recoveryInstruction ?? "",
    /pid=8860, pid=8861, pid=8862, pid=8863, pid=8864, pid=8865, pid=8866/i
  );
  assert.deepEqual(session.progressState, {
    status: "waiting_for_user",
    message:
      "I couldn't move those folders yet because a broader inspected local holder set across editor, shell, sync, or nearby local processes still looks tied to them. Examples: Code, explorer, powershell. Candidate pids: 8860, 8861, 8862, 8863, 8864, 8865, 8866. They are not exact tracked runtime resources, so I still need your confirmation before I stop just those likely processes and retry the move. Do you want me to do that?",
    jobId: null,
    updatedAt: completedAt
  });
});

test("persistCompletedJobState keeps a broader eight-holder sync-plus-nearby set on clarification instead of manual cleanup", async () => {
  const nowIso = "2026-03-04T00:20:00.000Z";
  const completedAt = "2026-03-04T00:26:00.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-broader-eight-sync-nearby-holder",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job_completed_broader_eight_sync_nearby_holder";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job_completed_broader_eight_sync_nearby_holder",
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
        task: {
          id: "task-worker-broader-eight-sync-nearby-holder",
          goal: "Organize folders",
          userInput:
            "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-worker-broader-eight-sync-nearby-holder",
          plannerNotes: "Inspect the workspace holder state.",
          actions: [
            {
              id: "action-move-broader-eight-sync-nearby-holder",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
              estimatedCostUsd: 0.08
            },
            {
              id: "action-inspect-broader-eight-sync-nearby-holder",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-move-broader-eight-sync-nearby-holder",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
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
              id: "action-inspect-broader-eight-sync-nearby-holder",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "fast_path",
            approved: true,
            output:
              "Inspection found a broader local holder set across editor, shell, sync, and a nearby local process still tied to the blocked folders.",
            executionStatus: "success",
            executionMetadata: {
              runtimeOwnershipInspection: true,
              inspectionOwnershipClassification: "orphaned_attributable",
              inspectionRecommendedNextAction:
                "clarify_before_likely_non_preview_shutdown",
              inspectionUntrackedCandidatePids: "8870,8871,8872,8873,8874,8875,8876,8877",
              inspectionUntrackedCandidateKinds:
                "editor_workspace,shell_workspace,shell_workspace,editor_workspace,sync_client,shell_workspace,editor_workspace,unknown_local_process",
              inspectionUntrackedCandidateNames:
                "Code.exe|explorer.exe|powershell.exe|Code.exe|OneDrive.exe|cmd.exe|Code.exe|AcmeDesktopHelper.exe",
              inspectionUntrackedCandidateConfidences:
                "medium,medium,medium,low,medium,low,medium,medium",
              inspectionUntrackedCandidateReasons:
                "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path"
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "I couldn't finish organizing those folders in this run.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    persisted.resultSummary,
    "I couldn't move those folders yet because a broader inspected local holder set across editor, shell, sync, or nearby local processes still looks tied to them. Examples: Code, explorer, powershell. Candidate pids: 8870, 8871, 8872, 8873, 8874, 8875, 8876, 8877. They are not exact tracked runtime resources, so I still need your confirmation before I stop just those likely processes and retry the move. Do you want me to do that?"
  );
  assert.equal(session.activeClarification?.kind, "task_recovery");
  assert.equal(
    session.activeClarification?.matchedRuleId,
    "post_execution_likely_non_preview_holder_recovery_clarification"
  );
  assert.match(
    session.activeClarification?.recoveryInstruction ?? "",
    /pid=8870, pid=8871, pid=8872, pid=8873, pid=8874, pid=8875, pid=8876, pid=8877/i
  );
  assert.deepEqual(session.progressState, {
    status: "waiting_for_user",
    message:
      "I couldn't move those folders yet because a broader inspected local holder set across editor, shell, sync, or nearby local processes still looks tied to them. Examples: Code, explorer, powershell. Candidate pids: 8870, 8871, 8872, 8873, 8874, 8875, 8876, 8877. They are not exact tracked runtime resources, so I still need your confirmation before I stop just those likely processes and retry the move. Do you want me to do that?",
    jobId: null,
    updatedAt: completedAt
  });
});

test("persistCompletedJobState keeps a broader nine-holder local family on contextual manual cleanup wording", async () => {
  const nowIso = "2026-03-15T06:11:00.000Z";
  const completedAt = "2026-03-15T06:11:05.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-contextual-manual-cleanup",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-worker-contextual-manual-cleanup";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-worker-contextual-manual-cleanup",
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
        task: {
          id: "task-worker-contextual-manual-cleanup",
          goal: "Organize folders",
          userInput:
            "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-worker-contextual-manual-cleanup",
          plannerNotes: "Inspect the workspace holder state.",
          actions: [
            {
              id: "action-move-contextual-manual-cleanup",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
              estimatedCostUsd: 0.08
            },
            {
              id: "action-inspect-contextual-manual-cleanup",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-move-contextual-manual-cleanup",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
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
              id: "action-inspect-contextual-manual-cleanup",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "fast_path",
            approved: true,
            output:
              "Inspection found a broader still-local holder family tied to the blocked folders.",
            executionStatus: "success",
            executionMetadata: {
              runtimeOwnershipInspection: true,
              inspectionOwnershipClassification: "orphaned_attributable",
              inspectionRecommendedNextAction: "manual_non_preview_holder_cleanup",
              inspectionUntrackedCandidatePids:
                "8880,8881,8882,8883,8884,8885,8886,8887,8888",
              inspectionUntrackedCandidateKinds:
                "shell_workspace,shell_workspace,shell_workspace,shell_workspace,shell_workspace,shell_workspace,shell_workspace,shell_workspace,unknown_local_process",
              inspectionUntrackedCandidateNames:
                "explorer.exe|powershell.exe|explorer.exe|powershell.exe|explorer.exe|powershell.exe|explorer.exe|powershell.exe|AcmeDesktopHelper.exe",
              inspectionUntrackedCandidateConfidences:
                "medium,medium,low,medium,low,medium,low,medium,medium",
              inspectionUntrackedCandidateReasons:
                "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path"
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "I couldn't finish organizing those folders in this run.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    persisted.resultSummary,
    "I couldn't move those folders yet because 9 likely local non-preview holders across editor, shell, or nearby local processes still look tied to them. Examples: explorer, powershell, AcmeDesktopHelper. That broader local set is outside the confirmation lane, so I should not shut those down automatically from this runtime evidence alone. Close the terminal or file window still pointed at that folder, then ask me to retry the move. Examples: explorer, powershell, and AcmeDesktopHelper."
  );
  assert.equal(session.activeClarification, null);
  assert.equal(session.progressState, null);
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    "I couldn't move those folders yet because 9 likely local non-preview holders across editor, shell, or nearby local processes still look tied to them. Examples: explorer, powershell, AcmeDesktopHelper. That broader local set is outside the confirmation lane, so I should not shut those down automatically from this runtime evidence alone. Close the terminal or file window still pointed at that folder, then ask me to retry the move. Examples: explorer, powershell, and AcmeDesktopHelper."
  );
});

test("persistCompletedJobState keeps a grouped thirteen-holder local family on contextual manual cleanup wording", async () => {
  const nowIso = "2026-03-15T07:00:00.000Z";
  const completedAt = "2026-03-15T07:00:05.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-contextual-manual-cleanup-grouped",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-worker-contextual-manual-cleanup-grouped";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-worker-contextual-manual-cleanup-grouped",
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
        task: {
          id: "task-worker-contextual-manual-cleanup-grouped",
          goal: "Organize folders",
          userInput:
            "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-worker-contextual-manual-cleanup-grouped",
          plannerNotes: "Inspect the workspace holder state.",
          actions: [
            {
              id: "action-move-contextual-manual-cleanup-grouped",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
              estimatedCostUsd: 0.08
            },
            {
              id: "action-inspect-contextual-manual-cleanup-grouped",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-move-contextual-manual-cleanup-grouped",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
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
              id: "action-inspect-contextual-manual-cleanup-grouped",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "fast_path",
            approved: true,
            output:
              "Inspection found a broader still-local grouped holder family tied to the blocked folders.",
            executionStatus: "success",
            executionMetadata: {
              runtimeOwnershipInspection: true,
              inspectionOwnershipClassification: "orphaned_attributable",
              inspectionRecommendedNextAction: "manual_non_preview_holder_cleanup",
              inspectionUntrackedCandidatePids:
                "8890,8891,8892,8893,8894,8895,8896,8897,8898,8899,8900,8901,8902",
              inspectionUntrackedCandidateKinds:
                "editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,unknown_local_process",
              inspectionUntrackedCandidateNames:
                "Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|AcmeDesktopHelper.exe",
              inspectionUntrackedCandidateConfidences:
                "medium,medium,medium,medium,medium,medium,low,low,medium,low,low,medium,medium",
              inspectionUntrackedCandidateReasons:
                "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path"
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "I couldn't finish organizing those folders in this run.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    persisted.resultSummary,
    "I couldn't move those folders yet because 13 likely local non-preview holders across editor, shell, or nearby local processes still look tied to them. Examples: Code, explorer, powershell. That broader local set is outside the confirmation lane, so I should not shut those down automatically from this runtime evidence alone. Close Code, explorer, powershell, and AcmeDesktopHelper if that project is still open there, then ask me to retry the move."
  );
  assert.equal(session.activeClarification, null);
  assert.equal(session.progressState, null);
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    "I couldn't move those folders yet because 13 likely local non-preview holders across editor, shell, or nearby local processes still look tied to them. Examples: Code, explorer, powershell. That broader local set is outside the confirmation lane, so I should not shut those down automatically from this runtime evidence alone. Close Code, explorer, powershell, and AcmeDesktopHelper if that project is still open there, then ask me to retry the move."
  );
});

test("persistCompletedJobState keeps a grouped fifteen-holder local family with two nearby local processes on contextual manual cleanup wording", async () => {
  const nowIso = "2026-03-15T07:30:00.000Z";
  const completedAt = "2026-03-15T07:30:05.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-contextual-manual-cleanup-grouped-two-nearby",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-worker-contextual-manual-cleanup-grouped-two-nearby";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-worker-contextual-manual-cleanup-grouped-two-nearby",
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
        task: {
          id: "task-worker-contextual-manual-cleanup-grouped-two-nearby",
          goal: "Organize folders",
          userInput:
            "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-worker-contextual-manual-cleanup-grouped-two-nearby",
          plannerNotes: "Inspect the workspace holder state.",
          actions: [
            {
              id: "action-move-contextual-manual-cleanup-grouped-two-nearby",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
              estimatedCostUsd: 0.08
            },
            {
              id: "action-inspect-contextual-manual-cleanup-grouped-two-nearby",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-move-contextual-manual-cleanup-grouped-two-nearby",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
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
              id: "action-inspect-contextual-manual-cleanup-grouped-two-nearby",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "fast_path",
            approved: true,
            output:
              "Inspection found a broader still-local grouped holder family with two nearby local processes tied to the blocked folders.",
            executionStatus: "success",
            executionMetadata: {
              runtimeOwnershipInspection: true,
              inspectionOwnershipClassification: "orphaned_attributable",
              inspectionRecommendedNextAction: "manual_non_preview_holder_cleanup",
              inspectionUntrackedCandidatePids:
                "8910,8911,8912,8913,8914,8915,8916,8917,8918,8919,8920,8921,8922,8923,8924",
              inspectionUntrackedCandidateKinds:
                "editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,unknown_local_process,unknown_local_process",
              inspectionUntrackedCandidateNames:
                "Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|AcmeDesktopHelper.exe|WatchBridgeService.exe",
              inspectionUntrackedCandidateConfidences:
                "medium,medium,medium,medium,medium,medium,low,low,medium,low,low,medium,medium,medium,medium",
              inspectionUntrackedCandidateReasons:
                "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path|command_line_matches_target_path"
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "I couldn't finish organizing those folders in this run.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    persisted.resultSummary,
    "I couldn't move those folders yet because 15 likely local non-preview holders across editor, shell, or nearby local processes still look tied to them. Examples: Code, explorer, powershell. That broader local set is outside the confirmation lane, so I should not shut those down automatically from this runtime evidence alone. Close Code, explorer, powershell, AcmeDesktopHelper, and WatchBridgeService if that project is still open there, then ask me to retry the move."
  );
  assert.equal(session.activeClarification, null);
  assert.equal(session.progressState, null);
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    "I couldn't move those folders yet because 15 likely local non-preview holders across editor, shell, or nearby local processes still look tied to them. Examples: Code, explorer, powershell. That broader local set is outside the confirmation lane, so I should not shut those down automatically from this runtime evidence alone. Close Code, explorer, powershell, AcmeDesktopHelper, and WatchBridgeService if that project is still open there, then ask me to retry the move."
  );
});

test("persistCompletedJobState keeps a grouped eighteen-holder mixed local family with two nearby local processes on contextual manual cleanup wording", async () => {
  const nowIso = "2026-03-15T08:00:00.000Z";
  const completedAt = "2026-03-15T08:00:05.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-contextual-manual-cleanup-grouped-eighteen",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-worker-contextual-manual-cleanup-grouped-eighteen";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-worker-contextual-manual-cleanup-grouped-eighteen",
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
        task: {
          id: "task-worker-contextual-manual-cleanup-grouped-eighteen",
          goal: "Organize folders",
          userInput:
            "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-worker-contextual-manual-cleanup-grouped-eighteen",
          plannerNotes: "Inspect the workspace holder state.",
          actions: [
            {
              id: "action-move-contextual-manual-cleanup-grouped-eighteen",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
              estimatedCostUsd: 0.08
            },
            {
              id: "action-inspect-contextual-manual-cleanup-grouped-eighteen",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-move-contextual-manual-cleanup-grouped-eighteen",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
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
              id: "action-inspect-contextual-manual-cleanup-grouped-eighteen",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "fast_path",
            approved: true,
            output:
              "Inspection found a broader still-local grouped holder family with sync clients and two nearby local processes tied to the blocked folders.",
            executionStatus: "success",
            executionMetadata: {
              runtimeOwnershipInspection: true,
              inspectionOwnershipClassification: "orphaned_attributable",
              inspectionRecommendedNextAction: "manual_non_preview_holder_cleanup",
              inspectionUntrackedCandidatePids:
                "8930,8931,8932,8933,8934,8935,8936,8937,8938,8939,8940,8941,8942,8943,8944,8945,8946,8947",
              inspectionUntrackedCandidateKinds:
                "editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,unknown_local_process,unknown_local_process,sync_client,sync_client,sync_client",
              inspectionUntrackedCandidateNames:
                "Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|AcmeDesktopHelper.exe|WatchBridgeService.exe|OneDrive.exe|OneDrive.exe|OneDrive.exe",
              inspectionUntrackedCandidateConfidences:
                "medium,medium,medium,medium,medium,medium,low,low,medium,low,low,medium,medium,medium,medium,medium,medium,medium",
              inspectionUntrackedCandidateReasons:
                "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path|command_line_matches_target_path|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name"
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "I couldn't finish organizing those folders in this run.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    persisted.resultSummary,
    "I couldn't move those folders yet because 18 likely local non-preview holders across editor, shell, sync, or nearby local processes still look tied to them. Examples: Code, explorer, powershell. That broader local set is outside the confirmation lane, so I should not shut those down automatically from this runtime evidence alone. Close or pause Code, explorer, powershell, AcmeDesktopHelper, WatchBridgeService, and OneDrive if they are still tied to that project, then ask me to retry the move."
  );
  assert.equal(session.activeClarification, null);
  assert.equal(session.progressState, null);
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    "I couldn't move those folders yet because 18 likely local non-preview holders across editor, shell, sync, or nearby local processes still look tied to them. Examples: Code, explorer, powershell. That broader local set is outside the confirmation lane, so I should not shut those down automatically from this runtime evidence alone. Close or pause Code, explorer, powershell, AcmeDesktopHelper, WatchBridgeService, and OneDrive if they are still tied to that project, then ask me to retry the move."
  );
});

test("persistCompletedJobState keeps a repeated-family twenty-four-holder mixed local family on contextual manual cleanup wording", async () => {
  const nowIso = "2026-03-15T08:30:00.000Z";
  const completedAt = "2026-03-15T08:30:05.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-recovery-contextual-manual-cleanup-grouped-twenty-four",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-worker-contextual-manual-cleanup-grouped-twenty-four";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-worker-contextual-manual-cleanup-grouped-twenty-four",
      input:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      executionInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      status: "running",
      startedAt: nowIso
    }
  ];

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "I couldn't finish organizing those folders in this run.",
    errorMessage: null
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "I couldn't finish organizing those folders in this run.",
      taskRunResult: {
        task: {
          id: "task-worker-contextual-manual-cleanup-grouped-twenty-four",
          goal: "Organize folders",
          userInput:
            "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-worker-contextual-manual-cleanup-grouped-twenty-four",
          plannerNotes: "Inspect the workspace holder state.",
          actions: [
            {
              id: "action-move-contextual-manual-cleanup-grouped-twenty-four",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
              estimatedCostUsd: 0.08
            },
            {
              id: "action-inspect-contextual-manual-cleanup-grouped-twenty-four",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action-move-contextual-manual-cleanup-grouped-twenty-four",
              type: "shell_command",
              description: "Move matching drone-company folders into the new root.",
              params: {},
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
              id: "action-inspect-contextual-manual-cleanup-grouped-twenty-four",
              type: "inspect_workspace_resources",
              description: "Inspect the workspace holder state.",
              params: {},
              estimatedCostUsd: 0.03
            },
            mode: "fast_path",
            approved: true,
            output:
              "Inspection found a broader repeated-family local holder group with sync clients and two nearby local processes tied to the blocked folders.",
            executionStatus: "success",
            executionMetadata: {
              runtimeOwnershipInspection: true,
              inspectionOwnershipClassification: "orphaned_attributable",
              inspectionRecommendedNextAction: "manual_non_preview_holder_cleanup",
              inspectionUntrackedCandidatePids:
                "8950,8951,8952,8953,8954,8955,8956,8957,8958,8959,8960,8961,8962,8963,8964,8965,8966,8967,8968,8969,8970,8971,8972,8973",
              inspectionUntrackedCandidateKinds:
                "editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace,editor_workspace,unknown_local_process,unknown_local_process,sync_client,sync_client,sync_client,editor_workspace,shell_workspace,shell_workspace,editor_workspace,shell_workspace,shell_workspace",
              inspectionUntrackedCandidateNames:
                "Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|AcmeDesktopHelper.exe|WatchBridgeService.exe|OneDrive.exe|OneDrive.exe|OneDrive.exe|Code.exe|explorer.exe|powershell.exe|Code.exe|explorer.exe|powershell.exe",
              inspectionUntrackedCandidateConfidences:
                "medium,medium,medium,medium,medium,medium,low,low,medium,low,low,medium,medium,medium,medium,medium,medium,medium,medium,medium,medium,low,low,medium",
              inspectionUntrackedCandidateReasons:
                "command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_matches_target_path|command_line_matches_target_path|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name|command_line_mentions_target_name"
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "I couldn't finish organizing those folders in this run.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(
    persisted.resultSummary,
    "I couldn't move those folders yet because 24 likely local non-preview holders across editor, shell, sync, or nearby local processes still look tied to them. Examples: Code, explorer, powershell. That broader local set is outside the confirmation lane, so I should not shut those down automatically from this runtime evidence alone. Close or pause Code, explorer, powershell, AcmeDesktopHelper, WatchBridgeService, and OneDrive if they are still tied to that project, then ask me to retry the move."
  );
  assert.equal(session.activeClarification, null);
  assert.equal(session.progressState, null);
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    "I couldn't move those folders yet because 24 likely local non-preview holders across editor, shell, sync, or nearby local processes still look tied to them. Examples: Code, explorer, powershell. That broader local set is outside the confirmation lane, so I should not shut those down automatically from this runtime evidence alone. Close or pause Code, explorer, powershell, AcmeDesktopHelper, WatchBridgeService, and OneDrive if they are still tied to that project, then ask me to retry the move."
  );
});

test("isBlockedSystemJobOutcome only matches completed blocked system outputs", () => {
  const nowIso = "2026-03-03T00:00:00.000Z";
  const blocked = {
    ...buildQueuedJob(nowIso),
    status: "completed" as const,
    isSystemJob: true,
    resultSummary: "State: blocked (policy)."
  };
  const governanceBlocked = {
    ...buildQueuedJob(nowIso),
    status: "completed" as const,
    isSystemJob: true,
    resultSummary:
      "I couldn't execute that request in this run. What happened: governance blocked the requested action."
  };
  const normal = {
    ...buildQueuedJob(nowIso),
    status: "completed" as const,
    isSystemJob: true,
    resultSummary: "Done."
  };

  assert.equal(isBlockedSystemJobOutcome(blocked), true);
  assert.equal(isBlockedSystemJobOutcome(governanceBlocked), true);
  assert.equal(
    isBlockedSystemJobOutcome(normal, {
      summary: "Suppressed pulse",
      suppressUserDelivery: true
    }),
    true
  );
  assert.equal(isBlockedSystemJobOutcome(normal), false);
});

test("persistExecutedJobOutcome keeps suppressed system summaries out of assistant turns and handoff", () => {
  const nowIso = "2026-03-03T00:00:00.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  const queuedJob = {
    ...buildQueuedJob(nowIso),
    id: "job-pulse-1",
    isSystemJob: true
  };
  const completedJob = {
    ...queuedJob,
    status: "completed" as const,
    completedAt: "2026-03-03T00:00:05.000Z",
    resultSummary:
      "I couldn't execute that request in this run. What happened: governance blocked the requested action."
  };
  session.recentJobs = [queuedJob];

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob: completedJob,
    executionResult: {
      summary: completedJob.resultSummary!,
      suppressUserDelivery: true
    },
    maxRecentJobs: 10,
    maxRecentActions: 10,
    maxBrowserSessions: 5,
    maxPathDestinations: 10,
    maxConversationTurns: 10
  });

  assert.equal(persisted.resultSummary, completedJob.resultSummary);
  assert.equal(session.conversationTurns.length, 0);
  assert.equal(session.returnHandoff, null);
});

test("persistExecutedJobOutcome downgrades the active workspace when stop_process closes the linked browser session too", () => {
  const nowIso = "2026-03-14T21:00:00.000Z";
  const completedAt = "2026-03-14T21:00:02.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-stop-linked-cleanup",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-stop-linked-cleanup";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-stop-linked-cleanup",
      input: "Organize the drone folders and shut down the linked preview first.",
      executionInput: "Organize the drone folders and shut down the linked preview first.",
      status: "running",
      startedAt: nowIso
    }
  ];
  session.browserSessions = [
    {
      id: "browser_session:action_open_browser_preview",
      label: "Browser window",
      url: "file:///C:/Users/testuser/Desktop/drone-company/index.html",
      status: "open",
      openedAt: "2026-03-14T20:59:00.000Z",
      closedAt: null,
      sourceJobId: "job-open-preview",
      visibility: "visible",
      controllerKind: "playwright_managed",
      controlAvailable: true,
      browserProcessPid: 42057,
      linkedProcessLeaseId: "proc_preview_3",
      linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
      linkedProcessPid: 43127
    }
  ];
  session.activeWorkspace = {
    id: "workspace:drone-company",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
    previewUrl: "file:///C:/Users/testuser/Desktop/drone-company/index.html",
    browserSessionId: "browser_session:action_open_browser_preview",
    browserSessionIds: ["browser_session:action_open_browser_preview"],
    browserSessionStatus: "open",
    browserProcessPid: 42057,
    previewProcessLeaseId: "proc_preview_3",
    previewProcessLeaseIds: ["proc_preview_3"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
    lastKnownPreviewProcessPid: 43127,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_and_preview",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
    sourceJobId: "job-open-preview",
    updatedAt: "2026-03-14T20:59:00.000Z"
  };

  const executedJob: ConversationJob = {
    ...session.recentJobs[0]!,
    status: "completed",
    completedAt,
    resultSummary: "Stopped the linked preview holder and closed its browser window.",
    errorMessage: null
  };

  persistExecutedJobOutcome({
    session,
    executedJob,
    executionResult: {
      summary: "Stopped the linked preview holder and closed its browser window.",
      taskRunResult: {
        task: {
          id: "task-stop-linked-cleanup",
          goal: "Stop the linked preview holder and close its browser window.",
          userInput: "Organize the drone folders and shut down the linked preview first.",
          createdAt: nowIso
        },
        plan: {
          taskId: "task-stop-linked-cleanup",
          plannerNotes: "Stop the exact preview holder before continuing.",
          actions: [
            {
              id: "action_stop_preview_cleanup",
              type: "stop_process",
              description: "Stop the linked preview process and close its browser window.",
              params: {
                leaseId: "proc_preview_3"
              },
              estimatedCostUsd: 0.08
            }
          ]
        },
        actionResults: [
          {
            action: {
              id: "action_stop_preview_cleanup",
              type: "stop_process",
              description: "Stop the linked preview process and close its browser window.",
              params: {
                leaseId: "proc_preview_3"
              },
              estimatedCostUsd: 0.08
            },
            mode: "escalation_path",
            approved: true,
            output:
              "Process stopped: lease proc_preview_3. Closed 1 linked browser window.",
            executionStatus: "success",
            executionMetadata: {
              processLeaseId: "proc_preview_3",
              processLifecycleStatus: "PROCESS_STOPPED",
              processCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
              processPid: 43127,
              linkedBrowserSessionCleanupCount: 1,
              linkedBrowserSessionCleanupRecordsJson: JSON.stringify([
                {
                  sessionId: "browser_session:action_open_browser_preview",
                  url: "file:///C:/Users/testuser/Desktop/drone-company/index.html",
                  status: "closed",
                  visibility: "visible",
                  controllerKind: "playwright_managed",
                  controlAvailable: false,
                  browserProcessPid: 42057,
                  workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
                  linkedProcessLeaseId: "proc_preview_3",
                  linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
                  linkedProcessPid: 43127
                }
              ])
            },
            blockedBy: [],
            violations: [],
            votes: []
          }
        ],
        summary: "Stopped the linked preview holder and closed its browser window.",
        startedAt: nowIso,
        completedAt
      }
    },
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(session.browserSessions[0]?.status, "closed");
  assert.equal(session.browserSessions[0]?.controlAvailable, false);
  assert.equal(session.activeWorkspace?.browserSessionStatus, "closed");
  assert.equal(session.activeWorkspace?.stillControllable, false);
  assert.equal(session.activeWorkspace?.ownershipState, "stale");
  assert.equal(session.activeWorkspace?.previewStackState, "detached");
});

test("persistExecutedJobOutcome reconciles persisted workspace control against live runtime snapshots", () => {
  const nowIso = "2026-03-15T18:10:00.000Z";
  const completedAt = "2026-03-15T18:10:08.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-close-after-reload",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.runningJobId = "job-close-preview-after-reload";
  session.recentJobs = [
    {
      ...buildQueuedJob(nowIso),
      id: "job-close-preview-after-reload",
      input: "Close the landing page after the runtime restarted.",
      executionInput: "Close the landing page after the runtime restarted.",
      status: "running",
      startedAt: nowIso
    }
  ];
  session.browserSessions = [
    {
      id: "browser_session:reloaded_preview",
      label: "Browser window",
      url: "http://127.0.0.1:55225/index.html",
      status: "open",
      openedAt: "2026-03-15T18:09:00.000Z",
      closedAt: null,
      sourceJobId: "job-open-preview",
      visibility: "visible",
      controllerKind: "playwright_managed",
      controlAvailable: false,
      browserProcessPid: 55001,
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      linkedProcessLeaseId: "proc_preview_reload",
      linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
      linkedProcessPid: 55002
    }
  ];
  session.activeWorkspace = {
    id: "workspace:drone-company",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
    previewUrl: "http://127.0.0.1:55225/index.html",
    browserSessionId: "browser_session:reloaded_preview",
    browserSessionIds: ["browser_session:reloaded_preview"],
    browserSessionStatus: "open",
    browserProcessPid: 55001,
    previewProcessLeaseId: "proc_preview_reload",
    previewProcessLeaseIds: ["proc_preview_reload"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
    lastKnownPreviewProcessPid: 55002,
    stillControllable: false,
    ownershipState: "orphaned",
    previewStackState: "browser_only",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
    sourceJobId: "job-open-preview",
    updatedAt: "2026-03-15T18:09:00.000Z"
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob: {
      ...session.recentJobs[0]!,
      status: "completed",
      completedAt,
      resultSummary:
        "Process stopped: lease proc_preview_reload.\nOne later step was blocked (BROWSER_SESSION_CONTROL_UNAVAILABLE), so I stopped after the work that already succeeded.",
      errorMessage: null
    },
    executionResult: {
      summary:
        "Process stopped: lease proc_preview_reload.\nOne later step was blocked (BROWSER_SESSION_CONTROL_UNAVAILABLE), so I stopped after the work that already succeeded."
    },
    browserSessionSnapshots: [
      {
        sessionId: "browser_session:reloaded_preview",
        url: "http://127.0.0.1:55225/index.html",
        status: "closed",
        openedAt: "2026-03-15T18:09:00.000Z",
        closedAt: completedAt,
        visibility: "visible",
        controllerKind: "playwright_managed",
        controlAvailable: false,
        browserProcessPid: 55001,
        workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
        linkedProcessLeaseId: "proc_preview_reload",
        linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
        linkedProcessPid: 55002
      }
    ],
    managedProcessSnapshots: [
      {
        leaseId: "proc_preview_reload",
        taskId: "task-close-after-reload",
        actionId: "action_stop_preview_reload",
        pid: 55002,
        commandFingerprint: "python -m http.server 55225",
        cwd: "C:\\Users\\testuser\\Desktop\\drone-company",
        shellExecutable: "python",
        shellKind: "process",
    requestedHost: null,
    requestedPort: null,
    requestedUrl: null,
    startedAt: "2026-03-15T18:09:00.000Z",
        statusCode: "PROCESS_STOPPED",
        exitCode: 0,
        signal: null,
        stopRequested: true
      }
    ],
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.equal(persisted.status, "completed");
  assert.match(
    persisted.resultSummary ?? "",
    /closed the linked browser window/i
  );
  assert.doesNotMatch(
    persisted.resultSummary ?? "",
    /BROWSER_SESSION_CONTROL_UNAVAILABLE/i
  );
  assert.equal(session.browserSessions[0]?.status, "closed");
  assert.equal(session.browserSessions[0]?.closedAt, completedAt);
  assert.equal(session.activeWorkspace?.browserSessionStatus, "closed");
  assert.equal(session.activeWorkspace?.stillControllable, false);
  assert.equal(session.activeWorkspace?.ownershipState, "stale");
  assert.equal(session.activeWorkspace?.previewStackState, "detached");
  assert.equal(session.returnHandoff?.status, "completed");
});

test("persistExecutedJobOutcome does not promote closed-preview success copy when the request names a different explicit localhost URL", () => {
  const nowIso = "2026-03-15T18:09:00.000Z";
  const completedAt = "2026-03-15T18:09:02.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "close-foreign-preview",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.recentJobs = [
    {
      id: "job-foreign-url",
      input:
        "Please close http://127.0.0.1:59999/index.html only if it is actually the page from this project.",
      executionInput: "same",
      createdAt: nowIso,
      startedAt: nowIso,
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
      finalDeliveryLastAttemptAt: null,
      pauseRequestedAt: null
    }
  ];
  session.browserSessions = [
    {
      id: "browser_session:reloaded_preview",
      label: "Landing page preview",
      url: "http://127.0.0.1:55225/index.html",
      status: "closed",
      openedAt: "2026-03-15T18:09:00.000Z",
      closedAt: completedAt,
      sourceJobId: "job-open-preview",
      visibility: "visible",
      controllerKind: "playwright_managed",
      controlAvailable: false,
      browserProcessPid: 55001,
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      linkedProcessLeaseId: "proc_preview_reload",
      linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
      linkedProcessPid: 55002
    }
  ];
  session.activeWorkspace = {
    id: "workspace:drone-company",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
    previewUrl: "http://127.0.0.1:55225/index.html",
    browserSessionId: "browser_session:reloaded_preview",
    browserSessionIds: ["browser_session:reloaded_preview"],
    browserSessionStatus: "closed",
    browserProcessPid: 55001,
    previewProcessLeaseId: "proc_preview_reload",
    previewProcessLeaseIds: ["proc_preview_reload"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
    lastKnownPreviewProcessPid: 55002,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
    sourceJobId: "job-open-preview",
    updatedAt: "2026-03-15T18:09:00.000Z"
  };

  const persisted = persistExecutedJobOutcome({
    session,
    executedJob: {
      ...session.recentJobs[0]!,
      status: "completed",
      completedAt,
      resultSummary:
        "Process stopped: lease proc_preview_reload.\nOne later step was blocked (BROWSER_SESSION_CONTROL_UNAVAILABLE), so I stopped after the work that already succeeded.",
      errorMessage: null
    },
    executionResult: {
      summary:
        "Process stopped: lease proc_preview_reload.\nOne later step was blocked (BROWSER_SESSION_CONTROL_UNAVAILABLE), so I stopped after the work that already succeeded."
    },
    browserSessionSnapshots: [
      {
        sessionId: "browser_session:reloaded_preview",
        url: "http://127.0.0.1:55225/index.html",
        status: "closed",
        openedAt: "2026-03-15T18:09:00.000Z",
        closedAt: completedAt,
        visibility: "visible",
        controllerKind: "playwright_managed",
        controlAvailable: false,
        browserProcessPid: 55001,
        workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
        linkedProcessLeaseId: "proc_preview_reload",
        linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
        linkedProcessPid: 55002
      }
    ],
    managedProcessSnapshots: [
      {
        leaseId: "proc_preview_reload",
        taskId: "task-close-after-reload",
        actionId: "action_stop_preview_reload",
        pid: 55002,
        commandFingerprint: "python -m http.server 55225",
        cwd: "C:\\Users\\testuser\\Desktop\\drone-company",
        shellExecutable: "python",
        shellKind: "process",
    requestedHost: null,
    requestedPort: null,
    requestedUrl: null,
    startedAt: "2026-03-15T18:09:00.000Z",
        statusCode: "PROCESS_STOPPED",
        exitCode: 0,
        signal: null,
        stopRequested: true
      }
    ],
    maxRecentJobs: 20,
    maxRecentActions: 12,
    maxBrowserSessions: 6,
    maxPathDestinations: 8,
    maxConversationTurns: 40
  });

  assert.match(
    persisted.resultSummary ?? "",
    /BROWSER_SESSION_CONTROL_UNAVAILABLE/i
  );
  assert.doesNotMatch(
    persisted.resultSummary ?? "",
    /closed the linked browser window/i
  );
});
