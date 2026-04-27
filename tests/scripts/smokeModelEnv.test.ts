import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSmokeModelEnvOverrides,
  resolveRequiredRealSmokeBackend
} from "../../scripts/evidence/smokeModelEnv";

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
  assert.equal(result.envOverrides.OLLAMA_TIMEOUT_MS, "180000");
  assert.equal(result.envOverrides.BRAIN_LOCAL_INTENT_MODEL_TIMEOUT_MS, "90000");

  if (previousPreferLocal === undefined) {
    delete process.env.BRAIN_LIVE_SMOKE_PREFER_LOCAL_MODEL;
  } else {
    process.env.BRAIN_LIVE_SMOKE_PREFER_LOCAL_MODEL = previousPreferLocal;
  }
});

test("buildSmokeModelEnvOverrides honors explicit live-smoke local timeout overrides", () => {
  const previousPreferLocal = process.env.BRAIN_LIVE_SMOKE_PREFER_LOCAL_MODEL;
  const previousOllamaSmokeTimeout = process.env.BRAIN_LIVE_SMOKE_OLLAMA_TIMEOUT_MS;
  const previousIntentSmokeTimeout = process.env.BRAIN_LIVE_SMOKE_LOCAL_INTENT_TIMEOUT_MS;
  process.env.BRAIN_LIVE_SMOKE_PREFER_LOCAL_MODEL = "true";
  process.env.BRAIN_LIVE_SMOKE_OLLAMA_TIMEOUT_MS = "240000";
  process.env.BRAIN_LIVE_SMOKE_LOCAL_INTENT_TIMEOUT_MS = "120000";

  const result = buildSmokeModelEnvOverrides({
    provider: "ollama",
    reachable: true,
    modelPresent: true,
    model: "phi4-mini:latest"
  });

  assert.equal(result.backend, "ollama");
  assert.equal(result.envOverrides.OLLAMA_TIMEOUT_MS, "240000");
  assert.equal(result.envOverrides.BRAIN_LOCAL_INTENT_MODEL_TIMEOUT_MS, "120000");

  if (previousPreferLocal === undefined) {
    delete process.env.BRAIN_LIVE_SMOKE_PREFER_LOCAL_MODEL;
  } else {
    process.env.BRAIN_LIVE_SMOKE_PREFER_LOCAL_MODEL = previousPreferLocal;
  }
  if (previousOllamaSmokeTimeout === undefined) {
    delete process.env.BRAIN_LIVE_SMOKE_OLLAMA_TIMEOUT_MS;
  } else {
    process.env.BRAIN_LIVE_SMOKE_OLLAMA_TIMEOUT_MS = previousOllamaSmokeTimeout;
  }
  if (previousIntentSmokeTimeout === undefined) {
    delete process.env.BRAIN_LIVE_SMOKE_LOCAL_INTENT_TIMEOUT_MS;
  } else {
    process.env.BRAIN_LIVE_SMOKE_LOCAL_INTENT_TIMEOUT_MS = previousIntentSmokeTimeout;
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

test("resolveRequiredRealSmokeBackend blocks when the effective backend is mock", () => {
  const previousBackend = process.env.BRAIN_MODEL_BACKEND;
  delete process.env.BRAIN_MODEL_BACKEND;

  const result = resolveRequiredRealSmokeBackend({
    provider: "ollama",
    reachable: false,
    modelPresent: false,
    model: "phi4-mini:latest"
  });

  assert.equal(result.effectiveBackend, "mock");
  assert.match(result.blockerReason ?? "", /effective backend is mock/i);

  if (previousBackend === undefined) {
    delete process.env.BRAIN_MODEL_BACKEND;
  } else {
    process.env.BRAIN_MODEL_BACKEND = previousBackend;
  }
});
