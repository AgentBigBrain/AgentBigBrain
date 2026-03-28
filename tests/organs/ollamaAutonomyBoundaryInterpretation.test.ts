/**
 * @fileoverview Covers the bounded Ollama-backed autonomy-boundary interpretation task.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createOllamaAutonomyBoundaryInterpretationResolver } from "../../src/organs/languageUnderstanding/ollamaLocalIntentModel";

test("createOllamaAutonomyBoundaryInterpretationResolver parses a valid payload", async () => {
  let capturedBody = "";
  const resolver = createOllamaAutonomyBoundaryInterpretationResolver(
    {
      baseUrl: "http://127.0.0.1:11434",
      model: "phi4-mini:latest",
      timeoutMs: 1000
    },
    {
      fetchImpl: async (_url, init) => {
        capturedBody = typeof init?.body === "string" ? init.body : "";
        return new Response(
          JSON.stringify({
            response: JSON.stringify({
              kind: "promote_to_autonomous",
              confidence: "medium",
              explanation: "Active workflow continuity makes the ambiguous end-to-end wording a real ownership request."
            })
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        );
      }
    }
  );

  const signal = await resolver({
    userInput: "Take care of it end to end and leave the preview open.",
    routingClassification: null,
    sessionHints: {
      hasReturnHandoff: false,
      returnHandoffStatus: null,
      returnHandoffPreviewAvailable: false,
      returnHandoffPrimaryArtifactAvailable: false,
      returnHandoffChangedPathCount: 0,
      returnHandoffNextSuggestedStepAvailable: false,
      modeContinuity: "build",
      workflowContinuityActive: true,
      domainDominantLane: "workflow"
    },
    recentTurns: [
      {
        role: "assistant",
        text: "I still have the landing page preview open from the prior run."
      }
    ],
    deterministicSignalStrength: "ambiguous"
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    kind: "promote_to_autonomous",
    confidence: "medium",
    explanation:
      "Active workflow continuity makes the ambiguous end-to-end wording a real ownership request."
  });
  const requestPayload = JSON.parse(capturedBody) as { prompt?: string };
  assert.match(requestPayload.prompt ?? "", /Task: autonomy_boundary_interpretation\./);
  assert.match(requestPayload.prompt ?? "", /Deterministic autonomy signal strength:/);
});

test("createOllamaAutonomyBoundaryInterpretationResolver fails closed on unsupported payload", async () => {
  const resolver = createOllamaAutonomyBoundaryInterpretationResolver(
    {
      baseUrl: "http://127.0.0.1:11434",
      model: "phi4-mini:latest",
      timeoutMs: 1000
    },
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            response: JSON.stringify({
              kind: "force_worker",
              confidence: "high",
              explanation: "Unsupported."
            })
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json"
            }
          }
        )
    }
  );

  const signal = await resolver({
    userInput: "Handle this all the way through.",
    routingClassification: null,
    deterministicSignalStrength: "ambiguous"
  });

  assert.equal(signal, null);
});
