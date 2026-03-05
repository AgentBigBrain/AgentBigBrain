/**
 * @fileoverview Tests deterministic Stage 6.86 open-loop creation, surfacing, and resolution behavior for checkpoint 6.86.D.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildConversationStackFromTurnsV1 } from "../../src/core/stage6_86ConversationStack";
import {
  detectOpenLoopTriggerV1,
  resolveOpenLoopOnConversationStackV1,
  selectOpenLoopsForPulseV1,
  upsertOpenLoopOnConversationStackV1
} from "../../src/core/stage6_86OpenLoops";

/**
 * Implements `detectsDeterministicOpenLoopTriggers` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function detectsDeterministicOpenLoopTriggers(): void {
  const first = detectOpenLoopTriggerV1("Remind me later to finalize the launch checklist.");
  const second = detectOpenLoopTriggerV1("Remind me later to finalize the launch checklist.");
  const nonTrigger = detectOpenLoopTriggerV1("Please finalize the launch checklist now.");

  assert.deepEqual(first, second);
  assert.equal(first.triggered, true);
  assert.equal(first.triggerCode, "DEFERRED_QUESTION");
  assert.equal(nonTrigger.triggered, false);
}

/**
 * Implements `createsOpenLoopFromDeferredPrompt` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function createsOpenLoopFromDeferredPrompt(): void {
  const stack = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Let's plan sprint backlog priorities.",
        at: "2026-03-01T09:00:00.000Z"
      }
    ],
    "2026-03-01T09:00:00.000Z"
  );
  const threadKey = stack.activeThreadKey;
  assert.ok(threadKey);

  const result = upsertOpenLoopOnConversationStackV1({
    stack,
    threadKey: threadKey!,
    text: "Remind me later to finalize the sprint estimate.",
    observedAt: "2026-03-01T09:02:00.000Z",
    entityRefs: ["entity_sprint"]
  });

  assert.equal(result.created, true);
  assert.equal(result.updated, false);
  assert.equal(result.triggerCode, "DEFERRED_QUESTION");
  assert.ok(result.loop);
  assert.equal(result.loop?.status, "open");
  assert.equal(result.loop?.threadKey, threadKey);
}

/**
 * Implements `upsertsSameOpenLoopDeterministically` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function upsertsSameOpenLoopDeterministically(): void {
  const stack = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Let's review launch checklist items.",
        at: "2026-03-01T10:00:00.000Z"
      }
    ],
    "2026-03-01T10:00:00.000Z"
  );
  const threadKey = stack.activeThreadKey;
  assert.ok(threadKey);

  const first = upsertOpenLoopOnConversationStackV1({
    stack,
    threadKey: threadKey!,
    text: "Still need to decide deployment window and rollback owner.",
    observedAt: "2026-03-01T10:01:00.000Z",
    priorityHint: 0.62
  });
  const second = upsertOpenLoopOnConversationStackV1({
    stack: first.stack,
    threadKey: threadKey!,
    text: "Still need to decide deployment window and rollback owner.",
    observedAt: "2026-03-01T10:03:00.000Z",
    priorityHint: 0.9,
    entityRefs: ["entity_deploy_owner"]
  });

  assert.ok(first.loop);
  assert.ok(second.loop);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.updated, true);
  assert.equal(second.loop?.loopId, first.loop?.loopId);
  assert.equal(second.loop?.priority, 0.9);
  assert.equal(second.loop?.lastMentionedAt, "2026-03-01T10:03:00.000Z");
  assert.equal(second.stack.threads.find((thread) => thread.threadKey === threadKey)?.openLoops.length, 1);
}

/**
 * Implements `surfacesBoundedOpenLoopCandidatesWithStaleThreshold` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function surfacesBoundedOpenLoopCandidatesWithStaleThreshold(): void {
  const seeded = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Let's review sprint backlog priorities.",
        at: "2026-01-01T09:00:00.000Z"
      },
      {
        role: "user",
        text: "Switch to budget forecast assumptions.",
        at: "2026-03-01T09:00:00.000Z"
      }
    ],
    "2026-03-01T09:00:00.000Z"
  );

  const sprintThread = seeded.threads.find((thread) => thread.topicKey.includes("sprint"));
  const budgetThread = seeded.threads.find((thread) => thread.topicKey.includes("budget"));
  assert.ok(sprintThread && budgetThread);

  const staleLoopStack = upsertOpenLoopOnConversationStackV1({
    stack: seeded,
    threadKey: sprintThread!.threadKey,
    text: "Still need to decide sprint overflow policy.",
    observedAt: "2026-01-01T09:05:00.000Z",
    priorityHint: 0.6
  }).stack;

  const freshLoopStack = upsertOpenLoopOnConversationStackV1({
    stack: staleLoopStack,
    threadKey: budgetThread!.threadKey,
    text: "Remind me later to confirm budget runway assumptions.",
    observedAt: "2026-03-01T09:05:00.000Z",
    priorityHint: 0.61
  }).stack;

  const selection = selectOpenLoopsForPulseV1(
    freshLoopStack,
    "2026-03-15T09:00:00.000Z",
    {
      maxOpenLoopsSurfaced: 1,
      openLoopStaleDays: 30,
      freshPriorityThreshold: 0.35,
      stalePriorityThreshold: 0.7
    }
  );

  assert.equal(selection.selected.length, 1);
  assert.equal(selection.selected[0]?.threadKey, budgetThread?.threadKey);
  assert.ok(
    selection.suppressed.some(
      (candidate) =>
        candidate.threadKey === sprintThread?.threadKey &&
        candidate.suppressionReason === "STALE_PRIORITY_TOO_LOW"
    )
  );
}

/**
 * Implements `resolvesOpenLoopAndKeepsItOutOfPulseSelection` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function resolvesOpenLoopAndKeepsItOutOfPulseSelection(): void {
  const stack = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Let's review launch readiness.",
        at: "2026-03-01T11:00:00.000Z"
      }
    ],
    "2026-03-01T11:00:00.000Z"
  );
  const threadKey = stack.activeThreadKey;
  assert.ok(threadKey);

  const upserted = upsertOpenLoopOnConversationStackV1({
    stack,
    threadKey: threadKey!,
    text: "Still need to decide final launch owner.",
    observedAt: "2026-03-01T11:05:00.000Z"
  });
  assert.ok(upserted.loop);

  const resolved = resolveOpenLoopOnConversationStackV1({
    stack: upserted.stack,
    threadKey: threadKey!,
    loopId: upserted.loop!.loopId,
    observedAt: "2026-03-01T11:10:00.000Z",
    status: "resolved"
  });

  assert.equal(resolved.resolved, true);
  assert.equal(resolved.loop?.status, "resolved");

  const selection = selectOpenLoopsForPulseV1(
    resolved.stack,
    "2026-03-01T12:00:00.000Z",
    {
      maxOpenLoopsSurfaced: 1
    }
  );
  assert.equal(selection.selected.length, 0);
}

test(
  "stage 6.86 open loops detect deterministic deferred and unresolved-decision trigger signals",
  detectsDeterministicOpenLoopTriggers
);
test(
  "stage 6.86 open loops create loop state for deferred prompts",
  createsOpenLoopFromDeferredPrompt
);
test(
  "stage 6.86 open loops deterministically upsert repeated loop cues into one loop id",
  upsertsSameOpenLoopDeterministically
);
test(
  "stage 6.86 open loops surface bounded pulse candidates and suppress stale low-priority loops",
  surfacesBoundedOpenLoopCandidatesWithStaleThreshold
);
test(
  "stage 6.86 open loops resolve loops and exclude resolved loops from pulse selection",
  resolvesOpenLoopAndKeepsItOutOfPulseSelection
);
