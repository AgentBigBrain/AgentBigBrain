/**
 * @fileoverview Tests deterministic commitment-signal classification behavior, including fail-closed conflict handling.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyCommitmentSignal,
  createCommitmentSignalRuleContext
} from "../../src/core/commitmentSignalClassifier";

test("classifyCommitmentSignal detects topic resolution candidate from user input", () => {
  const result = classifyCommitmentSignal("my tax filing is complete", {
    mode: "user_input",
    ruleContext: createCommitmentSignalRuleContext(null)
  });

  assert.equal(result.category, "TOPIC_RESOLUTION_CANDIDATE");
  assert.equal(result.conflict, false);
  assert.equal(result.confidenceTier, "HIGH");
  assert.equal(result.matchedRuleId, "commitment_signal_v1_user_input_topic_resolution_candidate");
});

test("classifyCommitmentSignal detects generic resolution signal from user input", () => {
  const result = classifyCommitmentSignal("I am all set, no longer need help", {
    mode: "user_input",
    ruleContext: createCommitmentSignalRuleContext(null)
  });

  assert.equal(result.category, "GENERIC_RESOLUTION");
  assert.equal(result.conflict, false);
  assert.equal(result.matchedRuleId, "commitment_signal_v1_user_input_generic_resolution");
});

test("classifyCommitmentSignal fails closed on conflicting user resolution and unresolved signals", () => {
  const result = classifyCommitmentSignal("tax filing is complete but still pending", {
    mode: "user_input",
    ruleContext: createCommitmentSignalRuleContext(null)
  });

  assert.equal(result.category, "UNCLEAR");
  assert.equal(result.conflict, true);
  assert.equal(result.matchedRuleId, "commitment_signal_v1_user_input_conflict");
});

test("classifyCommitmentSignal resolves fact value markers when non-conflicting", () => {
  const result = classifyCommitmentSignal("resolved", {
    mode: "fact_value",
    ruleContext: createCommitmentSignalRuleContext(null)
  });

  assert.equal(result.category, "RESOLVED_MARKER");
  assert.equal(result.conflict, false);
  assert.equal(result.matchedRuleId, "commitment_signal_v1_fact_value_resolved_marker");
});

test("classifyCommitmentSignal fails closed on conflicting fact value markers", () => {
  const result = classifyCommitmentSignal("resolved but still pending", {
    mode: "fact_value",
    ruleContext: createCommitmentSignalRuleContext(null)
  });

  assert.equal(result.category, "UNCLEAR");
  assert.equal(result.conflict, true);
  assert.equal(result.matchedRuleId, "commitment_signal_v1_fact_value_conflict");
});

test("createCommitmentSignalRuleContext applies tightening-only generic-disable override", () => {
  const context = createCommitmentSignalRuleContext({
    schemaVersion: 1,
    disableGenericResolution: true
  });
  const result = classifyCommitmentSignal("I am all set", {
    mode: "user_input",
    ruleContext: context
  });

  assert.equal(result.category, "NO_SIGNAL");
  assert.equal(result.matchedRuleId, "commitment_signal_v1_user_input_no_resolution_signal");
});
