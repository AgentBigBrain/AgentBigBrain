import assert from "node:assert/strict";
import { test } from "node:test";

import type { MemoryBoundaryLaneOutput } from "../../src/organs/memoryContext/contracts";
import { assessDomainBoundary } from "../../src/organs/memoryContext/queryPlanningDomainBoundary";

function buildLane(
  overrides: Partial<MemoryBoundaryLaneOutput> = {}
): MemoryBoundaryLaneOutput {
  return {
    laneId: "lane_default",
    domainLane: "relationship",
    semanticMode: "relationship_inventory",
    relevanceScope: "conversation_local",
    scopedThreadKeys: ["thread_rel"],
    answerMode: "current",
    dominantLane: "current_state",
    supportingLanes: [],
    overflowNote: null,
    degradedNotes: [],
    ...overrides
  };
}

test("assessDomainBoundary injects profile context from typed profile lane output", () => {
  const boundary = assessDomainBoundary("what should I remember about me?", [
    buildLane({
      laneId: "lane_profile_identity",
      domainLane: "profile",
      semanticMode: "identity",
      relevanceScope: "global_profile",
      scopedThreadKeys: []
    })
  ]);

  assert.equal(boundary.decision, "inject_profile_context");
  assert.ok(boundary.lanes.includes("profile"));
  assert.ok(boundary.scores.profile >= 2);
});

test("assessDomainBoundary injects profile context from typed relationship lane output", () => {
  const boundary = assessDomainBoundary("who is Owen again?", [
    buildLane({
      laneId: "lane_relationship_contact",
      domainLane: "relationship"
    })
  ]);

  assert.equal(boundary.decision, "inject_profile_context");
  assert.ok(boundary.lanes.includes("relationship"));
  assert.ok(boundary.scores.relationship >= 2);
});

test("assessDomainBoundary suppresses profile context when typed workflow lanes dominate", () => {
  const boundary = assessDomainBoundary("deploy the workspace repo now", [
    buildLane({
      laneId: "lane_workflow_current",
      domainLane: "workflow",
      semanticMode: "event_history"
    })
  ]);

  assert.equal(boundary.decision, "suppress_profile_context");
  assert.equal(boundary.reason, "non_profile_dominant_request");
  assert.ok(boundary.lanes.includes("workflow"));
});

test("assessDomainBoundary suppresses profile context when typed policy lanes dominate", () => {
  const boundary = assessDomainBoundary("explain the approval policy for this governor path", [
    buildLane({
      laneId: "lane_policy_current",
      domainLane: "system_policy",
      semanticMode: "event_history"
    })
  ]);

  assert.equal(boundary.decision, "suppress_profile_context");
  assert.equal(boundary.reason, "non_profile_dominant_request");
  assert.ok(boundary.lanes.includes("system_policy"));
});

test("assessDomainBoundary keeps ambiguous relationship lanes bounded without falling back to flat text parsing", () => {
  const boundary = assessDomainBoundary("what was going on with Owen?", [
    buildLane({
      laneId: "lane_relationship_ambiguous",
      domainLane: "relationship",
      answerMode: "ambiguous",
      dominantLane: "contradiction_notes",
      supportingLanes: ["historical_context"]
    })
  ]);

  assert.equal(boundary.decision, "inject_profile_context");
  assert.ok(boundary.scores.relationship >= 1);
  assert.ok(boundary.lanes.includes("relationship"));
});

test("assessDomainBoundary fail-closes when typed lane output is insufficient or quarantined", () => {
  const insufficientBoundary = assessDomainBoundary("remind me what you know here", [
    buildLane({
      laneId: "lane_relationship_insufficient",
      domainLane: "relationship",
      answerMode: "insufficient_evidence",
      dominantLane: "insufficient_evidence"
    })
  ]);
  const quarantinedBoundary = assessDomainBoundary("which Owen was that?", [
    buildLane({
      laneId: "lane_relationship_quarantined",
      domainLane: "relationship",
      answerMode: "quarantined_identity",
      dominantLane: "quarantined_identity"
    })
  ]);

  assert.equal(insufficientBoundary.decision, "suppress_profile_context");
  assert.equal(insufficientBoundary.reason, "no_profile_signal");
  assert.equal(quarantinedBoundary.decision, "suppress_profile_context");
  assert.equal(quarantinedBoundary.reason, "no_profile_signal");
});
