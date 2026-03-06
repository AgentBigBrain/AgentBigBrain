/**
 * @fileoverview Validates deterministic Stage 6.85 routing-map prompt classification and execution hints.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRoutingExecutionHintV1,
  classifyRoutingIntentV1,
  isDiagnosticsRoutingClassification
} from "../../src/interfaces/routingMap";

test("classifyRoutingIntentV1 classifies schedule prompts as execution-surface calendar routing", () => {
  const classification = classifyRoutingIntentV1(
    "Schedule 3 focus blocks next week and show exact approval diff before any write."
  );
  assert.equal(classification.category, "SCHEDULE_FOCUS_BLOCKS");
  assert.equal(classification.routeType, "execution_surface");
  assert.equal(classification.actionFamily, "calendar");
  assert.equal(classification.fallbackReasonCode, "CALENDAR_PROPOSE_NOT_AVAILABLE");
  assert.equal(classification.rulepackVersion, "RoutingMapV1");
});

test("classifyRoutingIntentV1 classifies explicit diagnostics approval-diff prompts as diagnostics", () => {
  const classification = classifyRoutingIntentV1(
    "Show exact approval diff and wait for step-level approval."
  );
  assert.equal(classification.category, "DIAGNOSTICS_APPROVAL_DIFF");
  assert.equal(isDiagnosticsRoutingClassification(classification), true);
});

test("classifyRoutingIntentV1 classifies clone block-reason prompts as policy explanations", () => {
  const classification = classifyRoutingIntentV1(
    "Show why non-mergeable clone packet kinds are blocked."
  );
  assert.equal(classification.category, "CLONE_BLOCK_REASONS");
  assert.equal(classification.routeType, "policy_explanation");
  assert.equal(classification.actionFamily, "clone_workflow");
});

test("classifyRoutingIntentV1 classifies generic app-creation prompts as build execution surface", () => {
  const classification = classifyRoutingIntentV1(
    "Create a React app on my Desktop and execute now."
  );
  assert.equal(classification.category, "BUILD_SCAFFOLD");
  assert.equal(classification.routeType, "execution_surface");
  assert.equal(classification.actionFamily, "build");
  assert.equal(classification.fallbackReasonCode, "BUILD_NO_SIDE_EFFECT_EXECUTED");
  assert.equal(classification.matchedRuleId, "routing_v1_build_scaffold_generic");
});

test("classifyRoutingIntentV1 does not over-classify explanation-only build prompts as execution surface", () => {
  const classification = classifyRoutingIntentV1(
    "How do I create a React app on my Desktop?"
  );
  assert.equal(classification.category, "NONE");
  assert.equal(classification.routeType, "none");
});

test("buildRoutingExecutionHintV1 returns deterministic hints for workflow replay and no hint for NONE", () => {
  const workflowHint = buildRoutingExecutionHintV1(
    classifyRoutingIntentV1("Capture this flow, compile replay script, and block on selector mismatch.")
  );
  assert.ok(workflowHint);
  assert.match(workflowHint ?? "", /reasonCode\s+WORKFLOW_REPLAY_NO_SIDE_EFFECT_EXECUTED/i);

  const noneHint = buildRoutingExecutionHintV1(classifyRoutingIntentV1("How are you today?"));
  assert.equal(noneHint, null);
});
