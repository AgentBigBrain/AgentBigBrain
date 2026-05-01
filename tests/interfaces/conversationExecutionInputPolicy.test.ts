/**
 * @fileoverview Tests deterministic execution-input and follow-up policy helpers extracted from conversationManager.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildAgentPulseExecutionInput,
  buildConversationAwareExecutionInput,
  buildTurnLocalStatusUpdateBlock,
  resolveFollowUpInput
} from "../../src/interfaces/conversationExecutionInputPolicy";
import { buildConversationMediaContextBlock } from "../../src/interfaces/conversationRuntime/mediaContextRendering";
import {
  buildSessionSeed,
  createFollowUpRuleContext
} from "../../src/interfaces/conversationManagerHelpers";
import type { ConversationSemanticRouteMetadata } from "../../src/interfaces/conversationRuntime/intentModeContracts";
import { classifyRoutingIntentV1 } from "../../src/interfaces/routingMap";
import {
  type ConversationSession
} from "../../src/interfaces/sessionStore";
import { buildConversationBrowserSessionFixture } from "../helpers/conversationFixtures";

/**
 * Creates a stable session fixture for execution-input policy tests.
 *
 * @returns Fresh seeded conversation session.
 */
function buildSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ...buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-execution-policy",
      userId: "user-1",
      username: "owner",
      conversationVisibility: "private",
      receivedAt: "2026-03-03T00:00:00.000Z"
    }),
    ...overrides
  };
}

/**
 * Builds a compact semantic-route fixture for execution-input tests.
 *
 * @param overrides - Typed route metadata overrides for the scenario under test.
 * @returns Complete semantic route metadata.
 */
function buildSemanticRouteFixture(
  overrides: Partial<Omit<ConversationSemanticRouteMetadata, "explicitConstraints">> & {
    explicitConstraints?: Partial<ConversationSemanticRouteMetadata["explicitConstraints"]>;
  } = {}
): ConversationSemanticRouteMetadata {
  return {
    routeId: overrides.routeId ?? "chat_answer",
    confidence: overrides.confidence ?? "high",
    source: overrides.source ?? "model",
    buildFormat: overrides.buildFormat ?? null,
    executionMode: overrides.executionMode ?? "chat",
    continuationKind: overrides.continuationKind ?? "none",
    memoryIntent: overrides.memoryIntent ?? "none",
    runtimeControlIntent: overrides.runtimeControlIntent ?? "none",
    explicitConstraints: {
      disallowBrowserOpen: overrides.explicitConstraints?.disallowBrowserOpen ?? false,
      disallowServerStart: overrides.explicitConstraints?.disallowServerStart ?? false,
      requiresUserOwnedLocation: overrides.explicitConstraints?.requiresUserOwnedLocation ?? false
    }
  };
}

test("buildTurnLocalStatusUpdateBlock only emits block for first-person status updates", () => {
  const block = buildTurnLocalStatusUpdateBlock("my deployment ticket is still pending");
  assert.match(block ?? "", /Turn-local status update/);
  assert.match(block ?? "", /my deployment ticket is still pending/i);

  const missingStatus = buildTurnLocalStatusUpdateBlock("please help with deployment");
  assert.equal(missingStatus, null);
});

test("resolveFollowUpInput wraps short follow-up answers with prior assistant clarification context", async () => {
  const session = buildSession();
  session.conversationTurns.push({
    role: "assistant",
    text: "Do you want the private or public pulse mode?",
    at: "2026-03-03T00:00:10.000Z"
  });

  const resolution = await resolveFollowUpInput(
    session,
    "private",
    createFollowUpRuleContext(null)
  );

  assert.equal(resolution.classification.isShortFollowUp, true);
  assert.equal(resolution.linkedToPriorAssistantPrompt, true);
  assert.equal(resolution.executionInput, "private");
});

test("resolveFollowUpInput strips robotic assistant labels from prior clarification prompts", async () => {
  const session = buildSession();
  session.conversationTurns.push({
    role: "assistant",
    text: "AI assistant answer: Would you like me to build it now or plan it first?",
    at: "2026-03-03T00:00:10.000Z"
  });

  const resolution = await resolveFollowUpInput(
    session,
    "build it now",
    createFollowUpRuleContext(null)
  );

  assert.equal(resolution.linkedToPriorAssistantPrompt, true);
  assert.equal(resolution.executionInput, "build it now");
});

test("resolveFollowUpInput uses continuation interpretation for bounded ambiguous follow-up leftovers", async () => {
  const session = buildSession();
  session.modeContinuity = {
    activeMode: "build",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: "2026-03-03T00:00:09.000Z",
    lastUserInput: "Build the landing page and save it where we used before."
  };
  session.conversationTurns.push({
    role: "assistant",
    text: "Should I save this in the same folder as before or create a new folder?",
    at: "2026-03-03T00:00:10.000Z"
  });

  const resolution = await resolveFollowUpInput(
    session,
    "same folder as before",
    createFollowUpRuleContext(null),
    async (request) => {
      assert.equal(request.recentAssistantTurn, "Should I save this in the same folder as before or create a new folder?");
      return {
        source: "local_intent_model",
        kind: "short_follow_up",
        followUpCategory: "ack",
        continuationTarget: "prior_assistant_turn",
        candidateValue: null,
        confidence: "medium",
        explanation: "The user is answering the prior folder clarification."
      };
    },
    classifyRoutingIntentV1("same folder as before")
  );

  assert.equal(resolution.classification.isShortFollowUp, true);
  assert.equal(resolution.classification.rulepackVersion, "ContinuationInterpretationV1");
  assert.match(resolution.executionInput, /Follow-up interpretation: The user is answering the prior folder clarification\./);
  assert.match(resolution.executionInput, /User follow-up answer: same folder as before/);
});

test("resolveFollowUpInput fails closed when continuation interpretation is low confidence", async () => {
  const session = buildSession();
  session.conversationTurns.push({
    role: "assistant",
    text: "Should I save this in the same folder as before or create a new folder?",
    at: "2026-03-03T00:00:10.000Z"
  });

  const resolution = await resolveFollowUpInput(
    session,
    "same folder as before",
    createFollowUpRuleContext(null),
    async () => ({
      source: "local_intent_model",
      kind: "short_follow_up",
      followUpCategory: "ack",
      continuationTarget: "prior_assistant_turn",
      candidateValue: null,
      confidence: "low",
      explanation: "Low confidence."
    }),
    classifyRoutingIntentV1("same folder as before")
  );

  assert.equal(resolution.classification.isShortFollowUp, false);
  assert.equal(resolution.executionInput, "same folder as before");
});

test("resolveFollowUpInput keeps question-like relationship recall off the continuation follow-up path", async () => {
  const session = buildSession();
  session.conversationTurns.push({
    role: "assistant",
    text: "Do you want me to keep going there?",
    at: "2026-03-03T00:00:10.000Z"
  });

  const resolution = await resolveFollowUpInput(
    session,
    "So, yeah, who is Milo?",
    createFollowUpRuleContext(null),
    async () => {
      throw new Error("continuation interpretation should not run for question-like relationship recall");
    },
    classifyRoutingIntentV1("So, yeah, who is Milo?")
  );

  assert.equal(resolution.classification.isShortFollowUp, false);
  assert.equal(resolution.linkedToPriorAssistantPrompt, false);
  assert.equal(resolution.executionInput, "So, yeah, who is Milo?");
});



test("buildConversationMediaContextBlock renders bounded interpreted attachment details", () => {
  const block = buildConversationMediaContextBlock({
    attachments: [
      {
        kind: "image",
        provider: "telegram",
        fileId: "file-image-1",
        fileUniqueId: "uniq-image-1",
        mimeType: "image/png",
        fileName: "error.png",
        sizeBytes: 2048,
        caption: "You did this wrong.",
        durationSeconds: null,
        width: 1280,
        height: 720,
        interpretation: {
          summary: "Screenshot shows a failing planner assertion.",
          transcript: null,
          ocrText: "Expected true Received false",
          confidence: null,
          provenance: "ocr + vision summary",
          source: "fixture_catalog",
          entityHints: ["planner.test.ts", "assertion"]
        }
      }
    ]
  });

  assert.match(block ?? "", /Inbound media context \(interpreted once, bounded, no raw bytes\):/);
  assert.match(block ?? "", /Attachment 1: image/);
  assert.match(block ?? "", /interpretation\.confidence: unknown/);
  assert.match(block ?? "", /planner\.test\.ts, assertion/);
});

test("buildConversationAwareExecutionInput returns raw input when no context, status, or routing hints exist", async () => {
  const session = buildSession();
  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "just do this",
    10
  );

  assert.equal(executionInput, "just do this");
});

test("buildConversationAwareExecutionInput emits a resolved semantic-route block when one is provided", async () => {
  const session = buildSession();
  const executionInput = await buildConversationAwareExecutionInput(
    session,
    'Build me a landing page in the exact folder "C:\\Users\\testuser\\Desktop\\Sample Service Landing Page" on my Desktop.',
    10,
    null,
    'Build me a landing page in the exact folder "C:\\Users\\testuser\\Desktop\\Sample Service Landing Page" on my Desktop.',
    undefined,
    undefined,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "static_html_build"
  );

  assert.match(executionInput, /Resolved semantic route:/);
  assert.match(executionInput, /- routeId: static_html_build/);
  assert.match(
    executionInput,
    /Planner-policy must consume it before any lexical fallback\./
  );
});

test("buildConversationAwareExecutionInput emits expanded semantic-route metadata when provided", async () => {
  const session = buildSession();
  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "open_browser url=file:///C:/Users/testuser/Desktop/northstar/index.html",
    10,
    null,
    "open_browser url=file:///C:/Users/testuser/Desktop/northstar/index.html",
    undefined,
    undefined,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "build_request",
    null,
    {
      routeId: "build_request",
      confidence: "high",
      source: "exact_command",
      buildFormat: null,
      executionMode: "build",
      continuationKind: "none",
      memoryIntent: "none",
      runtimeControlIntent: "open_browser",
      explicitConstraints: {
        disallowBrowserOpen: false,
        disallowServerStart: false,
        requiresUserOwnedLocation: true
      }
    }
  );

  assert.match(executionInput, /- source: exact_command/);
  assert.match(executionInput, /- executionMode: build/);
  assert.match(executionInput, /- memoryIntent: none/);
  assert.match(executionInput, /- runtimeControlIntent: open_browser/);
  assert.match(executionInput, /- requiresUserOwnedLocation: true/);
});

test("buildConversationAwareExecutionInput emits typed build-format metadata for planner handoff", async () => {
  const session = buildSession();
  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Use auto mode to build a static single-file HTML site and close the browser afterward.",
    10,
    null,
    "Use auto mode to build a static single-file HTML site and close the browser afterward.",
    undefined,
    undefined,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    "autonomous_execution",
    {
      format: "static_html",
      source: "explicit_user_request",
      confidence: "high"
    }
  );

  assert.match(executionInput, /Resolved build format:/);
  assert.match(executionInput, /- format: static_html/);
  assert.match(executionInput, /- source: explicit_user_request/);
  assert.match(executionInput, /not authorization for side effects/);
});

test("buildConversationAwareExecutionInput adds bounded self-identity facts for direct recall turns", async () => {
  const session = buildSession();
  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Who am I?",
    10,
    null,
    "Who am I?",
    undefined,
    async () => [
      {
        factId: "fact_identity_preferred_name",
        key: "identity.preferred_name",
        value: "Avery",
        status: "active",
        observedAt: "2026-03-19T12:00:00.000Z",
        lastUpdatedAt: "2026-03-20T16:00:00.000Z",
        confidence: 0.98
      },
      {
        factId: "fact_relationship_manager",
        key: "relationship.manager_name",
        value: "Pat",
        status: "active",
        observedAt: "2026-03-19T12:00:00.000Z",
        lastUpdatedAt: "2026-03-19T12:00:00.000Z",
        confidence: 0.75
      }
    ]
  );

  assert.match(executionInput, /Direct self-identity recall context:/);
  assert.match(executionInput, /identity\.preferred_name: Avery/);
  assert.doesNotMatch(executionInput, /relationship\.manager_name/i);
  assert.match(
    executionInput,
    /Do not say you only know their name 'from this chat' when these facts are present\./
  );
});

test("buildConversationAwareExecutionInput falls back to a low-confidence transport identity hint when no facts exist", async () => {
  const session = buildSession({
    transportIdentity: {
      provider: "telegram",
      username: "averybrooks",
      displayName: "Avery Brooks",
      givenName: "Avery",
      familyName: "Bena",
      observedAt: "2026-03-20T20:48:00.000Z"
    }
  });
  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Who am I?",
    10,
    null,
    "Who am I?"
  );

  assert.match(executionInput, /Direct self-identity recall context:/);
  assert.match(executionInput, /Low-confidence transport identity hint:/);
  assert.match(executionInput, /Source: transport display name/);
  assert.match(executionInput, /Candidate display name: Avery Brooks/);
  assert.match(executionInput, /Trust rule: this hint came from transport metadata and is not a stored profile fact\./);
  assert.doesNotMatch(executionInput, /No bounded non-sensitive identity facts were found for this user yet\.\n- Response rule: say you do not know yet/i);
});

