import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import { enqueueAutomaticTrackedWorkspaceRecoveryRetry } from "../../src/interfaces/conversationRuntime/conversationWorkerAutoRecovery";
import {
  buildWorkspaceRecoveryNextUserInput,
  deriveWorkspaceRecoverySignal
} from "../../src/core/autonomy/workspaceRecoveryPolicy";
import type { TaskRunResult } from "../../src/core/types";
import type { ConversationJob } from "../../src/interfaces/sessionStore";

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

test("enqueueAutomaticTrackedWorkspaceRecoveryRetry fails closed when the tracked workspace was not born in workflow context", () => {
  const nowIso = "2026-03-14T22:10:00.000Z";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-auto-recovery-domain-gate",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.domainContext.dominantLane = "profile";
  session.activeWorkspace = {
    id: "workspace-1",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\OneDrive\\Desktop\\drone-company-a",
    primaryArtifactPath: null,
    previewUrl: null,
    browserSessionId: null,
    browserSessionIds: [],
    browserSessionStatus: null,
    browserProcessPid: null,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: null,
    lastKnownPreviewProcessPid: null,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "detached",
    lastChangedPaths: [],
    sourceJobId: "job-seed",
    domainSnapshotLane: "profile",
    domainSnapshotRecordedAt: nowIso,
    updatedAt: nowIso
  };

  const queued = enqueueAutomaticTrackedWorkspaceRecoveryRetry(
    session,
    {
      ...buildQueuedJob(nowIso),
      id: "job-completed",
      input: "Organize the project folders.",
      status: "completed",
      startedAt: nowIso,
      completedAt: nowIso,
      resultSummary: "Blocked by an open preview holder."
    },
    {
      task: {
        id: "task-auto-recovery-domain-gate",
        goal: "Organize the project folders.",
        userInput: "Organize the project folders.",
        createdAt: nowIso
      }
    } as TaskRunResult
  );

  assert.equal(queued, false);
  assert.equal(session.queuedJobs.length, 0);
});

