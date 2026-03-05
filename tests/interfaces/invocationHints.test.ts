/**
 * @fileoverview Tests invocation-hint rewriting so user-facing command guidance matches name-call policy requirements.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { applyInvocationHints } from "../../src/interfaces/invocationHints";

test("invocation hints leave text unchanged when name-call is disabled", () => {
  const input = "Use /status for live state.\n/help";
  const output = applyInvocationHints(input, {
    requireNameCall: false,
    aliases: ["BigBrain"]
  });

  assert.equal(output, input);
});

test("invocation hints rewrite slash-command lines with alias prefix", () => {
  const input = "Commands:\n/help\n/status";
  const output = applyInvocationHints(input, {
    requireNameCall: true,
    aliases: ["BigBrain"]
  });

  assert.equal(output, "Commands:\nBigBrain /help\nBigBrain /status");
});

test("invocation hints rewrite inline 'Use /status' guidance", () => {
  const input = "Queued.\nUse /status to monitor progress.";
  const output = applyInvocationHints(input, {
    requireNameCall: true,
    aliases: ["Brain"]
  });

  assert.ok(output.includes("Use Brain /status"));
});

