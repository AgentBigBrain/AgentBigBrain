/**
 * @fileoverview Tests canonical Stage 6.85 latency, observability, and quality-gate runtime helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDeterministicRejectSummary,
  evaluateCacheBaselineEquivalence,
  evaluatePhaseLatencies,
  resolveDefaultLatencyBudgetsMs
} from "../../src/core/stage6_85/latency";
import {
  buildMissionTimelineV1,
  buildRedactedEvidenceBundleProfile,
  explainFailureDeterministically
} from "../../src/core/stage6_85/observability";
import {
  evaluateTruthfulnessGate,
  evaluateVerificationGate,
  resolveDefinitionOfDoneProfile
} from "../../src/core/stage6_85/qualityGates";

test("stage6_85 latency runtime preserves deterministic phase-budget and cache-equivalence rules", () => {
  const budgets = resolveDefaultLatencyBudgetsMs();
  const passing = evaluatePhaseLatencies({
    budgetsMs: budgets,
    observedMs: {
      planning: 7_000,
      vote_collection: 2_000,
      execution: 9_000,
      response_rendering: 1_000
    }
  });
  assert.equal(passing.overallPass, true);

  const cacheDecision = evaluateCacheBaselineEquivalence({
    baselineModelCalls: 4,
    cachedModelCalls: 5
  });
  assert.equal(cacheDecision.passed, false);
  assert.equal(
    buildDeterministicRejectSummary(["policy denied", "budget exceeded", "budget exceeded"]),
    "budget exceeded | policy denied"
  );
});

test("stage6_85 observability runtime preserves deterministic timeline and remediation behavior", () => {
  const timeline = buildMissionTimelineV1({
    missionId: "mission_685_runtime_observability",
    events: [
      {
        sequence: 2,
        phase: "execute",
        eventType: "action",
        detail: "Ran replay step",
        observedAt: "2026-02-27T00:02:00.000Z"
      },
      {
        sequence: 1,
        phase: "plan",
        eventType: "plan",
        detail: "Built mission plan",
        observedAt: "2026-02-27T00:01:00.000Z"
      }
    ]
  });
  assert.equal(timeline.events[0]?.sequence, 1);

  const remediation = explainFailureDeterministically({
    blockCode: "WORKFLOW_DRIFT_DETECTED",
    conflictCode: "SELECTOR_NOT_FOUND"
  });
  assert.match(remediation.summary, /SELECTOR_NOT_FOUND/);

  const bundle = buildRedactedEvidenceBundleProfile({
    artifactPaths: ["b.json", "a.json", "b.json"],
    redactedFieldNames: ["token", "authorization", "token"]
  });
  assert.deepEqual(bundle.artifactPaths, ["a.json", "b.json"]);
  assert.equal(bundle.redactionCount, 2);
});

test("stage6_85 quality-gate runtime preserves deterministic proof and truthfulness rules", () => {
  const profile = resolveDefinitionOfDoneProfile("workflow_replay");
  assert.equal(profile.requiredProofKinds.join(","), "capture,compile,replay_receipt");

  const gate = evaluateVerificationGate({
    gateId: "gate_685_runtime",
    category: "build",
    proofRefs: ["artifact_test", "artifact_build", "artifact_build"],
    waiverApproved: false
  });
  assert.equal(gate.passed, true);
  assert.equal(gate.proofRefs.join(","), "artifact_build,artifact_test");

  const truthfulness = evaluateTruthfulnessGate({
    summaryText: "Completed and sent update successfully.",
    blockedSideEffectCount: 1,
    simulatedActionCount: 0,
    simulationLabelPresent: false
  });
  assert.equal(truthfulness.passed, false);
});
