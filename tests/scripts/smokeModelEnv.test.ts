import assert from "node:assert/strict";
import test from "node:test";

import { buildSmokeModelEnvOverrides } from "../../scripts/evidence/smokeModelEnv";

test("buildSmokeModelEnvOverrides prefers ollama when the local model is ready", () => {
  const previousPreferLocal = process.env.BRAIN_LIVE_SMOKE_PREFER_LOCAL_MODEL;
  process.env.BRAIN_LIVE_SMOKE_PREFER_LOCAL_MODEL = "true";

  const result = buildSmokeModelEnvOverrides({
    provider: "ollama",
    reachable: true,
    modelPresent: true,
    model: "phi4-mini:latest"
  });

  assert.equal(result.backend, "ollama");
  assert.equal(result.envOverrides.BRAIN_MODEL_BACKEND, "ollama");
  assert.equal(result.envOverrides.OLLAMA_MODEL_LARGE_REASONING, "phi4-mini:latest");
  assert.equal(result.envOverrides.OLLAMA_MODEL_DEFAULT, "phi4-mini:latest");

  if (previousPreferLocal === undefined) {
    delete process.env.BRAIN_LIVE_SMOKE_PREFER_LOCAL_MODEL;
  } else {
    process.env.BRAIN_LIVE_SMOKE_PREFER_LOCAL_MODEL = previousPreferLocal;
  }
});

test("buildSmokeModelEnvOverrides keeps the existing backend when ollama is unavailable", () => {
  const result = buildSmokeModelEnvOverrides({
    provider: "ollama",
    reachable: false,
    modelPresent: false,
    model: "phi4-mini:latest"
  });

  assert.equal(result.backend, "existing");
  assert.deepEqual(result.envOverrides, {});
});

test("buildSmokeModelEnvOverrides keeps the existing backend by default even when ollama is ready", () => {
  const previousPreferLocal = process.env.BRAIN_LIVE_SMOKE_PREFER_LOCAL_MODEL;
  delete process.env.BRAIN_LIVE_SMOKE_PREFER_LOCAL_MODEL;

  const result = buildSmokeModelEnvOverrides({
    provider: "ollama",
    reachable: true,
    modelPresent: true,
    model: "phi4-mini:latest"
  });

  assert.equal(result.backend, "existing");
  assert.deepEqual(result.envOverrides, {});

  if (previousPreferLocal === undefined) {
    delete process.env.BRAIN_LIVE_SMOKE_PREFER_LOCAL_MODEL;
  } else {
    process.env.BRAIN_LIVE_SMOKE_PREFER_LOCAL_MODEL = previousPreferLocal;
  }
});
