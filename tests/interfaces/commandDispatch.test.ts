/**
 * @fileoverview Covers canonical slash-command dispatch below the stable ingress coordinator.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSessionSeed,
  createFollowUpRuleContext,
  createPulseLexicalRuleContext
} from "../../src/interfaces/conversationManagerHelpers";
import { buildConversationInboundUserInput } from "../../src/interfaces/mediaRuntime/mediaNormalization";
import type { ConversationIngressDependencies } from "../../src/interfaces/conversationRuntime/contracts";
import { handleConversationCommand } from "../../src/interfaces/conversationRuntime/commandDispatch";
import type {
  ConversationInboundMessage
} from "../../src/interfaces/conversationRuntime/managerContracts";
import type { ConversationJob, ConversationSession } from "../../src/interfaces/sessionStore";
import { buildConversationIngressConfig } from "../helpers/conversationFixtures";

function buildSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ...buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-1",
      userId: "user-1",
      username: "agentowner",
      conversationVisibility: "private",
      receivedAt: "2026-03-07T17:00:00.000Z"
    }),
    ...overrides
  };
}

function buildMessage(text: string): ConversationInboundMessage {
  return {
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
    receivedAt: "2026-03-07T17:00:05.000Z",
    text
  };
}

function buildVoiceCommandMessage(transcript: string): ConversationInboundMessage {
  const media = {
    attachments: [
      {
        kind: "voice" as const,
        provider: "telegram" as const,
        fileId: "voice-1",
        fileUniqueId: "voice-1-uniq",
        mimeType: "audio/ogg",
        fileName: null,
        sizeBytes: 1024,
        caption: null,
        durationSeconds: 4,
        width: null,
        height: null,
        interpretation: {
          summary: `Voice note transcript: ${transcript}`,
          transcript,
          ocrText: null,
          confidence: 0.96,
          provenance: "fixture transcription",
          source: "fixture_catalog" as const,
          entityHints: []
        }
      }
    ]
  };

  return {
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
    receivedAt: "2026-03-07T17:00:05.000Z",
    text: buildConversationInboundUserInput("", media),
    media
  };
}

function buildQueuedJob(input: string): ConversationJob {
  return {
    id: "job-1",
    input,
    executionInput: input,
    createdAt: "2026-03-07T17:00:05.000Z",
    startedAt: null,
    completedAt: null,
    status: "queued",
    resultSummary: null,
    errorMessage: null,
    ackTimerGeneration: 0,
    ackEligibleAt: null,
    ackLifecycleState: "NOT_SENT",
    ackMessageId: null,
    ackSentAt: null,
    ackEditAttemptCount: 0,
    ackLastErrorCode: null,
    finalDeliveryOutcome: "not_attempted",
    finalDeliveryAttemptCount: 0,
    finalDeliveryLastErrorCode: null,
    finalDeliveryLastAttemptAt: null
  };
}

function buildDependencies(
  enqueueJob: ConversationIngressDependencies["enqueueJob"],
  overrides: Partial<ConversationIngressDependencies> = {}
): ConversationIngressDependencies {
  return {
    store: {
      getSession: async () => null,
      setSession: async () => undefined,
      listSessions: async () => []
    } as ConversationIngressDependencies["store"],
    config: buildConversationIngressConfig({
      maxProposalInputChars: 400
    }),
    followUpRuleContext: createFollowUpRuleContext(null),
    pulseLexicalRuleContext: createPulseLexicalRuleContext(null),
    interpretConversationIntent: undefined,
    intentInterpreterConfidenceThreshold: 0.75,
    runCheckpointReview: undefined,
    isWorkerActive: () => false,
    clearAckTimer: () => undefined,
    setWorkerBinding: () => undefined,
    startWorkerIfNeeded: async () => undefined,
    enqueueJob,
    buildAutonomousExecutionInput: (goal) => `[AUTONOMOUS_LOOP_GOAL]\n${goal}`,
    ...overrides
  };
}

test("handleConversationCommand keeps status debug usage deterministic", async () => {
  const session = buildSession();
  const reply = await handleConversationCommand(
    session,
    buildMessage("/status verbose"),
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for status usage");
    })
  );

  assert.equal(reply, "Usage: /status [debug]");
});

test("handleConversationCommand routes /chat through canonical queue routing", async () => {
  const session = buildSession();
  let capturedExecutionInput = "";

  const reply = await handleConversationCommand(
    session,
    buildMessage("/chat create a React app at C:\\Temp\\demo and execute now"),
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedExecutionInput = executionInput ?? "";
      currentSession.queuedJobs.push(buildQueuedJob(input));
      return {
        reply: "queued chat job",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(reply, "queued chat job");
  assert.equal(session.queuedJobs.length, 1);
  assert.ok(capturedExecutionInput.includes("Resolved semantic route:"));
  assert.ok(capturedExecutionInput.includes("- routeId: framework_app_build"));
});

test("handleConversationCommand keeps /auto policy and turn recording behavior", async () => {
  const session = buildSession();

  const disabledReply = await handleConversationCommand(
    session,
    buildMessage("/auto ship it"),
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run when /auto is disabled");
      },
      {
        config: {
          ...buildConversationIngressConfig({
            allowAutonomousViaInterface: false,
            maxProposalInputChars: 400
          })
        }
      }
    )
  );
  assert.equal(
    disabledReply,
    "Autonomous loop is disabled. Set BRAIN_ALLOW_AUTONOMOUS_VIA_INTERFACE=true to enable."
  );

  const enabledReply = await handleConversationCommand(
    session,
    buildMessage("/auto ship it"),
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      currentSession.queuedJobs.push(buildQueuedJob(input));
      assert.equal(executionInput, "[AUTONOMOUS_LOOP_GOAL]\nship it");
      return {
        reply: "queued autonomous goal",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(
    enabledReply,
    "Starting autonomous loop for: ship it\nqueued autonomous goal"
  );
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    "/auto ship it"
  );
});

test("handleConversationCommand routes /memory through canonical review dispatch", async () => {
  const session = buildSession();
  let capturedReviewTaskId = "";

  const reply = await handleConversationCommand(
    session,
    buildMessage("/memory"),
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for /memory");
      },
      {
        reviewConversationMemory: async (request) => {
          capturedReviewTaskId = request.reviewTaskId;
          return [
            {
              episodeId: "episode_owen_fall",
              title: "Owen fell down",
              summary: "Owen fell down and the outcome was unresolved.",
              status: "unresolved",
              lastMentionedAt: "2026-03-07T10:00:00.000Z",
              resolvedAt: null,
              confidence: 0.91,
              sensitive: false
            }
          ];
        }
      }
    )
  );

  assert.match(capturedReviewTaskId, /^memory_review_/);
  assert.match(reply, /Remembered situations:/);
  assert.match(reply, /Owen fell down/);
});

test("handleConversationCommand renders the canonical skill inventory for /skills", async () => {
  const session = buildSession();

  const reply = await handleConversationCommand(
    session,
    buildMessage("/skills"),
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for /skills");
      },
      {
        listAvailableSkills: async () => [
          {
            name: "triage_planner_failure",
            description: "Inspect planner failures and summarize likely causes.",
            userSummary: "Reusable tool for planner failure triage.",
            verificationStatus: "verified",
            riskLevel: "low",
            tags: ["planner", "tests"],
            invocationHints: ["Ask me to run skill triage_planner_failure."],
            lifecycleStatus: "active",
            updatedAt: "2026-03-10T12:00:00.000Z"
          }
        ]
      }
    )
  );

  assert.match(reply, /^Available skills:/);
  assert.match(reply, /triage_planner_failure/);
  assert.match(reply, /verified, low risk/);
});

test("handleConversationCommand fails closed when /skills inventory is unavailable", async () => {
  const session = buildSession();

  const reply = await handleConversationCommand(
    session,
    buildMessage("/skills"),
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for /skills");
    })
  );

  assert.equal(reply, "Skill inventory is unavailable in this runtime.");
});

test("handleConversationCommand uses media-normalized voice command text for /skills", async () => {
  const session = buildSession();

  const reply = await handleConversationCommand(
    session,
    buildVoiceCommandMessage("command skills"),
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for voice-promoted /skills");
      },
      {
        listAvailableSkills: async () => [
          {
            name: "triage_planner_failure",
            description: "Inspect planner failures and summarize likely causes.",
            userSummary: "Reusable tool for planner failure triage.",
            verificationStatus: "verified",
            riskLevel: "low",
            tags: ["planner", "tests"],
            invocationHints: ["Ask me to run skill triage_planner_failure."],
            lifecycleStatus: "active",
            updatedAt: "2026-03-10T12:00:00.000Z"
          }
        ]
      }
    )
  );

  assert.match(reply, /^Available skills:/);
  assert.match(reply, /triage_planner_failure/);
});

test("handleConversationCommand updates and reports the per-session backend override", async () => {
  const session = buildSession();

  const setReply = await handleConversationCommand(
    session,
    buildMessage("/backend codex_oauth"),
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for /backend");
    })
  );
  assert.equal(session.modelBackendOverride, "codex_oauth");
  assert.match(setReply, /Session backend override set to codex_oauth/);

  const statusReply = await handleConversationCommand(
    session,
    buildMessage("/backend status"),
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for /backend status");
    })
  );
  assert.equal(
    statusReply,
    "Session backend override: codex_oauth."
  );

  const clearReply = await handleConversationCommand(
    session,
    buildMessage("/backend clear"),
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for /backend clear");
    })
  );
  assert.equal(session.modelBackendOverride, null);
  assert.equal(session.codexAuthProfileId, null);
  assert.match(clearReply, /Cleared the session backend override/);
});

test("handleConversationCommand fails closed for unsupported backend overrides", async () => {
  const session = buildSession();

  const reply = await handleConversationCommand(
    session,
    buildMessage("/backend made_up_backend"),
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for unsupported /backend");
    })
  );

  assert.equal(session.modelBackendOverride, null);
  assert.equal(
    reply,
    "Unsupported backend. Use /backend status, /backend clear, or one of: mock, ollama, openai_api, codex_oauth."
  );
});

test("handleConversationCommand updates and clears the per-session Codex profile override", async () => {
  const session = buildSession();

  const setReply = await handleConversationCommand(
    session,
    buildMessage("/profile work"),
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for /profile");
    })
  );
  assert.equal(session.codexAuthProfileId, "work");
  assert.equal(session.modelBackendOverride, "codex_oauth");
  assert.match(setReply, /Session Codex profile override set to work/);

  const statusReply = await handleConversationCommand(
    session,
    buildMessage("/profile status"),
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for /profile status");
    })
  );
  assert.equal(
    statusReply,
    "Session Codex profile override: work."
  );

  const clearReply = await handleConversationCommand(
    session,
    buildMessage("/profile clear"),
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for /profile clear");
    })
  );
  assert.equal(session.codexAuthProfileId, null);
  assert.match(clearReply, /Cleared the session Codex profile override/);
});
