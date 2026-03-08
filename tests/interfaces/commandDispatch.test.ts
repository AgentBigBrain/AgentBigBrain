/**
 * @fileoverview Covers canonical slash-command dispatch below the stable ingress coordinator.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSessionSeed,
  createFollowUpRuleContext,
  createPulseLexicalRuleContext
} from "../../src/interfaces/conversationManagerHelpers";
import type { ConversationIngressDependencies } from "../../src/interfaces/conversationRuntime/contracts";
import { handleConversationCommand } from "../../src/interfaces/conversationRuntime/commandDispatch";
import type {
  ConversationInboundMessage
} from "../../src/interfaces/conversationRuntime/managerContracts";
import type { ConversationJob, ConversationSession } from "../../src/interfaces/sessionStore";

function buildSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ...buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-1",
      userId: "user-1",
      username: "agentowner",
      conversationVisibility: "private",
      receivedAt: "2026-03-07T17:00:00.000Z"
    }),
    ...overrides
  };
}

function buildMessage(text: string): ConversationInboundMessage {
  return {
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
    receivedAt: "2026-03-07T17:00:05.000Z",
    text
  };
}

function buildQueuedJob(input: string): ConversationJob {
  return {
    id: "job-1",
    input,
    executionInput: input,
    createdAt: "2026-03-07T17:00:05.000Z",
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

function buildDependencies(
  enqueueJob: ConversationIngressDependencies["enqueueJob"],
  overrides: Partial<ConversationIngressDependencies> = {}
): ConversationIngressDependencies {
  return {
    store: {
      getSession: async () => null,
      setSession: async () => undefined,
      listSessions: async () => []
    } as ConversationIngressDependencies["store"],
    config: {
      allowAutonomousViaInterface: true,
      maxProposalInputChars: 400,
      maxConversationTurns: 20,
      maxContextTurnsForExecution: 8,
      staleRunningJobRecoveryMs: 60_000,
      maxRecentJobs: 20
    },
    followUpRuleContext: createFollowUpRuleContext(null),
    pulseLexicalRuleContext: createPulseLexicalRuleContext(null),
    interpretConversationIntent: undefined,
    intentInterpreterConfidenceThreshold: 0.75,
    runCheckpointReview: undefined,
    isWorkerActive: () => false,
    clearAckTimer: () => undefined,
    setWorkerBinding: () => undefined,
    startWorkerIfNeeded: async () => undefined,
    enqueueJob,
    buildAutonomousExecutionInput: (goal) => `[AUTONOMOUS_LOOP_GOAL]\n${goal}`,
    ...overrides
  };
}

test("handleConversationCommand keeps status debug usage deterministic", async () => {
  const session = buildSession();
  const reply = await handleConversationCommand(
    session,
    buildMessage("/status verbose"),
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for status usage");
    })
  );

  assert.equal(reply, "Usage: /status [debug]");
});

test("handleConversationCommand routes /chat through canonical queue routing", async () => {
  const session = buildSession();
  let capturedExecutionInput = "";

  const reply = await handleConversationCommand(
    session,
    buildMessage("/chat create a React app at C:\\Temp\\demo and execute now"),
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedExecutionInput = executionInput ?? "";
      currentSession.queuedJobs.push(buildQueuedJob(input));
      return {
        reply: "queued chat job",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(reply, "queued chat job");
  assert.equal(session.queuedJobs.length, 1);
  assert.ok(capturedExecutionInput.includes("Deterministic routing hint:"));
});

test("handleConversationCommand keeps /auto policy and turn recording behavior", async () => {
  const session = buildSession();

  const disabledReply = await handleConversationCommand(
    session,
    buildMessage("/auto ship it"),
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run when /auto is disabled");
      },
      {
        config: {
          allowAutonomousViaInterface: false,
          maxProposalInputChars: 400,
          maxConversationTurns: 20,
          maxContextTurnsForExecution: 8,
          staleRunningJobRecoveryMs: 60_000,
          maxRecentJobs: 20
        }
      }
    )
  );
  assert.equal(
    disabledReply,
    "Autonomous loop is disabled. Set BRAIN_ALLOW_AUTONOMOUS_VIA_INTERFACE=true to enable."
  );

  const enabledReply = await handleConversationCommand(
    session,
    buildMessage("/auto ship it"),
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      currentSession.queuedJobs.push(buildQueuedJob(input));
      assert.equal(executionInput, "[AUTONOMOUS_LOOP_GOAL]\nship it");
      return {
        reply: "queued autonomous goal",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(
    enabledReply,
    "Starting autonomous loop for: ship it\nqueued autonomous goal"
  );
  assert.equal(session.conversationTurns.at(-1)?.text, "/auto ship it");
});

test("handleConversationCommand routes /memory through canonical review dispatch", async () => {
  const session = buildSession();
  let capturedReviewTaskId = "";

  const reply = await handleConversationCommand(
    session,
    buildMessage("/memory"),
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for /memory");
      },
      {
        reviewConversationMemory: async (request) => {
          capturedReviewTaskId = request.reviewTaskId;
          return [
            {
              episodeId: "episode_billy_fall",
              title: "Billy fell down",
              summary: "Billy fell down and the outcome was unresolved.",
              status: "unresolved",
              lastMentionedAt: "2026-03-07T10:00:00.000Z",
              resolvedAt: null,
              confidence: 0.91,
              sensitive: false
            }
          ];
        }
      }
    )
  );

  assert.match(capturedReviewTaskId, /^memory_review_/);
  assert.match(reply, /Remembered situations:/);
  assert.match(reply, /Billy fell down/);
});
