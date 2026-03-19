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

test("buildTurnLocalStatusUpdateBlock only emits block for first-person status updates", () => {
  const block = buildTurnLocalStatusUpdateBlock("my deployment ticket is still pending");
  assert.match(block ?? "", /Turn-local status update/);
  assert.match(block ?? "", /my deployment ticket is still pending/i);

  const missingStatus = buildTurnLocalStatusUpdateBlock("please help with deployment");
  assert.equal(missingStatus, null);
});

test("resolveFollowUpInput wraps short follow-up answers with prior assistant clarification context", () => {
  const session = buildSession();
  session.conversationTurns.push({
    role: "assistant",
    text: "Do you want the private or public pulse mode?",
    at: "2026-03-03T00:00:10.000Z"
  });

  const resolution = resolveFollowUpInput(
    session,
    "private",
    createFollowUpRuleContext(null)
  );

  assert.equal(resolution.classification.isShortFollowUp, true);
  assert.match(resolution.executionInput, /Follow-up user response to prior assistant clarification/);
  assert.match(resolution.executionInput, /Previous assistant question:/);
  assert.match(resolution.executionInput, /User follow-up answer: private/);
});

test("resolveFollowUpInput strips robotic assistant labels from prior clarification prompts", () => {
  const session = buildSession();
  session.conversationTurns.push({
    role: "assistant",
    text: "AI assistant answer: Would you like me to build it now or plan it first?",
    at: "2026-03-03T00:00:10.000Z"
  });

  const resolution = resolveFollowUpInput(
    session,
    "build it now",
    createFollowUpRuleContext(null)
  );

  assert.match(resolution.executionInput, /Previous assistant question: Would you like me to build it now or plan it first\?/);
  assert.doesNotMatch(resolution.executionInput, /AI assistant answer:/i);
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
    goal: "Build the drone landing page and leave the preview ready.",
    summary: "I finished the draft and left the preview ready for review.",
    nextSuggestedStep: "Tell me which section you want refined next.",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
    previewUrl: "http://127.0.0.1:4177/index.html",
    changedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
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
  assert.match(executionInput, /Prior goal: Build the drone landing page and leave the preview ready\./);
  assert.match(executionInput, /Suggested next step: Tell me which section you want refined next\./);
  assert.match(executionInput, /Do not rebuild or restart from scratch unless the tracked workspace or artifact no longer fits/i);
});

