import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultOllamaModelForAlias,
  resolveOllamaModel
} from "../../src/models/ollama/modelResolution";

test("resolveOllamaModel keeps direct provider ids unchanged", () => {
  const resolved = resolveOllamaModel("phi4-mini:latest", {});

  assert.deepEqual(resolved, {
    requestedModel: "phi4-mini:latest",
    aliasModel: null,
    providerModel: "phi4-mini:latest"
  });
});

test("resolveOllamaModel prefers alias-specific env overrides", () => {
  const resolved = resolveOllamaModel("large-reasoning-model", {
    OLLAMA_MODEL_LARGE_REASONING: "phi4-mini:latest"
  });

  assert.deepEqual(resolved, {
    requestedModel: "large-reasoning-model",
    aliasModel: "large-reasoning-model",
    providerModel: "phi4-mini:latest"
  });
});

test("defaultOllamaModelForAlias uses OLLAMA_MODEL_DEFAULT", () => {
  assert.equal(
    defaultOllamaModelForAlias("medium-general-model", {
      OLLAMA_MODEL_DEFAULT: "phi4-mini:latest"
    }),
    "phi4-mini:latest"
  );
});

test("defaultOllamaModelForAlias fails closed when no mapping exists", () => {
  assert.throws(
    () => defaultOllamaModelForAlias("large-reasoning-model", {}),
    /OLLAMA_MODEL_LARGE_REASONING|OLLAMA_MODEL_DEFAULT/i
  );
});
