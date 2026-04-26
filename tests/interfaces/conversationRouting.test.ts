/**
 * @fileoverview Covers canonical conversation routing, including persisted clarification state and natural capability discovery.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { ProfileMemoryIngestRequest } from "../../src/core/profileMemoryRuntime/contracts";
import type { TemporalMemorySynthesis } from "../../src/core/profileMemoryRuntime/profileMemoryTemporalQueryContracts";
import { buildConversationStackFromTurnsV1 } from "../../src/core/stage6_86ConversationStack";
import { createEmptyConversationDomainContext } from "../../src/core/sessionContext";
import {
  buildSessionSeed,
  createFollowUpRuleContext,
  normalizeAssistantTurnText
} from "../../src/interfaces/conversationManagerHelpers";
import {
  routeConversationMessageInput,
  type ConversationRoutingDependencies
} from "../../src/interfaces/conversationRuntime/conversationRouting";
import { buildConversationInboundUserInput } from "../../src/interfaces/mediaRuntime/mediaNormalization";
import { parseAutonomousExecutionInput } from "../../src/interfaces/conversationRuntime/managerContracts";
import type { ConversationJob, ConversationSession } from "../../src/interfaces/sessionStore";
import type { SkillInventoryEntry } from "../../src/organs/skillRegistry/contracts";
import { buildLegacyCompatibleTemporalSynthesis } from "../../src/organs/memorySynthesis/temporalSynthesisAdapter";
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

function buildWorkflowHeavySession(
  overrides: Partial<ConversationSession> = {}
): ConversationSession {
  const conversationId = "telegram:chat-1:user-1";
  return buildSession({
    domainContext: {
      ...createEmptyConversationDomainContext(conversationId),
      dominantLane: "workflow",
      continuitySignals: {
        activeWorkspace: true,
        returnHandoff: true,
        modeContinuity: true
      },
      activeSince: "2026-03-11T18:04:00.000Z",
      lastUpdatedAt: "2026-03-11T18:05:00.000Z"
    },
    modeContinuity: {
      activeMode: "build",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:00.000Z",
      lastUserInput: "Build the landing page and leave it open."
    },
    activeWorkspace: {
      id: "workspace:sample-company",
      label: "Tracked preview workspace",
      rootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      browserSessionId: "browser-1",
      browserSessionIds: ["browser-1"],
      browserSessionStatus: "open",
      browserProcessPid: 999,
      previewProcessLeaseId: "lease-1",
      previewProcessLeaseIds: ["lease-1"],
      previewProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company",
      lastKnownPreviewProcessPid: 1234,
      stillControllable: true,
      ownershipState: "tracked",
      previewStackState: "browser_and_preview",
      lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
      sourceJobId: "job-1",
      updatedAt: "2026-03-11T18:05:00.000Z"
    },
    returnHandoff: {
      id: "handoff:job-1",
      status: "waiting_for_user",
      goal: "Finish the landing page draft and leave it ready for review.",
      summary: "The landing page draft is ready and the preview is still open.",
      nextSuggestedStep: "Tell me which section to refine next.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
      sourceJobId: "job-1",
      updatedAt: "2026-03-11T18:05:00.000Z"
    },
    browserSessions: [
      buildConversationBrowserSessionFixture({
        id: "browser-1",
        label: "Landing page preview",
        url: "http://127.0.0.1:4177/index.html",
        sourceJobId: "job-1",
        openedAt: "2026-03-11T18:05:00.000Z"
      })
    ],
    ...overrides
  });
}

function buildQuarantinedJordanContinuityFacts() {
  const supportingEpisode = {
    episodeId: "episode_jordan_identity_ambiguity",
    title: "Jordan identity ambiguity remains unresolved",
    summary: "Two Jordans and an overlapping J.R. alias still need disambiguation.",
    status: "unresolved" as const,
    lastMentionedAt: "2026-03-28T09:59:00.000Z",
    entityRefs: ["Jordan", "J.R."],
    entityLinks: [],
    openLoopLinks: []
  };
  const supportingFact = {
    factId: "fact_jordan_identity_ambiguity",
    key: "contact.jordan.work_association",
    value: "Northstar",
    status: "confirmed",
    observedAt: "2026-03-28T09:58:00.000Z",
    lastUpdatedAt: "2026-03-28T09:58:00.000Z",
    confidence: 0.88
  };
  const compatibilitySynthesis = buildLegacyCompatibleTemporalSynthesis(
    [supportingEpisode],
    [supportingFact]
  );
  assert.ok(compatibilitySynthesis);
  const temporalSynthesis: TemporalMemorySynthesis = {
    ...compatibilitySynthesis.temporalSynthesis,
    currentState: [],
    historicalContext: [],
    contradictionNotes: [
      "I can't safely tell whether Jordan means the Northstar contact or the Ember contact yet, and J.R. could mean the Northstar Jordan or the Harbor contact."
    ],
    answerMode: "quarantined_identity",
    laneMetadata: compatibilitySynthesis.temporalSynthesis.laneMetadata.map((lane) => ({
      ...lane,
      answerMode: "quarantined_identity",
      dominantLane: "quarantined_identity",
      supportingLanes: []
    }))
  };
  return Object.assign(
    [
      {
        factId: supportingFact.factId,
        key: supportingFact.key,
        value: supportingFact.value,
        status: supportingFact.status,
        observedAt: supportingFact.observedAt,
        lastUpdatedAt: supportingFact.lastUpdatedAt,
        confidence: supportingFact.confidence
      }
    ],
    {
      semanticMode: "relationship_inventory" as const,
      relevanceScope: "conversation_local" as const,
      scopedThreadKeys: ["thread_jordan_identity_ambiguity"],
      temporalSynthesis,
      laneBoundaries: compatibilitySynthesis.laneBoundaries
    }
  );
}

function buildAccordSaleContinuityEpisodes() {
  return [
    {
      episodeId: "episode_gray_accord_sale",
      title: "Milo sold Jordan the gray Accord",
      summary: "Milo sold Jordan the gray Accord in late 2024.",
      status: "unresolved" as const,
      lastMentionedAt: "2026-03-29T11:00:00.000Z",
      entityRefs: ["contact.milo", "contact.jordan", "gray Accord"],
      entityLinks: [
        {
          entityKey: "entity_milo",
          canonicalName: "Milo"
        },
        {
          entityKey: "entity_jordan",
          canonicalName: "Jordan"
        }
      ],
      openLoopLinks: []
    }
  ] as const;
}

test("routeConversationMessageInput promotes strong end-to-end wording into autonomous execution", async () => {
  const session = buildSession();
  let capturedExecutionInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Hey, build me a tech landing page for sample products, go until you finish, put it on my desktop, create a folder called sample-company, and leave it open for me.",
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
    "Hey, build me a tech landing page for sample products, go until you finish, put it on my desktop, create a folder called sample-company, and leave it open for me."
  );
  assert.match(
    autonomousPayload?.initialExecutionInput ?? "",
    /Current user request:/
  );
  assert.match(
    autonomousPayload?.initialExecutionInput ?? "",
    /Autonomous execution request\./
  );
  assert.equal(session.domainContext.dominantLane, "workflow");
  assert.equal(
    session.domainContext.recentRoutingSignals[session.domainContext.recentRoutingSignals.length - 1]?.mode,
    "autonomous"
  );
  assert.equal(session.modeContinuity?.activeMode, "autonomous");
  assert.equal(session.modeContinuity?.source, "natural_intent");
});

test("routeConversationMessageInput can use the autonomy-boundary interpreter for ambiguous end-to-end wording without deterministic workflow promotion", async () => {
  const conversationId = "telegram:chat-1:user-1";
  const session = buildSession({
    domainContext: {
      ...createEmptyConversationDomainContext(conversationId),
      dominantLane: "profile",
      continuitySignals: {
        activeWorkspace: false,
        returnHandoff: true,
        modeContinuity: false
      },
      activeSince: "2026-03-11T18:04:00.000Z",
      lastUpdatedAt: "2026-03-11T18:05:00.000Z"
    }
  });
  let capturedExecutionInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Could you take care of this end to end and leave the preview open for me?",
    "2026-03-11T18:05:05.000Z",
    buildDependencies(
      (currentSession, input, _receivedAt, executionInput) => {
        capturedExecutionInput = executionInput ?? "";
        currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
        return {
          reply: "",
          shouldStartWorker: true
        };
      },
      {
        autonomyBoundaryInterpretationResolver: async (request) => {
          assert.equal(request.sessionHints?.domainDominantLane, "profile");
          assert.equal(request.deterministicSignalStrength, "ambiguous");
          return {
            source: "local_intent_model",
            kind: "promote_to_autonomous",
            confidence: "medium",
            explanation: "The user is delegating the current artifact end to end."
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, true);
  assert.equal(
    result.reply,
    "I'm taking this end to end now. I'll keep going until it's done or I hit a real blocker."
  );
  assert.match(capturedExecutionInput, /^\[AUTONOMOUS_LOOP_GOAL\]/);
  assert.equal(session.modeContinuity?.activeMode, "autonomous");
  assert.equal(session.modeContinuity?.source, "natural_intent");
});

test("routeConversationMessageInput applies a precomputed topic-key resume signal before recording the user turn", async () => {
  const session = buildSession({
    modeContinuity: {
      activeMode: "build",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:00.000Z",
      lastUserInput: "Keep building the active project."
    },
    conversationTurns: [
      {
        role: "user",
        text: "Landing page hero section",
        at: "2026-03-11T18:05:00.000Z"
      },
      {
        role: "assistant",
        text: "I updated the landing page hero section.",
        at: "2026-03-11T18:05:01.000Z"
      },
      {
        role: "user",
        text: "API auth retry bug",
        at: "2026-03-11T18:05:02.000Z"
      },
      {
        role: "assistant",
        text: "I investigated the API auth retry bug.",
        at: "2026-03-11T18:05:03.000Z"
      }
    ]
  });
  session.conversationStack = buildConversationStackFromTurnsV1(
    session.conversationTurns,
    "2026-03-11T18:05:03.000Z",
    {}
  );
  const pausedThread = session.conversationStack.threads.find((thread) => thread.state === "paused");
  assert.ok(pausedThread);

  const result = await routeConversationMessageInput(
    session,
    "continue that",
    "2026-03-11T18:05:05.000Z",
    buildDependencies(
      (currentSession, input, _receivedAt, executionInput) => {
        currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
        return {
          reply: "queued",
          shouldStartWorker: true
        };
      },
      {
        topicKeyInterpretationResolver: async () => ({
          source: "local_intent_model",
          kind: "resume_paused_thread",
          selectedTopicKey: null,
          selectedThreadKey: pausedThread.threadKey,
          confidence: "high",
          explanation: "resume the paused landing-page thread"
        })
      }
    )
  );

  assert.equal(result.reply, "queued");
  assert.equal(session.conversationStack?.activeThreadKey, pausedThread.threadKey);
});

test("routeConversationMessageInput persists build-format clarification and resolves the next turn against it", async () => {
  const session = buildSession();
  let capturedInput = "";
  let capturedExecutionInput = "";
  const sourceInput =
    'Create me that landing page with a hero and call to action in the exact folder "C:\\Users\\testuser\\Desktop\\Sample Service Landing Page".';

  const firstResult = await routeConversationMessageInput(
    session,
    sourceInput,
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

  assert.equal(
    firstResult.reply,
    "Would you like that built as plain HTML, or as a framework app like Next.js or React?"
  );
  assert.equal(firstResult.shouldStartWorker, false);
  assert.ok(session.activeClarification);
  assert.equal(session.activeClarification?.kind, "build_format");
  assert.deepEqual(session.progressState, {
    status: "waiting_for_user",
    message: "Would you like that built as plain HTML, or as a framework app like Next.js or React?",
    jobId: null,
    updatedAt: "2026-03-11T18:05:05.000Z"
  });

  const secondResult = await routeConversationMessageInput(
    session,
    "Plain HTML.",
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
  assert.equal(capturedInput, sourceInput);
  assert.ok(capturedExecutionInput.includes("User selected: Plain HTML."));
  assert.ok(capturedExecutionInput.includes("Execution lane: static_html_build."));
  assert.equal(session.modeContinuity?.activeMode, "static_html_build");
  assert.equal(session.modeContinuity?.source, "clarification_answer");
});

test("routeConversationMessageInput can render build-format clarification wording naturally while keeping deterministic options", async () => {
  const session = buildSession();
  const sourceInput =
    'Build me a landing page for this company in the exact folder "C:\\Users\\testuser\\Desktop\\Sample Service Landing Page".';

  const result = await routeConversationMessageInput(
    session,
    sourceInput,
    "2026-03-11T18:07:00.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run while the build format is still ambiguous");
      },
      {
        runDirectConversationTurn: async () => ({
          summary: "Do you want that as plain HTML, or do you want me to build it in Next.js or React?"
        })
      }
    )
  );

  assert.equal(
    result.reply,
    "Do you want that as plain HTML, or do you want me to build it in Next.js or React?"
  );
  assert.equal(session.activeClarification?.kind, "build_format");
  assert.deepEqual(
    session.activeClarification?.options.map((option) => option.id),
    ["static_html", "nextjs", "react"]
  );
});

test("routeConversationMessageInput can render plan-versus-build clarification wording naturally while keeping deterministic state", async () => {
  const session = buildSession();
  const sourceInput =
    "BigBrain I recorded a short clip so you can see what the UI is doing. The wrong panel slides in right after the menu opens and the dashboard feels off. Please build the dashboard change using this clip.";

  const result = await routeConversationMessageInput(
    session,
    sourceInput,
    "2026-03-11T18:07:30.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run while execution mode is still ambiguous");
      },
      {
        runDirectConversationTurn: async () => ({
          summary: "Should I plan this out first, or jump straight into building it?"
        })
      }
    )
  );

  assert.equal(
    result.reply,
    "Should I plan this out first, or jump straight into building it?"
  );
  assert.equal(session.activeClarification?.kind, "execution_mode");
  assert.equal(session.activeClarification?.renderingIntent, "plan_or_build");
  assert.deepEqual(
    session.activeClarification?.options.map((option) => option.id),
    ["plan", "build"]
  );
});

test("routeConversationMessageInput clears stale execution-mode clarification before routing a fresh chat turn", async () => {
  const session = buildSession({
    activeClarification: {
      id: "clarification_2026-04-11T16:48:51.000Z",
      kind: "execution_mode",
      sourceInput:
        "Billy moved from Sample Web Studio to Crimson Analytics in February, and Garrett still owns Harbor Signal Studio.",
      question: "Do you want me to plan it first or build it now?",
      requestedAt: "2026-04-11T16:48:51.000Z",
      matchedRuleId: "execution_intent_build_generic",
      renderingIntent: "plan_or_build",
      options: [
        {
          id: "plan",
          label: "Plan it first"
        },
        {
          id: "build",
          label: "Build it now"
        }
      ]
    },
    progressState: {
      status: "waiting_for_user",
      message: "Do you want me to plan it first or build it now?",
      jobId: null,
      updatedAt: "2026-04-11T16:48:51.000Z"
    }
  });
  let capturedInput = "";

  const result = await routeConversationMessageInput(
    session,
    "What is Sample Web Studio?",
    "2026-04-12T00:13:00.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for a fresh chat question after a stale clarification");
      },
      {
        runDirectConversationTurn: async (input) => {
          capturedInput = input;
          return {
            summary: "Sample Web Studio is a web-design business tied to the relationship context you mentioned earlier."
          };
        }
      }
    )
  );

  assert.equal(
    result.reply,
    "Sample Web Studio is a web-design business tied to the relationship context you mentioned earlier."
  );
  assert.equal(result.shouldStartWorker, false);
  assert.equal(session.activeClarification, null);
  assert.equal(session.progressState, null);
  assert.equal(capturedInput, "What is Sample Web Studio?");
});

test("routeConversationMessageInput keeps vague conversational follow-ups attached to the latest informational answer instead of an older clarification", async () => {
  const session = buildWorkflowHeavySession({
    conversationTurns: [
      {
        role: "assistant",
        text: "Do you want me to plan it first or build it now?",
        at: "2026-04-12T00:12:00.000Z"
      },
      {
        role: "user",
        text: "What is Sample Web Studio?",
        at: "2026-04-12T00:13:00.000Z"
      },
      {
        role: "assistant",
        text: "From the context, Sample Web Studio appears to be a web design company that Billy worked with as a front-end contractor.",
        at: "2026-04-12T00:13:05.000Z"
      }
    ]
  });
  let directConversationInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Okay, what else?",
    "2026-04-12T00:13:20.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for vague conversational follow-ups after an informational answer");
      },
      {
        runDirectConversationTurn: async (input) => {
          directConversationInput = input;
          return {
            summary: "From the context, Billy later moved from Sample Web Studio to Crimson Analytics."
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(
    result.reply,
    "From the context, Billy later moved from Sample Web Studio to Crimson Analytics."
  );
  assert.equal(session.queuedJobs.length, 0);
  assert.match(directConversationInput, /Current user request:\nOkay, what else\?/);
  assert.doesNotMatch(
    directConversationInput,
    /Follow-up user response to prior assistant clarification\./
  );
});

test("routeConversationMessageInput renders mixed durable-memory and browser-status recap prompts from continuity facts and tracked browser state", async () => {
  const session = buildWorkflowHeavySession({
    browserSessions: [
      buildConversationBrowserSessionFixture({
        id: "browser-foundry",
        label: "Foundry Echo preview",
        url: "file:///C:/Users/testuser/Desktop/Foundry%20Echo/index.html",
        sourceJobId: "job-foundry",
        openedAt: "2026-04-13T10:19:15.165Z",
        status: "closed",
        controllerKind: "os_default",
        controlAvailable: false,
        workspaceRootPath: "C:\\Users\\testuser\\Desktop\\Foundry Echo"
      }),
      buildConversationBrowserSessionFixture({
        id: "browser-river",
        label: "River Glass preview",
        url: "file:///C:/Users/testuser/Desktop/River%20Glass/index.html",
        sourceJobId: "job-river",
        openedAt: "2026-04-13T10:24:15.165Z",
        status: "closed",
        controllerKind: "os_default",
        controlAvailable: false,
        workspaceRootPath: "C:\\Users\\testuser\\Desktop\\River Glass"
      }),
      buildConversationBrowserSessionFixture({
        id: "browser-marquee",
        label: "Marquee Thread preview",
        url: "file:///C:/Users/testuser/Desktop/Marquee%20Thread/index.html",
        sourceJobId: "job-marquee",
        openedAt: "2026-04-13T10:29:15.165Z",
        status: "closed",
        controllerKind: "os_default",
        controlAvailable: false,
        workspaceRootPath: "C:\\Users\\testuser\\Desktop\\Marquee Thread"
      })
    ]
  });
  const mixedRecallPrompt =
    "Switch gears back to memory and status tracking. Tell me which employment facts are current versus historical, " +
    "which date is the active pending review date, who currently handles the billing cleanup, and whether the Foundry Echo, River Glass, and Marquee Thread browser pages are still open or fully closed. " +
    "Keep the personal facts and the desktop project status separate in your answer.";

  const result = await routeConversationMessageInput(
    session,
    mixedRecallPrompt,
    "2026-04-13T15:20:00.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for mixed memory-plus-status recap questions");
      },
      {
        queryContinuityFacts: async () => {
          const supportingFacts = [
            {
              factId: "fact_billy_current_role",
              key: "contact.billy.work_association",
              value: "Crimson Analytics",
              status: "confirmed" as const,
              observedAt: "2026-04-13T11:49:01.000Z",
              lastUpdatedAt: "2026-04-13T11:49:01.000Z",
              confidence: 0.95
            },
            {
              factId: "fact_sam_billing_cleanup",
              key: "contact.sam.context.billing_cleanup",
              value: "Sam is handling the billing cleanup after March 21",
              status: "confirmed" as const,
              observedAt: "2026-04-13T11:49:01.000Z",
              lastUpdatedAt: "2026-04-13T11:49:01.000Z",
              confidence: 0.95
            },
            {
              factId: "fact_billy_historical_role",
              key: "contact.billy.context.previous_employment",
              value: "Billy is no longer at Sample Web Studio",
              status: "confirmed" as const,
              observedAt: "2026-04-13T11:49:01.000Z",
              lastUpdatedAt: "2026-04-13T11:49:01.000Z",
              confidence: 0.95
            },
            {
              factId: "fact_pending_review_date",
              key: "contact.sam.context.pending_review",
              value: "Sam finally delivered it on March 24, which means the March 27 review is the current pending milestone",
              status: "confirmed" as const,
              observedAt: "2026-04-13T11:49:01.000Z",
              lastUpdatedAt: "2026-04-13T11:49:01.000Z",
              confidence: 0.95
            }
          ] as const;
          const compatibility = buildLegacyCompatibleTemporalSynthesis([], supportingFacts);
          assert.ok(compatibility);
          return Object.assign([...supportingFacts], {
            semanticMode: "relationship_inventory" as const,
            relevanceScope: "conversation_local" as const,
            scopedThreadKeys: ["thread_memory_status_recap"],
            temporalSynthesis: compatibility.temporalSynthesis,
            laneBoundaries: compatibility.laneBoundaries
          });
        },
        queryContinuityEpisodes: async () => [
          {
            episodeId: "episode_docklight_review",
            title: "Docklight launch review",
            summary: "The March 27 review is still pending.",
            status: "unresolved" as const,
            lastMentionedAt: "2026-04-13T11:49:01.000Z",
            entityRefs: ["Docklight"],
            entityLinks: [],
            openLoopLinks: []
          }
        ],
        runDirectConversationTurn: async () => {
          throw new Error("runDirectConversationTurn should not run for mixed memory-plus-status recap questions");
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /Personal facts:/);
  assert.match(result.reply, /Current employment: Billy: Crimson Analytics\./);
  assert.match(result.reply, /Historical employment: Billy: Sample Web Studio\./);
  assert.match(result.reply, /Active pending review date: March 27\./);
  assert.match(result.reply, /Billing cleanup: Sam currently handles the billing cleanup\./);
  assert.match(result.reply, /Desktop project status:/);
  assert.match(result.reply, /Foundry Echo: closed\./);
  assert.match(result.reply, /River Glass: closed\./);
  assert.match(result.reply, /Marquee Thread: closed\./);
  assert.equal(session.queuedJobs.length, 0);
});

test("routeConversationMessageInput keeps attachment-analysis turns on the direct conversational path even when OCR contains repair vocabulary", async () => {
  const session = buildWorkflowHeavySession();
  let directConversationInput = "";
  const media = {
    attachments: [
      {
        kind: "image" as const,
        fileId: "file-image-1",
        fileUniqueId: "unique-file-image-1",
        provider: "telegram" as const,
        mimeType: "image/png",
        fileName: "approval-diagram.png",
        sizeBytes: 1024,
        caption: null,
        durationSeconds: null,
        width: null,
        height: null,
        interpretation: {
          source: "fixture_catalog" as const,
          confidence: 0.91,
          provenance: "diagram_ocr",
          summary:
            "The diagram appears to describe an approval flow for AgentBigBrain safety decisions.",
          transcript: null,
          ocrText:
            "If action breaks a rule, it is blocked. Expert council review decides whether to execute or fix the issue.",
          entityHints: ["AgentBigBrain", "Expert council"]
        }
      }
    ]
  };
  const canonicalInput = buildConversationInboundUserInput(
    "Please review the attached diagram image and summarize what process it seems to describe.",
    media
  );

  const result = await routeConversationMessageInput(
    session,
    canonicalInput,
    "2026-04-13T15:22:00.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for grounded media-analysis requests");
      },
      {
        runDirectConversationTurn: async (input) => {
          directConversationInput = input;
          return {
            summary:
              "It describes a gated approval flow where safety checks and council review happen before execution."
          };
        }
      }
    ),
    media
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(
    result.reply,
    "It describes a gated approval flow where safety checks and council review happen before execution."
  );
  assert.equal(session.queuedJobs.length, 0);
  assert.match(
    directConversationInput,
    /Current user request:\nPlease review the attached diagram image and summarize what process it seems to describe\./
  );
  assert.doesNotMatch(directConversationInput, /Do you want me to explain the issue first or fix it now\?/);
});

test("routeConversationMessageInput does not raise a plan-or-build clarification for an explicit exact-folder scaffold request during workflow continuity", async () => {
  const session = buildWorkflowHeavySession({
    activeWorkspace: {
      id: "workspace:foundry-echo",
      label: "Foundry Echo workspace",
      rootPath: "C:\\Users\\testuser\\Desktop\\Foundry Echo",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\Foundry Echo\\index.html",
      previewUrl: "file:///C:/Users/testuser/Desktop/Foundry%20Echo/index.html",
      browserSessionId: "browser-foundry",
      browserSessionIds: ["browser-foundry"],
      browserSessionStatus: "closed",
      browserProcessPid: 62476,
      previewProcessLeaseId: null,
      previewProcessLeaseIds: [],
      previewProcessCwd: "C:\\Users\\testuser\\Desktop\\Foundry Echo",
      lastKnownPreviewProcessPid: null,
      stillControllable: false,
      ownershipState: "stale",
      previewStackState: "detached",
      lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\Foundry Echo\\index.html"],
      sourceJobId: "job-foundry",
      updatedAt: "2026-04-13T10:19:43.635Z"
    },
    browserSessions: [
      buildConversationBrowserSessionFixture({
        id: "browser-foundry",
        label: "Foundry Echo browser window",
        url: "file:///C:/Users/testuser/Desktop/Foundry%20Echo/index.html",
        sourceJobId: "job-foundry",
        openedAt: "2026-04-13T10:19:15.165Z",
        status: "closed",
        controllerKind: "os_default",
        controlAvailable: false,
        workspaceRootPath: "C:\\Users\\testuser\\Desktop\\Foundry Echo"
      })
    ]
  });
  let capturedInput = "";
  let capturedExecutionInput = "";
  const userInput =
    'Create another lightweight single-file HTML landing page in the exact folder "C:\\Users\\testuser\\Desktop\\River Glass" on my Desktop.\n\n' +
    "Call this one River Glass. Keep it as a static single-page site with an `index.html` entry file in that exact folder. " +
    "Do not start a local preview server for this scenario. Open that exact local `index.html` file directly in the browser with an absolute `file://` URL and leave it open when you are done.";

  const result = await routeConversationMessageInput(
    session,
    userInput,
    "2026-04-13T10:20:04.000Z",
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
  assert.equal(result.reply, "queued");
  assert.equal(capturedInput, userInput);
  assert.equal(session.activeClarification, null);
  assert.equal(session.progressState, null);
  assert.match(capturedExecutionInput, /Current tracked workspace in this chat:/);
  assert.match(capturedExecutionInput, /Current user request:\nCreate another lightweight single-file HTML landing page/i);
});

test("routeConversationMessageInput carries explicit do-not-run and do-not-open constraints into build execution input", async () => {
  const session = buildSession();
  let capturedExecutionInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Can you get a new Next.js landing-page workspace started on my desktop and call it Sample City Showcase? Just get the workspace ready for edits with the dependencies installed. Do not run it or open anything yet.",
    "2026-04-13T10:25:00.000Z",
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
  assert.match(capturedExecutionInput, /Explicit execution constraints for this run:/);
  assert.match(
    capturedExecutionInput,
    /Do not start preview\/dev servers or other long-running project runtime processes in this run\./
  );
  assert.match(
    capturedExecutionInput,
    /Do not open a browser window or page in this run unless a later user turn removes that restriction\./
  );
});

test("routeConversationMessageInput links ambiguous modeled follow-up answers to the prior assistant clarification", async () => {
  const session = buildSession({
    conversationTurns: [
      {
        role: "assistant",
        text: "Should I save this in the same folder as before or create a new folder?",
        at: "2026-03-11T18:05:00.000Z"
      }
    ]
  });
  let capturedInput = "";
  let capturedExecutionInput = "";

  const result = await routeConversationMessageInput(
    session,
    "same folder as before",
    "2026-03-11T18:05:12.000Z",
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedInput = input;
      capturedExecutionInput = executionInput ?? "";
      currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
      return {
        reply: "queued",
        shouldStartWorker: true
      };
    }, {
      continuationInterpretationResolver: async (request) => {
        assert.equal(
          request.recentAssistantTurn,
          "Should I save this in the same folder as before or create a new folder?"
        );
        return {
          source: "local_intent_model",
          kind: "short_follow_up",
          followUpCategory: "ack",
          continuationTarget: "prior_assistant_turn",
          candidateValue: null,
          confidence: "medium",
          explanation: "The user is answering the prior folder clarification."
        };
      }
    })
  );

  assert.equal(result.shouldStartWorker, true);
  assert.equal(capturedInput, "same folder as before");
  assert.match(capturedExecutionInput, /Follow-up user response to prior assistant clarification\./);
  assert.match(capturedExecutionInput, /Follow-up interpretation: The user is answering the prior folder clarification\./);
  assert.match(
    capturedExecutionInput,
    /Previous assistant question: Should I save this in the same folder as before or create a new folder\?/
  );
  assert.match(capturedExecutionInput, /User follow-up answer: same folder as before/);
});

test("routeConversationMessageInput retries a recovery clarification when the user approves shutdown and retry", async () => {
  const session = buildSession({
    activeClarification: {
      id: "clarification_1",
      kind: "task_recovery",
      sourceInput:
        "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects.",
      question:
        "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?",
      requestedAt: "2026-03-13T14:05:00.000Z",
      matchedRuleId: "post_execution_locked_folder_recovery",
      renderingIntent: "task_recovery",
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
    "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects."
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
        "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects.",
      question:
        "I couldn't move those folders yet because likely local preview holders may still be using them. I can inspect those holders more closely first. Do you want me to continue that recovery?",
      requestedAt: "2026-03-13T14:06:00.000Z",
      matchedRuleId: "post_execution_untracked_holder_recovery_clarification",
      renderingIntent: "task_recovery",
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
        "Please organize the sample-company project folders you made earlier into a folder called sample-web-projects.",
      question:
        "I couldn't move those folders yet because one or more are still open in a local preview process. I can inspect the matching holders, shut down only exact tracked ones, and retry the move. Do you want me to do that?",
      requestedAt: "2026-03-13T14:05:00.000Z",
      matchedRuleId: "post_execution_locked_folder_recovery",
      renderingIntent: "task_recovery",
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
  assert.equal(session.domainContext.dominantLane, "unknown");
  assert.equal(
    session.domainContext.recentRoutingSignals[session.domainContext.recentRoutingSignals.length - 1]?.mode,
    "discover_available_capabilities"
  );
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

test("routeConversationMessageInput keeps capability discovery off the worker path during workflow-heavy continuity", async () => {
  const session = buildWorkflowHeavySession();

  const result = await routeConversationMessageInput(
    session,
    "What can you help me with from here?",
    "2026-03-11T18:05:08.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for capability discovery during workflow continuity");
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
              summary: "I can keep working on the tracked build or switch to another task."
            }
          ]
        }),
        listAvailableSkills: async () => []
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /Here is what I can help with/i);
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
  assert.equal(session.domainContext.dominantLane, "unknown");
  assert.equal(
    session.domainContext.recentRoutingSignals[session.domainContext.recentRoutingSignals.length - 1]?.mode,
    "chat"
  );
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    normalizeAssistantTurnText(result.reply)
  );
});

test("routeConversationMessageInput keeps greetings and identity recall direct under saved workflow handoff context", async () => {
  const session = buildWorkflowHeavySession({
    returnHandoff: {
      id: "handoff:blocked-job",
      status: "completed",
      goal: "Finish the sample-company landing page and leave it ready for review.",
      summary:
        "I couldn't execute that request in this run. What happened: one or more governed actions were blocked before execution. Why it didn't execute: a safety, governance, or runtime policy denied the requested side effect. What to do next: ask for the exact block code and approval diff, then retry with a narrower allowed action.",
      nextSuggestedStep: "Ask for the exact block code and approval diff, then retry with a narrower allowed action.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\Sample World",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\Sample World\\src\\index.css",
      previewUrl: "file:///C:/Users/testuser/Desktop/sample-company-landing.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\Sample World\\src\\index.css",
        "C:\\Users\\testuser\\Desktop\\Sample World\\src\\App.jsx"
      ],
      sourceJobId: "job-blocked",
      updatedAt: "2026-03-20T19:43:00.000Z"
    }
  });
  let localResolverCalls = 0;

  const greetingResult = await routeConversationMessageInput(
    session,
    "Hi",
    "2026-03-20T19:44:00.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for a greeting under return-handoff context");
      },
      {
        localIntentModelResolver: async () => {
          localResolverCalls += 1;
          return {
            source: "local_intent_model",
            mode: "status_or_recall",
            confidence: "medium",
            matchedRuleId: "local_intent_model_misread_greeting_as_handoff_status",
            explanation: "Incorrectly treated the greeting as a saved-draft recall request.",
            clarification: null,
            semanticHint: "review_ready"
          };
        },
        runDirectConversationTurn: async (input) => {
          assert.match(input, /Current user request:\nHi/);
          return {
            summary: "Hey."
          };
        }
      }
    )
  );

  assert.equal(greetingResult.shouldStartWorker, false);
  assert.equal(greetingResult.reply, "Hey.");
  assert.doesNotMatch(greetingResult.reply, /ready to review/i);

  session.transportIdentity = {
    provider: "telegram",
    username: "avery",
    displayName: null,
    givenName: "Avery",
    familyName: null,
    observedAt: "2026-03-20T19:44:10.000Z"
  };
  const identityResult = await routeConversationMessageInput(
    session,
    "What's my name?",
    "2026-03-20T19:44:10.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for identity recall under return-handoff context");
      },
      {
        localIntentModelResolver: async () => {
          localResolverCalls += 1;
          return {
            source: "local_intent_model",
            mode: "status_or_recall",
            confidence: "medium",
            matchedRuleId: "local_intent_model_misread_identity_as_handoff_status",
            explanation: "Incorrectly treated the personal recall question as a saved-draft review request.",
            clarification: null,
            semanticHint: "review_ready"
          };
        },
        runDirectConversationTurn: async () => {
          throw new Error("runDirectConversationTurn should not run for deterministic self-identity replies");
        }
      }
    )
  );

  assert.equal(identityResult.shouldStartWorker, false);
  assert.equal(
    identityResult.reply,
    "Your Telegram profile shows Avery, but I don't have that saved as a confirmed name fact yet."
  );
  assert.doesNotMatch(identityResult.reply, /ready to review/i);
  assert.equal(localResolverCalls, 0);

  const assistantIdentityResult = await routeConversationMessageInput(
    session,
    "And you are?",
    "2026-03-20T19:44:15.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for assistant identity recall under return-handoff context");
      },
      {
        localIntentModelResolver: async () => {
          localResolverCalls += 1;
          return {
            source: "local_intent_model",
            mode: "status_or_recall",
            confidence: "medium",
            matchedRuleId: "local_intent_model_misread_assistant_identity_as_handoff_status",
            explanation: "Incorrectly treated the assistant-identity question as a saved-draft review request.",
            clarification: null,
            semanticHint: "review_ready"
          };
        },
        runDirectConversationTurn: async (input) => {
          assert.match(input, /Current user request:\nAnd you are\?/);
          return {
            summary: "I'm AgentBigBrain."
          };
        }
      }
    )
  );

  assert.equal(assistantIdentityResult.shouldStartWorker, false);
  assert.equal(assistantIdentityResult.reply, "I'm AgentBigBrain.");
  assert.doesNotMatch(assistantIdentityResult.reply, /ready to review/i);
  assert.equal(localResolverCalls, 0);
});

test("routeConversationMessageInput keeps self-identity declarations direct and persists them through the profile-memory seam", async () => {
  const session = buildWorkflowHeavySession();
  let localResolverCalls = 0;
  let rememberedInput: ProfileMemoryIngestRequest | null = null;

  const result = await routeConversationMessageInput(
    session,
    "My name is Avery, yes.",
    "2026-03-20T23:10:00.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for self-identity declaration chat");
      },
      {
        localIntentModelResolver: async () => {
          localResolverCalls += 1;
          return {
            source: "local_intent_model",
            mode: "build",
            confidence: "medium",
            matchedRuleId: "local_intent_model_misread_identity_declaration_as_execution",
            explanation: "Incorrectly treated the self-identity declaration as workflow execution.",
            clarification: null
          };
        },
        rememberConversationProfileInput: async (input) => {
          if (typeof input === "string") {
            throw new Error("self-identity declaration should use the bounded request contract");
          }
          rememberedInput = input;
          return true;
        },
        runDirectConversationTurn: async () => {
          throw new Error("runDirectConversationTurn should not run for deterministic self-identity declaration replies");
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(result.reply, "Okay, I'll remember that you're Avery.");
  const rememberedProfileInput = rememberedInput as ProfileMemoryIngestRequest | null;
  assert.equal(rememberedProfileInput?.userInput, "My name is Avery, yes.");
  assert.equal(rememberedProfileInput?.provenance?.conversationId, session.conversationId);
  assert.equal(rememberedProfileInput?.provenance?.dominantLaneAtWrite, "workflow");
  assert.equal(rememberedProfileInput?.provenance?.threadKey, null);
  assert.equal(rememberedProfileInput?.provenance?.sourceSurface, "conversation_profile_input");
  assert.match(rememberedProfileInput?.provenance?.turnId ?? "", /^turn_[a-f0-9]{24}$/);
  assert.match(rememberedProfileInput?.provenance?.sourceFingerprint ?? "", /^[a-f0-9]{32}$/);
  assert.equal(localResolverCalls, 0);
});

test("routeConversationMessageInput keeps workflow callback phrasing out of the identity path even with recent identity context", async () => {
  const session = buildWorkflowHeavySession({
    conversationTurns: [
      {
        role: "assistant",
        text: "What should I call you?",
        at: "2026-03-20T23:08:55.000Z"
      }
    ]
  });
  let rememberedInputs = 0;
  let identityInterpretationCalls = 0;
  let capturedExecutionInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Call me when the deploy is done.",
    "2026-03-20T23:10:10.000Z",
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedExecutionInput = executionInput ?? input;
      currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
      return {
        reply: "queued",
        shouldStartWorker: true
      };
    }, {
      rememberConversationProfileInput: async () => {
        rememberedInputs += 1;
        return true;
      },
      identityInterpretationResolver: async () => {
        identityInterpretationCalls += 1;
        return {
          source: "local_intent_model",
          kind: "self_identity_declaration",
          candidateValue: "Deploy",
          confidence: "high",
          shouldPersist: true,
          explanation: "Incorrectly treated workflow callback wording as a name."
        };
      },
      runDirectConversationTurn: async () => {
        throw new Error("runDirectConversationTurn should not run for workflow callback phrasing");
      }
    })
  );

  assert.equal(result.shouldStartWorker, true);
  assert.equal(result.reply, "queued");
  assert.equal(rememberedInputs, 0);
  assert.equal(identityInterpretationCalls, 0);
  assert.equal(session.queuedJobs.length, 1);
  assert.match(capturedExecutionInput, /Call me when the deploy is done/i);
});

test("routeConversationMessageInput keeps assistant-identity acknowledgements and objections on the direct chat path even with queued workflow state", async () => {
  const session = buildWorkflowHeavySession({
    runningJobId: "job-running",
    queuedJobs: [buildQueuedJob("keep building", "keep building")],
    conversationTurns: [
      {
        role: "user",
        text: "Who are you?",
        at: "2026-03-25T23:42:00.000Z"
      },
      {
        role: "assistant",
        text: "I'm BigBrain.",
        at: "2026-03-25T23:42:01.000Z"
      }
    ]
  });
  let localResolverCalls = 0;
  let identityInterpretationCalls = 0;
  const directInputs: string[] = [];

  const acknowledgement = await routeConversationMessageInput(
    session,
    "I know you are.",
    "2026-03-25T23:42:05.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for assistant-identity acknowledgement chat");
      },
      {
        localIntentModelResolver: async () => {
          localResolverCalls += 1;
          return {
            source: "local_intent_model",
            mode: "build",
            confidence: "high",
            matchedRuleId: "local_intent_model_misread_acknowledgement_as_work",
            explanation: "Incorrectly treated the acknowledgement as workflow continuation.",
            clarification: null
          };
        },
        identityInterpretationResolver: async () => {
          identityInterpretationCalls += 1;
          return {
            source: "local_intent_model",
            kind: "assistant_identity_query",
            candidateValue: null,
            confidence: "high",
            shouldPersist: false,
            explanation: "Incorrectly treated the acknowledgement as another assistant-identity question."
          };
        },
        runDirectConversationTurn: async (input) => {
          directInputs.push(input);
          return {
            summary: "Okay."
          };
        }
      }
    )
  );
  assert.equal(acknowledgement.shouldStartWorker, false);
  assert.equal(acknowledgement.reply, "Okay.");

  const objection = await routeConversationMessageInput(
    session,
    "I didn't say to work on that.",
    "2026-03-25T23:42:08.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for assistant-identity objection chat");
      },
      {
        localIntentModelResolver: async () => {
          localResolverCalls += 1;
          return {
            source: "local_intent_model",
            mode: "build",
            confidence: "high",
            matchedRuleId: "local_intent_model_misread_objection_as_work",
            explanation: "Incorrectly treated the objection as workflow continuation.",
            clarification: null
          };
        },
        identityInterpretationResolver: async () => {
          identityInterpretationCalls += 1;
          return {
            source: "local_intent_model",
            kind: "assistant_identity_query",
            candidateValue: null,
            confidence: "high",
            shouldPersist: false,
            explanation: "Incorrectly treated the objection as another assistant-identity question."
          };
        },
        runDirectConversationTurn: async (input) => {
          directInputs.push(input);
          return {
            summary: "Okay, I won't treat that as a new work request."
          };
        }
      }
    )
  );
  assert.equal(objection.shouldStartWorker, false);
  assert.equal(objection.reply, "Okay, I won't treat that as a new work request.");
  assert.equal(localResolverCalls, 0);
  assert.equal(identityInterpretationCalls, 0);
  assert.equal(session.queuedJobs.length, 1);
  assert.equal(session.runningJobId, "job-running");
  assert.equal(directInputs.length, 2);
});

test("routeConversationMessageInput keeps status-shaped relationship recall on the direct chat path during workflow continuity", async () => {
  const session = buildWorkflowHeavySession();
  let directConversationInput = "";

  const result = await routeConversationMessageInput(
    session,
    "What's the status with Billy?",
    "2026-03-26T15:39:10.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for status-shaped relationship recall chat");
      },
      {
        runDirectConversationTurn: async (input) => {
          directConversationInput = input;
          assert.doesNotMatch(input, /Current working mode from earlier in this chat:/i);
          return {
            summary: "Billy is someone you used to work with."
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(result.reply, "Billy is someone you used to work with.");
  assert.equal(directConversationInput, "What's the status with Billy?");
  assert.equal(session.queuedJobs.length, 0);
  assert.equal(session.runningJobId, null);
});

test("routeConversationMessageInput keeps broad people-inventory recall on the direct chat path during workflow continuity", async () => {
  const session = buildWorkflowHeavySession();
  let directConversationInput = "";

  const result = await routeConversationMessageInput(
    session,
    "who are ppl i know?",
    "2026-03-26T15:39:15.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for broad relationship inventory recall chat");
      },
      {
        runDirectConversationTurn: async (input) => {
          directConversationInput = input;
          assert.doesNotMatch(input, /Current working mode from earlier in this chat:/i);
          return {
            summary: "You've mentioned Jordan and Milo."
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(result.reply, "You've mentioned Jordan and Milo.");
  assert.equal(directConversationInput, "who are ppl i know?");
  assert.equal(session.queuedJobs.length, 0);
  assert.equal(session.runningJobId, null);
});

test("routeConversationMessageInput keeps continuity-shaped relationship recall off workflow continuity blocks", async () => {
  const session = buildWorkflowHeavySession();
  let directConversationInput = "";

  const result = await routeConversationMessageInput(
    session,
    "What's going on with Billy and Beacon?",
    "2026-03-26T15:40:20.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for continuity-shaped relationship recall chat");
      },
      {
        runDirectConversationTurn: async (input) => {
          directConversationInput = input;
          assert.doesNotMatch(input, /Current working mode from earlier in this chat:/i);
          return {
            summary: "Billy is someone you worked with at Beacon."
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(result.reply, "Billy is someone you worked with at Beacon.");
  assert.equal(directConversationInput, "What's going on with Billy and Beacon?");
  assert.equal(session.queuedJobs.length, 0);
  assert.equal(session.runningJobId, null);
});

test("routeConversationMessageInput keeps typo-bearing Billy history follow-up on the direct chat path during workflow continuity", async () => {
  const session = buildWorkflowHeavySession({
    conversationTurns: [
      {
        role: "user",
        text: "Billy used to be at Beacon. He's at Northstar now. He drives a gray Accord.",
        at: "2026-03-27T16:09:00.000Z"
      },
      {
        role: "assistant",
        text: "Got it - Billy's at Northstar now, and Beacon was the earlier connection.",
        at: "2026-03-27T16:09:05.000Z"
      },
      {
        role: "user",
        text: "Open the last landing page draft.",
        at: "2026-03-27T16:10:00.000Z"
      },
      {
        role: "assistant",
        text: "I opened the last landing page draft.",
        at: "2026-03-27T16:10:10.000Z"
      }
    ]
  });
  let directConversationInput = "";

  const result = await routeConversationMessageInput(
    session,
    "waht about billy and beacon?",
    "2026-03-27T16:10:20.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for typo-bearing Billy history recall chat");
      },
      {
        runDirectConversationTurn: async (input) => {
          directConversationInput = input;
          assert.doesNotMatch(input, /Current working mode from earlier in this chat:/i);
          return {
            summary: "Billy's at Northstar now. Beacon was the earlier connection."
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(result.reply, "Billy's at Northstar now. Beacon was the earlier connection.");
  assert.match(directConversationInput, /Current user request:\nwaht about billy and beacon\?/i);
  assert.doesNotMatch(directConversationInput, /Current working mode from earlier in this chat:/i);
  assert.equal(session.queuedJobs.length, 0);
  assert.equal(session.runningJobId, null);
});

test("routeConversationMessageInput keeps short object relationship follow-up on the direct chat path during workflow continuity", async () => {
  const session = buildWorkflowHeavySession({
    conversationTurns: [
      {
        role: "user",
        text: "Billy used to be at Beacon. He's at Northstar now. He drives a gray Accord.",
        at: "2026-03-27T16:09:00.000Z"
      },
      {
        role: "assistant",
        text: "Got it - Billy's at Northstar now, and Beacon was the earlier connection.",
        at: "2026-03-27T16:09:05.000Z"
      },
      {
        role: "user",
        text: "waht about billy and beacon?",
        at: "2026-03-27T16:10:20.000Z"
      },
      {
        role: "assistant",
        text: "Billy's at Northstar now. Beacon was the earlier connection.",
        at: "2026-03-27T16:10:25.000Z"
      },
      {
        role: "user",
        text: "Okay, back to the Desktop task - rename the mobile file and move it into the archive folder.",
        at: "2026-03-27T16:10:35.000Z"
      },
      {
        role: "assistant",
        text: "I renamed the mobile file and moved it into the archive folder.",
        at: "2026-03-27T16:10:45.000Z"
      }
    ]
  });
  let directConversationInput = "";

  const result = await routeConversationMessageInput(
    session,
    "and the accord?",
    "2026-03-27T16:10:55.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for short object relationship follow-up chat");
      },
      {
        runDirectConversationTurn: async (input) => {
          directConversationInput = input;
          assert.doesNotMatch(input, /Current working mode from earlier in this chat:/i);
          return {
            summary: "That's Billy's gray Accord."
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(result.reply, "That's Billy's gray Accord.");
  assert.match(directConversationInput, /Current user request:\nand the accord\?/i);
  assert.doesNotMatch(directConversationInput, /Current working mode from earlier in this chat:/i);
  assert.equal(session.queuedJobs.length, 0);
  assert.equal(session.runningJobId, null);
});

test("routeConversationMessageInput keeps transfer-event recall on the direct chat path during workflow continuity", async () => {
  const session = buildWorkflowHeavySession({
    conversationTurns: [
      {
        role: "user",
        text: "Milo sold Jordan the gray Accord in late 2024.",
        at: "2026-03-29T10:58:00.000Z"
      },
      {
        role: "assistant",
        text: "Got it - Milo sold Jordan the gray Accord in late 2024.",
        at: "2026-03-29T10:58:05.000Z"
      },
      {
        role: "user",
        text: "Switch back to the browser tab with the reference site.",
        at: "2026-03-29T10:59:00.000Z"
      },
      {
        role: "assistant",
        text: "I'm back on the reference tab.",
        at: "2026-03-29T10:59:05.000Z"
      }
    ]
  });
  let directConversationInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Who sold Jordan the gray Accord?",
    "2026-03-29T11:00:00.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for event participant recall chat");
      },
      {
        queryContinuityEpisodes: async (request) => {
          assert.equal(request.semanticMode, "event_history");
          return buildAccordSaleContinuityEpisodes();
        },
        runDirectConversationTurn: async (input) => {
          directConversationInput = input;
          assert.doesNotMatch(input, /Current working mode from earlier in this chat:/i);
          assert.match(input, /Relevant situation: Milo sold Jordan the gray Accord/i);
          assert.match(input, /gray Accord/i);
          return {
            summary: "Milo sold it to Jordan in late 2024."
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(result.reply, "Milo sold it to Jordan in late 2024.");
  assert.match(directConversationInput, /Current user request:\nWho sold Jordan the gray Accord\?/i);
  assert.equal(session.queuedJobs.length, 0);
  assert.equal(session.runningJobId, null);
});

test("routeConversationMessageInput keeps missing participant-role follow-up on the direct chat path during workflow continuity", async () => {
  const session = buildWorkflowHeavySession({
    conversationTurns: [
      {
        role: "user",
        text: "Milo sold Jordan the gray Accord in late 2024.",
        at: "2026-03-29T10:58:00.000Z"
      },
      {
        role: "assistant",
        text: "Got it - Milo sold Jordan the gray Accord in late 2024.",
        at: "2026-03-29T10:58:05.000Z"
      },
      {
        role: "user",
        text: "What happened with the gray Accord?",
        at: "2026-03-29T10:59:20.000Z"
      },
      {
        role: "assistant",
        text: "Milo sold it to Jordan in late 2024.",
        at: "2026-03-29T10:59:25.000Z"
      }
    ]
  });
  let directConversationInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Who handled the paperwork?",
    "2026-03-29T11:00:30.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for insufficient event-role recall chat");
      },
      {
        queryContinuityEpisodes: async () => [],
        runDirectConversationTurn: async (input) => {
          directConversationInput = input;
          assert.doesNotMatch(input, /Current working mode from earlier in this chat:/i);
          assert.doesNotMatch(input, /Relevant situation:/i);
          return {
            summary: "You never mentioned who handled the paperwork."
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(result.reply, "You never mentioned who handled the paperwork.");
  assert.match(directConversationInput, /Current user request:\nWho handled the paperwork\?/i);
  assert.equal(session.queuedJobs.length, 0);
  assert.equal(session.runningJobId, null);
});

test("routeConversationMessageInput keeps same-name ambiguity recall on the direct chat path during workflow continuity", async () => {
  const session = buildWorkflowHeavySession({
    conversationTurns: [
      {
        role: "user",
        text: "I work with Jordan at Northstar.",
        at: "2026-03-28T09:56:00.000Z"
      },
      {
        role: "assistant",
        text: "Got it - Jordan's the Northstar coworker.",
        at: "2026-03-28T09:56:05.000Z"
      },
      {
        role: "user",
        text: "I also know another Jordan at Ember. That's a different Jordan from Northstar.",
        at: "2026-03-28T09:57:00.000Z"
      },
      {
        role: "assistant",
        text: "Okay - I'll keep the Ember Jordan separate from the Northstar one.",
        at: "2026-03-28T09:57:05.000Z"
      },
      {
        role: "user",
        text: "Open the last landing page draft and check the reference browser tab.",
        at: "2026-03-28T09:58:00.000Z"
      },
      {
        role: "assistant",
        text: "I reopened the draft and the reference tab.",
        at: "2026-03-28T09:58:10.000Z"
      }
    ]
  });
  let directConversationInput = "";

  const result = await routeConversationMessageInput(
    session,
    "What about Jordan?",
    "2026-03-28T09:59:00.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for same-name ambiguity recall chat");
      },
      {
        queryContinuityFacts: async () => buildQuarantinedJordanContinuityFacts(),
        runDirectConversationTurn: async (input) => {
          directConversationInput = input;
          assert.doesNotMatch(input, /Current working mode from earlier in this chat:/i);
          assert.match(input, /Contradiction Notes:/i);
          assert.match(input, /Northstar/i);
          assert.match(input, /Ember/i);
          return {
            summary: "Which Jordan - Northstar or Ember?"
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(result.reply, "Which Jordan - Northstar or Ember?");
  assert.match(directConversationInput, /Current user request:\nWhat about Jordan\?/i);
  assert.equal(session.queuedJobs.length, 0);
  assert.equal(session.runningJobId, null);
});

test("routeConversationMessageInput keeps alias-collision recall on the direct chat path during workflow continuity", async () => {
  const session = buildWorkflowHeavySession({
    conversationTurns: [
      {
        role: "user",
        text: "I work with Jordan at Northstar.",
        at: "2026-03-28T10:01:00.000Z"
      },
      {
        role: "assistant",
        text: "Got it - Jordan's the Northstar coworker.",
        at: "2026-03-28T10:01:05.000Z"
      },
      {
        role: "user",
        text: "The Jordan from Northstar sometimes goes by J.R.",
        at: "2026-03-28T10:01:20.000Z"
      },
      {
        role: "assistant",
        text: "Okay - I'll remember that alias for the Northstar Jordan.",
        at: "2026-03-28T10:01:25.000Z"
      },
      {
        role: "user",
        text: "I met a different J.R. from Harbor last month.",
        at: "2026-03-28T10:01:40.000Z"
      },
      {
        role: "assistant",
        text: "Understood - that J.R. may be someone else from Harbor.",
        at: "2026-03-28T10:01:45.000Z"
      },
      {
        role: "user",
        text: "Switch back to the browser tab with the reference site.",
        at: "2026-03-28T10:02:00.000Z"
      },
      {
        role: "assistant",
        text: "I'm back on the reference tab.",
        at: "2026-03-28T10:02:05.000Z"
      }
    ]
  });
  let directConversationInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Who's J.R.?",
    "2026-03-28T10:02:20.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for alias-collision recall chat");
      },
      {
        queryContinuityFacts: async () => buildQuarantinedJordanContinuityFacts(),
        runDirectConversationTurn: async (input) => {
          directConversationInput = input;
          assert.doesNotMatch(input, /Current working mode from earlier in this chat:/i);
          assert.match(input, /Contradiction Notes:/i);
          assert.match(input, /J\.R\./i);
          assert.match(input, /Harbor/i);
          return {
            summary: "I have two possible J.R. matches there - the Northstar Jordan and someone from Harbor."
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(
    result.reply,
    "I have two possible J.R. matches there - the Northstar Jordan and someone from Harbor."
  );
  assert.match(directConversationInput, /Current user request:\nWho's J\.R\.\?/i);
  assert.equal(session.queuedJobs.length, 0);
  assert.equal(session.runningJobId, null);
});

test("routeConversationMessageInput keeps broader governed relationship recall off workflow continuity blocks", async () => {
  const session = buildWorkflowHeavySession();
  let directConversationInput = "";

  const result = await routeConversationMessageInput(
    session,
    "What's going on with my direct report Casey?",
    "2026-03-26T15:40:40.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for broadened relationship recall chat");
      },
      {
        runDirectConversationTurn: async (input) => {
          directConversationInput = input;
          assert.doesNotMatch(input, /Current working mode from earlier in this chat:/i);
          return {
            summary: "Casey is your direct report."
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(result.reply, "Casey is your direct report.");
  assert.equal(directConversationInput, "What's going on with my direct report Casey?");
  assert.equal(session.queuedJobs.length, 0);
  assert.equal(session.runningJobId, null);
});

test("routeConversationMessageInput keeps unattached short deny turns off the worker path during workflow continuity", async () => {
  const session = buildWorkflowHeavySession();
  session.conversationTurns.push({
    role: "assistant",
    text: "Status: Blocked\nBlocked: SHELL_EXECUTABLE_NOT_FOUND",
    at: "2026-03-20T23:11:00.000Z"
  });
  let localResolverCalls = 0;

  const result = await routeConversationMessageInput(
    session,
    "No",
    "2026-03-20T23:11:05.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for unattached deny chat");
      },
      {
        localIntentModelResolver: async () => {
          localResolverCalls += 1;
          return {
            source: "local_intent_model",
            mode: "build",
            confidence: "medium",
            matchedRuleId: "local_intent_model_misread_unattached_deny_as_execution",
            explanation: "Incorrectly treated the bare deny as execution continuity.",
            clarification: null
          };
        },
        runDirectConversationTurn: async (input) => {
          assert.match(input, /Current user request:\nNo/);
          return {
            summary: "Okay."
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(result.reply, "Okay.");
  assert.equal(localResolverCalls, 0);
});

test("routeConversationMessageInput keeps mixed identity recall plus explicit browser control on the workflow path", async () => {
  const session = buildWorkflowHeavySession();
  let rememberedInputs = 0;
  let identityInterpretationCalls = 0;
  let capturedExecutionInput = "";

  const result = await routeConversationMessageInput(
    session,
    "what is my name and close the browser",
    "2026-03-20T23:11:10.000Z",
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedExecutionInput = executionInput ?? input;
      currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
      return {
        reply: "queued",
        shouldStartWorker: true
      };
    }, {
      rememberConversationProfileInput: async () => {
        rememberedInputs += 1;
        return true;
      },
      identityInterpretationResolver: async () => {
        identityInterpretationCalls += 1;
        return {
          source: "local_intent_model",
          kind: "self_identity_query",
          candidateValue: null,
          confidence: "high",
          shouldPersist: false,
          explanation: "Incorrectly prioritized identity recall over explicit browser control."
        };
      },
      runDirectConversationTurn: async () => {
        throw new Error("runDirectConversationTurn should not run for mixed identity-plus-browser control");
      }
    })
  );

  assert.equal(result.shouldStartWorker, true);
  assert.equal(result.reply, "queued");
  assert.equal(rememberedInputs, 0);
  assert.equal(identityInterpretationCalls, 0);
  assert.equal(session.queuedJobs.length, 1);
  assert.match(capturedExecutionInput, /close the browser/i);
});

test("routeConversationMessageInput uses a no-worker fallback for chat when direct conversation synthesis is unavailable", async () => {
  const session = buildWorkflowHeavySession({
    returnHandoff: {
      id: "handoff:blocked-chat-fallback",
      status: "completed",
      goal: "Finish the page and leave it ready for review.",
      summary:
        "I couldn't execute that request in this run. What happened: one or more governed actions were blocked before execution.",
      nextSuggestedStep: "Ask for the exact block code and approval diff.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\Sample World",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\Sample World\\src\\index.css",
      previewUrl: "file:///C:/Users/testuser/Desktop/sample-company-landing.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\Sample World\\src\\index.css",
        "C:\\Users\\testuser\\Desktop\\Sample World\\src\\App.jsx"
      ],
      sourceJobId: "job-blocked-chat-fallback",
      updatedAt: "2026-03-20T19:43:00.000Z"
    }
  });
  let enqueueCalls = 0;

  const result = await routeConversationMessageInput(
    session,
    "Bonjour",
    "2026-03-20T19:44:20.000Z",
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      enqueueCalls += 1;
      currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
      return {
        reply: "queued",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(result.shouldStartWorker, false);
  assert.equal(result.reply, "Hey.");
  assert.equal(enqueueCalls, 0);
  assert.equal(session.queuedJobs.length, 0);

  const assistantIdentityFallback = await routeConversationMessageInput(
    session,
    "And you are?",
    "2026-03-20T19:44:25.000Z",
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      enqueueCalls += 1;
      currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
      return {
        reply: "queued",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(assistantIdentityFallback.shouldStartWorker, false);
  assert.equal(assistantIdentityFallback.reply, "I'm AgentBigBrain.");
  assert.equal(enqueueCalls, 0);
  assert.equal(session.queuedJobs.length, 0);

  const conversationalFallback = await routeConversationMessageInput(
    session,
    "What about you?",
    "2026-03-20T19:44:30.000Z",
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      enqueueCalls += 1;
      currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
      return {
        reply: "queued",
        shouldStartWorker: true
      };
    })
  );

  assert.equal(conversationalFallback.shouldStartWorker, false);
  assert.equal(conversationalFallback.reply, "Hey.");
  assert.equal(enqueueCalls, 0);
  assert.equal(session.queuedJobs.length, 0);
});

test("routeConversationMessageInput keeps explicit conversational interludes direct while leaving the preview open", async () => {
  const session = buildSession({
    modeContinuity: {
      activeMode: "autonomous",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:00.000Z",
      lastUserInput: "Handle this end to end and leave Sample City open."
    },
    activeWorkspace: {
      id: "workspace:ai-sample-city",
      label: "Sample City",
      rootPath: "C:\\Users\\testuser\\Desktop\\Sample City",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\Sample City\\dist\\index.html",
      previewUrl: "http://127.0.0.1:49263/",
      browserSessionId: "browser_session:ai-sample-city",
      browserSessionIds: ["browser_session:ai-sample-city"],
      browserSessionStatus: "open",
      browserProcessPid: 52056,
      previewProcessLeaseId: "proc_ai_sample_city",
      previewProcessLeaseIds: ["proc_ai_sample_city"],
      previewProcessCwd: "C:\\Users\\testuser\\Desktop\\Sample City",
      lastKnownPreviewProcessPid: 49236,
      stillControllable: true,
      ownershipState: "tracked",
      previewStackState: "browser_and_preview",
      lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\Sample City"],
      sourceJobId: "job-1",
      updatedAt: "2026-03-11T18:05:10.000Z"
    },
    browserSessions: [
      buildConversationBrowserSessionFixture({
        id: "browser_session:ai-sample-city",
        label: "Sample City preview",
        url: "http://127.0.0.1:49263/",
        sourceJobId: "job-1",
        openedAt: "2026-03-11T18:05:10.000Z",
        linkedProcessLeaseId: "proc_ai_sample_city",
        linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\Sample City"
      })
    ]
  });

  const result = await routeConversationMessageInput(
    session,
    "Before changing anything, just talk with me for a minute about what makes Sample City feel playful. Reply in two short paragraphs and keep the page open.",
    "2026-03-11T18:06:00.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for a conversational interlude");
      },
      {
        runDirectConversationTurn: async () => ({
          summary: "Sample City feels playful because the pacing is light and the motion stays inviting instead of noisy.\n\nThe colors and airy spacing give it room to feel curious, so the page can stay open as a playful preview while we talk."
        })
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /\n\n/);
  assert.equal(session.runningJobId, null);
  assert.equal(session.queuedJobs.length, 0);
  assert.equal(session.browserSessions[0]?.status, "open");
  assert.equal(session.domainContext.dominantLane, "workflow");
  assert.equal(
    session.domainContext.recentRoutingSignals[session.domainContext.recentRoutingSignals.length - 1]?.mode,
    "chat"
  );
  assert.equal(session.domainContext.continuitySignals.activeWorkspace, true);
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

test("routeConversationMessageInput keeps long narrative memory updates off the execution clarification path", async () => {
  const session = buildSession();
  let capturedInput = "";

  const result = await routeConversationMessageInput(
    session,
    [
      "Billy moved from Sample Web Studio to Crimson in February, and the Harbor project timeline shifted a week after that.",
      "Garrett is still handling the website handoff, and I am going to add corrections and date changes after we talk through it.",
      "",
      "Mara is flying in on April 20, Billy said the old office keys are still in the blue folder, and the review call is supposed to happen before the March invoices get closed."
    ].join("\n\n"),
    "2026-03-11T18:05:11.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for long narrative memory updates");
      },
      {
        runDirectConversationTurn: async (input) => {
          capturedInput = input;
          return {
            summary: "I have those relationship and timeline details in view, and I'm ready for the corrections when you want to add them."
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /relationship and timeline details/i);
  assert.equal(session.activeClarification, null);
  assert.match(capturedInput, /Billy moved from Sample Web Studio to Crimson in February/i);
  assert.match(capturedInput, /Harbor project timeline shifted a week/i);
});

test("routeConversationMessageInput keeps before-action multi-paragraph conversation direct during active browser workflow continuity", async () => {
  const session = buildWorkflowHeavySession({
    activeWorkspace: {
      id: "workspace:ai-sample-city",
      label: "Sample City workspace",
      rootPath: "C:\\Users\\testuser\\Desktop\\Sample City",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\Sample City\\index.html",
      previewUrl: "http://127.0.0.1:49263/",
      browserSessionId: "browser_session:ai-sample-city",
      browserSessionIds: ["browser_session:ai-sample-city"],
      browserSessionStatus: "open",
      browserProcessPid: 777,
      previewProcessLeaseId: "proc_ai_sample_city",
      previewProcessLeaseIds: ["proc_ai_sample_city"],
      previewProcessCwd: "C:\\Users\\testuser\\Desktop\\Sample City",
      lastKnownPreviewProcessPid: 778,
      stillControllable: true,
      ownershipState: "tracked",
      previewStackState: "browser_and_preview",
      lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\Sample City\\index.html"],
      sourceJobId: "job-1",
      updatedAt: "2026-03-11T18:05:10.000Z"
    },
    browserSessions: [
      buildConversationBrowserSessionFixture({
        id: "browser_session:ai-sample-city",
        label: "Sample City preview",
        url: "http://127.0.0.1:49263/",
        sourceJobId: "job-1",
        openedAt: "2026-03-11T18:05:10.000Z",
        linkedProcessLeaseId: "proc_ai_sample_city",
        linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\Sample City"
      })
    ]
  });
  let capturedInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Thanks.\n\nBefore you close it, talk me through whether the call to action feels calmer now.",
    "2026-03-11T18:06:10.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for before-action multi-paragraph workflow conversation");
      },
      {
        runDirectConversationTurn: async (input) => {
          capturedInput = input;
          return {
            summary:
              "Yes, it feels calmer now because the call to action reads as an invitation instead of a push.\n\nWe can keep the preview open while we talk, then close it when you're ready."
          };
        }
      }
    )
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /\n\n/);
  assert.match(capturedInput, /Before you close it, talk me through/i);
  assert.equal(session.browserSessions[0]?.status, "open");
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
  assert.equal(session.domainContext.dominantLane, "unknown");
  assert.equal(
    session.domainContext.recentRoutingSignals[session.domainContext.recentRoutingSignals.length - 1]?.mode,
    "chat"
  );
  assert.equal(session.domainContext.continuitySignals.activeWorkspace, false);
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
  assert.equal(session.domainContext.dominantLane, "unknown");
  assert.equal(
    session.domainContext.recentRoutingSignals[session.domainContext.recentRoutingSignals.length - 1]?.mode,
    "status_or_recall"
  );
  assert.equal(session.modeContinuity?.activeMode, "status_or_recall");
  assert.equal(
    session.conversationTurns[session.conversationTurns.length - 1]?.text,
    normalizeAssistantTurnText(result.reply)
  );
});

test("routeConversationMessageInput keeps explicit status and recall off the worker path during workflow-heavy continuity", async () => {
  const session = buildWorkflowHeavySession({
    progressState: {
      status: "working",
      message: "I'm building the page and setting up the preview.",
      jobId: "job-1",
      updatedAt: "2026-03-11T18:05:00.000Z"
    }
  });

  const result = await routeConversationMessageInput(
    session,
    "What's the status and where did you leave the landing page?",
    "2026-03-11T18:05:10.000Z",
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for status/recall during workflow continuity");
    })
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /I'm working on/i);
  assert.match(result.reply, /Current workspace:/);
  assert.match(result.reply, /C:\\Users\\testuser\\Desktop\\sample-company/);
  assert.equal(session.modeContinuity?.activeMode, "status_or_recall");
});

test("routeConversationMessageInput can use contextual follow-up interpretation for ambiguous later-status wording", async () => {
  const session = buildWorkflowHeavySession({
    progressState: {
      status: "working",
      message: "I'm building the page and keeping the preview ready.",
      jobId: "job-1",
      updatedAt: "2026-03-11T18:05:00.000Z"
    }
  });
  let localIntentResolverCalled = false;

  const result = await routeConversationMessageInput(
    session,
    "Keep me posted on the landing page draft.",
    "2026-03-11T18:05:11.000Z",
    buildDependencies(
      () => {
        throw new Error("enqueueJob should not run for interpreted contextual status follow-ups");
      },
      {
        localIntentModelResolver: async () => {
          localIntentResolverCalled = true;
          return {
            source: "local_intent_model",
            mode: "build",
            confidence: "high",
            matchedRuleId: "local_intent_model_incorrect_contextual_followup_build",
            explanation: "The generic local model should not own contextual status interpretation.",
            clarification: null
          };
        },
        contextualFollowupInterpretationResolver: async (request) => {
          assert.deepEqual(request.deterministicCandidateTokens, ["landing", "page", "draft"]);
          return {
            source: "local_intent_model",
            kind: "status_followup",
            candidateTokens: ["landing", "page", "draft"],
            confidence: "medium",
            explanation: "The user wants a later update on the current landing page draft."
          };
        }
      }
    )
  );

  assert.equal(localIntentResolverCalled, false);
  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /I'm working on/i);
  assert.equal(session.modeContinuity?.activeMode, "status_or_recall");
  assert.equal(
    session.domainContext.recentRoutingSignals[session.domainContext.recentRoutingSignals.length - 1]?.mode,
    "status_or_recall"
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
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
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
  assert.equal(session.domainContext.dominantLane, "workflow");
  assert.equal(
    session.domainContext.recentRoutingSignals[session.domainContext.recentRoutingSignals.length - 1]?.mode,
    "status_or_recall"
  );
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
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\sample-company\\styles.css"
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
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\sample-company\\styles.css"
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
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\sample-company\\styles.css"
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
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\sample-company\\styles.css"
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
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\sample-company\\styles.css"
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
  assert.match(result.reply, /Next review step: Check the primary artifact at C:\\Users\\testuser\\Desktop\\sample-company\\index\.html\./);
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
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\sample-company\\styles.css"
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
  assert.match(result.reply, /Next review step: Check the primary artifact at C:\\Users\\testuser\\Desktop\\sample-company\\index\.html\./);
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
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\sample-company\\styles.css"
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
  assert.match(result.reply, /What I wrapped up: C:\\Users\\testuser\\Desktop\\sample-company\\index\.html and C:\\Users\\testuser\\Desktop\\sample-company\\styles\.css\./);
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
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
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
  assert.match(capturedExecutionInput, /Resume workspace root: C:\\Users\\testuser\\Desktop\\sample-company/);
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
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
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
  assert.match(capturedExecutionInput, /Resume workspace root: C:\\Users\\testuser\\Desktop\\sample-company/);
});

test("routeConversationMessageInput can use the local intent model for nuanced return-handoff explain wording", async () => {
  const session = buildSession({
    returnHandoff: {
      id: "handoff:job-explain-model",
      status: "completed",
      goal: "Finish the landing page draft and save it for review.",
      summary: "I finished the landing page draft and saved the review checkpoint for you.",
      nextSuggestedStep: "Tell me which section you want me to refine next.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: [
        "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
        "C:\\Users\\testuser\\Desktop\\sample-company\\styles.css"
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
  assert.match(result.reply, /What I changed: C:\\Users\\testuser\\Desktop\\sample-company\\index\.html and C:\\Users\\testuser\\Desktop\\sample-company\\styles\.css\./);
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
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
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

test("routeConversationMessageInput can use continuation interpretation for nuanced return-handoff resume wording", async () => {
  const session = buildSession({
    modeContinuity: {
      activeMode: "build",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:00.000Z",
      lastUserInput: "Build the landing page and leave it ready for review."
    },
    returnHandoff: {
      id: "handoff:job-resume-model",
      status: "waiting_for_user",
      goal: "Finish the landing page draft and leave the preview open.",
      summary: "The page draft exists and the preview can be resumed from the last checkpoint.",
      nextSuggestedStep: "Refine the hero copy and confirm the final CTA.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
      sourceJobId: "job-resume-model",
      updatedAt: "2026-03-11T18:05:25.000Z"
    }
  });
  let capturedExecutionInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Let's jump back into the saved draft and move it forward.",
    "2026-03-11T18:06:20.000Z",
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedExecutionInput = executionInput ?? "";
      currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
      return {
        reply: "queued",
        shouldStartWorker: true
      };
    }, {
      continuationInterpretationResolver: async (request) => {
        assert.equal(request.sessionHints?.hasReturnHandoff, true);
        return {
          source: "local_intent_model",
          kind: "return_handoff_resume",
          followUpCategory: null,
          continuationTarget: "return_handoff",
          candidateValue: null,
          confidence: "high",
          explanation: "The user is asking to resume the saved checkpoint rather than start new work."
        };
      }
    })
  );

  assert.equal(result.shouldStartWorker, true);
  assert.equal(result.reply, "I'm picking that back up from the last checkpoint now.");
  assert.match(capturedExecutionInput, /Durable return-handoff continuation:/);
  assert.match(capturedExecutionInput, /Resume workspace root: C:\\Users\\testuser\\Desktop\\sample-company/);
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
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
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
  assert.match(result.reply, /Workspace: C:\\Users\\testuser\\Desktop\\sample-company/);
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
      id: "workspace:sample-company",
      label: "Current project workspace",
      rootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      browserSessionId: "browser-1",
      browserSessionIds: ["browser-1"],
      browserSessionStatus: "open",
      browserProcessPid: 999,
      previewProcessLeaseId: "lease-1",
      previewProcessLeaseIds: ["lease-1"],
      previewProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company",
      lastKnownPreviewProcessPid: 1234,
      stillControllable: true,
      ownershipState: "tracked",
      previewStackState: "browser_and_preview",
      lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
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
  assert.match(result.reply, /Workspace: C:\\Users\\testuser\\Desktop\\sample-company/);
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
        location: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
        status: "created",
        sourceJobId: "job-1",
        at: "2026-03-11T18:05:00.000Z",
        summary: "Created the landing page."
      }
    ],
    pathDestinations: [
      {
        id: "dest-1",
        label: "Sample company folder",
        resolvedPath: "C:\\Users\\testuser\\Desktop\\sample-company",
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
  assert.match(capturedExecutionInput, /Preferred edit destination: C:\\Users\\testuser\\Desktop\\sample-company/);
});

test("routeConversationMessageInput keeps workflow continuation turns on the work path after conversational interludes", async () => {
  const session = buildSession({
    modeContinuity: {
      activeMode: "plan",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:00.000Z",
      lastUserInput: "Please plan a calm air-sample landing page in three concise steps."
    },
    recentJobs: [
      {
        ...buildQueuedJob(
          "Please plan a calm air-sample landing page in three concise steps.",
          "Please plan a calm air-sample landing page in three concise steps."
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

test("routeConversationMessageInput can use continuation interpretation for nuanced mode-continuation wording", async () => {
  const session = buildSession({
    modeContinuity: {
      activeMode: "build",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:00.000Z",
      lastUserInput: "Build the landing page and save it in the sample-company folder."
    },
    pathDestinations: [
      {
        id: "dest-1",
        label: "Sample company folder",
        resolvedPath: "C:\\Users\\testuser\\Desktop\\sample-company",
        sourceJobId: "job-1",
        updatedAt: "2026-03-11T18:05:00.000Z"
      }
    ]
  });
  let capturedExecutionInput = "";

  const result = await routeConversationMessageInput(
    session,
    "Let's keep moving with the last version in that earlier spot.",
    "2026-03-11T18:06:00.000Z",
    buildDependencies((currentSession, input, _receivedAt, executionInput) => {
      capturedExecutionInput = executionInput ?? "";
      currentSession.queuedJobs.push(buildQueuedJob(input, executionInput ?? input));
      return {
        reply: "queued",
        shouldStartWorker: true
      };
    }, {
      continuationInterpretationResolver: async (request) => {
        assert.equal(request.sessionHints?.modeContinuity, "build");
        return {
          source: "local_intent_model",
          kind: "mode_continuation",
          followUpCategory: null,
          continuationTarget: "mode_continuity",
          candidateValue: null,
          confidence: "medium",
          explanation: "The user wants to keep going with the current build flow and remembered destination."
        };
      }
    })
  );

  assert.equal(result.shouldStartWorker, true);
  assert.equal(session.modeContinuity?.activeMode, "build");
  assert.match(capturedExecutionInput, /Current working mode from earlier in this chat:/);
  assert.match(capturedExecutionInput, /Current user request:\nLet's keep moving with the last version in that earlier spot\./);
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
        linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company"
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
    /control=available; .*linkedPreviewLease=proc_preview_1; .*linkedPreviewCwd=C:\\Users\\testuser\\Desktop\\sample-company/
  );
  assert.match(capturedExecutionInput, /Natural browser-session follow-up:/);
  assert.match(capturedExecutionInput, /prefer close_browser with params\.sessionId=browser_session:landing-page and then stop_process with params\.leaseId=proc_preview_1/i);
});

test("routeConversationMessageInput resolves explicit foreign browser URLs inline when ownership is not proven", async () => {
  const session = buildWorkflowHeavySession({
    modeContinuity: {
      activeMode: "build",
      source: "natural_intent",
      confidence: "HIGH",
      lastAffirmedAt: "2026-03-11T18:05:00.000Z",
      lastUserInput: "Please close the landing page we left open earlier so we can move on."
    },
    returnHandoff: {
      id: "handoff:job-owned-stale",
      status: "completed",
      goal: "Please close the landing page we left open earlier so we can move on.",
      summary: "I closed the tracked landing page window from earlier and shut down its linked local preview process.",
      nextSuggestedStep: null,
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
      sourceJobId: "job-owned-stale",
      updatedAt: "2026-03-11T18:05:25.000Z"
    },
    browserSessions: [
      buildConversationBrowserSessionFixture({
        id: "browser-owned-stale",
        label: "Tracked landing page preview",
        url: "http://127.0.0.1:4177/index.html",
        sourceJobId: "job-owned-stale",
        openedAt: "2026-03-11T18:05:10.000Z",
        status: "closed",
        closedAt: "2026-03-11T18:05:24.000Z",
        controlAvailable: false,
        linkedProcessLeaseId: "proc-owned-stale",
        linkedProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company"
      })
    ],
    activeWorkspace: {
      id: "workspace:sample-company",
      label: "Tracked preview workspace",
      rootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      browserSessionId: "browser-owned-stale",
      browserSessionIds: ["browser-owned-stale"],
      browserSessionStatus: "closed",
      browserProcessPid: 999,
      previewProcessLeaseId: "lease-1",
      previewProcessLeaseIds: ["lease-1"],
      previewProcessCwd: "C:\\Users\\testuser\\Desktop\\sample-company",
      lastKnownPreviewProcessPid: 1234,
      stillControllable: false,
      ownershipState: "stale",
      previewStackState: "detached",
      lastChangedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
      sourceJobId: "job-owned-stale",
      updatedAt: "2026-03-11T18:05:25.000Z"
    }
  });

  const result = await routeConversationMessageInput(
    session,
    "There is another localhost page I opened myself earlier. If you cannot prove it belongs to this project, leave it alone instead of guessing. Please close http://127.0.0.1:59999/index.html only if it is actually the page from this project.",
    "2026-03-11T18:06:30.000Z",
    buildDependencies(() => {
      throw new Error("enqueueJob should not run when explicit browser ownership is not proven");
    })
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /ownership_not_proven/);
  assert.match(result.reply, /I left `http:\/\/127\.0\.0\.1:59999\/index\.html` alone\./);
  assert.match(result.reply, /only project page I can tie to this project from the conversation/i);
  assert.equal(session.modeContinuity?.activeMode, "status_or_recall");
});

test("routeConversationMessageInput can use handoff-control interpretation for nuanced pause wording", async () => {
  const session = buildWorkflowHeavySession({
    returnHandoff: {
      id: "handoff:pause-local-interpretation",
      status: "completed",
      goal: "Finish the calm landing page and leave it ready for review.",
      summary: "I finished the draft and left the checkpoint ready for your next step.",
      nextSuggestedStep: "Tell me what section you want me to refine next.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
      sourceJobId: "job-pause-1",
      updatedAt: "2026-03-12T00:00:09.000Z"
    },
    progressState: {
      status: "completed",
      message: "The draft is ready.",
      jobId: "job-pause-1",
      updatedAt: "2026-03-12T00:00:09.000Z"
    }
  });

  const result = await routeConversationMessageInput(
    session,
    "Let's stop on this checkpoint and revisit it tomorrow.",
    "2026-03-12T00:01:00.000Z",
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for interpreted return-handoff pause requests");
    }, {
      handoffControlInterpretationResolver: async (request) => {
        assert.equal(request.sessionHints?.hasReturnHandoff, true);
        return {
          source: "local_intent_model",
          kind: "pause_request",
          confidence: "medium",
          explanation: "The user wants to preserve the saved checkpoint and come back later."
        };
      }
    })
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /I'll leave the rest for later and keep this checkpoint ready for you/i);
  assert.equal(session.returnHandoff?.status, "waiting_for_user");
  assert.equal(session.progressState?.status, "waiting_for_user");
});

test("routeConversationMessageInput can use handoff-control interpretation for ambiguous saved-work review wording", async () => {
  const session = buildWorkflowHeavySession({
    returnHandoff: {
      id: "handoff:review-local-interpretation",
      status: "completed",
      goal: "Finish the calm landing page and leave it ready for review.",
      summary: "I finished the draft and left the preview ready for review.",
      nextSuggestedStep: "Tell me what section you want me to refine next.",
      workspaceRootPath: "C:\\Users\\testuser\\Desktop\\sample-company",
      primaryArtifactPath: "C:\\Users\\testuser\\Desktop\\sample-company\\index.html",
      previewUrl: "http://127.0.0.1:4177/index.html",
      changedPaths: ["C:\\Users\\testuser\\Desktop\\sample-company\\index.html"],
      sourceJobId: "job-review-1",
      updatedAt: "2026-03-12T00:00:09.000Z"
    }
  });

  const result = await routeConversationMessageInput(
    session,
    "Anything I should eyeball from that draft before we move on?",
    "2026-03-12T00:01:10.000Z",
    buildDependencies(() => {
      throw new Error("enqueueJob should not run for interpreted return-handoff review questions");
    }, {
      handoffControlInterpretationResolver: async (request) => {
        assert.equal(request.sessionHints?.hasReturnHandoff, true);
        return {
          source: "local_intent_model",
          kind: "review_request",
          confidence: "medium",
          explanation: "The user is asking what from the saved work is worth reviewing."
        };
      }
    })
  );

  assert.equal(result.shouldStartWorker, false);
  assert.match(result.reply, /Here is what is ready to review:/);
  assert.match(result.reply, /Preview: http:\/\/127\.0\.0\.1:4177\/index\.html/);
  assert.equal(session.modeContinuity?.activeMode, "status_or_recall");
});
