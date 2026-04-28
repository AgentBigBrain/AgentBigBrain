/**
 * @fileoverview Covers a transcript-shaped request matrix for completion-critical routing surfaces.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildConversationAwareExecutionInput } from "../../src/interfaces/conversationExecutionInputPolicy";
import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import { resolveConversationIntentMode } from "../../src/interfaces/conversationRuntime/intentModeResolution";
import type {
  ConversationBuildFormatId,
  ConversationRouteMemoryIntent,
  ConversationRuntimeControlIntent,
  ConversationSemanticRouteId,
  ResolvedConversationIntentMode
} from "../../src/interfaces/conversationRuntime/intentModeContracts";
import { classifyRoutingIntentV1 } from "../../src/interfaces/routingMap";
import type { ConversationSession } from "../../src/interfaces/sessionStore";
import type { LocalIntentModelSessionHints } from "../../src/organs/languageUnderstanding/localIntentModelContracts";
import { buildConversationBrowserSessionFixture } from "../helpers/conversationFixtures";

function buildSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ...buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-request-matrix",
      userId: "user-1",
      username: "owner",
      conversationVisibility: "private",
      receivedAt: "2026-03-03T00:00:00.000Z"
    }),
    ...overrides
  };
}

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

async function resolveMatrixRequest(
  prompt: string,
  sessionHints: LocalIntentModelSessionHints | null = null
): Promise<ResolvedConversationIntentMode> {
  return resolveConversationIntentMode(
    prompt,
    classifyRoutingIntentV1(prompt),
    undefined,
    sessionHints
  );
}

async function buildMatrixExecutionInput(
  session: ConversationSession,
  prompt: string,
  sessionHints: LocalIntentModelSessionHints | null = null
): Promise<{
  resolution: ResolvedConversationIntentMode;
  executionInput: string;
}> {
  const routingClassification = classifyRoutingIntentV1(prompt);
  const resolution = await resolveConversationIntentMode(
    prompt,
    routingClassification,
    undefined,
    sessionHints
  );
  const executionInput = await buildConversationAwareExecutionInput(
    session,
    prompt,
    10,
    routingClassification,
    prompt,
    undefined,
    undefined,
    null,
    undefined,
    resolution.semanticHint ?? null,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    resolution.semanticRouteId ?? null,
    resolution.buildFormat ?? null,
    resolution.semanticRoute ?? null
  );
  return { resolution, executionInput };
}

interface RouteMatrixCase {
  name: string;
  prompt: string;
  sessionHints?: LocalIntentModelSessionHints;
  expectedMode: ResolvedConversationIntentMode["mode"];
  expectedRouteId: ConversationSemanticRouteId;
  expectedBuildFormat: ConversationBuildFormatId | null;
  expectedRuntimeControlIntent: ConversationRuntimeControlIntent;
  expectedMemoryIntent: ConversationRouteMemoryIntent;
  expectedRequiresUserOwnedLocation: boolean;
  expectedClarificationKind?: NonNullable<ResolvedConversationIntentMode["clarification"]>["kind"];
}

const routeMatrixCases: readonly RouteMatrixCase[] = [
  {
    name: "autonomous static site build keeps static build-format metadata",
    prompt:
      "I would like you to build a modern creative agency static site with multiple pages end to end, put it in a folder on my desktop, and open it in the browser when you are done",
    expectedMode: "autonomous",
    expectedRouteId: "autonomous_execution",
    expectedBuildFormat: "static_html",
    expectedRuntimeControlIntent: "open_browser",
    expectedMemoryIntent: "none",
    expectedRequiresUserOwnedLocation: true
  },
  {
    name: "explicit static HTML build stays on the static build lane",
    prompt:
      "Make a static HTML portfolio site with placeholder images, save it on my desktop, and open it in the browser when done.",
    expectedMode: "static_html_build",
    expectedRouteId: "static_html_build",
    expectedBuildFormat: "static_html",
    expectedRuntimeControlIntent: "open_browser",
    expectedMemoryIntent: "none",
    expectedRequiresUserOwnedLocation: true
  },
  {
    name: "framework build preserves Next.js metadata and browser control",
    prompt:
      "Create a Next.js dashboard app on my desktop and leave the dev server open in the browser.",
    expectedMode: "framework_app_build",
    expectedRouteId: "framework_app_build",
    expectedBuildFormat: "nextjs",
    expectedRuntimeControlIntent: "open_browser",
    expectedMemoryIntent: "none",
    expectedRequiresUserOwnedLocation: true
  },
  {
    name: "desktop cleanup remains an execution route without build-format metadata",
    prompt:
      "Move every folder on my desktop that starts with sample-company into sample-folder. Do not ask again.",
    expectedMode: "build",
    expectedRouteId: "build_request",
    expectedBuildFormat: null,
    expectedRuntimeControlIntent: "none",
    expectedMemoryIntent: "none",
    expectedRequiresUserOwnedLocation: true
  },
  {
    name: "browser close follow-up carries typed close intent",
    prompt: "Close the landing page so we can work on something else.",
    expectedMode: "chat",
    expectedRouteId: "chat_answer",
    expectedBuildFormat: null,
    expectedRuntimeControlIntent: "close_browser",
    expectedMemoryIntent: "none",
    expectedRequiresUserOwnedLocation: false
  },
  {
    name: "workflow status question stays on status recall",
    prompt: "What are you doing right now and where did you put that landing page?",
    sessionHints: buildSessionHints({
      hasActiveWorkspace: true,
      modeContinuity: "build",
      domainDominantLane: "workflow",
      domainContinuityActive: true,
      workflowContinuityActive: true
    }),
    expectedMode: "status_or_recall",
    expectedRouteId: "status_recall",
    expectedBuildFormat: null,
    expectedRuntimeControlIntent: "none",
    expectedMemoryIntent: "none",
    expectedRequiresUserOwnedLocation: false
  },
  {
    name: "relationship recall stays conversational during workflow continuity",
    prompt: "What's going on with Billy and Beacon?",
    sessionHints: buildSessionHints({
      hasActiveWorkspace: true,
      modeContinuity: "build",
      domainDominantLane: "workflow",
      domainContinuityActive: true,
      workflowContinuityActive: true
    }),
    expectedMode: "chat",
    expectedRouteId: "relationship_recall",
    expectedBuildFormat: null,
    expectedRuntimeControlIntent: "none",
    expectedMemoryIntent: "relationship_recall",
    expectedRequiresUserOwnedLocation: false
  },
  {
    name: "ambiguous landing-page build asks for build format",
    prompt:
      "Build me a simple landing page end to end. Put it in the exact folder C:\\Users\\testuser\\Desktop\\Sample Service Landing Page and do not open it yet.",
    expectedMode: "clarify_build_format",
    expectedRouteId: "clarify_build_format",
    expectedBuildFormat: null,
    expectedRuntimeControlIntent: "none",
    expectedMemoryIntent: "none",
    expectedRequiresUserOwnedLocation: false,
    expectedClarificationKind: "build_format"
  }
];

test("request completion matrix preserves route metadata for common Telegram-style requests", async (t) => {
  for (const matrixCase of routeMatrixCases) {
    await t.test(matrixCase.name, async () => {
      const resolution = await resolveMatrixRequest(
        matrixCase.prompt,
        matrixCase.sessionHints ?? null
      );

      assert.equal(resolution.mode, matrixCase.expectedMode);
      assert.equal(resolution.semanticRouteId, matrixCase.expectedRouteId);
      assert.equal(
        resolution.semanticRoute?.buildFormat?.format ?? null,
        matrixCase.expectedBuildFormat
      );
      assert.equal(
        resolution.semanticRoute?.runtimeControlIntent,
        matrixCase.expectedRuntimeControlIntent
      );
      assert.equal(
        resolution.semanticRoute?.memoryIntent,
        matrixCase.expectedMemoryIntent
      );
      assert.equal(
        resolution.semanticRoute?.explicitConstraints.requiresUserOwnedLocation,
        matrixCase.expectedRequiresUserOwnedLocation
      );
      assert.equal(
        resolution.clarification?.kind ?? null,
        matrixCase.expectedClarificationKind ?? null
      );
    });
  }
});

test("request completion matrix renders completion-critical execution-input guardrails", async () => {
  const staticBuild = await buildMatrixExecutionInput(
    buildSession(),
    routeMatrixCases[0].prompt
  );

  assert.equal(staticBuild.resolution.semanticRouteId, "autonomous_execution");
  assert.match(staticBuild.executionInput, /Resolved semantic route:/);
  assert.match(staticBuild.executionInput, /- routeId: autonomous_execution/);
  assert.match(staticBuild.executionInput, /Resolved build format:/);
  assert.match(staticBuild.executionInput, /- format: static_html/);
  assert.match(staticBuild.executionInput, /- runtimeControlIntent: open_browser/);
  assert.match(staticBuild.executionInput, /- requiresUserOwnedLocation: true/);
  assert.doesNotMatch(staticBuild.executionInput, /Natural desktop-organization follow-up:/);
  assert.doesNotMatch(staticBuild.executionInput, /Match Desktop folders whose names contain the word multiple\./);
  assert.doesNotMatch(staticBuild.executionInput, /real folder move side effect/i);

  const cleanupSession = buildSession();
  cleanupSession.activeWorkspace = {
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
  const cleanup = await buildMatrixExecutionInput(
    cleanupSession,
    routeMatrixCases[3].prompt
  );

  assert.equal(cleanup.resolution.semanticRouteId, "build_request");
  assert.match(cleanup.executionInput, /Resolved semantic route:/);
  assert.match(cleanup.executionInput, /Natural desktop-organization follow-up:/);
  assert.match(cleanup.executionInput, /real Desktop folder move, not just an inspection or summary/i);
  assert.match(cleanup.executionInput, /Match Desktop folders whose names start with sample-company\./i);
  assert.match(cleanup.executionInput, /This run must include a real folder move side effect\./i);
  assert.doesNotMatch(cleanup.executionInput, /Resolved build format:/);

  const browserSession = buildSession();
  browserSession.browserSessions.push(buildConversationBrowserSessionFixture({
    id: "browser_session:landing-page",
    label: "Landing page preview",
    url: "http://127.0.0.1:4173/",
    sourceJobId: "job-landing",
    openedAt: "2026-03-03T00:00:24.000Z",
    linkedProcessLeaseId: "proc_preview_1",
    linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company"
  }));
  const browserClose = await buildMatrixExecutionInput(
    browserSession,
    routeMatrixCases[4].prompt
  );

  assert.equal(browserClose.resolution.semanticRoute?.runtimeControlIntent, "close_browser");
  assert.match(browserClose.executionInput, /Natural browser-session follow-up:/);
  assert.match(browserClose.executionInput, /prefer close_browser with params\.sessionId=browser_session:landing-page/i);
});
