/**
 * @fileoverview Tests bounded entity-reference reuse at the conversation ingress coordinator.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { processConversationMessage } from "../../src/interfaces/conversationIngressLifecycle";
import {
  createFollowUpRuleContext,
  createPulseLexicalRuleContext
} from "../../src/interfaces/conversationManagerHelpers";
import type {
  ConversationInboundMessage,
  ExecuteConversationTask
} from "../../src/interfaces/conversationRuntime/managerContracts";
import type { ConversationIngressDependencies } from "../../src/interfaces/conversationRuntime/contracts";
import type { ConversationSession } from "../../src/interfaces/sessionStore";
import {
  buildConversationIngressConfig,
  buildConversationSessionFixture
} from "../helpers/conversationFixtures";

function buildMessage(
  text: string,
  receivedAt: string
): ConversationInboundMessage {
  return {
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
    text,
    receivedAt
  };
}

function createIngressDeps(
  session: ConversationSession,
  overrides: Partial<ConversationIngressDependencies> = {}
): ConversationIngressDependencies {
  let currentSession = session;
  return {
    store: {
      getSession: async () => currentSession,
      setSession: async (nextSession) => {
        currentSession = nextSession;
      }
    },
    config: buildConversationIngressConfig(),
    followUpRuleContext: createFollowUpRuleContext(null),
    pulseLexicalRuleContext: createPulseLexicalRuleContext(null),
    intentInterpreterConfidenceThreshold: 0.7,
    isWorkerActive: () => false,
    clearAckTimer: () => undefined,
    setWorkerBinding: () => undefined,
    startWorkerIfNeeded: async () => undefined,
    enqueueJob: () => ({
      reply: "Queued.",
      shouldStartWorker: true
    }),
    buildAutonomousExecutionInput: (goal) => goal,
    ...overrides
  };
}

test("processConversationMessage reuses one bounded entity-reference interpretation result during alias clarification chat", async () => {
  const receivedAt = "2026-03-21T09:00:10.000Z";
  const aliasMutations: Array<{
    entityKey: string;
    aliasCandidate: string;
    observedAt: string;
    evidenceRef: string;
  }> = [];
  let interpretationCalls = 0;
  const session = buildConversationSessionFixture(
    {
      updatedAt: "2026-03-21T09:00:00.000Z",
      conversationTurns: [
        {
          role: "user",
          text: "Sarah said the client meeting went badly.",
          at: "2026-03-21T08:59:00.000Z"
        },
        {
          role: "assistant",
          text: "If she comes up again, I can help you revisit that situation.",
          at: "2026-03-21T08:59:10.000Z"
        }
      ]
    },
    {
      conversationId: "chat-1",
      receivedAt: "2026-03-21T09:00:00.000Z"
    }
  );
  const deps = createIngressDeps(session, {
    runDirectConversationTurn: async () => ({ summary: "Okay." }),
    getEntityGraph: async () => ({
      schemaVersion: "v1",
      updatedAt: "2026-03-21T09:00:00.000Z",
      entities: [
        {
          entityKey: "entity_sarah",
          canonicalName: "Sarah",
          entityType: "person",
          disambiguator: null,
          domainHint: "relationship",
          aliases: ["Sarah"],
          firstSeenAt: "2026-03-21T08:59:00.000Z",
          lastSeenAt: "2026-03-21T08:59:00.000Z",
          salience: 2,
          evidenceRefs: ["trace:sarah"]
        },
        {
          entityKey: "entity_sarah_lee",
          canonicalName: "Sarah Lee",
          entityType: "person",
          disambiguator: null,
          domainHint: "relationship",
          aliases: ["Sarah Lee"],
          firstSeenAt: "2026-03-21T08:59:00.000Z",
          lastSeenAt: "2026-03-21T08:59:00.000Z",
          salience: 1,
          evidenceRefs: ["trace:sarah_lee"]
        }
      ],
      edges: []
    }),
    entityReferenceInterpretationResolver: async (request) => {
      interpretationCalls += 1;
      assert.equal(request.userInput, "I mean Sarah Connor, not Sarah Lee.");
      assert.equal(request.candidateEntities?.length, 2);
      return {
        source: "local_intent_model",
        kind: "entity_alias_candidate",
        selectedEntityKeys: ["entity_sarah"],
        aliasCandidate: "Sarah Connor",
        confidence: "medium",
        explanation: "The user is clarifying which Sarah they meant."
      };
    },
    reconcileEntityAliasCandidate: async (request) => {
      aliasMutations.push(request);
      return {
        acceptedAlias: request.aliasCandidate,
        rejectionReason: null
      };
    }
  });

  const reply = await processConversationMessage(
    buildMessage("I mean Sarah Connor, not Sarah Lee.", receivedAt),
    (async () => {
      throw new Error("executeTask should not run for bounded entity-alias clarification chat");
    }) as ExecuteConversationTask,
    async () => undefined,
    deps
  );

  assert.equal(reply, "Okay.");
  assert.equal(interpretationCalls, 1);
  assert.equal(aliasMutations.length, 1);
  assert.deepEqual(aliasMutations[0], {
    entityKey: "entity_sarah",
    aliasCandidate: "Sarah Connor",
    observedAt: receivedAt,
    evidenceRef:
      "conversation.entity_alias_interpretation:telegram:chat-1:user-1:2026-03-21T09:00:10.000Z:entity_sarah"
  });
});

test("processConversationMessage ignores one exact inbound replay instead of queueing duplicate autonomous work", async () => {
  const receivedAt = "2026-04-10T17:55:53.000Z";
  const userInput =
    'I want you to create a nextjs landing page, with 4 sections called "Detroit City 2" and there should be a footer and header, a gritty feeling design, and you need to do this end to end and put it on my desktop, then leave it open in the browser so i can review it. This means you have to run it and leave it open.';
  const session = buildConversationSessionFixture(
    {
      updatedAt: receivedAt,
      conversationTurns: [
        {
          role: "user",
          text: userInput,
          at: receivedAt
        }
      ],
      recentJobs: [
        {
          id: "job_existing",
          input: userInput,
          executionInput: userInput,
          createdAt: receivedAt,
          startedAt: receivedAt,
          completedAt: null,
          status: "running",
          resultSummary: null,
          errorMessage: null,
          isSystemJob: false,
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
          pauseRequestedAt: null
        }
      ],
      runningJobId: "job_existing"
    },
    {
      conversationId: "chat-1",
      receivedAt
    }
  );
  let setSessionCalls = 0;
  let enqueueCalls = 0;
  const deps = createIngressDeps(session, {
    store: {
      getSession: async () => session,
      setSession: async () => {
        setSessionCalls += 1;
      }
    },
    enqueueJob: () => {
      enqueueCalls += 1;
      return {
        reply: "Queued.",
        shouldStartWorker: true
      };
    }
  });

  const reply = await processConversationMessage(
    buildMessage(userInput, receivedAt),
    (async () => {
      throw new Error("executeTask should not run for one exact inbound replay");
    }) as ExecuteConversationTask,
    async () => undefined,
    deps
  );

  assert.equal(reply, "");
  assert.equal(enqueueCalls, 0);
  assert.equal(setSessionCalls, 0);
});

test("processConversationMessage recovers an orphaned running job before queueing a fresh autonomous request", async () => {
  const receivedAt = "2026-04-10T18:12:33.000Z";
  const previousUpdateAt = "2026-04-10T18:12:00.000Z";
  const userInput =
    'I want you to create a nextjs landing page, with 4 sections called "Detroit City" and there should be a footer and header, a gritty feeling design, and you need to do this end to end and put it on my desktop, then leave it open in the browser so i can review it. This means you have to run it and leave it open.';
  const session = buildConversationSessionFixture(
    {
      updatedAt: previousUpdateAt,
      runningJobId: "job_orphaned",
      progressState: {
        status: "working",
        message: "I'm building the page and setting up the preview.",
        jobId: "job_orphaned",
        updatedAt: previousUpdateAt,
        recoveryTrace: null
      },
      recentJobs: [
        {
          id: "job_orphaned",
          input: userInput,
          executionInput: userInput,
          createdAt: previousUpdateAt,
          startedAt: previousUpdateAt,
          completedAt: null,
          status: "running",
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
          pauseRequestedAt: null
        }
      ]
    },
    {
      conversationId: "chat-1",
      receivedAt: previousUpdateAt
    }
  );
  let currentSession = session;
  let enqueueCalls = 0;
  const deps = createIngressDeps(session, {
    config: {
      ...buildConversationIngressConfig(),
      staleRunningJobRecoveryMs: 60_000
    },
    store: {
      getSession: async () => currentSession,
      setSession: async (nextSession) => {
        currentSession = nextSession;
      }
    },
    enqueueJob: (mutableSession, input, createdAt, executionInput) => {
      enqueueCalls += 1;
      mutableSession.queuedJobs.push({
        id: `job_enqueued_${enqueueCalls}`,
        input,
        executionInput: executionInput ?? input,
        createdAt,
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
        pauseRequestedAt: null
      });
      return {
        reply: "Queued.",
        shouldStartWorker: true
      };
    }
  });

  const reply = await processConversationMessage(
    buildMessage(userInput, receivedAt),
    (async () => {
      throw new Error("executeTask should not run during ingress queueing");
    }) as ExecuteConversationTask,
    async () => undefined,
    deps
  );

  assert.equal(reply, "Queued.");
  assert.equal(enqueueCalls, 1);
  assert.equal(currentSession.runningJobId, null);
  assert.equal(currentSession.progressState?.status, undefined);
  assert.equal(currentSession.queuedJobs.length, 1);
  assert.equal(currentSession.recentJobs.some((job) => job.id === "job_orphaned" && job.status === "failed"), true);
});

test("processConversationMessage recovers a stale running job even when the worker bit is still set", async () => {
  const receivedAt = "2026-04-10T18:12:33.000Z";
  const previousUpdateAt = "2026-04-10T18:10:00.000Z";
  const userInput =
    'I want you to create a nextjs landing page, with 4 sections called "Detroit City Two" and there should be a footer and header, a gritty feeling design, and you need to do this end to end and put it on my desktop, then leave it open in the browser so i can review it. This means you have to run it and leave it open.';
  const session = buildConversationSessionFixture(
    {
      updatedAt: previousUpdateAt,
      runningJobId: "job_stuck",
      progressState: {
        status: "working",
        message: "I'm building the page and setting up the preview.",
        jobId: "job_stuck",
        updatedAt: previousUpdateAt,
        recoveryTrace: null
      },
      recentJobs: [
        {
          id: "job_stuck",
          input: userInput,
          executionInput: userInput,
          createdAt: previousUpdateAt,
          startedAt: previousUpdateAt,
          completedAt: null,
          status: "running",
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
          pauseRequestedAt: null
        }
      ]
    },
    {
      conversationId: "chat-1",
      receivedAt: previousUpdateAt
    }
  );
  let currentSession = session;
  let enqueueCalls = 0;
  const deps = createIngressDeps(session, {
    config: {
      ...buildConversationIngressConfig(),
      staleRunningJobRecoveryMs: 60_000
    },
    store: {
      getSession: async () => currentSession,
      setSession: async (nextSession) => {
        currentSession = nextSession;
      }
    },
    isWorkerActive: () => true,
    getWorkerLastSeenAt: () => previousUpdateAt,
    enqueueJob: (mutableSession, input, createdAt, executionInput) => {
      enqueueCalls += 1;
      mutableSession.queuedJobs.push({
        id: `job_enqueued_${enqueueCalls}`,
        input,
        executionInput: executionInput ?? input,
        createdAt,
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
        pauseRequestedAt: null
      });
      return {
        reply: "Queued.",
        shouldStartWorker: true
      };
    }
  });

  const reply = await processConversationMessage(
    buildMessage(userInput, receivedAt),
    (async () => {
      throw new Error("executeTask should not run during ingress queueing");
    }) as ExecuteConversationTask,
    async () => undefined,
    deps
  );

  assert.equal(reply, "Queued.");
  assert.equal(enqueueCalls, 1);
  assert.equal(currentSession.runningJobId, null);
  assert.equal(currentSession.progressState?.status, undefined);
  assert.equal(currentSession.queuedJobs.length, 1);
  assert.equal(currentSession.recentJobs.some((job) => job.id === "job_stuck" && job.status === "failed"), true);
});
