/**
 * @fileoverview Tests deterministic recent-job and turn-history mutation helpers used by ConversationManager.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildConversationStackFromTurnsV1 } from "../../src/core/stage6_86ConversationStack";
import {
  backfillTurnsFromRecentJobsIfNeeded,
  findRecentJob,
  recordAssistantTurn,
  recordUserTurn,
  setActiveWorkspace,
  setReturnHandoff,
  upsertRecentJob
} from "../../src/interfaces/conversationSessionMutations";
import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import {
  ConversationJob,
  ConversationSession
} from "../../src/interfaces/sessionStore";

/**
 * Creates a deterministic baseline session for session-mutation tests.
 *
 * **Why it exists:**
 * Test cases need a stable, fully-typed session without repeating boilerplate fields.
 *
 * **What it talks to:**
 * - Calls `buildSessionSeed` to mirror runtime defaults.
 *
 * @returns Fresh conversation session with empty jobs/turns.
 */
function buildSession(): ConversationSession {
  return buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: "2026-03-03T00:00:00.000Z"
  });
}

/**
 * Builds a deterministic job record with optional overrides for targeted assertions.
 *
 * **Why it exists:**
 * Keeps each test focused on one mutation behavior instead of reconstructing full job shape.
 *
 * **What it talks to:**
 * - Returns an in-memory `ConversationJob` object used by mutation helpers.
 *
 * @param id - Unique job identifier.
 * @param overrides - Optional per-test field overrides.
 * @returns Fully-typed job record.
 */
