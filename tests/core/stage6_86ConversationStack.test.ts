/**
 * @fileoverview Tests deterministic Stage 6.86 conversation-stack threading and migration behavior for checkpoint 6.86.C.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyUserTurnToConversationStackV1,
  buildConversationStackFromTurnsV1,
  createEmptyConversationStackV1,
  deriveTopicKeyCandidatesV1,
  migrateSessionConversationStackToV2
} from "../../src/core/stage6_86ConversationStack";

/**
 * Implements `derivesDeterministicTopicKeyCandidates` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function derivesDeterministicTopicKeyCandidates(): void {
  const observedAt = "2026-03-01T10:00:00.000Z";
  const input = "Please schedule three focused backlog planning blocks next week.";
  const first = deriveTopicKeyCandidatesV1(input, observedAt);
  const second = deriveTopicKeyCandidatesV1(input, observedAt);

  assert.deepEqual(first, second);
  assert.ok(first.length >= 1);
  assert.ok(first[0].topicKey.includes("schedule"));
}

/**
 * Implements `switchesThreadsOnDeterministicTopicChange` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function switchesThreadsOnDeterministicTopicChange(): void {
  const stack = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Let's plan sprint backlog priorities.",
        at: "2026-03-01T10:00:00.000Z"
      },
      {
        role: "assistant",
        text: "Understood. Sprint backlog planning thread is active.",
        at: "2026-03-01T10:00:05.000Z"
      },
      {
        role: "user",
        text: "Now switch to budget forecast assumptions.",
        at: "2026-03-01T10:01:00.000Z"
      }
    ],
    "2026-03-01T10:01:00.000Z"
  );

  assert.ok(stack.activeThreadKey);
  assert.equal(stack.threads.length, 2);
  const active = stack.threads.find((thread) => thread.threadKey === stack.activeThreadKey);
  assert.ok(active);
  assert.ok(active?.topicKey.includes("budget"));
  assert.ok(stack.threads.some((thread) => thread.state === "paused"));
}

/**
 * Implements `suppressesAmbiguousReturnSignals` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function suppressesAmbiguousReturnSignals(): void {
  let stack = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Let's discuss sprint backlog planning.",
        at: "2026-03-01T10:00:00.000Z"
      },
      {
        role: "user",
        text: "Now let's discuss release launch checklist.",
        at: "2026-03-01T10:01:00.000Z"
      },
      {
        role: "user",
        text: "Now let's discuss budget runway assumptions.",
        at: "2026-03-01T10:02:00.000Z"
      }
    ],
    "2026-03-01T10:02:00.000Z"
  );
  const activeBefore = stack.activeThreadKey;
  assert.ok(activeBefore);

  stack = applyUserTurnToConversationStackV1(stack, {
    role: "user",
    text: "Let's go back.",
    at: "2026-03-01T10:03:00.000Z"
  });

  assert.equal(stack.activeThreadKey, activeBefore);
}

/**
 * Implements `resumesUniquePausedThreadOnExplicitReturn` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function resumesUniquePausedThreadOnExplicitReturn(): void {
  let stack = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Let's discuss sprint backlog planning.",
        at: "2026-03-01T10:00:00.000Z"
      },
      {
        role: "user",
        text: "Now let's discuss budget runway assumptions.",
        at: "2026-03-01T10:02:00.000Z"
      }
    ],
    "2026-03-01T10:02:00.000Z"
  );

  stack = applyUserTurnToConversationStackV1(stack, {
    role: "user",
    text: "Go back to sprint backlog and continue there.",
    at: "2026-03-01T10:03:00.000Z"
  });

  const active = stack.threads.find((thread) => thread.threadKey === stack.activeThreadKey);
  assert.ok(active);
  assert.ok(active?.topicKey.includes("sprint"));
}

/**
 * Implements `resumesPausedThreadFromInterpretedReturnWhenDeterministicReturnIsAmbiguous`
 * behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function resumesPausedThreadFromInterpretedReturnWhenDeterministicReturnIsAmbiguous(): void {
  let stack = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Let's discuss sprint backlog planning.",
        at: "2026-03-01T10:00:00.000Z"
      },
      {
        role: "user",
        text: "Now let's discuss release launch checklist.",
        at: "2026-03-01T10:01:00.000Z"
      },
      {
        role: "user",
        text: "Now let's discuss budget runway assumptions.",
        at: "2026-03-01T10:02:00.000Z"
      }
    ],
    "2026-03-01T10:02:00.000Z"
  );

  const sprintThread = stack.threads.find((thread) => thread.topicKey.includes("sprint"));
  assert.ok(sprintThread);

  stack = applyUserTurnToConversationStackV1(
    stack,
    {
      role: "user",
      text: "Let's go back.",
      at: "2026-03-01T10:03:00.000Z"
    },
    {
      topicKeyInterpretation: {
        kind: "resume_paused_thread",
        selectedTopicKey: null,
        selectedThreadKey: sprintThread!.threadKey,
        confidence: "high"
      }
    }
  );

  assert.equal(stack.activeThreadKey, sprintThread!.threadKey);
}

/**
 * Implements `switchesWeakTopicFromInterpretedCandidateWhenDeterministicConfidenceIsTooLow`
 * behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function switchesWeakTopicFromInterpretedCandidateWhenDeterministicConfidenceIsTooLow(): void {
  const seeded = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Let's discuss sprint backlog planning.",
        at: "2026-03-01T10:00:00.000Z"
      }
    ],
    "2026-03-01T10:00:00.000Z"
  );

  const updated = applyUserTurnToConversationStackV1(
    seeded,
    {
      role: "user",
      text: "Budget",
      at: "2026-03-01T10:01:00.000Z"
    },
    {
      topicKeyInterpretation: {
        kind: "switch_topic_candidate",
        selectedTopicKey: "budget",
        selectedThreadKey: null,
        confidence: "high"
      }
    }
  );

  const active = updated.threads.find((thread) => thread.threadKey === updated.activeThreadKey);
  assert.ok(active);
  assert.equal(active?.topicKey, "budget");
}

/**
 * Implements `keepsMissionThreadActiveWhenMissionPriorityIsSet` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function keepsMissionThreadActiveWhenMissionPriorityIsSet(): void {
  const seeded = buildConversationStackFromTurnsV1(
    [
      {
        role: "user",
        text: "Investigate prod incident timeline and rollback path.",
        at: "2026-03-01T11:00:00.000Z"
      }
    ],
    "2026-03-01T11:00:00.000Z"
  );
  const missionThreadKey = seeded.activeThreadKey;
  assert.ok(missionThreadKey);

  const updated = applyUserTurnToConversationStackV1(
    seeded,
    {
      role: "user",
      text: "Also remind me to plan vacation flights.",
      at: "2026-03-01T11:01:00.000Z"
    },
    {
      activeMissionThreadKey: missionThreadKey
    }
  );

  assert.equal(updated.activeThreadKey, missionThreadKey);
  const active = updated.threads.find((thread) => thread.threadKey === missionThreadKey);
  assert.ok(active);
  assert.ok(active?.topicKey.includes("incident"));
}

/**
 * Implements `migratesLegacySessionTurnsToConversationStackV2` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function migratesLegacySessionTurnsToConversationStackV2(): void {
  const migration = migrateSessionConversationStackToV2({
    sessionSchemaVersion: null,
    updatedAt: "2026-03-01T12:00:00.000Z",
    conversationTurns: [
      {
        role: "user",
        text: "Let's review launch checklist items.",
        at: "2026-03-01T12:00:00.000Z"
      },
      {
        role: "assistant",
        text: "Launch checklist thread is open.",
        at: "2026-03-01T12:00:03.000Z"
      }
    ],
    conversationStack: createEmptyConversationStackV1("2026-03-01T11:59:00.000Z")
  });

  assert.equal(migration.sessionSchemaVersion, "v2");
  assert.equal(migration.migrationApplied, true);
  assert.equal(migration.migrationReason, "LEGACY_SCHEMA");
  assert.equal(migration.conversationStack.schemaVersion, "v1");
  assert.equal(migration.conversationStack.threads.length, 1);
}

test(
  "stage 6.86 conversation stack derives deterministic topic key candidates from user turns",
  derivesDeterministicTopicKeyCandidates
);
test(
  "stage 6.86 conversation stack switches active thread on deterministic topic changes",
  switchesThreadsOnDeterministicTopicChange
);
test(
  "stage 6.86 conversation stack suppresses ambiguous return signals instead of switching threads",
  suppressesAmbiguousReturnSignals
);
test(
  "stage 6.86 conversation stack resumes a unique paused thread on explicit return phrasing",
  resumesUniquePausedThreadOnExplicitReturn
);
test(
  "stage 6.86 conversation stack can resume one paused thread from interpreted return output when deterministic return is ambiguous",
  resumesPausedThreadFromInterpretedReturnWhenDeterministicReturnIsAmbiguous
);
test(
  "stage 6.86 conversation stack can switch to one interpreted weak topic candidate when deterministic confidence is too low",
  switchesWeakTopicFromInterpretedCandidateWhenDeterministicConfidenceIsTooLow
);
test(
  "stage 6.86 conversation stack keeps mission-priority thread active under competing topic cues",
  keepsMissionThreadActiveWhenMissionPriorityIsSet
);
test(
  "stage 6.86 conversation stack migrates legacy session turns to schema-versioned v2 state",
  migratesLegacySessionTurnsToConversationStackV2
);
