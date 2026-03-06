/**
 * @fileoverview Validates deterministic entropy-boundary behavior for ID generation.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { makeId } from "../../src/core/ids";
import { RuntimeEntropySource } from "../../src/core/runtimeEntropy";

/**
 * Builds deterministic entropy source fixture for ID tests.
 *
 * @returns Runtime entropy source with stable timestamp/token outputs.
 */
function buildDeterministicEntropySource(): RuntimeEntropySource {
  return {
    nowMs: () => 1_700_000_000_000,
    randomBase36: () => "abc123",
    randomHex: () => "deadbeefcafe"
  };
}

test("makeId uses injected entropy source for deterministic output", () => {
  const id = makeId("task", buildDeterministicEntropySource());
  assert.equal(id, "task_loyw3v28_abc123");
});

test("makeId keeps canonical prefix_time_token shape with default entropy", () => {
  const id = makeId("action");
  assert.match(id, /^action_[0-9a-z]+_[0-9a-z]{6}$/i);
});