test("buildConversationAwareExecutionInput adds the durable continuation block when semantic intent proves a resume request", async () => {
  const session = buildSession();
  session.returnHandoff = {
    id: "handoff:job-7b",
    status: "waiting_for_user",
    goal: "Keep refining the drone landing page draft.",
    summary: "I paused with a reviewable draft ready.",
    nextSuggestedStep: "Keep refining the hero and CTA when the user is ready.",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
    previewUrl: "http://127.0.0.1:4177/index.html",
    changedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
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
  assert.match(executionInput, /Prior goal: Keep refining the drone landing page draft\./);
});

test("buildConversationAwareExecutionInput strips robotic assistant labels from recent conversation context", async () => {
  const session = buildSession();
  session.conversationTurns.push({
    role: "assistant",
    text: "AI assistant answer: Billy seems to be doing better now.",
    at: "2026-03-03T00:00:20.000Z"
  });

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "How is Billy doing?",
    10
  );

  assert.match(executionInput, /Recent conversation context \(oldest to newest\):/);
  assert.match(executionInput, /- assistant: Billy seems to be doing better now\./);
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

test("buildConversationAwareExecutionInput includes build-scaffold routing hint for generic app creation prompts", async () => {
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

  assert.match(executionInput, /Deterministic routing hint:/);
  assert.match(executionInput, /Intent surface: build_scaffold\./i);
  assert.match(executionInput, /Prefer governed finite proof steps first/i);
  assert.match(executionInput, /Only use managed process plus probe actions/i);
  assert.match(executionInput, /BUILD_NO_SIDE_EFFECT_EXECUTED/i);
});

test("buildConversationAwareExecutionInput can inject episode-aware contextual recall from the raw user turn while preserving wrapped execution input", async () => {
  const session = buildSession();
  session.conversationTurns.push({
    role: "user",
    text: "Billy fell down a few weeks ago.",
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
        threadKey: "thread_billy",
        topicKey: "billy_fall",
        topicLabel: "Billy Fall",
        state: "paused",
        resumeHint: "Billy fell down and you wanted to hear how it ended up.",
        openLoops: [
          {
            loopId: "loop_billy",
            threadKey: "thread_billy",
            entityRefs: ["billy"],
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
        topicKey: "billy_fall",
        label: "Billy Fall",
        firstSeenAt: "2026-02-14T15:00:00.000Z",
        lastSeenAt: "2026-02-14T15:00:00.000Z",
        mentionCount: 1
      }
    ]
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Follow-up user response to prior assistant clarification.\nUser follow-up answer: Billy seems better now.",
    10,
    null,
    "How is Billy doing lately?",
    async () => [
      {
        episodeId: "episode_billy_fall",
        title: "Billy fell down",
        summary: "Billy fell down a few weeks ago and the outcome never got resolved.",
        status: "unresolved",
        lastMentionedAt: "2026-02-14T15:00:00.000Z",
        entityRefs: ["Billy"],
        entityLinks: [
          {
            entityKey: "entity_billy",
            canonicalName: "Billy"
          }
        ],
        openLoopLinks: [
          {
            loopId: "loop_billy",
            threadKey: "thread_billy",
            status: "open",
            priority: 0.8
          }
        ]
      }
    ]
  );

  assert.match(executionInput, /Contextual recall opportunity \(optional\):/);
  assert.match(executionInput, /older unresolved situation/i);
  assert.match(executionInput, /Relevant situation: Billy fell down/i);
  assert.match(executionInput, /Current user request:/);
  assert.match(executionInput, /User follow-up answer: Billy seems better now\./);
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
    location: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
    status: "created",
    sourceJobId: "job-landing",
    at: "2026-03-03T00:00:24.000Z",
    summary: "Created the landing page."
  });
  session.pathDestinations.push({
    id: "dest-landing-folder",
    label: "Drone company folder",
    resolvedPath: "C:\\Users\\testuser\\Desktop\\drone-company",
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
  assert.match(executionInput, /Most recent concrete artifact: Landing page file at C:\\Users\\testuser\\Desktop\\drone-company\\index\.html/);
  assert.match(executionInput, /Preferred edit destination: C:\\Users\\testuser\\Desktop\\drone-company/);
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
    location: "C:\\Users\\testuser\\Desktop\\drone-company\\script.js",
    status: "updated",
    sourceJobId: "job-landing",
    at: "2026-03-03T00:00:29.000Z",
    summary: "Updated script.js."
  });
  session.recentActions.push({
    id: "action-styles",
    kind: "file",
    label: "File styles.css",
    location: "C:\\Users\\testuser\\Desktop\\drone-company\\styles.css",
    status: "updated",
    sourceJobId: "job-landing",
    at: "2026-03-03T00:00:28.000Z",
    summary: "Updated styles.css."
  });
  session.recentActions.push({
    id: "action-index",
    kind: "file",
    label: "File index.html",
    location: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
    status: "updated",
    sourceJobId: "job-landing",
    at: "2026-03-03T00:00:27.000Z",
    summary: "Updated index.html."
  });
  session.pathDestinations.push({
    id: "dest-script",
    label: "Drone company script",
    resolvedPath: "C:\\Users\\testuser\\Desktop\\drone-company\\script.js",
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

  assert.match(executionInput, /Recent user-visible actions in this chat:\n- File script\.js: C:\\Users\\testuser\\Desktop\\drone-company\\script\.js \(updated\)\n- File styles\.css: C:\\Users\\testuser\\Desktop\\drone-company\\styles\.css \(updated\)\n- File index\.html: C:\\Users\\testuser\\Desktop\\drone-company\\index\.html \(updated\)/);
  assert.match(executionInput, /Most recent concrete artifact: File script\.js at C:\\Users\\testuser\\Desktop\\drone-company\\script\.js/);
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
    linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company"
  }));

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Close the landing page so we can work on something else.",
    10
  );

  assert.match(executionInput, /Natural browser-session follow-up:/);
  assert.match(executionInput, /Preferred browser session: Landing page preview; sessionId=browser_session:landing-page; url=http:\/\/127\.0\.0\.1:4173\/; status=open; control=available/);
  assert.match(executionInput, /Linked preview process: leaseId=proc_preview_1; cwd=C:\\Users\\testuser\\Desktop\\drone-company/);
  assert.match(executionInput, /prefer close_browser with params\.sessionId=browser_session:landing-page and then stop_process with params\.leaseId=proc_preview_1/i);
});

