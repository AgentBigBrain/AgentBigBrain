/**
 * @fileoverview Focused tests for planner action schema normalization helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizePlannerActionParams } from "../../src/core/plannerActionSchema";

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