test("buildConversationAwareExecutionInput keeps confirmed identity facts authoritative over transport hints", async () => {
  const session = buildSession({
    transportIdentity: {
      provider: "telegram",
      username: "averybrooks",
      displayName: "Avery Brooks",
      givenName: "Avery",
      familyName: "Bena",
      observedAt: "2026-03-20T20:48:00.000Z"
    }
  });
  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Who am I?",
    10,
    null,
    "Who am I?",
    undefined,
    async () => [
      {
        factId: "fact_identity_preferred_name",
        key: "identity.preferred_name",
        value: "Tony",
        status: "active",
        observedAt: "2026-03-19T12:00:00.000Z",
        lastUpdatedAt: "2026-03-20T16:00:00.000Z",
        confidence: 0.99
      }
    ]
  );

  assert.match(executionInput, /identity\.preferred_name: Tony/);
  assert.doesNotMatch(executionInput, /Low-confidence transport identity hint:/);
});

test("buildConversationAwareExecutionInput rejects generic usernames as identity hints", async () => {
  const session = buildSession({
    transportIdentity: {
      provider: "telegram",
      username: "agentowner",
      displayName: null,
      givenName: null,
      familyName: null,
      observedAt: "2026-03-20T20:48:00.000Z"
    }
  });
  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Who am I?",
    10,
    null,
    "Who am I?"
  );

  assert.match(executionInput, /Direct self-identity recall context:/);
  assert.doesNotMatch(executionInput, /Low-confidence transport identity hint:/);
  assert.match(executionInput, /Response rule: say you do not know yet instead of inventing or inferring a name\./);
});

test("buildConversationAwareExecutionInput includes conversation context, status guardrails, and routing hint", async () => {
  const session = buildSession();
  session.conversationTurns.push({
    role: "user",
    text: "Please keep approvals deterministic.",
    at: "2026-03-03T00:00:10.000Z"
  });
  session.conversationTurns.push({
    role: "assistant",
    text: "I will provide the exact approval diff before any write.",
    at: "2026-03-03T00:00:20.000Z"
  });
  session.modeContinuity = {
    activeMode: "build",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: "2026-03-03T00:00:25.000Z",
    lastUserInput: "Build the release notes app."
  };
  session.progressState = {
    status: "working",
    message: "building the release notes app",
    jobId: "job-1",
    updatedAt: "2026-03-03T00:00:30.000Z"
  };
  session.returnHandoff = {
    id: "handoff:job-0",
    status: "completed",
    goal: "Build the release notes app.",
    summary: "I finished a usable draft and left the preview ready.",
    nextSuggestedStep: "Tell me what to refine next.",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\123",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\123\\index.html",
    previewUrl: "http://localhost:3000",
    changedPaths: ["C:\\Users\\testuser\\Desktop\\123\\index.html"],
    sourceJobId: "job-0",
    updatedAt: "2026-03-03T00:00:29.000Z"
  };
  session.recentActions.push({
    id: "action-1",
    kind: "file",
    label: "Landing page file",
    location: "C:\\Users\\testuser\\Desktop\\123\\index.html",
    status: "updated",
    sourceJobId: "job-1",
    at: "2026-03-03T00:00:20.000Z",
    summary: "Wrote the landing page."
  });
  session.pathDestinations.push({
    id: "dest-1",
    label: "Desktop 123 folder",
    resolvedPath: "C:\\Users\\testuser\\Desktop\\123",
    sourceJobId: "job-1",
    updatedAt: "2026-03-03T00:00:20.000Z"
  });
  session.browserSessions.push({
    id: "browser-1",
    label: "Landing page preview",
    url: "http://localhost:3000",
    visibility: "visible",
    status: "open",
    sourceJobId: "job-1",
    openedAt: "2026-03-03T00:00:20.000Z",
    closedAt: null,
    controllerKind: "playwright_managed",
    controlAvailable: true,
    browserProcessPid: 41001,
    linkedProcessLeaseId: null,
    linkedProcessCwd: null,
    linkedProcessPid: null
  });
  session.activeWorkspace = {
    id: "workspace:desktop-123",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\123",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\123\\index.html",
    previewUrl: "http://localhost:3000",
    browserSessionId: "browser-1",
    browserSessionIds: ["browser-1"],
    browserSessionStatus: "open",
    browserProcessPid: 41001,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: null,
    lastKnownPreviewProcessPid: null,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_only",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\123\\index.html"],
    sourceJobId: "job-1",
    updatedAt: "2026-03-03T00:00:20.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "my release status is pending",
    10,
    classifyRoutingIntentV1("schedule 3 focus blocks next week")
  );

  assert.match(executionInput, /Recent conversation context \(oldest to newest\):/);
  assert.match(executionInput, /Turn-local status update \(authoritative for this turn\):/);
  assert.match(executionInput, /Current working mode from earlier in this chat:/);
  assert.match(executionInput, /Current progress state:/);
  assert.match(executionInput, /Latest durable work handoff in this chat:/);
  assert.match(executionInput, /Summary: I finished a usable draft and left the preview ready\./);
  assert.match(executionInput, /Recent user-visible actions in this chat:/);
  assert.match(executionInput, /Current tracked workspace in this chat:/);
  assert.match(executionInput, /Root path: C:\\Users\\testuser\\Desktop\\123/);
  assert.match(executionInput, /Ownership state: tracked/);
  assert.match(executionInput, /Preview stack state: browser_only/);
  assert.match(executionInput, /Tracked browser sessions:/);
  assert.match(executionInput, /sessionId=browser-1;/);
  assert.match(executionInput, /browserPid=41001/);
  assert.match(executionInput, /Deterministic routing hint:/);
  assert.match(executionInput, /Current user request:/);
});

test("buildConversationAwareExecutionInput adds a durable continuation block for resume-style follow-ups", async () => {
  const session = buildSession();
  session.returnHandoff = {
    id: "handoff:job-7",
    status: "completed",
    goal: "Build the sample landing page and leave the preview ready.",
    summary: "I finished the draft and left the preview ready for review.",
    nextSuggestedStep: "Tell me which section you want refined next.",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
    previewUrl: "http://127.0.0.1:4177/index.html",
    changedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
    sourceJobId: "job-7",
    updatedAt: "2026-03-03T00:00:40.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Pick that back up and keep going from where you left off.",
    10
  );

  assert.match(executionInput, /Durable return-handoff continuation:/);
  assert.match(executionInput, /Resume request: Pick that back up and keep going from where you left off\./);
  assert.match(executionInput, /Prior goal: Build the sample landing page and leave the preview ready\./);
  assert.match(executionInput, /Suggested next step: Tell me which section you want refined next\./);
  assert.match(executionInput, /Do not rebuild or restart from scratch unless the tracked workspace or artifact no longer fits/i);
});

test("buildConversationAwareExecutionInput adds the durable continuation block when semantic intent proves a resume request", async () => {
  const session = buildSession();
  session.returnHandoff = {
    id: "handoff:job-7b",
    status: "waiting_for_user",
    goal: "Keep refining the sample landing page draft.",
    summary: "I paused with a reviewable draft ready.",
    nextSuggestedStep: "Keep refining the hero and CTA when the user is ready.",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
    previewUrl: "http://127.0.0.1:4177/index.html",
    changedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
    sourceJobId: "job-7b",
    updatedAt: "2026-03-03T00:00:41.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "When you get a chance, keep refining that draft from where you left off.",
    10,
    null,
    "When you get a chance, keep refining that draft from where you left off.",
    undefined,
    undefined,
    null,
    undefined,
    "resume_handoff"
  );

  assert.match(executionInput, /Durable return-handoff continuation:/);
  assert.match(executionInput, /Resume request: When you get a chance, keep refining that draft from where you left off\./);
  assert.match(executionInput, /Prior goal: Keep refining the sample landing page draft\./);
});

test("buildConversationAwareExecutionInput suppresses workflow continuity blocks for profile detours", async () => {
  const session = buildSession();
  session.modeContinuity = {
    activeMode: "build",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: "2026-03-03T00:00:25.000Z",
    lastUserInput: "Build the release notes app."
  };
  session.progressState = {
    status: "working",
    message: "building the release notes app",
    jobId: "job-1",
    updatedAt: "2026-03-03T00:00:30.000Z"
  };
  session.returnHandoff = {
    id: "handoff:job-0",
    status: "completed",
    goal: "Build the release notes app.",
    summary: "I finished a usable draft and left the preview ready.",
    nextSuggestedStep: "Tell me what to refine next.",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\123",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\123\\index.html",
    previewUrl: "http://localhost:3000",
    changedPaths: ["C:\\Users\\testuser\\Desktop\\123\\index.html"],
    sourceJobId: "job-0",
    updatedAt: "2026-03-03T00:00:29.000Z"
  };
  session.activeWorkspace = {
    id: "workspace:desktop-123",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\123",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\123\\index.html",
    previewUrl: "http://localhost:3000",
    browserSessionId: "browser-1",
    browserSessionIds: ["browser-1"],
    browserSessionStatus: "open",
    browserProcessPid: 41001,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\123",
    lastKnownPreviewProcessPid: null,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_only",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\123\\index.html"],
    sourceJobId: "job-1",
    updatedAt: "2026-03-03T00:00:20.000Z"
  };
  session.domainContext.dominantLane = "workflow";
  session.domainContext.continuitySignals = {
    activeWorkspace: true,
    returnHandoff: true,
    modeContinuity: true
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Remember that I prefer dark mode.",
    10
  );

  assert.doesNotMatch(executionInput, /Current working mode from earlier in this chat:/);
  assert.doesNotMatch(executionInput, /Latest durable work handoff in this chat:/);
  assert.doesNotMatch(executionInput, /Current tracked workspace in this chat:/);
  assert.equal(executionInput, "Remember that I prefer dark mode.");
});

test("buildConversationAwareExecutionInput suppresses workflow continuity blocks for broader governed relationship detours", async () => {
  const session = buildSession();
  session.modeContinuity = {
    activeMode: "build",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: "2026-03-03T00:00:25.000Z",
    lastUserInput: "Build the release notes app."
  };
  session.progressState = {
    status: "working",
    message: "building the release notes app",
    jobId: "job-1",
    updatedAt: "2026-03-03T00:00:30.000Z"
  };
  session.returnHandoff = {
    id: "handoff:job-0",
    status: "completed",
    goal: "Build the release notes app.",
    summary: "I finished a usable draft and left the preview ready.",
    nextSuggestedStep: "Tell me what to refine next.",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\123",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\123\\index.html",
    previewUrl: "http://localhost:3000",
    changedPaths: ["C:\\Users\\testuser\\Desktop\\123\\index.html"],
    sourceJobId: "job-0",
    updatedAt: "2026-03-03T00:00:29.000Z"
  };
  session.activeWorkspace = {
    id: "workspace:desktop-123",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\123",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\123\\index.html",
    previewUrl: "http://localhost:3000",
    browserSessionId: "browser-1",
    browserSessionIds: ["browser-1"],
    browserSessionStatus: "open",
    browserProcessPid: 41001,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\123",
    lastKnownPreviewProcessPid: null,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_only",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\123\\index.html"],
    sourceJobId: "job-1",
    updatedAt: "2026-03-03T00:00:20.000Z"
  };
  session.domainContext.dominantLane = "workflow";
  session.domainContext.continuitySignals = {
    activeWorkspace: true,
    returnHandoff: true,
    modeContinuity: true
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "My direct report is Casey.",
    10
  );

  assert.doesNotMatch(executionInput, /Current working mode from earlier in this chat:/);
  assert.doesNotMatch(executionInput, /Latest durable work handoff in this chat:/);
  assert.doesNotMatch(executionInput, /Current tracked workspace in this chat:/);
  assert.equal(executionInput, "My direct report is Casey.");
});

test("buildConversationAwareExecutionInput preserves workflow continuity blocks for workflow follow-ups", async () => {
  const session = buildSession();
  session.modeContinuity = {
    activeMode: "build",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: "2026-03-03T00:00:25.000Z",
    lastUserInput: "Build the release notes app."
  };
  session.returnHandoff = {
    id: "handoff:job-0",
    status: "completed",
    goal: "Build the release notes app.",
    summary: "I finished a usable draft and left the preview ready.",
    nextSuggestedStep: "Tell me what to refine next.",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\123",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\123\\index.html",
    previewUrl: "http://localhost:3000",
    changedPaths: ["C:\\Users\\testuser\\Desktop\\123\\index.html"],
    sourceJobId: "job-0",
    updatedAt: "2026-03-03T00:00:29.000Z"
  };
  session.activeWorkspace = {
    id: "workspace:desktop-123",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\123",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\123\\index.html",
    previewUrl: "http://localhost:3000",
    browserSessionId: "browser-1",
    browserSessionIds: ["browser-1"],
    browserSessionStatus: "open",
    browserProcessPid: 41001,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\123",
    lastKnownPreviewProcessPid: null,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_only",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\123\\index.html"],
    sourceJobId: "job-1",
    updatedAt: "2026-03-03T00:00:20.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Update the landing page hero copy.",
    10,
    classifyRoutingIntentV1("Update the landing page hero copy.")
  );

  assert.match(executionInput, /Current working mode from earlier in this chat:/);
  assert.match(executionInput, /Latest durable work handoff in this chat:/);
  assert.match(executionInput, /Current tracked workspace in this chat:/);
});

