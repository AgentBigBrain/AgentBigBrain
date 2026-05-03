/**
 * @fileoverview Covers the bounded Ollama-backed entity-domain-hint-interpretation task.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { createOllamaEntityDomainHintInterpretationResolver } from "../../src/organs/languageUnderstanding/ollamaLocalIntentModel";

test("createOllamaEntityDomainHintInterpretationResolver parses a valid payload", async () => {
  let capturedBody = "";
  const resolver = createOllamaEntityDomainHintInterpretationResolver(
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
              kind: "domain_hinted_candidates",
              domainHintedCandidates: [
                {
                  candidateId: "entity_sarah",
                  domainHint: "relationship"
                },
                {
                  candidateId: "entity_google",
                  domainHint: "workflow"
                }
              ],
              confidence: "high",
              explanation:
                "Sarah is framed socially while Google is framed as work context."
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
    userInput: "My friend Sarah is helping Google with the launch deck.",
    routingClassification: null,
    candidateEntities: [
      {
        candidateId: "entity_sarah",
        candidateName: "Sarah",
        entityType: "person",
        deterministicDomainHint: "workflow"
      },
      {
        candidateId: "entity_google",
        candidateName: "Google",
        entityType: "org",
        deterministicDomainHint: "workflow"
      }
    ],
    deterministicHints: ["friend", "launch deck"]
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    kind: "domain_hinted_candidates",
    domainHintedCandidates: [
      {
        candidateId: "entity_sarah",
        domainHint: "relationship"
      },
      {
        candidateId: "entity_google",
        domainHint: "workflow"
      }
    ],
    confidence: "high",
    explanation: "Sarah is framed socially while Google is framed as work context."
  });
  const requestPayload = JSON.parse(capturedBody) as { prompt?: string };
  assert.match(requestPayload.prompt ?? "", /Task: entity_domain_hint_interpretation\./);
  assert.match(requestPayload.prompt ?? "", /candidateId/);
});

test("createOllamaEntityDomainHintInterpretationResolver fails closed on unsupported domain hint output", async () => {
  const resolver = createOllamaEntityDomainHintInterpretationResolver(
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
              kind: "domain_hinted_candidates",
              domainHintedCandidates: [
                {
                  candidateId: "entity_sarah",
                  domainHint: "system_policy"
                }
              ],
              confidence: "medium",
              explanation: "Unsupported domain hint."
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
    userInput: "My friend Sarah is coming over later.",
    routingClassification: null,
    candidateEntities: [
      {
        candidateId: "entity_sarah",
        candidateName: "Sarah",
        entityType: "person",
        deterministicDomainHint: null
      }
    ]
  });

  assert.equal(signal, null);
});

test("createOllamaEntityDomainHintInterpretationResolver rejects name-only model selections", async () => {
  const resolver = createOllamaEntityDomainHintInterpretationResolver(
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
              kind: "domain_hinted_candidates",
              domainHintedCandidates: [
                {
                  candidateName: "Sarah",
                  domainHint: "relationship"
                }
              ],
              confidence: "high",
              explanation: "The model echoed the candidate name instead of selecting the id."
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
    userInput: "My friend Sarah is coming over later.",
    routingClassification: null,
    candidateEntities: [
      {
        candidateId: "entity_sarah",
        candidateName: "Sarah",
        entityType: "person",
        deterministicDomainHint: null
      }
    ]
  });

  assert.equal(signal, null);
});

test("createOllamaEntityDomainHintInterpretationResolver allows non-boundary output with no hinted candidates", async () => {
  const resolver = createOllamaEntityDomainHintInterpretationResolver(
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
              kind: "non_entity_domain_boundary",
              domainHintedCandidates: [],
              confidence: "high",
              explanation: "This is a workflow command, not an entity-domain turn."
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
        candidateId: "entity_browser",
        candidateName: "Browser",
        entityType: "thing",
        deterministicDomainHint: "workflow"
      }
    ]
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    kind: "non_entity_domain_boundary",
    domainHintedCandidates: [],
    confidence: "high",
    explanation: "This is a workflow command, not an entity-domain turn."
  });
});