test("buildConversationAwareExecutionInput instructs close follow-ups to stop every exact tracked preview lease for the workspace", async () => {
  const session = buildSession();
  session.browserSessions.push(buildConversationBrowserSessionFixture({
    id: "browser_session:ai-drone-city",
    label: "AI Drone City preview",
    url: "http://127.0.0.1:4173/",
    sourceJobId: "job-ai-drone-city",
    openedAt: "2026-03-03T00:00:24.000Z",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\AI Drone City",
    linkedProcessLeaseId: "proc_preview_2",
    linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\AI Drone City"
  }));
  session.activeWorkspace = {
    id: "workspace:ai-drone-city",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\AI Drone City",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\AI Drone City\\package.json",
    previewUrl: "http://127.0.0.1:4173/",
    browserSessionId: "browser_session:ai-drone-city",
    browserSessionIds: ["browser_session:ai-drone-city"],
    browserSessionStatus: "open",
    browserProcessPid: 41001,
    previewProcessLeaseId: "proc_preview_2",
    previewProcessLeaseIds: ["proc_preview_2", "proc_preview_1"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\AI Drone City",
    lastKnownPreviewProcessPid: 4002,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_and_preview",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\AI Drone City\\package.json"],
    sourceJobId: "job-ai-drone-city",
    updatedAt: "2026-03-03T00:00:24.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Thanks. Please close AI Drone City and anything it needs so we can move on.",
    10
  );

  assert.match(executionInput, /Exact tracked preview process leases for this workspace: proc_preview_2, proc_preview_1/);
  assert.match(executionInput, /prefer close_browser with params\.sessionId=browser_session:ai-drone-city and then stop each exact tracked preview lease for this workspace: stop_process with params\.leaseId=proc_preview_2, then stop_process with params\.leaseId=proc_preview_1/i);
});

test("buildConversationAwareExecutionInput treats closing a named tracked workspace as a browser close follow-up", async () => {
  const session = buildSession();
  session.browserSessions.push(buildConversationBrowserSessionFixture({
    id: "browser_session:ai-drone-city",
    label: "AI Drone City preview",
    url: "file:///C:/Users/testuser/Desktop/AI%20Drone%20City/dist/index.html",
    sourceJobId: "job-ai-drone-city",
    openedAt: "2026-03-03T00:00:24.000Z",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\AI Drone City\\dist"
  }));
  session.activeWorkspace = {
    id: "workspace:ai-drone-city",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\AI Drone City\\dist",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\AI Drone City\\dist\\index.html",
    previewUrl: "file:///C:/Users/testuser/Desktop/AI%20Drone%20City/dist/index.html",
    browserSessionId: "browser_session:ai-drone-city",
    browserSessionIds: ["browser_session:ai-drone-city"],
    browserSessionStatus: "open",
    browserProcessPid: 41001,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\AI Drone City\\dist",
    lastKnownPreviewProcessPid: null,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_only",
    lastChangedPaths: [],
    sourceJobId: "job-ai-drone-city",
    updatedAt: "2026-03-03T00:00:24.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Thanks. Please close AI Drone City and anything it needs so we can move on.",
    10
  );

  assert.match(executionInput, /Natural browser-session follow-up:/);
  assert.match(executionInput, /Preferred browser session: AI Drone City preview; sessionId=browser_session:ai-drone-city/i);
  assert.match(executionInput, /prefer close_browser with params\.sessionId=browser_session:ai-drone-city/i);
});

