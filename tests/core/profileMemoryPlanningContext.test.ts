/**
 * @fileoverview Focused tests for canonical query-aware profile-memory planning context ranking.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildQueryAwarePlanningContext
} from "../../src/core/profileMemoryRuntime/profileMemoryPlanningContext";
import {
  createEmptyProfileMemoryState,
  upsertTemporalProfileFact
} from "../../src/core/profileMemory";

test("buildQueryAwarePlanningContext prioritizes matching contact facts under a tight budget", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "identity.preferred_name",
    value: "Benny",
    sensitive: false,
    sourceTaskId: "task_identity",
    source: "test",
    observedAt: "2026-03-07T10:00:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.name",
    value: "Owen",
    sensitive: false,
    sourceTaskId: "task_contact_name",
    source: "test",
    observedAt: "2026-03-07T10:01:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "contact.owen.work_association",
    value: "Lantern Studio",
    sensitive: false,
    sourceTaskId: "task_contact_work",
    source: "test",
    observedAt: "2026-03-07T10:02:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "preference.editor",
    value: "Helix",
    sensitive: false,
    sourceTaskId: "task_editor",
    source: "test",
    observedAt: "2026-03-07T10:03:00.000Z",
    confidence: 0.95
  }).nextState;

  const context = buildQueryAwarePlanningContext(state, 3, "who is Owen?");

  assert.equal(context.includes("identity.preferred_name: Benny"), true);
  assert.equal(context.includes("contact.owen.name: Owen"), true);
  assert.equal(
    context.includes("contact.owen.work_association: Lantern Studio"),
    true
  );
  assert.equal(context.includes("preference.editor: Helix"), false);
});