test("buildConversationAwareExecutionInput suppresses stale workflow continuity blocks for fresh framework scaffold requests", async () => {
  const session = buildSession();
  session.modeContinuity = {
    activeMode: "autonomous",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: "2026-04-10T17:56:52.000Z",
    lastUserInput: "Create the Detroit City landing page and leave it open."
  };
  session.progressState = {
    status: "stopped",
    message: "The prior Detroit City run stopped before the preview was usable.",
    jobId: "job-old",
    updatedAt: "2026-04-10T17:57:16.000Z"
  };
  session.returnHandoff = {
    id: "handoff:detroit-city-old",
    status: "completed",
    goal: "Create the Detroit City landing page and leave it open.",
    summary: "The prior Detroit City run stopped after planner failure.",
    nextSuggestedStep: "Retry with a fresh scaffold plan.",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\Detroit City",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\Detroit City\\app\\page.js",
    previewUrl: "http://127.0.0.1:3000",
    changedPaths: ["C:\\Users\\testuser\\Desktop\\Detroit City\\app\\page.js"],
    sourceJobId: "job-old",
    updatedAt: "2026-04-10T17:57:16.000Z"
  };
  session.activeWorkspace = {
    id: "workspace:detroit-city-old",
    label: "Detroit City workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\Detroit City",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\Detroit City\\app\\page.js",
    previewUrl: "http://127.0.0.1:3000",
    browserSessionId: null,
    browserSessionIds: [],
    browserSessionStatus: null,
    browserProcessPid: null,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\Detroit City",
    lastKnownPreviewProcessPid: null,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\Detroit City\\app\\page.js"],
    sourceJobId: "job-old",
    updatedAt: "2026-04-10T17:57:16.000Z"
  };
  session.domainContext.dominantLane = "workflow";
  session.domainContext.continuitySignals = {
    activeWorkspace: true,
    returnHandoff: true,
    modeContinuity: true
  };

  const userInput =
    'I want you to create a nextjs landing page, with 4 sections called "Detroit City" and there should be a footer and header, a gritty feeling design, and you need to do this end to end and put it on my desktop, then leave it open in the browser so i can review it. This means you have to run it and leave it open.';
  const semanticRoute = buildSemanticRouteFixture({
    routeId: "framework_app_build",
    source: "model",
    buildFormat: {
      format: "nextjs",
      source: "explicit_user_request",
      confidence: "high"
    },
    executionMode: "build",
    runtimeControlIntent: "open_browser",
    explicitConstraints: {
      requiresUserOwnedLocation: true
    }
  });
  const executionInput = await buildConversationAwareExecutionInput(
    session,
    userInput,
    10,
    classifyRoutingIntentV1(userInput),
    userInput,
    undefined,
    undefined,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    semanticRoute.routeId,
    semanticRoute.buildFormat,
    semanticRoute
  );

  assert.doesNotMatch(executionInput, /Current working mode from earlier in this chat:/);
  assert.doesNotMatch(executionInput, /Latest durable work handoff in this chat:/);
  assert.doesNotMatch(executionInput, /Current tracked workspace in this chat:/);
  assert.match(executionInput, /Resolved semantic route:/);
  assert.match(executionInput, /- routeId: framework_app_build/);
  assert.match(executionInput, /Resolved build format:/);
  assert.match(executionInput, /- format: nextjs/);
  assert.doesNotMatch(executionInput, /Deterministic routing hint:/);
  assert.match(executionInput, /Current user request:/);
  assert.match(executionInput, /create a nextjs landing page/i);
});

test("buildConversationAwareExecutionInput lets plan route metadata beat stale workflow continuity", async () => {
  const session = buildSession();
  session.modeContinuity = {
    activeMode: "build",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: "2026-04-10T17:56:52.000Z",
    lastUserInput: "Build the prior sample site."
  };
  session.returnHandoff = {
    id: "handoff:prior-sample-site",
    status: "completed",
    goal: "Build the prior sample site.",
    summary: "The prior sample site was created.",
    nextSuggestedStep: "Edit the prior site if asked.",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\prior-sample-site",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\prior-sample-site\\index.html",
    previewUrl: "file:///C:/Users/testuser/Desktop/prior-sample-site/index.html",
    changedPaths: ["C:\\Users\\testuser\\Desktop\\prior-sample-site\\index.html"],
    sourceJobId: "job-prior",
    updatedAt: "2026-04-10T17:57:16.000Z"
  };
  session.activeWorkspace = {
    id: "workspace:prior-sample-site",
    label: "Prior sample workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\prior-sample-site",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\prior-sample-site\\index.html",
    previewUrl: "file:///C:/Users/testuser/Desktop/prior-sample-site/index.html",
    browserSessionId: "browser-prior",
    browserSessionIds: ["browser-prior"],
    browserSessionStatus: "closed",
    browserProcessPid: null,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: null,
    lastKnownPreviewProcessPid: null,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\prior-sample-site\\index.html"],
    sourceJobId: "job-prior",
    updatedAt: "2026-04-10T17:57:16.000Z"
  };
  session.domainContext.dominantLane = "workflow";
  session.domainContext.continuitySignals = {
    activeWorkspace: true,
    returnHandoff: true,
    modeContinuity: true
  };
  const userInput =
    "Before building anything, outline a static HTML creative agency site with a few page ideas.";
  const semanticRoute = buildSemanticRouteFixture({
    routeId: "plan_request",
    executionMode: "plan",
    buildFormat: {
      format: "static_html",
      source: "explicit_user_request",
      confidence: "high"
    },
    explicitConstraints: {
      disallowBrowserOpen: true,
      disallowServerStart: true
    }
  });

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    userInput,
    10,
    classifyRoutingIntentV1(userInput),
    userInput,
    undefined,
    undefined,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    semanticRoute.routeId,
    semanticRoute.buildFormat,
    semanticRoute
  );

  assert.match(executionInput, /Resolved semantic route:/);
  assert.match(executionInput, /- routeId: plan_request/);
  assert.match(executionInput, /Resolved build format:/);
  assert.match(executionInput, /- format: static_html/);
  assert.doesNotMatch(executionInput, /Current working mode from earlier in this chat:/);
  assert.doesNotMatch(executionInput, /Latest durable work handoff in this chat:/);
  assert.doesNotMatch(executionInput, /Current tracked workspace in this chat:/);
  assert.doesNotMatch(executionInput, /Natural artifact-edit follow-up:/);
});

test("buildConversationAwareExecutionInput grounds tracked runtime inspection against the tracked workspace instead of build/scaffold work", async () => {
  const session = buildSession();
  session.modeContinuity = {
    activeMode: "autonomous",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: "2026-04-11T03:22:29.000Z",
    lastUserInput:
      'did you make sure you shut down "Detroit City Two" so that the server is no longer running? Please do this end to end - check and make sure. If it\'s complete then you succeeded.'
  };
  session.progressState = {
    status: "stopped",
    message: "The prior verification run failed closed for PROCESS_NOT_READY.",
    jobId: "job-detroit-two-inspect",
    updatedAt: "2026-04-11T03:24:29.335Z"
  };
  session.returnHandoff = {
    id: "handoff:detroit-city-two",
    status: "completed",
    goal: "Please inspect and see if Detroit City Two is still running, do this end to end.",
    summary:
      "The prior run failed closed for PROCESS_NOT_READY because no exact managed-process lease was inspected.",
    nextSuggestedStep: "Inspect the tracked runtime directly before declaring success.",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\Detroit City Two",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\Detroit City Two\\app\\globals.css",
    previewUrl: "http://127.0.0.1:3000/",
    changedPaths: ["C:\\Users\\testuser\\Desktop\\Detroit City Two\\app\\globals.css"],
    sourceJobId: "job-detroit-two-inspect",
    updatedAt: "2026-04-11T03:24:29.335Z"
  };
  session.activeWorkspace = {
    id: "workspace:detroit-city-two",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\Detroit City Two",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\Detroit City Two\\app\\globals.css",
    previewUrl: "http://127.0.0.1:3000/",
    browserSessionId: "browser_session:action_detroit_two",
    browserSessionIds: ["browser_session:action_detroit_two"],
    browserSessionStatus: "closed",
    browserProcessPid: 54944,
    previewProcessLeaseId: "proc_detroit_two",
    previewProcessLeaseIds: ["proc_detroit_two"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\Detroit City Two",
    lastKnownPreviewProcessPid: 17864,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\Detroit City Two\\app\\globals.css"],
    sourceJobId: "job-detroit-two-inspect",
    updatedAt: "2026-04-11T03:24:29.335Z"
  };
  session.domainContext.dominantLane = "workflow";
  session.domainContext.continuitySignals = {
    activeWorkspace: true,
    returnHandoff: true,
    modeContinuity: true
  };

  const userInput = "please inspect and see if Detroit City Two is still running, do this end to end";
  const executionInput = await buildConversationAwareExecutionInput(
    session,
    userInput,
    10,
    classifyRoutingIntentV1(userInput)
  );

  assert.match(executionInput, /Runtime process-management context:/);
  assert.match(
    executionInput,
    /Tracked runtime target: rootPath=C:\\Users\\testuser\\Desktop\\Detroit City Two; ownership=stale; previewState=detached/
  );
  assert.match(executionInput, /Exact tracked preview lease ids: proc_detroit_two/);
  assert.match(executionInput, /Prefer inspect_workspace_resources first/i);
  assert.match(executionInput, /Current tracked workspace in this chat:/);
  assert.match(executionInput, /Preview process lease: proc_detroit_two/);
});

test("buildConversationAwareExecutionInput keeps tracked runtime continuity for natural shorthand that uniquely names the tracked project", async () => {
  const session = buildSession();
  session.modeContinuity = {
    activeMode: "autonomous",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: "2026-04-11T03:22:29.000Z",
    lastUserInput:
      'I want you to create a nextjs landing page, with 4 sections called "Detroit City Two" and leave it open.'
  };
  session.returnHandoff = {
    id: "handoff:detroit-city-two",
    status: "completed",
    goal: 'Build "Detroit City Two" and leave the preview ready.',
    summary: "The tracked Detroit City Two preview is detached and needs inspection.",
    nextSuggestedStep: "Inspect the tracked runtime directly before declaring success.",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\Detroit City Two",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\Detroit City Two\\app\\globals.css",
    previewUrl: "http://127.0.0.1:3000/",
    changedPaths: ["C:\\Users\\testuser\\Desktop\\Detroit City Two\\app\\globals.css"],
    sourceJobId: "job-detroit-two-inspect",
    updatedAt: "2026-04-11T03:24:29.335Z"
  };
  session.activeWorkspace = {
    id: "workspace:detroit-city-two",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\Detroit City Two",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\Detroit City Two\\app\\globals.css",
    previewUrl: "http://127.0.0.1:3000/",
    browserSessionId: "browser_session:action_detroit_two",
    browserSessionIds: ["browser_session:action_detroit_two"],
    browserSessionStatus: "closed",
    browserProcessPid: 54944,
    previewProcessLeaseId: "proc_detroit_two",
    previewProcessLeaseIds: ["proc_detroit_two"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\Detroit City Two",
    lastKnownPreviewProcessPid: 17864,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\Detroit City Two\\app\\globals.css"],
    sourceJobId: "job-detroit-two-inspect",
    updatedAt: "2026-04-11T03:24:29.335Z"
  };

  const userInput =
    "did you make sure you shut down the nextjs detroit two we just worked on and verify it is no longer running?";
  const executionInput = await buildConversationAwareExecutionInput(
    session,
    userInput,
    10,
    classifyRoutingIntentV1(userInput)
  );

  assert.match(executionInput, /Runtime process-management context:/);
  assert.match(
    executionInput,
    /Tracked runtime target: rootPath=C:\\Users\\testuser\\Desktop\\Detroit City Two; ownership=stale; previewState=detached/
  );
  assert.match(executionInput, /Current tracked workspace in this chat:/);
  assert.match(executionInput, /Preview process lease: proc_detroit_two/);
  assert.doesNotMatch(
    executionInput,
    /The request does not target the currently tracked workspace by name/i
  );
});

test("buildConversationAwareExecutionInput suppresses stale tracked workflow continuity for broad Desktop runtime shutdown requests", async () => {
  const session = buildSession();
  session.modeContinuity = {
    activeMode: "autonomous",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: "2026-04-11T03:23:48.000Z",
    lastUserInput: "please inspect and see if Detroit City Two is still running, do this end to end"
  };
  session.progressState = {
    status: "stopped",
    message: "The prior Detroit City Two inspection run failed closed.",
    jobId: "job-detroit-two-stop",
    updatedAt: "2026-04-11T03:24:29.335Z"
  };
  session.returnHandoff = {
    id: "handoff:detroit-city-two",
    status: "completed",
    goal: "please inspect and see if Detroit City Two is still running, do this end to end",
    summary: "The prior run failed closed for PROCESS_NOT_READY.",
    nextSuggestedStep: "Inspect the tracked runtime directly.",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\Detroit City Two",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\Detroit City Two\\app\\globals.css",
    previewUrl: "http://127.0.0.1:3000/",
    changedPaths: ["C:\\Users\\testuser\\Desktop\\Detroit City Two\\app\\globals.css"],
    sourceJobId: "job-detroit-two-stop",
    updatedAt: "2026-04-11T03:24:29.335Z"
  };
  session.activeWorkspace = {
    id: "workspace:detroit-city-two",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\Detroit City Two",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\Detroit City Two\\app\\globals.css",
    previewUrl: "http://127.0.0.1:3000/",
    browserSessionId: "browser_session:action_detroit_two",
    browserSessionIds: ["browser_session:action_detroit_two"],
    browserSessionStatus: "closed",
    browserProcessPid: 54944,
    previewProcessLeaseId: "proc_detroit_two",
    previewProcessLeaseIds: ["proc_detroit_two"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\Detroit City Two",
    lastKnownPreviewProcessPid: 17864,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\Detroit City Two\\app\\globals.css"],
    sourceJobId: "job-detroit-two-stop",
    updatedAt: "2026-04-11T03:24:29.335Z"
  };
  session.domainContext.dominantLane = "workflow";
  session.domainContext.continuitySignals = {
    activeWorkspace: true,
    returnHandoff: true,
    modeContinuity: true
  };

  const userInput =
    "Look at all the folders on the desktop that start with sample and Sample, stop the servers that are running in the folders do this end to end";
  const executionInput = await buildConversationAwareExecutionInput(
    session,
    userInput,
    10,
    classifyRoutingIntentV1(userInput)
  );

  assert.match(executionInput, /Runtime process-management context:/);
  assert.match(
    executionInput,
    /The request does not target the currently tracked workspace by name, so do not reuse stale build continuity or project handoff state as a substitute\./i
  );
  assert.match(
    executionInput,
    /first enumerate those matching folders, then inspect running processes tied to those exact folders, stop only matched processes, and verify the result\./i
  );
  assert.doesNotMatch(executionInput, /Current working mode from earlier in this chat:/);
  assert.doesNotMatch(executionInput, /Latest durable work handoff in this chat:/);
  assert.doesNotMatch(executionInput, /Current tracked workspace in this chat:/);
});

test("buildConversationAwareExecutionInput strips robotic assistant labels from recent conversation context", async () => {
  const session = buildSession();
  session.conversationTurns.push({
    role: "assistant",
    text: "AI assistant answer: Owen seems to be doing better now.",
    at: "2026-03-03T00:00:20.000Z"
  });

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "How is Owen doing?",
    10
  );

  assert.match(executionInput, /Recent conversation context \(oldest to newest\):/);
  assert.match(executionInput, /- assistant: Owen seems to be doing better now\./);
  assert.doesNotMatch(executionInput, /AI assistant answer:/i);
});



test("buildConversationAwareExecutionInput includes interpreted media context when media is attached", async () => {
  const session = buildSession();
  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Please fix this.",
    10,
    null,
    "Please fix this.",
    undefined,
    undefined,
    {
      attachments: [
        {
          kind: "voice",
          provider: "telegram",
          fileId: "voice-1",
          fileUniqueId: "voice-uniq-1",
          mimeType: "audio/ogg",
          fileName: null,
          sizeBytes: 8192,
          caption: null,
          durationSeconds: 11,
          width: null,
          height: null,
          interpretation: {
            summary: "Voice note asking to fix the failing planner test now.",
            transcript: "Please fix the failing planner test now.",
            ocrText: null,
            confidence: 0.94,
            provenance: "transcription",
            source: "fixture_catalog",
            entityHints: ["planner", "test"]
          }
        }
      ]
    }
  );

  assert.match(executionInput, /Inbound media context \(interpreted once, bounded, no raw bytes\):/);
  assert.match(executionInput, /interpretation\.transcript: Please fix the failing planner test now\./);
  assert.match(executionInput, /Current user request:/);
});

test("buildConversationAwareExecutionInput does not add routing-map build hints for generic app creation prompts", async () => {
  const session = buildSession();
  const classification = classifyRoutingIntentV1(
    "Create a React app on my Desktop and execute now."
  );
  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Create a React app on my Desktop and execute now.",
    10,
    classification
  );

  assert.equal(executionInput, "Create a React app on my Desktop and execute now.");
});

