/**
 * @fileoverview Tests shared interface entity-graph runtime helpers for Stage 6.86 read/write lifecycle wiring.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { EntityGraphStore } from "../../src/core/entityGraphStore";
import {
  buildInboundEntityGraphEvidenceRef,
  createDynamicPulseEntityGraphGetter,
  EntityGraphStoreLike,
  maybeRecordInboundEntityGraphMutation
} from "../../src/interfaces/entityGraphRuntime";
import type {
  EntityDomainHintInterpretationResolver,
  EntityTypeInterpretationResolver
} from "../../src/organs/languageUnderstanding/localIntentModelContracts";

test("buildInboundEntityGraphEvidenceRef normalizes provider, conversation, and event ids", () => {
  const reference = buildInboundEntityGraphEvidenceRef("telegram", "chat:prod room", "event#42");
  assert.equal(reference, "interface:telegram:chat_prod_room:event_42");
});

test("createDynamicPulseEntityGraphGetter binds reads to shared store only when enabled", async () => {
  let getGraphCalls = 0;
  const store: EntityGraphStoreLike = {
    getGraph: async () => {
      getGraphCalls += 1;
      return {
        schemaVersion: "v1",
        updatedAt: new Date().toISOString(),
        entities: [],
        edges: []
      };
    },
    upsertFromExtractionInput: async () => undefined
  };

  const disabledGetter = createDynamicPulseEntityGraphGetter(false, store);
  assert.equal(disabledGetter, undefined);

  const enabledGetter = createDynamicPulseEntityGraphGetter(true, store);
  assert.ok(enabledGetter);
  await enabledGetter?.();
  assert.equal(getGraphCalls, 1);
});

test("maybeRecordInboundEntityGraphMutation persists provider-scoped evidence refs in shared store", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage6_86-interface-"));
  const graphPath = path.join(tempDir, "entity_graph.json");
  const store = new EntityGraphStore(graphPath, { backend: "json" });

  try {
    const firstWrite = await maybeRecordInboundEntityGraphMutation(
      store,
      true,
      {
        provider: "telegram",
        conversationId: "chat-1",
        eventId: "1001",
        text: "Alice met Bob at Contoso Labs for Launch Review.",
        observedAt: "2026-03-03T10:00:00.000Z",
        domainHint: "workflow"
      },
      {}
    );
    const secondWrite = await maybeRecordInboundEntityGraphMutation(
      store,
      true,
      {
        provider: "discord",
        conversationId: "channel-9",
        eventId: "2002",
        text: "Charlie and Dana joined Fabrikam Summit planning.",
        observedAt: "2026-03-03T10:05:00.000Z"
      },
      {}
    );

    assert.equal(firstWrite, true);
    assert.equal(secondWrite, true);

    const graph = await store.getGraph();
    assert.ok(graph.entities.length > 0);
    const allEvidenceRefs = new Set([
      ...graph.entities.flatMap((node) => node.evidenceRefs),
      ...graph.edges.flatMap((edge) => edge.evidenceRefs)
    ]);
    assert.ok(allEvidenceRefs.has("interface:telegram:chat-1:1001"));
    assert.ok(allEvidenceRefs.has("interface:discord:channel-9:2002"));
    const workflowNodes = graph.entities.filter((node) => node.evidenceRefs.includes("interface:telegram:chat-1:1001"));
    assert.ok(workflowNodes.length > 0);
    assert.ok(workflowNodes.every((node) => node.domainHint === "workflow"));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("maybeRecordInboundEntityGraphMutation fails closed with deterministic false return on write error", async () => {
  let failureMessage = "";
  const failingStore: EntityGraphStoreLike = {
    getGraph: async () => ({
      schemaVersion: "v1",
      updatedAt: new Date().toISOString(),
      entities: [],
      edges: []
    }),
    upsertFromExtractionInput: async () => {
      throw new Error("write denied");
    }
  };

  const persisted = await maybeRecordInboundEntityGraphMutation(
    failingStore,
    true,
    {
      provider: "telegram",
      conversationId: "chat-1",
      eventId: "1001",
      text: "Alice",
      observedAt: "2026-03-03T10:00:00.000Z"
    },
    {},
    (error) => {
      failureMessage = error.message;
    }
  );

  assert.equal(persisted, false);
  assert.equal(failureMessage, "write denied");
});

test("maybeRecordInboundEntityGraphMutation can apply validated entity-type interpretation hints before persistence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage6_86-entity-type-"));
  const graphPath = path.join(tempDir, "entity_graph.json");
  const store = new EntityGraphStore(graphPath, { backend: "json" });
  const resolver: EntityTypeInterpretationResolver = async (request) => {
    assert.equal(request.candidateEntities?.length, 2);
    assert.deepEqual(
      request.candidateEntities
        ?.map((candidate) => [candidate.candidateName, candidate.deterministicEntityType] as const)
        .sort((left, right) => left[0].localeCompare(right[0])),
      [
        ["Google", "thing"],
        ["Sarah", "thing"]
      ]
    );
    return {
      source: "local_intent_model",
      kind: "typed_candidates",
      typedCandidates: [
        {
          candidateName: "Sarah",
          entityType: "person"
        },
        {
          candidateName: "Google",
          entityType: "org"
        }
      ],
      confidence: "high",
      explanation: "The turn frames Sarah as a friend and Google as the organization involved."
    };
  };

  try {
    const persisted = await maybeRecordInboundEntityGraphMutation(
      store,
      true,
      {
        provider: "telegram",
        conversationId: "chat-2",
        eventId: "2001",
        text: "my friend Sarah is meeting Google tomorrow.",
        observedAt: "2026-03-04T10:00:00.000Z",
        domainHint: "workflow"
      },
      {
        entityTypeInterpretationResolver: resolver
      }
    );

    assert.equal(persisted, true);
    const graph = await store.getGraph();
    const sarah = graph.entities.find((entity) => entity.canonicalName === "Sarah");
    const google = graph.entities.find((entity) => entity.canonicalName === "Google");
    assert.equal(sarah?.entityType, "person");
    assert.equal(google?.entityType, "org");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("maybeRecordInboundEntityGraphMutation fails closed to deterministic typing when the interpreter returns low confidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage6_86-entity-type-fallback-"));
  const graphPath = path.join(tempDir, "entity_graph.json");
  const store = new EntityGraphStore(graphPath, { backend: "json" });

  try {
    const persisted = await maybeRecordInboundEntityGraphMutation(
      store,
      true,
      {
        provider: "discord",
        conversationId: "channel-2",
        eventId: "3001",
        text: "my friend Sarah is joining later.",
        observedAt: "2026-03-04T11:00:00.000Z",
        domainHint: "relationship"
      },
      {
        entityTypeInterpretationResolver: async () => ({
          source: "local_intent_model",
          kind: "typed_candidates",
          typedCandidates: [
            {
              candidateName: "Sarah",
              entityType: "person"
            }
          ],
          confidence: "low",
          explanation: "Low confidence should fail closed."
        })
      }
    );

    assert.equal(persisted, true);
    const graph = await store.getGraph();
    const sarah = graph.entities.find((entity) => entity.canonicalName === "Sarah");
    assert.equal(sarah?.entityType, "thing");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("maybeRecordInboundEntityGraphMutation can apply validated entity-domain hints before persistence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage6_86-entity-domain-"));
  const graphPath = path.join(tempDir, "entity_graph.json");
  const store = new EntityGraphStore(graphPath, { backend: "json" });
  const resolver: EntityDomainHintInterpretationResolver = async (request) => {
    assert.equal(request.candidateEntities?.length, 2);
    assert.deepEqual(
      request.candidateEntities
        ?.map((candidate) => [
          candidate.candidateName,
          candidate.entityType,
          candidate.deterministicDomainHint
        ] as const)
        .sort((left, right) => left[0].localeCompare(right[0])),
      [
        ["Google", "thing", "workflow"],
        ["Sarah", "thing", "workflow"]
      ]
    );
    return {
      source: "local_intent_model",
      kind: "domain_hinted_candidates",
      domainHintedCandidates: [
        {
          candidateName: "Sarah",
          domainHint: "relationship"
        },
        {
          candidateName: "Google",
          domainHint: "workflow"
        }
      ],
      confidence: "high",
      explanation: "Sarah is framed as a friend while Google stays in task context."
    };
  };

  try {
    const persisted = await maybeRecordInboundEntityGraphMutation(
      store,
      true,
      {
        provider: "telegram",
        conversationId: "chat-3",
        eventId: "4001",
        text: "my friend Sarah is meeting Google tomorrow.",
        observedAt: "2026-03-04T12:00:00.000Z",
        domainHint: "workflow"
      },
      {
        entityDomainHintInterpretationResolver: resolver
      }
    );

    assert.equal(persisted, true);
    const graph = await store.getGraph();
    const sarah = graph.entities.find((entity) => entity.canonicalName === "Sarah");
    const google = graph.entities.find((entity) => entity.canonicalName === "Google");
    assert.equal(sarah?.domainHint, "relationship");
    assert.equal(google?.domainHint, "workflow");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("maybeRecordInboundEntityGraphMutation fails closed to deterministic domain hints when the interpreter returns low confidence", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage6_86-entity-domain-fallback-"));
  const graphPath = path.join(tempDir, "entity_graph.json");
  const store = new EntityGraphStore(graphPath, { backend: "json" });

  try {
    const persisted = await maybeRecordInboundEntityGraphMutation(
      store,
      true,
      {
        provider: "discord",
        conversationId: "channel-4",
        eventId: "5001",
        text: "my friend Sarah is joining the review later.",
        observedAt: "2026-03-04T13:00:00.000Z",
        domainHint: "workflow"
      },
      {
        entityDomainHintInterpretationResolver: async () => ({
          source: "local_intent_model",
          kind: "domain_hinted_candidates",
          domainHintedCandidates: [
            {
              candidateName: "Sarah",
              domainHint: "relationship"
            }
          ],
          confidence: "low",
          explanation: "Low confidence should fail closed."
        })
      }
    );

    assert.equal(persisted, true);
    const graph = await store.getGraph();
    const sarah = graph.entities.find((entity) => entity.canonicalName === "Sarah");
    assert.equal(sarah?.domainHint, "workflow");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
