/**
 * @fileoverview Covers the bounded Ollama-backed continuation-interpretation task.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createOllamaContinuationInterpretationResolver } from "../../src/organs/languageUnderstanding/ollamaLocalIntentModel";

test("createOllamaContinuationInterpretationResolver parses a valid continuation_interpretation payload", async () => {
  let capturedBody = "";
  const resolver = createOllamaContinuationInterpretationResolver(
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
              kind: "return_handoff_resume",
              followUpCategory: null,
              continuationTarget: "return_handoff",
              candidateValue: null,
              confidence: "high",
              explanation: "The user wants to continue from the saved checkpoint."
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
    userInput: "Pick that back up from where you left off.",
    routingClassification: null,
    sessionHints: {
      hasReturnHandoff: true,
      returnHandoffStatus: "waiting_for_user",
      returnHandoffPreviewAvailable: true,
      returnHandoffPrimaryArtifactAvailable: true,
      returnHandoffChangedPathCount: 2,
      returnHandoffNextSuggestedStepAvailable: true,
      modeContinuity: "build"
    },
    recentAssistantTurn: "I paused at the checkpoint and can continue when you are ready."
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    kind: "return_handoff_resume",
    followUpCategory: null,
    continuationTarget: "return_handoff",
    candidateValue: null,
    confidence: "high",
    explanation: "The user wants to continue from the saved checkpoint."
  });
  const requestPayload = JSON.parse(capturedBody) as { prompt?: string };
  assert.match(requestPayload.prompt ?? "", /Task: continuation_interpretation\./);
  assert.match(requestPayload.prompt ?? "", /durable checkpoint|last stopping point/i);
});

test("createOllamaContinuationInterpretationResolver keeps bounded adjust payloads for short follow-up turns", async () => {
  const resolver = createOllamaContinuationInterpretationResolver(
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
              kind: "short_follow_up",
              followUpCategory: "adjust",
              continuationTarget: "prior_assistant_turn",
              candidateValue: "to weekly",
              confidence: "high",
              explanation: "The user is adjusting the prior proposal."
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
    userInput: "adjust it to weekly",
    routingClassification: null,
    recentAssistantTurn: "Do you want me to schedule that for daily or weekly?"
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    kind: "short_follow_up",
    followUpCategory: "adjust",
    continuationTarget: "prior_assistant_turn",
    candidateValue: "to weekly",
    confidence: "high",
    explanation: "The user is adjusting the prior proposal."
  });
});

test("createOllamaContinuationInterpretationResolver fails closed on invalid continuation target", async () => {
  const resolver = createOllamaContinuationInterpretationResolver(
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
              kind: "return_handoff_resume",
              followUpCategory: null,
              continuationTarget: "prior_assistant_turn",
              candidateValue: null,
              confidence: "high",
              explanation: "Bad target."
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
    userInput: "pick that back up",
    routingClassification: null
  });

  assert.equal(signal, null);
});
