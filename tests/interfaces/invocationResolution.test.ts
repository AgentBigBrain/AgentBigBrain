/**
 * @fileoverview Covers canonical non-command invocation resolution below the stable ingress coordinator.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSessionSeed,
  createFollowUpRuleContext,
  createPulseLexicalRuleContext
} from "../../src/interfaces/conversationManagerHelpers";
import {
  resolveConversationInvocation
} from "../../src/interfaces/conversationRuntime/invocationResolution";
import type {
  ConversationInboundMessage,
  ExecuteConversationTask
} from "../../src/interfaces/conversationRuntime/managerContracts";
import type { ConversationIngressDependencies } from "../../src/interfaces/conversationRuntime/contracts";
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
      receivedAt: "2026-03-07T16:30:00.000Z"
    }),
    ...overrides
  };
}

function buildQueuedJob(input: string): ConversationJob {
  return {
    id: "job-1",
    input,
    executionInput: input,
    createdAt: "2026-03-07T16:30:00.000Z",
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

function buildMessage(text: string): ConversationInboundMessage {
  return {
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
    receivedAt: "2026-03-07T16:30:05.000Z",
    text
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

const noopExecuteTask: ExecuteConversationTask = async (input) => ({ summary: input });

test("resolveConversationInvocation handles natural pulse commands without starting the worker", async () => {
  const session = buildSession({
    agentPulse: {
      ...buildSession().agentPulse,
      optIn: true
    }
  });

  const resolution = await resolveConversationInvocation(
    session,
    buildMessage("turn off pulse"),
    noopExecuteTask,
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for natural pulse commands");
    })
  );

  assert.ok(resolution.reply.includes("Agent Pulse is now OFF"));
  assert.equal(resolution.shouldStartWorker, false);
  assert.equal(session.agentPulse.optIn, false);
});

test("resolveConversationInvocation routes normal messages into the queue and requests worker startup", async () => {
  const session = buildSession();
  let capturedExecutionInput = "";

  const resolution = await resolveConversationInvocation(
    session,
    buildMessage("Please draft a concise summary"),
    noopExecuteTask,
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedExecutionInput = executionInput ?? "";
      currentSession.queuedJobs.push(buildQueuedJob(input));
      return {
        reply: "queued normal message",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(resolution.reply, "queued normal message");
  assert.equal(resolution.shouldStartWorker, true);
  assert.equal(session.queuedJobs.length, 1);
  assert.equal(capturedExecutionInput, "Please draft a concise summary");
  assert.ok(!capturedExecutionInput.includes("Deterministic routing hint:"));
});

test("resolveConversationInvocation keeps ordinary chat synchronous without queueing work", async () => {
  const session = buildSession();
  let executeCalls = 0;
  let directConversationCalls = 0;

  const resolution = await resolveConversationInvocation(
    session,
    buildMessage("What's your name?"),
    async (input) => {
      executeCalls += 1;
      assert.equal(input, "What's your name?");
      return {
        summary: "I'm BigBrain."
      };
    },
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for ordinary chat");
      },
      {
        runDirectConversationTurn: async (input) => {
          directConversationCalls += 1;
          assert.equal(input, "What's your name?");
          return {
            summary: "I'm BigBrain."
          };
        }
      }
    )
  );

  assert.equal(resolution.reply, "I'm BigBrain.");
  assert.equal(resolution.shouldStartWorker, false);
  assert.equal(directConversationCalls, 1);
  assert.equal(executeCalls, 0);
  assert.equal(session.queuedJobs.length, 0);
});

test("resolveConversationInvocation preserves a direct-route no-worker decision even when older work is queued", async () => {
  const session = buildSession({
    queuedJobs: [buildQueuedJob("older queued work")]
  });
  let directConversationCalls = 0;

  const resolution = await resolveConversationInvocation(
    session,
    buildMessage("What's your name?"),
    noopExecuteTask,
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for ordinary chat turns");
      },
      {
        runDirectConversationTurn: async (input) => {
          directConversationCalls += 1;
          assert.equal(input, "What's your name?");
          return {
            summary: "I'm BigBrain."
          };
        }
      }
    )
  );

  assert.equal(resolution.reply, "I'm BigBrain.");
  assert.equal(resolution.shouldStartWorker, false);
  assert.equal(directConversationCalls, 1);
  assert.equal(session.queuedJobs.length, 1);
});

test("resolveConversationInvocation prefers active work status over pulse status for generic status prompts", async () => {
  const session = buildSession({
    runningJobId: "job-1",
    queuedJobs: [buildQueuedJob("older queued work")],
    progressState: {
      status: "working",
      message: "organizing the React landing page files",
      jobId: "job-1",
      updatedAt: "2026-03-07T16:30:04.000Z"
    }
  });

  const resolution = await resolveConversationInvocation(
    session,
    buildMessage("What's the status?"),
    noopExecuteTask,
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for generic status prompts");
    })
  );

  assert.match(
    resolution.reply,
    /I'm working on organizing the React landing page files\./
  );
  assert.equal(resolution.shouldStartWorker, false);
});

test("resolveConversationInvocation keeps explicit pulse status requests on the pulse-control path", async () => {
  const session = buildSession({
    runningJobId: "job-1",
    queuedJobs: [buildQueuedJob("older queued work")],
    progressState: {
      status: "working",
      message: "organizing the React landing page files",
      jobId: "job-1",
      updatedAt: "2026-03-07T16:30:04.000Z"
    }
  });

  const resolution = await resolveConversationInvocation(
    session,
    buildMessage("pulse status"),
    noopExecuteTask,
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for explicit pulse status requests");
    })
  );

  assert.match(resolution.reply, /Agent Pulse: off/);
  assert.equal(resolution.shouldStartWorker, false);
});

test("resolveConversationInvocation does not treat mixed status-tracking recap requests as pulse status", async () => {
  const session = buildSession();

  const resolution = await resolveConversationInvocation(
    session,
    buildMessage(
      "Switch gears back to memory and status tracking. Tell me which employment facts are current versus historical and whether the Foundry Echo browser page is still open."
    ),
    noopExecuteTask,
    buildDependencies(() => {
      throw new Error("enqueueJob should not run when the status/recall path can answer inline");
    })
  );

  assert.match(resolution.reply, /tracked browser windows left open right now/i);
  assert.doesNotMatch(resolution.reply, /Agent Pulse:/i);
  assert.equal(resolution.shouldStartWorker, false);
  assert.equal(session.queuedJobs.length, 0);
});

test("resolveConversationInvocation does not treat OCR text as a pulse command", async () => {
  const session = buildSession();
  let directConversationCalls = 0;

  const resolution = await resolveConversationInvocation(
    session,
    {
      ...buildMessage("Please review the attached PDF and tell me what concrete names it contains."),
      commandRoutingText:
        "Please review the attached PDF and tell me what concrete names it contains.",
      media: {
        attachments: [
          {
            kind: "document",
            provider: "telegram",
            fileId: "doc-1",
            fileUniqueId: "doc-1-uniq",
            mimeType: "application/pdf",
            fileName: "filing.pdf",
            sizeBytes: 4096,
            caption: null,
            durationSeconds: null,
            width: null,
            height: null,
            interpretation: {
              summary: "business filing.",
              transcript: null,
              ocrText:
                "Signed before a notary public in Wayne County. Present entity ACME SAMPLE DESIGN, LLC.",
              confidence: 0.92,
              provenance: "document extraction",
              source: "fixture_catalog",
              entityHints: ["ACME SAMPLE DESIGN, LLC", "Wayne County"]
            }
          }
        ]
      }
    },
    noopExecuteTask,
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for ordinary document review chat");
      },
      {
        runDirectConversationTurn: async (input) => {
          directConversationCalls += 1;
          assert.match(input, /Please review the attached PDF/);
          assert.match(input, /notary public/i);
          assert.match(input, /ACME SAMPLE DESIGN, LLC/);
          return {
            summary: "The filing names ACME SAMPLE DESIGN, LLC."
          };
        }
      }
    )
  );

  assert.equal(resolution.reply, "The filing names ACME SAMPLE DESIGN, LLC.");
  assert.equal(resolution.shouldStartWorker, false);
  assert.equal(directConversationCalls, 1);
  assert.equal(session.agentPulse.optIn, false);
});
