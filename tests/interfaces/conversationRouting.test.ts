/**
 * @fileoverview Covers canonical conversation-routing helpers below the stable ingress coordinator.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSessionSeed,
  createFollowUpRuleContext,
  type FollowUpRuleContext
} from "../../src/interfaces/conversationManagerHelpers";
import {
  routeConversationChatInput,
  routeConversationMessageInput,
  type ConversationEnqueueResult,
  type ConversationRoutingDependencies
} from "../../src/interfaces/conversationRuntime/conversationRouting";
import type { ConversationSession } from "../../src/interfaces/sessionStore";

function buildSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ...buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-1",
      userId: "user-1",
      username: "agentowner",
      conversationVisibility: "private",
      receivedAt: "2026-03-07T16:00:00.000Z"
    }),
    ...overrides
  };
}

function buildRoutingDependencies(
  enqueueJob: ConversationRoutingDependencies["enqueueJob"],
  followUpRuleContext: FollowUpRuleContext = createFollowUpRuleContext(null)
): ConversationRoutingDependencies {
  return {
    followUpRuleContext,
    config: {
      maxContextTurnsForExecution: 6,
      maxConversationTurns: 20
    },
    enqueueJob
  };
}



test("routeConversationChatInput asks one clarification question for ambiguous build requests", async () => {
  const session = buildSession();
  let enqueueCalls = 0;

  const result = await routeConversationChatInput(
    session,
    "Build a dashboard for the team.",
    "2026-03-07T16:00:05.000Z",
    buildRoutingDependencies(() => {
      enqueueCalls += 1;
      return {
        reply: "should not enqueue",
        shouldStartWorker: true
      };
    })
  );

  assert.deepEqual(result, {
    reply: "Do you want me to plan it first or build it now?",
    shouldStartWorker: false
  } satisfies ConversationEnqueueResult);
  assert.equal(enqueueCalls, 0);
  assert.equal(session.conversationTurns.length, 2);
  assert.equal(session.conversationTurns[0]?.role, "user");
  assert.equal(session.conversationTurns[1]?.role, "assistant");
});

test("routeConversationMessageInput asks one clarification question for ambiguous fix requests", async () => {
  const session = buildSession();
  let enqueueCalls = 0;

  const result = await routeConversationMessageInput(
    session,
    "The screenshot shows a failing test and something is wrong.",
    "2026-03-07T16:00:05.000Z",
    buildRoutingDependencies(() => {
      enqueueCalls += 1;
      return {
        reply: "should not enqueue",
        shouldStartWorker: true
      };
    })
  );

  assert.deepEqual(result, {
    reply: "Do you want me to explain the issue first or fix it now?",
    shouldStartWorker: false
  } satisfies ConversationEnqueueResult);
  assert.equal(enqueueCalls, 0);
});

test("routeConversationMessageInput preserves explicit build-now requests without clarification", async () => {
  const session = buildSession();
  let enqueueCalls = 0;

  const result = await routeConversationMessageInput(
    session,
    "Build this now and use React.",
    "2026-03-07T16:00:05.000Z",
    buildRoutingDependencies((_currentSession, _input, _receivedAt, executionInput) => {
      enqueueCalls += 1;
      assert.match(executionInput ?? "", /Current user request:/);
      return {
        reply: "queued build",
        shouldStartWorker: true
      };
    })
  );

  assert.deepEqual(result, {
    reply: "queued build",
    shouldStartWorker: true
  } satisfies ConversationEnqueueResult);
  assert.equal(enqueueCalls, 1);
});

test("routeConversationMessageInput passes interpreted media context through execution input", async () => {
  const session = buildSession();
  let capturedExecutionInput = "";

  await routeConversationMessageInput(
    session,
    "Please fix this.",
    "2026-03-07T16:00:05.000Z",
    buildRoutingDependencies((_currentSession, _input, _receivedAt, executionInput) => {
      capturedExecutionInput = executionInput ?? "";
      return {
        reply: "queued media request",
        shouldStartWorker: true
      };
    }),
    {
      attachments: [
        {
          kind: "image",
          provider: "telegram",
          fileId: "img-1",
          fileUniqueId: "img-uniq-1",
          mimeType: "image/png",
          fileName: "failure.png",
          sizeBytes: 4096,
          caption: "You did this wrong.",
          durationSeconds: null,
          width: 1280,
          height: 720,
          interpretation: {
            summary: "Screenshot shows a failing assertion in planner.test.ts.",
            transcript: null,
            ocrText: "Expected true Received false",
            confidence: 0.91,
            provenance: "vision + ocr",
            source: "fixture_catalog",
            entityHints: ["planner.test.ts", "assertion"]
          }
        }
      ]
    }
  );

  assert.match(capturedExecutionInput, /Inbound media context \(interpreted once, bounded, no raw bytes\):/);
  assert.match(capturedExecutionInput, /planner\.test\.ts/);
});

test("routeConversationChatInput adds deterministic routing hints and records the user turn", async () => {
  const session = buildSession();
  let capturedInput = "";
  let capturedExecutionInput = "";

  const result = await routeConversationChatInput(
    session,
    "Create a React app at C:\\Temp\\demo and execute now.",
    "2026-03-07T16:00:05.000Z",
    buildRoutingDependencies((currentSession, input, receivedAt, executionInput) => {
      capturedInput = input;
      capturedExecutionInput = executionInput ?? "";
      assert.equal(currentSession, session);
      assert.equal(receivedAt, "2026-03-07T16:00:05.000Z");
      return {
        reply: "queued chat request",
        shouldStartWorker: true
      };
    })
  );

  assert.deepEqual(result, {
    reply: "queued chat request",
    shouldStartWorker: true
  } satisfies ConversationEnqueueResult);
  assert.equal(capturedInput, "Create a React app at C:\\Temp\\demo and execute now.");
  assert.ok(capturedExecutionInput.includes("Deterministic routing hint:"));
  assert.equal(session.conversationTurns.length, 1);
  assert.equal(
    session.conversationTurns[0]?.text,
    "Create a React app at C:\\Temp\\demo and execute now."
  );
});

test("routeConversationMessageInput keeps follow-up execution envelopes without adding chat-only routing hints", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "assistant",
        text: "Would you like plain text or markdown?",
        at: "2026-03-07T16:00:02.000Z"
      }
    ]
  });
  let capturedExecutionInput = "";

  const result = await routeConversationMessageInput(
    session,
    "plain text",
    "2026-03-07T16:00:05.000Z",
    buildRoutingDependencies((_currentSession, _input, _receivedAt, executionInput) => {
      capturedExecutionInput = executionInput ?? "";
      return {
        reply: "queued follow-up",
        shouldStartWorker: true
      };
    })
  );

  assert.deepEqual(result, {
    reply: "queued follow-up",
    shouldStartWorker: true
  } satisfies ConversationEnqueueResult);
  assert.ok(
    capturedExecutionInput.includes("Follow-up user response to prior assistant clarification.")
  );
  assert.ok(capturedExecutionInput.includes("User follow-up answer: plain text"));
  assert.ok(!capturedExecutionInput.includes("Deterministic routing hint:"));
  assert.equal(session.classifierEvents?.length, 1);
  assert.equal(session.classifierEvents?.[0]?.classifier, "follow_up");
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    "plain text"
  );
});

test("routeConversationMessageInput threads bounded episodic recall into execution input when available", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "user",
        text: "Billy fell down a few weeks ago.",
        at: "2026-02-14T15:00:00.000Z"
      }
    ],
    conversationStack: {
      schemaVersion: "v1",
      updatedAt: "2026-03-07T16:00:00.000Z",
      activeThreadKey: "thread_current",
      threads: [
        {
          threadKey: "thread_current",
          topicKey: "release_rollout",
          topicLabel: "Release Rollout",
          state: "active",
          resumeHint: "Need to finish the rollout.",
          openLoops: [],
          lastTouchedAt: "2026-03-07T16:00:00.000Z"
        },
        {
          threadKey: "thread_billy",
          topicKey: "billy_fall",
          topicLabel: "Billy Fall",
          state: "paused",
          resumeHint: "Billy fell down and you wanted to hear how it ended up.",
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
          firstSeenAt: "2026-03-07T16:00:00.000Z",
          lastSeenAt: "2026-03-07T16:00:00.000Z",
          mentionCount: 1
        },
        {
          topicKey: "billy_fall",
          label: "Billy Fall",
          firstSeenAt: "2026-02-14T15:00:00.000Z",
          lastSeenAt: "2026-02-14T15:00:00.000Z",
          mentionCount: 1
        }
      ]
    }
  });
  let capturedExecutionInput = "";

  await routeConversationMessageInput(
    session,
    "How is Billy doing lately?",
    "2026-03-07T16:00:05.000Z",
    {
      ...buildRoutingDependencies((_currentSession, _input, _receivedAt, executionInput) => {
        capturedExecutionInput = executionInput ?? "";
        return {
          reply: "queued recall-aware message",
          shouldStartWorker: true
        };
      }),
      queryContinuityEpisodes: async () => [
        {
          episodeId: "episode_billy_fall",
          title: "Billy fell down",
          summary: "Billy fell down a few weeks ago and the outcome never got resolved.",
          status: "unresolved",
          lastMentionedAt: "2026-02-14T15:00:00.000Z",
          entityRefs: ["Billy"],
          entityLinks: [
            {
              entityKey: "entity_billy",
              canonicalName: "Billy"
            }
          ],
          openLoopLinks: [
            {
              loopId: "loop_billy",
              threadKey: "thread_billy",
              status: "open",
              priority: 0.8
            }
          ]
        }
      ]
    }
  );

  assert.match(capturedExecutionInput, /Relevant situation: Billy fell down/i);
  assert.match(capturedExecutionInput, /ask at most one brief follow-up/i);
});