test("buildConversationAwareExecutionInput can inject episode-aware contextual recall from the raw user turn while preserving wrapped execution input", async () => {
  const session = buildSession();
  session.conversationTurns.push({
    role: "user",
    text: "Owen fell down a few weeks ago.",
    at: "2026-02-14T15:00:00.000Z"
  });
  session.conversationStack = {
    schemaVersion: "v1",
    updatedAt: "2026-03-03T00:00:00.000Z",
    activeThreadKey: "thread_current",
    threads: [
      {
        threadKey: "thread_current",
        topicKey: "release_rollout",
        topicLabel: "Release Rollout",
        state: "active",
        resumeHint: "Need to finish the rollout.",
        openLoops: [],
        lastTouchedAt: "2026-03-03T00:00:00.000Z"
      },
      {
        threadKey: "thread_owen",
        topicKey: "owen_fall",
        topicLabel: "Owen Fall",
        state: "paused",
        resumeHint: "Owen fell down and you wanted to hear how it ended up.",
        openLoops: [
          {
            loopId: "loop_owen",
            threadKey: "thread_owen",
            entityRefs: ["owen"],
            createdAt: "2026-02-14T15:00:00.000Z",
            lastMentionedAt: "2026-02-14T15:00:00.000Z",
            priority: 0.8,
            status: "open"
          }
        ],
        lastTouchedAt: "2026-02-14T15:00:00.000Z"
      }
    ],
    topics: [
      {
        topicKey: "release_rollout",
        label: "Release Rollout",
        firstSeenAt: "2026-03-03T00:00:00.000Z",
        lastSeenAt: "2026-03-03T00:00:00.000Z",
        mentionCount: 1
      },
      {
        topicKey: "owen_fall",
        label: "Owen Fall",
        firstSeenAt: "2026-02-14T15:00:00.000Z",
        lastSeenAt: "2026-02-14T15:00:00.000Z",
        mentionCount: 1
      }
    ]
  };

  const semanticRoute = buildSemanticRouteFixture({
    routeId: "status_recall",
    executionMode: "status_or_recall",
    continuationKind: "contextual_followup",
    memoryIntent: "contextual_recall"
  });
  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Follow-up user response to prior assistant clarification.\nUser follow-up answer: Owen seems better now.",
    10,
    null,
    "How is Owen doing lately?",
    async () => [
      {
        episodeId: "episode_owen_fall",
        title: "Owen fell down",
        summary: "Owen fell down a few weeks ago and the outcome never got resolved.",
        status: "unresolved",
        lastMentionedAt: "2026-02-14T15:00:00.000Z",
        entityRefs: ["Owen"],
        entityLinks: [
          {
            entityKey: "entity_owen",
            canonicalName: "Owen"
          }
        ],
        openLoopLinks: [
          {
            loopId: "loop_owen",
            threadKey: "thread_owen",
            status: "open",
            priority: 0.8
          }
        ]
      }
    ],
    undefined,
    null,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    semanticRoute.routeId,
    semanticRoute.buildFormat,
    semanticRoute
  );

  assert.match(executionInput, /Resolved semantic route:/);
  assert.match(executionInput, /- memoryIntent: contextual_recall/);
  assert.match(executionInput, /Contextual recall opportunity \(optional\):/);
  assert.match(executionInput, /older unresolved situation/i);
  assert.match(executionInput, /Relevant situation: Owen fell down/i);
  assert.match(executionInput, /Current user request:/);
  assert.match(executionInput, /User follow-up answer: Owen seems better now\./);
});

test("buildConversationAwareExecutionInput reuses one continuity read session for route-approved contextual recall", async () => {
  const session = buildSession();
  session.conversationTurns.push({
    role: "user",
    text: "Owen fell down a few weeks ago.",
    at: "2026-02-14T15:00:00.000Z"
  });
  session.conversationStack = {
    schemaVersion: "v1",
    updatedAt: "2026-03-03T00:00:00.000Z",
    activeThreadKey: "thread_current",
    threads: [
      {
        threadKey: "thread_current",
        topicKey: "release_rollout",
        topicLabel: "Release Rollout",
        state: "active",
        resumeHint: "Need to finish the rollout.",
        openLoops: [],
        lastTouchedAt: "2026-03-03T00:00:00.000Z"
      },
      {
        threadKey: "thread_owen",
        topicKey: "owen_fall",
        topicLabel: "Owen Fall",
        state: "paused",
        resumeHint: "Owen fell down and you wanted to hear how it ended up.",
        openLoops: [
          {
            loopId: "loop_owen",
            threadKey: "thread_owen",
            entityRefs: ["owen"],
            createdAt: "2026-02-14T15:00:00.000Z",
            lastMentionedAt: "2026-02-14T15:00:00.000Z",
            priority: 0.8,
            status: "open"
          }
        ],
        lastTouchedAt: "2026-02-14T15:00:00.000Z"
      }
    ],
    topics: [
      {
        topicKey: "release_rollout",
        label: "Release Rollout",
        firstSeenAt: "2026-03-03T00:00:00.000Z",
        lastSeenAt: "2026-03-03T00:00:00.000Z",
        mentionCount: 1
      },
      {
        topicKey: "owen_fall",
        label: "Owen Fall",
        firstSeenAt: "2026-02-14T15:00:00.000Z",
        lastSeenAt: "2026-02-14T15:00:00.000Z",
        mentionCount: 1
      }
    ]
  };

  let openedSessions = 0;
  let continuityEpisodeQueries = 0;
  let continuityFactQueries = 0;

  const semanticRoute = buildSemanticRouteFixture({
    routeId: "status_recall",
    executionMode: "status_or_recall",
    continuationKind: "contextual_followup",
    memoryIntent: "contextual_recall"
  });
  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Follow-up user response to prior assistant clarification.\nUser follow-up answer: Owen seems better now.",
    10,
    null,
    "How is Owen doing lately?",
    async () => {
      throw new Error("raw continuity episode callback should not run when a read session is available");
    },
    async () => {
      throw new Error("raw continuity fact callback should not run when a read session is available");
    },
    undefined,
    undefined,
    null,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {
      openedSessions += 1;
      return {
        queryContinuityEpisodes: async () => {
          continuityEpisodeQueries += 1;
          return [
            {
              episodeId: "episode_owen_fall",
              title: "Owen fell down",
              summary: "Owen fell down a few weeks ago and the outcome never got resolved.",
              status: "unresolved",
              lastMentionedAt: "2026-02-14T15:00:00.000Z",
              entityRefs: ["Owen"],
              entityLinks: [
                {
                  entityKey: "entity_owen",
                  canonicalName: "Owen"
                }
              ],
              openLoopLinks: [
                {
                  loopId: "loop_owen",
                  threadKey: "thread_owen",
                  status: "open",
                  priority: 0.8
                }
              ]
            }
          ];
        },
        queryContinuityFacts: async () => {
          continuityFactQueries += 1;
          return [
            {
              factId: "fact_owen_relationship",
              key: "contact.owen.relationship",
              value: "work_peer",
              status: "active",
              observedAt: "2026-02-14T15:00:00.000Z",
              lastUpdatedAt: "2026-02-14T15:00:00.000Z",
              confidence: 0.82
            }
          ];
        }
      };
    },
    undefined,
    semanticRoute.routeId,
    semanticRoute.buildFormat,
    semanticRoute
  );

  assert.equal(openedSessions, 1);
  assert.ok(continuityEpisodeQueries > 0);
  assert.ok(continuityFactQueries > 0);
  assert.match(executionInput, /- memoryIntent: contextual_recall/);
  assert.match(executionInput, /Contextual recall opportunity \(optional\):/);
  assert.match(executionInput, /Relevant situation: Owen fell down/i);
  assert.doesNotMatch(executionInput, /Relationship continuity context:/);
});

test("buildConversationAwareExecutionInput includes natural reuse preference guidance when the user asks to use the same approach", async () => {
  const session = buildSession();
  session.modeContinuity = {
    activeMode: "build",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: "2026-03-03T00:00:25.000Z",
    lastUserInput: "Build the dashboard and leave it open."
  };
  session.recentActions.push({
    id: "action-2",
    kind: "file",
    label: "Dashboard app",
    location: "C:\\Users\\testuser\\Desktop\\123\\dashboard\\index.html",
    status: "created",
    sourceJobId: "job-2",
    at: "2026-03-03T00:00:24.000Z",
    summary: "Created the dashboard."
  });
  session.pathDestinations.push({
    id: "dest-2",
    label: "Previous dashboard folder",
    resolvedPath: "C:\\Users\\testuser\\Desktop\\123\\dashboard",
    sourceJobId: "job-2",
    updatedAt: "2026-03-03T00:00:24.000Z"
  });

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Use the same approach as before and put it in the same place again.",
    10
  );

  assert.match(executionInput, /Natural reuse preference:/);
  assert.match(executionInput, /reuse the same approach, trusted tool, workflow, or destination/i);
  assert.match(executionInput, /Current working mode: build/);
  assert.match(executionInput, /Most recent concrete result: Dashboard app at C:\\Users\\testuser\\Desktop\\123\\dashboard\\index\.html/);
  assert.match(executionInput, /Most recent destination: C:\\Users\\testuser\\Desktop\\123\\dashboard/);
});

test("buildConversationAwareExecutionInput highlights natural artifact-edit follow-ups against the current artifact", async () => {
  const session = buildSession();
  session.recentActions.push({
    id: "action-landing-file",
    kind: "file",
    label: "Landing page file",
    location: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
    status: "created",
    sourceJobId: "job-landing",
    at: "2026-03-03T00:00:24.000Z",
    summary: "Created the landing page."
  });
  session.pathDestinations.push({
    id: "dest-landing-folder",
    label: "Sample company folder",
    resolvedPath: "C:\\Users\\testuser\\Desktop\\sample-company",
    sourceJobId: "job-landing",
    updatedAt: "2026-03-03T00:00:24.000Z"
  });
  session.browserSessions.push(buildConversationBrowserSessionFixture({
    id: "browser_session:landing-page",
    label: "Landing page preview",
    url: "http://127.0.0.1:4173/",
    sourceJobId: "job-landing",
    openedAt: "2026-03-03T00:00:24.000Z"
  }));

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Change the hero image to a slider instead of the landing page.",
    10
  );

  assert.match(executionInput, /Natural artifact-edit follow-up:/);
  assert.match(executionInput, /editing the artifact already created in this chat rather than asking for a brand-new project/i);
  assert.match(executionInput, /Most recent concrete artifact: Landing page file at C:\\Users\\testuser\\Desktop\\sample-company\\index\.html/);
  assert.match(executionInput, /Preferred edit destination: C:\\Users\\testuser\\Desktop\\sample-company/);
  assert.match(executionInput, /Visible preview already exists: http:\/\/127\.0\.0\.1:4173\/; keep the preview aligned/i);
  assert.match(executionInput, /This run must include a real file mutation under the tracked workspace/i);
  assert.match(executionInput, /Do not satisfy this request by only reopening, focusing, or closing the preview/i);
});

