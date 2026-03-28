/**
 * @fileoverview Covers the bounded Ollama-backed entity-reference-interpretation task.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createOllamaEntityReferenceInterpretationResolver } from "../../src/organs/languageUnderstanding/ollamaLocalIntentModel";

test("createOllamaEntityReferenceInterpretationResolver parses a valid entity_reference_interpretation payload", async () => {
  let capturedBody = "";
  const resolver = createOllamaEntityReferenceInterpretationResolver(
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
              kind: "entity_alias_candidate",
              selectedEntityKeys: ["entity_sarah"],
              aliasCandidate: "Sarah Connor",
              confidence: "medium",
              explanation: "The user is clarifying which Sarah they meant."
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
    userInput: "I mean Sarah Connor, not Sarah Lee.",
    routingClassification: null,
    candidateEntities: [
      {
        entityKey: "entity_sarah",
        canonicalName: "Sarah",
        aliases: ["Sarah"],
        entityType: "person",
        domainHint: "relationship"
      }
    ],
    deterministicHints: ["sarah"]
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    kind: "entity_alias_candidate",
    selectedEntityKeys: ["entity_sarah"],
    aliasCandidate: "Sarah Connor",
    confidence: "medium",
    explanation: "The user is clarifying which Sarah they meant."
  });
  const requestPayload = JSON.parse(capturedBody) as { prompt?: string };
  assert.match(requestPayload.prompt ?? "", /Task: entity_reference_interpretation\./);
  assert.match(requestPayload.prompt ?? "", /entity_sarah/);
});

test("createOllamaEntityReferenceInterpretationResolver fails closed on invented entity keys", async () => {
  const resolver = createOllamaEntityReferenceInterpretationResolver(
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
              kind: "entity_scoped_reference",
              selectedEntityKeys: ["entity_invented"],
              aliasCandidate: null,
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
    userInput: "How is Sarah doing lately?",
    routingClassification: null,
    candidateEntities: [
      {
        entityKey: "entity_sarah",
        canonicalName: "Sarah",
        aliases: ["Sarah"],
        entityType: "person",
        domainHint: "relationship"
      }
    ]
  });

  assert.equal(signal, null);
});
