/**
 * @fileoverview Covers canonical intent-mode resolution for the human-centric execution front door.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveConversationIntentMode } from "../../src/interfaces/conversationRuntime/intentModeResolution";

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

test("resolveConversationIntentMode keeps explicit conversational interludes off the work path even when the preview should stay open", async () => {
  const resolution = await resolveConversationIntentMode(
    "Before changing anything, just talk with me for a minute about what makes AI Drone City feel playful. Reply in two short paragraphs and keep the page open."
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

test("resolveConversationIntentMode returns a persisted clarification candidate for ambiguous build requests", async () => {
  const resolution = await resolveConversationIntentMode(
    "Please create me that landing page we talked about yesterday with a hero and a strong call to action."
  );

  assert.equal(resolution.mode, "unclear");
  assert.equal(resolution.confidence, "medium");
  assert.ok(resolution.clarification);
  assert.equal(resolution.clarification?.kind, "execution_mode");
  assert.deepEqual(
    resolution.clarification?.options.map((option) => option.id),
    ["plan", "build"]
  );
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

test("resolveConversationIntentMode can promote a weak deterministic match through the optional local intent model", async () => {
  const resolution = await resolveConversationIntentMode(
    "Could you own this for me and keep it open for me later tonight?",
    null,
    async () => ({
      source: "local_intent_model",
      mode: "autonomous",
      confidence: "high",
      matchedRuleId: "local_intent_model_autonomous_request",
      explanation: "The local intent model recognized a clear autonomous execution request.",
      clarification: null
    })
  );

  assert.equal(resolution.mode, "autonomous");
  assert.equal(resolution.confidence, "high");
  assert.equal(resolution.matchedRuleId, "local_intent_model_autonomous_request");
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

test("resolveConversationIntentMode lets the local intent model break ties for natural build wording", async () => {
  const resolution = await resolveConversationIntentMode(
    "Hey can you build me a simple tech landing page and leave it open for me to view?",
    null,
    async () => ({
      source: "local_intent_model",
      mode: "build",
      confidence: "medium",
      matchedRuleId: "local_intent_model_build_now",
      explanation: "The local intent model recognized a natural request to build now without a long autonomous loop.",
      clarification: null
    })
  );

  assert.equal(resolution.mode, "build");
  assert.equal(resolution.confidence, "medium");
  assert.equal(resolution.matchedRuleId, "local_intent_model_build_now");
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
