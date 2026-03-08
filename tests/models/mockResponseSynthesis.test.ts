/**
 * @fileoverview Tests canonical mock response-synthesis builders.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildResponseSynthesisOutput } from "../../src/models/mock/responseSynthesis";

test("buildResponseSynthesisOutput uses the active wrapped request", () => {
  const output = buildResponseSynthesisOutput(
    JSON.stringify({
      userInput: [
        "Recent conversation context (oldest to newest):",
        "- User: Create a React app on my Desktop and execute now.",
        "",
        "Current user request:",
        "say currently running: none queued: one"
      ].join("\n")
    })
  );

  assert.equal(output.message, "currently running: none queued: one");
});

test("buildResponseSynthesisOutput falls back to generic assistance text", () => {
  const output = buildResponseSynthesisOutput(
    JSON.stringify({
      userInput: "help me with something specific"
    })
  );

  assert.match(output.message, /share a little more detail/i);
});
