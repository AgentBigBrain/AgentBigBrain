/**
 * @fileoverview Tests canonical backend normalization for model client selection.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeModelBackend } from "../../src/models/backendConfig";

test("normalizeModelBackend preserves canonical backend names", () => {
  assert.equal(normalizeModelBackend("mock"), "mock");
  assert.equal(normalizeModelBackend("ollama"), "ollama");
  assert.equal(normalizeModelBackend("openai_api"), "openai_api");
  assert.equal(normalizeModelBackend("codex_oauth"), "codex_oauth");
});

test("normalizeModelBackend preserves legacy openai alias", () => {
  assert.equal(normalizeModelBackend("openai"), "openai_api");
});

test("normalizeModelBackend fails closed for unsupported values", () => {
  assert.throws(
    () => normalizeModelBackend("mystery"),
    /Unsupported BRAIN_MODEL_BACKEND/i
  );
});
