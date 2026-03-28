/**
 * @fileoverview Tests profile-memory runtime query helpers for bounded planning context and approval-gated fact reads.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createEmptyProfileMemoryState,
  upsertTemporalProfileFact
} from "../../src/core/profileMemory";
import {
  buildProfilePlanningContext,
  readProfileFacts
} from "../../src/core/profileMemoryRuntime/profileMemoryQueries";

test("readProfileFacts hides sensitive facts without explicit approval", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "employment.current",
    value: "Lantern",
    sensitive: false,
    sourceTaskId: "task_profile_query_read_1",
    source: "test",
    observedAt: "2026-02-23T00:00:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "address",
    value: "123 Main Street",
    sensitive: true,
    sourceTaskId: "task_profile_query_read_2",
    source: "test",
    observedAt: "2026-02-23T00:01:00.000Z",
    confidence: 0.95
  }).nextState;

  const readable = readProfileFacts(state, {
    purpose: "operator_view",
    includeSensitive: true,
    explicitHumanApproval: false
  });

  assert.equal(readable.some((fact) => fact.key === "address"), false);
  assert.equal(readable.some((fact) => fact.key === "employment.current"), true);
});

test("readProfileFacts returns sensitive facts only with explicit operator approval", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "address",
    value: "123 Main Street",
    sensitive: true,
    sourceTaskId: "task_profile_query_read_approved",
    source: "test",
    observedAt: "2026-02-23T00:00:00.000Z",
    confidence: 0.95
  }).nextState;

  const readable = readProfileFacts(state, {
    purpose: "operator_view",
    includeSensitive: true,
    explicitHumanApproval: true,
    approvalId: "approval_profile_query_1"
  });

  assert.equal(readable.length, 1);
  assert.equal(readable[0]?.key, "address");
  assert.equal(readable[0]?.value, "123 Main Street");
});

test("buildProfilePlanningContext preserves query-aware non-sensitive grounding", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "employment.current",
    value: "Lantern",
    sensitive: false,
    sourceTaskId: "task_profile_query_context_1",
    source: "test",
    observedAt: "2026-02-24T00:00:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "address",
    value: "123 Main Street",
    sensitive: true,
    sourceTaskId: "task_profile_query_context_2",
    source: "test",
    observedAt: "2026-02-24T00:01:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.name",
    value: "Owen",
    sensitive: false,
    sourceTaskId: "task_profile_query_context_3",
    source: "test",
    observedAt: "2026-02-24T00:02:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.work_association",
    value: "Lantern Studio",
    sensitive: false,
    sourceTaskId: "task_profile_query_context_4",
    source: "test",
    observedAt: "2026-02-24T00:03:00.000Z",
    confidence: 0.95
  }).nextState;

  const planningContext = buildProfilePlanningContext(state, 4, "who is Owen?");

  assert.equal(planningContext.includes("contact.owen.name: Owen"), true);
  assert.equal(
    planningContext.includes("contact.owen.work_association: Lantern Studio"),
    true
  );
  assert.equal(planningContext.includes("employment.current: Lantern"), true);
  assert.equal(planningContext.includes("address"), false);
  assert.equal(planningContext.includes("123 Main Street"), false);
});
