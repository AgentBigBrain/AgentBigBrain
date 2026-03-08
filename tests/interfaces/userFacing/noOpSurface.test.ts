/**
 * @fileoverview Focused tests for user-facing no-op rendering helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyRoutingIntentV1 } from "../../../src/interfaces/routingMap";
import {
  isExecutionStyleRequestPrompt,
  resolveExecutionSurfaceFallbackFromRouting,
  resolveHighRiskDeleteNoOpFallback
} from "../../../src/interfaces/userFacing/noOpSurface";
import { WINDOWS_TEST_DEMO_APP_DIR } from "../../support/windowsPathFixtures";

test("resolveExecutionSurfaceFallbackFromRouting returns build fallback for build-scaffold prompts", () => {
  const userInput =
    `Create a React app at ${WINDOWS_TEST_DEMO_APP_DIR} and execute now.`;
  const classification = classifyRoutingIntentV1(userInput);

  const fallback = resolveExecutionSurfaceFallbackFromRouting(classification, userInput);

  assert.equal(classification.category, "BUILD_SCAFFOLD");
  assert.ok(fallback);
  assert.match(fallback!, /BUILD_NO_SIDE_EFFECT_EXECUTED/i);
  assert.match(fallback!, /No governed build side-effect action was approved and executed in this run/i);
});

test("resolveHighRiskDeleteNoOpFallback explains protected-path deletes", () => {
  const fallback = resolveHighRiskDeleteNoOpFallback(
    "Delete C:\\Windows\\System32\\drivers\\etc\\hosts right now."
  );

  assert.ok(fallback);
  assert.match(fallback!, /high-risk delete/i);
  assert.match(fallback!, /protected or system path/i);
});

test("isExecutionStyleRequestPrompt distinguishes execution from explanation prompts", () => {
  assert.equal(isExecutionStyleRequestPrompt("Create the app and execute now."), true);
  assert.equal(isExecutionStyleRequestPrompt("How do I create the app?"), false);
});
