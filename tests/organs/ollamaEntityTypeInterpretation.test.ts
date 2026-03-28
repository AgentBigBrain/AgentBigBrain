/**
 * @fileoverview Covers the bounded Ollama-backed entity-type-interpretation task.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createOllamaEntityTypeInterpretationResolver } from "../../src/organs/languageUnderstanding/ollamaLocalIntentModel";

test("createOllamaEntityTypeInterpretationResolver parses a valid payload", async () => {
  let capturedBody = "";
  const resolver = createOllamaEntityTypeInterpretationResolver(
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
              kind: "typed_candidates",
              typedCandidates: [
                {
                  candidateName: "Sarah",
                  entityType: "person"
                },
                {
                  candidateName: "Google",
                  entityType: "org"
                }
              ],
              confidence: "high",
              explanation: "The turn makes Sarah a person and Google an organization."
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
    userInput: "My friend Sarah has a meeting with Google tomorrow.",
    routingClassification: null,
    candidateEntities: [
      {
        candidateName: "Sarah",
        deterministicEntityType: "thing",
        domainHint: "relationship"
      },
      {
        candidateName: "Google",
        deterministicEntityType: "thing",
        domainHint: "workflow"
      }
    ],
    deterministicHints: ["friend", "meeting"]
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    kind: "typed_candidates",
    typedCandidates: [
      {
        candidateName: "Sarah",
        entityType: "person"
      },
      {
        candidateName: "Google",
        entityType: "org"
      }
    ],
    confidence: "high",
    explanation: "The turn makes Sarah a person and Google an organization."
  });
  const requestPayload = JSON.parse(capturedBody) as { prompt?: string };
  assert.match(requestPayload.prompt ?? "", /Deterministic hints already extracted:/);
});

test("createOllamaEntityTypeInterpretationResolver fails closed on unsupported entity type output", async () => {
  const resolver = createOllamaEntityTypeInterpretationResolver(
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
              kind: "typed_candidates",
              typedCandidates: [
                {
                  candidateName: "Sarah",
                  entityType: "team"
                }
              ],
              confidence: "medium",
              explanation: "Unsupported entity type."
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
    userInput: "Sarah is joining us later.",
    routingClassification: null,
    candidateEntities: [
      {
        candidateName: "Sarah",
        deterministicEntityType: "thing",
        domainHint: "relationship"
      }
    ]
  });

  assert.equal(signal, null);
});

test("createOllamaEntityTypeInterpretationResolver allows non-boundary output with no typed candidates", async () => {
  const resolver = createOllamaEntityTypeInterpretationResolver(
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
              kind: "non_entity_type_boundary",
              typedCandidates: [],
              confidence: "high",
              explanation: "This is a workflow command, not an entity-typing turn."
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
    userInput: "Close the browser and ship the fix.",
    routingClassification: null,
    candidateEntities: [
      {
        candidateName: "Browser",
        deterministicEntityType: "thing",
        domainHint: "workflow"
      }
    ]
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    kind: "non_entity_type_boundary",
    typedCandidates: [],
    confidence: "high",
    explanation: "This is a workflow command, not an entity-typing turn."
  });
});
