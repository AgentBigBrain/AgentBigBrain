/**
 * @fileoverview Covers the bounded Ollama contextual-followup-interpretation task.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createOllamaContextualFollowupInterpretationResolver } from "../../src/organs/languageUnderstanding/ollamaContextualFollowupInterpretation";

test("createOllamaContextualFollowupInterpretationResolver parses a valid status-followup payload", async () => {
  const resolver = createOllamaContextualFollowupInterpretationResolver(
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
              kind: "status_followup",
              candidateTokens: ["sarah", "draft"],
              confidence: "medium",
              explanation: "The user wants a later update on the existing Sarah draft thread."
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
    userInput: "Check in on the Sarah draft later.",
    routingClassification: null,
    sessionHints: {
      hasReturnHandoff: false,
      returnHandoffStatus: null,
      returnHandoffPreviewAvailable: false,
      returnHandoffPrimaryArtifactAvailable: false,
      returnHandoffChangedPathCount: 0,
      returnHandoffNextSuggestedStepAvailable: false,
      modeContinuity: "build"
    },
    deterministicCandidateTokens: ["sarah", "draft"]
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    kind: "status_followup",
    candidateTokens: ["sarah", "draft"],
    confidence: "medium",
    explanation: "The user wants a later update on the existing Sarah draft thread."
  });
});

test("createOllamaContextualFollowupInterpretationResolver fails closed on unsupported candidate token payload", async () => {
  const resolver = createOllamaContextualFollowupInterpretationResolver(
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
              kind: "status_followup",
              candidateTokens: ["sarah draft"],
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
    userInput: "Update me later on the Sarah draft.",
    routingClassification: null,
    sessionHints: null
  });

  assert.equal(signal, null);
});
