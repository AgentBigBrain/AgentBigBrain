/**
 * @fileoverview Covers canonical proposal and follow-up resolution helpers below conversation ingress.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { type ConversationInboundMessage } from "../../src/interfaces/conversationRuntime/managerContracts";
import type { ConversationIngressDependencies } from "../../src/interfaces/conversationRuntime/contracts";
import {
  approveProposal,
  handleImplicitProposalFlow,
  resolveInterpretedPulseCommandArgument
} from "../../src/interfaces/conversationRuntime/followUpResolution";
import {
  createFollowUpRuleContext,
  createPulseLexicalRuleContext
} from "../../src/interfaces/conversationManagerHelpers";
import { type ConversationSession } from "../../src/interfaces/sessionStore";

/**
 * Builds a minimal interface conversation session for follow-up tests.
 */
function buildSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    conversationId: "telegram:chat-1:user-1",
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
    updatedAt: "2026-03-07T15:00:00.000Z",
    activeProposal: {
      id: "draft-1",
      originalInput: "schedule focused work",
      currentInput: "schedule focused work",
      createdAt: "2026-03-07T15:00:00.000Z",
      updatedAt: "2026-03-07T15:00:00.000Z",
      status: "pending"
    },
    runningJobId: null,
    queuedJobs: [],
    recentJobs: [],
    conversationTurns: [],
    agentPulse: {
      optIn: false,
      mode: "private",
      routeStrategy: "last_private_used",
      lastPulseSentAt: null,
      lastPulseReason: null,
      lastPulseTargetConversationId: null,
      lastDecisionCode: "NOT_EVALUATED",
      lastEvaluatedAt: null
    },
    ...overrides
  };
}

/**
 * Builds a minimal inbound message for follow-up helper tests.
 */
function buildMessage(text: string): ConversationInboundMessage {
  return {
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
    text,
    receivedAt: "2026-03-07T15:05:00.000Z"
  };
}

/**
 * Builds deterministic ingress dependencies for isolated helper tests.
 */
function buildDeps(
  overrides: Partial<ConversationIngressDependencies> = {}
): ConversationIngressDependencies {
  return {
    store: null as never,
    config: {
      allowAutonomousViaInterface: false,
      maxProposalInputChars: 5_000,
      maxConversationTurns: 20,
      maxContextTurnsForExecution: 8,
      staleRunningJobRecoveryMs: 60_000,
      maxRecentJobs: 20
    },
    followUpRuleContext: createFollowUpRuleContext(null),
    pulseLexicalRuleContext: createPulseLexicalRuleContext(null),
    intentInterpreterConfidenceThreshold: 0.85,
    isWorkerActive: () => false,
    clearAckTimer: () => undefined,
    setWorkerBinding: () => undefined,
    startWorkerIfNeeded: async () => undefined,
    enqueueJob: () => ({
      reply: "",
      shouldStartWorker: true
    }),
    buildAutonomousExecutionInput: (goal) => goal,
    ...overrides
  };
}

test("approveProposal clears the active draft and enqueues the proposal input", () => {
  const session = buildSession();
  const enqueuedInputs: string[] = [];

  const reply = approveProposal(
    session,
    buildMessage("approve"),
    buildDeps({
      enqueueJob: (_session, input) => {
        enqueuedInputs.push(input);
        return {
          reply: "",
          shouldStartWorker: true
        };
      }
    })
  );

  assert.equal(enqueuedInputs[0], "schedule focused work");
  assert.equal(session.activeProposal, null);
  assert.ok(reply.includes("Draft draft-1 approved."));
  assert.ok(reply.includes("Execution started. Use /status for live state."));
});

test("resolveInterpretedPulseCommandArgument honors model-assisted pulse control when confidence passes", async () => {
  const session = buildSession({
    activeProposal: null,
    conversationTurns: [
      {
        role: "user",
        text: "turn pulse on",
        at: "2026-03-07T15:00:00.000Z"
      }
    ]
  });

  const interpreted = await resolveInterpretedPulseCommandArgument(
    "turn pulse public",
    session,
    buildDeps({
      interpretConversationIntent: async () => ({
        intentType: "pulse_control",
        pulseMode: "public",
        confidence: 0.96,
        lexicalClassification: null
      }) as never
    })
  );

  assert.equal(interpreted?.pulseMode, "public");
});

test("handleImplicitProposalFlow executes direct clarifying answers while proposal is idle", async () => {
  const session = buildSession();
  const reply = await handleImplicitProposalFlow(
    session,
    buildMessage("plain text"),
    async () => ({
      summary: "I will render the approval diff in plain text."
    }),
    buildDeps()
  );

  assert.ok(reply.includes("I will render the approval diff in plain text."));
  assert.ok(reply.includes("Draft draft-1 is still pending."));
  assert.equal(session.conversationTurns.length, 2);
  assert.equal(session.conversationTurns[0]?.role, "user");
  assert.equal(session.conversationTurns[1]?.role, "assistant");
});
