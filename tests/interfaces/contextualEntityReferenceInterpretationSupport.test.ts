/**
 * @fileoverview Tests bounded entity-reference interpretation helpers for contextual recall and alias reconciliation.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { EntityGraphV1 } from "../../src/core/types";
import {
  createProfileMemoryRequestTelemetry
} from "../../src/core/profileMemoryRuntime/profileMemoryRequestTelemetry";
import {
  reconcileInterpretedEntityAliasCandidateForTurn,
  resolveInterpretedEntityReferenceHints
} from "../../src/interfaces/conversationRuntime/contextualEntityReferenceInterpretationSupport";
import {
  buildConversationSessionFixture
} from "../helpers/conversationFixtures";

function buildAliasClarificationGraph(): EntityGraphV1 {
  return {
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
  };
}

function buildResolvedEntityGraph(): EntityGraphV1 {
  return {
    schemaVersion: "v1",
    updatedAt: "2026-03-21T09:00:00.000Z",
    entities: [
      {
        entityKey: "entity_sarah",
        canonicalName: "Sarah Connor",
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
  };
}

test("resolveInterpretedEntityReferenceHints returns bounded entity hints for one validated entity-scoped selection", async () => {
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

  const hints = await resolveInterpretedEntityReferenceHints(
    session,
    "How is she doing now?",
    {
      directTerms: [],
      resolvedHints: ["sarah", "connor"],
      hasRecallCue: true,
      usedFallbackContext: true
    },
    async () => buildResolvedEntityGraph(),
    async (request) => {
      assert.equal(request.userInput, "How is she doing now?");
      assert.equal(request.candidateEntities?.length, 2);
      return {
        source: "local_intent_model",
        kind: "entity_scoped_reference",
        selectedEntityKeys: ["entity_sarah"],
        confidence: "medium",
        explanation: "The user is asking about Sarah Connor specifically."
      };
    }
  );

  assert.deepEqual(hints, {
    selectedEntityKeys: ["entity_sarah"],
    selectedEntityLabels: ["Sarah Connor"],
    resolvedEntityHints: ["connor", "sarah"],
    explanation: "The user is asking about Sarah Connor specifically."
  });
});

test("reconcileInterpretedEntityAliasCandidateForTurn forwards one medium-confidence alias candidate with bounded evidence", async () => {
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
  const requestTelemetry = createProfileMemoryRequestTelemetry();
  let reconciliationCalls = 0;
  let recordedRequest:
    | {
        entityKey: string;
        aliasCandidate: string;
        observedAt: string;
        evidenceRef: string;
      }
    | null = null;

  const result = await reconcileInterpretedEntityAliasCandidateForTurn(
    session,
    "I mean Sarah Connor, not Sarah Lee.",
    "2026-03-21T09:00:10.000Z",
    async () => buildAliasClarificationGraph(),
    async () => ({
      source: "local_intent_model",
      kind: "entity_alias_candidate",
      selectedEntityKeys: ["entity_sarah"],
      aliasCandidate: "Sarah Connor",
      confidence: "medium",
      explanation: "The user is clarifying which Sarah they meant."
    }),
    async (request) => {
      reconciliationCalls += 1;
      recordedRequest = request;
      return {
        acceptedAlias: request.aliasCandidate,
        rejectionReason: null
      };
    },
    requestTelemetry
  );

  assert.equal(reconciliationCalls, 1);
  assert.equal(requestTelemetry.aliasSafetyDecisionCount, 1);
  assert.deepEqual(recordedRequest, {
    entityKey: "entity_sarah",
    aliasCandidate: "Sarah Connor",
    observedAt: "2026-03-21T09:00:10.000Z",
    evidenceRef:
      "conversation.entity_alias_interpretation:telegram:chat-1:user-1:2026-03-21T09:00:10.000Z:entity_sarah"
  });
  assert.deepEqual(result, {
    acceptedAlias: "Sarah Connor",
    rejectionReason: null
  });
});

test("reconcileInterpretedEntityAliasCandidateForTurn fails closed for low-confidence or multi-entity alias candidates", async () => {
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
  const requestTelemetry = createProfileMemoryRequestTelemetry();
  let reconciliationCalls = 0;

  const lowConfidence = await reconcileInterpretedEntityAliasCandidateForTurn(
    session,
    "I mean Sarah Connor, not Sarah Lee.",
    "2026-03-21T09:00:10.000Z",
    async () => buildAliasClarificationGraph(),
    async () => ({
      source: "local_intent_model",
      kind: "entity_alias_candidate",
      selectedEntityKeys: ["entity_sarah"],
      aliasCandidate: "Sarah Connor",
      confidence: "low",
      explanation: "This should fail closed."
    }),
    async () => {
      reconciliationCalls += 1;
      return {
        acceptedAlias: "Sarah Connor",
        rejectionReason: null
      };
    },
    requestTelemetry
  );
  const ambiguous = await reconcileInterpretedEntityAliasCandidateForTurn(
    session,
    "I mean Sarah Connor, not Sarah Lee.",
    "2026-03-21T09:00:10.000Z",
    async () => buildAliasClarificationGraph(),
    async () => ({
      source: "local_intent_model",
      kind: "entity_alias_candidate",
      selectedEntityKeys: ["entity_sarah", "entity_sarah_lee"],
      aliasCandidate: "Sarah Connor",
      confidence: "high",
      explanation: "This should also fail closed."
    }),
    async () => {
      reconciliationCalls += 1;
      return {
        acceptedAlias: "Sarah Connor",
        rejectionReason: null
      };
    },
    requestTelemetry
  );

  assert.equal(lowConfidence, null);
  assert.equal(ambiguous, null);
  assert.equal(reconciliationCalls, 0);
  assert.equal(requestTelemetry.aliasSafetyDecisionCount, 2);
});
