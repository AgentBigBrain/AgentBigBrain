/**
 * @fileoverview Tests deterministic Stage 6.85 clone-workflow policy behavior for bounds, queue contracts, packet envelopes, merge eligibility, and side-effect denial.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { verifySchemaEnvelopeV1 } from "../../src/core/schemaEnvelope";
import {
  buildFindingsPacketV1,
  buildOptionPacketV1,
  createFindingsPacketEnvelopeV1,
  createOptionPacketEnvelopeV1,
  evaluateCloneActionSurface,
  evaluateClonePacketMergeEligibility,
  resolveParallelSpikeBounds,
  validateCloneQueueRequest
} from "../../src/core/stage6_85CloneWorkflowPolicy";

/**
 * Implements `resolvesParallelSpikeBoundsWithConfigInheritanceAndStageCaps` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function resolvesParallelSpikeBoundsWithConfigInheritanceAndStageCaps(): void {
  const decision = resolveParallelSpikeBounds({
    configMaxSubagentsPerTask: 2,
    configMaxSubagentDepth: 1
  });

  assert.equal(decision.allowed, true);
  assert.ok(decision.bounds);
  assert.equal(decision.bounds?.maxClonesPerParallelSpike, 2);
  assert.equal(decision.bounds?.maxCloneDepth, 1);
  assert.equal(decision.bounds?.maxCloneBudgetUsd, 1);
  assert.equal(decision.bounds?.maxPacketsPerClone, 4);
}

/**
 * Implements `blocksParallelSpikeBoundsWhenRequestedValuesExceedDeterministicCaps` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function blocksParallelSpikeBoundsWhenRequestedValuesExceedDeterministicCaps(): void {
  const decision = resolveParallelSpikeBounds({
    configMaxSubagentsPerTask: 2,
    configMaxSubagentDepth: 1,
    requestedBounds: {
      maxClonesPerParallelSpike: 3,
      maxCloneDepth: 2,
      maxCloneBudgetUsd: 1.2,
      maxPacketsPerClone: 7
    }
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.blockCode, "PARALLEL_SPIKE_BOUNDS_INVALID");
  assert.ok(decision.reasons.some((reason) => reason.includes("maxClonesPerParallelSpike")));
  assert.ok(decision.reasons.some((reason) => reason.includes("maxCloneDepth")));
  assert.ok(decision.reasons.some((reason) => reason.includes("maxCloneBudgetUsd")));
  assert.ok(decision.reasons.some((reason) => reason.includes("maxPacketsPerClone")));
}

/**
 * Implements `validatesCloneQueueRequestsAgainstResolvedBounds` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function validatesCloneQueueRequestsAgainstResolvedBounds(): void {
  const boundsDecision = resolveParallelSpikeBounds({
    configMaxSubagentsPerTask: 2,
    configMaxSubagentDepth: 1
  });
  assert.equal(boundsDecision.allowed, true);
  assert.ok(boundsDecision.bounds);

  const validDecision = validateCloneQueueRequest(
    {
      missionId: "mission_6_85_c_001",
      missionAttemptId: 1,
      rootTaskId: "task_6_85_c_001",
      phase: "parallel_spike",
      cloneRole: "researcher",
      requestedCloneCount: 2,
      requestedDepth: 1,
      requestedBudgetUsd: 1,
      packetBudgetPerClone: 4
    },
    boundsDecision.bounds!
  );
  assert.equal(validDecision.valid, true);
  assert.ok(validDecision.normalizedRequest);
  assert.equal(validDecision.normalizedRequest?.missionId, "mission_6_85_c_001");

  const invalidDecision = validateCloneQueueRequest(
    {
      missionId: "mission_6_85_c_001",
      missionAttemptId: 1,
      rootTaskId: "task_6_85_c_001",
      phase: "parallel_spike",
      cloneRole: "researcher",
      requestedCloneCount: 3,
      requestedDepth: 2,
      requestedBudgetUsd: 1.5,
      packetBudgetPerClone: 8
    },
    boundsDecision.bounds!
  );
  assert.equal(invalidDecision.valid, false);
  assert.equal(invalidDecision.blockCode, "CLONE_QUEUE_OBJECT_INVALID");
  assert.ok(invalidDecision.reasons.length >= 4);
}

/**
 * Implements `buildsNormalizedClonePacketsAndEnvelopeHashes` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildsNormalizedClonePacketsAndEnvelopeHashes(): void {
  const optionPacket = buildOptionPacketV1({
    packetId: " option_a ",
    cloneId: " atlas-1001 ",
    recommendation: " Prefer deterministic diff render path. ",
    tradeoffs: ["Higher approval friction", "Higher approval friction", "lower speed"],
    risks: ["Policy drift", "Policy drift"],
    evidenceRefs: ["trace_b", "trace_a", "trace_b"],
    confidence: 1.4,
    contentKind: "plan_variant"
  });
  const findingsPacket = buildFindingsPacketV1({
    packetId: " findings_a ",
    cloneId: " atlas-1001 ",
    recommendation: " Selector strategy improved replay reliability. ",
    tradeoffs: ["selector maintenance"],
    risks: ["selector drift"],
    evidenceRefs: ["trace_selector_1"],
    confidence: -0.3,
    contentKind: "selector_strategy"
  });

  assert.equal(optionPacket.packetId, "option_a");
  assert.equal(optionPacket.cloneId, "atlas-1001");
  assert.equal(optionPacket.tradeoffs.join(","), "Higher approval friction,lower speed");
  assert.equal(optionPacket.evidenceRefs.join(","), "trace_a,trace_b");
  assert.equal(optionPacket.confidence, 1);
  assert.equal(findingsPacket.confidence, 0);

  const optionEnvelope = createOptionPacketEnvelopeV1(optionPacket, "2026-02-27T00:00:00.000Z");
  const findingsEnvelope = createFindingsPacketEnvelopeV1(
    findingsPacket,
    "2026-02-27T00:00:00.000Z"
  );
  assert.equal(verifySchemaEnvelopeV1(optionEnvelope), true);
  assert.equal(verifySchemaEnvelopeV1(findingsEnvelope), true);
}

/**
 * Implements `enforcesDeterministicMergeEligibilityAndCloneSideEffectDenial` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function enforcesDeterministicMergeEligibilityAndCloneSideEffectDenial(): void {
  const mergeable = evaluateClonePacketMergeEligibility("pattern");
  const nonMergeable = evaluateClonePacketMergeEligibility("secret");
  assert.equal(mergeable.mergeable, true);
  assert.equal(mergeable.blockCode, null);
  assert.equal(nonMergeable.mergeable, false);
  assert.equal(nonMergeable.blockCode, "CLONE_PACKET_NON_MERGEABLE");

  const proposalOnly = evaluateCloneActionSurface("respond");
  const deniedSideEffect = evaluateCloneActionSurface("write_file");
  assert.equal(proposalOnly.allowed, true);
  assert.equal(deniedSideEffect.allowed, false);
  assert.equal(deniedSideEffect.blockCode, "CLONE_DIRECT_SIDE_EFFECT_DENIED");
}

test(
  "stage 6.85 clone workflow resolves deterministic parallel-spike bounds from config inheritance and stage caps",
  resolvesParallelSpikeBoundsWithConfigInheritanceAndStageCaps
);
test(
  "stage 6.85 clone workflow blocks invalid parallel-spike bounds when requested values exceed deterministic limits",
  blocksParallelSpikeBoundsWhenRequestedValuesExceedDeterministicCaps
);
test(
  "stage 6.85 clone workflow validates typed clone queue requests against resolved deterministic bounds",
  validatesCloneQueueRequestsAgainstResolvedBounds
);
test(
  "stage 6.85 clone workflow builds normalized option and findings packets with verified schema envelope fingerprints",
  buildsNormalizedClonePacketsAndEnvelopeHashes
);
test(
  "stage 6.85 clone workflow enforces merge eligibility policy and blocks direct clone side-effect actions",
  enforcesDeterministicMergeEligibilityAndCloneSideEffectDenial
);
