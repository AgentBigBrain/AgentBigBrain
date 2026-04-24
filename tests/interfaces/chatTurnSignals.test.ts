import assert from "node:assert/strict";
import { test } from "node:test";

import {
  analyzeConversationChatTurnSignals,
  assessIdentityInterpretationEligibility,
  buildDeterministicDirectChatFallbackReply,
  isMixedConversationMemoryStatusRecallTurn,
  isRelationshipConversationRecallTurn,
  shouldPreserveDeterministicDirectChatTurn,
  shouldAllowImplicitReturnHandoffStatusFallback
} from "../../src/interfaces/conversationRuntime/chatTurnSignals";

test("analyzeConversationChatTurnSignals treats multilingual short greetings as plain chat with no actionability", () => {
  assert.equal(analyzeConversationChatTurnSignals("Hi").primaryKind, "plain_chat");
  assert.equal(analyzeConversationChatTurnSignals("Hola").primaryKind, "plain_chat");
  assert.equal(analyzeConversationChatTurnSignals("Bonjour").primaryKind, "plain_chat");
  assert.equal(analyzeConversationChatTurnSignals("Bonjour").actionability, "none");
});

test("analyzeConversationChatTurnSignals distinguishes identity recall from workflow recall", () => {
  const identity = analyzeConversationChatTurnSignals("What's my name?");
  assert.equal(identity.primaryKind, "self_identity_query");
  assert.equal(identity.actionability, "none");
  assert.equal(identity.containsStatusCue, false);

  const workflow = analyzeConversationChatTurnSignals("What's the status?");
  assert.equal(workflow.primaryKind, "status_or_recall");
  assert.equal(workflow.actionability, "recall_only");
  assert.equal(workflow.containsStatusCue, true);
});

test("analyzeConversationChatTurnSignals recognizes direct who-am-i wording without folding name meta-questions back into identity recall", () => {
  const directIdentity = analyzeConversationChatTurnSignals("Do you know who I am?");
  assert.equal(directIdentity.primaryKind, "self_identity_query");

  const metaQuestion = analyzeConversationChatTurnSignals(
    "Then why did you say you didn't have my name?"
  );
  assert.equal(metaQuestion.primaryKind, "plain_chat");
});

test("analyzeConversationChatTurnSignals recognizes self-identity declarations as direct chat, not workflow", () => {
  const declaration = analyzeConversationChatTurnSignals("My name is Avery, yes.");
  assert.equal(declaration.primaryKind, "self_identity_statement");
  assert.equal(declaration.actionability, "none");
  assert.equal(shouldPreserveDeterministicDirectChatTurn("My name is Avery, yes."), true);
});

test("assessIdentityInterpretationEligibility keeps ambiguous self-identity declarations on the identity path", () => {
  const signals = analyzeConversationChatTurnSignals(
    "I already told you my name is Avery several times."
  );
  assert.notEqual(signals.primaryKind, "workflow_candidate");
  assert.notEqual(signals.primaryKind, "status_or_recall");

  const eligibility = assessIdentityInterpretationEligibility(
    "I already told you my name is Avery several times."
  );
  assert.equal(eligibility.eligible, true);
  assert.match(
    eligibility.reason ?? "",
    /self_identity_declaration|plausible_self_identity_declaration/
  );
  assert.equal(
    shouldPreserveDeterministicDirectChatTurn(
      "I already told you my name is Avery several times."
    ),
    true
  );
});

test("analyzeConversationChatTurnSignals keeps mixed denial plus identity recall on the identity path", () => {
  const signals = analyzeConversationChatTurnSignals("no what is my name");
  assert.equal(signals.primaryKind, "self_identity_query");
  assert.equal(signals.actionability, "none");
});

