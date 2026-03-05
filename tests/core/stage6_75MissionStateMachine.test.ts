/**
 * @fileoverview Tests deterministic Stage 6.75 mission-state replay, action-id derivation, and stop-limit/idempotency behavior.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  advanceMissionPhase,
  buildInitialMissionState,
  createMissionCheckpoint,
  deriveDeterministicActionId,
  evaluateMissionStopDecision,
  registerMissionActionOutcome
} from "../../src/core/stage6_75MissionStateMachine";

test("deterministic action id derivation is stable for identical inputs", () => {
  const first = deriveDeterministicActionId(
    "mission_001",
    1,
    "retrieve",
    "read_file",
    { path: "docs/stages/stage_6_75_governed_operator_capability.md" }
  );
  const second = deriveDeterministicActionId(
    "mission_001",
    1,
    "retrieve",
    "read_file",
    { path: "docs/stages/stage_6_75_governed_operator_capability.md" }
  );
  assert.equal(first, second);
});

test("mission replay advances phases in deterministic order", () => {
  const initial = buildInitialMissionState("mission_001");
  const afterRetrieve = advanceMissionPhase(initial);
  const afterSynthesize = advanceMissionPhase(afterRetrieve);
  assert.equal(initial.currentPhase, "intake");
  assert.equal(afterRetrieve.currentPhase, "retrieve");
  assert.equal(afterSynthesize.currentPhase, "synthesize");
  assert.deepEqual(afterSynthesize.phaseHistory, ["intake", "retrieve", "synthesize"]);
});

test("mission checkpoint creation emits deterministic action id for phase and params", () => {
  const state = buildInitialMissionState("mission_001");
  const checkpoint = createMissionCheckpoint(
    state,
    "retrieve",
    "read_file",
    "idem_001",
    {
      path: "README.md"
    },
    "2026-02-27T21:00:00.000Z"
  );
  assert.ok(checkpoint.actionId.startsWith("action_"));
  assert.equal(checkpoint.idempotencyKey, "idem_001");
});

test("mission action registration detects idempotency replay and stop limits", () => {
  const state = buildInitialMissionState("mission_001");
  const first = registerMissionActionOutcome(state, "idem_001", 256, false);
  const duplicate = registerMissionActionOutcome(first.nextState, "idem_001", 512, true);

  assert.equal(first.duplicateReplayDetected, false);
  assert.equal(duplicate.duplicateReplayDetected, true);

  const stopDecision = evaluateMissionStopDecision(duplicate.nextState, {
    maxActions: 2,
    maxDenies: 4,
    maxBytes: 4096
  });
  assert.equal(stopDecision.shouldStop, true);
  assert.equal(stopDecision.blockCode, "MISSION_STOP_LIMIT_REACHED");
});
