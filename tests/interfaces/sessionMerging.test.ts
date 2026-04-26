import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyDomainSignalWindow,
  createEmptyConversationDomainContext
} from "../../src/core/sessionContext";
import { buildConversationSessionFixture } from "../helpers/conversationFixtures";
import { mergeConversationSession } from "../../src/interfaces/conversationRuntime/sessionMerging";
import type { ConversationSession } from "../../src/interfaces/sessionStore";

function buildSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return buildConversationSessionFixture(
    {
      updatedAt: "2026-03-07T12:00:00.000Z",
      ...overrides
    },
    {
      conversationId: "chat-1",
      receivedAt: "2026-03-07T12:00:00.000Z"
    }
  );
}

test("mergeConversationSession removes completed jobs from the queued list", () => {
  const existing = buildSession({
    runningJobId: "job-1",
    queuedJobs: [
      {
        id: "job-1",
        input: "run task",
        createdAt: "2026-03-07T12:00:00.000Z",
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
    ]
  });
  const incoming = buildSession({
    updatedAt: "2026-03-07T12:05:00.000Z",
    recentJobs: [
      {
        id: "job-1",
        input: "run task",
        createdAt: "2026-03-07T12:00:00.000Z",
        startedAt: "2026-03-07T12:01:00.000Z",
        completedAt: "2026-03-07T12:04:00.000Z",
        status: "completed",
        resultSummary: "done",
        errorMessage: null,
        ackTimerGeneration: 0,
        ackEligibleAt: null,
        ackLifecycleState: "FINAL_SENT_NO_EDIT",
        ackMessageId: "ack-1",
        ackSentAt: "2026-03-07T12:01:00.000Z",
        ackEditAttemptCount: 0,
        ackLastErrorCode: null,
        finalDeliveryOutcome: "sent",
        finalDeliveryAttemptCount: 1,
        finalDeliveryLastErrorCode: null,
        finalDeliveryLastAttemptAt: "2026-03-07T12:04:30.000Z"
      }
    ]
  });

  const merged = mergeConversationSession(existing, incoming);
  assert.equal(merged.queuedJobs.length, 0);
  assert.equal(merged.recentJobs.length, 1);
  assert.equal(merged.runningJobId, null);
});

test("mergeConversationSession removes queued duplicates once the same job is already running in recent jobs", () => {
  const existing = buildSession({
    runningJobId: "job-1",
    queuedJobs: [
      {
        id: "job-1",
        input: "run task",
        createdAt: "2026-03-07T12:00:00.000Z",
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
    recentJobs: [
      {
        id: "job-1",
        input: "run task",
        createdAt: "2026-03-07T12:00:00.000Z",
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
    ]
  });
  const incoming = buildSession({
    updatedAt: "2026-03-07T12:01:00.000Z",
    runningJobId: "job-1",
    queuedJobs: [],
    recentJobs: [
      {
        id: "job-1",
        input: "run task",
        createdAt: "2026-03-07T12:00:00.000Z",
        startedAt: "2026-03-07T12:01:00.000Z",
        completedAt: null,
        status: "running",
        resultSummary: null,
        errorMessage: null,
        ackTimerGeneration: 0,
        ackEligibleAt: "2026-03-07T12:01:00.300Z",
        ackLifecycleState: "SENT",
        ackMessageId: "ack-1",
        ackSentAt: "2026-03-07T12:01:00.000Z",
        ackEditAttemptCount: 0,
        ackLastErrorCode: null,
        finalDeliveryOutcome: "not_attempted",
        finalDeliveryAttemptCount: 0,
        finalDeliveryLastErrorCode: null,
        finalDeliveryLastAttemptAt: null
      }
    ]
  });

  const merged = mergeConversationSession(existing, incoming);
  assert.equal(merged.runningJobId, "job-1");
  assert.equal(merged.queuedJobs.length, 0);
  assert.equal(merged.recentJobs[0]?.status, "running");
});

test("mergeConversationSession clears stale working progress when no runnable job remains", () => {
  const existing = buildSession({
    runningJobId: "job-1",
    progressState: {
      status: "working",
      message: "Working on it",
      jobId: "job-1",
      updatedAt: "2026-03-07T12:01:00.000Z"
    },
    recentJobs: [
      {
        id: "job-1",
        input: "run task",
        createdAt: "2026-03-07T12:00:00.000Z",
        startedAt: "2026-03-07T12:01:00.000Z",
        completedAt: null,
        status: "running",
        resultSummary: null,
        errorMessage: null,
        ackTimerGeneration: 0,
        ackEligibleAt: null,
        ackLifecycleState: "SENT",
        ackMessageId: "ack-1",
        ackSentAt: "2026-03-07T12:01:00.000Z",
        ackEditAttemptCount: 0,
        ackLastErrorCode: null,
        finalDeliveryOutcome: "not_attempted",
        finalDeliveryAttemptCount: 0,
        finalDeliveryLastErrorCode: null,
        finalDeliveryLastAttemptAt: null
      }
    ]
  });
  const incoming = buildSession({
    updatedAt: "2026-03-07T12:05:00.000Z",
    progressState: null,
    runningJobId: null,
    recentJobs: [
      {
        id: "job-1",
        input: "run task",
        createdAt: "2026-03-07T12:00:00.000Z",
        startedAt: "2026-03-07T12:01:00.000Z",
        completedAt: "2026-03-07T12:04:00.000Z",
        status: "completed",
        resultSummary: "done",
        errorMessage: null,
        ackTimerGeneration: 0,
        ackEligibleAt: null,
        ackLifecycleState: "FINAL_SENT_NO_EDIT",
        ackMessageId: "ack-1",
        ackSentAt: "2026-03-07T12:01:00.000Z",
        ackEditAttemptCount: 0,
        ackLastErrorCode: null,
        finalDeliveryOutcome: "sent",
        finalDeliveryAttemptCount: 1,
        finalDeliveryLastErrorCode: null,
        finalDeliveryLastAttemptAt: "2026-03-07T12:04:30.000Z"
      }
    ]
  });

  const merged = mergeConversationSession(existing, incoming);
  assert.equal(merged.runningJobId, null);
  assert.equal(merged.progressState, null);
});

test("mergeConversationSession preserves terminal autonomous progress after work is no longer running", () => {
  const existing = buildSession({
    runningJobId: "job-1",
    progressState: {
      status: "verifying",
      message: "Verifying the local preview.",
      jobId: "job-1",
      updatedAt: "2026-03-07T12:03:00.000Z"
    },
    recentJobs: [
      {
        id: "job-1",
        input: "run task",
        createdAt: "2026-03-07T12:00:00.000Z",
        startedAt: "2026-03-07T12:01:00.000Z",
        completedAt: null,
        status: "running",
        resultSummary: null,
        errorMessage: null,
        ackTimerGeneration: 0,
        ackEligibleAt: null,
        ackLifecycleState: "SENT",
        ackMessageId: "ack-1",
        ackSentAt: "2026-03-07T12:01:00.000Z",
        ackEditAttemptCount: 0,
        ackLastErrorCode: null,
        finalDeliveryOutcome: "not_attempted",
        finalDeliveryAttemptCount: 0,
        finalDeliveryLastErrorCode: null,
        finalDeliveryLastAttemptAt: null
      }
    ]
  });
  const incoming = buildSession({
    updatedAt: "2026-03-07T12:05:00.000Z",
    progressState: {
      status: "completed",
      message: "Finished the autonomous run cleanly.",
      jobId: null,
      updatedAt: "2026-03-07T12:04:30.000Z"
    },
    runningJobId: null,
    recentJobs: [
      {
        id: "job-1",
        input: "run task",
        createdAt: "2026-03-07T12:00:00.000Z",
        startedAt: "2026-03-07T12:01:00.000Z",
        completedAt: "2026-03-07T12:04:00.000Z",
        status: "completed",
        resultSummary: "done",
        errorMessage: null,
        ackTimerGeneration: 0,
        ackEligibleAt: null,
        ackLifecycleState: "FINAL_SENT_NO_EDIT",
        ackMessageId: "ack-1",
        ackSentAt: "2026-03-07T12:01:00.000Z",
        ackEditAttemptCount: 0,
        ackLastErrorCode: null,
        finalDeliveryOutcome: "sent",
        finalDeliveryAttemptCount: 1,
        finalDeliveryLastErrorCode: null,
        finalDeliveryLastAttemptAt: "2026-03-07T12:04:30.000Z"
      }
    ]
  });

  const merged = mergeConversationSession(existing, incoming);
  assert.equal(merged.runningJobId, null);
  assert.deepEqual(merged.progressState, {
    status: "completed",
    message: "Finished the autonomous run cleanly.",
    jobId: null,
    updatedAt: "2026-03-07T12:04:30.000Z"
  });
});

test("mergeConversationSession preserves linked preview-process context when a newer browser session update omits it", () => {
  const existing = buildSession({
    browserSessions: [
      {
        id: "browser_session:landing-page",
        label: "Landing page preview",
        url: "http://127.0.0.1:4173/",
        status: "open",
        openedAt: "2026-03-07T12:01:00.000Z",
        closedAt: null,
        sourceJobId: "job-1",
        visibility: "visible",
        controllerKind: "playwright_managed",
        controlAvailable: true,
        browserProcessPid: 42001,
        workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
        linkedProcessLeaseId: "proc_preview_1",
        linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company",
        linkedProcessPid: 43125
      }
    ]
  });
  const incoming = buildSession({
    updatedAt: "2026-03-07T12:05:00.000Z",
    browserSessions: [
      {
        id: "browser_session:landing-page",
        label: "Landing page preview",
        url: "http://127.0.0.1:4173/",
        status: "open",
        openedAt: "2026-03-07T12:04:00.000Z",
        closedAt: null,
        sourceJobId: "job-2",
        visibility: "visible",
        controllerKind: "playwright_managed",
        controlAvailable: true,
        browserProcessPid: null,
        workspaceRootPath: null,
        linkedProcessLeaseId: null,
        linkedProcessCwd: null,
        linkedProcessPid: null
      }
    ]
  });

  const merged = mergeConversationSession(existing, incoming);
  assert.equal(merged.browserSessions[0]?.browserProcessPid, 42001);
  assert.equal(
    merged.browserSessions[0]?.workspaceRootPath,
    "C:\\Users\\testuser\\Desktop\\sample-company"
  );
  assert.equal(merged.browserSessions[0]?.linkedProcessLeaseId, "proc_preview_1");
  assert.equal(
    merged.browserSessions[0]?.linkedProcessCwd,
    "C:\\Users\\testuser\\Desktop\\sample-company"
  );
  assert.equal(merged.browserSessions[0]?.linkedProcessPid, 43125);
});

test("mergeConversationSession preserves the newer active workspace while backfilling missing continuity fields", () => {
  const existing = buildSession({
    activeWorkspace: {
      id: "workspace:sample-company",
      label: "Current project workspace",
      rootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      browserSessionId: "browser_session:landing-page",
      browserSessionIds: ["browser_session:landing-page"],
      browserSessionStatus: "open",
      browserProcessPid: 42001,
      previewProcessLeaseId: "proc_preview_1",
      previewProcessLeaseIds: ["proc_preview_1"],
      previewProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company",
      lastKnownPreviewProcessPid: 43125,
      stillControllable: true,
      ownershipState: "tracked",
      previewStackState: "browser_and_preview",
      lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
      sourceJobId: "job-1",
      updatedAt: "2026-03-13T12:00:00.000Z"
    }
  });
  const incoming = buildSession({
    updatedAt: "2026-03-13T12:05:00.000Z",
    activeWorkspace: {
      id: "workspace:sample-company",
      label: "Current project workspace",
      rootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: null,
      previewUrl: "http://127.0.0.1:4177/index.html",
      browserSessionId: "browser_session:landing-page",
      browserSessionIds: [],
      browserSessionStatus: "closed",
      browserProcessPid: null,
      previewProcessLeaseId: null,
      previewProcessLeaseIds: [],
      previewProcessCwd: null,
      lastKnownPreviewProcessPid: null,
      stillControllable: false,
      ownershipState: "stale",
      previewStackState: "detached",
      lastChangedPaths: [],
      sourceJobId: "job-2",
      updatedAt: "2026-03-13T12:05:00.000Z"
    }
  });

  const merged = mergeConversationSession(existing, incoming);
  assert.equal(merged.activeWorkspace?.browserSessionStatus, "closed");
  assert.equal(
    merged.activeWorkspace?.primaryArtifactPath,
    "C:\\Users\\testuser\\Desktop\\sample-company\\index.html"
  );
  assert.equal(merged.activeWorkspace?.previewProcessLeaseId, "proc_preview_1");
  assert.deepEqual(merged.activeWorkspace?.browserSessionIds, [
    "browser_session:landing-page"
  ]);
  assert.deepEqual(merged.activeWorkspace?.previewProcessLeaseIds, ["proc_preview_1"]);
  assert.equal(merged.activeWorkspace?.browserProcessPid, 42001);
  assert.equal(merged.activeWorkspace?.lastKnownPreviewProcessPid, 43125);
  assert.equal(merged.activeWorkspace?.stillControllable, false);
  assert.equal(merged.activeWorkspace?.ownershipState, "stale");
  assert.equal(merged.activeWorkspace?.previewStackState, "detached");
  assert.deepEqual(merged.activeWorkspace?.lastChangedPaths, [
    "C:\\Users\\testuser\\Desktop\\sample-company\\index.html"
  ]);
});

test("mergeConversationSession backfills active-workspace and handoff domain snapshots from the older matching record", () => {
  const existing = buildSession({
    activeWorkspace: {
      id: "workspace:sample-company",
      label: "Current project workspace",
      rootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: null,
      browserSessionId: null,
      browserSessionIds: [],
      browserSessionStatus: null,
      browserProcessPid: null,
      previewProcessLeaseId: null,
      previewProcessLeaseIds: [],
      previewProcessCwd: null,
      lastKnownPreviewProcessPid: null,
      stillControllable: false,
      ownershipState: "stale",
      previewStackState: "detached",
      lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
      sourceJobId: "job-1",
      domainSnapshotLane: "workflow",
      domainSnapshotRecordedAt: "2026-03-13T12:00:00.000Z",
      updatedAt: "2026-03-13T12:00:00.000Z"
    },
    returnHandoff: {
      id: "handoff:job-1",
      status: "completed",
      goal: "Finish the landing page",
      summary: "Ready for review.",
      nextSuggestedStep: null,
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: null,
      previewUrl: null,
      changedPaths: [],
      sourceJobId: "job-1",
      domainSnapshotLane: "workflow",
      domainSnapshotRecordedAt: "2026-03-13T12:00:00.000Z",
      updatedAt: "2026-03-13T12:00:00.000Z"
    }
  });
  const incoming = buildSession({
    updatedAt: "2026-03-13T12:05:00.000Z",
    activeWorkspace: {
      id: "workspace:sample-company",
      label: "Current project workspace",
      rootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
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
      stillControllable: false,
      ownershipState: "stale",
      previewStackState: "detached",
      lastChangedPaths: [],
      sourceJobId: "job-2",
      updatedAt: "2026-03-13T12:05:00.000Z"
    },
    returnHandoff: {
      id: "handoff:job-1",
      status: "completed",
      goal: "Finish the landing page",
      summary: "Ready for review.",
      nextSuggestedStep: null,
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: null,
      previewUrl: null,
      changedPaths: [],
      sourceJobId: "job-1",
      updatedAt: "2026-03-13T12:05:00.000Z"
    }
  });

  const merged = mergeConversationSession(existing, incoming);
  assert.equal(merged.activeWorkspace?.domainSnapshotLane, "workflow");
  assert.equal(
    merged.activeWorkspace?.domainSnapshotRecordedAt,
    "2026-03-13T12:00:00.000Z"
  );
  assert.equal(merged.returnHandoff?.domainSnapshotLane, "workflow");
  assert.equal(
    merged.returnHandoff?.domainSnapshotRecordedAt,
    "2026-03-13T12:00:00.000Z"
  );
});

test("mergeConversationSession trusts the newer workspace ownership state once control truth changes", () => {
  const existing = buildSession({
    activeWorkspace: {
      id: "workspace:sample-company",
      label: "Current project workspace",
      rootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "file:///C:/Users/testuser/Desktop/sample-company/index.html",
      browserSessionId: "browser_session:detached-preview",
      browserSessionIds: ["browser_session:detached-preview"],
      browserSessionStatus: "open",
      browserProcessPid: null,
      previewProcessLeaseId: null,
      previewProcessLeaseIds: [],
      previewProcessCwd: null,
      lastKnownPreviewProcessPid: null,
      stillControllable: false,
      ownershipState: "orphaned",
      previewStackState: "browser_only",
      lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
      sourceJobId: "job-1",
      updatedAt: "2026-03-13T12:00:00.000Z"
    }
  });
  const incoming = buildSession({
    updatedAt: "2026-03-13T12:05:00.000Z",
    activeWorkspace: {
      id: "workspace:sample-company",
      label: "Current project workspace",
      rootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
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
      stillControllable: false,
      ownershipState: "stale",
      previewStackState: "detached",
      lastChangedPaths: [],
      sourceJobId: "job-2",
      updatedAt: "2026-03-13T12:05:00.000Z"
    }
  });

  const merged = mergeConversationSession(existing, incoming);
  assert.equal(merged.activeWorkspace?.ownershipState, "stale");
  assert.equal(merged.activeWorkspace?.previewStackState, "detached");
  assert.equal(
    merged.activeWorkspace?.rootPath,
    "C:\\Users\\testuser\\Desktop\\sample-company"
  );
});

test("mergeConversationSession does not backfill stale preview continuity into a newer different workspace", () => {
  const existing = buildSession({
    activeWorkspace: {
      id: "workspace:old-static-preview",
      label: "Current project workspace",
      rootPath: "C:\\Users\\testuser\\Desktop",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company-landing.html",
      previewUrl: "file:///C:/Users/testuser/Desktop/sample-company-landing.html",
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
      lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company-landing.html"],
      sourceJobId: "job-old-static-preview",
      updatedAt: "2026-03-17T23:40:00.000Z"
    }
  });
  const incoming = buildSession({
    updatedAt: "2026-03-17T23:58:00.000Z",
    activeWorkspace: {
      id: "workspace:new-react-project",
      label: "Current project workspace",
      rootPath: "C:\\Users\\testuser\\Desktop\\React Landing Page",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\React Landing Page\\src\\App.jsx",
      previewUrl: null,
      browserSessionId: null,
      browserSessionIds: [],
      browserSessionStatus: null,
      browserProcessPid: null,
      previewProcessLeaseId: null,
      previewProcessLeaseIds: [],
      previewProcessCwd: "C:\\Users\\testuser\\Desktop\\React Landing Page",
      lastKnownPreviewProcessPid: null,
      stillControllable: false,
      ownershipState: "stale",
      previewStackState: "detached",
      lastChangedPaths: [
        "C:\\Users\\testuser\\Desktop\\React Landing Page\\src\\App.jsx",
        "C:\\Users\\testuser\\Desktop\\React Landing Page\\src\\index.css"
      ],
      sourceJobId: "job-react-workspace-reset",
      updatedAt: "2026-03-17T23:58:00.000Z"
    }
  });

  const merged = mergeConversationSession(existing, incoming);
  assert.equal(
    merged.activeWorkspace?.rootPath,
    "C:\\Users\\testuser\\Desktop\\React Landing Page"
  );
  assert.equal(
    merged.activeWorkspace?.primaryArtifactPath,
    "C:\\Users\\testuser\\Desktop\\React Landing Page\\src\\App.jsx"
  );
  assert.equal(merged.activeWorkspace?.previewUrl, null);
  assert.equal(merged.activeWorkspace?.browserSessionId, null);
  assert.deepEqual(merged.activeWorkspace?.browserSessionIds, []);
  assert.deepEqual(merged.activeWorkspace?.previewProcessLeaseIds, []);
  assert.deepEqual(merged.activeWorkspace?.lastChangedPaths, [
    "C:\\Users\\testuser\\Desktop\\React Landing Page\\src\\App.jsx",
    "C:\\Users\\testuser\\Desktop\\React Landing Page\\src\\index.css"
  ]);
});

test("mergeConversationSession keeps the meaningful domain context when a fresher partial update is empty", () => {
  const existing = buildSession({
    domainContext: applyDomainSignalWindow(createEmptyConversationDomainContext("chat-1"), {
      observedAt: "2026-03-07T12:00:00.000Z",
      laneSignals: [
        { lane: "workflow", observedAt: "2026-03-07T12:00:00.000Z", source: "routing_mode", weight: 1 }
      ]
    })
  });
  const incoming = buildSession({
    updatedAt: "2026-03-07T12:05:00.000Z",
    domainContext: createEmptyConversationDomainContext("chat-1")
  });

  const merged = mergeConversationSession(existing, incoming);
  assert.equal(merged.domainContext.dominantLane, "workflow");
  assert.equal(merged.domainContext.recentLaneHistory.length, 1);
});

test("mergeConversationSession prefers the fresher meaningful domain context when it is updated", () => {
  const existing = buildSession({
    domainContext: applyDomainSignalWindow(createEmptyConversationDomainContext("chat-1"), {
      observedAt: "2026-03-07T12:00:00.000Z",
      laneSignals: [
        { lane: "workflow", observedAt: "2026-03-07T12:00:00.000Z", source: "routing_mode", weight: 1 }
      ]
    })
  });
  const incoming = buildSession({
    updatedAt: "2026-03-07T12:05:00.000Z",
    domainContext: applyDomainSignalWindow(createEmptyConversationDomainContext("chat-1"), {
      observedAt: "2026-03-07T12:05:00.000Z",
      laneSignals: [
        { lane: "profile", observedAt: "2026-03-07T12:05:00.000Z", source: "keyword", weight: 1 }
      ]
    })
  });

  const merged = mergeConversationSession(existing, incoming);
  assert.equal(merged.domainContext.dominantLane, "profile");
  assert.equal(merged.domainContext.lastUpdatedAt, "2026-03-07T12:05:00.000Z");
});