test("buildConversationAwareExecutionInput does not treat keep the page open as a reopen request during normal conversation", async () => {
  const session = buildSession();
  session.browserSessions.push(buildConversationBrowserSessionFixture({
    id: "browser_session:ai-drone-city",
    label: "AI Drone City preview",
    url: "file:///C:/Users/testuser/Desktop/AI%20Drone%20City/dist/index.html",
    sourceJobId: "job-ai-drone-city",
    openedAt: "2026-03-03T00:00:24.000Z",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\AI Drone City"
  }));
  session.activeWorkspace = {
    id: "workspace:ai-drone-city",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\AI Drone City",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\AI Drone City\\package.json",
    previewUrl: "file:///C:/Users/testuser/Desktop/AI%20Drone%20City/dist/index.html",
    browserSessionId: "browser_session:ai-drone-city",
    browserSessionIds: ["browser_session:ai-drone-city"],
    browserSessionStatus: "open",
    browserProcessPid: 41001,
    previewProcessLeaseId: null,
    previewProcessLeaseIds: [],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\AI Drone City",
    lastKnownPreviewProcessPid: null,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_only",
    lastChangedPaths: [
      "C:\\Users\\testuser\\Desktop\\AI Drone City\\package.json",
      "C:\\Users\\testuser\\Desktop\\AI Drone City"
    ],
    sourceJobId: "job-ai-drone-city",
    updatedAt: "2026-03-03T00:00:24.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Looks good. Before changing anything, just talk with me for a minute about what makes AI Drone City feel playful. Reply in two short paragraphs and keep the page open.",
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
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
    linkedProcessLeaseId: "proc_preview_1",
    linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
    linkedProcessPid: 4001
  });
  session.activeWorkspace = {
    id: "workspace:landing-page",
    label: "Landing page workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
    previewUrl: "http://127.0.0.1:4173/",
    browserSessionId: "browser_session:landing-page",
    browserSessionIds: ["browser_session:landing-page"],
    browserSessionStatus: "open",
    browserProcessPid: 41001,
    previewProcessLeaseId: "proc_preview_1",
    previewProcessLeaseIds: ["proc_preview_1"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
    lastKnownPreviewProcessPid: 4001,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_and_preview",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
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
        cwd: "C:\\Users\\testuser\\Desktop\\drone-company",
        shellExecutable: "powershell.exe",
        shellKind: "powershell",
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
        workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
        linkedProcessLeaseId: "proc_preview_1",
        linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
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
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
    linkedProcessLeaseId: "proc_preview_1",
    linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
    linkedProcessPid: 4001
  });
  session.activeWorkspace = {
    id: "workspace:drone-company",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
    previewUrl: "http://127.0.0.1:4173/",
    browserSessionId: "browser_session:landing-page",
    browserSessionIds: ["browser_session:landing-page"],
    browserSessionStatus: "closed",
    browserProcessPid: 41001,
    previewProcessLeaseId: "proc_preview_1",
    previewProcessLeaseIds: ["proc_preview_1"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
    lastKnownPreviewProcessPid: 4001,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
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
    url: "file:///C:/Users/testuser/Desktop/drone-company-landing.html",
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
    /prefer open_browser with params\.url=file:\/\/\/C:\/Users\/testuser\/Desktop\/drone-company-landing\.html/i
  );
});

