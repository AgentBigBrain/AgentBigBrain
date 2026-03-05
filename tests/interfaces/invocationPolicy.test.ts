/**
 * @fileoverview Tests deterministic invocation-name gating behavior for interface messages.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { applyInvocationPolicy } from "../../src/interfaces/invocationPolicy";

test("invocation policy passes through text when name-call requirement is disabled", () => {
  const result = applyInvocationPolicy("say hello", {
    requireNameCall: false,
    aliases: ["BigBrain"]
  });

  assert.equal(result.accepted, true);
  assert.equal(result.normalizedText, "say hello");
  assert.equal(result.reason, "ALIAS_NOT_REQUIRED");
});

test("invocation policy accepts and strips configured alias prefixes", () => {
  const result = applyInvocationPolicy("BigBrain, say hello", {
    requireNameCall: true,
    aliases: ["BigBrain"]
  });

  assert.equal(result.accepted, true);
  assert.equal(result.normalizedText, "say hello");
  assert.equal(result.reason, "ALIAS_MATCHED");
});

test("invocation policy supports @alias addressing", () => {
  const result = applyInvocationPolicy("@BigBrain: run /help", {
    requireNameCall: true,
    aliases: ["BigBrain"]
  });

  assert.equal(result.accepted, true);
  assert.equal(result.normalizedText, "run /help");
});

test("invocation policy ignores messages without required alias", () => {
  const result = applyInvocationPolicy("hello there", {
    requireNameCall: true,
    aliases: ["BigBrain"]
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "ALIAS_REQUIRED");
});

test("invocation policy rejects alias-only messages", () => {
  const result = applyInvocationPolicy("BigBrain", {
    requireNameCall: true,
    aliases: ["BigBrain"]
  });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, "EMPTY_AFTER_ALIAS");
});

test("invocation policy matches aliases case-insensitively", () => {
  const result = applyInvocationPolicy("biGBraIN say hello", {
    requireNameCall: true,
    aliases: ["BIGBRAIN"]
  });

  assert.equal(result.accepted, true);
  assert.equal(result.normalizedText, "say hello");
});

