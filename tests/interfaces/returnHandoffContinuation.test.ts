import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import {
  buildReturnHandoffContinuationBlock,
  resolveReturnHandoffContinuationIntent
} from "../../src/interfaces/conversationRuntime/returnHandoffContinuation";
import type { ResolvedConversationIntentMode } from "../../src/interfaces/conversationRuntime/intentModeContracts";

function buildSession() {
  return buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-handoff-1",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: "2026-03-20T12:00:00.000Z"
  });
}

function buildChatIntent(): ResolvedConversationIntentMode {
  return {
    mode: "chat",
    confidence: "medium",
    matchedRuleId: "test_chat",
    explanation: "test",
    clarification: null,
    semanticHint: null
  };
}

test("resolveReturnHandoffContinuationIntent resumes workflow handoff when the handoff snapshot was workflow-born", () => {
  const session = buildSession();
  session.domainContext.dominantLane = "profile";
  session.returnHandoff = {
    id: "handoff:job-1",
    status: "completed",
    goal: "Finish the landing page",
    summary: "Ready for review.",
    nextSuggestedStep: null,
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
    primaryArtifactPath: null,
    previewUrl: null,
    changedPaths: [],
    sourceJobId: "job-1",
    domainSnapshotLane: "workflow",
    domainSnapshotRecordedAt: "2026-03-20T11:55:00.000Z",
    updatedAt: "2026-03-20T11:56:00.000Z"
  };

  const resolved = resolveReturnHandoffContinuationIntent(
    session,
    "continue from where you left off",
    buildChatIntent()
  );

  assert.equal(resolved?.mode, "build");
  assert.equal(resolved?.semanticHint, "resume_handoff");
});

test("resolveReturnHandoffContinuationIntent fails closed when no workflow-compatible domain context exists", () => {
  const session = buildSession();
  session.domainContext.dominantLane = "profile";
  session.returnHandoff = {
    id: "handoff:job-1",
    status: "completed",
    goal: "Finish the landing page",
    summary: "Ready for review.",
    nextSuggestedStep: null,
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
    primaryArtifactPath: null,
    previewUrl: null,
    changedPaths: [],
    sourceJobId: "job-1",
    domainSnapshotLane: "profile",
    domainSnapshotRecordedAt: "2026-03-20T11:55:00.000Z",
    updatedAt: "2026-03-20T11:56:00.000Z"
  };

  const resolved = resolveReturnHandoffContinuationIntent(
    session,
    "continue from where you left off",
    buildChatIntent()
  );

  assert.equal(resolved, null);
  assert.equal(
    buildReturnHandoffContinuationBlock(session, "continue from where you left off"),
    null
  );
});

test("resolveReturnHandoffContinuationIntent keeps lexical resume wording pinned to the saved handoff mode", () => {
  const session = buildSession();
  session.modeContinuity = {
    activeMode: "build",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: "2026-03-20T11:58:00.000Z",
    lastUserInput: "Build the landing page and leave it open."
  };
  session.returnHandoff = {
    id: "handoff:job-2",
    status: "completed",
    goal: "Finish the landing page",
    summary: "Ready for review.",
    nextSuggestedStep: null,
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
    primaryArtifactPath: null,
    previewUrl: null,
    changedPaths: [],
    sourceJobId: "job-2",
    domainSnapshotLane: "workflow",
    domainSnapshotRecordedAt: "2026-03-20T11:57:00.000Z",
    updatedAt: "2026-03-20T11:58:30.000Z"
  };

  const resolved = resolveReturnHandoffContinuationIntent(
    session,
    "Pick that back up and keep going from where you left off.",
    {
      mode: "autonomous",
      confidence: "high",
      matchedRuleId: "intent_mode_autonomous_execution",
      explanation: "Explicit keep-going wording promoted autonomy before handoff continuation applied.",
      clarification: null,
      semanticHint: null
    }
  );

  assert.equal(resolved?.mode, "build");
  assert.equal(resolved?.semanticHint, "resume_handoff");
});
