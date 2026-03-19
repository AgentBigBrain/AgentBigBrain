/**
 * @fileoverview Covers canonical conversation routing, including persisted clarification state and natural capability discovery.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildSessionSeed,
  createFollowUpRuleContext,
  normalizeAssistantTurnText
} from "../../src/interfaces/conversationManagerHelpers";
import {
  routeConversationMessageInput,
  type ConversationRoutingDependencies
} from "../../src/interfaces/conversationRuntime/conversationRouting";
import { parseAutonomousExecutionInput } from "../../src/interfaces/conversationRuntime/managerContracts";
import type { ConversationJob, ConversationSession } from "../../src/interfaces/sessionStore";
import type { SkillInventoryEntry } from "../../src/organs/skillRegistry/contracts";
import type { ConversationCapabilitySummary } from "../../src/interfaces/conversationRuntime/managerContracts";
import {
  buildConversationBrowserSessionFixture,
  buildConversationJobFixture
} from "../helpers/conversationFixtures";

function buildSession(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    ...buildSessionSeed({
      provider: "telegram",
      conversationId: "chat-1",
      userId: "user-1",
      username: "agentowner",
      conversationVisibility: "private",
      receivedAt: "2026-03-11T18:05:00.000Z"
    }),
    ...overrides
  };
}

function buildQueuedJob(input: string, executionInput: string): ConversationJob {
  return {
    id: "job-1",
    input,
    executionInput,
    createdAt: "2026-03-11T18:05:05.000Z",
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
  enqueueJob: ConversationRoutingDependencies["enqueueJob"],
  overrides: Partial<ConversationRoutingDependencies> = {}
): ConversationRoutingDependencies {
  return {
    followUpRuleContext: createFollowUpRuleContext(null),
    config: {
      allowAutonomousViaInterface: true,
      maxContextTurnsForExecution: 8,
      maxConversationTurns: 20
    },
    enqueueJob,
    ...overrides
  };
}

test("routeConversationMessageInput promotes strong end-to-end wording into autonomous execution", async () => {
  const session = buildSession();
  let capturedExecutionInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Hey, build me a tech landing page for air drones, go until you finish, put it on my desktop, create a folder called drone-company, and leave it open for me.",
    "2026-03-11T18:05:05.000Z",
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedExecutionInput = executionInput ?? "";
      currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
      return {
        reply: "",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(result.shouldStartWorker, true);
  assert.equal(
    result.reply,
    "I'm taking this end to end now. I'll keep going until it's done or I hit a real blocker."
  );
  assert.match(capturedExecutionInput, /^\[AUTONOMOUS_LOOP_GOAL\]/);
  const autonomousPayload = parseAutonomousExecutionInput(capturedExecutionInput);
  assert.ok(autonomousPayload);
  assert.equal(
    autonomousPayload?.goal,
    "Hey, build me a tech landing page for air drones, go until you finish, put it on my desktop, create a folder called drone-company, and leave it open for me."
  );
  assert.match(
    autonomousPayload?.initialExecutionInput ?? "",
    /Current user request:/
  );
  assert.match(
    autonomousPayload?.initialExecutionInput ?? "",
    /Autonomous execution request\./
  );
  assert.equal(session.modeContinuity?.activeMode, "autonomous");
  assert.equal(session.modeContinuity?.source, "natural_intent");
});

test("routeConversationMessageInput persists execution-mode clarification and resolves the next turn against it", async () => {
  const session = buildSession();
  let capturedInput = "";
  let capturedExecutionInput = "";

  const firstResult = await routeConversationMessageInput(
    session,
    "Create me that landing page with a hero and call to action.",
    "2026-03-11T18:05:05.000Z",
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedInput = input;
      capturedExecutionInput = executionInput ?? "";
      currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
      return {
        reply: "queued",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(firstResult.reply, "Do you want me to plan it first or build it now?");
  assert.equal(firstResult.shouldStartWorker, false);
  assert.ok(session.activeClarification);
  assert.deepEqual(session.progressState, {
    status: "waiting_for_user",
    message: "Do you want me to plan it first or build it now?",
    jobId: null,
    updatedAt: "2026-03-11T18:05:05.000Z"
  });

  const secondResult = await routeConversationMessageInput(
    session,
    "Build it now.",
    "2026-03-11T18:05:10.000Z",
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedInput = input;
      capturedExecutionInput = executionInput ?? "";
      currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
      return {
        reply: "",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(secondResult.shouldStartWorker, true);
  assert.equal(session.activeClarification, null);
  assert.equal(session.progressState, null);
  assert.equal(capturedInput, "Create me that landing page with a hero and call to action.");
  assert.ok(capturedExecutionInput.includes("User selected: Build it now."));
  assert.equal(session.modeContinuity?.activeMode, "build");
  assert.equal(session.modeContinuity?.source, "clarification_answer");
});

test("routeConversationMessageInput retries a recovery clarification when the user approves shutdown and retry", async () => {
  const session = buildSession({
    activeClarification: {
      id: "clarification_1",
      kind: "task_recovery",
      sourceInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      question:
        "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?",
      requestedAt: "2026-03-13T14:05:00.000Z",
      matchedRuleId: "post_execution_locked_folder_recovery",
      recoveryInstruction:
        "Recovery instruction: stop only these exact tracked preview-process lease ids if they are still active: leaseId=\"proc_preview_1\".",
      options: [
        {
          id: "retry_with_shutdown",
          label: "Yes, shut them down and retry"
        },
        {
          id: "cancel",
          label: "No, leave them alone"
        }
      ]
    }
  });
  let capturedInput = "";
  let capturedExecutionInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Yes, please do that.",
    "2026-03-13T14:05:05.000Z",
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedInput = input;
      capturedExecutionInput = executionInput ?? "";
      currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
      return {
        reply: "queued",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(result.shouldStartWorker, true);
  assert.equal(
    capturedInput,
    "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects."
  );
  assert.match(capturedExecutionInput, /leaseId="proc_preview_1"/);
  assert.equal(session.activeClarification, null);
  assert.equal(session.modeContinuity?.activeMode, "build");
  assert.equal(session.modeContinuity?.source, "clarification_answer");
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    "Yes, please do that."
  );
});

test("routeConversationMessageInput continues inspection-first recovery when the clarification is not a proven shutdown yet", async () => {
  const session = buildSession({
    activeClarification: {
      id: "clarification_2",
      kind: "task_recovery",
      sourceInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      question:
        "I couldn't move those folders yet because likely local preview holders may still be using them. I can inspect those holders more closely first. Do you want me to continue that recovery?",
      requestedAt: "2026-03-13T14:06:00.000Z",
      matchedRuleId: "post_execution_untracked_holder_recovery_clarification",
      recoveryInstruction:
        "Recovery instruction: inspect the likely untracked holder processes more closely. Do not stop them automatically.",
      options: [
        {
          id: "continue_recovery",
          label: "Yes, inspect and continue"
        },
        {
          id: "cancel",
          label: "No, leave them alone"
        }
      ]
    }
  });
  let capturedExecutionInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Yes, inspect them more closely first.",
    "2026-03-13T14:06:05.000Z",
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedExecutionInput = executionInput ?? "";
      currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
      return {
        reply: "queued",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(result.shouldStartWorker, true);
  assert.match(capturedExecutionInput, /User selected: Yes, inspect and continue\./);
  assert.match(capturedExecutionInput, /inspect the likely untracked holder processes more closely/i);
  assert.equal(session.activeClarification, null);
  assert.equal(session.modeContinuity?.activeMode, "build");
});

test("routeConversationMessageInput lets the user decline a recovery clarification without queueing more work", async () => {
  const session = buildSession({
    activeClarification: {
      id: "clarification_1",
      kind: "task_recovery",
      sourceInput:
        "Please organize the drone-company project folders you made earlier into a folder called drone-web-projects.",
      question:
        "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?",
      requestedAt: "2026-03-13T14:05:00.000Z",
      matchedRuleId: "post_execution_locked_folder_recovery",
      options: [
        {
          id: "retry_with_shutdown",
          label: "Yes, shut them down and retry"
        },
        {
          id: "cancel",
          label: "No, leave them alone"
        }
      ]
    }
  });

  const result = await routeConversationMessageInput(
    session,
    "No, leave them where they are.",
    "2026-03-13T14:05:05.000Z",
    buildDependencies(() => {
      throw new Error("enqueueJob should not run when the user declines recovery");
    })
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(
    result.reply,
    "Okay. I will leave those folders and preview holders alone for now."
  );
  assert.equal(session.activeClarification, null);
});

test("routeConversationMessageInput serves natural capability discovery through the canonical front door", async () => {
  const session = buildSession();
  const skills: readonly SkillInventoryEntry[] = [
    {
      name: "planner-fix",
      description: "Fixes planner regressions.",
      userSummary: "A reusable planner repair tool.",
      verificationStatus: "verified",
      riskLevel: "low",
      tags: ["planner"],
      invocationHints: ["Use for planner failures"],
      lifecycleStatus: "active",
      updatedAt: "2026-03-10T00:00:00.000Z"
    }
  ];
  const capabilitySummary: ConversationCapabilitySummary = {
    provider: "telegram",
    privateChatAliasOptional: true,
    supportsNaturalConversation: true,
    supportsAutonomousExecution: true,
    supportsMemoryReview: true,
    capabilities: [
      {
        id: "autonomous_execution",
        label: "Autonomous execution",
        status: "available",
        summary: "I can run clear requests end to end with normal safety checks."
      }
    ]
  };

  const result = await routeConversationMessageInput(
    session,
    "What reusable tools do you already have for planner failures like this one?",
    "2026-03-11T18:05:05.000Z",
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for capability discovery");
    }, {
      listAvailableSkills: async () => skills,
      describeRuntimeCapabilities: async () => capabilitySummary
    })
  );

  assert.ok(result.reply.includes("Here is what I can help with in this Telegram chat right now:"));
  assert.ok(result.reply.includes("Autonomous execution: Available."));
  assert.ok(result.reply.includes("planner-fix"));
  assert.equal(result.shouldStartWorker, false);
  assert.equal(session.modeContinuity?.activeMode, "discover_available_capabilities");
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    normalizeAssistantTurnText(result.reply)
  );
});

test("routeConversationMessageInput keeps what-can-you-help-me-with prompts off the worker path", async () => {
  const session = buildSession();
  const result = await routeConversationMessageInput(
    session,
    "What can you help me with?",
    "2026-03-11T18:05:06.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for capability discovery prompts");
      },
      {
        describeRuntimeCapabilities: async () => ({
          provider: "telegram",
          privateChatAliasOptional: true,
          supportsNaturalConversation: true,
          supportsAutonomousExecution: true,
          supportsMemoryReview: true,
          capabilities: [
            {
              id: "natural_chat",
              label: "Natural conversation",
              status: "available",
              summary: "You can talk to me normally in this private chat."
            },
            {
              id: "plan_and_build",
              label: "Plan and build requests",
              status: "available",
              summary: "I can help plan, build, and review work from chat."
            }
          ]
        }),
        listAvailableSkills: async () => [
          {
            name: "planner-fix",
            description: "Fixes planner regressions.",
            userSummary: "A reusable planner repair tool.",
            verificationStatus: "verified",
            riskLevel: "low",
            tags: ["planner"],
            invocationHints: ["Use for planner failures"],
            lifecycleStatus: "active",
            updatedAt: "2026-03-10T00:00:00.000Z"
          }
        ]
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /Here is what I can help with/i);
  assert.match(result.reply, /Natural conversation: Available\./);
  assert.match(result.reply, /planner-fix/);
  assert.equal(session.modeContinuity?.activeMode, "discover_available_capabilities");
});

test("routeConversationMessageInput can synthesize capability discovery replies through the direct conversation path", async () => {
  const session = buildSession();
  let capturedInput = "";

  const result = await routeConversationMessageInput(
    session,
    "What can you help me with?",
    "2026-03-11T18:05:07.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for direct capability discovery");
      },
      {
        describeRuntimeCapabilities: async () => ({
          provider: "telegram",
          privateChatAliasOptional: true,
          supportsNaturalConversation: true,
          supportsAutonomousExecution: true,
          supportsMemoryReview: true,
          capabilities: [
            {
              id: "plan_and_build",
              label: "Plan and build requests",
              status: "available",
              summary: "I can help plan, build, and review work from chat."
            }
          ]
        }),
        listAvailableSkills: async () => [
          {
            name: "planner-fix",
            description: "Fixes planner regressions.",
            userSummary: "A reusable planner repair tool.",
            verificationStatus: "verified",
            riskLevel: "low",
            tags: ["planner"],
            invocationHints: ["Use for planner failures"],
            lifecycleStatus: "active",
            updatedAt: "2026-03-10T00:00:00.000Z"
          }
        ],
        runDirectConversationTurn: async (input) => {
          capturedInput = input;
          return {
            summary: "I can chat normally, help plan or build work, and reuse skills like planner-fix when they fit."
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(
    result.reply,
    "I can chat normally, help plan or build work, and reuse skills like planner-fix when they fit."
  );
  assert.match(capturedInput, /Capability facts:/);
  assert.match(capturedInput, /Reusable skill facts:/);
  assert.equal(session.modeContinuity?.activeMode, "discover_available_capabilities");
});

test("routeConversationMessageInput answers casual chat turns directly without queueing work", async () => {
  const session = buildSession();

  const result = await routeConversationMessageInput(
    session,
    "Hi",
    "2026-03-11T18:05:04.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for ordinary chat");
      },
      {
        runDirectConversationTurn: async (input) => {
          assert.equal(input, "Hi");
          return {
            summary: "Hello there."
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(result.reply, "Hello there.");
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    normalizeAssistantTurnText(result.reply)
  );
});

test("routeConversationMessageInput keeps explicit conversational interludes direct while leaving the preview open", async () => {
  const session = buildSession({
    modeContinuity: {
      activeMode: "autonomous",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:00.000Z",
      lastUserInput: "Handle this end to end and leave AI Drone City open."
    },
    activeWorkspace: {
      id: "workspace:ai-drone-city",
      label: "AI Drone City",
      rootPath: "C:\\Users\\testuser\\Desktop\\AI Drone City",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\AI Drone City\\dist\\index.html",
      previewUrl: "http://127.0.0.1:49263/",
      browserSessionId: "browser_session:ai-drone-city",
      browserSessionIds: ["browser_session:ai-drone-city"],
      browserSessionStatus: "open",
      browserProcessPid: 52056,
      previewProcessLeaseId: "proc_ai_drone_city",
      previewProcessLeaseIds: ["proc_ai_drone_city"],
      previewProcessCwd: "C:\\Users\\testuser\\Desktop\\AI Drone City",
      lastKnownPreviewProcessPid: 49236,
      stillControllable: true,
      ownershipState: "tracked",
      previewStackState: "browser_and_preview",
      lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\AI Drone City"],
      sourceJobId: "job-1",
      updatedAt: "2026-03-11T18:05:10.000Z"
    },
    browserSessions: [
      buildConversationBrowserSessionFixture({
        id: "browser_session:ai-drone-city",
        label: "AI Drone City preview",
        url: "http://127.0.0.1:49263/",
        sourceJobId: "job-1",
        openedAt: "2026-03-11T18:05:10.000Z",
        linkedProcessLeaseId: "proc_ai_drone_city",
        linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\AI Drone City"
      })
    ]
  });

  const result = await routeConversationMessageInput(
    session,
    "Before changing anything, just talk with me for a minute about what makes AI Drone City feel playful. Reply in two short paragraphs and keep the page open.",
    "2026-03-11T18:06:00.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for a conversational interlude");
      },
      {
        runDirectConversationTurn: async () => ({
          summary: "AI Drone City feels playful because the pacing is light and the motion stays inviting instead of noisy.\n\nThe colors and airy spacing give it room to feel curious, so the page can stay open as a playful preview while we talk."
        })
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /\n\n/);
  assert.equal(session.runningJobId, null);
  assert.equal(session.queuedJobs.length, 0);
  assert.equal(session.browserSessions[0]?.status, "open");
  assert.match(
    session.conversationTurns[session.conversationTurns.length - 1]?.text ?? "",
    /\n\n/
  );
});

test("routeConversationMessageInput normalizes third-person self-reference in direct chat replies", async () => {
  const session = buildSession();

  const result = await routeConversationMessageInput(
    session,
    "Hi",
    "2026-03-11T18:05:04.500Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for ordinary chat");
      },
      {
        runDirectConversationTurn: async () => ({
          summary: "If you want, BigBrain can keep chatting for a bit."
        })
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(result.reply, "If you want, I can keep chatting for a bit.");
});

test("routeConversationMessageInput keeps casual greetings off the worker path even after earlier assistant turns", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "assistant",
        text: "What should we work on next?",
        at: "2026-03-11T18:04:58.000Z"
      }
    ]
  });

  const result = await routeConversationMessageInput(
    session,
    "Hi",
    "2026-03-11T18:05:08.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for a greeting after prior assistant turns");
      },
      {
        runDirectConversationTurn: async (input) => {
          assert.match(input, /Recent conversation context \(oldest to newest\):/);
          assert.match(input, /Current user request:\nHi/);
          return {
            summary: "Hey again."
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(result.reply, "Hey again.");
});

test("routeConversationMessageInput keeps capability discovery off the worker path even after earlier assistant turns", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "assistant",
        text: "What should we work on next?",
        at: "2026-03-11T18:04:58.000Z"
      }
    ]
  });

  const result = await routeConversationMessageInput(
    session,
    "What can you help me with?",
    "2026-03-11T18:05:09.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for capability discovery after prior assistant turns");
      },
      {
        describeRuntimeCapabilities: async () => ({
          provider: "telegram",
          privateChatAliasOptional: true,
          supportsNaturalConversation: true,
          supportsAutonomousExecution: true,
          supportsMemoryReview: true,
          capabilities: [
            {
              id: "natural_chat",
              label: "Natural conversation",
              status: "available",
              summary: "You can talk to me normally in this private chat."
            }
          ]
        }),
        runDirectConversationTurn: async () => ({
          summary: "I can talk normally here, help with tasks, and answer questions about what I can do."
        })
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /I can talk normally here/i);
});

test("routeConversationMessageInput keeps multi-paragraph conversational turns off the worker path", async () => {
  const session = buildSession();
  let capturedInput = "";

  const result = await routeConversationMessageInput(
    session,
    "I've had a long day and I'm still deciding what I want to work on.\n\nCan we just talk it through for a minute before you start anything?",
    "2026-03-11T18:05:10.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for multi-paragraph conversation");
      },
      {
        runDirectConversationTurn: async (input) => {
          capturedInput = input;
          return {
            summary: "Of course. We can talk it through first and start work only when you want to."
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(
    result.reply,
    "Of course. We can talk it through first and start work only when you want to."
  );
  assert.equal(
    capturedInput,
    "I've had a long day and I'm still deciding what I want to work on.\n\nCan we just talk it through for a minute before you start anything?"
  );
});

test("routeConversationMessageInput forwards explicit conversation-only format controls into the direct chat path", async () => {
  const session = buildSession();
  let capturedInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Can we just talk for a minute before we do anything else?\n\nPlease reply in two short paragraphs and do not start work yet.",
    "2026-03-11T18:05:10.500Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for explicit conversation-only turns");
      },
      {
        runDirectConversationTurn: async (input) => {
          capturedInput = input;
          return {
            summary: "First sentence. Second sentence. Third sentence. Fourth sentence."
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /First sentence\./);
  assert.match(result.reply, /\n\n/);
  assert.match(result.reply, /Third sentence\./);
  assert.match(
    capturedInput,
    /Direct reply format requirement: reply in exactly two short paragraphs separated by one blank line\./
  );
  assert.match(
    capturedInput,
    /Direct reply intent: answer this as conversation only\./
  );
});

test("routeConversationMessageInput handles natural status and artifact-recall questions without queueing work", async () => {
  const session = buildSession({
    progressState: {
      status: "working",
      message: "building the landing page in Desktop\\123",
      jobId: "job-1",
      updatedAt: "2026-03-11T18:05:00.000Z"
    },
    pathDestinations: [
      {
        id: "dest-1",
        label: "Landing page folder",
        resolvedPath: "C:\\Users\\testuser\\Desktop\\123",
        sourceJobId: "job-1",
        updatedAt: "2026-03-11T18:04:59.000Z"
      }
    ]
  });

  const result = await routeConversationMessageInput(
    session,
    "What are you doing right now and where did you put it?",
    "2026-03-11T18:05:12.000Z",
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for status or recall");
    })
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /I'm working on/i);
  assert.match(result.reply, /Recent locations:/);
  assert.match(result.reply, /C:\\Users\\testuser\\Desktop\\123/);
  assert.equal(session.modeContinuity?.activeMode, "status_or_recall");
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    normalizeAssistantTurnText(result.reply)
  );
});

test("routeConversationMessageInput answers review-ready handoff prompts without queueing work", async () => {
  const session = buildSession({
    returnHandoff: {
      id: "handoff:job-review",
      status: "waiting_for_user",
      goal: "Build the landing page and leave a preview open for review.",
      summary: "I finished the first draft and paused at the review checkpoint.",
      nextSuggestedStep: "Tell me what section you want changed next.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
      sourceJobId: "job-review",
      updatedAt: "2026-03-11T18:05:11.000Z"
    }
  });

  const result = await routeConversationMessageInput(
    session,
    "Show me what is ready to review.",
    "2026-03-11T18:05:13.000Z",
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for review-ready recall prompts");
    })
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /Here is what is ready to review:/);
  assert.match(result.reply, /Status: Paused here with a saved checkpoint ready for your review or next change request\./);
  assert.equal(session.modeContinuity?.activeMode, "status_or_recall");
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    normalizeAssistantTurnText(result.reply)
  );
});

test("routeConversationMessageInput answers guided review prompts from the durable handoff without queueing work", async () => {
  const session = buildSession({
    returnHandoff: {
      id: "handoff:job-review-guided",
      status: "waiting_for_user",
      goal: "Build the landing page and pause at the review checkpoint.",
      summary: "I finished the first draft and paused at the review checkpoint.",
      nextSuggestedStep: "Tell me what section you want changed next.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\drone-company\\styles.css"
      ],
      sourceJobId: "job-review-guided",
      updatedAt: "2026-03-11T18:05:11.500Z"
    }
  });

  const result = await routeConversationMessageInput(
    session,
    "What should I look at first?",
    "2026-03-11T18:05:14.000Z",
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for guided review recall prompts");
    })
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /Start here: open the preview at http:\/\/127\.0\.0\.1:4177\/index\.html\./);
  assert.match(result.reply, /After your review: Tell me what section you want changed next\./);
  assert.equal(session.modeContinuity?.activeMode, "status_or_recall");
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    normalizeAssistantTurnText(result.reply)
  );
});

test("routeConversationMessageInput can use the local intent model for nuanced return-handoff review wording", async () => {
  const session = buildSession({
    returnHandoff: {
      id: "handoff:job-review-guided-model",
      status: "waiting_for_user",
      goal: "Build the landing page and pause at the review checkpoint.",
      summary: "I finished the first draft and paused at the review checkpoint.",
      nextSuggestedStep: "Tell me what section you want changed next.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\drone-company\\styles.css"
      ],
      sourceJobId: "job-review-guided-model",
      updatedAt: "2026-03-11T18:05:11.500Z"
    },
    modeContinuity: {
      activeMode: "build",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:11.500Z",
      lastUserInput: "Build the landing page and pause at the review checkpoint."
    }
  });

  const result = await routeConversationMessageInput(
    session,
    "When I get back later, what should I inspect first from the draft you left me?",
    "2026-03-11T18:05:14.500Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for nuanced guided review recall prompts");
      },
      {
        localIntentModelResolver: async (request) => {
          assert.equal(request.sessionHints?.hasReturnHandoff, true);
          return {
            source: "local_intent_model",
            mode: "status_or_recall",
            confidence: "medium",
            matchedRuleId: "local_intent_model_guided_review_handoff",
            explanation: "The local intent model recognized a guided review request for the saved draft.",
            clarification: null,
            semanticHint: "guided_review"
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /Start here: open the preview at http:\/\/127\.0\.0\.1:4177\/index\.html\./);
  assert.match(result.reply, /Review order:/);
  assert.equal(session.modeContinuity?.activeMode, "status_or_recall");
});

test("routeConversationMessageInput can use the local intent model for softer review-ready wording", async () => {
  const session = buildSession({
    returnHandoff: {
      id: "handoff:job-review-ready-model",
      status: "completed",
      goal: "Finish the landing page draft and save it for review.",
      summary: "I finished the landing page draft and left the preview ready for review.",
      nextSuggestedStep: "Tell me what section you want me to refine next.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\drone-company\\styles.css"
      ],
      sourceJobId: "job-review-ready-model",
      updatedAt: "2026-03-11T18:05:11.750Z"
    },
    modeContinuity: {
      activeMode: "build",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:11.750Z",
      lastUserInput: "Build the landing page and save it for review."
    }
  });

  const result = await routeConversationMessageInput(
    session,
    "What else is ready from that draft?",
    "2026-03-11T18:05:14.750Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for softer review-ready recall prompts");
      },
      {
        localIntentModelResolver: async (request) => {
          assert.equal(request.sessionHints?.hasReturnHandoff, true);
          return {
            source: "local_intent_model",
            mode: "status_or_recall",
            confidence: "medium",
            matchedRuleId: "local_intent_model_more_review_ready",
            explanation: "The local intent model recognized a softer review-ready question.",
            clarification: null,
            semanticHint: "review_ready"
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /Here is what is ready to review:/);
  assert.equal(session.modeContinuity?.activeMode, "status_or_recall");
});

test("routeConversationMessageInput can use the local intent model for softer anything-else-to-review wording", async () => {
  const session = buildSession({
    returnHandoff: {
      id: "handoff:job-review-ready-more-model",
      status: "completed",
      goal: "Finish the landing page draft and save it for review.",
      summary: "I finished the landing page draft and saved the review checkpoint for you.",
      nextSuggestedStep: "Tell me which section you want me to refine next.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\drone-company\\styles.css"
      ],
      sourceJobId: "job-review-ready-more-model",
      updatedAt: "2026-03-11T18:05:11.825Z"
    },
    modeContinuity: {
      activeMode: "build",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:11.825Z",
      lastUserInput: "Build the landing page and save it for review."
    }
  });

  const result = await routeConversationMessageInput(
    session,
    "Is there anything else in that draft I should look over?",
    "2026-03-11T18:05:14.825Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for softer anything-else-to-review recall prompts");
      },
      {
        localIntentModelResolver: async (request) => {
          assert.equal(request.sessionHints?.hasReturnHandoff, true);
          return {
            source: "local_intent_model",
            mode: "status_or_recall",
            confidence: "medium",
            matchedRuleId: "local_intent_model_review_ready_more_to_see_handoff",
            explanation: "The local intent model recognized a softer anything-else-to-review question.",
            clarification: null,
            semanticHint: "review_ready"
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /Here is what is ready to review:/);
  assert.equal(session.modeContinuity?.activeMode, "status_or_recall");
});

test("routeConversationMessageInput can use the local intent model for nuanced review-next wording", async () => {
  const session = buildSession({
    returnHandoff: {
      id: "handoff:job-review-next-model",
      status: "waiting_for_user",
      goal: "Finish the landing page draft and pause for review.",
      summary: "I finished the landing page draft and paused at the review checkpoint.",
      nextSuggestedStep: "Tell me what section you want me to refine first.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\drone-company\\styles.css"
      ],
      sourceJobId: "job-review-next-model",
      updatedAt: "2026-03-11T18:05:11.900Z"
    },
    modeContinuity: {
      activeMode: "build",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:11.900Z",
      lastUserInput: "Build the landing page and pause for review."
    }
  });

  const result = await routeConversationMessageInput(
    session,
    "What should I review next from that draft?",
    "2026-03-11T18:05:14.900Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for review-next recall prompts");
      },
      {
        localIntentModelResolver: async (request) => {
          assert.equal(request.sessionHints?.hasReturnHandoff, true);
          assert.equal(request.sessionHints?.returnHandoffChangedPathCount, 2);
          return {
            source: "local_intent_model",
            mode: "status_or_recall",
            confidence: "medium",
            matchedRuleId: "local_intent_model_next_review_step_handoff",
            explanation: "The local intent model recognized a next-review-step request.",
            clarification: null,
            semanticHint: "next_review_step"
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /Next review step: Check the primary artifact at C:\\Users\\testuser\\Desktop\\drone-company\\index\.html\./);
  assert.equal(session.modeContinuity?.activeMode, "status_or_recall");
});

test("routeConversationMessageInput can use the local intent model for after-that review wording", async () => {
  const session = buildSession({
    returnHandoff: {
      id: "handoff:job-review-after-that-model",
      status: "waiting_for_user",
      goal: "Finish the landing page draft and pause for review.",
      summary: "I finished the landing page draft and paused at the review checkpoint.",
      nextSuggestedStep: "Tell me what section you want me to refine first.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\drone-company\\styles.css"
      ],
      sourceJobId: "job-review-after-that-model",
      updatedAt: "2026-03-11T18:05:11.950Z"
    },
    modeContinuity: {
      activeMode: "build",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:11.950Z",
      lastUserInput: "Build the landing page and pause for review."
    }
  });

  const result = await routeConversationMessageInput(
    session,
    "What should I look at after that?",
    "2026-03-11T18:05:15.050Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for after-that review recall prompts");
      },
      {
        localIntentModelResolver: async (request) => {
          assert.equal(request.sessionHints?.hasReturnHandoff, true);
          return {
            source: "local_intent_model",
            mode: "status_or_recall",
            confidence: "medium",
            matchedRuleId: "local_intent_model_after_that_review_step",
            explanation: "The local intent model recognized a follow-on review-step request.",
            clarification: null,
            semanticHint: "next_review_step"
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /Next review step: Check the primary artifact at C:\\Users\\testuser\\Desktop\\drone-company\\index\.html\./);
  assert.equal(session.modeContinuity?.activeMode, "status_or_recall");
});

test("routeConversationMessageInput can use the local intent model for wrap-up summary wording", async () => {
  const session = buildSession({
    returnHandoff: {
      id: "handoff:job-wrap-up-model",
      status: "completed",
      goal: "Finish the landing page draft and save it for review.",
      summary: "I finished the landing page draft and saved the review checkpoint for you.",
      nextSuggestedStep: "Tell me which section you want me to refine next.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\drone-company\\styles.css"
      ],
      sourceJobId: "job-wrap-up-model",
      updatedAt: "2026-03-11T18:05:12.050Z"
    },
    modeContinuity: {
      activeMode: "build",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:12.050Z",
      lastUserInput: "Build the landing page and save it for review."
    }
  });

  const result = await routeConversationMessageInput(
    session,
    "What did you wrap up for me on that draft?",
    "2026-03-11T18:05:15.150Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for wrap-up summary recall prompts");
      },
      {
        localIntentModelResolver: async (request) => {
          assert.equal(request.sessionHints?.hasReturnHandoff, true);
          return {
            source: "local_intent_model",
            mode: "status_or_recall",
            confidence: "medium",
            matchedRuleId: "local_intent_model_wrap_up_summary_handoff",
            explanation: "The local intent model recognized a wrap-up summary request.",
            clarification: null,
            semanticHint: "wrap_up_summary"
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /Here is what I wrapped up for you:/);
  assert.match(result.reply, /What I wrapped up: C:\\Users\\testuser\\Desktop\\drone-company\\index\.html and C:\\Users\\testuser\\Desktop\\drone-company\\styles\.css\./);
  assert.equal(session.modeContinuity?.activeMode, "status_or_recall");
});

test("routeConversationMessageInput resumes prior build work from the durable handoff checkpoint", async () => {
  const session = buildSession({
    modeContinuity: {
      activeMode: "build",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:00.000Z",
      lastUserInput: "Build the landing page and leave it open."
    },
    returnHandoff: {
      id: "handoff:job-3",
      status: "completed",
      goal: "Build the landing page and leave the preview ready.",
      summary: "I finished the landing page draft and left the preview ready for review.",
      nextSuggestedStep: "Tell me what section you want changed next.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
      sourceJobId: "job-3",
      updatedAt: "2026-03-11T18:05:10.000Z"
    }
  });
  let capturedExecutionInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Pick that back up and keep going from where you left off.",
    "2026-03-11T18:05:20.000Z",
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedExecutionInput = executionInput ?? "";
      currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
      return {
        reply: "queued",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(result.shouldStartWorker, true);
  assert.equal(result.reply, "I'm picking that back up from the last checkpoint now.");
  assert.equal(session.modeContinuity?.activeMode, "build");
  assert.match(capturedExecutionInput, /Latest durable work handoff in this chat:/);
  assert.match(capturedExecutionInput, /Durable return-handoff continuation:/);
  assert.match(capturedExecutionInput, /Resume workspace root: C:\\Users\\testuser\\Desktop\\drone-company/);
});

test("routeConversationMessageInput can use the local intent model for nuanced return-handoff resume wording", async () => {
  const session = buildSession({
    modeContinuity: {
      activeMode: "build",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:00.000Z",
      lastUserInput: "Build the landing page and leave it open."
    },
    returnHandoff: {
      id: "handoff:job-3b",
      status: "waiting_for_user",
      goal: "Keep refining the landing page draft from the saved checkpoint.",
      summary: "I paused with the landing page draft ready for refinement.",
      nextSuggestedStep: "Keep refining the hero and CTA from the saved draft.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
      sourceJobId: "job-3b",
      updatedAt: "2026-03-11T18:05:10.500Z"
    }
  });
  let capturedExecutionInput = "";

  const result = await routeConversationMessageInput(
    session,
    "When you get a chance, keep refining that draft from where you left off.",
    "2026-03-11T18:05:21.000Z",
    buildDependencies(
      (currentSession, input, _receivedAt, executionInput) => {
        capturedExecutionInput = executionInput ?? "";
        currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
        return {
          reply: "queued",
          shouldStartWorker: true
        };
      },
      {
        localIntentModelResolver: async (request) => {
          assert.equal(request.sessionHints?.hasReturnHandoff, true);
          return {
            source: "local_intent_model",
            mode: "build",
            confidence: "medium",
            matchedRuleId: "local_intent_model_resume_saved_draft",
            explanation: "The local intent model recognized a resume-from-checkpoint request.",
            clarification: null,
            semanticHint: "resume_handoff"
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, true);
  assert.equal(result.reply, "I'm picking that back up from the last checkpoint now.");
  assert.match(capturedExecutionInput, /Durable return-handoff continuation:/);
  assert.match(capturedExecutionInput, /Resume workspace root: C:\\Users\\testuser\\Desktop\\drone-company/);
});

test("routeConversationMessageInput can use the local intent model for nuanced return-handoff explain wording", async () => {
  const session = buildSession({
    returnHandoff: {
      id: "handoff:job-explain-model",
      status: "completed",
      goal: "Finish the landing page draft and save it for review.",
      summary: "I finished the landing page draft and saved the review checkpoint for you.",
      nextSuggestedStep: "Tell me which section you want me to refine next.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\drone-company\\styles.css"
      ],
      sourceJobId: "job-explain-model",
      updatedAt: "2026-03-11T18:05:12.000Z"
    },
    modeContinuity: {
      activeMode: "build",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:12.000Z",
      lastUserInput: "Build the landing page and save it for review."
    }
  });

  const result = await routeConversationMessageInput(
    session,
    "Explain what you actually changed in that saved draft.",
    "2026-03-11T18:05:15.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for nuanced explain-style handoff recall prompts");
      },
      {
        localIntentModelResolver: async (request) => {
          assert.equal(request.sessionHints?.hasReturnHandoff, true);
          assert.equal(request.sessionHints?.returnHandoffChangedPathCount, 2);
          return {
            source: "local_intent_model",
            mode: "status_or_recall",
            confidence: "medium",
            matchedRuleId: "local_intent_model_explain_saved_draft_changes",
            explanation: "The local intent model recognized a saved-draft change explanation request.",
            clarification: null,
            semanticHint: "explain_handoff"
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /Here is what I changed in the saved work:/);
  assert.match(result.reply, /What I changed: C:\\Users\\testuser\\Desktop\\drone-company\\index\.html and C:\\Users\\testuser\\Desktop\\drone-company\\styles\.css\./);
  assert.equal(session.modeContinuity?.activeMode, "status_or_recall");
});

test("routeConversationMessageInput resumes prior autonomous work from the durable handoff checkpoint", async () => {
  const session = buildSession({
    modeContinuity: {
      activeMode: "autonomous",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:00.000Z",
      lastUserInput: "Build the landing page and keep going until it is done."
    },
    returnHandoff: {
      id: "handoff:job-8",
      status: "waiting_for_user",
      goal: "Build the landing page, leave it open, and wait for refinement feedback.",
      summary: "I finished the first draft and paused at the review checkpoint.",
      nextSuggestedStep: "Keep iterating on the landing page after the user gives the next section to change.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
      sourceJobId: "job-8",
      updatedAt: "2026-03-11T18:06:10.000Z"
    }
  });
  let capturedExecutionInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Resume that and keep going.",
    "2026-03-11T18:06:20.000Z",
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedExecutionInput = executionInput ?? "";
      currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
      return {
        reply: "queued",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(result.shouldStartWorker, true);
  assert.equal(
    result.reply,
    "I'm picking that back up from the last checkpoint now. I'll keep going until it's done or I hit a real blocker."
  );
  assert.match(capturedExecutionInput, /^\[AUTONOMOUS_LOOP_GOAL\]/);
  const autonomousPayload = parseAutonomousExecutionInput(capturedExecutionInput);
  assert.ok(autonomousPayload);
  assert.match(
    autonomousPayload?.initialExecutionInput ?? "",
    /Durable return-handoff continuation:/
  );
  assert.equal(session.modeContinuity?.activeMode, "autonomous");
});

test("routeConversationMessageInput lets the user leave the rest for later without queueing more work", async () => {
  const session = buildSession({
    modeContinuity: {
      activeMode: "build",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:00.000Z",
      lastUserInput: "Build the landing page and leave it open."
    },
    returnHandoff: {
      id: "handoff:job-9",
      status: "completed",
      goal: "Build the landing page and leave the preview ready.",
      summary: "I finished the landing page draft and left the preview ready for review.",
      nextSuggestedStep: "Tell me what section you want changed next.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
      sourceJobId: "job-9",
      updatedAt: "2026-03-11T18:05:20.000Z"
    }
  });

  const result = await routeConversationMessageInput(
    session,
    "Okay, leave the rest for later.",
    "2026-03-11T18:05:30.000Z",
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for explicit pause handoff requests");
    })
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /I'll leave the rest for later and keep this checkpoint ready for you\./i);
  assert.match(result.reply, /Workspace: C:\\Users\\testuser\\Desktop\\drone-company/);
  assert.equal(session.returnHandoff?.status, "waiting_for_user");
  assert.equal(
    session.returnHandoff?.nextSuggestedStep,
    "pick this back up when you're ready, and I'll continue from the saved checkpoint"
  );
  assert.deepEqual(session.progressState, {
    status: "waiting_for_user",
    message: "pick this back up when you're ready, and I'll continue from the saved checkpoint",
    jobId: "job-9",
    updatedAt: "2026-03-11T18:05:30.000Z"
  });
  assert.equal(session.modeContinuity?.activeMode, "build");
});

test("routeConversationMessageInput pauses an active autonomous run without queueing more work", async () => {
  const session = buildSession({
    runningJobId: "job-live",
    recentJobs: [
      {
        ...buildQueuedJob(
          "Build the landing page and keep going until it is done.",
          "[AUTONOMOUS_LOOP_GOAL] Build the landing page and keep going until it is done."
        ),
        id: "job-live",
        input: "Build the landing page and keep going until it is done.",
        executionInput: "[AUTONOMOUS_LOOP_GOAL] Build the landing page and keep going until it is done.",
        startedAt: "2026-03-11T18:05:06.000Z",
        status: "running"
      }
    ],
    activeWorkspace: {
      id: "workspace:drone-company",
      label: "Current project workspace",
      rootPath: "C:\\Users\\testuser\\Desktop\\drone-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      browserSessionId: "browser-1",
      browserSessionIds: ["browser-1"],
      browserSessionStatus: "open",
      browserProcessPid: 999,
      previewProcessLeaseId: "lease-1",
      previewProcessLeaseIds: ["lease-1"],
      previewProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company",
      lastKnownPreviewProcessPid: 1234,
      stillControllable: true,
      ownershipState: "tracked",
      previewStackState: "browser_and_preview",
      lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\drone-company\\index.html"],
      sourceJobId: "job-live",
      updatedAt: "2026-03-11T18:05:05.000Z"
    }
  });
  let abortCalls = 0;

  const result = await routeConversationMessageInput(
    session,
    "Okay, leave the rest for later.",
    "2026-03-11T18:05:30.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for active autonomous pause requests");
      },
      {
        abortActiveAutonomousRun: () => {
          abortCalls += 1;
          return true;
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(abortCalls, 1);
  assert.match(result.reply, /I'm stopping here and keeping the latest checkpoint ready for you\./i);
  assert.match(result.reply, /Workspace: C:\\Users\\testuser\\Desktop\\drone-company/);
  assert.equal(session.recentJobs[0]?.pauseRequestedAt, "2026-03-11T18:05:30.000Z");
  assert.equal(session.returnHandoff?.status, "waiting_for_user");
  assert.equal(session.returnHandoff?.sourceJobId, "job-live");
  assert.deepEqual(session.progressState, {
    status: "stopped",
    message: "stopping here and keeping the latest checkpoint ready so you can pick it back up later",
    jobId: null,
    updatedAt: "2026-03-11T18:05:30.000Z"
  });
});

test("routeConversationMessageInput promotes natural continuity cues into the current build mode", async () => {
  const session = buildSession({
    modeContinuity: {
      activeMode: "build",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:00.000Z",
      lastUserInput: "Build the landing page and leave it open."
    },
    recentActions: [
      {
        id: "action-1",
        kind: "file",
        label: "Landing page file",
        location: "C:\\Users\\testuser\\Desktop\\123\\index.html",
        status: "created",
        sourceJobId: "job-1",
        at: "2026-03-11T18:05:00.000Z",
        summary: "Created the landing page."
      }
    ],
    pathDestinations: [
      {
        id: "dest-1",
        label: "Desktop 123 folder",
        resolvedPath: "C:\\Users\\testuser\\Desktop\\123",
        sourceJobId: "job-1",
        updatedAt: "2026-03-11T18:05:00.000Z"
      }
    ]
  });
  let capturedExecutionInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Go ahead and use the same approach as before, put it in the same place as before, and leave it open for me.",
    "2026-03-11T18:05:20.000Z",
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedExecutionInput = executionInput ?? "";
      currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
      return {
        reply: "queued",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(result.shouldStartWorker, true);
  assert.equal(session.modeContinuity?.activeMode, "build");
  assert.equal(session.modeContinuity?.source, "natural_intent");
  assert.match(capturedExecutionInput, /Remembered save\/open locations from this chat:/);
  assert.match(capturedExecutionInput, /Natural reuse preference:/);
});

test("routeConversationMessageInput carries open-browser and artifact context into natural follow-up edit requests", async () => {
  const session = buildSession({
    modeContinuity: {
      activeMode: "build",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:00.000Z",
      lastUserInput: "Build the landing page and leave it open."
    },
    recentActions: [
      {
        id: "action-1",
        kind: "file",
        label: "Landing page file",
        location: "C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
        status: "created",
        sourceJobId: "job-1",
        at: "2026-03-11T18:05:00.000Z",
        summary: "Created the landing page."
      }
    ],
    pathDestinations: [
      {
        id: "dest-1",
        label: "Drone company folder",
        resolvedPath: "C:\\Users\\testuser\\Desktop\\drone-company",
        sourceJobId: "job-1",
        updatedAt: "2026-03-11T18:05:00.000Z"
      }
    ],
    browserSessions: [
      buildConversationBrowserSessionFixture({
        id: "browser_session:landing-page",
        label: "Landing page preview",
        url: "http://127.0.0.1:4173/",
        sourceJobId: "job-1",
        openedAt: "2026-03-11T18:05:10.000Z"
      })
    ]
  });
  let capturedExecutionInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Change the hero image to a slider instead of the landing page.",
    "2026-03-11T18:06:00.000Z",
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedExecutionInput = executionInput ?? "";
      currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
      return {
        reply: "queued",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(result.shouldStartWorker, true);
  assert.equal(session.modeContinuity?.activeMode, "build");
  assert.match(capturedExecutionInput, /Landing page file/);
  assert.match(capturedExecutionInput, /Landing page preview: sessionId=browser_session:landing-page;/);
  assert.match(capturedExecutionInput, /Natural artifact-edit follow-up:/);
  assert.match(capturedExecutionInput, /Preferred edit destination: C:\\Users\\testuser\\Desktop\\drone-company/);
});

test("routeConversationMessageInput keeps workflow continuation turns on the work path after conversational interludes", async () => {
  const session = buildSession({
    modeContinuity: {
      activeMode: "plan",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:00.000Z",
      lastUserInput: "Please plan a calm air-drone landing page in three concise steps."
    },
    recentJobs: [
      {
        ...buildQueuedJob(
          "Please plan a calm air-drone landing page in three concise steps.",
          "Please plan a calm air-drone landing page in three concise steps."
        ),
        id: "job-plan-1",
        status: "completed",
        startedAt: "2026-03-11T18:05:01.000Z",
        completedAt: "2026-03-11T18:05:08.000Z",
        resultSummary: "Here is the three-step plan."
      }
    ]
  });
  let capturedExecutionInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Okay, now turn that plan into a short section-by-section outline.",
    "2026-03-11T18:06:00.000Z",
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedExecutionInput = executionInput ?? "";
      currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
      return {
        reply: "queued",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(result.shouldStartWorker, true);
  assert.equal(session.modeContinuity?.activeMode, "plan");
  assert.match(capturedExecutionInput, /Current user request:/);
  assert.match(capturedExecutionInput, /section-by-section outline/i);
});

test("routeConversationMessageInput routes natural close-browser follow-ups through the same build surface", async () => {
  const session = buildSession({
    modeContinuity: {
      activeMode: "build",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:00.000Z",
      lastUserInput: "Build the landing page and leave it open."
    },
    browserSessions: [
      buildConversationBrowserSessionFixture({
        id: "browser_session:landing-page",
        label: "Landing page preview",
        url: "http://127.0.0.1:4173/",
        sourceJobId: "job-1",
        openedAt: "2026-03-11T18:05:10.000Z",
        linkedProcessLeaseId: "proc_preview_1",
        linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\drone-company"
      })
    ]
  });
  let capturedExecutionInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Close the landing page so we can work on something else.",
    "2026-03-11T18:06:30.000Z",
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedExecutionInput = executionInput ?? "";
      currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
      return {
        reply: "queued",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(result.shouldStartWorker, true);
  assert.equal(session.modeContinuity?.activeMode, "build");
  assert.match(capturedExecutionInput, /Tracked browser sessions:/);
  assert.match(
    capturedExecutionInput,
    /control=available; .*linkedPreviewLease=proc_preview_1; .*linkedPreviewCwd=C:\\Users\\testuser\\Desktop\\drone-company/
  );
  assert.match(capturedExecutionInput, /Natural browser-session follow-up:/);
  assert.match(capturedExecutionInput, /prefer close_browser with params\.sessionId=browser_session:landing-page and then stop_process with params\.leaseId=proc_preview_1/i);
});
