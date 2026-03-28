/**
 * @fileoverview Tests canonical profile-memory fact lifecycle helpers behind the runtime subsystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createEmptyProfileMemoryState } from "../../src/core/profileMemoryRuntime/profileMemoryState";
import { upsertTemporalProfileFact } from "../../src/core/profileMemoryRuntime/profileMemoryFactLifecycle";

test("upsertTemporalProfileFact supersedes older active fact for the same key with a new value", () => {
  const emptyState = createEmptyProfileMemoryState();
  const first = upsertTemporalProfileFact(emptyState, {
    key: "employment.current",
    value: "Pro-Green",
    sensitive: false,
    sourceTaskId: "task_runtime_lifecycle_1",
    source: "test",
    observedAt: "2026-02-20T00:00:00.000Z",
    confidence: 0.95
  });

  const second = upsertTemporalProfileFact(first.nextState, {
    key: "employment.current",
    value: "Lantern",
    sensitive: false,
    sourceTaskId: "task_runtime_lifecycle_2",
    source: "test",
    observedAt: "2026-02-21T00:00:00.000Z",
    confidence: 0.95
  });

  const supersededFacts = second.nextState.facts.filter((fact) => fact.status === "superseded");
  const activeFacts = second.nextState.facts.filter(
    (fact) => fact.status !== "superseded" && fact.supersededAt === null
  );

  assert.equal(supersededFacts.length, 1);
  assert.equal(activeFacts.length, 1);
  assert.equal(activeFacts[0]?.value, "Lantern");
  assert.equal(second.supersededFactIds.length, 1);
});
