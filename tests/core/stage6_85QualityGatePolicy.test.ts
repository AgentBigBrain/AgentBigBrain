/**
 * @fileoverview Tests deterministic Stage 6.85 quality-gate contracts for category profiles, verification pass logic, and truthfulness checks.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  evaluateTruthfulnessGate,
  evaluateVerificationGate,
  resolveDefinitionOfDoneProfile
} from "../../src/core/stage6_85QualityGatePolicy";

/**
 * Implements `returnsDeterministicDefinitionOfDoneProfilesByCategory` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function returnsDeterministicDefinitionOfDoneProfilesByCategory(): void {
  const build = resolveDefinitionOfDoneProfile("build");
  const replay = resolveDefinitionOfDoneProfile("workflow_replay");
  assert.equal(build.requiredProofKinds.join(","), "build,test");
  assert.equal(replay.requiredProofKinds.join(","), "capture,compile,replay_receipt");
}

/**
 * Implements `passesVerificationGateWithProofsOrApprovedWaiver` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function passesVerificationGateWithProofsOrApprovedWaiver(): void {
  const withProof = evaluateVerificationGate({
    gateId: "gate_685_e_001",
    category: "build",
    proofRefs: ["artifact_test", "artifact_build", "artifact_build"],
    waiverApproved: false
  });
  assert.equal(withProof.passed, true);
  assert.equal(withProof.proofRefs.join(","), "artifact_build,artifact_test");

  const withWaiver = evaluateVerificationGate({
    gateId: "gate_685_e_002",
    category: "research",
    proofRefs: [],
    waiverApproved: true
  });
  assert.equal(withWaiver.passed, true);

  const blocked = evaluateVerificationGate({
    gateId: "gate_685_e_003",
    category: "communication",
    proofRefs: [],
    waiverApproved: false
  });
  assert.equal(blocked.passed, false);
}

/**
 * Implements `failsTruthfulnessGateOnOptimisticBlockedSideEffectsOrMissingSimulationLabels` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function failsTruthfulnessGateOnOptimisticBlockedSideEffectsOrMissingSimulationLabels(): void {
  const blockedOptimistic = evaluateTruthfulnessGate({
    summaryText: "Completed and sent update successfully.",
    blockedSideEffectCount: 1,
    simulatedActionCount: 0,
    simulationLabelPresent: false
  });
  assert.equal(blockedOptimistic.passed, false);

  const blockedSimulation = evaluateTruthfulnessGate({
    summaryText: "Prepared draft response.",
    blockedSideEffectCount: 0,
    simulatedActionCount: 1,
    simulationLabelPresent: false
  });
  assert.equal(blockedSimulation.passed, false);

  const allowed = evaluateTruthfulnessGate({
    summaryText: "Simulated execution only; waiting for approval.",
    blockedSideEffectCount: 0,
    simulatedActionCount: 1,
    simulationLabelPresent: true
  });
  assert.equal(allowed.passed, true);
}

test(
  "stage 6.85 quality gate policy returns deterministic definition-of-done profiles per category",
  returnsDeterministicDefinitionOfDoneProfilesByCategory
);
test(
  "stage 6.85 quality gate policy passes verification with proofs or explicit waivers and blocks empty claims",
  passesVerificationGateWithProofsOrApprovedWaiver
);
test(
  "stage 6.85 quality gate policy fail-closes on optimistic blocked outcomes and unlabeled simulated actions",
  failsTruthfulnessGateOnOptimisticBlockedSideEffectsOrMissingSimulationLabels
);
