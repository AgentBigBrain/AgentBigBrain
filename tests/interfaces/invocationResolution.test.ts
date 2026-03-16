/**
 * @fileoverview Covers canonical non-command invocation resolution below the stable ingress coordinator.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSessionSeed,
  createFollowUpRuleContext,
  createPulseLexicalRuleContext
} from "../../src/interfaces/conversationManagerHelpers";
import {
  resolveConversationInvocation
} from "../../src/interfaces/conversationRuntime/invocationResolution";
import type {
  ConversationInboundMessage,
  ExecuteConversationTask
} from "../../src/interfaces/conversationRuntime/managerContracts";
import type { ConversationIngressDependencies } from "../../src/interfaces/conversationRuntime/contracts";
import type { ConversationJob, ConversationSession } from "../../src/interfaces/sessionStore";
import { buildConversationIngressConfig } from "../helpers/conversationFixtures";

function buildSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ...buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-1",
      userId: "user-1",
      username: "agentowner",
      conversationVisibility: "private",
      receivedAt: "2026-03-07T16:30:00.000Z"
    }),
    ...overrides
  };
}

function buildQueuedJob(input: string): ConversationJob {
  return {
    id: "job-1",
    input,
    executionInput: input,
    createdAt: "2026-03-07T16:30:00.000Z",
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

function buildMessage(text: string): ConversationInboundMessage {
  return {
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
    receivedAt: "2026-03-07T16:30:05.000Z",
    text
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
    config: buildConversationIngressConfig({
      maxProposalInputChars: 400
    }),
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

const noopExecuteTask: ExecuteConversationTask = async (input) => ({ summary: input });

test("resolveConversationInvocation handles natural pulse commands without starting the worker", async () => {
  const session = buildSession({
    agentPulse: {
      ...buildSession().agentPulse,
      optIn: true
    }
  });

  const resolution = await resolveConversationInvocation(
    session,
    buildMessage("turn off pulse"),
    noopExecuteTask,
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for natural pulse commands");
    })
  );

  assert.ok(resolution.reply.includes("Agent Pulse is now OFF"));
  assert.equal(resolution.shouldStartWorker, false);
  assert.equal(session.agentPulse.optIn, false);
});

test("resolveConversationInvocation routes normal messages into the queue and requests worker startup", async () => {
  const session = buildSession();
  let capturedExecutionInput = "";

  const resolution = await resolveConversationInvocation(
    session,
    buildMessage("Please draft a concise summary"),
    noopExecuteTask,
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedExecutionInput = executionInput ?? "";
      currentSession.queuedJobs.push(buildQueuedJob(input));
      return {
        reply: "queued normal message",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(resolution.reply, "queued normal message");
  assert.equal(resolution.shouldStartWorker, true);
  assert.equal(session.queuedJobs.length, 1);
  assert.equal(capturedExecutionInput, "Please draft a concise summary");
  assert.ok(!capturedExecutionInput.includes("Deterministic routing hint:"));
});
