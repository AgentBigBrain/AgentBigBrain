/**
 * @fileoverview Tests planner action normalization and respond payload helpers directly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hasRespondMessage,
  normalizeModelActions
} from "../../src/organs/plannerPolicy/actionNormalization";

test("normalizeModelActions canonicalizes alias action types and params", () => {
  const actions = normalizeModelActions([
    {
      type: "response",
      message: "hello from alias"
    }
  ]);

  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.type, "respond");
  assert.equal(actions[0]?.params.message, "hello from alias");
  assert.match(actions[0]?.id ?? "", /^action_/);
  assert.equal(typeof actions[0]?.estimatedCostUsd, "number");
});

test("hasRespondMessage fails closed for respond actions without text payload", () => {
  assert.equal(
    hasRespondMessage({
      id: "respond_empty",
      type: "respond",
      description: "respond",
      params: {},
      estimatedCostUsd: 0.01
    }),
    false
  );

  assert.equal(
    hasRespondMessage({
      id: "respond_text",
      type: "respond",
      description: "respond",
      params: {
        text: "hello"
      },
      estimatedCostUsd: 0.01
    }),
    true
  );
});
