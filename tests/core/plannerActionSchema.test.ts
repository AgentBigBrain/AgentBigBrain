/**
 * @fileoverview Focused tests for planner action schema normalization helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { getHardConstraintActionAuthority } from "../../src/core/hardConstraints";
import {
  getPlannerActionAliasCompatibilityDiagnostic,
  normalizePlannerActionParams,
  normalizePlannerActionTypeAlias
} from "../../src/core/plannerActionSchema";

test("normalizePlannerActionParams clamps planner timeoutMs into supported runtime bounds", () => {
  const params = normalizePlannerActionParams(
    {
      timeoutMs: 240000
    },
    {}
  );

  assert.equal(params.timeoutMs, 120000);
});

test("normalizePlannerActionParams raises too-small planner timeoutMs to the minimum bound", () => {
  const params = normalizePlannerActionParams(
    {
      timeoutMs: 25
    },
    {}
  );

  assert.equal(params.timeoutMs, 250);
});

test("normalizePlannerActionParams clamps nested params.timeoutMs into supported runtime bounds", () => {
  const params = normalizePlannerActionParams(
    {},
    {
      timeoutMs: 240000
    }
  );

  assert.equal(params.timeoutMs, 120000);
});

test("normalizePlannerActionTypeAlias does not promote generic verbs into risky actions", () => {
  assert.equal(normalizePlannerActionTypeAlias("run"), null);
  assert.equal(normalizePlannerActionTypeAlias("use"), null);
  assert.equal(normalizePlannerActionTypeAlias("invoke"), null);
  assert.equal(normalizePlannerActionTypeAlias("run_skill"), "run_skill");
  assert.equal(normalizePlannerActionTypeAlias("use_skill"), "run_skill");

  const diagnostic = getPlannerActionAliasCompatibilityDiagnostic("run");
  assert.deepEqual(diagnostic, {
    alias: "run",
    legacyActionType: "run_skill",
    reason: "generic_alias_requires_exact_action_context"
  });
});

test("hard constraints can inspect canonical action authority metadata", () => {
  const networkMetadata = getHardConstraintActionAuthority("network_write");
  assert.equal(networkMetadata.type, "network_write");
  assert.equal(networkMetadata.riskClass, "external_write");
  assert.equal(networkMetadata.sideEffectClass, "external_network");

  const responseMetadata = getHardConstraintActionAuthority("respond");
  assert.equal(responseMetadata.sideEffectClass, "none");
});
