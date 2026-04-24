/**
 * @fileoverview Covers canonical intent-mode resolution for the human-centric execution front door.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyRoutingIntentV1 } from "../../src/interfaces/routingMap";
import type { LocalIntentModelSessionHints } from "../../src/organs/languageUnderstanding/localIntentModelContracts";
import { resolveConversationIntentMode } from "../../src/interfaces/conversationRuntime/intentModeResolution";

function buildSessionHints(
  overrides: Partial<LocalIntentModelSessionHints> = {}
): LocalIntentModelSessionHints {
  return {
    hasActiveWorkspace: false,
    hasReturnHandoff: false,
    returnHandoffStatus: null,
    returnHandoffPreviewAvailable: false,
    returnHandoffPrimaryArtifactAvailable: false,
    returnHandoffChangedPathCount: 0,
    returnHandoffNextSuggestedStepAvailable: false,
    modeContinuity: null,
    domainDominantLane: "unknown",
    domainContinuityActive: false,
    workflowContinuityActive: false,
    ...overrides
  };
}

test("resolveConversationIntentMode detects natural capability discovery requests", async () => {
  const resolution = await resolveConversationIntentMode(
    "What reusable tools do you already have for fixing planner failures like this?"
  );

  assert.equal(resolution.mode, "discover_available_capabilities");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.clarification, null);
});

test("resolveConversationIntentMode treats what-can-you-help-me-with prompts as capability discovery", async () => {
  const resolution = await resolveConversationIntentMode(
    "What can you help me with?"
  );

  assert.equal(resolution.mode, "discover_available_capabilities");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.clarification, null);
});

test("resolveConversationIntentMode treats natural capability-limit questions as capability discovery intent", async () => {
  const resolution = await resolveConversationIntentMode(
    "Why can't you do that here right now?"
  );

  assert.equal(resolution.mode, "discover_available_capabilities");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.clarification, null);
});

test("resolveConversationIntentMode detects natural status and artifact recall requests", async () => {
  const resolution = await resolveConversationIntentMode(
    "What are you doing right now and where did you put that landing page?"
  );

  assert.equal(resolution.mode, "status_or_recall");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.clarification, null);
});

test("resolveConversationIntentMode keeps explicit status wording authoritative during workflow continuity", async () => {
  const resolution = await resolveConversationIntentMode(
    "What's the status on the deploy and what did you leave open for me?",
    null,
    undefined,
    buildSessionHints({
      hasActiveWorkspace: true,
      modeContinuity: "build",
      domainDominantLane: "workflow",
      domainContinuityActive: true,
      workflowContinuityActive: true
    })
  );

  assert.equal(resolution.mode, "status_or_recall");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.clarification, null);
  assert.equal(resolution.matchedRuleId, "intent_mode_status_or_recall");
});

test("resolveConversationIntentMode keeps status-shaped relationship recall on the chat path during workflow continuity", async () => {
  const resolution = await resolveConversationIntentMode(
    "What's the status with Billy?",
    null,
    undefined,
    buildSessionHints({
      hasActiveWorkspace: true,
      modeContinuity: "build",
      domainDominantLane: "workflow",
      domainContinuityActive: true,
      workflowContinuityActive: true
    })
  );

  assert.equal(resolution.mode, "chat");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.clarification, null);
  assert.equal(resolution.matchedRuleId, "intent_mode_relationship_recall_chat");
});

test("resolveConversationIntentMode keeps continuity-shaped relationship recall on the chat path during workflow continuity", async () => {
  const resolution = await resolveConversationIntentMode(
    "What's going on with Billy and Beacon?",
    null,
    undefined,
    buildSessionHints({
      hasActiveWorkspace: true,
      modeContinuity: "build",
      domainDominantLane: "workflow",
      domainContinuityActive: true,
      workflowContinuityActive: true
    })
  );

  assert.equal(resolution.mode, "chat");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.clarification, null);
  assert.equal(resolution.matchedRuleId, "intent_mode_relationship_recall_chat");
});

test("resolveConversationIntentMode keeps broader governed relationship recall on the chat path during workflow continuity", async () => {
  const resolution = await resolveConversationIntentMode(
    "What's going on with my direct report Casey?",
    null,
    undefined,
    buildSessionHints({
      hasActiveWorkspace: true,
      modeContinuity: "build",
      domainDominantLane: "workflow",
      domainContinuityActive: true,
      workflowContinuityActive: true
    })
  );

  assert.equal(resolution.mode, "chat");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.clarification, null);
  assert.equal(resolution.matchedRuleId, "intent_mode_relationship_recall_chat");
});

test("resolveConversationIntentMode keeps capability discovery authoritative during workflow continuity", async () => {
  const resolution = await resolveConversationIntentMode(
    "What can you help me with from here?",
    null,
    undefined,
    buildSessionHints({
      hasActiveWorkspace: true,
      modeContinuity: "autonomous",
      domainDominantLane: "workflow",
      domainContinuityActive: true,
      workflowContinuityActive: true
    })
  );

  assert.equal(resolution.mode, "discover_available_capabilities");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.clarification, null);
  assert.equal(resolution.matchedRuleId, "intent_mode_capability_discovery");
});

test("resolveConversationIntentMode keeps explicit conversational interludes off the work path even when the preview should stay open", async () => {
  const resolution = await resolveConversationIntentMode(
    "Before changing anything, just talk with me for a minute about what makes AI Drone City feel playful. Reply in two short paragraphs and keep the page open."
  );

  assert.equal(resolution.mode, "chat");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.clarification, null);
  assert.equal(resolution.matchedRuleId, "intent_mode_direct_conversation_only");
});

test("resolveConversationIntentMode keeps direct-chat interludes authoritative during workflow continuity", async () => {
  const resolution = await resolveConversationIntentMode(
    "Before changing anything, just talk with me for a minute about whether this feels calmer.",
    null,
    undefined,
    buildSessionHints({
      hasActiveWorkspace: true,
      modeContinuity: "build",
      domainDominantLane: "workflow",
      domainContinuityActive: true,
      workflowContinuityActive: true
    })
  );

  assert.equal(resolution.mode, "chat");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.clarification, null);
  assert.equal(resolution.matchedRuleId, "intent_mode_direct_conversation_only");
});

test("resolveConversationIntentMode treats what's-the-status wording as status or recall", async () => {
  const resolution = await resolveConversationIntentMode(
    "What's the status?"
  );

  assert.equal(resolution.mode, "status_or_recall");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.clarification, null);
});

test("resolveConversationIntentMode treats change-summary follow-ups as status or recall requests", async () => {
  const resolution = await resolveConversationIntentMode(
    "Okay tell me about your changes so I know what you changed"
  );

  assert.equal(resolution.mode, "status_or_recall");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.clarification, null);
});

test("resolveConversationIntentMode treats review-ready handoff prompts as status or recall requests", async () => {
  const resolution = await resolveConversationIntentMode(
    "Show me what is ready to review."
  );

  assert.equal(resolution.mode, "status_or_recall");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.clarification, null);
});

test("resolveConversationIntentMode treats guided review and while-away completion prompts as status or recall requests", async () => {
  const guidedReviewResolution = await resolveConversationIntentMode(
    "What should I look at first?"
  );
  const whileGoneResolution = await resolveConversationIntentMode(
    "What did you finish while I was gone?"
  );

  assert.equal(guidedReviewResolution.mode, "status_or_recall");
  assert.equal(guidedReviewResolution.confidence, "high");
  assert.equal(guidedReviewResolution.clarification, null);
  assert.equal(whileGoneResolution.mode, "status_or_recall");
  assert.equal(whileGoneResolution.confidence, "high");
  assert.equal(whileGoneResolution.clarification, null);
});

test("resolveConversationIntentMode keeps explicit contextual status follow-ups off the work path without the generic local model", async () => {
  let localResolverCalled = false;

  const resolution = await resolveConversationIntentMode(
    "Update me later on the Sarah draft.",
    null,
    async () => {
      localResolverCalled = true;
      return {
        source: "local_intent_model",
        mode: "build",
        confidence: "high",
        matchedRuleId: "local_intent_model_incorrect_build",
        explanation: "The generic local model should not be needed for explicit contextual status follow-ups.",
        clarification: null
      };
    },
    buildSessionHints({
      domainDominantLane: "workflow",
      workflowContinuityActive: true
    })
  );

  assert.equal(localResolverCalled, false);
  assert.equal(resolution.mode, "status_or_recall");
  assert.equal(resolution.matchedRuleId, "intent_mode_contextual_followup_status_lexical");
});

test("resolveConversationIntentMode keeps explicit reminder follow-ups on the chat path without invoking the generic local model", async () => {
  let localResolverCalled = false;

  const resolution = await resolveConversationIntentMode(
    "Remind me later about the Sarah draft.",
    null,
    async () => {
      localResolverCalled = true;
      return {
        source: "local_intent_model",
        mode: "build",
        confidence: "high",
        matchedRuleId: "local_intent_model_incorrect_reminder_build",
        explanation: "The generic local model should not reinterpret explicit reminder follow-ups as work.",
        clarification: null
      };
    }
  );

  assert.equal(localResolverCalled, false);
  assert.equal(resolution.mode, "chat");
  assert.equal(resolution.matchedRuleId, "intent_mode_contextual_followup_reminder_lexical");
});

test("resolveConversationIntentMode can use the contextual follow-up interpreter for ambiguous later-update wording", async () => {
  let localResolverCalled = false;
  let capturedCandidateTokens: readonly string[] | undefined;

  const resolution = await resolveConversationIntentMode(
    "Keep me posted on the Sarah draft.",
    null,
    async () => {
      localResolverCalled = true;
      return {
        source: "local_intent_model",
        mode: "build",
        confidence: "high",
        matchedRuleId: "local_intent_model_incorrect_contextual_followup_build",
        explanation: "The generic local model should not run when the bounded contextual follow-up interpreter already resolved the turn.",
        clarification: null
      };
    },
    buildSessionHints({
      domainDominantLane: "workflow",
      workflowContinuityActive: true
    }),
    async (request) => {
      capturedCandidateTokens = request.deterministicCandidateTokens;
      return {
        source: "local_intent_model",
        kind: "status_followup",
        candidateTokens: ["sarah", "draft"],
        confidence: "medium",
        explanation: "The user wants a later status update on the Sarah draft thread."
      };
    }
  );

  assert.equal(localResolverCalled, false);
  assert.deepEqual(capturedCandidateTokens, ["sarah", "draft"]);
  assert.equal(resolution.mode, "status_or_recall");
  assert.equal(resolution.matchedRuleId, "intent_mode_contextual_followup_status_followup_model");
});

test("resolveConversationIntentMode fails closed for ambiguous contextual follow-up wording when the dedicated interpreter is unavailable", async () => {
  let localResolverCalled = false;

  const resolution = await resolveConversationIntentMode(
    "Keep me posted on the Sarah draft.",
    null,
    async () => {
      localResolverCalled = true;
      return {
        source: "local_intent_model",
        mode: "build",
        confidence: "high",
        matchedRuleId: "local_intent_model_incorrect_no_model_build",
        explanation: "The generic local model should not run when contextual follow-up interpretation is unavailable.",
        clarification: null
      };
    },
    buildSessionHints({
      domainDominantLane: "workflow",
      workflowContinuityActive: true
    })
  );

  assert.equal(localResolverCalled, false);
  assert.equal(resolution.mode, "chat");
  assert.equal(resolution.matchedRuleId, "intent_mode_default_chat");
});

test("resolveConversationIntentMode keeps first-person status facts off the contextual follow-up path", async () => {
  let contextualResolverCalled = false;
  let localResolverCalled = false;

  const resolution = await resolveConversationIntentMode(
    "my followup.tax filing is pending.",
    null,
    async () => {
      localResolverCalled = true;
      return {
        source: "local_intent_model",
        mode: "build",
        confidence: "high",
        matchedRuleId: "local_intent_model_incorrect_status_fact_build",
        explanation: "Generic local intent should not steal first-person status facts.",
        clarification: null
      };
    },
    buildSessionHints({
      domainDominantLane: "workflow",
      workflowContinuityActive: true
    }),
    async () => {
      contextualResolverCalled = true;
      return {
        source: "local_intent_model",
        kind: "status_followup",
        candidateTokens: ["tax", "filing"],
        confidence: "high",
        explanation: "Incorrect contextual follow-up interpretation for a first-person status fact."
      };
    }
  );

  assert.equal(contextualResolverCalled, false);
  assert.equal(localResolverCalled, false);
  assert.equal(resolution.mode, "chat");
  assert.equal(resolution.matchedRuleId, "intent_mode_default_chat");
});

test("resolveConversationIntentMode returns a persisted build-format clarification candidate for ambiguous exact-destination build requests", async () => {
  const resolution = await resolveConversationIntentMode(
    'Please create me that landing page we talked about yesterday with a hero and a strong call to action in the exact folder "C:\\Users\\testuser\\Desktop\\Solar Energy Landing Page".'
  );

  assert.equal(resolution.mode, "clarify_build_format");
  assert.equal(resolution.confidence, "medium");
  assert.ok(resolution.clarification);
  assert.equal(resolution.clarification?.kind, "build_format");
  assert.deepEqual(
    resolution.clarification?.options.map((option) => option.id),
    ["static_html", "nextjs", "react"]
  );
});

test("resolveConversationIntentMode returns a build-format clarification when the user explicitly signals plain-html-versus-framework ambiguity", async () => {
  const resolution = await resolveConversationIntentMode(
    "Can you create that landing page idea we talked about with a hero and strong call to action? I am still split on whether the first step should be plain HTML or a framework app."
  );

  assert.equal(resolution.mode, "clarify_build_format");
  assert.equal(resolution.confidence, "medium");
  assert.equal(
    resolution.clarification?.question,
    "Would you like that built as plain HTML, or as a framework app like Next.js or React?"
  );
});

test("resolveConversationIntentMode keeps plan-or-build clarification authoritative instead of letting the generic local model auto-build", async () => {
  const resolution = await resolveConversationIntentMode(
    "BigBrain I recorded a short clip so you can see what the UI is doing. The wrong panel slides in right after the menu opens and the dashboard feels off. Please build the dashboard change using this clip.",
    null,
    async () => ({
      source: "local_intent_model",
      mode: "build",
      confidence: "high",
      matchedRuleId: "local_intent_model_incorrect_video_build",
      explanation: "The generic local intent model should not silently consume an explicit plan-or-build ambiguity.",
      clarification: null
    })
  );

  assert.equal(resolution.mode, "unclear");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.matchedRuleId, "execution_intent_build_generic");
  assert.equal(resolution.clarification?.kind, "execution_mode");
});

test("resolveConversationIntentMode keeps long narrative memory updates off the build clarification path", async () => {
  const resolution = await resolveConversationIntentMode(
    [
      "Billy moved from Sample Web Studio to Crimson in February, and the Harbor project timeline shifted a week after that.",
      "Garrett is still handling the website handoff, and I am going to add corrections and date changes after we talk through it.",
      "",
      "Mara is flying in on April 20, Billy said the old office keys are still in the blue folder, and the review call is supposed to happen before the March invoices get closed."
    ].join("\n\n")
  );

  assert.equal(resolution.mode, "chat");
  assert.equal(resolution.clarification, null);
  assert.equal(resolution.matchedRuleId, "intent_mode_default_chat");
});

test("resolveConversationIntentMode promotes strong end-to-end wording into autonomous mode", async () => {
  const resolution = await resolveConversationIntentMode(
    "Hey, build me a tech landing page for air drones, go until you finish, put it on my desktop, and leave it open for me when you're done."
  );

  assert.equal(resolution.mode, "autonomous");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.clarification, null);
  assert.equal(resolution.matchedRuleId, "intent_mode_autonomous_execution");
});

test("resolveConversationIntentMode keeps ambiguous end-to-end wording off autonomous mode in a profile session without workflow continuity", async () => {
  const resolution = await resolveConversationIntentMode(
    "Could you take care of this end to end and remember that I prefer dark mode?",
    null,
    undefined,
    buildSessionHints({
      domainDominantLane: "profile",
      domainContinuityActive: true
    })
  );

  assert.equal(resolution.mode, "chat");
  assert.equal(resolution.confidence, "low");
  assert.equal(resolution.clarification, null);
  assert.equal(resolution.matchedRuleId, "intent_mode_default_chat");
});

test("resolveConversationIntentMode still promotes ambiguous end-to-end wording when workflow continuity is active", async () => {
  const resolution = await resolveConversationIntentMode(
    "Take care of it end to end and leave the preview open for me.",
    null,
    undefined,
    buildSessionHints({
      hasActiveWorkspace: true,
      modeContinuity: "build",
      domainDominantLane: "profile",
      domainContinuityActive: true,
      workflowContinuityActive: true
    })
  );

  assert.equal(resolution.mode, "autonomous");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.clarification, null);
  assert.equal(resolution.matchedRuleId, "intent_mode_autonomous_execution");
});

test("resolveConversationIntentMode can use the autonomy-boundary interpreter for ambiguous end-to-end wording in a non-workflow session", async () => {
  let capturedSignalStrength: string | null | undefined;

  const resolution = await resolveConversationIntentMode(
    "Could you take care of this end to end and leave the page polished?",
    null,
    undefined,
    buildSessionHints({
      domainDominantLane: "profile",
      domainContinuityActive: true
    }),
    undefined,
    async (request) => {
      capturedSignalStrength = request.deterministicSignalStrength;
      return {
        source: "local_intent_model",
        kind: "promote_to_autonomous",
        confidence: "medium",
        explanation: "The user is delegating end-to-end ownership for the current artifact."
      };
    }
  );

  assert.equal(capturedSignalStrength, "ambiguous");
  assert.equal(resolution.mode, "autonomous");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.matchedRuleId, "intent_mode_autonomy_boundary_model_autonomous");
  assert.equal(resolution.clarification, null);
});

test("resolveConversationIntentMode keeps strong deterministic autonomy promotion ahead of the autonomy-boundary interpreter", async () => {
  let autonomyBoundaryResolverCalled = false;

  const resolution = await resolveConversationIntentMode(
    "Finish the whole thing and keep going until it's done.",
    null,
    undefined,
    buildSessionHints({
      domainDominantLane: "profile",
      domainContinuityActive: true
    }),
    undefined,
    async () => {
      autonomyBoundaryResolverCalled = true;
      return {
        source: "local_intent_model",
        kind: "keep_as_chat",
        confidence: "high",
        explanation: "This should never run for strong deterministic autonomy prompts."
      };
    }
  );

  assert.equal(autonomyBoundaryResolverCalled, false);
  assert.equal(resolution.mode, "autonomous");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.matchedRuleId, "intent_mode_autonomous_execution");
});

test("resolveConversationIntentMode fails closed for ambiguous autonomy wording when the dedicated interpreter is unavailable", async () => {
  let localResolverCalled = false;

  const resolution = await resolveConversationIntentMode(
    "Could you take care of this end to end and remember that I prefer dark mode?",
    null,
    async () => {
      localResolverCalled = true;
      return {
        source: "local_intent_model",
        mode: "autonomous",
        confidence: "high",
        matchedRuleId: "local_intent_model_incorrect_autonomous_fallback",
        explanation: "The generic local intent model should stay suppressed for ambiguous autonomy leftovers.",
        clarification: null
      };
    },
    buildSessionHints({
      domainDominantLane: "profile",
      domainContinuityActive: true
    })
  );

  assert.equal(localResolverCalled, false);
  assert.equal(resolution.mode, "chat");
  assert.equal(resolution.confidence, "low");
  assert.equal(resolution.matchedRuleId, "intent_mode_default_chat");
});

test("resolveConversationIntentMode can use the status-recall-boundary interpreter to keep ambiguous mixed wording on the build path", async () => {
  let localResolverCalled = false;
  let capturedDeterministicPreference: string | null | undefined;

  const resolution = await resolveConversationIntentMode(
    "Please update the hero section and tell me what you changed.",
    null,
    async () => {
      localResolverCalled = true;
      return {
        source: "local_intent_model",
        mode: "status_or_recall",
        confidence: "high",
        matchedRuleId: "local_intent_model_should_not_run_for_status_recall_boundary_build",
        explanation: "The generic local model should stay suppressed when the dedicated boundary interpreter resolves the overlap.",
        clarification: null
      };
    },
    buildSessionHints({
      hasActiveWorkspace: true,
      modeContinuity: "build",
      domainDominantLane: "workflow",
      domainContinuityActive: true,
      workflowContinuityActive: true
    }),
    undefined,
    undefined,
    async (request) => {
      capturedDeterministicPreference = request.deterministicPreference;
      return {
        source: "local_intent_model",
        kind: "execute_now",
        focus: null,
        confidence: "medium",
        explanation: "The user is asking for fresh execution, not a status recap."
      };
    }
  );

  assert.equal(localResolverCalled, false);
  assert.equal(capturedDeterministicPreference, "status_or_recall");
  assert.equal(resolution.mode, "build");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.matchedRuleId, "intent_mode_status_recall_boundary_model_build");
  assert.equal(resolution.clarification, null);
});

test("resolveConversationIntentMode can use the status-recall-boundary interpreter to preserve status recall with a focused semantic hint", async () => {
  let localResolverCalled = false;

  const resolution = await resolveConversationIntentMode(
    "Please update the hero section and where did you put it?",
    null,
    async () => {
      localResolverCalled = true;
      return {
        source: "local_intent_model",
        mode: "build",
        confidence: "high",
        matchedRuleId: "local_intent_model_should_not_run_for_status_recall_boundary_status",
        explanation: "The generic local model should stay suppressed when the dedicated boundary interpreter keeps the turn on status recall.",
        clarification: null
      };
    },
    buildSessionHints({
      hasActiveWorkspace: true,
      modeContinuity: "build",
      domainDominantLane: "workflow",
      domainContinuityActive: true,
      workflowContinuityActive: true
    }),
    undefined,
    undefined,
    async () => ({
      source: "local_intent_model",
      kind: "status_or_recall",
      focus: "location",
      confidence: "medium",
      explanation: "The user is asking where the tracked artifact lives before deciding on more changes."
    })
  );

  assert.equal(localResolverCalled, false);
  assert.equal(resolution.mode, "status_or_recall");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.matchedRuleId, "intent_mode_status_recall_boundary_model_status");
  assert.equal(resolution.semanticHint, "status_location");
  assert.equal(resolution.clarification, null);
});

test("resolveConversationIntentMode keeps explicit status wording ahead of the status-recall-boundary interpreter when there is no execute-now overlap", async () => {
  let statusRecallBoundaryResolverCalled = false;

  const resolution = await resolveConversationIntentMode(
    "Tell me what you changed.",
    null,
    undefined,
    buildSessionHints({
      hasActiveWorkspace: true,
      modeContinuity: "build",
      domainDominantLane: "workflow",
      domainContinuityActive: true,
      workflowContinuityActive: true
    }),
    undefined,
    undefined,
    async () => {
      statusRecallBoundaryResolverCalled = true;
      return {
        source: "local_intent_model",
        kind: "execute_now",
        focus: null,
        confidence: "high",
        explanation: "This should never run for explicit pure status wording."
      };
    }
  );

  assert.equal(statusRecallBoundaryResolverCalled, false);
  assert.equal(resolution.mode, "status_or_recall");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.matchedRuleId, "intent_mode_status_or_recall");
  assert.equal(resolution.clarification, null);
});

test("resolveConversationIntentMode fails closed for ambiguous status/build overlap when the dedicated boundary interpreter is unavailable", async () => {
  let localResolverCalled = false;

  const resolution = await resolveConversationIntentMode(
    "Please update the hero section and tell me what you changed.",
    null,
    async () => {
      localResolverCalled = true;
      return {
        source: "local_intent_model",
        mode: "build",
        confidence: "high",
        matchedRuleId: "local_intent_model_incorrect_status_recall_overlap_build",
        explanation: "The generic local intent model should stay suppressed for ambiguous status/build overlap.",
        clarification: null
      };
    },
    buildSessionHints({
      hasActiveWorkspace: true,
      modeContinuity: "build",
      domainDominantLane: "workflow",
      domainContinuityActive: true,
      workflowContinuityActive: true
    })
  );

  assert.equal(localResolverCalled, false);
  assert.equal(resolution.mode, "status_or_recall");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.matchedRuleId, "intent_mode_status_or_recall");
  assert.equal(resolution.clarification, null);
});

test("resolveConversationIntentMode can promote a weak deterministic match through the optional local intent model", async () => {
  let capturedDomainLane: string | undefined;

  const resolution = await resolveConversationIntentMode(
    "Could you own this for me and keep it open for me later tonight?",
    null,
    async (request) => {
      capturedDomainLane = request.sessionHints?.domainDominantLane;
      return {
        source: "local_intent_model",
        mode: "autonomous",
        confidence: "high",
        matchedRuleId: "local_intent_model_autonomous_request",
        explanation: "The local intent model recognized a clear autonomous execution request.",
        clarification: null
      };
    },
    buildSessionHints({
      domainDominantLane: "workflow",
      domainContinuityActive: true,
      workflowContinuityActive: true
    })
  );

  assert.equal(capturedDomainLane, "workflow");
  assert.equal(resolution.mode, "autonomous");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.matchedRuleId, "local_intent_model_autonomous_request");
});

test("resolveConversationIntentMode keeps ambiguous self-identity declarations off the work path even when workflow continuity is active", async () => {
  let localResolverCalled = false;

  const resolution = await resolveConversationIntentMode(
    "I already told you my name is Avery several times.",
    null,
    async () => {
      localResolverCalled = true;
      return {
        source: "local_intent_model",
        mode: "build",
        confidence: "high",
        matchedRuleId: "local_intent_model_incorrect_build",
        explanation: "The local intent model incorrectly treated the turn as executable work.",
        clarification: null
      };
    },
    buildSessionHints({
      hasActiveWorkspace: true,
      modeContinuity: "build",
      domainDominantLane: "workflow",
      domainContinuityActive: true,
      workflowContinuityActive: true,
      recentIdentityConversationActive: true
    })
  );

  assert.equal(localResolverCalled, false);
  assert.equal(resolution.mode, "chat");
  assert.equal(resolution.confidence, "low");
  assert.equal(resolution.matchedRuleId, "intent_mode_default_chat");
});

test("resolveConversationIntentMode keeps short identity follow-ups off the work path even when the last assistant turn was a question", async () => {
  let localResolverCalled = false;

  const resolution = await resolveConversationIntentMode(
    "No",
    null,
    async () => {
      localResolverCalled = true;
      return {
        source: "local_intent_model",
        mode: "build",
        confidence: "high",
        matchedRuleId: "local_intent_model_incorrect_follow_up_build",
        explanation: "The local intent model incorrectly treated the short identity follow-up as work.",
        clarification: null
      };
    },
    buildSessionHints({
      hasActiveWorkspace: true,
      hasRecentAssistantQuestion: true,
      hasRecentAssistantIdentityPrompt: true,
      recentIdentityConversationActive: true,
      modeContinuity: "build",
      domainDominantLane: "workflow",
      domainContinuityActive: true,
      workflowContinuityActive: true
    })
  );

  assert.equal(localResolverCalled, false);
  assert.equal(resolution.mode, "chat");
  assert.equal(resolution.confidence, "low");
  assert.equal(resolution.matchedRuleId, "intent_mode_default_chat");
});

test("resolveConversationIntentMode keeps vague conversational follow-ups on the answer thread when the latest assistant turn was informational", async () => {
  let localResolverCalled = false;

  const resolution = await resolveConversationIntentMode(
    "Okay, what else?",
    null,
    async () => {
      localResolverCalled = true;
      return {
        source: "local_intent_model",
        mode: "build",
        confidence: "high",
        matchedRuleId: "local_intent_model_incorrect_answer_thread_build",
        explanation: "The local intent model should not steal vague answer-thread follow-ups into work.",
        clarification: null
      };
    },
    buildSessionHints({
      hasActiveWorkspace: true,
      hasReturnHandoff: true,
      modeContinuity: "build",
      domainDominantLane: "workflow",
      domainContinuityActive: true,
      workflowContinuityActive: true,
      recentAssistantTurnKind: "informational_answer",
      recentAssistantAnswerThreadActive: true
    })
  );

  assert.equal(localResolverCalled, false);
  assert.equal(resolution.mode, "chat");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.matchedRuleId, "intent_mode_recent_answer_thread_chat");
});

test("resolveConversationIntentMode does not let the local intent model downgrade explicit autonomous wording", async () => {
  const resolution = await resolveConversationIntentMode(
    "Hey, build me a tech landing page for air drones, go until you finish, put it on my desktop, and leave it open for me when you're done.",
    null,
    async () => ({
      source: "local_intent_model",
      mode: "build",
      confidence: "high",
      matchedRuleId: "local_intent_model_build_conflict",
      explanation: "The local model incorrectly preferred a normal build run.",
      clarification: null
    })
  );

  assert.equal(resolution.mode, "autonomous");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.matchedRuleId, "intent_mode_autonomous_execution");
});

test("resolveConversationIntentMode asks for build format instead of guessing on ambiguous exact-destination landing-page wording", async () => {
  let localResolverCalled = false;

  const resolution = await resolveConversationIntentMode(
    'Okay, build me a simple landing page end to end for a solar company. Put it in the exact folder "C:\\Users\\testuser\\Desktop\\Solar Energy Landing Page" on my Desktop and do not open it yet.',
    null,
    async () => {
      localResolverCalled = true;
      return {
        source: "local_intent_model",
        mode: "framework_app_build",
        confidence: "high",
        matchedRuleId: "local_intent_model_should_not_guess_build_format",
        explanation: "The generic local model should not silently pick a build format when the request stays materially ambiguous.",
        clarification: null
      };
    }
  );

  assert.equal(localResolverCalled, false);
  assert.equal(resolution.mode, "clarify_build_format");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.matchedRuleId, "intent_mode_build_format_clarify_execution_style");
  assert.equal(resolution.clarification?.kind, "build_format");
  assert.deepEqual(
    resolution.clarification?.options.map((option) => option.id),
    ["static_html", "nextjs", "react"]
  );
});

test("resolveConversationIntentMode sends explicit single-file HTML scaffold requests to the static HTML lane", async () => {
  let localResolverCalled = false;
  const userInput =
    'Create another lightweight single-file HTML landing page in the exact folder "C:\\Users\\testuser\\Desktop\\River Glass" on my Desktop. ' +
    "Call this one River Glass. Keep it as a static single-page site with an index.html entry file in that exact folder. " +
    "Do not start a local preview server for this scenario. Open that exact local index.html file directly in the browser with an absolute file:// URL and leave it open when you are done.";

  const resolution = await resolveConversationIntentMode(
    userInput,
    classifyRoutingIntentV1(userInput),
    async () => {
      localResolverCalled = true;
      return {
        source: "local_intent_model",
        mode: "plan",
        confidence: "high",
        matchedRuleId: "local_intent_model_incorrect_plan",
        explanation: "The local intent model should not downgrade an explicit scaffold execution request into plan mode.",
        clarification: null
      };
    },
    buildSessionHints({
      hasActiveWorkspace: true,
      hasReturnHandoff: true,
      modeContinuity: "build",
      domainDominantLane: "workflow",
      domainContinuityActive: true,
      workflowContinuityActive: true
    })
  );

  assert.equal(localResolverCalled, false);
  assert.equal(resolution.mode, "static_html_build");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.matchedRuleId, "intent_mode_static_html_build");
  assert.equal(resolution.clarification, null);
});

test("resolveConversationIntentMode sends explicit Next.js build requests to the framework app lane", async () => {
  const resolution = await resolveConversationIntentMode(
    "Build me a Next.js landing page for a solar company and put it on my desktop."
  );

  assert.equal(resolution.mode, "framework_app_build");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.matchedRuleId, "intent_mode_framework_app_build");
  assert.equal(resolution.clarification, null);
});

test("resolveConversationIntentMode treats polite edit imperatives as execute-now work", async () => {
  const resolution = await resolveConversationIntentMode(
    "Please change the hero section so the headline says calmer drone operations start here."
  );

  assert.equal(resolution.mode, "build");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.clarification, null);
});

test("resolveConversationIntentMode treats natural desktop cleanup imperatives as execute-now work", async () => {
  const resolution = await resolveConversationIntentMode(
    "Can you clean up the drone-company folders on my desktop and put them into drone-folder for me?"
  );

  assert.equal(resolution.mode, "build");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.clarification, null);
});

test("resolveConversationIntentMode keeps the Telegram live-smoke edit wording on the build path", async () => {
  const resolution = await resolveConversationIntentMode(
    "That helps. Please change the hero section so the headline literally says 'Calmer drone operations start here', and add a short trust bar that literally says 'Trusted by local teams'. Leave the updated page in the same place when you're done."
  );

  assert.equal(resolution.mode, "build");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.clarification, null);
});

test("resolveConversationIntentMode keeps natural browser-open follow-ups on the build path during tracked workflow continuity", async () => {
  const resolution = await resolveConversationIntentMode(
    "Alright, open that Downtown Detroit Drones landing page in my browser and leave it up for me. Use the same tracked localhost run that is already live on port 57860.",
    null,
    undefined,
    buildSessionHints({
      hasActiveWorkspace: true,
      hasReturnHandoff: true,
      returnHandoffStatus: "completed",
      returnHandoffPreviewAvailable: true,
      returnHandoffPrimaryArtifactAvailable: true,
      returnHandoffChangedPathCount: 4,
      modeContinuity: "build",
      domainDominantLane: "workflow",
      domainContinuityActive: true,
      workflowContinuityActive: true
    })
  );

  assert.equal(resolution.mode, "build");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.clarification, null);
  assert.equal(resolution.matchedRuleId, "intent_mode_execute_now");
});

test("resolveConversationIntentMode keeps the Telegram live-smoke cleanup wording on the build path", async () => {
  const resolution = await resolveConversationIntentMode(
    "One last real-world thing: please go ahead and clean up my desktop now by moving every folder there that starts with drone-company into drone-folder. I do mean all of them, so you do not need to ask again before doing it."
  );

  assert.equal(resolution.mode, "build");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.clarification, null);
});

test("resolveConversationIntentMode lets the local intent model classify nuanced return-handoff review wording with session hints", async () => {
  let capturedHasReturnHandoff = false;

  const resolution = await resolveConversationIntentMode(
    "When I get back later, what should I inspect first from the draft you left me?",
    null,
    async (request) => {
      capturedHasReturnHandoff = request.sessionHints?.hasReturnHandoff === true;
      return {
        source: "local_intent_model",
        mode: "status_or_recall",
        confidence: "medium",
        matchedRuleId: "local_intent_model_guided_review_handoff",
        explanation: "The local intent model recognized a guided review request for the saved draft.",
        clarification: null,
        semanticHint: "guided_review"
      };
    },
    {
      hasReturnHandoff: true,
      returnHandoffStatus: "waiting_for_user",
      returnHandoffPreviewAvailable: true,
      returnHandoffPrimaryArtifactAvailable: true,
      returnHandoffChangedPathCount: 2,
      returnHandoffNextSuggestedStepAvailable: true,
      modeContinuity: "build"
    }
  );

  assert.equal(capturedHasReturnHandoff, true);
  assert.equal(resolution.mode, "status_or_recall");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.matchedRuleId, "local_intent_model_guided_review_handoff");
  assert.equal(resolution.semanticHint, "guided_review");
});

test("resolveConversationIntentMode lets the local intent model classify softer review-ready wording with session hints", async () => {
  const resolution = await resolveConversationIntentMode(
    "What else is ready from that draft?",
    null,
    async () => ({
      source: "local_intent_model",
      mode: "status_or_recall",
      confidence: "medium",
      matchedRuleId: "local_intent_model_more_review_ready",
      explanation: "The local intent model recognized a softer review-ready question about the saved draft.",
      clarification: null,
      semanticHint: "review_ready"
    }),
    {
      hasReturnHandoff: true,
      returnHandoffStatus: "completed",
      returnHandoffPreviewAvailable: true,
      returnHandoffPrimaryArtifactAvailable: true,
      returnHandoffChangedPathCount: 3,
      returnHandoffNextSuggestedStepAvailable: true,
      modeContinuity: "build"
    }
  );

  assert.equal(resolution.mode, "status_or_recall");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.matchedRuleId, "local_intent_model_more_review_ready");
  assert.equal(resolution.semanticHint, "review_ready");
});

test("resolveConversationIntentMode lets the local intent model classify softer anything-else-to-review wording with session hints", async () => {
  const resolution = await resolveConversationIntentMode(
    "Is there anything else in that draft I should look over?",
    null,
    async () => ({
      source: "local_intent_model",
      mode: "status_or_recall",
      confidence: "medium",
      matchedRuleId: "local_intent_model_review_ready_more_to_see_handoff",
      explanation: "The local intent model recognized a softer anything-else-to-review question about the saved draft.",
      clarification: null,
      semanticHint: "review_ready"
    }),
    {
      hasReturnHandoff: true,
      returnHandoffStatus: "completed",
      returnHandoffPreviewAvailable: true,
      returnHandoffPrimaryArtifactAvailable: true,
      returnHandoffChangedPathCount: 3,
      returnHandoffNextSuggestedStepAvailable: true,
      modeContinuity: "build"
    }
  );

  assert.equal(resolution.mode, "status_or_recall");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.matchedRuleId, "local_intent_model_review_ready_more_to_see_handoff");
  assert.equal(resolution.semanticHint, "review_ready");
});

test("resolveConversationIntentMode lets the local intent model classify nuanced next-review wording with session hints", async () => {
  const resolution = await resolveConversationIntentMode(
    "What should I review next from that draft?",
    null,
    async () => ({
      source: "local_intent_model",
      mode: "status_or_recall",
      confidence: "medium",
      matchedRuleId: "local_intent_model_next_review_step_handoff",
      explanation: "The local intent model recognized a next-review-step request for the saved draft.",
      clarification: null,
      semanticHint: "next_review_step"
    }),
    {
      hasReturnHandoff: true,
      returnHandoffStatus: "waiting_for_user",
      returnHandoffPreviewAvailable: true,
      returnHandoffPrimaryArtifactAvailable: true,
      returnHandoffChangedPathCount: 2,
      returnHandoffNextSuggestedStepAvailable: true,
      modeContinuity: "build"
    }
  );

  assert.equal(resolution.mode, "status_or_recall");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.matchedRuleId, "local_intent_model_next_review_step_handoff");
  assert.equal(resolution.semanticHint, "next_review_step");
});

test("resolveConversationIntentMode lets the local intent model classify after-that review wording with session hints", async () => {
  const resolution = await resolveConversationIntentMode(
    "What should I look at after that?",
    null,
    async () => ({
      source: "local_intent_model",
      mode: "status_or_recall",
      confidence: "medium",
      matchedRuleId: "local_intent_model_after_that_review_step",
      explanation: "The local intent model recognized a follow-on review-step request for the saved draft.",
      clarification: null,
      semanticHint: "next_review_step"
    }),
    {
      hasReturnHandoff: true,
      returnHandoffStatus: "waiting_for_user",
      returnHandoffPreviewAvailable: true,
      returnHandoffPrimaryArtifactAvailable: true,
      returnHandoffChangedPathCount: 2,
      returnHandoffNextSuggestedStepAvailable: true,
      modeContinuity: "build"
    }
  );

  assert.equal(resolution.mode, "status_or_recall");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.matchedRuleId, "local_intent_model_after_that_review_step");
  assert.equal(resolution.semanticHint, "next_review_step");
});

test("resolveConversationIntentMode lets the local intent model classify wrap-up summary wording with session hints", async () => {
  const resolution = await resolveConversationIntentMode(
    "What did you wrap up for me on that draft?",
    null,
    async () => ({
      source: "local_intent_model",
      mode: "status_or_recall",
      confidence: "medium",
      matchedRuleId: "local_intent_model_wrap_up_summary_handoff",
      explanation: "The local intent model recognized a wrap-up summary request for the saved draft.",
      clarification: null,
      semanticHint: "wrap_up_summary"
    }),
    {
      hasReturnHandoff: true,
      returnHandoffStatus: "completed",
      returnHandoffPreviewAvailable: true,
      returnHandoffPrimaryArtifactAvailable: true,
      returnHandoffChangedPathCount: 3,
      returnHandoffNextSuggestedStepAvailable: true,
      modeContinuity: "build"
    }
  );

  assert.equal(resolution.mode, "status_or_recall");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.matchedRuleId, "local_intent_model_wrap_up_summary_handoff");
  assert.equal(resolution.semanticHint, "wrap_up_summary");
});

test("resolveConversationIntentMode lets the local intent model classify nuanced return-handoff resume wording with session hints", async () => {
  let capturedModeContinuity: string | null | undefined;

  const resolution = await resolveConversationIntentMode(
    "When you get a chance, keep refining that draft from where you left off.",
    null,
    async (request) => {
      capturedModeContinuity = request.sessionHints?.modeContinuity;
      return {
        source: "local_intent_model",
        mode: "build",
        confidence: "medium",
        matchedRuleId: "local_intent_model_resume_saved_draft",
        explanation: "The local intent model recognized a resume-from-checkpoint request.",
        clarification: null,
        semanticHint: "resume_handoff"
      };
    },
    {
      hasReturnHandoff: true,
      returnHandoffStatus: "waiting_for_user",
      returnHandoffPreviewAvailable: true,
      returnHandoffPrimaryArtifactAvailable: true,
      returnHandoffChangedPathCount: 2,
      returnHandoffNextSuggestedStepAvailable: true,
      modeContinuity: "build"
    }
  );

  assert.equal(capturedModeContinuity, "build");
  assert.equal(resolution.mode, "build");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.matchedRuleId, "local_intent_model_resume_saved_draft");
  assert.equal(resolution.semanticHint, "resume_handoff");
});

test("resolveConversationIntentMode lets the local intent model classify nuanced return-handoff explain wording with session hints", async () => {
  let capturedChangedPathCount: number | undefined;

  const resolution = await resolveConversationIntentMode(
    "Explain what you actually changed in that saved draft.",
    null,
    async (request) => {
      capturedChangedPathCount = request.sessionHints?.returnHandoffChangedPathCount;
      return {
        source: "local_intent_model",
        mode: "status_or_recall",
        confidence: "medium",
        matchedRuleId: "local_intent_model_explain_saved_draft_changes",
        explanation: "The local intent model recognized a saved-draft change explanation request.",
        clarification: null,
        semanticHint: "explain_handoff"
      };
    },
    {
      hasReturnHandoff: true,
      returnHandoffStatus: "completed",
      returnHandoffPreviewAvailable: true,
      returnHandoffPrimaryArtifactAvailable: true,
      returnHandoffChangedPathCount: 3,
      returnHandoffNextSuggestedStepAvailable: true,
      modeContinuity: "build"
    }
  );

  assert.equal(capturedChangedPathCount, 3);
  assert.equal(resolution.mode, "status_or_recall");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.matchedRuleId, "local_intent_model_explain_saved_draft_changes");
  assert.equal(resolution.semanticHint, "explain_handoff");
});
