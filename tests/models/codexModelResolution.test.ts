/**
 * @fileoverview Tests Codex alias resolution and supported-model allowlisting.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  defaultCodexModelForAlias,
  isSupportedCodexModel,
  resolveCodexModel
} from "../../src/models/codex/modelResolution";

test("defaultCodexModelForAlias maps logical aliases to recommended defaults", () => {
  assert.equal(defaultCodexModelForAlias("small-fast-model"), "gpt-5.4-mini");
  assert.equal(defaultCodexModelForAlias("large-reasoning-model"), "gpt-5.4");
});

test("isSupportedCodexModel allows supported provider models", () => {
  assert.equal(isSupportedCodexModel("gpt-5.4-mini"), true);
  assert.equal(isSupportedCodexModel("gpt-5.4"), true);
});

test("resolveCodexModel applies env overrides for alias-backed routes", () => {
  const resolved = resolveCodexModel("large-reasoning-model", {
    CODEX_MODEL_LARGE_REASONING: "gpt-5.4"
  });
  assert.equal(resolved.aliasModel, "large-reasoning-model");
  assert.equal(resolved.providerModel, "gpt-5.4");
});

test("resolveCodexModel fails closed for unsupported provider models", () => {
  assert.throws(
    () =>
      resolveCodexModel("large-reasoning-model", {
        CODEX_MODEL_LARGE_REASONING: "gpt-5-nano"
      }),
    /does not support provider model/i
  );
});
