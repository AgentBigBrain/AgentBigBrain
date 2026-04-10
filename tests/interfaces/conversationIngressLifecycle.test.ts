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