test("buildConversationAwareExecutionInput prioritizes tracked file actions ahead of browser sessions for artifact edits", async () => {
  const session = buildSession();
  session.recentActions.push({
    id: "action-browser",
    kind: "browser_session",
    label: "Browser window",
    location: "http://127.0.0.1:4173/",
    status: "open",
    sourceJobId: "job-landing",
    at: "2026-03-03T00:00:30.000Z",
    summary: "Left the preview open."
  });
  session.recentActions.push({
    id: "action-script",
    kind: "file",
    label: "File script.js",
    location: "C:\\Users\\testuser\\Desktop\\sample-company\\script.js",
    status: "updated",
    sourceJobId: "job-landing",
    at: "2026-03-03T00:00:29.000Z",
    summary: "Updated script.js."
  });
  session.recentActions.push({
    id: "action-styles",
    kind: "file",
    label: "File styles.css",
    location: "C:\\Users\\testuser\\Desktop\\sample-company\\styles.css",
    status: "updated",
    sourceJobId: "job-landing",
    at: "2026-03-03T00:00:28.000Z",
    summary: "Updated styles.css."
  });
  session.recentActions.push({
    id: "action-index",
    kind: "file",
    label: "File index.html",
    location: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
    status: "updated",
    sourceJobId: "job-landing",
    at: "2026-03-03T00:00:27.000Z",
    summary: "Updated index.html."
  });
  session.pathDestinations.push({
    id: "dest-script",
    label: "Sample company script",
    resolvedPath: "C:\\Users\\testuser\\Desktop\\sample-company\\script.js",
    sourceJobId: "job-landing",
    updatedAt: "2026-03-03T00:00:29.000Z"
  });
  session.browserSessions.push(buildConversationBrowserSessionFixture({
    id: "browser_session:landing-page",
    label: "Landing page preview",
    url: "http://127.0.0.1:4173/",
    sourceJobId: "job-landing",
    openedAt: "2026-03-03T00:00:30.000Z"
  }));

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Change the hero image to a slider instead of the landing page.",
    10
  );

  assert.match(executionInput, /Recent user-visible actions in this chat:\n- File script\.js: C:\\Users\\testuser\\Desktop\\sample-company\\script\.js \(updated\)\n- File styles\.css: C:\\Users\\testuser\\Desktop\\sample-company\\styles\.css \(updated\)\n- File index\.html: C:\\Users\\testuser\\Desktop\\sample-company\\index\.html \(updated\)/);
  assert.match(executionInput, /Most recent concrete artifact: File script\.js at C:\\Users\\testuser\\Desktop\\sample-company\\script\.js/);
});

test("buildConversationAwareExecutionInput highlights natural browser close follow-ups against tracked sessions", async () => {
  const session = buildSession();
  session.browserSessions.push(buildConversationBrowserSessionFixture({
    id: "browser_session:landing-page",
    label: "Landing page preview",
    url: "http://127.0.0.1:4173/",
    sourceJobId: "job-landing",
    openedAt: "2026-03-03T00:00:24.000Z",
    linkedProcessLeaseId: "proc_preview_1",
    linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company"
  }));

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Close the landing page so we can work on something else.",
    10
  );

  assert.match(executionInput, /Natural browser-session follow-up:/);
  assert.match(executionInput, /Preferred browser session: Landing page preview; sessionId=browser_session:landing-page; url=http:\/\/127\.0\.0\.1:4173\/; status=open; control=available/);
  assert.match(executionInput, /Linked preview process: leaseId=proc_preview_1; cwd=C:\\Users\\testuser\\Desktop\\sample-company/);
  assert.match(executionInput, /prefer close_browser with params\.sessionId=browser_session:landing-page and then stop_process with params\.leaseId=proc_preview_1/i);
});

test("buildConversationAwareExecutionInput instructs close follow-ups to stop every exact tracked preview lease for the workspace", async () => {
  const session = buildSession();
  session.browserSessions.push(buildConversationBrowserSessionFixture({
    id: "browser_session:ai-sample-city",
    label: "Sample City preview",
    url: "http://127.0.0.1:4173/",
    sourceJobId: "job-ai-sample-city",
    openedAt: "2026-03-03T00:00:24.000Z",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\Sample City",
    linkedProcessLeaseId: "proc_preview_2",
    linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\Sample City"
  }));
  session.activeWorkspace = {
    id: "workspace:ai-sample-city",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\Sample City",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\Sample City\\package.json",
    previewUrl: "http://127.0.0.1:4173/",
    browserSessionId: "browser_session:ai-sample-city",
    browserSessionIds: ["browser_session:ai-sample-city"],
    browserSessionStatus: "open",
    browserProcessPid: 41001,
    previewProcessLeaseId: "proc_preview_2",
    previewProcessLeaseIds: ["proc_preview_2", "proc_preview_1"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\Sample City",
    lastKnownPreviewProcessPid: 4002,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_and_preview",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\Sample City\\package.json"],
    sourceJobId: "job-ai-sample-city",
    updatedAt: "2026-03-03T00:00:24.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Thanks. Please close Sample City and anything it needs so we can move on.",
    10
  );

  assert.match(executionInput, /Exact tracked preview process leases for this workspace: proc_preview_2, proc_preview_1/);
  assert.match(executionInput, /prefer close_browser with params\.sessionId=browser_session:ai-sample-city and then stop each exact tracked preview lease for this workspace: stop_process with params\.leaseId=proc_preview_2, then stop_process with params\.leaseId=proc_preview_1/i);
});

test("buildConversationAwareExecutionInput treats closing a named tracked workspace as a browser close follow-up", async () => {
  const session = buildSession();
  session.browserSessions.push(buildConversationBrowserSessionFixture({
    id: "browser_session:ai-sample-city",
    label: "Sample City preview",
    url: "file:///C:/Users/testuser/Desktop/AI%20Sample%20City/dist/index.html",
    sourceJobId: "job-ai-sample-city",
    openedAt: "2026-03-03T00:00:24.000Z",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\Sample City\\dist"
  }));
  session.activeWorkspace = {
    id: "workspace:ai-sample-city",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\Sample City\\dist",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\Sample City\\dist\\index.html",
    previewUrl: "file:///C:/Users/testuser/Desktop/AI%20Sample%20City/dist/index.html",
    browserSessionId: "browser_session:ai-sample-city",
    browserSessionIds: ["browser_session:ai-sample-city"],
    browserSessionStatus: "open",
    browserProcessPid: 41001,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\Sample City\\dist",
    lastKnownPreviewProcessPid: null,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_only",
    lastChangedPaths: [],
    sourceJobId: "job-ai-sample-city",
    updatedAt: "2026-03-03T00:00:24.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Thanks. Please close Sample City and anything it needs so we can move on.",
    10
  );

  assert.match(executionInput, /Natural browser-session follow-up:/);
  assert.match(executionInput, /Preferred browser session: Sample City preview; sessionId=browser_session:ai-sample-city/i);
  assert.match(executionInput, /prefer close_browser with params\.sessionId=browser_session:ai-sample-city/i);
});

test("buildConversationAwareExecutionInput frames exact local static artifact reopen turns as browser-open follow-ups instead of build continuity", async () => {
  const session = buildSession();
  session.modeContinuity = {
    activeMode: "build",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: "2026-04-14T01:31:30.000Z",
    lastUserInput:
      'Create the landing page in "C:\\Users\\testuser\\Desktop\\Sample Service Landing Page" and do not open it yet.'
  };
  session.returnHandoff = {
    id: "handoff:sample-static-build",
    status: "completed",
    goal:
      'Create the landing page in "C:\\Users\\testuser\\Desktop\\Sample Service Landing Page" and do not open it yet.',
    summary:
      "I created or updated C:\\Users\\testuser\\Desktop\\Sample Service Landing Page\\index.html.",
    nextSuggestedStep: "Open the exact local file when the user asks.",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\Sample Service Landing Page",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\Sample Service Landing Page\\index.html",
    previewUrl: null,
    changedPaths: ["C:\\Users\\testuser\\Desktop\\Sample Service Landing Page\\index.html"],
    sourceJobId: "job-sample-static-build",
    updatedAt: "2026-04-14T01:33:57.677Z"
  };
  session.activeWorkspace = {
    id: "workspace:sample-static",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\Sample Service Landing Page",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\Sample Service Landing Page\\index.html",
    previewUrl: null,
    browserSessionId: null,
    browserSessionIds: [],
    browserSessionStatus: null,
    browserProcessPid: null,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: null,
    lastKnownPreviewProcessPid: null,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\Sample Service Landing Page\\index.html"],
    sourceJobId: "job-sample-static-build",
    updatedAt: "2026-04-14T01:33:57.677Z"
  };
  session.recentActions.push({
    id: "action-sample-static-index",
    kind: "file",
    label: "File index.html",
    location: "C:\\Users\\testuser\\Desktop\\Sample Service Landing Page\\index.html",
    status: "updated",
    sourceJobId: "job-sample-static-build",
    at: "2026-04-14T01:33:57.677Z",
    summary: "Wrote the static landing page."
  });

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Once you're done with the landing page, open it in the browser so I can see it. Use the exact local file at \"C:\\Users\\testuser\\Desktop\\Sample Service Landing Page\\index.html\". Do not start a dev server. Open the local static file directly with a file URL and leave that exact page open.",
    10
  );

  assert.match(executionInput, /Existing local static-artifact open follow-up:/);
  assert.match(
    executionInput,
    /Preferred artifact path: C:\\Users\\testuser\\Desktop\\Sample Service Landing Page\\index\.html/
  );
  assert.match(
    executionInput,
    /Preferred browser target: file:\/\/\/C:\/Users\/testuser\/Desktop\/Sample%20Service%20Landing%20Page\/index\.html/
  );
  assert.match(
    executionInput,
    /Prefer open_browser with params\.url=file:\/\/\/C:\/Users\/testuser\/Desktop\/Sample%20Service%20Landing%20Page\/index\.html and params\.rootPath=C:\\Users\\testuser\\Desktop\\Sample Service Landing Page\./
  );
  assert.match(
    executionInput,
    /Do not create, scaffold, edit, or rewrite project files for this turn unless the user explicitly asks for content changes\./
  );
  assert.match(
    executionInput,
    /The current turn explicitly forbids starting a dev or preview server, so do not use start_process, probe_http, or localhost verification for this open request\./
  );
  assert.doesNotMatch(executionInput, /Current working mode from earlier in this chat:/);
  assert.doesNotMatch(executionInput, /Latest durable work handoff in this chat:/);
  assert.match(executionInput, /Current tracked workspace in this chat:/);
  assert.match(executionInput, /Recent user-visible actions in this chat:/);
});

test("buildConversationAwareExecutionInput does not treat keep the page open as a reopen request during normal conversation", async () => {
  const session = buildSession();
  session.browserSessions.push(buildConversationBrowserSessionFixture({
    id: "browser_session:ai-sample-city",
    label: "Sample City preview",
    url: "file:///C:/Users/testuser/Desktop/AI%20Sample%20City/dist/index.html",
    sourceJobId: "job-ai-sample-city",
    openedAt: "2026-03-03T00:00:24.000Z",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\Sample City"
  }));
  session.activeWorkspace = {
    id: "workspace:ai-sample-city",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\Sample City",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\Sample City\\package.json",
    previewUrl: "file:///C:/Users/testuser/Desktop/AI%20Sample%20City/dist/index.html",
    browserSessionId: "browser_session:ai-sample-city",
    browserSessionIds: ["browser_session:ai-sample-city"],
    browserSessionStatus: "open",
    browserProcessPid: 41001,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\Sample City",
    lastKnownPreviewProcessPid: null,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_only",
    lastChangedPaths: [
      "C:\\Users\\testuser\\Desktop\\Sample City\\package.json",
      "C:\\Users\\testuser\\Desktop\\Sample City"
    ],
    sourceJobId: "job-ai-sample-city",
    updatedAt: "2026-03-03T00:00:24.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Looks good. Before changing anything, just talk with me for a minute about what makes Sample City feel playful. Reply in two short paragraphs and keep the page open.",
    10
  );

  assert.doesNotMatch(executionInput, /Natural browser-session follow-up:/);
});

