/**
 * @fileoverview Tests deterministic Stage 6.86 entity graph JSON/SQLite persistence parity and bootstrap behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { EntityGraphStore } from "../../src/core/entityGraphStore";
import type { EntityGraphV1 } from "../../src/core/types";

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
      text: "Owen and Sarah met at Lantern Labs.",
      observedAt: "2026-03-01T00:00:00.000Z",
      evidenceRef: "trace:json_upsert",
      domainHint: "workflow"
    });

    assert.equal(mutation.graph.entities.length, 3);
    assert.equal(mutation.graph.edges.length, 3);
    assert.ok(mutation.graph.entities.every((entity) => entity.domainHint === "workflow"));

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
              domainHint: null,
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
      text: "Owen and Sarah met at Lantern Labs.",
      observedAt: "2026-03-01T00:00:00.000Z",
      evidenceRef: "trace:parity",
      domainHint: "workflow" as const
    };
    const jsonMutation = await jsonStore.upsertFromExtractionInput(input);
    const sqliteMutation = await sqliteStore.upsertFromExtractionInput(input);

    assert.deepEqual(sqliteMutation.graph, jsonMutation.graph);
    assert.deepEqual(sqliteMutation.acceptedEntityKeys, jsonMutation.acceptedEntityKeys);
    assert.deepEqual(sqliteMutation.aliasConflicts, jsonMutation.aliasConflicts);
    assert.deepEqual(sqliteMutation.evictedEdgeKeys, jsonMutation.evictedEdgeKeys);
  });
}

/**
 * Implements `conflictingEntityDomainHintsDegradeToNull` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function conflictingEntityDomainHintsDegradeToNull(): Promise<void> {
  await withTempDir(async (tempDir) => {
    const graphPath = path.join(tempDir, "entity_graph.json");
    const store = new EntityGraphStore(graphPath, { backend: "json" });

    await store.upsertFromExtractionInput({
      text: "Owen joined Lantern Labs.",
      observedAt: "2026-03-01T00:00:00.000Z",
      evidenceRef: "trace:workflow",
      domainHint: "workflow"
    });
    await store.upsertFromExtractionInput({
      text: "Owen joined Lantern Labs.",
      observedAt: "2026-03-02T00:00:00.000Z",
      evidenceRef: "trace:profile",
      domainHint: "profile"
    });

    const graph = await store.getGraph();
    assert.ok(graph.entities.every((entity) => entity.domainHint === null));
  });
}

/**
 * Implements `aliasCandidateReconciliationPersistsValidatedAlias` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function aliasCandidateReconciliationPersistsValidatedAlias(): Promise<void> {
  await withTempDir(async (tempDir) => {
    const graphPath = path.join(tempDir, "entity_graph.json");
    const store = new EntityGraphStore(graphPath, { backend: "json" });
    const seedGraph: EntityGraphV1 = {
      schemaVersion: "v1",
      updatedAt: "2026-03-01T00:00:00.000Z",
      entities: [
        {
          entityKey: "entity_sarah",
          canonicalName: "Sarah",
          entityType: "person",
          disambiguator: null,
          domainHint: "relationship",
          aliases: ["Sarah"],
          firstSeenAt: "2026-03-01T00:00:00.000Z",
          lastSeenAt: "2026-03-01T00:00:00.000Z",
          salience: 1,
          evidenceRefs: ["trace:seed_sarah"]
        }
      ],
      edges: []
    };
    await store.persistGraph(seedGraph);

    const mutation = await store.reconcileAliasCandidate({
      entityKey: "entity_sarah",
      aliasCandidate: "Sarah Connor",
      observedAt: "2026-03-02T00:00:00.000Z",
      evidenceRef: "trace:alias_candidate"
    });

    assert.equal(mutation.acceptedAlias, "Sarah Connor");
    assert.equal(mutation.rejectionReason, null);
    const graph = await store.getGraph();
    assert.deepEqual(graph.entities[0]?.aliases, ["Sarah", "Sarah Connor"]);
  });
}

/**
 * Implements `aliasCandidateReconciliationRejectsCollidingAlias` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function aliasCandidateReconciliationRejectsCollidingAlias(): Promise<void> {
  await withTempDir(async (tempDir) => {
    const graphPath = path.join(tempDir, "entity_graph.json");
    const store = new EntityGraphStore(graphPath, { backend: "json" });
    const seedGraph: EntityGraphV1 = {
      schemaVersion: "v1",
      updatedAt: "2026-03-01T00:00:00.000Z",
      entities: [
        {
          entityKey: "entity_sarah",
          canonicalName: "Sarah",
          entityType: "person",
          disambiguator: null,
          domainHint: "relationship",
          aliases: ["Sarah"],
          firstSeenAt: "2026-03-01T00:00:00.000Z",
          lastSeenAt: "2026-03-01T00:00:00.000Z",
          salience: 1,
          evidenceRefs: ["trace:seed_sarah"]
        },
        {
          entityKey: "entity_sarah_connor",
          canonicalName: "Sarah Connor",
          entityType: "person",
          disambiguator: null,
          domainHint: "relationship",
          aliases: ["Sarah Connor"],
          firstSeenAt: "2026-03-01T00:00:00.000Z",
          lastSeenAt: "2026-03-01T00:00:00.000Z",
          salience: 1,
          evidenceRefs: ["trace:seed_sarah_connor"]
        }
      ],
      edges: []
    };
    await store.persistGraph(seedGraph);

    const mutation = await store.reconcileAliasCandidate({
      entityKey: "entity_sarah",
      aliasCandidate: "Sarah Connor",
      observedAt: "2026-03-02T00:00:00.000Z",
      evidenceRef: "trace:alias_candidate"
    });

    assert.equal(mutation.acceptedAlias, null);
    assert.equal(mutation.rejectionReason, "ALIAS_COLLISION");
    assert.equal(mutation.aliasConflicts.length, 1);
    const graph = await store.getGraph();
    assert.deepEqual(graph.entities[0]?.aliases, ["Sarah"]);
  });
}

/**
 * Implements `entityTypeHintsApplyBeforeDeterministicGraphPersistence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function entityTypeHintsApplyBeforeDeterministicGraphPersistence(): Promise<void> {
  await withTempDir(async (tempDir) => {
    const graphPath = path.join(tempDir, "entity_graph.json");
    const store = new EntityGraphStore(graphPath, { backend: "json" });

    const mutation = await store.upsertFromExtractionInput({
      text: "My friend Sarah is meeting Google tomorrow.",
      observedAt: "2026-03-05T00:00:00.000Z",
      evidenceRef: "trace:entity_type_hints",
      domainHint: "workflow",
      entityTypeHints: [
        {
          candidateName: "Sarah",
          entityType: "person"
        },
        {
          candidateName: "Google",
          entityType: "org"
        }
      ]
    });

    const sarah = mutation.graph.entities.find((entity) => entity.canonicalName === "Sarah");
    const google = mutation.graph.entities.find((entity) => entity.canonicalName === "Google");
    assert.equal(sarah?.entityType, "person");
    assert.equal(google?.entityType, "org");
  });
}

/**
 * Implements `entityDomainHintsApplyBeforeDeterministicGraphPersistence` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function entityDomainHintsApplyBeforeDeterministicGraphPersistence(): Promise<void> {
  await withTempDir(async (tempDir) => {
    const graphPath = path.join(tempDir, "entity_graph.json");
    const store = new EntityGraphStore(graphPath, { backend: "json" });

    const mutation = await store.upsertFromExtractionInput({
      text: "My friend Sarah is meeting Google tomorrow.",
      observedAt: "2026-03-05T00:05:00.000Z",
      evidenceRef: "trace:entity_domain_hints",
      domainHint: "workflow",
      entityDomainHints: [
        {
          candidateName: "Sarah",
          domainHint: "relationship"
        },
        {
          candidateName: "Google",
          domainHint: "workflow"
        }
      ]
    });

    const sarah = mutation.graph.entities.find((entity) => entity.canonicalName === "Sarah");
    const google = mutation.graph.entities.find((entity) => entity.canonicalName === "Google");
    assert.equal(sarah?.domainHint, "relationship");
    assert.equal(google?.domainHint, "workflow");
  });
}

/**
 * Implements `relationshipExtractionDropsClauseBoundaryAndLeadingStopwordCandidates` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function relationshipExtractionDropsClauseBoundaryAndLeadingStopwordCandidates(): Promise<void> {
  await withTempDir(async (tempDir) => {
    const graphPath = path.join(tempDir, "entity_graph.json");
    const store = new EntityGraphStore(graphPath, { backend: "json" });

    const mutation = await store.upsertFromExtractionInput({
      text: "Owen used to work for me. Milo is my boss. And Milo, who is he?",
      observedAt: "2026-03-26T15:38:00.000Z",
      evidenceRef: "trace:relationship_candidate_cleanup",
      domainHint: "relationship"
    });

    const canonicalNames = mutation.graph.entities.map((entity) => entity.canonicalName).sort();
    assert.ok(canonicalNames.includes("Owen"));
    assert.ok(canonicalNames.includes("Milo"));
    assert.ok(!canonicalNames.includes("Owen. Milo"));
    assert.ok(!canonicalNames.includes("And Milo"));
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
test(
  "stage 6.86 entity graph store degrades conflicting domain hints to null",
  conflictingEntityDomainHintsDegradeToNull
);
test(
  "stage 6.86 entity graph store reconciles one validated alias candidate onto the selected entity",
  aliasCandidateReconciliationPersistsValidatedAlias
);
test(
  "stage 6.86 entity graph store rejects alias candidates that collide with another entity",
  aliasCandidateReconciliationRejectsCollidingAlias
);
test(
  "stage 6.86 entity graph store applies validated entity type hints before persistence",
  entityTypeHintsApplyBeforeDeterministicGraphPersistence
);
test(
  "stage 6.86 entity graph store applies validated entity domain hints before persistence",
  entityDomainHintsApplyBeforeDeterministicGraphPersistence
);
test(
  "stage 6.86 entity graph store drops clause-boundary and leading-stopword relationship candidates",
  relationshipExtractionDropsClauseBoundaryAndLeadingStopwordCandidates
);
