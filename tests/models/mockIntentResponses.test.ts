/**
 * @fileoverview Tests canonical mock intent-response builders.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildIntentInterpretationOutput } from "../../src/models/mock/intentResponses";

test("buildIntentInterpretationOutput recognizes pulse-off requests", () => {
  const output = buildIntentInterpretationOutput(
    JSON.stringify({
      text: "Please stop pulse reminders for now."
    })
  );

  assert.equal(output.intentType, "pulse_control");
  assert.equal(output.mode, "off");
  assert.ok(output.confidence > 0.8);
});

test("buildIntentInterpretationOutput recognizes pulse status requests from context hints", () => {
  const output = buildIntentInterpretationOutput(
    JSON.stringify({
      text: "what's the status",
      contextHint: "pulse mode"
    })
  );

  assert.equal(output.intentType, "pulse_control");
  assert.equal(output.mode, "status");
});
