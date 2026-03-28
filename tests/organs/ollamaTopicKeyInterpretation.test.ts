/**
 * @fileoverview Covers the bounded Ollama-backed topic-key-interpretation task.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createOllamaTopicKeyInterpretationResolver } from "../../src/organs/languageUnderstanding/ollamaLocalIntentModel";

test("createOllamaTopicKeyInterpretationResolver parses a valid topic_key_interpretation payload", async () => {
  let capturedBody = "";
  const resolver = createOllamaTopicKeyInterpretationResolver(
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
              kind: "resume_paused_thread",
              selectedTopicKey: null,
              selectedThreadKey: "thread_css",
              confidence: "high",
              explanation: "The user is clearly returning to the paused CSS thread."
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
    userInput: "Go back to that CSS thing.",
    routingClassification: null,
    pausedThreads: [
      {
        threadKey: "thread_css",
        topicKey: "landing_page_css",
        topicLabel: "Landing Page CSS",
        resumeHint: "Finish the hero and features CSS polish.",
        state: "paused"
      }
    ],
    deterministicCandidates: [
      {
        topicKey: "landing_page_css",
        label: "Landing Page CSS",
        confidence: 0.58
      }
    ]
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    kind: "resume_paused_thread",
    selectedTopicKey: null,
    selectedThreadKey: "thread_css",
    confidence: "high",
    explanation: "The user is clearly returning to the paused CSS thread."
  });
  const requestPayload = JSON.parse(capturedBody) as { prompt?: string };
  assert.match(requestPayload.prompt ?? "", /Task: topic_key_interpretation\./);
  assert.match(requestPayload.prompt ?? "", /thread_css/);
});

test("createOllamaTopicKeyInterpretationResolver fails closed on invented topic/thread keys", async () => {
  const resolver = createOllamaTopicKeyInterpretationResolver(
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
              kind: "switch_topic_candidate",
              selectedTopicKey: "invented_topic_key",
              selectedThreadKey: null,
              confidence: "high",
              explanation: "Invalid invented key."
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
    userInput: "Switch back to the landing page.",
    routingClassification: null,
    deterministicCandidates: [
      {
        topicKey: "landing_page_hero",
        label: "Landing Page Hero",
        confidence: 0.61
      }
    ]
  });

  assert.equal(signal, null);
});
