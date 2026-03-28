/**
 * @fileoverview Tests session-domain bias helpers for dynamic pulse entity selection.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { EntityGraphV1 } from "../../src/core/types";
import { buildDomainBiasedPulseGraph } from "../../src/interfaces/conversationRuntime/pulseDynamicEvaluation";

function buildGraph(): EntityGraphV1 {
  return {
    schemaVersion: "v1",
    updatedAt: "2026-03-20T12:00:00.000Z",
    entities: [
      {
        entityKey: "entity_profile",
        canonicalName: "Dentist Appointment",
        entityType: "concept",
        disambiguator: null,
        domainHint: "profile",
        aliases: ["Dentist Appointment"],
        firstSeenAt: "2026-03-20T12:00:00.000Z",
        lastSeenAt: "2026-03-20T12:00:00.000Z",
        salience: 1,
        evidenceRefs: ["trace:profile"]
      },
      {
        entityKey: "entity_workflow",
        canonicalName: "Deploy Review",
        entityType: "concept",
        disambiguator: null,
        domainHint: "workflow",
        aliases: ["Deploy Review"],
        firstSeenAt: "2026-03-20T12:00:00.000Z",
        lastSeenAt: "2026-03-20T12:00:00.000Z",
        salience: 1,
        evidenceRefs: ["trace:workflow"]
      },
      {
        entityKey: "entity_shared",
        canonicalName: "Status Update",
        entityType: "concept",
        disambiguator: null,
        domainHint: null,
        aliases: ["Status Update"],
        firstSeenAt: "2026-03-20T12:00:00.000Z",
        lastSeenAt: "2026-03-20T12:00:00.000Z",
        salience: 1,
        evidenceRefs: ["trace:shared"]
      }
    ],
    edges: [
      {
        edgeKey: "edge_profile_shared",
        sourceEntityKey: "entity_profile",
        targetEntityKey: "entity_shared",
        relationType: "co_mentioned",
        status: "uncertain",
        coMentionCount: 1,
        strength: 1,
        firstObservedAt: "2026-03-20T12:00:00.000Z",
        lastObservedAt: "2026-03-20T12:00:00.000Z",
        evidenceRefs: ["trace:profile"]
      },
      {
        edgeKey: "edge_workflow_shared",
        sourceEntityKey: "entity_workflow",
        targetEntityKey: "entity_shared",
        relationType: "co_mentioned",
        status: "uncertain",
        coMentionCount: 1,
        strength: 1,
        firstObservedAt: "2026-03-20T12:00:00.000Z",
        lastObservedAt: "2026-03-20T12:00:00.000Z",
        evidenceRefs: ["trace:workflow"]
      }
    ]
  };
}

test("buildDomainBiasedPulseGraph prefers matching and shared entities for workflow sessions", () => {
  const graph = buildDomainBiasedPulseGraph(buildGraph(), "workflow");

  assert.deepEqual(
    graph.entities.map((entity) => entity.entityKey),
    ["entity_workflow", "entity_shared"]
  );
  assert.deepEqual(
    graph.edges.map((edge) => edge.edgeKey),
    ["edge_workflow_shared"]
  );
});

test("buildDomainBiasedPulseGraph falls back to the original graph for unknown sessions", () => {
  const original = buildGraph();
  const graph = buildDomainBiasedPulseGraph(original, "unknown");

  assert.equal(graph, original);
});