test("enqueueAutomaticTrackedWorkspaceRecoveryRetry queues one post-shutdown organization retry when the move was never retried", () => {
  const nowIso = "2026-03-14T22:10:00.000Z";
  const completedAt = "2026-03-14T22:10:05.000Z";
  const sourceInput =
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-auto-recovery-1",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.activeClarification = {
    id: "clarification-1",
    kind: "task_recovery",
    sourceInput,
    question: "Do you want me to continue?",
    requestedAt: nowIso,
    matchedRuleId: "post_execution_locked_folder_recovery",
    recoveryInstruction: "inspect first",
    options: [
      {
        id: "continue_recovery",
        label: "Yes, inspect and continue"
      },
      {
        id: "cancel",
        label: "No, leave them alone"
      }
    ]
  };
  session.progressState = {
    status: "waiting_for_user",
    message: "Do you want me to continue?",
    jobId: null,
    updatedAt: nowIso
  };
  session.conversationTurns.push(
    {
      role: "user",
      text: sourceInput,
      at: nowIso
    },
    {
      role: "assistant",
      text: "I checked C:\\Users\\testuser\\OneDrive\\Desktop.",
      at: completedAt
    }
  );

  const completedJob: ConversationJob = {
    ...buildQueuedJob(nowIso),
    input: sourceInput,
    executionInput: [
      sourceInput,
      "",
      "[Clarification resolved: Do you want me to continue?]",
      "User selected: Yes, inspect and continue.",
      "Recovery instruction: inspect the relevant workspace resources first."
    ].join("\n"),
    status: "completed",
    startedAt: nowIso,
    completedAt,
    resultSummary: "I checked C:\\Users\\testuser\\OneDrive\\Desktop.",
    errorMessage: null
  };

  const queued = enqueueAutomaticTrackedWorkspaceRecoveryRetry(session, completedJob, {
    task: {
      id: "task-auto-recovery-1",
      goal: sourceInput,
      userInput: sourceInput,
      createdAt: nowIso
    },
    plan: {
      taskId: "task-auto-recovery-1",
      plannerNotes: "Inspect, stop exact preview holders, then continue.",
      actions: [
        {
          id: "action-stop-a",
          type: "stop_process",
          description: "Stop first exact preview holder.",
          params: {
            leaseId: "proc_preview_a"
          },
          estimatedCostUsd: 0.03
        },
        {
          id: "action-stop-b",
          type: "stop_process",
          description: "Stop second exact preview holder.",
          params: {
            leaseId: "proc_preview_b"
          },
          estimatedCostUsd: 0.03
        },
        {
          id: "action-list-desktop",
          type: "list_directory",
          description: "Inspect desktop root.",
          params: {
            path: "C:\\Users\\testuser\\OneDrive\\Desktop"
          },
          estimatedCostUsd: 0.05
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action-stop-a",
          type: "stop_process",
          description: "Stop first exact preview holder.",
          params: {
            leaseId: "proc_preview_a"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_preview_a.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action-stop-b",
          type: "stop_process",
          description: "Stop second exact preview holder.",
          params: {
            leaseId: "proc_preview_b"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_preview_b.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action-list-desktop",
          type: "list_directory",
          description: "Inspect desktop root.",
          params: {
            path: "C:\\Users\\testuser\\OneDrive\\Desktop"
          },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: true,
        output: "Directory contents:\ndrone-company-a\ndrone-company-b\ndrone-web-projects",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    summary: "I checked C:\\Users\\testuser\\OneDrive\\Desktop.",
    startedAt: nowIso,
    completedAt
  });

  assert.equal(queued, true);
  assert.equal(session.queuedJobs.length, 1);
  assert.equal(session.queuedJobs[0]?.input, sourceInput);
  assert.match(
    session.queuedJobs[0]?.executionInput ?? "",
    /\[AUTOMATIC_TRACKED_WORKSPACE_POST_SHUTDOWN_RETRY\]/
  );
  assert.match(
    session.queuedJobs[0]?.executionInput ?? "",
    /\[WORKSPACE_RECOVERY_POST_SHUTDOWN_RETRY\]/
  );
  assert.match(
    session.queuedJobs[0]?.executionInput ?? "",
    /Retry this original folder-organization goal now/i
  );
  assert.equal(session.activeClarification, null);
  assert.equal(session.progressState, null);
  assert.equal(
    completedJob.resultSummary,
    "I shut down the exact tracked preview holders that were blocking those folders. I'm retrying the move now and will verify the destination before I finish."
  );
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    "I shut down the exact tracked preview holders that were blocking those folders. I'm retrying the move now and will verify the destination before I finish."
  );
  assert.equal(completedJob.recoveryTrace?.kind, "workspace_auto_recovery");
  assert.equal(completedJob.recoveryTrace?.status, "attempting");
  assert.equal(completedJob.recoveryTrace?.recoveryClass, "WORKSPACE_HOLDER_CONFLICT");
});

test("enqueueAutomaticTrackedWorkspaceRecoveryRetry queues a marker-bearing exact-holder recovery input", () => {
  const nowIso = "2026-03-14T22:30:00.000Z";
  const completedAt = "2026-03-14T22:30:05.000Z";
  const sourceInput =
    "Please organize every drone-* project folder into drone-folder on my desktop.";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-auto-recovery-3",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.conversationTurns.push(
    {
      role: "user",
      text: sourceInput,
      at: nowIso
    },
    {
      role: "assistant",
      text: "I couldn't move those folders yet because exact tracked preview holders are still keeping them busy.",
      at: completedAt
    }
  );

  const completedJob: ConversationJob = {
    ...buildQueuedJob(nowIso),
    input: sourceInput,
    executionInput: sourceInput,
    status: "completed",
    startedAt: nowIso,
    completedAt,
    resultSummary:
      "I couldn't move those folders yet because exact tracked preview holders are still keeping them busy.",
    errorMessage: null
  };

  const queued = enqueueAutomaticTrackedWorkspaceRecoveryRetry(session, completedJob, {
    task: {
      id: "task-auto-recovery-3",
      goal: sourceInput,
      userInput: sourceInput,
      createdAt: nowIso
    },
    plan: {
      taskId: "task-auto-recovery-3",
      plannerNotes: "Inspect exact holders and recover.",
      actions: [
        {
          id: "action-inspect",
          type: "inspect_workspace_resources",
          description: "Inspect the blocked drone workspace resources.",
          params: {
            workspaceRoot: "C:\\Users\\testuser\\OneDrive\\Desktop\\drone-company-a"
          },
          estimatedCostUsd: 0.05
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action-shell",
          type: "shell_command",
          description: "Attempt the move.",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: false,
        output:
          "Move-Item : The process cannot access the file because it is being used by another process.",
        blockedBy: [],
        violations: [
          {
            code: "ACTION_EXECUTION_FAILED",
            message:
              "The process cannot access the file because it is being used by another process."
          }
        ],
        votes: []
      },
      {
        action: {
          id: "action-inspect",
          type: "inspect_workspace_resources",
          description: "Inspect the blocked drone workspace resources.",
          params: {
            workspaceRoot: "C:\\Users\\testuser\\OneDrive\\Desktop\\drone-company-a"
          },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: true,
        output: "Inspection complete.",
        executionMetadata: {
          runtimeOwnershipInspection: true,
          inspectionRecommendedNextAction: "stop_exact_tracked_holders",
          inspectionOwnershipClassification: "tracked_exact",
          inspectionPreviewProcessLeaseIds: "proc_preview_a,proc_preview_b"
        },
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    summary:
      "I couldn't move those folders yet because exact tracked preview holders are still keeping them busy.",
    startedAt: nowIso,
    completedAt
  });

  assert.equal(queued, true);
  assert.equal(session.queuedJobs.length, 1);
  assert.equal(session.queuedJobs[0]?.input, sourceInput);
  assert.match(
    session.queuedJobs[0]?.executionInput ?? "",
    /\[AUTOMATIC_TRACKED_WORKSPACE_RECOVERY\]/
  );
  assert.match(
    session.queuedJobs[0]?.executionInput ?? "",
    /\[WORKSPACE_RECOVERY_STOP_EXACT\]/
  );
  assert.equal(completedJob.recoveryTrace?.kind, "workspace_auto_recovery");
  assert.equal(completedJob.recoveryTrace?.status, "attempting");
  assert.match(
    session.queuedJobs[0]?.executionInput ?? "",
    /Stop only these exact preview holders/i
  );
  assert.equal(
    completedJob.resultSummary,
    "I found the exact tracked preview holders blocking those folders. I'm shutting down just those tracked holders and retrying now."
  );
});

test("enqueueAutomaticTrackedWorkspaceRecoveryRetry does not queue inspect-first recovery after a waiting-for-user clarification was already persisted", () => {
  const nowIso = "2026-03-15T19:00:00.000Z";
  const completedAt = "2026-03-15T19:00:05.000Z";
  const sourceInput =
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-auto-recovery-inspect-first",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.activeClarification = {
    id: "clarification-inspect-first",
    kind: "task_recovery",
    sourceInput,
    question:
      "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?",
    requestedAt: completedAt,
    matchedRuleId: "post_execution_locked_folder_recovery",
    recoveryInstruction:
      "Recovery instruction: inspect the relevant workspace resources or path holders first.",
    options: [
      {
        id: "continue_recovery",
        label: "Yes, inspect and continue"
      },
      {
        id: "cancel",
        label: "No, leave them alone"
      }
    ]
  };
  session.progressState = {
    status: "waiting_for_user",
    message:
      "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?",
    jobId: null,
    updatedAt: completedAt
  };
  session.conversationTurns.push(
    {
      role: "user",
      text: sourceInput,
      at: nowIso
    },
    {
      role: "assistant",
      text:
        "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?",
      at: completedAt
    }
  );

  const completedJob: ConversationJob = {
    ...buildQueuedJob(nowIso),
    input: sourceInput,
    executionInput: sourceInput,
    status: "completed",
    startedAt: nowIso,
    completedAt,
    resultSummary:
      "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?",
    errorMessage: null
  };

  const queued = enqueueAutomaticTrackedWorkspaceRecoveryRetry(session, completedJob, {
    task: {
      id: "task-auto-recovery-inspect-first",
      goal: sourceInput,
      userInput: sourceInput,
      createdAt: nowIso
    },
    plan: {
      taskId: "task-auto-recovery-inspect-first",
      plannerNotes: "Attempt move before exact holder proof exists.",
      actions: [
        {
          id: "action-move",
          type: "shell_command",
          description: "Move matching drone folders.",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action-move",
          type: "shell_command",
          description: "Move matching drone folders.",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: false,
        output:
          "Move-Item : The process cannot access the file because it is being used by another process.",
        blockedBy: [],
        violations: [
          {
            code: "ACTION_EXECUTION_FAILED",
            message:
              "The process cannot access the file because it is being used by another process."
          }
        ],
        votes: []
      }
    ],
    summary:
      "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?",
    startedAt: nowIso,
    completedAt
  });

  assert.equal(queued, false);
  assert.equal(session.queuedJobs.length, 0);
  assert.equal(session.activeClarification?.kind, "task_recovery");
  assert.equal(session.progressState?.status, "waiting_for_user");
  assert.equal(
    completedJob.resultSummary,
    "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?"
  );
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?"
  );
});

test("enqueueAutomaticTrackedWorkspaceRecoveryRetry does not queue behind newer queued user work", () => {
  const nowIso = "2026-03-20T14:00:00.000Z";
  const completedAt = "2026-03-20T14:00:05.000Z";
  const sourceInput =
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-auto-recovery-newer-queued-work",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.queuedJobs.push({
    ...buildQueuedJob(nowIso),
    id: "job-follow-up",
    input: "Remember that I prefer dark mode.",
    executionInput: "Remember that I prefer dark mode."
  });
  session.conversationTurns.push(
    {
      role: "user",
      text: sourceInput,
      at: nowIso
    },
    {
      role: "assistant",
      text:
        "I couldn't move those folders yet because exact tracked preview holders are still keeping them busy.",
      at: completedAt
    }
  );

  const completedJob: ConversationJob = {
    ...buildQueuedJob(nowIso),
    input: sourceInput,
    executionInput: sourceInput,
    status: "completed",
    startedAt: nowIso,
    completedAt,
    resultSummary:
      "I couldn't move those folders yet because exact tracked preview holders are still keeping them busy.",
    errorMessage: null
  };

  const queued = enqueueAutomaticTrackedWorkspaceRecoveryRetry(session, completedJob, {
    task: {
      id: "task-auto-recovery-newer-queued-work",
      goal: sourceInput,
      userInput: sourceInput,
      createdAt: nowIso
    },
    plan: {
      taskId: "task-auto-recovery-newer-queued-work",
      plannerNotes: "Inspect exact holders and recover.",
      actions: [
        {
          id: "action-inspect",
          type: "inspect_workspace_resources",
          description: "Inspect the blocked drone workspace resources.",
          params: {
            workspaceRoot: "C:\\Users\\testuser\\OneDrive\\Desktop\\drone-company-a"
          },
          estimatedCostUsd: 0.05
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action-shell",
          type: "shell_command",
          description: "Attempt the move.",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: false,
        output:
          "Move-Item : The process cannot access the file because it is being used by another process.",
        blockedBy: [],
        violations: [
          {
            code: "ACTION_EXECUTION_FAILED",
            message:
              "The process cannot access the file because it is being used by another process."
          }
        ],
        votes: []
      },
      {
        action: {
          id: "action-inspect",
          type: "inspect_workspace_resources",
          description: "Inspect the blocked drone workspace resources.",
          params: {
            workspaceRoot: "C:\\Users\\testuser\\OneDrive\\Desktop\\drone-company-a"
          },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: true,
        output: "Inspection complete.",
        executionMetadata: {
          runtimeOwnershipInspection: true,
          inspectionRecommendedNextAction: "stop_exact_tracked_holders",
          inspectionOwnershipClassification: "tracked_exact",
          inspectionPreviewProcessLeaseIds: "proc_preview_a,proc_preview_b"
        },
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    summary:
      "I couldn't move those folders yet because exact tracked preview holders are still keeping them busy.",
    startedAt: nowIso,
    completedAt
  });

  assert.equal(queued, false);
  assert.equal(session.queuedJobs.length, 1);
  assert.equal(session.queuedJobs[0]?.id, "job-follow-up");
  assert.equal(
    completedJob.resultSummary,
    "I couldn't move those folders yet because exact tracked preview holders are still keeping them busy."
  );
});

test("enqueueAutomaticTrackedWorkspaceRecoveryRetry promotes live tracked workspace holders directly into exact recovery", () => {
  const nowIso = "2026-03-15T19:10:00.000Z";
  const completedAt = "2026-03-15T19:10:05.000Z";
  const sourceInput =
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.";
  const workspaceRootA = "C:\\Users\\testuser\\OneDrive\\Desktop\\drone-company-a";
  const workspaceRootB = "C:\\Users\\testuser\\OneDrive\\Desktop\\drone-company-b";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-auto-recovery-exact-from-session",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });
  session.activeWorkspace = {
    id: `workspace:${workspaceRootA}`,
    label: "Current project workspace",
    rootPath: workspaceRootA,
    primaryArtifactPath: `${workspaceRootA}\\index.html`,
    previewUrl: "http://localhost:4177/index.html",
    browserSessionId: "browser_session:a",
    browserSessionIds: ["browser_session:a", "browser_session:b"],
    browserSessionStatus: "open",
    browserProcessPid: null,
    previewProcessLeaseId: "proc_preview_a",
    previewProcessLeaseIds: ["proc_preview_a", "proc_preview_b"],
    previewProcessCwd: workspaceRootA,
    lastKnownPreviewProcessPid: 4111,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_and_preview",
    lastChangedPaths: [`${workspaceRootA}\\index.html`],
    sourceJobId: "job-seed",
    updatedAt: completedAt
  };
  session.browserSessions = [
    {
      id: "browser_session:a",
      label: "Browser window",
      url: "http://localhost:4177/index.html",
      status: "open",
      openedAt: nowIso,
      closedAt: null,
      sourceJobId: "job-seed-a",
      visibility: "visible",
      controllerKind: "playwright_managed",
      controlAvailable: true,
      browserProcessPid: null,
      workspaceRootPath: workspaceRootA,
      linkedProcessLeaseId: "proc_preview_a",
      linkedProcessCwd: workspaceRootA,
      linkedProcessPid: 4111
    },
    {
      id: "browser_session:b",
      label: "Browser window",
      url: "http://localhost:4178/index.html",
      status: "open",
      openedAt: nowIso,
      closedAt: null,
      sourceJobId: "job-seed-b",
      visibility: "visible",
      controllerKind: "playwright_managed",
      controlAvailable: true,
      browserProcessPid: null,
      workspaceRootPath: workspaceRootB,
      linkedProcessLeaseId: "proc_preview_b",
      linkedProcessCwd: workspaceRootB,
      linkedProcessPid: 4222
    }
  ];
  session.activeClarification = {
    id: "clarification-exact-from-session",
    kind: "task_recovery",
    sourceInput,
    question:
      "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?",
    requestedAt: completedAt,
    matchedRuleId: "post_execution_locked_folder_recovery",
    recoveryInstruction:
      "Recovery instruction: inspect the relevant workspace resources or path holders first.",
    options: [
      {
        id: "continue_recovery",
        label: "Yes, inspect and continue"
      },
      {
        id: "cancel",
        label: "No, leave them alone"
      }
    ]
  };
  session.progressState = {
    status: "waiting_for_user",
    message:
      "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?",
    jobId: null,
    updatedAt: completedAt
  };
  session.conversationTurns.push(
    {
      role: "user",
      text: sourceInput,
      at: nowIso
    },
    {
      role: "assistant",
      text:
        "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?",
      at: completedAt
    }
  );

  const completedJob: ConversationJob = {
    ...buildQueuedJob(nowIso),
    input: sourceInput,
    executionInput: sourceInput,
    status: "completed",
    startedAt: nowIso,
    completedAt,
    resultSummary:
      "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?",
    errorMessage: null
  };

  const queued = enqueueAutomaticTrackedWorkspaceRecoveryRetry(session, completedJob, {
    task: {
      id: "task-auto-recovery-exact-from-session",
      goal: sourceInput,
      userInput: sourceInput,
      createdAt: nowIso
    },
    plan: {
      taskId: "task-auto-recovery-exact-from-session",
      plannerNotes: "Attempt move before exact holder proof exists.",
      actions: [
        {
          id: "action-move",
          type: "shell_command",
          description: "Move matching drone folders.",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action-move",
          type: "shell_command",
          description: "Move matching drone folders.",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: false,
        output: [
          "Move-Item : The process cannot access the file because it is being used by another process.",
          `    + CategoryInfo          : WriteError: (${workspaceRootA}:DirectoryInfo) [Move-Item], IOException`,
          `    + CategoryInfo          : WriteError: (${workspaceRootB}:DirectoryInfo) [Move-Item], IOException`
        ].join("\n"),
        blockedBy: [],
        violations: [
          {
            code: "ACTION_EXECUTION_FAILED",
            message:
              "The process cannot access the file because it is being used by another process."
          }
        ],
        votes: []
      }
    ],
    summary:
      "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?",
    startedAt: nowIso,
    completedAt
  });

  assert.equal(queued, true);
  assert.equal(session.queuedJobs.length, 1);
  assert.match(
    session.queuedJobs[0]?.executionInput ?? "",
    /\[AUTOMATIC_TRACKED_WORKSPACE_RECOVERY\]/
  );
  assert.match(
    session.queuedJobs[0]?.executionInput ?? "",
    /\[WORKSPACE_RECOVERY_STOP_EXACT\]/
  );
  assert.match(
    session.queuedJobs[0]?.executionInput ?? "",
    /proc_preview_a/
  );
  assert.match(
    session.queuedJobs[0]?.executionInput ?? "",
    /proc_preview_b/
  );
  assert.equal(
    completedJob.resultSummary,
    "I found the exact tracked preview holders blocking those folders. I'm shutting down just those tracked holders and retrying now."
  );
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    "I found the exact tracked preview holders blocking those folders. I'm shutting down just those tracked holders and retrying now."
  );
});

test("deriveWorkspaceRecoverySignal recovers blocked desktop folder paths from PowerShell move errors", async () => {
  const sourceInput =
    "Every folder with the name beginning in drone should go in drone-folder on my desktop.";
  const originalOneDrive = process.env.OneDrive;
  const originalUserProfile = process.env.USERPROFILE;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-workspace-recovery-"));
  const oneDriveRoot = path.join(tempRoot, "OneDrive");
  const desktopRoot = path.join(oneDriveRoot, "Desktop");
  await mkdir(path.join(desktopRoot, "drone-company"), { recursive: true });
  await mkdir(path.join(desktopRoot, "drone-company-live-smoke-1773407921176"), {
    recursive: true
  });
  process.env.OneDrive = oneDriveRoot;
  process.env.USERPROFILE = tempRoot;
  const taskRunResult: TaskRunResult = {
    task: {
      id: "task-auto-recovery-paths",
      goal: sourceInput,
      userInput: sourceInput,
      createdAt: "2026-03-14T23:00:00.000Z"
    },
    plan: {
      taskId: "task-auto-recovery-paths",
      plannerNotes: "Move matching drone folders.",
      actions: [
        {
          id: "action-shell",
          type: "shell_command",
          description: "Move matching drone folders.",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action-shell",
          type: "shell_command",
          description: "Move matching drone folders.",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: false,
        output: [
          "Shell failed:",
          "Move-Item : The process cannot access the file because it is being used by another process.",
          "    + CategoryInfo          : WriteError: (C:\\Users\\testuser\\...p\\drone-company:DirectoryInfo) [Move-Item], IOException",
          "    + CategoryInfo          : WriteError: (C:\\Users\\testuser\\...e-1773407921176:DirectoryInfo) [Move-Item], IOException"
        ].join("\n"),
        blockedBy: [],
        violations: [
          {
            code: "ACTION_EXECUTION_FAILED",
            message:
              "The process cannot access the file because it is being used by another process."
          }
        ],
        votes: []
      }
    ],
    summary: "The move failed because the folders are still in use.",
    startedAt: "2026-03-14T23:00:01.000Z",
    completedAt: "2026-03-14T23:00:05.000Z"
  };

  try {
    const signal = deriveWorkspaceRecoverySignal(taskRunResult);

    assert.ok(signal);
    assert.deepEqual(signal.blockedFolderPaths, [
      path.join(desktopRoot, "drone-company"),
      path.join(desktopRoot, "drone-company-live-smoke-1773407921176")
    ]);
    assert.match(
      buildWorkspaceRecoveryNextUserInput(sourceInput, signal),
      new RegExp(
        `Blocked folder paths:\\s*- ${path.join(desktopRoot, "drone-company").replace(/\\/g, "\\\\")}\\s*- ${path.join(desktopRoot, "drone-company-live-smoke-1773407921176").replace(/\\/g, "\\\\")}`,
        "i"
      )
    );
  } finally {
    process.env.OneDrive = originalOneDrive;
    process.env.USERPROFILE = originalUserProfile;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("deriveWorkspaceRecoverySignal recovers blocked desktop folder paths from remainingOnDesktop JSON output", async () => {
  const sourceInput =
    "Every folder with the name beginning in drone should go in drone-folder on my desktop.";
  const originalOneDrive = process.env.OneDrive;
  const originalUserProfile = process.env.USERPROFILE;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-workspace-recovery-json-"));
  const oneDriveRoot = path.join(tempRoot, "OneDrive");
  const desktopRoot = path.join(oneDriveRoot, "Desktop");
  await mkdir(path.join(desktopRoot, "drone-company"), { recursive: true });
  await mkdir(path.join(desktopRoot, "drone-company-live-smoke-1773407921176"), {
    recursive: true
  });
  process.env.OneDrive = oneDriveRoot;
  process.env.USERPROFILE = tempRoot;

  const taskRunResult: TaskRunResult = {
    task: {
      id: "task-auto-recovery-json-paths",
      goal: sourceInput,
      userInput: sourceInput,
      createdAt: "2026-03-14T23:05:00.000Z"
    },
    plan: {
      taskId: "task-auto-recovery-json-paths",
      plannerNotes: "Move matching drone folders.",
      actions: [
        {
          id: "action-shell",
          type: "shell_command",
          description: "Move matching drone folders.",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action-shell",
          type: "shell_command",
          description: "Move matching drone folders.",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: true,
        output: [
          "Shell success:",
          JSON.stringify({
            destination: `${desktopRoot}\\drone-folder`,
            matchedBefore: ["drone-company", "drone-company-live-smoke-1773407921176"],
            moved: [],
            failed: [
              {
                name: null,
                error: "The process cannot access the file because it is being used by another process."
              }
            ],
            remainingOnDesktop: ["drone-company", "drone-company-live-smoke-1773407921176"]
          })
        ].join("\n"),
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    summary: "The move left locked folders on Desktop.",
    startedAt: "2026-03-14T23:05:01.000Z",
    completedAt: "2026-03-14T23:05:05.000Z"
  };

  try {
    const signal = deriveWorkspaceRecoverySignal(taskRunResult);

    assert.ok(signal);
    assert.deepEqual(signal.blockedFolderPaths, [
      path.join(desktopRoot, "drone-company"),
      path.join(desktopRoot, "drone-company-live-smoke-1773407921176")
    ]);
  } finally {
    process.env.OneDrive = originalOneDrive;
    process.env.USERPROFILE = originalUserProfile;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("deriveWorkspaceRecoverySignal recovers blocked desktop folder paths from capitalized shell JSON output", async () => {
  const sourceInput =
    "Every folder with the name beginning in drone should go in drone-folder on my desktop.";
  const originalOneDrive = process.env.OneDrive;
  const originalUserProfile = process.env.USERPROFILE;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-workspace-recovery-json-caps-"));
  const oneDriveRoot = path.join(tempRoot, "OneDrive");
  const desktopRoot = path.join(oneDriveRoot, "Desktop");
  await mkdir(path.join(desktopRoot, "drone-company"), { recursive: true });
  await mkdir(path.join(desktopRoot, "drone-company-live-smoke-1773407921176"), {
    recursive: true
  });
  process.env.OneDrive = oneDriveRoot;
  process.env.USERPROFILE = tempRoot;

  const taskRunResult: TaskRunResult = {
    task: {
      id: "task-auto-recovery-json-caps-paths",
      goal: sourceInput,
      userInput: sourceInput,
      createdAt: "2026-03-14T23:10:00.000Z"
    },
    plan: {
      taskId: "task-auto-recovery-json-caps-paths",
      plannerNotes: "Move matching drone folders.",
      actions: [
        {
          id: "action-shell",
          type: "shell_command",
          description: "Move matching drone folders.",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action-shell",
          type: "shell_command",
          description: "Move matching drone folders.",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: true,
        output: [
          "Shell success:",
          JSON.stringify({
            Source: `${desktopRoot}`,
            Destination: `${desktopRoot}\\drone-folder`,
            Failed: [
              "drone-company: The process cannot access the file because it is being used by another process."
            ],
            RemainingInSource: ["drone-company", "drone-company-live-smoke-1773407921176"]
          })
        ].join("\n"),
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    summary: "The move left locked folders on Desktop.",
    startedAt: "2026-03-14T23:10:01.000Z",
    completedAt: "2026-03-14T23:10:05.000Z"
  };

  try {
    const signal = deriveWorkspaceRecoverySignal(taskRunResult);

    assert.ok(signal);
    assert.deepEqual(signal.blockedFolderPaths, [
      path.join(desktopRoot, "drone-company"),
      path.join(desktopRoot, "drone-company-live-smoke-1773407921176")
    ]);
  } finally {
    process.env.OneDrive = originalOneDrive;
    process.env.USERPROFILE = originalUserProfile;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("deriveWorkspaceRecoverySignal recovers blocked desktop folder paths from item plus remainingDroneDirsOnDesktop JSON output", async () => {
  const sourceInput =
    "Every folder with the name beginning in drone should go in drone-folder on my desktop.";
  const originalOneDrive = process.env.OneDrive;
  const originalUserProfile = process.env.USERPROFILE;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-workspace-recovery-json-item-"));
  const oneDriveRoot = path.join(tempRoot, "OneDrive");
  const desktopRoot = path.join(oneDriveRoot, "Desktop");
  await mkdir(path.join(desktopRoot, "drone-company"), { recursive: true });
  await mkdir(path.join(desktopRoot, "drone-company-live-smoke-1773407921176"), {
    recursive: true
  });
  await mkdir(path.join(desktopRoot, "drone-company-live-smoke-1773414171194"), {
    recursive: true
  });
  process.env.OneDrive = oneDriveRoot;
  process.env.USERPROFILE = tempRoot;

  const taskRunResult: TaskRunResult = {
    task: {
      id: "task-auto-recovery-json-item-paths",
      goal: sourceInput,
      userInput: sourceInput,
      createdAt: "2026-03-14T23:15:00.000Z"
    },
    plan: {
      taskId: "task-auto-recovery-json-item-paths",
      plannerNotes: "Move matching drone folders.",
      actions: [
        {
          id: "action-shell",
          type: "shell_command",
          description: "Move matching drone folders.",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action-shell",
          type: "shell_command",
          description: "Move matching drone folders.",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: true,
        output: [
          "Shell success:",
          JSON.stringify({
            desktop: `${desktopRoot}`,
            destination: `${desktopRoot}\\drone-folder`,
            failed: [
              {
                item: `${desktopRoot}\\drone-company`,
                error: "The process cannot access the file because it is being used by another process."
              },
              {
                item: `${desktopRoot}\\drone-company-live-smoke-1773407921176`,
                error: "The process cannot access the file because it is being used by another process."
              }
            ],
            remainingDroneDirsOnDesktop: [
              "drone-company",
              "drone-company-live-smoke-1773407921176",
              "drone-company-live-smoke-1773414171194"
            ]
          })
        ].join("\n"),
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    summary: "The move left locked folders on Desktop.",
    startedAt: "2026-03-14T23:15:01.000Z",
    completedAt: "2026-03-14T23:15:05.000Z"
  };

  try {
    const signal = deriveWorkspaceRecoverySignal(taskRunResult);

    assert.ok(signal);
    assert.deepEqual(signal.blockedFolderPaths, [
      path.join(desktopRoot, "drone-company"),
      path.join(desktopRoot, "drone-company-live-smoke-1773407921176"),
      path.join(desktopRoot, "drone-company-live-smoke-1773414171194")
    ]);
  } finally {
    process.env.OneDrive = originalOneDrive;
    process.env.USERPROFILE = originalUserProfile;
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("deriveWorkspaceRecoverySignal aggregates inspection metadata across multiple blocked paths", () => {
  const sourceInput =
    "Every folder with the name beginning in drone should go in drone-folder on my desktop.";

  const signal = deriveWorkspaceRecoverySignal({
    task: {
      id: "task-auto-recovery-inspection-aggregate",
      goal: sourceInput,
      userInput: sourceInput,
      createdAt: "2026-03-14T23:20:00.000Z"
    },
    plan: {
      taskId: "task-auto-recovery-inspection-aggregate",
      plannerNotes: "Inspect holders.",
      actions: []
    },
    actionResults: [
      {
        action: {
          id: "action-shell",
          type: "shell_command",
          description: "Move matching drone folders.",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: true,
        output: JSON.stringify({
          desktop: "C:\\Users\\testuser\\OneDrive\\Desktop",
          destination: "C:\\Users\\testuser\\OneDrive\\Desktop\\drone-folder",
          failed: [
            {
              item: "C:\\Users\\testuser\\OneDrive\\Desktop\\drone-company",
              error: "The process cannot access the file because it is being used by another process."
            }
          ],
          remainingDroneDirsOnDesktop: ["drone-company", "drone-company-live-smoke-1773407921176"]
        }),
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action-inspect-exact",
          type: "inspect_path_holders",
          description: "Inspect first blocked path.",
          params: {
            path: "C:\\Users\\testuser\\OneDrive\\Desktop\\drone-company"
          },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: true,
        output: "Inspection complete.",
        blockedBy: [],
        violations: [],
        votes: [],
        executionMetadata: {
          runtimeOwnershipInspection: true,
          inspectionRecommendedNextAction: "stop_exact_tracked_holders",
          inspectionOwnershipClassification: "current_tracked",
          inspectionPreviewProcessLeaseIds: "proc_preview_exact",
          inspectionUntrackedCandidatePids: ""
        }
      },
      {
        action: {
          id: "action-inspect-unknown",
          type: "inspect_path_holders",
          description: "Inspect second blocked path.",
          params: {
            path: "C:\\Users\\testuser\\OneDrive\\Desktop\\drone-company-live-smoke-1773407921176"
          },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: true,
        output: "Inspection complete.",
        blockedBy: [],
        violations: [],
        votes: [],
        executionMetadata: {
          runtimeOwnershipInspection: true,
          inspectionRecommendedNextAction: "collect_more_evidence",
          inspectionOwnershipClassification: "unknown",
          inspectionPreviewProcessLeaseIds: "",
          inspectionUntrackedCandidatePids: ""
        }
      }
    ],
    summary: "The move left locked folders on Desktop.",
    startedAt: "2026-03-14T23:20:01.000Z",
    completedAt: "2026-03-14T23:20:05.000Z"
  });

  assert.ok(signal);
  assert.equal(signal.recommendedAction, "stop_exact_tracked_holders");
  assert.deepEqual(signal.trackedPreviewProcessLeaseIds, ["proc_preview_exact"]);
});

test("deriveWorkspaceRecoverySignal promotes exact tracked holder shutdown directly from recovery context", () => {
  const blockedFolderPath = "C:\\Users\\testuser\\Desktop\\drone-company-organize-smoke-a";
  const userInput = [
    "Workspace recovery context for this chat:",
    `- Preferred workspace root: ${blockedFolderPath}`,
    "- Exact tracked preview lease ids: proc_preview_a",
    "",
    "Current user request:",
    'Please take this from start to finish: move the earlier drone-company-organize-smoke project folders into a folder called drone-web-projects on my desktop.'
  ].join("\n");
  const signal = deriveWorkspaceRecoverySignal({
    task: {
      id: "task-auto-recovery-context-promotion",
      goal: userInput,
      userInput,
      createdAt: "2026-03-15T21:00:00.000Z"
    },
    plan: {
      taskId: "task-auto-recovery-context-promotion",
      plannerNotes: "Move matching drone folders.",
      actions: [
        {
          id: "action-shell",
          type: "shell_command",
          description: "Move matching drone folders.",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action-shell",
          type: "shell_command",
          description: "Move matching drone folders.",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: false,
        output: [
          "Shell failed:",
          "Move-Item : The process cannot access the file because it is being used by another process.",
          `Path : ${blockedFolderPath}`
        ].join("\n"),
        blockedBy: [],
        violations: [
          {
            code: "ACTION_EXECUTION_FAILED",
            message:
              "The process cannot access the file because it is being used by another process."
          }
        ],
        votes: []
      }
    ],
    summary: "The move failed because the folder is still in use.",
    startedAt: "2026-03-15T21:00:01.000Z",
    completedAt: "2026-03-15T21:00:05.000Z"
  });

  assert.ok(signal);
  assert.equal(signal.recommendedAction, "stop_exact_tracked_holders");
  assert.deepEqual(signal.trackedPreviewProcessLeaseIds, ["proc_preview_a"]);
  assert.deepEqual(signal.blockedFolderPaths, [blockedFolderPath]);
});

test("enqueueAutomaticTrackedWorkspaceRecoveryRetry does not queue a post-shutdown retry when the move was already proven", () => {
  const nowIso = "2026-03-14T22:20:00.000Z";
  const completedAt = "2026-03-14T22:20:05.000Z";
  const sourceInput =
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.";
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-auto-recovery-2",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: nowIso
  });

  const completedJob: ConversationJob = {
    ...buildQueuedJob(nowIso),
    input: sourceInput,
    executionInput: sourceInput,
    status: "completed",
    startedAt: nowIso,
    completedAt,
    resultSummary:
      "I moved the matching folders into C:\\Users\\testuser\\OneDrive\\Desktop\\drone-web-projects.",
    errorMessage: null
  };

  const queued = enqueueAutomaticTrackedWorkspaceRecoveryRetry(session, completedJob, {
    task: {
      id: "task-auto-recovery-2",
      goal: sourceInput,
      userInput: sourceInput,
      createdAt: nowIso
    },
    plan: {
      taskId: "task-auto-recovery-2",
      plannerNotes: "Stop holders, move folders, verify destination.",
      actions: [
        {
          id: "action-stop-a",
          type: "stop_process",
          description: "Stop exact preview holder.",
          params: {
            leaseId: "proc_preview_a"
          },
          estimatedCostUsd: 0.03
        },
        {
          id: "action-move",
          type: "shell_command",
          description: "Move matching drone folders.",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        {
          id: "action-verify-destination",
          type: "list_directory",
          description: "Inspect destination folder.",
          params: {
            path: "C:\\Users\\testuser\\OneDrive\\Desktop\\drone-web-projects"
          },
          estimatedCostUsd: 0.05
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action-stop-a",
          type: "stop_process",
          description: "Stop exact preview holder.",
          params: {
            leaseId: "proc_preview_a"
          },
          estimatedCostUsd: 0.03
        },
        mode: "escalation_path",
        approved: true,
        output: "Process stopped: lease proc_preview_a.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action-move",
          type: "shell_command",
          description: "Move matching drone folders.",
          params: {
            command: "Move-Item ..."
          },
          estimatedCostUsd: 0.18
        },
        mode: "escalation_path",
        approved: true,
        output: "Shell success: moved matching drone-company folders.",
        blockedBy: [],
        violations: [],
        votes: []
      },
      {
        action: {
          id: "action-verify-destination",
          type: "list_directory",
          description: "Inspect destination folder.",
          params: {
            path: "C:\\Users\\testuser\\OneDrive\\Desktop\\drone-web-projects"
          },
          estimatedCostUsd: 0.05
        },
        mode: "fast_path",
        approved: true,
        output: "Directory contents:\ndrone-company-a\ndrone-company-b",
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    summary:
      "I moved the matching folders into C:\\Users\\testuser\\OneDrive\\Desktop\\drone-web-projects.",
    startedAt: nowIso,
    completedAt
  });

  assert.equal(queued, false);
  assert.equal(session.queuedJobs.length, 0);
  assert.equal(
    completedJob.resultSummary,
    "I moved the matching folders into C:\\Users\\testuser\\OneDrive\\Desktop\\drone-web-projects."
  );
});
