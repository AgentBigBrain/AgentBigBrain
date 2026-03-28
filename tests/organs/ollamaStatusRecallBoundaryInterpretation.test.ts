/**
 * @fileoverview Covers the bounded Ollama-backed status/recall-boundary interpretation task.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createOllamaStatusRecallBoundaryInterpretationResolver } from "../../src/organs/languageUnderstanding/ollamaLocalIntentModel";

test("createOllamaStatusRecallBoundaryInterpretationResolver parses a valid payload", async () => {
  let capturedBody = "";
  const resolver = createOllamaStatusRecallBoundaryInterpretationResolver(
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
              kind: "status_or_recall",
              focus: "location",
              confidence: "high",
              explanation: "The user is asking where the output was placed."
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
    userInput: "Where did you put it?",
    routingClassification: null,
    deterministicPreference: "status_or_recall"
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    kind: "status_or_recall",
    focus: "location",
    confidence: "high",
    explanation: "The user is asking where the output was placed."
  });
  const requestPayload = JSON.parse(capturedBody) as { prompt?: string };
  assert.match(requestPayload.prompt ?? "", /Deterministic boundary preference:/);
});

test("createOllamaStatusRecallBoundaryInterpretationResolver clears unsupported focus for non-status output", async () => {
  const resolver = createOllamaStatusRecallBoundaryInterpretationResolver(
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
              kind: "execute_now",
              focus: "browser",
              confidence: "medium",
              explanation: "The user is asking for an immediate change."
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
    userInput: "Change that section now.",
    routingClassification: null,
    deterministicPreference: "execute_now"
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    kind: "execute_now",
    focus: null,
    confidence: "medium",
    explanation: "The user is asking for an immediate change."
  });
});

test("createOllamaStatusRecallBoundaryInterpretationResolver fails closed on unsupported payload", async () => {
  const resolver = createOllamaStatusRecallBoundaryInterpretationResolver(
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
              kind: "route_to_browser_manager",
              focus: "browser",
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
    userInput: "What is still open?",
    routingClassification: null
  });

  assert.equal(signal, null);
});