test("buildConversationAwareExecutionInput surfaces exact tracked workspace recovery affordances for local organization requests", async () => {
  const session = buildSession();
  session.browserSessions.push(buildConversationBrowserSessionFixture({
    id: "browser_session:drone-preview",
    label: "Drone preview",
    url: "http://127.0.0.1:4173/",
    sourceJobId: "job-drone",
    openedAt: "2026-03-03T00:00:24.000Z",
    linkedProcessLeaseId: "proc_preview_drone",
    linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1"
  }));
  session.activeWorkspace = {
    id: "workspace:drone-company",
    label: "Drone company project",
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1\\index.html",
    previewUrl: "http://127.0.0.1:4173/",
    browserSessionId: "browser_session:drone-preview",
    browserSessionIds: ["browser_session:drone-preview"],
    browserSessionStatus: "open",
    browserProcessPid: 41001,
    previewProcessLeaseId: "proc_preview_drone",
    previewProcessLeaseIds: ["proc_preview_drone"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1",
    lastKnownPreviewProcessPid: 4001,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_and_preview",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1\\index.html"],
    sourceJobId: "job-drone",
    updatedAt: "2026-03-03T00:00:24.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
    10,
    null,
    null,
    undefined,
    undefined,
    null,
    [
      {
        leaseId: "proc_preview_drone",
        taskId: "task-1",
        actionId: "action-1",
        pid: 4001,
        commandFingerprint: "python-http-server",
        cwd: "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1",
        shellExecutable: "powershell.exe",
        shellKind: "powershell",
        startedAt: "2026-03-03T00:00:10.000Z",
        statusCode: "PROCESS_STILL_RUNNING",
        exitCode: null,
        signal: null,
        stopRequested: false
      }
    ]
  );

  assert.match(executionInput, /Workspace recovery context for this chat:/);
  assert.match(executionInput, /Preferred workspace root: C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1/);
  assert.match(executionInput, /Exact tracked browser session ids: browser_session:drone-preview/);
  assert.match(executionInput, /Exact tracked preview lease ids: proc_preview_drone/);
  assert.match(executionInput, /leaseId=proc_preview_drone; cwd=C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1; status=PROCESS_STILL_RUNNING; stopRequested=no/);
  assert.match(executionInput, /inspect_workspace_resources first with the preferred workspace root/i);
  assert.match(executionInput, /stop only those exact lease ids with stop_process/i);
});

