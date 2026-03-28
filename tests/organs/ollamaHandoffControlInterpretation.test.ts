/**
 * @fileoverview Covers the bounded Ollama handoff-control-interpretation task.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createOllamaHandoffControlInterpretationResolver } from "../../src/organs/languageUnderstanding/ollamaHandoffControlInterpretation";

test("createOllamaHandoffControlInterpretationResolver parses a valid review payload", async () => {
  const resolver = createOllamaHandoffControlInterpretationResolver(
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
              kind: "review_request",
              confidence: "medium",
              explanation: "The user wants to inspect the saved draft."
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
    userInput: "What is ready for review from that draft?",
    routingClassification: null,
    sessionHints: {
      hasReturnHandoff: true,
      returnHandoffStatus: "waiting_for_user",
      returnHandoffPreviewAvailable: true,
      returnHandoffPrimaryArtifactAvailable: true,
      returnHandoffChangedPathCount: 2,
      returnHandoffNextSuggestedStepAvailable: true,
      modeContinuity: "build"
    }
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    kind: "review_request",
    confidence: "medium",
    explanation: "The user wants to inspect the saved draft."
  });
});

test("createOllamaHandoffControlInterpretationResolver fails closed on unsupported kind", async () => {
  const resolver = createOllamaHandoffControlInterpretationResolver(
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
              kind: "resume_handoff_now",
              confidence: "high",
              explanation: "Unsupported"
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
    userInput: "What changed while I was away?",
    routingClassification: null,
    sessionHints: null
  });

  assert.equal(signal, null);
});
