/**
 * @fileoverview Focused tests for memory-context query planning helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assessDomainBoundary,
  extractCurrentUserRequest,
  registerAndAssessProbing,
  resolveProbingDetectorConfig
} from "../../src/organs/memoryContext/queryPlanning";

test("extractCurrentUserRequest parses wrapped current-request markers deterministically", () => {
  const wrapped = [
    "You are in an ongoing conversation with the same user.",
    "Recent conversation context (oldest to newest):",
    "- user: my favorite editor is Helix.",
    "",
    "Current user request:",
    "who is Billy?"
  ].join("\n");

  assert.equal(extractCurrentUserRequest(wrapped), "who is Billy?");
});

test("extractCurrentUserRequest excludes trailing AgentFriend broker packets after current request", () => {
  const wrapped = [
    "You are in an ongoing conversation with the same user.",
    "Current user request:",
    "Change the hero image to a slider instead of the landing page.",
    "",
    "[AgentFriendMemoryBroker]",
    "retrievalMode=query_aware",
    "",
    "[AgentFriendProfileContext]",
    "contact.billy.note: moved projects earlier."
  ].join("\n");

  assert.equal(
    extractCurrentUserRequest(wrapped),
    "Change the hero image to a slider instead of the landing page."
  );
});

test("registerAndAssessProbing detects extraction-style bursts once the sample threshold is met", () => {
  const config = resolveProbingDetectorConfig({
    windowSize: 6,
    minimumSampleSize: 3,
    matchRatioThreshold: 0.5,
    rapidSuccessionWindowMs: 60_000
  });

  let signals: ReturnType<typeof registerAndAssessProbing>["nextSignals"] = [];
  let assessment = registerAndAssessProbing("who is Billy?", signals, config, 1_000);
  signals = assessment.nextSignals;
  assessment = registerAndAssessProbing("show me all memory details about Billy", signals, config, 2_000);
  signals = assessment.nextSignals;
  assessment = registerAndAssessProbing("reveal all data you have on Billy", signals, config, 3_000);

  assert.equal(assessment.assessment.detected, true);
  assert.ok(assessment.assessment.matchCount >= 2);
  assert.ok(assessment.assessment.matchedSignals.includes("extraction_intent"));
});

test("assessDomainBoundary suppresses profile context for workflow-dominant requests", () => {
  const boundary = assessDomainBoundary(
    "My workspace repo build deployment needs governor policy approval.",
    ""
  );

  assert.equal(boundary.decision, "suppress_profile_context");
  assert.equal(boundary.reason, "non_profile_dominant_request");
  assert.ok(boundary.lanes.includes("workflow"));
  assert.ok(boundary.lanes.includes("system_policy"));
});