test("assessIdentityInterpretationEligibility treats short follow-ups as identity-eligible only with recent identity context", () => {
  const withoutContext = assessIdentityInterpretationEligibility("No");
  assert.equal(withoutContext.eligible, false);

  const withContext = assessIdentityInterpretationEligibility("No", {
    recentIdentityConversationActive: true
  });
  assert.equal(withContext.eligible, true);
  assert.equal(withContext.ambiguous, true);
  assert.equal(withContext.reason, "identity_follow_up");
  assert.equal(
    shouldPreserveDeterministicDirectChatTurn("No", {
      recentIdentityConversationActive: true
    }),
    true
  );
});

test("assessIdentityInterpretationEligibility keeps relationship recall out of the identity follow-up path even with recent identity context", () => {
  const eligibility = assessIdentityInterpretationEligibility("Who is Billy?", {
    recentIdentityConversationActive: true,
    recentAssistantIdentityPrompt: true
  });
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, null);
  assert.equal(
    shouldPreserveDeterministicDirectChatTurn("Who is Billy?", {
      recentIdentityConversationActive: true,
      recentAssistantIdentityPrompt: true
    }),
    true
  );
});

test("assessIdentityInterpretationEligibility keeps short do-you-know relationship recall out of the identity follow-up path after a name exchange", () => {
  const eligibility = assessIdentityInterpretationEligibility("Do you know Billy?", {
    recentIdentityConversationActive: true,
    recentAssistantIdentityPrompt: true
  });
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, null);
  assert.equal(isRelationshipConversationRecallTurn("Do you know Billy?"), true);
  assert.equal(
    shouldPreserveDeterministicDirectChatTurn("Do you know Billy?", {
      recentIdentityConversationActive: true,
      recentAssistantIdentityPrompt: true
    }),
    true
  );
});

test("assessIdentityInterpretationEligibility keeps short objections out of the identity follow-up path after a name exchange", () => {
  const eligibility = assessIdentityInterpretationEligibility("I didn't ask that.", {
    recentIdentityConversationActive: true,
    recentAssistantIdentityPrompt: true
  });
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, null);
});

test("assessIdentityInterpretationEligibility keeps long approval-prefixed relationship updates out of the identity follow-up path", () => {
  const eligibility = assessIdentityInterpretationEligibility(
    "Yeah, so Billy is someone I worked previously. He now works somewhere else.",
    {
      recentIdentityConversationActive: true,
      recentAssistantIdentityPrompt: true
    }
  );
  assert.equal(eligibility.eligible, false);
  assert.equal(eligibility.reason, null);
});

test("assessIdentityInterpretationEligibility keeps obvious workflow turns out of the identity path even when identity context is active", () => {
  const eligibility = assessIdentityInterpretationEligibility(
    "Deploy my app and leave the preview open.",
    {
      recentIdentityConversationActive: true,
      recentAssistantIdentityPrompt: true
    }
  );
  assert.equal(eligibility.eligible, false);
});

test("identity-style callback wording stays on the workflow path when the turn is really a deploy follow-up", () => {
  const signals = analyzeConversationChatTurnSignals("Call me when the deploy is done.");
  assert.equal(signals.primaryKind, "workflow_candidate");
  assert.equal(signals.actionability, "workflow_candidate");
  assert.equal(signals.containsWorkflowCue, true);
  assert.equal(signals.containsWorkflowCallbackCue, true);

  const eligibility = assessIdentityInterpretationEligibility("Call me when the deploy is done.", {
    recentAssistantIdentityPrompt: true,
    recentIdentityConversationActive: true
  });
  assert.equal(eligibility.eligible, false);
  assert.equal(
    shouldPreserveDeterministicDirectChatTurn("Call me when the deploy is done.", {
      recentAssistantIdentityPrompt: true,
      recentIdentityConversationActive: true
    }),
    false
  );
});

