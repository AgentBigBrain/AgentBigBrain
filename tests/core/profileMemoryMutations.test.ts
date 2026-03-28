/**
 * @fileoverview Tests profile-memory mutation helpers for commitment resolution, reconciliation, and candidate application.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createEmptyProfileMemoryState,
  upsertTemporalProfileFact
} from "../../src/core/profileMemory";
import {
  applyProfileFactCandidates,
  buildInferredCommitmentResolutionCandidates,
  buildStateReconciliationResolutionCandidates,
  countUnresolvedCommitments,
  extractUnresolvedCommitmentTopics
} from "../../src/core/profileMemoryRuntime/profileMemoryMutations";

test("countUnresolvedCommitments and extractUnresolvedCommitmentTopics track active follow-ups", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "followup.tax.filing",
    value: "pending",
    sensitive: false,
    sourceTaskId: "task_profile_mutation_topic_1",
    source: "test",
    observedAt: "2026-02-25T00:00:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "followup.private.address",
    value: "pending",
    sensitive: true,
    sourceTaskId: "task_profile_mutation_topic_2",
    source: "test",
    observedAt: "2026-02-25T00:01:00.000Z",
    confidence: 0.95
  }).nextState;

  assert.equal(countUnresolvedCommitments(state), 2);
  assert.deepEqual(extractUnresolvedCommitmentTopics(state), ["tax filing"]);
});

test("buildInferredCommitmentResolutionCandidates resolves matching unresolved follow-up topics", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "followup.tax.filing",
    value: "pending",
    sensitive: false,
    sourceTaskId: "task_profile_mutation_resolve_1",
    source: "test",
    observedAt: "2026-02-25T00:00:00.000Z",
    confidence: 0.95
  }).nextState;

  const candidates = buildInferredCommitmentResolutionCandidates(
    state,
    "I finished the tax filing so you can stop reminding me.",
    "task_profile_mutation_resolve_2",
    "2026-02-25T01:00:00.000Z"
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.key, "followup.tax.filing");
  assert.equal(candidates[0]?.value, "resolved");
  assert.equal(candidates[0]?.source, "user_input_pattern.followup_resolved_inferred");
});

test("buildStateReconciliationResolutionCandidates closes contradictory unresolved commitments", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "followup.tax.filing",
    value: "pending",
    sensitive: false,
    sourceTaskId: "task_profile_mutation_reconcile_1",
    source: "test",
    observedAt: "2026-02-25T00:00:00.000Z",
    confidence: 0.95
  }).nextState;
  state = upsertTemporalProfileFact(state, {
    key: "tax filing",
    value: "resolved",
    sensitive: false,
    sourceTaskId: "task_profile_mutation_reconcile_2",
    source: "test",
    observedAt: "2026-02-25T00:05:00.000Z",
    confidence: 0.95
  }).nextState;

  const candidates = buildStateReconciliationResolutionCandidates(
    state,
    "2026-02-25T01:00:00.000Z"
  );

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]?.key, "followup.tax.filing");
  assert.equal(candidates[0]?.value, "resolved");
  assert.equal(candidates[0]?.source, "profile_state_reconciliation.followup_resolved");
});

test("applyProfileFactCandidates deduplicates equivalent writes before mutation", () => {
  const state = createEmptyProfileMemoryState();
  const result = applyProfileFactCandidates(state, [
    {
      key: "employment.current",
      value: "Lantern",
      sensitive: false,
      sourceTaskId: "task_profile_mutation_apply_1",
      source: "test",
      observedAt: "2026-02-25T00:00:00.000Z",
      confidence: 0.95
    },
    {
      key: "employment.current",
      value: "lantern",
      sensitive: false,
      sourceTaskId: "task_profile_mutation_apply_2",
      source: "test",
      observedAt: "2026-02-25T00:00:01.000Z",
      confidence: 0.95
    }
  ]);

  assert.equal(result.appliedFacts, 1);
  assert.equal(result.supersededFacts, 0);
  assert.equal(result.nextState.facts.length, 1);
  assert.equal(result.nextState.facts[0]?.value, "Lantern");
});
