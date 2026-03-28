/**
 * @fileoverview Covers the optional Ollama-backed local intent-model runtime seam.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  createOllamaEntityTypeInterpretationResolver,
  createOllamaIdentityInterpretationResolver,
  createOllamaLocalIntentModelResolver,
  createOllamaProposalReplyInterpretationResolver,
  createOllamaStatusRecallBoundaryInterpretationResolver,
  probeOllamaLocalIntentModel
} from "../../src/organs/languageUnderstanding/ollamaLocalIntentModel";
import {
  createAutonomyBoundaryInterpretationResolverFromEnv,
  createBridgeQuestionTimingInterpretationResolverFromEnv,
  createContinuationInterpretationResolverFromEnv,
  createContextualFollowupInterpretationResolverFromEnv,
  createContextualReferenceInterpretationResolverFromEnv,
  createEntityDomainHintInterpretationResolverFromEnv,
  createEntityReferenceInterpretationResolverFromEnv,
  createEntityTypeInterpretationResolverFromEnv,
  createHandoffControlInterpretationResolverFromEnv,
  createIdentityInterpretationResolverFromEnv,
  createLocalIntentModelRuntimeConfigFromEnv,
  createLocalIntentModelResolverFromEnv,
  createProposalReplyInterpretationResolverFromEnv,
  createStatusRecallBoundaryInterpretationResolverFromEnv,
  createTopicKeyInterpretationResolverFromEnv
} from "../../src/organs/languageUnderstanding/localIntentModelRuntime";

test("createOllamaLocalIntentModelResolver parses a valid Ollama JSON payload", async () => {
  let capturedBody = "";
  const resolver = createOllamaLocalIntentModelResolver(
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
              mode: "build",
              confidence: "high",
              matchedRuleId: "build_now",
              explanation: "The user clearly wants execution now."
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
    userInput: "Could you build that now and leave it visible for me later?",
    routingClassification: null,
    sessionHints: {
      hasReturnHandoff: true,
      returnHandoffStatus: "waiting_for_user",
      returnHandoffPreviewAvailable: true,
      returnHandoffPrimaryArtifactAvailable: true,
      returnHandoffChangedPathCount: 2,
      returnHandoffNextSuggestedStepAvailable: true,
      modeContinuity: "build"
    }
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    mode: "build",
    confidence: "high",
    matchedRuleId: "local_intent_model_build_now",
    explanation: "The user clearly wants execution now.",
    clarification: null,
    semanticHint: null
  });
  const requestPayload = JSON.parse(capturedBody) as { prompt?: string };
  assert.match(requestPayload.prompt ?? "", /"hasReturnHandoff":true/);
});

test("createOllamaLocalIntentModelResolver keeps supported semantic handoff hints from the model", async () => {
  const resolver = createOllamaLocalIntentModelResolver(
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
              mode: "status_or_recall",
              confidence: "medium",
              matchedRuleId: "review_ready_handoff",
              explanation: "The user is asking what to inspect from the saved draft.",
              semanticHint: "guided_review"
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
    userInput: "When I get back later, what should I inspect first from the draft you left me?",
    routingClassification: null,
    sessionHints: {
      hasReturnHandoff: true,
      returnHandoffStatus: "waiting_for_user",
      returnHandoffPreviewAvailable: true,
      returnHandoffPrimaryArtifactAvailable: true,
      returnHandoffChangedPathCount: 2,
      returnHandoffNextSuggestedStepAvailable: true,
      modeContinuity: "build"
    }
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    mode: "status_or_recall",
    confidence: "medium",
    matchedRuleId: "local_intent_model_review_ready_handoff",
    explanation: "The user is asking what to inspect from the saved draft.",
    clarification: null,
    semanticHint: "guided_review"
  });
});

test("createOllamaLocalIntentModelResolver keeps next_review_step semantic hints for saved-work review ordering", async () => {
  const resolver = createOllamaLocalIntentModelResolver(
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
              mode: "status_or_recall",
              confidence: "medium",
              matchedRuleId: "next_review_step_handoff",
              explanation: "The user is asking what to review next from the saved draft.",
              semanticHint: "next_review_step"
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
    userInput: "What should I review next from that draft?",
    routingClassification: null,
    sessionHints: {
      hasReturnHandoff: true,
      returnHandoffStatus: "waiting_for_user",
      returnHandoffPreviewAvailable: true,
      returnHandoffPrimaryArtifactAvailable: true,
      returnHandoffChangedPathCount: 2,
      returnHandoffNextSuggestedStepAvailable: true,
      modeContinuity: "build"
    }
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    mode: "status_or_recall",
    confidence: "medium",
    matchedRuleId: "local_intent_model_next_review_step_handoff",
    explanation: "The user is asking what to review next from the saved draft.",
    clarification: null,
    semanticHint: "next_review_step"
  });
});

test("createOllamaLocalIntentModelResolver keeps wrap_up_summary semantic hints for saved-work completion summaries", async () => {
  const resolver = createOllamaLocalIntentModelResolver(
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
              mode: "status_or_recall",
              confidence: "medium",
              matchedRuleId: "wrap_up_summary_handoff",
              explanation: "The user is asking what was wrapped up from the saved draft.",
              semanticHint: "wrap_up_summary"
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
    userInput: "What did you wrap up for me on that draft?",
    routingClassification: null,
    sessionHints: {
      hasReturnHandoff: true,
      returnHandoffStatus: "completed",
      returnHandoffPreviewAvailable: true,
      returnHandoffPrimaryArtifactAvailable: true,
      returnHandoffChangedPathCount: 3,
      returnHandoffNextSuggestedStepAvailable: true,
      modeContinuity: "build"
    }
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    mode: "status_or_recall",
    confidence: "medium",
    matchedRuleId: "local_intent_model_wrap_up_summary_handoff",
    explanation: "The user is asking what was wrapped up from the saved draft.",
    clarification: null,
    semanticHint: "wrap_up_summary"
  });
});

test("createOllamaLocalIntentModelResolver keeps review_ready semantic hints for softer anything-else-to-review prompts", async () => {
  const resolver = createOllamaLocalIntentModelResolver(
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
              mode: "status_or_recall",
              confidence: "medium",
              matchedRuleId: "review_ready_more_to_see_handoff",
              explanation: "The user is asking whether there is anything else worth reviewing in the saved draft.",
              semanticHint: "review_ready"
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
    userInput: "Is there anything else in that draft I should look over?",
    routingClassification: null,
    sessionHints: {
      hasReturnHandoff: true,
      returnHandoffStatus: "completed",
      returnHandoffPreviewAvailable: true,
      returnHandoffPrimaryArtifactAvailable: true,
      returnHandoffChangedPathCount: 3,
      returnHandoffNextSuggestedStepAvailable: true,
      modeContinuity: "build"
    }
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    mode: "status_or_recall",
    confidence: "medium",
    matchedRuleId: "local_intent_model_review_ready_more_to_see_handoff",
    explanation: "The user is asking whether there is anything else worth reviewing in the saved draft.",
    clarification: null,
    semanticHint: "review_ready"
  });
});

test("createOllamaLocalIntentModelResolver keeps resume_handoff semantic hints for resumable work", async () => {
  const resolver = createOllamaLocalIntentModelResolver(
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
              mode: "build",
              confidence: "medium",
              matchedRuleId: "resume_saved_draft",
              explanation: "The user wants to continue the saved draft instead of starting over.",
              semanticHint: "resume_handoff"
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
    userInput: "When you get a chance, keep refining that draft from where you left off.",
    routingClassification: null,
    sessionHints: {
      hasReturnHandoff: true,
      returnHandoffStatus: "waiting_for_user",
      returnHandoffPreviewAvailable: true,
      returnHandoffPrimaryArtifactAvailable: true,
      returnHandoffChangedPathCount: 2,
      returnHandoffNextSuggestedStepAvailable: true,
      modeContinuity: "build"
    }
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    mode: "build",
    confidence: "medium",
    matchedRuleId: "local_intent_model_resume_saved_draft",
    explanation: "The user wants to continue the saved draft instead of starting over.",
    clarification: null,
    semanticHint: "resume_handoff"
  });
});

test("createOllamaLocalIntentModelResolver keeps explain_handoff semantic hints for saved-work change explanations", async () => {
  const resolver = createOllamaLocalIntentModelResolver(
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
              mode: "status_or_recall",
              confidence: "medium",
              matchedRuleId: "explain_saved_draft_changes",
              explanation: "The user wants a walkthrough of what changed in the saved draft.",
              semanticHint: "explain_handoff"
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
    userInput: "Explain what you actually changed in that saved draft.",
    routingClassification: null,
    sessionHints: {
      hasReturnHandoff: true,
      returnHandoffStatus: "completed",
      returnHandoffPreviewAvailable: true,
      returnHandoffPrimaryArtifactAvailable: true,
      returnHandoffChangedPathCount: 3,
      returnHandoffNextSuggestedStepAvailable: true,
      modeContinuity: "build"
    }
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    mode: "status_or_recall",
    confidence: "medium",
    matchedRuleId: "local_intent_model_explain_saved_draft_changes",
    explanation: "The user wants a walkthrough of what changed in the saved draft.",
    clarification: null,
    semanticHint: "explain_handoff"
  });
});

test("createOllamaLocalIntentModelResolver fails closed on unsupported model output", async () => {
  const resolver = createOllamaLocalIntentModelResolver(
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
              mode: "unclear",
              confidence: "high",
              matchedRuleId: "ambiguous",
              explanation: "Ambiguous."
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
    userInput: "Maybe handle it later.",
    routingClassification: null
  });

  assert.equal(signal, null);
});

test("createOllamaIdentityInterpretationResolver parses a valid identity_interpretation payload", async () => {
  let capturedBody = "";
  const resolver = createOllamaIdentityInterpretationResolver(
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
              kind: "self_identity_declaration",
              candidateValue: "Avery",
              confidence: "high",
              shouldPersist: true,
              explanation: "The user is explicitly stating their own name."
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
    userInput: "My name is Avery, yes.",
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
    recentAssistantTurn: "What should I call you?"
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    kind: "self_identity_declaration",
    candidateValue: "Avery",
    confidence: "high",
    shouldPersist: true,
    explanation: "The user is explicitly stating their own name."
  });
  const requestPayload = JSON.parse(capturedBody) as { prompt?: string };
  assert.match(requestPayload.prompt ?? "", /Task: identity_interpretation\./);
  assert.match(requestPayload.prompt ?? "", /What should I call you\?/);
});

test("createOllamaIdentityInterpretationResolver fails closed on invalid declaration payload", async () => {
  const resolver = createOllamaIdentityInterpretationResolver(
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
              kind: "self_identity_declaration",
              candidateValue: "",
              confidence: "high",
              shouldPersist: true,
              explanation: "Invalid empty candidate."
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
    userInput: "My name is.",
    routingClassification: null
  });

  assert.equal(signal, null);
});

test("probeOllamaLocalIntentModel reports model presence from /api/tags", async () => {
  const probe = await probeOllamaLocalIntentModel(
    {
      baseUrl: "http://127.0.0.1:11434",
      model: "phi4-mini:latest",
      timeoutMs: 1000
    },
    {
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            models: [
              { name: "phi4-mini:latest" },
              { name: "other-model:latest" }
            ]
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

  assert.equal(probe.reachable, true);
  assert.equal(probe.modelPresent, true);
  assert.deepEqual(probe.availableModels, ["phi4-mini:latest", "other-model:latest"]);
});

test("createLocalIntentModelRuntimeConfigFromEnv parses env-backed config", () => {
  const config = createLocalIntentModelRuntimeConfigFromEnv({
    BRAIN_LOCAL_INTENT_MODEL_ENABLED: "true",
    BRAIN_LOCAL_INTENT_MODEL_PROVIDER: "ollama",
    BRAIN_LOCAL_INTENT_MODEL_BASE_URL: "http://127.0.0.1:11434",
    BRAIN_LOCAL_INTENT_MODEL_NAME: "phi4-mini:latest",
    BRAIN_LOCAL_INTENT_MODEL_TIMEOUT_MS: "22000",
    BRAIN_LOCAL_INTENT_MODEL_LIVE_SMOKE_REQUIRED: "true"
  });

  assert.deepEqual(config, {
    enabled: true,
    provider: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    model: "phi4-mini:latest",
    timeoutMs: 22000,
    liveSmokeRequired: true
  });
});

test("createLocalIntentModelResolverFromEnv returns undefined when disabled", () => {
  const resolver = createLocalIntentModelResolverFromEnv({
    BRAIN_LOCAL_INTENT_MODEL_ENABLED: "false"
  });

  assert.equal(resolver, undefined);
});

test("createIdentityInterpretationResolverFromEnv returns undefined when disabled", () => {
  const resolver = createIdentityInterpretationResolverFromEnv({
    BRAIN_LOCAL_INTENT_MODEL_ENABLED: "false"
  });

  assert.equal(resolver, undefined);
});

test("createProposalReplyInterpretationResolverFromEnv returns undefined when disabled", () => {
  const resolver = createProposalReplyInterpretationResolverFromEnv({
    BRAIN_LOCAL_INTENT_MODEL_ENABLED: "false"
  });

  assert.equal(resolver, undefined);
});

test("createContinuationInterpretationResolverFromEnv returns undefined when disabled", () => {
  const resolver = createContinuationInterpretationResolverFromEnv({
    BRAIN_LOCAL_INTENT_MODEL_ENABLED: "false"
  });

  assert.equal(resolver, undefined);
});

test("createContextualReferenceInterpretationResolverFromEnv returns undefined when disabled", () => {
  const resolver = createContextualReferenceInterpretationResolverFromEnv({
    BRAIN_LOCAL_INTENT_MODEL_ENABLED: "false"
  });

  assert.equal(resolver, undefined);
});

test("createTopicKeyInterpretationResolverFromEnv returns undefined when disabled", () => {
  const resolver = createTopicKeyInterpretationResolverFromEnv({
    BRAIN_LOCAL_INTENT_MODEL_ENABLED: "false"
  });

  assert.equal(resolver, undefined);
});

test("createEntityReferenceInterpretationResolverFromEnv returns undefined when disabled", () => {
  const resolver = createEntityReferenceInterpretationResolverFromEnv({
    BRAIN_LOCAL_INTENT_MODEL_ENABLED: "false"
  });

  assert.equal(resolver, undefined);
});

test("createEntityTypeInterpretationResolverFromEnv returns undefined when disabled", () => {
  const resolver = createEntityTypeInterpretationResolverFromEnv({
    BRAIN_LOCAL_INTENT_MODEL_ENABLED: "false"
  });

  assert.equal(resolver, undefined);
});

test("createEntityDomainHintInterpretationResolverFromEnv returns undefined when disabled", () => {
  const resolver = createEntityDomainHintInterpretationResolverFromEnv({
    BRAIN_LOCAL_INTENT_MODEL_ENABLED: "false"
  });

  assert.equal(resolver, undefined);
});

test("createHandoffControlInterpretationResolverFromEnv returns undefined when disabled", () => {
  const resolver = createHandoffControlInterpretationResolverFromEnv({
    BRAIN_LOCAL_INTENT_MODEL_ENABLED: "false"
  });

  assert.equal(resolver, undefined);
});

test("createContextualFollowupInterpretationResolverFromEnv returns undefined when disabled", () => {
  const resolver = createContextualFollowupInterpretationResolverFromEnv({
    BRAIN_LOCAL_INTENT_MODEL_ENABLED: "false"
  });

  assert.equal(resolver, undefined);
});

test("createBridgeQuestionTimingInterpretationResolverFromEnv returns undefined when disabled", () => {
  const resolver = createBridgeQuestionTimingInterpretationResolverFromEnv({
    BRAIN_LOCAL_INTENT_MODEL_ENABLED: "false"
  });

  assert.equal(resolver, undefined);
});

test("createAutonomyBoundaryInterpretationResolverFromEnv returns undefined when disabled", () => {
  const resolver = createAutonomyBoundaryInterpretationResolverFromEnv({
    BRAIN_LOCAL_INTENT_MODEL_ENABLED: "false"
  });

  assert.equal(resolver, undefined);
});

test("createStatusRecallBoundaryInterpretationResolverFromEnv returns undefined when disabled", () => {
  const resolver = createStatusRecallBoundaryInterpretationResolverFromEnv({
    BRAIN_LOCAL_INTENT_MODEL_ENABLED: "false"
  });

  assert.equal(resolver, undefined);
});

test("createOllamaStatusRecallBoundaryInterpretationResolver parses a valid payload via the shared runtime surface", async () => {
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
              focus: "change_summary",
              confidence: "medium",
              explanation: "The user is asking for a recap of changes, not a new action."
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
    userInput: "What did you change on that page?",
    routingClassification: null,
    deterministicPreference: "status_or_recall"
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    kind: "status_or_recall",
    focus: "change_summary",
    confidence: "medium",
    explanation: "The user is asking for a recap of changes, not a new action."
  });
  const requestPayload = JSON.parse(capturedBody) as { prompt?: string };
  assert.match(requestPayload.prompt ?? "", /Task: status_recall_boundary_interpretation\./);
});

test("createOllamaProposalReplyInterpretationResolver fails closed when transport throws", async () => {
  const resolver = createOllamaProposalReplyInterpretationResolver(
    {
      baseUrl: "http://127.0.0.1:11434",
      model: "phi4-mini:latest",
      timeoutMs: 1000
    },
    {
      fetchImpl: async () => {
        throw new Error("offline");
      }
    }
  );

  const signal = await resolver({
    userInput: "Looks fine to me.",
    routingClassification: null,
    activeProposalPreview: "Draft: make the schedule weekly."
  });

  assert.equal(signal, null);
});

test("createOllamaEntityTypeInterpretationResolver parses a valid payload via the shared runtime surface", async () => {
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
                  candidateName: "Google",
                  entityType: "org"
                }
              ],
              confidence: "medium",
              explanation: "The turn describes Google as the organization involved in the meeting."
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
    userInput: "The meeting with Google is tomorrow.",
    routingClassification: null,
    candidateEntities: [
      {
        candidateName: "Google",
        deterministicEntityType: "thing",
        domainHint: "workflow"
      },
      {
        candidateName: "Meeting",
        deterministicEntityType: "thing",
        domainHint: "workflow"
      }
    ]
  });

  assert.deepEqual(signal, {
    source: "local_intent_model",
    kind: "typed_candidates",
    typedCandidates: [
      {
        candidateName: "Google",
        entityType: "org"
      }
    ],
    confidence: "medium",
    explanation: "The turn describes Google as the organization involved in the meeting."
  });
  const requestPayload = JSON.parse(capturedBody) as { prompt?: string };
  assert.match(requestPayload.prompt ?? "", /Task: entity_type_interpretation\./);
});