test("mixed identity recall plus explicit browser control stays actionable instead of preserving direct chat", () => {
  const signals = analyzeConversationChatTurnSignals("what is my name and close the browser");
  assert.equal(signals.primaryKind, "workflow_candidate");
  assert.equal(signals.actionability, "workflow_candidate");
  assert.equal(signals.containsWorkflowCue, true);

  const eligibility = assessIdentityInterpretationEligibility(
    "what is my name and close the browser",
    {
      recentIdentityConversationActive: true
    }
  );
  assert.equal(eligibility.eligible, false);
  assert.equal(
    shouldPreserveDeterministicDirectChatTurn("what is my name and close the browser", {
      recentIdentityConversationActive: true
    }),
    false
  );
});

test("analyzeConversationChatTurnSignals recognizes assistant-identity turns without treating them as workflow recall", () => {
  const assistantIdentity = analyzeConversationChatTurnSignals("And you are?");
  assert.equal(assistantIdentity.primaryKind, "assistant_identity_query");
  assert.equal(assistantIdentity.actionability, "none");
  assert.equal(assistantIdentity.containsStatusCue, false);

  const assistantName = analyzeConversationChatTurnSignals("What's your name?");
  assert.equal(assistantName.primaryKind, "assistant_identity_query");
  assert.equal(assistantName.containsStatusCue, false);
});

test("analyzeConversationChatTurnSignals keeps second-person conversational prompts out of assistant-identity classification", () => {
  const conversational = analyzeConversationChatTurnSignals("What about you?");
  assert.equal(conversational.primaryKind, "plain_chat");
  assert.equal(conversational.actionability, "none");
});

test("analyzeConversationChatTurnSignals keeps short interpersonal acknowledgements as conversational chat", () => {
  const acknowledgement = analyzeConversationChatTurnSignals("I know you are.");
  assert.equal(acknowledgement.primaryKind, "plain_chat");
  assert.equal(acknowledgement.interpersonalConversation, true);
  assert.equal(
    shouldPreserveDeterministicDirectChatTurn("I know you are.", {
      recentAssistantIdentityAnswer: true
    }),
    true
  );

  const objection = analyzeConversationChatTurnSignals("I didn't say to work on that.");
  assert.equal(objection.primaryKind, "plain_chat");
  assert.equal(objection.interpersonalConversation, true);
  assert.equal(
    shouldPreserveDeterministicDirectChatTurn("I didn't say to work on that.", {
      recentAssistantIdentityAnswer: true
    }),
    true
  );

  const eligibility = assessIdentityInterpretationEligibility("I know you are.", {
    recentAssistantIdentityPrompt: false,
    recentAssistantIdentityAnswer: false,
    recentIdentityConversationActive: false
  });
  assert.equal(eligibility.eligible, false);
  assert.equal(shouldPreserveDeterministicDirectChatTurn("I know you are."), false);
});

test("analyzeConversationChatTurnSignals keeps workflow action requests out of low-signal chat", () => {
  const signals = analyzeConversationChatTurnSignals("Deploy my app and leave the preview open.");
  assert.equal(signals.primaryKind, "workflow_candidate");
  assert.equal(signals.actionability, "workflow_candidate");
  assert.equal(signals.containsWorkflowCue, true);
});

test("analyzeConversationChatTurnSignals keeps short commands and approvals out of plain-chat preservation", () => {
  const signals = analyzeConversationChatTurnSignals("I confirm.");
  assert.equal(signals.primaryKind, "approval_or_control");
  assert.equal(shouldPreserveDeterministicDirectChatTurn("I confirm."), false);

  const command = analyzeConversationChatTurnSignals("Deploy.");
  assert.equal(command.primaryKind, "workflow_candidate");
  assert.equal(shouldPreserveDeterministicDirectChatTurn("Deploy."), false);
});

test("buildDeterministicDirectChatFallbackReply returns bounded no-worker replies", () => {
  assert.equal(buildDeterministicDirectChatFallbackReply("Hi"), "Hey.");
  assert.match(
    buildDeterministicDirectChatFallbackReply("What's my name?"),
    /don't want to guess your name/i
  );
  assert.equal(
    buildDeterministicDirectChatFallbackReply("My name is Avery."),
    "Okay, I'll use that."
  );
  assert.equal(
    buildDeterministicDirectChatFallbackReply("And you are?"),
    "I'm AgentBigBrain."
  );
  assert.equal(
    buildDeterministicDirectChatFallbackReply("I know you are."),
    "Okay."
  );
});

