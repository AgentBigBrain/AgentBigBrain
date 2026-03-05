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
        observedAt: "2026-03-03T10:00:00.000Z"
      }
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
      }
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
    (error) => {
      failureMessage = error.message;
    }
  );

  assert.equal(persisted, false);
  assert.equal(failureMessage, "write denied");
});
