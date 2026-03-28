/**
 * @fileoverview Covers the bounded Ollama-backed contextual-reference-interpretation task.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createOllamaContextualReferenceInterpretationResolver } from "../../src/organs/languageUnderstanding/ollamaLocalIntentModel";

test("createOllamaContextualReferenceInterpretationResolver parses a valid contextual_reference_interpretation payload", async () => {
  let capturedBody = "";
  const resolver = createOllamaContextualReferenceInterpretationResolver(
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
              kind: "contextual_recall_reference",
              entityHints: ["owen"],
              topicHints: ["mri", "end up"],
              confidence: "high",
              explanation: "The user is referring back to Owen's unresolved MRI situation."
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
    userInput: "How did that whole thing end up?",
    routingClassification: null,
    sessionHints: {
      hasReturnHandoff: false,
      returnHandoffStatus: null,
      returnHandoffPreviewAvailable: false,
      returnHandoffPrimaryArtifactAvailable: false,
      returnHandoffChangedPathCount: 0,
      returnHandoffNextSuggestedStepAvailable: false,
      modeContinuity: null
    },
    deterministicHints: ["thing", "end up"],
    recentTurns: [
      {
        role: "user",
        text: "Owen was waiting on MRI results."
      }
    ],
    pausedThreads: [
      {
        topicLabel: "Owen Fall",
        resumeHint: "Owen was waiting on MRI results after the fall.",
        openLoopCount: 1,
        lastTouchedAt: "2026-02-14T15:00:00.000Z"
      }
    ]
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    kind: "contextual_recall_reference",
    entityHints: ["owen"],
    topicHints: ["mri", "end up"],
    confidence: "high",
    explanation: "The user is referring back to Owen's unresolved MRI situation."
  });
  const requestPayload = JSON.parse(capturedBody) as { prompt?: string };
  assert.match(requestPayload.prompt ?? "", /Task: contextual_reference_interpretation\./);
  assert.match(requestPayload.prompt ?? "", /Owen Fall/);
});

test("createOllamaContextualReferenceInterpretationResolver fails closed on sentence-like hint payloads", async () => {
  const resolver = createOllamaContextualReferenceInterpretationResolver(
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
              kind: "contextual_recall_reference",
              entityHints: ["owen had a rough fall and maybe this is the one"],
              topicHints: ["https://example.com/fake"],
              confidence: "high",
              explanation: "Invalid oversized hints."
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
    userInput: "How did that end up?",
    routingClassification: null
  });

  assert.equal(signal, null);
});
