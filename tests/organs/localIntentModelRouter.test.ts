/**
 * @fileoverview Tests fail-closed diagnostics for optional local intent-model routing.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { LocalIntentModelRequest } from "../../src/organs/languageUnderstanding/localIntentModelContracts";
import {
  routeLocalIntentModel,
  routeLocalIntentModelWithDiagnostics
} from "../../src/organs/languageUnderstanding/localIntentModelRouter";

const request: LocalIntentModelRequest = {
  userInput: "Handle this however you think is best.",
  routingClassification: null,
  sessionHints: null
};

test("routeLocalIntentModelWithDiagnostics distinguishes missing resolver from no signal", async () => {
  const missing = await routeLocalIntentModelWithDiagnostics(request);
  assert.equal(missing.result, null);
  assert.equal(missing.diagnostic.status, "disabled");

  const noSignal = await routeLocalIntentModelWithDiagnostics(request, async () => null);
  assert.equal(noSignal.result, null);
  assert.equal(noSignal.diagnostic.status, "no_signal");
});

test("routeLocalIntentModelWithDiagnostics classifies timeout, malformed, and unavailable errors", async () => {
  const timeout = await routeLocalIntentModelWithDiagnostics(request, async () => {
    throw new Error("The local model request timed out.");
  });
  assert.equal(timeout.result, null);
  assert.equal(timeout.diagnostic.status, "timeout");

  const malformed = await routeLocalIntentModelWithDiagnostics(request, async () => {
    throw new SyntaxError("Unexpected token in JSON response.");
  });
  assert.equal(malformed.result, null);
  assert.equal(malformed.diagnostic.status, "malformed_response");

  const unavailable = await routeLocalIntentModelWithDiagnostics(request, async () => {
    throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
  });
  assert.equal(unavailable.result, null);
  assert.equal(unavailable.diagnostic.status, "unavailable");
});

test("routeLocalIntentModelWithDiagnostics marks low-confidence signals distinctly", async () => {
  const routed = await routeLocalIntentModelWithDiagnostics(request, async () => ({
    source: "local_intent_model",
    mode: "build",
    confidence: "low",
    matchedRuleId: "local_intent_model_low_confidence_build",
    explanation: "Weak model guess.",
    clarification: null
  }));

  assert.equal(routed.result?.mode, "build");
  assert.equal(routed.diagnostic.status, "low_confidence");
});

test("routeLocalIntentModel remains a fail-closed compatibility wrapper", async () => {
  const routed = await routeLocalIntentModel(request, async () => {
    throw new Error("local provider unavailable");
  });

  assert.equal(routed, null);
});
