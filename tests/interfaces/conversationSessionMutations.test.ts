/**
 * @fileoverview Tests deterministic recent-job and turn-history mutation helpers used by ConversationManager.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  backfillTurnsFromRecentJobsIfNeeded,
  findRecentJob,
  recordAssistantTurn,
  recordUserTurn,
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
});

test("recordAssistantTurn preserves blank-line paragraph boundaries", () => {
  const session = buildSession();

  recordAssistantTurn(
    session,
    " First paragraph with extra   spacing.\n\n Second paragraph stays separate. ",
    "2026-03-03T00:00:03.000Z",
    4
  );

  assert.equal(
    session.conversationTurns[0]?.text,
    "First paragraph with extra spacing.\n\nSecond paragraph stays separate."
  );
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