test("buildConversationAwareExecutionInput prefers stop_process first when live browser control is unavailable after restart churn", async () => {
  const session = buildSession();
  session.browserSessions.push({
    id: "browser_session:landing-page",
    label: "Landing page preview",
    url: "http://127.0.0.1:4173/",
    visibility: "visible",
    status: "open",
    sourceJobId: "job-landing",
    openedAt: "2026-03-03T00:00:24.000Z",
    closedAt: null,
    controllerKind: "playwright_managed",
    controlAvailable: true,
    browserProcessPid: 41001,
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
    linkedProcessLeaseId: "proc_preview_1",
    linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company",
    linkedProcessPid: 4001
  });
  session.activeWorkspace = {
    id: "workspace:landing-page",
    label: "Landing page workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
    previewUrl: "http://127.0.0.1:4173/",
    browserSessionId: "browser_session:landing-page",
    browserSessionIds: ["browser_session:landing-page"],
    browserSessionStatus: "open",
    browserProcessPid: 41001,
    previewProcessLeaseId: "proc_preview_1",
    previewProcessLeaseIds: ["proc_preview_1"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company",
    lastKnownPreviewProcessPid: 4001,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_and_preview",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
    sourceJobId: "job-landing",
    updatedAt: "2026-03-03T00:00:24.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Close the landing page so we can move on.",
    10,
    null,
    null,
    undefined,
    undefined,
    null,
    [
      {
        leaseId: "proc_preview_1",
        taskId: "task-preview",
        actionId: "action-preview",
        pid: 4001,
        commandFingerprint: "python-http-server",
        cwd: "C:\\Users\\testuser\\Desktop\\sample-company",
        shellExecutable: "powershell.exe",
        shellKind: "powershell",
    requestedHost: null,
    requestedPort: null,
    requestedUrl: null,
    startedAt: "2026-03-03T00:00:20.000Z",
        statusCode: "PROCESS_STILL_RUNNING",
        exitCode: null,
        signal: null,
        stopRequested: false
      }
    ],
    null,
    [
      {
        sessionId: "browser_session:landing-page",
        url: "http://127.0.0.1:4173/",
        status: "open",
        openedAt: "2026-03-03T00:00:24.000Z",
        closedAt: null,
        visibility: "visible",
        controllerKind: "playwright_managed",
        controlAvailable: false,
        browserProcessPid: null,
        workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
        linkedProcessLeaseId: "proc_preview_1",
        linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company",
        linkedProcessPid: 4001
      }
    ]
  );

  assert.match(executionInput, /Current tracked workspace in this chat:/);
  assert.match(executionInput, /Still controllable: yes/);
  assert.match(executionInput, /Ownership state: tracked/);
  assert.match(executionInput, /Preferred browser session: Landing page preview; sessionId=browser_session:landing-page; url=http:\/\/127\.0\.0\.1:4173\/; status=open; control=unavailable/);
  assert.match(executionInput, /prefer stop_process with params\.leaseId=proc_preview_1 first/i);
  assert.match(executionInput, /only use close_browser with params\.sessionId=browser_session:landing-page if the runtime still proves direct browser control afterward/i);
});

test("buildConversationAwareExecutionInput does not inject tracked browser follow-up guidance when the user names a different explicit localhost URL", async () => {
  const session = buildSession();
  session.browserSessions.push({
    id: "browser_session:landing-page",
    label: "Landing page preview",
    url: "http://127.0.0.1:4173/",
    visibility: "visible",
    status: "closed",
    sourceJobId: "job-landing",
    openedAt: "2026-03-03T00:00:24.000Z",
    closedAt: "2026-03-03T00:01:10.000Z",
    controllerKind: "playwright_managed",
    controlAvailable: false,
    browserProcessPid: 41001,
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
    linkedProcessLeaseId: "proc_preview_1",
    linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company",
    linkedProcessPid: 4001
  });
  session.activeWorkspace = {
    id: "workspace:sample-company",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
    previewUrl: "http://127.0.0.1:4173/",
    browserSessionId: "browser_session:landing-page",
    browserSessionIds: ["browser_session:landing-page"],
    browserSessionStatus: "closed",
    browserProcessPid: 41001,
    previewProcessLeaseId: "proc_preview_1",
    previewProcessLeaseIds: ["proc_preview_1"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company",
    lastKnownPreviewProcessPid: 4001,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
    sourceJobId: "job-landing",
    updatedAt: "2026-03-03T00:01:10.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Please close http://127.0.0.1:59999/index.html only if it is actually the page from this project.",
    10
  );

  assert.doesNotMatch(executionInput, /Natural browser-session follow-up:/);
});

test("buildConversationAwareExecutionInput does not treat a stale detached closed preview as the preferred reopen target for a new React workspace", async () => {
  const session = buildSession();
  session.browserSessions.push({
    id: "browser_session:old-static-preview",
    label: "Older static landing page",
    url: "file:///C:/Users/testuser/Desktop/sample-company-landing.html",
    visibility: "visible",
    status: "closed",
    sourceJobId: "job-old-static-preview",
    openedAt: "2026-03-03T00:00:18.000Z",
    closedAt: "2026-03-03T00:00:22.000Z",
    controllerKind: "playwright_managed",
    controlAvailable: false,
    browserProcessPid: 41001,
    workspaceRootPath: "C:\\Users\\testuser\\Desktop",
    linkedProcessLeaseId: null,
    linkedProcessCwd: "C:\\Users\\testuser\\Desktop",
    linkedProcessPid: null
  });
  session.activeWorkspace = {
    id: "workspace:new-react-project",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\React Landing Page",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\React Landing Page\\src\\App.jsx",
    previewUrl: null,
    browserSessionId: null,
    browserSessionIds: [],
    browserSessionStatus: null,
    browserProcessPid: null,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\React Landing Page",
    lastKnownPreviewProcessPid: null,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: [
      "C:\\Users\\testuser\\Desktop\\React Landing Page\\src\\App.jsx",
      "C:\\Users\\testuser\\Desktop\\React Landing Page\\src\\index.css"
    ],
    sourceJobId: "job-react-workspace-reset",
    updatedAt: "2026-03-03T00:00:30.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Open both of the landing pages that you just designed in React so I can compare them.",
    10
  );

  assert.match(executionInput, /Current tracked workspace in this chat:/);
  assert.match(executionInput, /Root path: C:\\Users\\testuser\\Desktop\\React Landing Page/);
  assert.doesNotMatch(executionInput, /Natural browser-session follow-up:/);
  assert.doesNotMatch(
    executionInput,
    /prefer open_browser with params\.url=file:\/\/\/C:\/Users\/testuser\/Desktop\/sample-company-landing\.html/i
  );
});

test("buildConversationAwareExecutionInput surfaces exact tracked workspace recovery affordances for local organization requests", async () => {
  const session = buildSession();
  session.browserSessions.push(buildConversationBrowserSessionFixture({
    id: "browser_session:sample-preview",
    label: "Sample preview",
    url: "http://127.0.0.1:4173/",
    sourceJobId: "job-sample",
    openedAt: "2026-03-03T00:00:24.000Z",
    linkedProcessLeaseId: "proc_preview_sample",
    linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1"
  }));
  session.activeWorkspace = {
    id: "workspace:sample-company",
    label: "Sample company project",
    rootPath: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1\\index.html",
    previewUrl: "http://127.0.0.1:4173/",
    browserSessionId: "browser_session:sample-preview",
    browserSessionIds: ["browser_session:sample-preview"],
    browserSessionStatus: "open",
    browserProcessPid: 41001,
    previewProcessLeaseId: "proc_preview_sample",
    previewProcessLeaseIds: ["proc_preview_sample"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1",
    lastKnownPreviewProcessPid: 4001,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_and_preview",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1\\index.html"],
    sourceJobId: "job-sample",
    updatedAt: "2026-03-03T00:00:24.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects.",
    10,
    null,
    null,
    undefined,
    undefined,
    null,
    [
      {
        leaseId: "proc_preview_sample",
        taskId: "task-1",
        actionId: "action-1",
        pid: 4001,
        commandFingerprint: "python-http-server",
        cwd: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1",
        shellExecutable: "powershell.exe",
        shellKind: "powershell",
    requestedHost: null,
    requestedPort: null,
    requestedUrl: null,
    startedAt: "2026-03-03T00:00:10.000Z",
        statusCode: "PROCESS_STILL_RUNNING",
        exitCode: null,
        signal: null,
        stopRequested: false
      }
    ]
  );

  assert.match(executionInput, /Workspace recovery context for this chat:/);
  assert.match(executionInput, /Preferred workspace root: C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1/);
  assert.match(executionInput, /Exact tracked browser session ids: browser_session:sample-preview/);
  assert.match(executionInput, /Exact tracked preview lease ids: proc_preview_sample/);
  assert.match(executionInput, /leaseId=proc_preview_sample; cwd=C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1; status=PROCESS_STILL_RUNNING; stopRequested=no/);
  assert.match(executionInput, /inspect_workspace_resources first with the preferred workspace root/i);
  assert.match(executionInput, /stop only those exact lease ids with stop_process/i);
});

test("buildConversationAwareExecutionInput distinguishes remembered preview lease ids from live tracked ones when the workspace is stale", async () => {
  const session = buildSession();
  session.activeWorkspace = {
    id: "workspace:sample-company-stale",
    label: "Sample company project",
    rootPath: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1\\index.html",
    previewUrl: "http://127.0.0.1:4173/",
    browserSessionId: "browser_session:sample-preview",
    browserSessionIds: ["browser_session:sample-preview"],
    browserSessionStatus: "closed",
    browserProcessPid: 41001,
    previewProcessLeaseId: "proc_preview_sample_old",
    previewProcessLeaseIds: ["proc_preview_sample_old"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1",
    lastKnownPreviewProcessPid: 4001,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1\\index.html"],
    sourceJobId: "job-sample-old",
    updatedAt: "2026-03-03T00:00:24.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects.",
    10,
    null,
    null,
    undefined,
    undefined,
    null,
    [
      {
        leaseId: "proc_preview_sample_old",
        taskId: "task-old-sample",
        actionId: "action-old-sample",
        pid: 4001,
        commandFingerprint: "python-http-server",
        cwd: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1",
        shellExecutable: "powershell.exe",
        shellKind: "powershell",
    requestedHost: null,
    requestedPort: null,
    requestedUrl: null,
    startedAt: "2026-03-03T00:00:10.000Z",
        statusCode: "PROCESS_STOPPED",
        exitCode: 0,
        signal: null,
        stopRequested: true
      }
    ]
  );

  assert.match(executionInput, /Workspace recovery context for this chat:/);
  assert.match(
    executionInput,
    /Remembered preview lease ids from earlier assistant work: proc_preview_sample_old/
  );
  assert.match(
    executionInput,
    /Remembered preview lease status from earlier assistant work:\n- leaseId=proc_preview_sample_old; cwd=C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1; status=PROCESS_STOPPED; stopRequested=yes/
  );
  assert.doesNotMatch(executionInput, /Exact tracked preview lease ids: proc_preview_sample_old/);
  assert.match(
    executionInput,
    /If no exact tracked holder is proven, inspect first and then clarify before touching untracked local processes\./
  );
});

test("buildConversationAwareExecutionInput surfaces matching runtime preview leases for local organization requests", async () => {
  const session = buildSession();

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects.",
    10,
    null,
    null,
    undefined,
    undefined,
    null,
    [
      {
        leaseId: "proc_sample_1",
        taskId: "task-1",
        actionId: "action-1",
        pid: 4001,
        commandFingerprint: "python-http-server",
        cwd: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1",
        shellExecutable: "powershell.exe",
        shellKind: "powershell",
    requestedHost: null,
    requestedPort: null,
    requestedUrl: null,
    startedAt: "2026-03-03T00:00:10.000Z",
        statusCode: "PROCESS_STILL_RUNNING",
        exitCode: null,
        signal: null,
        stopRequested: false
      },
      {
        leaseId: "proc_other_1",
        taskId: "task-2",
        actionId: "action-2",
        pid: 4002,
        commandFingerprint: "python-http-server",
        cwd: "C:\\Users\\testuser\\Desktop\\totally-different-project",
        shellExecutable: "powershell.exe",
        shellKind: "powershell",
    requestedHost: null,
    requestedPort: null,
    requestedUrl: null,
    startedAt: "2026-03-03T00:00:11.000Z",
        statusCode: "PROCESS_STILL_RUNNING",
        exitCode: null,
        signal: null,
        stopRequested: false
      }
    ]
  );

  assert.match(executionInput, /Workspace recovery context for this chat:/);
  assert.match(executionInput, /No exact tracked workspace holder is currently known for this request\./);
  assert.match(executionInput, /Candidate runtime-managed preview lease: leaseId=proc_sample_1; cwd=C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1; status=PROCESS_STILL_RUNNING; stopRequested=no/);
  assert.doesNotMatch(executionInput, /proc_other_1/);
  assert.match(executionInput, /Prefer inspect_workspace_resources or inspect_path_holders before any shutdown/i);
  assert.match(executionInput, /Do not stop those candidate preview leases directly from this hint block alone/i);
});

test("buildConversationAwareExecutionInput surfaces attributable remembered roots before looser organization hints", async () => {
  const session = buildSession();
  session.pathDestinations.push(
    {
      id: "dest-sample-folder",
      label: "Sample company folder",
      resolvedPath: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1",
      sourceJobId: "job-sample-1",
      updatedAt: "2026-03-03T00:00:20.000Z"
    },
    {
      id: "dest-sample-file",
      label: "Sample company index",
      resolvedPath: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-2\\index.html",
      sourceJobId: "job-sample-2",
      updatedAt: "2026-03-03T00:00:21.000Z"
    }
  );
  session.browserSessions.push({
    id: "browser_session:sample-old",
    label: "Older sample preview",
    url: "http://127.0.0.1:4175/",
    visibility: "visible",
    status: "closed",
    sourceJobId: "job-sample-1",
    openedAt: "2026-03-03T00:00:10.000Z",
    closedAt: "2026-03-03T00:00:30.000Z",
    controllerKind: "playwright_managed",
    controlAvailable: false,
    browserProcessPid: null,
    linkedProcessLeaseId: "proc_sample_old",
    linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1",
    linkedProcessPid: 4001
  });

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects.",
    10,
    null,
    null,
    undefined,
    undefined,
    null,
    [
      {
        leaseId: "proc_sample_old",
        taskId: "task-old-sample",
        actionId: "action-old-sample",
        pid: 4001,
        commandFingerprint: "python-http-server",
        cwd: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1",
        shellExecutable: "powershell.exe",
        shellKind: "powershell",
    requestedHost: null,
    requestedPort: null,
    requestedUrl: null,
    startedAt: "2026-03-03T00:00:10.000Z",
        statusCode: "PROCESS_STOPPED",
        exitCode: 0,
        signal: null,
        stopRequested: true
      }
    ]
  );

  assert.match(executionInput, /Workspace recovery context for this chat:/);
  assert.match(executionInput, /No exact tracked workspace holder is currently known for this request\./);
  assert.match(executionInput, /Attributable workspace roots already remembered in this chat:/);
  assert.match(executionInput, /root=C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1; reason=remembered destination/);
  assert.match(executionInput, /root=C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-2; reason=remembered destination/);
  assert.match(executionInput, /Attributable remembered preview lease: leaseId=proc_sample_old; cwd=C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-1; status=PROCESS_STOPPED; stopRequested=yes/);
  assert.match(executionInput, /inspect_path_holders or inspect_workspace_resources against these exact remembered roots first/i);
});

test("buildConversationAwareExecutionInput surfaces durable handoff and remembered browser workspace roots for older organization follow-ups", async () => {
  const session = buildSession();
  session.returnHandoff = {
    id: "handoff:sample-older-work",
    status: "completed",
    goal: "Finish the older sample-company draft and leave it ready for review.",
    summary: "I finished the older sample-company draft and saved the review checkpoint.",
    nextSuggestedStep: "Tell me what section to refine next.",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company-older-1",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company-older-1\\index.html",
    previewUrl: "file:///C:/Users/testuser/Desktop/sample-company-older-1/index.html",
    changedPaths: [
      "C:\\Users\\testuser\\Desktop\\sample-company-older-2\\styles.css"
    ],
    sourceJobId: "job-sample-older",
    updatedAt: "2026-03-03T00:00:22.000Z"
  };
  session.browserSessions.push({
    id: "browser_session:sample-older-detached",
    label: "Older detached sample preview",
    url: "file:///C:/Users/testuser/Desktop/sample-company-older-3/index.html",
    visibility: "visible",
    status: "open",
    sourceJobId: "job-sample-older",
    openedAt: "2026-03-03T00:00:21.000Z",
    closedAt: null,
    controllerKind: "os_default",
    controlAvailable: false,
    browserProcessPid: null,
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company-older-3",
    linkedProcessLeaseId: null,
    linkedProcessCwd: null,
    linkedProcessPid: null
  });

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects.",
    10
  );

  assert.match(executionInput, /Workspace recovery context for this chat:/);
  assert.match(executionInput, /No exact tracked workspace holder is currently known for this request\./);
  assert.match(
    executionInput,
    /root=C:\\Users\\testuser\\Desktop\\sample-company-older-1; reason=durable handoff workspace/
  );
  assert.match(
    executionInput,
    /root=C:\\Users\\testuser\\Desktop\\sample-company-older-2; reason=durable handoff changed file/
  );
  assert.match(
    executionInput,
    /root=C:\\Users\\testuser\\Desktop\\sample-company-older-3; reason=remembered browser workspace/
  );
  assert.match(executionInput, /inspect_path_holders or inspect_workspace_resources against these exact remembered roots first/i);
});

