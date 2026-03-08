/**
 * @fileoverview Tests canonical Stage 6.85 clone-workflow runtime helpers.
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
} from "../../src/core/stage6_85/cloneWorkflow";

test("stage6_85 clone workflow runtime preserves deterministic bounds and queue validation", () => {
  const bounds = resolveParallelSpikeBounds({
    configMaxSubagentsPerTask: 2,
    configMaxSubagentDepth: 1
  });
  assert.equal(bounds.allowed, true);
  assert.equal(bounds.bounds?.maxClonesPerParallelSpike, 2);

  const queue = validateCloneQueueRequest(
    {
      missionId: "mission_runtime_clone",
      missionAttemptId: 1,
      rootTaskId: "task_runtime_clone",
      phase: "parallel_spike",
      cloneRole: "researcher",
      requestedCloneCount: 2,
      requestedDepth: 1,
      requestedBudgetUsd: 1,
      packetBudgetPerClone: 4
    },
    bounds.bounds!
  );
  assert.equal(queue.valid, true);
});

test("stage6_85 clone workflow runtime preserves deterministic packet envelope behavior", () => {
  const optionPacket = buildOptionPacketV1({
    packetId: " option_runtime ",
    cloneId: " clone_runtime ",
    recommendation: "Use deterministic replay path.",
    tradeoffs: ["higher friction", "higher friction"],
    risks: ["policy drift"],
    evidenceRefs: ["trace_2", "trace_1", "trace_2"],
    confidence: 1.4,
    contentKind: "plan_variant"
  });
  const findingsPacket = buildFindingsPacketV1({
    packetId: " findings_runtime ",
    cloneId: " clone_runtime ",
    recommendation: "Selector strategy improved replay reliability.",
    tradeoffs: ["selector maintenance"],
    risks: ["selector drift"],
    evidenceRefs: ["trace_selector"],
    confidence: -0.2,
    contentKind: "selector_strategy"
  });

  const optionEnvelope = createOptionPacketEnvelopeV1(optionPacket, "2026-02-27T00:00:00.000Z");
  const findingsEnvelope = createFindingsPacketEnvelopeV1(
    findingsPacket,
    "2026-02-27T00:00:00.000Z"
  );

  assert.equal(verifySchemaEnvelopeV1(optionEnvelope), true);
  assert.equal(verifySchemaEnvelopeV1(findingsEnvelope), true);
});

test("stage6_85 clone workflow runtime preserves merge and side-effect gating", () => {
  const mergeable = evaluateClonePacketMergeEligibility("pattern");
  const denied = evaluateCloneActionSurface("write_file");

  assert.equal(mergeable.mergeable, true);
  assert.equal(denied.allowed, false);
  assert.equal(denied.blockCode, "CLONE_DIRECT_SIDE_EFFECT_DENIED");
});
