/**
 * @fileoverview Covers the bounded Ollama-backed bridge-question-timing interpretation task.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createOllamaBridgeQuestionTimingInterpretationResolver } from "../../src/organs/languageUnderstanding/ollamaLocalIntentModel";

test("createOllamaBridgeQuestionTimingInterpretationResolver parses a valid payload", async () => {
  let capturedBody = "";
  const resolver = createOllamaBridgeQuestionTimingInterpretationResolver(
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
              kind: "defer_for_context",
              confidence: "high",
              explanation: "The user is focused on active workflow execution, so this is not a natural interruption point."
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
    userInput: "Please finish the CSS fix before we talk about anything else.",
    routingClassification: null,
    sessionHints: {
      hasReturnHandoff: false,
      returnHandoffStatus: null,
      returnHandoffPreviewAvailable: false,
      returnHandoffPrimaryArtifactAvailable: false,
      returnHandoffChangedPathCount: 0,
      returnHandoffNextSuggestedStepAvailable: false,
      modeContinuity: "build",
      workflowContinuityActive: true
    },
    recentTurns: [
      {
        role: "assistant",
        text: "I noticed Sarah and Mike keep coming up together."
      }
    ],
    questionPrompt: "I noticed Sarah and Mike come up together. How would you describe their relationship?",
    entityLabels: ["Sarah", "Mike"]
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    kind: "defer_for_context",
    confidence: "high",
    explanation: "The user is focused on active workflow execution, so this is not a natural interruption point."
  });
  const requestPayload = JSON.parse(capturedBody) as { prompt?: string };
  assert.match(requestPayload.prompt ?? "", /Task: bridge_question_timing_interpretation\./);
  assert.match(requestPayload.prompt ?? "", /Sarah/);
  assert.match(requestPayload.prompt ?? "", /Mike/);
});

test("createOllamaBridgeQuestionTimingInterpretationResolver fails closed on unsupported payload", async () => {
  const resolver = createOllamaBridgeQuestionTimingInterpretationResolver(
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
              kind: "interrupt_now",
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
    userInput: "Who is Sarah to Mike?",
    routingClassification: null,
    questionPrompt: "How would you describe their relationship?",
    entityLabels: ["Sarah", "Mike"]
  });

  assert.equal(signal, null);
});