test("buildConversationAwareExecutionInput distinguishes remembered preview lease ids from live tracked ones when the workspace is stale", async () => {
  const session = buildSession();
  session.activeWorkspace = {
    id: "workspace:drone-company-stale",
    label: "Drone company project",
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1\\index.html",
    previewUrl: "http://127.0.0.1:4173/",
    browserSessionId: "browser_session:drone-preview",
    browserSessionIds: ["browser_session:drone-preview"],
    browserSessionStatus: "closed",
    browserProcessPid: 41001,
    previewProcessLeaseId: "proc_preview_drone_old",
    previewProcessLeaseIds: ["proc_preview_drone_old"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1",
    lastKnownPreviewProcessPid: 4001,
    stillControllable: false,
    ownershipState: "stale",
    previewStackState: "detached",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1\\index.html"],
    sourceJobId: "job-drone-old",
    updatedAt: "2026-03-03T00:00:24.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
    10,
    null,
    null,
    undefined,
    undefined,
    null,
    [
      {
        leaseId: "proc_preview_drone_old",
        taskId: "task-old-drone",
        actionId: "action-old-drone",
        pid: 4001,
        commandFingerprint: "python-http-server",
        cwd: "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1",
        shellExecutable: "powershell.exe",
        shellKind: "powershell",
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
    /Remembered preview lease ids from earlier assistant work: proc_preview_drone_old/
  );
  assert.match(
    executionInput,
    /Remembered preview lease status from earlier assistant work:\n- leaseId=proc_preview_drone_old; cwd=C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1; status=PROCESS_STOPPED; stopRequested=yes/
  );
  assert.doesNotMatch(executionInput, /Exact tracked preview lease ids: proc_preview_drone_old/);
  assert.match(
    executionInput,
    /If no exact tracked holder is proven, inspect first and then clarify before touching untracked local processes\./
  );
});

test("buildConversationAwareExecutionInput surfaces matching runtime preview leases for local organization requests", async () => {
  const session = buildSession();

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
    10,
    null,
    null,
    undefined,
    undefined,
    null,
    [
      {
        leaseId: "proc_drone_1",
        taskId: "task-1",
        actionId: "action-1",
        pid: 4001,
        commandFingerprint: "python-http-server",
        cwd: "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1",
        shellExecutable: "powershell.exe",
        shellKind: "powershell",
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
  assert.match(executionInput, /Candidate runtime-managed preview lease: leaseId=proc_drone_1; cwd=C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1; status=PROCESS_STILL_RUNNING; stopRequested=no/);
  assert.doesNotMatch(executionInput, /proc_other_1/);
  assert.match(executionInput, /Prefer inspect_workspace_resources or inspect_path_holders before any shutdown/i);
  assert.match(executionInput, /Do not stop those candidate preview leases directly from this hint block alone/i);
});

test("buildConversationAwareExecutionInput surfaces attributable remembered roots before looser organization hints", async () => {
  const session = buildSession();
  session.pathDestinations.push(
    {
      id: "dest-drone-folder",
      label: "Drone company folder",
      resolvedPath: "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1",
      sourceJobId: "job-drone-1",
      updatedAt: "2026-03-03T00:00:20.000Z"
    },
    {
      id: "dest-drone-file",
      label: "Drone company index",
      resolvedPath: "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-2\\index.html",
      sourceJobId: "job-drone-2",
      updatedAt: "2026-03-03T00:00:21.000Z"
    }
  );
  session.browserSessions.push({
    id: "browser_session:drone-old",
    label: "Older drone preview",
    url: "http://127.0.0.1:4175/",
    visibility: "visible",
    status: "closed",
    sourceJobId: "job-drone-1",
    openedAt: "2026-03-03T00:00:10.000Z",
    closedAt: "2026-03-03T00:00:30.000Z",
    controllerKind: "playwright_managed",
    controlAvailable: false,
    browserProcessPid: null,
    linkedProcessLeaseId: "proc_drone_old",
    linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1",
    linkedProcessPid: 4001
  });

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
    10,
    null,
    null,
    undefined,
    undefined,
    null,
    [
      {
        leaseId: "proc_drone_old",
        taskId: "task-old-drone",
        actionId: "action-old-drone",
        pid: 4001,
        commandFingerprint: "python-http-server",
        cwd: "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1",
        shellExecutable: "powershell.exe",
        shellKind: "powershell",
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
  assert.match(executionInput, /root=C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1; reason=remembered destination/);
  assert.match(executionInput, /root=C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-2; reason=remembered destination/);
  assert.match(executionInput, /Attributable remembered preview lease: leaseId=proc_drone_old; cwd=C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-1; status=PROCESS_STOPPED; stopRequested=yes/);
  assert.match(executionInput, /inspect_path_holders or inspect_workspace_resources against these exact remembered roots first/i);
});

test("buildConversationAwareExecutionInput surfaces durable handoff and remembered browser workspace roots for older organization follow-ups", async () => {
  const session = buildSession();
  session.returnHandoff = {
    id: "handoff:drone-older-work",
    status: "completed",
    goal: "Finish the older drone-company draft and leave it ready for review.",
    summary: "I finished the older drone-company draft and saved the review checkpoint.",
    nextSuggestedStep: "Tell me what section to refine next.",
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company-older-1",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company-older-1\\index.html",
    previewUrl: "file:///C:/Users/testuser/Desktop/drone-company-older-1/index.html",
    changedPaths: [
      "C:\\Users\\testuser\\Desktop\\drone-company-older-2\\styles.css"
    ],
    sourceJobId: "job-drone-older",
    updatedAt: "2026-03-03T00:00:22.000Z"
  };
  session.browserSessions.push({
    id: "browser_session:drone-older-detached",
    label: "Older detached drone preview",
    url: "file:///C:/Users/testuser/Desktop/drone-company-older-3/index.html",
    visibility: "visible",
    status: "open",
    sourceJobId: "job-drone-older",
    openedAt: "2026-03-03T00:00:21.000Z",
    closedAt: null,
    controllerKind: "os_default",
    controlAvailable: false,
    browserProcessPid: null,
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company-older-3",
    linkedProcessLeaseId: null,
    linkedProcessCwd: null,
    linkedProcessPid: null
  });

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
    10
  );

  assert.match(executionInput, /Workspace recovery context for this chat:/);
  assert.match(executionInput, /No exact tracked workspace holder is currently known for this request\./);
  assert.match(
    executionInput,
    /root=C:\\Users\\testuser\\Desktop\\drone-company-older-1; reason=durable handoff workspace/
  );
  assert.match(
    executionInput,
    /root=C:\\Users\\testuser\\Desktop\\drone-company-older-2; reason=durable handoff changed file/
  );
  assert.match(
    executionInput,
    /root=C:\\Users\\testuser\\Desktop\\drone-company-older-3; reason=remembered browser workspace/
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
    label: "Desktop drone folder",
    resolvedPath: "C:\\Users\\testuser\\Desktop\\drone-folder",
    sourceJobId: "job-4",
    updatedAt: "2026-03-03T00:00:25.000Z"
  });
  session.activeWorkspace = {
    id: "workspace:drone-folder",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-folder",
    primaryArtifactPath: null,
    previewUrl: "file:///C:/Users/testuser/Desktop/drone-folder/index.html",
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
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\drone-folder\\index.html"],
    sourceJobId: "job-4",
    updatedAt: "2026-03-03T00:00:25.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "Put it in the same place as before and leave it open for me.",
    10
  );

  assert.match(executionInput, /Remembered save\/open locations from this chat:/);
  assert.match(executionInput, /The most recent workspace in this chat is orphaned at C:\\Users\\testuser\\Desktop\\drone-folder/i);
  assert.match(executionInput, /require fresh inspection before assuming preview or process control still exists/i);
});

test("buildConversationAwareExecutionInput grounds the Telegram desktop cleanup wording as a real move", async () => {
  const session = buildSession();
  session.activeWorkspace = {
    id: "workspace:drone-company-live-smoke-9",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-9",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-9\\index.html",
    previewUrl: "file:///C:/Users/testuser/Desktop/drone-company-live-smoke-9/index.html",
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
      "C:\\Users\\testuser\\Desktop\\drone-company-live-smoke-9\\index.html"
    ],
    sourceJobId: "job-cleanup-1",
    updatedAt: "2026-03-03T00:00:25.000Z"
  };

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "One last real-world thing: please go ahead and clean up my desktop now by moving every folder there that starts with drone-company into drone-folder. I do mean all of them, so you do not need to ask again before doing it.",
    10
  );

  assert.match(executionInput, /Natural desktop-organization follow-up:/);
  assert.match(executionInput, /real Desktop folder move, not just an inspection or summary/i);
  assert.match(executionInput, /Strongest remembered Desktop root in this chat: C:\\Users\\testuser\\Desktop/i);
  assert.match(executionInput, /Treat the named destination as C:\\Users\\testuser\\Desktop\\drone-folder/i);
  assert.match(executionInput, /Match Desktop folders whose names start with drone-company\./i);
  assert.match(
    executionInput,
    /The current tracked workspace folder drone-company-live-smoke-9 also matches that requested prefix; include it in the move unless the user explicitly excluded it\./i
  );
  assert.match(executionInput, /The user explicitly authorized moving all matching folders now; do not ask again before executing the move unless a new blocker appears\./i);
  assert.match(executionInput, /This run must include a real folder move side effect\./i);
});

test("buildConversationAwareExecutionInput does not misread build destinations as Desktop cleanup work", async () => {
  const executionInput = await buildConversationAwareExecutionInput(
    buildSession(),
    "Hey, build me a tech landing page for air drones, go until you finish, put it on my desktop, create a folder called drone-company, and leave it open for me.",
    10
  );

  assert.doesNotMatch(executionInput, /Natural desktop-organization follow-up:/);
});

test("buildConversationAwareExecutionInput derives workspace root and artifact from a tracked file preview", async () => {
  const session = buildSession();
  session.browserSessions.push({
    id: "browser-file-1",
    label: "Landing page preview",
    url: "file:///C:/Users/testuser/Desktop/drone-company/index.html",
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
    previewUrl: "file:///C:/Users/testuser/Desktop/drone-company/index.html",
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
        url: "file:///C:/Users/testuser/Desktop/drone-company/index.html",
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

  assert.match(executionInput, /Root path: C:\\Users\\testuser\\Desktop\\drone-company/);
  assert.match(executionInput, /Primary artifact: C:\\Users\\testuser\\Desktop\\drone-company\\index.html/);
  assert.match(executionInput, /Preview URL: file:\/\/\/C:\/Users\/testuser\/Desktop\/drone-company\/index\.html/);
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
    linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
    linkedProcessPid: 42002,
    workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });
  session.activeWorkspace = {
    id: "workspace:drone-company",
    label: "Current project workspace",
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
    primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
    previewUrl: "http://127.0.0.1:4173/index.html",
    browserSessionId: "browser-owned-1",
    browserSessionIds: ["browser-owned-1"],
    browserSessionStatus: "open",
    browserProcessPid: 42001,
    previewProcessLeaseId: "proc-owned-1",
    previewProcessLeaseIds: ["proc-owned-1"],
    previewProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
    lastKnownPreviewProcessPid: 42002,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_and_preview",
    lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
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


test("buildConversationAwareExecutionInput can use media continuity cues to surface bounded contextual recall", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "user",
        text: "We never really found out how Billy's MRI turned out.",
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
          threadKey: "thread_billy",
          topicKey: "billy_mri",
          topicLabel: "Billy MRI",
          state: "paused",
          resumeHint: "Billy was waiting on MRI results and the outcome never got resolved.",
          openLoops: [
            {
              loopId: "loop_billy_mri",
              threadKey: "thread_billy",
              entityRefs: ["billy", "mri"],
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
          topicKey: "billy_mri",
          label: "Billy MRI",
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
        episodeId: "episode_billy_mri",
        title: "Billy MRI results were still pending",
        summary: "Billy was waiting on MRI results and the outcome never got resolved.",
        status: "outcome_unknown",
        lastMentionedAt: "2026-02-14T15:00:00.000Z",
        entityRefs: ["Billy", "MRI"],
        entityLinks: [
          {
            entityKey: "entity_billy",
            canonicalName: "Billy"
          }
        ],
        openLoopLinks: [
          {
            loopId: "loop_billy_mri",
            threadKey: "thread_billy",
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
          fileId: "image-billy-1",
          fileUniqueId: "image-billy-uniq-1",
          mimeType: "image/png",
          fileName: "billy-update.png",
          sizeBytes: 2048,
          caption: "Here is the note about Billy.",
          durationSeconds: null,
          width: 1024,
          height: 768,
          interpretation: {
            summary: "The screenshot mentions Billy and says the MRI results still have not come back.",
            transcript: null,
            ocrText: "Billy MRI results still pending",
            confidence: 0.93,
            provenance: "fixture screenshot",
            source: "fixture_catalog",
            entityHints: ["Billy", "MRI"]
          }
        }
      ]
    }
  );

  assert.match(executionInput, /Contextual recall opportunity \(optional\):/);
  assert.match(executionInput, /Media continuity cues: billy, mri/);
  assert.match(executionInput, /Relevant situation: Billy MRI results were still pending/i);
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


