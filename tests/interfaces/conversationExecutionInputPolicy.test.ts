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

/**
 * Creates a stable session fixture for execution-input policy tests.
 *
 * @returns Fresh seeded conversation session.
 */
function buildSession(): ConversationSession {
  return buildSessionSeed({
    provider: "telegram",
    conversationId: "chat-execution-policy",
    userId: "user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: "2026-03-03T00:00:00.000Z"
  });
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

  const executionInput = await buildConversationAwareExecutionInput(
    session,
    "my release status is pending",
    10,
    classifyRoutingIntentV1("schedule 3 focus blocks next week")
  );

  assert.match(executionInput, /Recent conversation context \(oldest to newest\):/);
  assert.match(executionInput, /Turn-local status update \(authoritative for this turn\):/);
  assert.match(executionInput, /Deterministic routing hint:/);
  assert.match(executionInput, /Current user request:/);
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


