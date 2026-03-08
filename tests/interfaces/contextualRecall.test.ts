/**
 * @fileoverview Covers bounded in-conversation contextual recall helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildContextualRecallBlock,
  resolveContextualRecallCandidate
} from "../../src/interfaces/conversationRuntime/contextualRecall";
import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import type {
  ConversationStackV1
} from "../../src/core/types";
import type {
  ConversationSession
} from "../../src/interfaces/sessionStore";

/**
 * Creates a stable session fixture for contextual-recall tests.
 *
 * @param overrides - Optional session overrides.
 * @returns Fresh seeded conversation session.
 */
function buildSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ...buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-contextual-recall",
      userId: "user-1",
      username: "owner",
      conversationVisibility: "private",
      receivedAt: "2026-03-08T11:00:00.000Z"
    }),
    ...overrides
  };
}

/**
 * Builds one paused-thread stack fixture.
 *
 * @returns Conversation stack containing an older paused Billy thread.
 */
function buildPausedBillyStack(): ConversationStackV1 {
  return {
    schemaVersion: "v1",
    updatedAt: "2026-03-08T11:00:00.000Z",
    activeThreadKey: "thread_current",
    threads: [
      {
        threadKey: "thread_current",
        topicKey: "release_rollout",
        topicLabel: "Release Rollout",
        state: "active",
        resumeHint: "Need to finish the rollout.",
        openLoops: [],
        lastTouchedAt: "2026-03-08T10:55:00.000Z"
      },
      {
        threadKey: "thread_billy",
        topicKey: "billy_fall",
        topicLabel: "Billy Fall",
        state: "paused",
        resumeHint: "Billy fell down a few weeks ago and you wanted to hear how that situation ended up.",
        openLoops: [
          {
            loopId: "loop_billy",
            threadKey: "thread_billy",
            entityRefs: ["billy"],
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
        topicKey: "release_rollout",
        label: "Release Rollout",
        firstSeenAt: "2026-03-08T10:40:00.000Z",
        lastSeenAt: "2026-03-08T10:55:00.000Z",
        mentionCount: 3
      },
      {
        topicKey: "billy_fall",
        label: "Billy Fall",
        firstSeenAt: "2026-02-14T15:00:00.000Z",
        lastSeenAt: "2026-02-14T15:00:00.000Z",
        mentionCount: 2
      }
    ]
  };
}

test("resolveContextualRecallCandidate returns a paused-thread recall when the user naturally re-mentions the topic", () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "user",
        text: "Billy fell down a few weeks ago.",
        at: "2026-02-14T15:00:00.000Z"
      },
      {
        role: "assistant",
        text: "I hope Billy is okay.",
        at: "2026-02-14T15:01:00.000Z"
      },
      {
        role: "assistant",
        text: "The rollout can wait until after lunch.",
        at: "2026-03-08T10:50:00.000Z"
      }
    ],
    conversationStack: buildPausedBillyStack()
  });

  const candidate = resolveContextualRecallCandidate(
    session,
    "How is Billy doing lately?"
  );

  assert.ok(candidate);
  assert.equal(candidate?.threadKey, "thread_billy");
  assert.equal(candidate?.topicLabel, "Billy Fall");
  assert.equal(candidate?.openLoopCount, 1);
  assert.match(candidate?.supportingCue ?? "", /Billy/i);
});

test("buildContextualRecallBlock suppresses recall when no paused related thread exists", () => {
  const session = buildSession();
  const block = buildContextualRecallBlock(
    session,
    "How is Billy doing lately?"
  );

  assert.equal(block, null);
});

test("buildContextualRecallBlock suppresses recall when the assistant already asked that follow-up recently", () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "assistant",
        text: "Did Billy end up okay after the fall?",
        at: "2026-03-08T10:59:00.000Z"
      }
    ],
    conversationStack: buildPausedBillyStack()
  });

  const block = buildContextualRecallBlock(
    session,
    "How is Billy doing lately?"
  );

  assert.equal(block, null);
});
