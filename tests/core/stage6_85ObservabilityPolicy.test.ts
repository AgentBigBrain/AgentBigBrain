/**
 * @fileoverview Tests deterministic Stage 6.85 observability policy for mission timeline ordering, failure explainers, and redacted evidence-bundle profiles.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMissionTimelineV1,
  buildRedactedEvidenceBundleProfile,
  explainFailureDeterministically
} from "../../src/core/stage6_85ObservabilityPolicy";

/**
 * Implements `ordersMissionTimelineEventsDeterministically` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function ordersMissionTimelineEventsDeterministically(): void {
  const timeline = buildMissionTimelineV1({
    missionId: "mission_685_h_001",
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
  assert.equal(timeline.events[1]?.sequence, 2);
}

/**
 * Implements `mapsWorkflowDriftFailuresToTypedRemediation` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function mapsWorkflowDriftFailuresToTypedRemediation(): void {
  const explained = explainFailureDeterministically({
    blockCode: "WORKFLOW_DRIFT_DETECTED",
    conflictCode: "SELECTOR_NOT_FOUND"
  });
  assert.match(explained.summary, /SELECTOR_NOT_FOUND/);
  assert.ok(explained.remediation[0]?.includes("selector"));
}

/**
 * Implements `buildsBoundedRedactedEvidenceBundleProfiles` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildsBoundedRedactedEvidenceBundleProfiles(): void {
  const bundle = buildRedactedEvidenceBundleProfile({
    artifactPaths: [
      "runtime/evidence/stage6_85_workflow_replay_report.json",
      "runtime/evidence/stage6_85_workflow_replay_report.json",
      "runtime/evidence/stage6_85_mission_ux_report.json"
    ],
    redactedFieldNames: ["authorization", "token", "authorization"]
  });
  assert.equal(
    bundle.artifactPaths.join(","),
    "runtime/evidence/stage6_85_mission_ux_report.json,runtime/evidence/stage6_85_workflow_replay_report.json"
  );
  assert.equal(bundle.redactionCount, 2);
}

test(
  "stage 6.85 observability policy orders mission timeline events deterministically",
  ordersMissionTimelineEventsDeterministically
);
test(
  "stage 6.85 observability policy maps workflow drift failures to deterministic remediation",
  mapsWorkflowDriftFailuresToTypedRemediation
);
test(
  "stage 6.85 observability policy builds bounded redacted evidence-bundle profiles",
  buildsBoundedRedactedEvidenceBundleProfiles
);
