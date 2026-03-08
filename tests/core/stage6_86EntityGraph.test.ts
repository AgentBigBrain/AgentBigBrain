/**
 * @fileoverview Tests deterministic Stage 6.86 entity extraction and graph mutation behavior for checkpoint 6.86.A foundations.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { EntityGraphV1 } from "../../src/core/types";
import {
  applyEntityExtractionToGraph,
  buildEntityKey,
  computeCoMentionIncrement,
  createEmptyEntityGraphV1,
  extractEntityCandidates,
  getEntityLookupTerms,
  promoteRelationEdgeWithConfirmation
} from "../../src/core/stage6_86EntityGraph";

/**
 * Implements `extractsDeterministicEntityCandidates` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function extractsDeterministicEntityCandidates(): void {
  const input = {
    text: "Billy and Sarah met at Flare Labs before Project Aurora review.",
    observedAt: "2026-03-01T00:00:00.000Z",
    evidenceRef: "trace:entity_extract_001"
  };

  const first = extractEntityCandidates(input);
  const second = extractEntityCandidates(input);

  assert.deepEqual(first, second);
  assert.ok(first.nodes.length >= 3);
  assert.ok(first.nodes.some((node) => node.canonicalName === "Billy"));
  assert.ok(first.nodes.some((node) => node.canonicalName === "Sarah"));
}

/**
 * Implements `appliesEntityExtractionWithCoMentionEdges` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function appliesEntityExtractionWithCoMentionEdges(): void {
  const observedAt = "2026-03-01T00:00:00.000Z";
  const graph = createEmptyEntityGraphV1(observedAt);
  const extraction = extractEntityCandidates({
    text: "Billy and Sarah met at Flare Labs.",
    observedAt,
    evidenceRef: "trace:entity_extract_002"
  });

  const mutation = applyEntityExtractionToGraph(
    graph,
    extraction,
    observedAt,
    "trace:entity_extract_002"
  );

  assert.equal(mutation.aliasConflicts.length, 0);
  assert.equal(mutation.acceptedEntityKeys.length, 3);
  assert.equal(mutation.graph.entities.length, 3);
  assert.equal(mutation.graph.edges.length, 3);
  assert.ok(
    mutation.graph.edges.every(
      (edge) =>
        edge.relationType === "co_mentioned" &&
        edge.status === "uncertain" &&
        edge.coMentionCount === 1
    )
  );
}

/**
 * Implements `surfacesAliasCollisionWithoutSilentMerge` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function surfacesAliasCollisionWithoutSilentMerge(): void {
  const observedAt = "2026-03-01T00:00:00.000Z";
  const existingEntityKey = buildEntityKey("William Bena", "person", null);
  const incomingEntityKey = buildEntityKey("Billy Bena", "person", null);
  const seededGraph: EntityGraphV1 = {
    schemaVersion: "v1",
    updatedAt: observedAt,
    entities: [
      {
        entityKey: existingEntityKey,
        canonicalName: "William Bena",
        entityType: "person",
        disambiguator: null,
        aliases: ["Billy"],
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        salience: 1,
        evidenceRefs: ["trace:seed"]
      }
    ],
    edges: []
  };

  const mutation = applyEntityExtractionToGraph(
    seededGraph,
    {
      nodes: [
        {
          entityKey: incomingEntityKey,
          canonicalName: "Billy Bena",
          entityType: "person",
          disambiguator: null,
          aliases: ["Billy", "Billy Bena"],
          firstSeenAt: observedAt,
          lastSeenAt: observedAt,
          salience: 1,
          evidenceRefs: ["trace:incoming"]
        }
      ],
      coMentionPairs: []
    },
    observedAt,
    "trace:incoming"
  );

  assert.equal(mutation.aliasConflicts.length, 1);
  assert.equal(mutation.aliasConflicts[0]?.conflictCode, "ALIAS_COLLISION");
  assert.equal(mutation.aliasConflicts[0]?.existingEntityKey, existingEntityKey);
  const incoming = mutation.graph.entities.find((entity) => entity.entityKey === incomingEntityKey);
  assert.ok(incoming);
  assert.equal(incoming?.aliases.includes("Billy"), false);
}

/**
 * Implements `evictsLowestStrengthEdgesWhenCapExceeded` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function evictsLowestStrengthEdgesWhenCapExceeded(): void {
  const observedAt = "2026-03-01T00:00:00.000Z";
  const hub = buildEntityKey("Hub Entity", "thing", null);
  const left = buildEntityKey("Left Node", "thing", null);
  const center = buildEntityKey("Center Node", "thing", null);
  const right = buildEntityKey("Right Node", "thing", null);
  const seededGraph: EntityGraphV1 = {
    schemaVersion: "v1",
    updatedAt: observedAt,
    entities: [
      {
        entityKey: hub,
        canonicalName: "Hub Entity",
        entityType: "thing",
        disambiguator: null,
        aliases: ["Hub Entity"],
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        salience: 1,
        evidenceRefs: ["trace:seed"]
      },
      {
        entityKey: left,
        canonicalName: "Left Node",
        entityType: "thing",
        disambiguator: null,
        aliases: ["Left Node"],
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        salience: 1,
        evidenceRefs: ["trace:seed"]
      },
      {
        entityKey: center,
        canonicalName: "Center Node",
        entityType: "thing",
        disambiguator: null,
        aliases: ["Center Node"],
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        salience: 1,
        evidenceRefs: ["trace:seed"]
      },
      {
        entityKey: right,
        canonicalName: "Right Node",
        entityType: "thing",
        disambiguator: null,
        aliases: ["Right Node"],
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        salience: 1,
        evidenceRefs: ["trace:seed"]
      }
    ],
    edges: [
      {
        edgeKey: "edge_0001",
        sourceEntityKey: hub,
        targetEntityKey: left,
        relationType: "co_mentioned",
        status: "uncertain",
        coMentionCount: 1,
        strength: 1,
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        evidenceRefs: ["trace:seed"]
      },
      {
        edgeKey: "edge_0002",
        sourceEntityKey: hub,
        targetEntityKey: center,
        relationType: "co_mentioned",
        status: "uncertain",
        coMentionCount: 2,
        strength: 2,
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        evidenceRefs: ["trace:seed"]
      },
      {
        edgeKey: "edge_0003",
        sourceEntityKey: hub,
        targetEntityKey: right,
        relationType: "co_mentioned",
        status: "uncertain",
        coMentionCount: 3,
        strength: 3,
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        evidenceRefs: ["trace:seed"]
      }
    ]
  };

  const mutation = applyEntityExtractionToGraph(
    seededGraph,
    {
      nodes: [],
      coMentionPairs: []
    },
    observedAt,
    "trace:noop",
    {
      maxGraphEdgesPerEntity: 2
    }
  );

  assert.equal(mutation.evictedEdgeKeys.length, 1);
  assert.equal(mutation.evictedEdgeKeys[0], "edge_0001");
  assert.equal(mutation.graph.edges.length, 2);
}

/**
 * Implements `keepsCoMentionEdgesUncertainUntilExplicitConfirmation` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function keepsCoMentionEdgesUncertainUntilExplicitConfirmation(): void {
  const observedAt = "2026-03-01T00:00:00.000Z";
  const seeded = applyEntityExtractionToGraph(
    createEmptyEntityGraphV1(observedAt),
    extractEntityCandidates({
      text: "Billy and Sarah reviewed Project Aurora.",
      observedAt,
      evidenceRef: "trace:relation_seed"
    }),
    observedAt,
    "trace:relation_seed"
  ).graph;
  const billy = seeded.entities.find((entity) => entity.canonicalName === "Billy");
  const sarah = seeded.entities.find((entity) => entity.canonicalName === "Sarah");
  assert.ok(billy && sarah);

  const denied = promoteRelationEdgeWithConfirmation(seeded, {
    sourceEntityKey: billy!.entityKey,
    targetEntityKey: sarah!.entityKey,
    relationType: "friend",
    explicitUserConfirmation: false,
    observedAt: "2026-03-02T00:00:00.000Z",
    evidenceRef: "trace:relation_denied"
  });

  assert.equal(denied.promoted, false);
  assert.equal(denied.deniedConflictCode, "INSUFFICIENT_EVIDENCE");
  const edge = denied.graph.edges.find((entry) =>
    [entry.sourceEntityKey, entry.targetEntityKey].includes(billy!.entityKey) &&
    [entry.sourceEntityKey, entry.targetEntityKey].includes(sarah!.entityKey)
  );
  assert.ok(edge);
  assert.equal(edge?.relationType, "co_mentioned");
  assert.equal(edge?.status, "uncertain");
}

/**
 * Implements `promotesRelationOnlyWithExplicitConfirmation` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function promotesRelationOnlyWithExplicitConfirmation(): void {
  const observedAt = "2026-03-01T00:00:00.000Z";
  const seeded = applyEntityExtractionToGraph(
    createEmptyEntityGraphV1(observedAt),
    extractEntityCandidates({
      text: "Billy and Sarah reviewed Project Aurora.",
      observedAt,
      evidenceRef: "trace:relation_seed_2"
    }),
    observedAt,
    "trace:relation_seed_2"
  ).graph;
  const billy = seeded.entities.find((entity) => entity.canonicalName === "Billy");
  const sarah = seeded.entities.find((entity) => entity.canonicalName === "Sarah");
  assert.ok(billy && sarah);

  const promoted = promoteRelationEdgeWithConfirmation(seeded, {
    sourceEntityKey: billy!.entityKey,
    targetEntityKey: sarah!.entityKey,
    relationType: "coworker",
    explicitUserConfirmation: true,
    observedAt: "2026-03-02T00:00:00.000Z",
    evidenceRef: "trace:relation_promoted"
  });

  assert.equal(promoted.promoted, true);
  assert.equal(promoted.deniedConflictCode, null);
  const edge = promoted.graph.edges.find((entry) => entry.edgeKey === promoted.edgeKey);
  assert.ok(edge);
  assert.equal(edge?.relationType, "coworker");
  assert.equal(edge?.status, "confirmed");
}

/**
 * Implements `appliesRecencyWeightedCoMentionStrengthIncrements` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function appliesRecencyWeightedCoMentionStrengthIncrements(): void {
  const sameDayIncrement = computeCoMentionIncrement(
    "2026-03-01T00:00:00.000Z",
    "2026-03-01T00:00:00.000Z"
  );
  const staleIncrement = computeCoMentionIncrement(
    "2025-09-01T00:00:00.000Z",
    "2026-03-01T00:00:00.000Z"
  );

  assert.equal(sameDayIncrement, 1);
  assert.ok(staleIncrement < sameDayIncrement);
  assert.ok(staleIncrement > 0);
}

/**
 * Implements `buildsDeterministicEntityLookupTerms` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildsDeterministicEntityLookupTerms(): void {
  const terms = getEntityLookupTerms({
    canonicalName: "Billy Bena",
    aliases: ["Billy", "William Bena"]
  });

  assert.deepEqual(terms, ["bena", "billy", "william"]);
}

test(
  "stage 6.86 entity graph extracts deterministic entity candidates from recurring conversation text",
  extractsDeterministicEntityCandidates
);
test(
  "stage 6.86 entity graph applies extraction results and emits co-mention uncertain edges",
  appliesEntityExtractionWithCoMentionEdges
);
test(
  "stage 6.86 entity graph surfaces alias collisions instead of silent deterministic merge",
  surfacesAliasCollisionWithoutSilentMerge
);
test(
  "stage 6.86 entity graph enforces deterministic edge-cap eviction order",
  evictsLowestStrengthEdgesWhenCapExceeded
);
test(
  "stage 6.86 entity graph keeps co-mention relationships uncertain until explicit user confirmation",
  keepsCoMentionEdgesUncertainUntilExplicitConfirmation
);
test(
  "stage 6.86 entity graph promotes relation type only with explicit confirmation",
  promotesRelationOnlyWithExplicitConfirmation
);
test(
  "stage 6.86 entity graph uses deterministic recency-weighted strength increments",
  appliesRecencyWeightedCoMentionStrengthIncrements
);
test(
  "stage 6.86 entity graph builds deterministic lookup terms for continuity linkage",
  buildsDeterministicEntityLookupTerms
);