test("buildConversationAwareExecutionInput includes destination memory for same-place follow-ups", async () => {
  const session = buildSession();
  session.pathDestinations.push({
    id: "dest-3",
    label: "Desktop 123 folder",
    resolvedPath: "C:\\Users\\testuser\\Desktop\\123",
    sourceJobId: "job-3",
    updatedAt: "2026-03-03T00:00:20.000Z"
  });

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Put it in the same place as before and leave it open for me.",
    10
  );

  assert.match(executionInput, /Remembered save\/open locations from this chat:/);
  assert.match(executionInput, /Desktop 123 folder: C:\\Users\\testuser\\Desktop\\123/);
  assert.match(executionInput, /prefer these remembered destinations before guessing a new path/i);
});

test("buildConversationAwareExecutionInput explains when the remembered workspace is stale or orphaned", async () => {
  const session = buildSession();
  session.pathDestinations.push({
    id: "dest-4",
    label: "Desktop sample folder",
    resolvedPath: "C:\\Users\\testuser\\Desktop\\sample-folder",
    sourceJobId: "job-4",
    updatedAt: "2026-03-03T00:00:25.000Z"
  });
  session.activeWorkspace = {
    id: "workspace:sample-folder",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\sample-folder",
    primaryArtifactPath: null,
    previewUrl: "file:///C:/Users/testuser/Desktop/sample-folder/index.html",
    browserSessionId: "browser-detached-1",
    browserSessionIds: ["browser-detached-1"],
    browserSessionStatus: "open",
    browserProcessPid: null,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: null,
    lastKnownPreviewProcessPid: null,
    stillControllable: false,
    ownershipState: "orphaned",
    previewStackState: "browser_only",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\sample-folder\\index.html"],
    sourceJobId: "job-4",
    updatedAt: "2026-03-03T00:00:25.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Put it in the same place as before and leave it open for me.",
    10
  );

  assert.match(executionInput, /Remembered save\/open locations from this chat:/);
  assert.match(executionInput, /The most recent workspace in this chat is orphaned at C:\\Users\\testuser\\Desktop\\sample-folder/i);
  assert.match(executionInput, /require fresh inspection before assuming preview or process control still exists/i);
});

test("buildConversationAwareExecutionInput grounds the Telegram desktop cleanup wording as a real move", async () => {
  const session = buildSession();
  session.activeWorkspace = {
    id: "workspace:sample-company-live-smoke-9",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-9",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-9\\index.html",
    previewUrl: "file:///C:/Users/testuser/Desktop/sample-company-live-smoke-9/index.html",
    browserSessionId: "browser-detached-cleanup-1",
    browserSessionIds: ["browser-detached-cleanup-1"],
    browserSessionStatus: "closed",
    browserProcessPid: null,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: null,
    lastKnownPreviewProcessPid: null,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: [
      "C:\\Users\\testuser\\Desktop\\sample-company-live-smoke-9\\index.html"
    ],
    sourceJobId: "job-cleanup-1",
    updatedAt: "2026-03-03T00:00:25.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "One last real-world thing: please go ahead and clean up my desktop now by moving every folder there that starts with sample-company into sample-folder. I do mean all of them, so you do not need to ask again before doing it.",
    10
  );

  assert.match(executionInput, /Natural desktop-organization follow-up:/);
  assert.match(executionInput, /real Desktop folder move, not just an inspection or summary/i);
  assert.match(executionInput, /Strongest remembered Desktop root in this chat: C:\\Users\\testuser\\Desktop/i);
  assert.match(executionInput, /Treat the named destination as C:\\Users\\testuser\\Desktop\\sample-folder/i);
  assert.match(executionInput, /Match Desktop folders whose names start with sample-company\./i);
  assert.match(
    executionInput,
    /The current tracked workspace folder sample-company-live-smoke-9 also matches that requested prefix; include it in the move unless the user explicitly excluded it\./i
  );
  assert.match(executionInput, /The user explicitly authorized moving all matching folders now; do not ask again before executing the move unless a new blocker appears\./i);
  assert.match(executionInput, /This run must include a real folder move side effect\./i);
});

test("buildConversationAwareExecutionInput grounds exact-name Desktop cleanup follow-ups", async () => {
  const session = buildSession();
  session.activeWorkspace = {
    id: "workspace:agentbigbrain-static-html-smoke-1234",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\agentbigbrain-static-html-smoke-1234",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\agentbigbrain-static-html-smoke-1234\\index.html",
    previewUrl: "file:///C:/Users/testuser/Desktop/agentbigbrain-static-html-smoke-1234/index.html",
    browserSessionId: "browser-exact-cleanup-1",
    browserSessionIds: ["browser-exact-cleanup-1"],
    browserSessionStatus: "closed",
    browserProcessPid: null,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: null,
    lastKnownPreviewProcessPid: null,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: [
      "C:\\Users\\testuser\\Desktop\\agentbigbrain-static-html-smoke-1234\\index.html"
    ],
    sourceJobId: "job-cleanup-exact",
    updatedAt: "2026-03-03T00:00:25.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "One last real-world thing: please go ahead and clean up my desktop now by moving only the folder named agentbigbrain-static-html-smoke-1234 into sample-folder. Do not move any other desktop folders, and you do not need to ask again before doing it.",
    10
  );

  assert.match(executionInput, /Natural desktop-organization follow-up:/);
  assert.match(executionInput, /Treat the named destination as C:\\Users\\testuser\\Desktop\\sample-folder/i);
  assert.match(
    executionInput,
    /Move exactly the Desktop folder named agentbigbrain-static-html-smoke-1234; do not move sibling folders/i
  );
  assert.match(
    executionInput,
    /current tracked workspace folder agentbigbrain-static-html-smoke-1234 exactly matches the requested folder name/i
  );
  assert.match(executionInput, /This run must include a real folder move side effect\./i);
});

test("buildConversationAwareExecutionInput grounds broad Desktop cleanup for matching files and folders", async () => {
  const session = buildSession();
  session.modeContinuity = {
    activeMode: "build",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: "2026-03-03T00:00:24.000Z",
    lastUserInput: "Build the sample React app and leave it open in the browser."
  };
  session.returnHandoff = {
    id: "handoff:sample-react-live-smoke-2",
    status: "completed",
    goal: "Build the sample React app and leave it open in the browser.",
    summary: "I built the app and left the preview open.",
    nextSuggestedStep: "Tell me what to change next.",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-react-live-smoke-2",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-react-live-smoke-2\\package.json",
    previewUrl: "http://127.0.0.1:4173/",
    changedPaths: [
      "C:\\Users\\testuser\\Desktop\\sample-react-live-smoke-2\\package.json"
    ],
    sourceJobId: "job-cleanup-2",
    updatedAt: "2026-03-03T00:00:25.000Z"
  };
  session.activeWorkspace = {
    id: "workspace:sample-react-live-smoke-2",
    label: "Sample React workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\sample-react-live-smoke-2",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-react-live-smoke-2\\package.json",
    previewUrl: "http://127.0.0.1:4173/",
    browserSessionId: "browser-detached-cleanup-2",
    browserSessionIds: ["browser-detached-cleanup-2"],
    browserSessionStatus: "closed",
    browserProcessPid: null,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: null,
    lastKnownPreviewProcessPid: null,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: [
      "C:\\Users\\testuser\\Desktop\\sample-react-live-smoke-2\\package.json"
    ],
    sourceJobId: "job-cleanup-2",
    updatedAt: "2026-03-03T00:00:25.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    'Please put every file and folder on my desktop with the word "sample" into a folder called sample-dump.',
    10
  );

  assert.match(executionInput, /Natural desktop-organization follow-up:/);
  assert.match(executionInput, /real Desktop file-and-folder move, not just an inspection or summary/i);
  assert.match(executionInput, /Strongest remembered Desktop root in this chat: C:\\Users\\testuser\\Desktop/i);
  assert.match(executionInput, /Treat the named destination as C:\\Users\\testuser\\Desktop\\sample-dump/i);
  assert.match(executionInput, /Match Desktop files and folders whose names contain the word sample\./i);
  assert.match(
    executionInput,
    /The current tracked workspace folder sample-react-live-smoke-2 also matches that requested word rule; include it in the move unless the user explicitly excluded it\./i
  );
  assert.match(
    executionInput,
    /This run must include a real Desktop move side effect for matching files and folders\./i
  );
  assert.doesNotMatch(executionInput, /Current working mode from earlier in this chat:/);
  assert.doesNotMatch(executionInput, /Latest durable work handoff in this chat:/);
  assert.doesNotMatch(executionInput, /Current tracked workspace in this chat:/);
  assert.doesNotMatch(executionInput, /Tracked browser sessions:/);
});

test("buildConversationAwareExecutionInput does not misread start-to-finish phrasing as the desktop destination folder", async () => {
  const session = buildSession();
  session.modeContinuity = {
    activeMode: "build",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: "2026-03-03T00:00:24.000Z",
    lastUserInput: "Please build a small sample project in a folder called sample-company-organize-smoke-a."
  };
  session.returnHandoff = {
    id: "handoff:sample-company-organize-smoke-b",
    status: "completed",
    goal: "Please build a small sample project in a folder called sample-company-organize-smoke-b.",
    summary: "Created the second sample-company-organize-smoke workspace.",
    nextSuggestedStep: "Tell me what to do next.",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company-organize-smoke-b",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company-organize-smoke-b\\index.html",
    previewUrl: null,
    changedPaths: [
      "C:\\Users\\testuser\\Desktop\\sample-company-organize-smoke-b\\index.html"
    ],
    sourceJobId: "job-cleanup-3",
    updatedAt: "2026-03-03T00:00:25.000Z"
  };
  session.activeWorkspace = {
    id: "workspace:sample-company-organize-smoke-b",
    label: "Sample organize workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\sample-company-organize-smoke-b",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company-organize-smoke-b\\index.html",
    previewUrl: null,
    browserSessionId: null,
    browserSessionIds: [],
    browserSessionStatus: null,
    browserProcessPid: null,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: null,
    lastKnownPreviewProcessPid: null,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: [
      "C:\\Users\\testuser\\Desktop\\sample-company-organize-smoke-b\\index.html"
    ],
    sourceJobId: "job-cleanup-3",
    updatedAt: "2026-03-03T00:00:25.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Please take this from start to finish: move the earlier sample-company-organize-smoke project folders into a folder called sample-web-projects on my desktop.",
    10
  );

  assert.match(executionInput, /Natural desktop-organization follow-up:/);
  assert.match(
    executionInput,
    /Treat the named destination as C:\\Users\\testuser\\Desktop\\sample-web-projects/i
  );
  assert.doesNotMatch(executionInput, /Desktop\\finish/i);
});