function buildJob(id: string, overrides: Partial<ConversationJob> = {}): ConversationJob {
  return {
    id,
    input: `input-${id}`,
    createdAt: `2026-03-03T00:00:0${id}.000Z`,
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

test("findRecentJob returns matching job by id and null for unknown id", () => {
  const session = buildSession();
  const jobA = buildJob("1");
  const jobB = buildJob("2");
  session.recentJobs = [jobA, jobB];

  assert.equal(findRecentJob(session, "2")?.id, "2");
  assert.equal(findRecentJob(session, "missing"), null);
});

test("upsertRecentJob keeps one copy per id, newest first, and enforces cap", () => {
  const session = buildSession();
  const job1 = buildJob("1");
  const job2 = buildJob("2");
  const job3 = buildJob("3");

  upsertRecentJob(session, job1, 2);
  upsertRecentJob(session, job2, 2);
  upsertRecentJob(session, buildJob("1", { status: "completed" }), 2);
  upsertRecentJob(session, job3, 2);

  assert.deepEqual(session.recentJobs.map((job) => job.id), ["3", "1"]);
  assert.equal(session.recentJobs[1]?.status, "completed");
});

test("recordUserTurn and recordAssistantTurn normalize text and cap turn history", () => {
  const session = buildSession();

  recordUserTurn(session, "   Hello    world   ", "2026-03-03T00:00:01.000Z", 2);
  recordAssistantTurn(session, "  ", "2026-03-03T00:00:02.000Z", 2);
  recordAssistantTurn(session, "Second reply", "2026-03-03T00:00:03.000Z", 2);
  recordUserTurn(session, "Third turn", "2026-03-03T00:00:04.000Z", 2);

  assert.equal(session.conversationTurns.length, 2);
  assert.deepEqual(
    session.conversationTurns.map((turn) => `${turn.role}:${turn.text}`),
    ["assistant:Second reply", "user:Third turn"]
  );
  assert.ok(session.conversationStack);
  assert.equal(session.conversationStack?.activeThreadKey !== null, true);
});

test("recordAssistantTurn preserves blank-line paragraph boundaries", () => {
  const session = buildSession();
  recordUserTurn(
    session,
    "Landing page hero section",
    "2026-03-03T00:00:02.000Z",
    4
  );

  recordAssistantTurn(
    session,
    " First paragraph with extra   spacing.\n\n Second paragraph stays separate. ",
    "2026-03-03T00:00:03.000Z",
    4
  );

  assert.equal(
    session.conversationTurns[1]?.text,
    "First paragraph with extra spacing.\n\nSecond paragraph stays separate."
  );
  assert.equal(session.conversationStack?.updatedAt, "2026-03-03T00:00:03.000Z");
});

test("recordUserTurn applies one precomputed topic-key interpretation to the live conversation stack", () => {
  const session = buildSession();
  session.conversationTurns = [
    {
      role: "user",
      text: "Landing page hero section",
      at: "2026-03-03T00:00:01.000Z"
    },
    {
      role: "assistant",
      text: "I updated the landing page hero section.",
      at: "2026-03-03T00:00:02.000Z"
    },
    {
      role: "user",
      text: "API auth retry bug",
      at: "2026-03-03T00:00:03.000Z"
    },
    {
      role: "assistant",
      text: "I investigated the API auth retry bug.",
      at: "2026-03-03T00:00:04.000Z"
    }
  ];
  session.conversationStack = buildConversationStackFromTurnsV1(
    session.conversationTurns,
    "2026-03-03T00:00:04.000Z",
    {}
  );
  const pausedThread = session.conversationStack.threads.find((thread) => thread.state === "paused");
  assert.ok(pausedThread);

  recordUserTurn(
    session,
    "continue that",
    "2026-03-03T00:00:05.000Z",
    10,
    {
      topicKeyInterpretation: {
        kind: "resume_paused_thread",
        selectedTopicKey: null,
        selectedThreadKey: pausedThread.threadKey,
        confidence: "high"
      }
    }
  );

  assert.equal(session.conversationStack?.activeThreadKey, pausedThread.threadKey);
});

test("backfillTurnsFromRecentJobsIfNeeded reconstructs turns from recent jobs in chronological order", () => {
  const session = buildSession();
  session.recentJobs = [
    buildJob("3", {
      createdAt: "2026-03-03T00:03:00.000Z",
      status: "completed",
      resultSummary: "Done 3",
      completedAt: "2026-03-03T00:03:40.000Z"
    }),
    buildJob("2", {
      createdAt: "2026-03-03T00:02:00.000Z",
      status: "failed"
    }),
    buildJob("1", {
      createdAt: "2026-03-03T00:01:00.000Z",
      status: "completed",
      resultSummary: "Done 1",
      completedAt: "2026-03-03T00:01:20.000Z"
    })
  ];

  backfillTurnsFromRecentJobsIfNeeded(session, 3, 6);

  assert.deepEqual(
    session.conversationTurns.map((turn) => `${turn.role}:${turn.text}`),
    [
      "user:input-1",
      "assistant:Done 1",
      "user:input-2",
      "user:input-3",
      "assistant:Done 3"
    ]
  );
  assert.ok(session.conversationStack);
  assert.equal(session.conversationStack?.updatedAt, "2026-03-03T00:03:40.000Z");
});

test("backfillTurnsFromRecentJobsIfNeeded does not overwrite existing turns", () => {
  const session = buildSession();
  session.conversationTurns = [{
    role: "user",
    text: "existing",
    at: "2026-03-03T00:00:01.000Z"
  }];
  session.recentJobs = [buildJob("1", { status: "completed", resultSummary: "ignored" })];

  backfillTurnsFromRecentJobsIfNeeded(session, 3, 10);

  assert.deepEqual(session.conversationTurns, [{
    role: "user",
    text: "existing",
    at: "2026-03-03T00:00:01.000Z"
  }]);
});

test("setActiveWorkspace stamps the current session-domain snapshot when one is available", () => {
  const session = buildSession();
  session.domainContext.dominantLane = "workflow";
  session.domainContext.lastUpdatedAt = "2026-03-03T00:10:00.000Z";

  setActiveWorkspace(session, {
    id: "workspace-1",
    label: "Drone Company",
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\src\\App.jsx",
    previewUrl: "http://127.0.0.1:4173/",
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
    previewStackState: "browser_only",
    lastChangedPaths: [],
    sourceJobId: "job-1",
    updatedAt: "2026-03-03T00:10:05.000Z"
  });

  assert.equal(session.activeWorkspace?.domainSnapshotLane, "workflow");
  assert.equal(
    session.activeWorkspace?.domainSnapshotRecordedAt,
    "2026-03-03T00:10:00.000Z"
  );
});

test("setReturnHandoff inherits the active workspace domain snapshot when present", () => {
  const session = buildSession();
  session.activeWorkspace = {
    id: "workspace-1",
    label: "Drone Company",
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
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
    sourceJobId: "job-1",
    domainSnapshotLane: "workflow",
    domainSnapshotRecordedAt: "2026-03-03T00:15:00.000Z",
    updatedAt: "2026-03-03T00:15:30.000Z"
  };

  setReturnHandoff(session, {
    id: "handoff:job-1",
    status: "completed",
    goal: "Finish the landing page",
    summary: "Ready for review.",
    nextSuggestedStep: null,
    workspaceRootPath: session.activeWorkspace.rootPath,
    primaryArtifactPath: null,
    previewUrl: null,
    changedPaths: [],
    sourceJobId: "job-1",
    updatedAt: "2026-03-03T00:16:00.000Z"
  });

  assert.equal(session.returnHandoff?.domainSnapshotLane, "workflow");
  assert.equal(
    session.returnHandoff?.domainSnapshotRecordedAt,
    "2026-03-03T00:15:00.000Z"
  );
});