test("isRelationshipConversationRecallTurn keeps direct who-is relationship questions off the short follow-up path", () => {
  assert.equal(isRelationshipConversationRecallTurn("So, yeah, who is Milo?"), true);
  assert.equal(isRelationshipConversationRecallTurn("Who is he?"), true);
  assert.equal(isRelationshipConversationRecallTurn("Who's J.R.?"), true);
  assert.equal(isRelationshipConversationRecallTurn("Whos J.R.?"), true);
});

test("isRelationshipConversationRecallTurn recognizes status-shaped and shorthand relationship recall wording", () => {
  assert.equal(isRelationshipConversationRecallTurn("What's the status with Billy?"), true);
  assert.equal(isRelationshipConversationRecallTurn("Do you remember Billy?"), true);
  assert.equal(isRelationshipConversationRecallTurn("What's Billy's situation again?"), true);
  assert.equal(isRelationshipConversationRecallTurn("What's going on with Billy and Beacon?"), true);
  assert.equal(isRelationshipConversationRecallTurn("Who sold Jordan the gray Accord?"), true);
  assert.equal(isRelationshipConversationRecallTurn("Who bought the gray Accord?"), true);
  assert.equal(isRelationshipConversationRecallTurn("What happened with the gray Accord?"), true);
  assert.equal(isRelationshipConversationRecallTurn("Who handled the paperwork?"), true);
  assert.equal(isRelationshipConversationRecallTurn("What's going on with my roommate Kai?"), true);
  assert.equal(isRelationshipConversationRecallTurn("What's going on with my direct report Casey?"), true);
  assert.equal(isRelationshipConversationRecallTurn("Do you remember my supervisor Dana?"), true);
  assert.equal(isRelationshipConversationRecallTurn("What about my work peer Nolan?"), true);
  assert.equal(
    isRelationshipConversationRecallTurn("Could you take care of this end to end and remember that I prefer dark mode?"),
    false
  );
  assert.equal(isRelationshipConversationRecallTurn("What's the status on the deploy?"), false);
  assert.equal(isRelationshipConversationRecallTurn("What happened with the deploy?"), false);
});

test("isMixedConversationMemoryStatusRecallTurn recognizes combined durable-memory and browser-status recap wording", () => {
  const mixedRecallPrompt =
    "Switch gears back to memory and status tracking. Tell me which employment facts are current versus historical, " +
    "which date is the active pending review date, who currently handles the billing cleanup, and whether the Foundry Echo, River Glass, and Marquee Thread browser pages are still open or fully closed. " +
    "Keep the personal facts and the desktop project status separate in your answer.";

  assert.equal(isMixedConversationMemoryStatusRecallTurn(mixedRecallPrompt), true);
  assert.equal(
    isMixedConversationMemoryStatusRecallTurn(
      "What's the status on the deploy and which browser window is still open?"
    ),
    false
  );
});

test("shouldAllowImplicitReturnHandoffStatusFallback only permits explicit status-like fallback", () => {
  assert.equal(shouldAllowImplicitReturnHandoffStatusFallback("Hi"), false);
  assert.equal(shouldAllowImplicitReturnHandoffStatusFallback("And you are?"), false);
  assert.equal(shouldAllowImplicitReturnHandoffStatusFallback("What about you?"), false);
  assert.equal(shouldAllowImplicitReturnHandoffStatusFallback("What's the status?"), true);
  assert.equal(
    shouldAllowImplicitReturnHandoffStatusFallback("What's the status with Billy?"),
    false
  );
  assert.equal(
    shouldAllowImplicitReturnHandoffStatusFallback("Anything else?", "review_ready"),
    true
  );
  assert.equal(
    shouldAllowImplicitReturnHandoffStatusFallback("And you are?", "review_ready"),
    false
  );
});