test("buildConversationAwareExecutionInput does not misread build destinations as Desktop cleanup work", async () => {
  const executionInput = await buildConversationAwareExecutionInput(
    buildSession(),
    "Hey, build me a tech landing page for sample products, go until you finish, put it on my desktop, create a folder called sample-company, and leave it open for me.",
    10
  );

  assert.doesNotMatch(executionInput, /Natural desktop-organization follow-up:/);
});

test("buildConversationAwareExecutionInput does not treat multi-page static site builds as Desktop cleanup", async () => {
  const executionInput = await buildConversationAwareExecutionInput(
    buildSession(),
    "I would like you to build a modern creative agency static site with multiple pages end to end, put it in a folder on my desktop, and open it in the browser when you are done",
    10
  );

  assert.doesNotMatch(executionInput, /Natural desktop-organization follow-up:/);
  assert.doesNotMatch(executionInput, /Match Desktop folders whose names contain the word multiple\./);
  assert.doesNotMatch(executionInput, /real folder move side effect/i);
});

test("buildConversationAwareExecutionInput derives workspace root and artifact from a tracked file preview", async () => {
  const session = buildSession();
  session.browserSessions.push({
    id: "browser-file-1",
    label: "Landing page preview",
    url: "file:///C:/Users/testuser/Desktop/sample-company/index.html",
    visibility: "visible",
    status: "open",
    sourceJobId: "job-file-1",
    openedAt: "2026-03-03T00:00:20.000Z",
    closedAt: null,
    controllerKind: "playwright_managed",
    controlAvailable: true,
    browserProcessPid: null,
    workspaceRootPath: null,
    linkedProcessLeaseId: null,
    linkedProcessCwd: null,
    linkedProcessPid: null
  });
  session.activeWorkspace = {
    id: "workspace:file-preview",
    label: "Current project workspace",
    rootPath: null,
    primaryArtifactPath: null,
    previewUrl: "file:///C:/Users/testuser/Desktop/sample-company/index.html",
    browserSessionId: "browser-file-1",
    browserSessionIds: ["browser-file-1"],
    browserSessionStatus: "open",
    browserProcessPid: null,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: null,
    lastKnownPreviewProcessPid: null,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_only",
    lastChangedPaths: [],
    sourceJobId: "job-file-1",
    updatedAt: "2026-03-03T00:00:25.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Change the hero section to a slider instead of a single static image.",
    10,
    null,
    null,
    undefined,
    undefined,
    null,
    undefined,
    null,
    [
      {
        sessionId: "browser-file-1",
        url: "file:///C:/Users/testuser/Desktop/sample-company/index.html",
        status: "open",
        openedAt: "2026-03-03T00:00:20.000Z",
        closedAt: null,
        visibility: "visible",
        controllerKind: "playwright_managed",
        controlAvailable: true,
        browserProcessPid: null,
        workspaceRootPath: null,
        linkedProcessLeaseId: null,
        linkedProcessCwd: null,
        linkedProcessPid: null
      }
    ]
  );

  assert.match(executionInput, /Root path: C:\\Users\\testuser\\Desktop\\sample-company/);
  assert.match(executionInput, /Primary artifact: C:\\Users\\testuser\\Desktop\\sample-company\\index.html/);
  assert.match(executionInput, /Preview URL: file:\/\/\/C:\/Users\/testuser\/Desktop\/sample-company\/index\.html/);
});

test("buildConversationAwareExecutionInput adds an ownership guard for explicit untracked localhost URLs", async () => {
  const session = buildSession();
  session.browserSessions.push({
    id: "browser-owned-1",
    label: "Tracked landing page preview",
    url: "http://127.0.0.1:4173/index.html",
    visibility: "visible",
    status: "open",
    sourceJobId: "job-owned-1",
    openedAt: "2026-03-03T00:00:20.000Z",
    closedAt: null,
    controllerKind: "playwright_managed",
    controlAvailable: true,
    browserProcessPid: 42001,
    linkedProcessLeaseId: "proc-owned-1",
    linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company",
    linkedProcessPid: 42002,
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company"
  });
  session.activeWorkspace = {
    id: "workspace:sample-company",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
    previewUrl: "http://127.0.0.1:4173/index.html",
    browserSessionId: "browser-owned-1",
    browserSessionIds: ["browser-owned-1"],
    browserSessionStatus: "open",
    browserProcessPid: 42001,
    previewProcessLeaseId: "proc-owned-1",
    previewProcessLeaseIds: ["proc-owned-1"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company",
    lastKnownPreviewProcessPid: 42002,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_and_preview",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
    sourceJobId: "job-owned-1",
    updatedAt: "2026-03-03T00:00:25.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Please close http://127.0.0.1:59999/index.html only if it is actually the page from this project. If you cannot prove that, leave it alone instead of guessing.",
    10
  );

  assert.match(executionInput, /Explicit browser-ownership guard:/);
  assert.match(
    executionInput,
    /not one of the tracked project pages in this chat: http:\/\/127\.0\.0\.1:59999\/index\.html/
  );
  assert.match(
    executionInput,
    /Do not close, reopen, or stop the tracked project preview as a substitute for that foreign URL\./
  );
  assert.match(
    executionInput,
    /Unless this run can prove that exact explicit URL belongs to the current tracked project, leave it alone and explain that ownership was not proven\./
  );
  assert.doesNotMatch(executionInput, /Natural browser-session follow-up:/);
});

test("buildConversationAwareExecutionInput keeps the ownership guard authoritative after the tracked preview is already stale", async () => {
  const session = buildSession();
  session.modeContinuity = {
    activeMode: "build",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: "2026-03-03T00:00:24.000Z",
    lastUserInput: "Please close the landing page we left open earlier so we can move on."
  };
  session.returnHandoff = {
    id: "handoff:job-owned-stale",
    status: "completed",
    goal: "Please close the landing page we left open earlier so we can move on.",
    summary: "I closed the tracked landing page window from earlier and shut down its linked local preview process.",
    nextSuggestedStep: null,
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
    previewUrl: "http://127.0.0.1:4173/index.html",
    changedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
    sourceJobId: "job-owned-stale",
    updatedAt: "2026-03-03T00:00:25.000Z"
  };
  session.browserSessions.push({
    id: "browser-owned-stale",
    label: "Tracked landing page preview",
    url: "http://127.0.0.1:4173/index.html",
    visibility: "visible",
    status: "closed",
    sourceJobId: "job-owned-stale",
    openedAt: "2026-03-03T00:00:20.000Z",
    closedAt: "2026-03-03T00:00:24.000Z",
    controllerKind: "playwright_managed",
    controlAvailable: false,
    browserProcessPid: 42001,
    linkedProcessLeaseId: "proc-owned-stale",
    linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company",
    linkedProcessPid: 42002,
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company"
  });
  session.activeWorkspace = {
    id: "workspace:sample-company",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
    previewUrl: "http://127.0.0.1:4173/index.html",
    browserSessionId: "browser-owned-stale",
    browserSessionIds: ["browser-owned-stale"],
    browserSessionStatus: "closed",
    browserProcessPid: 42001,
    previewProcessLeaseId: "proc-owned-stale",
    previewProcessLeaseIds: ["proc-owned-stale"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company",
    lastKnownPreviewProcessPid: 42002,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
    sourceJobId: "job-owned-stale",
    updatedAt: "2026-03-03T00:00:25.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "There is another localhost page I opened myself earlier. If you cannot prove it belongs to this project, leave it alone instead of guessing. Please close http://127.0.0.1:59999/index.html only if it is actually the page from this project.",
    10
  );

  assert.match(executionInput, /Explicit browser-ownership guard:/);
  assert.doesNotMatch(executionInput, /Natural browser-session follow-up:/);
  assert.doesNotMatch(executionInput, /prefer stop_process with params\.leaseId=proc-owned-stale/i);
  assert.doesNotMatch(executionInput, /prefer close_browser with params\.sessionId=browser-owned-stale/i);
  assert.doesNotMatch(executionInput, /Current tracked workspace in this chat:/);
  assert.doesNotMatch(executionInput, /Latest durable work handoff in this chat:/);
  assert.doesNotMatch(executionInput, /Current working mode from earlier in this chat:/);
});


test("buildConversationAwareExecutionInput can use media continuity cues to surface bounded contextual recall", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "user",
        text: "We never really found out how Owen's MRI turned out.",
        at: "2026-02-14T15:00:00.000Z"
      }
    ],
    conversationStack: {
      schemaVersion: "v1",
      updatedAt: "2026-03-03T00:00:00.000Z",
      activeThreadKey: "thread_current",
      threads: [
        {
          threadKey: "thread_current",
          topicKey: "repo_work",
          topicLabel: "Repo Work",
          state: "active",
          resumeHint: "Continue the repo work.",
          openLoops: [],
          lastTouchedAt: "2026-03-03T00:00:00.000Z"
        },
        {
          threadKey: "thread_owen",
          topicKey: "owen_mri",
          topicLabel: "Owen MRI",
          state: "paused",
          resumeHint: "Owen was waiting on MRI results and the outcome never got resolved.",
          openLoops: [
            {
              loopId: "loop_owen_mri",
              threadKey: "thread_owen",
              entityRefs: ["owen", "mri"],
              createdAt: "2026-02-14T15:00:00.000Z",
              lastMentionedAt: "2026-02-14T15:00:00.000Z",
              priority: 0.9,
              status: "open"
            }
          ],
          lastTouchedAt: "2026-02-14T15:00:00.000Z"
        }
      ],
      topics: [
        {
          topicKey: "repo_work",
          label: "Repo Work",
          firstSeenAt: "2026-03-03T00:00:00.000Z",
          lastSeenAt: "2026-03-03T00:00:00.000Z",
          mentionCount: 1
        },
        {
          topicKey: "owen_mri",
          label: "Owen MRI",
          firstSeenAt: "2026-02-14T15:00:00.000Z",
          lastSeenAt: "2026-02-14T15:00:00.000Z",
          mentionCount: 1
        }
      ]
    }
  });

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Please review the screenshot and tell me what to do next.",
    10,
    null,
    "Please review the screenshot and tell me what to do next.",
    async () => [
      {
        episodeId: "episode_owen_mri",
        title: "Owen MRI results were still pending",
        summary: "Owen was waiting on MRI results and the outcome never got resolved.",
        status: "outcome_unknown",
        lastMentionedAt: "2026-02-14T15:00:00.000Z",
        entityRefs: ["Owen", "MRI"],
        entityLinks: [
          {
            entityKey: "entity_owen",
            canonicalName: "Owen"
          }
        ],
        openLoopLinks: [
          {
            loopId: "loop_owen_mri",
            threadKey: "thread_owen",
            status: "open",
            priority: 0.9
          }
        ]
      }
    ],
    undefined,
    {
      attachments: [
        {
          kind: "image",
          provider: "telegram",
          fileId: "image-owen-1",
          fileUniqueId: "image-owen-uniq-1",
          mimeType: "image/png",
          fileName: "owen-update.png",
          sizeBytes: 2048,
          caption: "Here is the note about Owen.",
          durationSeconds: null,
          width: 1024,
          height: 768,
          interpretation: {
            summary: "The screenshot mentions Owen and says the MRI results still have not come back.",
            transcript: null,
            ocrText: "Owen MRI results still pending",
            confidence: 0.93,
            provenance: "fixture screenshot",
            source: "fixture_catalog",
            entityHints: ["Owen", "MRI"]
          }
        }
      ]
    }
  );

  assert.match(executionInput, /Contextual recall opportunity \(optional\):/);
  assert.match(executionInput, /Media continuity cues: owen, mri/);
  assert.match(executionInput, /Relevant situation: Owen MRI results were still pending/i);
});

test("buildAgentPulseExecutionInput includes pulse safety instructions and bounded context", () => {
  const session = buildSession();
  session.conversationTurns.push({
    role: "assistant",
    text: "Reminder: we paused at checkpoint 6.86.G.",
    at: "2026-03-03T00:00:10.000Z"
  });

  const executionInput = buildAgentPulseExecutionInput(
    session,
    "Follow up on unresolved checkpoint reminders.",
    10
  );

  assert.match(executionInput, /^System-generated Agent Pulse check-in request\./);
  assert.match(executionInput, /Do not impersonate a human\./);
  assert.match(executionInput, /Do not volunteer that you are an AI assistant in ordinary greetings or casual replies\./);
  assert.match(executionInput, /Only mention that identity if the user directly asks what you are/i);
  assert.match(executionInput, /Never open with canned self-introductions like 'AI assistant here' or 'I'm your AI assistant'\./);
  assert.match(executionInput, /Agent Pulse request:/);
  assert.match(executionInput, /Recent conversation context \(oldest to newest\):/);
});


