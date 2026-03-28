/**
 * @fileoverview Covers the bounded Ollama-backed proposal-reply-interpretation task.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createOllamaProposalReplyInterpretationResolver } from "../../src/organs/languageUnderstanding/ollamaLocalIntentModel";

test("createOllamaProposalReplyInterpretationResolver parses a valid adjust payload", async () => {
  let capturedBody = "";
  const resolver = createOllamaProposalReplyInterpretationResolver(
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
              kind: "adjust",
              adjustmentText: "make it weekly instead",
              confidence: "high",
              explanation: "The user is asking to revise the active draft."
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
    userInput: "Could you make it weekly instead?",
    routingClassification: null,
    activeProposalPreview: "Schedule a daily summary every morning.",
    recentAssistantTurn: "I drafted a daily summary automation for you."
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    kind: "adjust",
    adjustmentText: "make it weekly instead",
    confidence: "high",
    explanation: "The user is asking to revise the active draft."
  });
  const requestPayload = JSON.parse(capturedBody) as { prompt?: string };
  assert.match(requestPayload.prompt ?? "", /Task: proposal_reply_interpretation\./);
  assert.match(requestPayload.prompt ?? "", /Active proposal preview:/);
  assert.match(requestPayload.prompt ?? "", /Recent assistant turn:/);
});

test("createOllamaProposalReplyInterpretationResolver fails closed on unsupported kind", async () => {
  const resolver = createOllamaProposalReplyInterpretationResolver(
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
              kind: "approve_and_execute",
              adjustmentText: null,
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
    userInput: "Yep, do it.",
    routingClassification: null,
    activeProposalPreview: "Draft: ship the change tonight."
  });

  assert.equal(signal, null);
});

test("createOllamaProposalReplyInterpretationResolver fails closed on invalid adjust payload", async () => {
  const resolver = createOllamaProposalReplyInterpretationResolver(
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
              kind: "adjust",
              adjustmentText: null,
              confidence: "medium",
              explanation: "Missing the actual change."
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
    userInput: "Change it.",
    routingClassification: null,
    activeProposalPreview: "Draft: send the automation weekly."
  });

  assert.equal(signal, null);
});
