/**
 * @fileoverview Tests deterministic Stage 6.86 entity graph JSON/SQLite persistence parity and bootstrap behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { EntityGraphStore } from "../../src/core/entityGraphStore";

/**
 * Implements `withTempDir` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withTempDir(run: (tempDir: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "obb-stage686-"));
  try {
    await run(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Implements `jsonBackendPersistsUpsertedEntityGraph` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function jsonBackendPersistsUpsertedEntityGraph(): Promise<void> {
  await withTempDir(async (tempDir) => {
    const graphPath = path.join(tempDir, "entity_graph.json");
    const store = new EntityGraphStore(graphPath, { backend: "json" });

    const mutation = await store.upsertFromExtractionInput({
      text: "Billy and Sarah met at Flare Labs.",
      observedAt: "2026-03-01T00:00:00.000Z",
      evidenceRef: "trace:json_upsert"
    });

    assert.equal(mutation.graph.entities.length, 3);
    assert.equal(mutation.graph.edges.length, 3);

    const reloadedStore = new EntityGraphStore(graphPath, { backend: "json" });
    const reloadedGraph = await reloadedStore.getGraph();
    assert.equal(reloadedGraph.entities.length, 3);
    assert.equal(reloadedGraph.edges.length, 3);
  });
}

/**
 * Implements `sqliteBackendBootstrapsFromJsonSnapshotWhenEmpty` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function sqliteBackendBootstrapsFromJsonSnapshotWhenEmpty(): Promise<void> {
  await withTempDir(async (tempDir) => {
    const graphPath = path.join(tempDir, "entity_graph.json");
    const sqlitePath = path.join(tempDir, "entity_graph.sqlite");

    await writeFile(
      graphPath,
      `${JSON.stringify(
        {
          schemaVersion: "v1",
          updatedAt: "2026-03-01T00:00:00.000Z",
          entities: [
            {
              entityKey: "entity_seed_001",
              canonicalName: "Seed Entity",
              entityType: "thing",
              disambiguator: null,
              aliases: ["Seed Entity"],
              firstSeenAt: "2026-03-01T00:00:00.000Z",
              lastSeenAt: "2026-03-01T00:00:00.000Z",
              salience: 1,
              evidenceRefs: ["trace:seed"]
            }
          ],
          edges: []
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const store = new EntityGraphStore(graphPath, {
      backend: "sqlite",
      sqlitePath,
      exportJsonOnWrite: false
    });
    const graph = await store.getGraph();
    assert.equal(graph.entities.length, 1);
    assert.equal(graph.entities[0]?.canonicalName, "Seed Entity");
  });
}

/**
 * Implements `sqliteAndJsonBackendsProduceEquivalentMutationResults` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function sqliteAndJsonBackendsProduceEquivalentMutationResults(): Promise<void> {
  await withTempDir(async (tempDir) => {
    const jsonPath = path.join(tempDir, "entity_graph_json_backend.json");
    const sqliteJsonPath = path.join(tempDir, "entity_graph_sqlite_backend.json");
    const sqlitePath = path.join(tempDir, "entity_graph.sqlite");

    const jsonStore = new EntityGraphStore(jsonPath, { backend: "json" });
    const sqliteStore = new EntityGraphStore(sqliteJsonPath, {
      backend: "sqlite",
      sqlitePath,
      exportJsonOnWrite: false
    });

    const input = {
      text: "Billy and Sarah met at Flare Labs.",
      observedAt: "2026-03-01T00:00:00.000Z",
      evidenceRef: "trace:parity"
    };
    const jsonMutation = await jsonStore.upsertFromExtractionInput(input);
    const sqliteMutation = await sqliteStore.upsertFromExtractionInput(input);

    assert.deepEqual(sqliteMutation.graph, jsonMutation.graph);
    assert.deepEqual(sqliteMutation.acceptedEntityKeys, jsonMutation.acceptedEntityKeys);
    assert.deepEqual(sqliteMutation.aliasConflicts, jsonMutation.aliasConflicts);
    assert.deepEqual(sqliteMutation.evictedEdgeKeys, jsonMutation.evictedEdgeKeys);
  });
}

test(
  "stage 6.86 entity graph store persists deterministic extraction mutations in JSON backend",
  jsonBackendPersistsUpsertedEntityGraph
);
test(
  "stage 6.86 entity graph store bootstraps SQLite backend from existing JSON snapshot when empty",
  sqliteBackendBootstrapsFromJsonSnapshotWhenEmpty
);
test(
  "stage 6.86 entity graph store keeps deterministic mutation parity across JSON and SQLite backends",
  sqliteAndJsonBackendsProduceEquivalentMutationResults
);
