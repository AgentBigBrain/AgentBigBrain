/**
 * @fileoverview Tests canonical profile-memory fact lifecycle helpers behind the runtime subsystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createEmptyProfileMemoryState } from "../../src/core/profileMemoryRuntime/profileMemoryState";
import { upsertTemporalProfileFact } from "../../src/core/profileMemoryRuntime/profileMemoryFactLifecycle";

test("upsertTemporalProfileFact replaces prior winner for explicit successor families", () => {
  const emptyState = createEmptyProfileMemoryState();
  const first = upsertTemporalProfileFact(emptyState, {
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: false,
    sourceTaskId: "task_runtime_lifecycle_1",
    source: "test",
    observedAt: "2026-02-20T00:00:00.000Z",
    confidence: 0.95
  });

  const second = upsertTemporalProfileFact(first.nextState, {
    key: "identity.preferred_name",
    value: "Ava",
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
  assert.equal(activeFacts[0]?.value, "Ava");
  assert.equal(second.supersededFactIds.length, 1);
  assert.equal(second.applied, true);
});

test("upsertTemporalProfileFact retains the prior winner and stores preserve-prior challengers as uncertain", () => {
  const emptyState = createEmptyProfileMemoryState();
  const first = upsertTemporalProfileFact(emptyState, {
    key: "employment.current",
    value: "Pro-Green",
    sensitive: false,
    sourceTaskId: "task_runtime_lifecycle_preserve_1",
    source: "test",
    observedAt: "2026-02-20T00:00:00.000Z",
    confidence: 0.95
  });

  const second = upsertTemporalProfileFact(first.nextState, {
    key: "employment.current",
    value: "Lantern",
    sensitive: false,
    sourceTaskId: "task_runtime_lifecycle_preserve_2",
    source: "test",
    observedAt: "2026-02-21T00:00:00.000Z",
    confidence: 0.95
  });

  const supersededFacts = second.nextState.facts.filter((fact) => fact.status === "superseded");
  const activeFacts = second.nextState.facts.filter(
    (fact) => fact.status !== "superseded" && fact.supersededAt === null
  );
  const confirmedFacts = activeFacts.filter((fact) => fact.status === "confirmed");
  const uncertainFacts = activeFacts.filter((fact) => fact.status === "uncertain");

  assert.equal(supersededFacts.length, 0);
  assert.equal(activeFacts.length, 2);
  assert.equal(confirmedFacts[0]?.value, "Pro-Green");
  assert.equal(uncertainFacts[0]?.value, "Lantern");
  assert.equal(second.upsertedFact.value, "Lantern");
  assert.equal(second.upsertedFact.status, "uncertain");
  assert.equal(second.supersededFactIds.length, 0);
  assert.equal(second.applied, true);
});
