/**
 * @fileoverview Runs runtime-backed live smoke for human-centric execution UX behavior.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ensureEnvLoaded } from "../../src/core/envLoader";
import { ConversationManager } from "../../src/interfaces/conversationManager";
import { buildConversationInboundUserInput } from "../../src/interfaces/mediaRuntime/mediaNormalization";
import type {
  ConversationCapabilitySummary,
  ConversationInboundMessage,
  ConversationExecutionResult
} from "../../src/interfaces/conversationRuntime/managerContracts";
import { buildSessionSeed } from "../../src/interfaces/conversationManagerHelpers";
import { InterfaceSessionStore } from "../../src/interfaces/sessionStore";
import type { LocalIntentModelResolver } from "../../src/organs/languageUnderstanding/localIntentModelContracts";
import {
  createLocalIntentModelResolverFromEnv,
  isLocalIntentModelRuntimeReady,
  probeLocalIntentModelFromEnv
} from "../../src/organs/languageUnderstanding/localIntentModelRuntime";

interface LiveSmokeScenarioResult {
  scenarioId: string;
  passed: boolean;
  transcriptPreview: readonly string[];
  checks: readonly {
    label: string;
    passed: boolean;
    observed: string;
  }[];
}

interface HumanCentricExecutionUxLiveSmokeArtifact {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL";
  summary: {
    scenarioCount: number;
    passedScenarios: number;
    failedScenarios: number;
  };
  requiredProofs: {
    naturalBuildRequestWorked: boolean;
    clarificationRoundTripWorked: boolean;
    queueAndStatusCopyWorked: boolean;
    capabilityDiscoveryWorked: boolean;
    voiceCommandAutoWorked: boolean;
    textVoiceAutoParityWorked: boolean;
    statusRecallWorked: boolean;
    emptyInputRecoveryWorked: boolean;
  };
  localIntentModel: {
    enabled: boolean;
    required: boolean;
    provider: string;
    model: string;
    baseUrl: string;
    reachable: boolean;
    modelPresent: boolean;
    status: "PASS" | "FAIL" | "SKIPPED";
    note: string;
    invoked: boolean;
    observedMode: string | null;
    observedConfidence: string | null;
  };
  scenarioResults: readonly LiveSmokeScenarioResult[];
}

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/human_centric_execution_ux_live_smoke_report.json"
);
const COMMAND_NAME = "tsx scripts/evidence/humanCentricExecutionUxLiveSmoke.ts";

const CAPABILITY_SUMMARY_FIXTURE: ConversationCapabilitySummary = {
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
      summary: "You can talk naturally without special syntax."
    },
    {
      id: "autonomous_execution",
      label: "Autonomous execution",
      status: "available",
      summary: "I can run clear requests end to end with normal safety rules."
    }
  ]
};

interface Harness {
  tempDir: string;
  store: InterfaceSessionStore;
  manager: ConversationManager;
  notifications: string[];
  executedInputs: string[];
  localIntentModel: HumanCentricExecutionUxLiveSmokeArtifact["localIntentModel"];
}

function buildMessage(
  conversationId: string,
  text: string,
  receivedAt: string,
  media: ConversationInboundMessage["media"] = null
): ConversationInboundMessage {
  return {
    provider: "telegram",
    conversationId,
    userId: "user-1",
    username: "benny",
    conversationVisibility: "private",
    text,
    media,
    receivedAt
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 4_000
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await sleep(25);
  }
  throw new Error("Timed out waiting for live smoke condition.");
}

async function waitForSessionIdle(
  store: InterfaceSessionStore,
  conversationKey: string,
  timeoutMs = 4_000
): Promise<void> {
  await waitFor(async () => {
    const session = await store.getSession(conversationKey);
    if (!session) {
      return false;
    }
    return session.runningJobId === null && session.queuedJobs.length === 0;
  }, timeoutMs);
}

async function createHarness(): Promise<Harness> {
  const localProbe = await probeLocalIntentModelFromEnv();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-human-centric-ux-live-"));
  const store = new InterfaceSessionStore(path.join(tempDir, "interface_sessions.json"));
  const notifications: string[] = [];
  const executedInputs: string[] = [];
  const manager = new ConversationManager(
    store,
    {
      allowAutonomousViaInterface: true,
      maxConversationTurns: 40,
      maxContextTurnsForExecution: 10
    },
    {
      listAvailableSkills: async () => [
        {
          name: "planner-fix",
          description: "Repairs planner regressions.",
          userSummary: "Repairs planner regressions.",
          verificationStatus: "verified",
          riskLevel: "low",
          tags: ["planner"],
          invocationHints: ["Use when planning fails"],
          lifecycleStatus: "active",
          updatedAt: "2026-03-10T00:00:00.000Z"
        }
      ],
      describeRuntimeCapabilities: async () => CAPABILITY_SUMMARY_FIXTURE
    }
  );

  return {
    tempDir,
    store,
    manager,
    notifications,
    executedInputs,
    localIntentModel: {
      enabled: localProbe.enabled,
      required: localProbe.liveSmokeRequired,
      provider: localProbe.provider,
      model: localProbe.model,
      baseUrl: localProbe.baseUrl,
      reachable: localProbe.reachable,
      modelPresent: localProbe.modelPresent,
      status: localProbe.enabled
        ? (isLocalIntentModelRuntimeReady(localProbe)
          ? "SKIPPED"
          : (localProbe.liveSmokeRequired ? "FAIL" : "SKIPPED"))
        : "SKIPPED",
      note: localProbe.enabled
        ? (isLocalIntentModelRuntimeReady(localProbe)
          ? "Ready for live probe."
          : (localProbe.reachable
            ? "Configured local intent model is missing from Ollama."
            : "Ollama is not reachable."))
        : "Local intent model is disabled in the current environment.",
      invoked: false,
      observedMode: null,
      observedConfidence: null
    }
  };
}

async function disposeHarness(harness: Harness): Promise<void> {
  await sleep(200);
  await rm(harness.tempDir, { recursive: true, force: true });
}

async function runNaturalBuildScenario(harness: Harness): Promise<LiveSmokeScenarioResult> {
  const receivedAt = new Date("2026-03-12T15:00:00.000Z").toISOString();
  const reply = await harness.manager.handleMessage(
    buildMessage(
      "live-natural-build",
      "Go ahead and build this now with a clean hero and a clear call to action. Put it in the same desktop folder as before and keep it visible when it is ready.",
      receivedAt
    ),
    async (input): Promise<ConversationExecutionResult> => {
      harness.executedInputs.push(input);
      return {
        summary: "natural build smoke complete"
      };
    },
    async (message) => {
      harness.notifications.push(message);
    }
  );

  await waitForSessionIdle(harness.store, "telegram:live-natural-build:user-1");
  const executed = harness.executedInputs.some((input) =>
    input.includes("Go ahead and build this now")
  );
  return {
    scenarioId: "natural_build_request_live",
    passed: reply.startsWith("On it. I'll start with:") && executed,
    transcriptPreview: [
      "user: Go ahead and build this now with a clean hero and a clear call to action. Put it in the same desktop folder as before and keep it visible when it is ready."
    ],
    checks: [
      {
        label: "immediate_reply_shape",
        passed: reply.startsWith("On it. I'll start with:"),
        observed: reply
      },
      {
        label: "execution_started",
        passed: executed,
        observed: executed ? "captured execution input" : "execution input missing"
      }
    ]
  };
}

async function runClarificationScenario(harness: Harness): Promise<LiveSmokeScenarioResult> {
  const firstReply = await harness.manager.handleMessage(
    buildMessage(
      "live-clarification",
      "Create the landing page we talked about yesterday with a strong hero and call to action. I want to come back to it later, and I am still split on how the first step should happen.",
      new Date("2026-03-12T15:05:00.000Z").toISOString()
    ),
    async (input) => {
      harness.executedInputs.push(input);
      return {
        summary: "clarification smoke complete"
      };
    },
    async (message) => {
      harness.notifications.push(message);
    }
  );

  const secondReply = await harness.manager.handleMessage(
    buildMessage(
      "live-clarification",
      "Build it now.",
      new Date("2026-03-12T15:05:08.000Z").toISOString()
    ),
    async (input) => {
      harness.executedInputs.push(input);
      return {
        summary: "clarification smoke complete"
      };
    },
    async (message) => {
      harness.notifications.push(message);
    }
  );

  await waitForSessionIdle(harness.store, "telegram:live-clarification:user-1");
  const clarifiedExecution = harness.executedInputs.some((input) =>
    input.includes("User selected: Build it now.")
  );
  return {
    scenarioId: "clarification_round_trip_live",
    passed:
      firstReply.includes("Do you want me to plan it first or build it now?")
      && secondReply.startsWith("On it. I'll start with:")
      && clarifiedExecution,
    transcriptPreview: [
      "user: Create the landing page we talked about yesterday with a strong hero and call to action. I want to come back to it later, and I am still split on how the first step should happen.",
      `assistant: ${firstReply}`,
      "user: Build it now."
    ],
    checks: [
      {
        label: "clarification_prompt",
        passed: firstReply.includes("Do you want me to plan it first or build it now?"),
        observed: firstReply
      },
      {
        label: "clarified_execution",
        passed: clarifiedExecution,
        observed: clarifiedExecution
          ? "execution input includes clarification selection"
          : "missing clarification annotation in execution input"
      }
    ]
  };
}

async function runQueueAndStatusCopyScenario(harness: Harness): Promise<LiveSmokeScenarioResult> {
  const firstReply = await harness.manager.handleMessage(
    buildMessage(
      "live-queue",
      "Go ahead and build it now for this long queue request. Keep it deterministic and report completion after checks.",
      new Date("2026-03-12T15:10:00.000Z").toISOString()
    ),
    async (input) => {
      harness.executedInputs.push(input);
      if (input.toLowerCase().includes("long queue request")) {
        await sleep(300);
      }
      return {
        summary: "queue scenario first run complete"
      };
    },
    async (message) => {
      harness.notifications.push(message);
    }
  );

  const secondReply = await harness.manager.handleMessage(
    buildMessage(
      "live-queue",
      "Please run this follow-up request after the first one finishes. I am sending it now so it waits in queue.",
      new Date("2026-03-12T15:10:01.000Z").toISOString()
    ),
    async (input) => {
      harness.executedInputs.push(input);
      return {
        summary: `queue scenario follow-up complete for ${input}`
      };
    },
    async (message) => {
      harness.notifications.push(message);
    }
  );

  const statusReply = await harness.manager.handleMessage(
    buildMessage(
      "live-queue",
      "/status",
      new Date("2026-03-12T15:10:02.000Z").toISOString()
    ),
    async (input) => {
      harness.executedInputs.push(input);
      return {
        summary: input
      };
    },
    async (message) => {
      harness.notifications.push(message);
    }
  );

  await waitForSessionIdle(harness.store, "telegram:live-queue:user-1");

  const queueCopyPassed = secondReply.includes(
    "I got your request and added it"
  );
  const statusCopyPassed = statusReply.includes(
    "If you want the technical view behind this status, you can still run /status debug."
  );
  return {
    scenarioId: "queue_status_copy_live",
    passed: firstReply.startsWith("On it. I'll start with:") && queueCopyPassed && statusCopyPassed,
    transcriptPreview: [
      "user: Go ahead and build it now for this long queue request. Keep it deterministic and report completion after checks.",
      `assistant: ${firstReply}`,
      "user: Please run this follow-up request after the first one finishes. I am sending it now so it waits in queue.",
      `assistant: ${secondReply}`
    ],
    checks: [
      {
        label: "queue_copy",
        passed: queueCopyPassed,
        observed: secondReply
      },
      {
        label: "status_copy",
        passed: statusCopyPassed,
        observed: statusReply
      }
    ]
  };
}

async function runCapabilityScenario(harness: Harness): Promise<LiveSmokeScenarioResult> {
  const reply = await harness.manager.handleMessage(
    buildMessage(
      "live-capabilities",
      "What can you do here and what tools do you already know for this kind of work? I want the practical version.",
      new Date("2026-03-12T15:15:00.000Z").toISOString()
    ),
    async (input) => {
      harness.executedInputs.push(input);
      return {
        summary: input
      };
    },
    async (message) => {
      harness.notifications.push(message);
    }
  );

  const passed =
    reply.includes("Here is what I can help with in this Telegram chat right now:")
    && reply.includes("Reusable skills I can lean on:")
    && reply.includes("planner-fix");
  return {
    scenarioId: "capability_discovery_live",
    passed,
    transcriptPreview: [
      "user: What can you do here and what tools do you already know for this kind of work? I want the practical version.",
      `assistant: ${reply}`
    ],
    checks: [
      {
        label: "capability_and_skill_sections",
        passed,
        observed: reply
      }
    ]
  };
}

async function runVoiceAndTextAutoParityScenario(
  harness: Harness
): Promise<LiveSmokeScenarioResult> {
  const voiceTranscript =
    "Command auto create a smoke test page and verify it in a browser. Stop after proof and summarize what happened.";
  const voiceMedia: ConversationInboundMessage["media"] = {
    attachments: [
      {
        kind: "voice",
        provider: "telegram",
        fileId: "voice-1",
        fileUniqueId: "voice-1-uniq",
        mimeType: "audio/ogg",
        fileName: null,
        sizeBytes: 1024,
        caption: null,
        durationSeconds: 6,
        width: null,
        height: null,
        interpretation: {
          summary: voiceTranscript,
          transcript: voiceTranscript,
          ocrText: null,
          confidence: 0.95,
          provenance: "live-smoke voice fixture",
          source: "fixture_catalog",
          entityHints: []
        }
      }
    ]
  };
  const normalizedVoiceInput = buildConversationInboundUserInput("", voiceMedia);

  const voiceReply = await harness.manager.handleMessage(
    buildMessage(
      "live-voice-auto",
      normalizedVoiceInput,
      new Date("2026-03-12T15:20:00.000Z").toISOString(),
      voiceMedia
    ),
    async (input) => {
      harness.executedInputs.push(input);
      return {
        summary: "voice auto complete"
      };
    },
    async (message) => {
      harness.notifications.push(message);
    }
  );

  const textReply = await harness.manager.handleMessage(
    buildMessage(
      "live-text-auto",
      "/auto create a smoke test page and verify it in a browser, then stop and summarize what happened.",
      new Date("2026-03-12T15:20:05.000Z").toISOString()
    ),
    async (input) => {
      harness.executedInputs.push(input);
      return {
        summary: "text auto complete"
      };
    },
    async (message) => {
      harness.notifications.push(message);
    }
  );

  await waitForSessionIdle(harness.store, "telegram:live-voice-auto:user-1");
  await waitForSessionIdle(harness.store, "telegram:live-text-auto:user-1");

  const autonomousInputs = harness.executedInputs.filter((input) =>
    input.startsWith("[AUTONOMOUS_LOOP_GOAL]")
  );
  const passed =
    normalizedVoiceInput.startsWith("/auto")
    && voiceReply.includes("Starting autonomous loop for:")
    && textReply.includes("Starting autonomous loop for:")
    && autonomousInputs.length >= 2;
  return {
    scenarioId: "text_voice_auto_parity_live",
    passed,
    transcriptPreview: [
      `voice transcript: ${voiceTranscript}`,
      `normalized voice input: ${normalizedVoiceInput}`,
      `assistant (voice route): ${voiceReply}`,
      `assistant (text route): ${textReply}`
    ],
    checks: [
      {
        label: "voice_command_promoted",
        passed: normalizedVoiceInput.startsWith("/auto"),
        observed: normalizedVoiceInput
      },
      {
        label: "autonomous_inputs_captured",
        passed: autonomousInputs.length >= 2,
        observed: `count=${autonomousInputs.length}`
      }
    ]
  };
}

async function runStatusRecallScenario(harness: Harness): Promise<LiveSmokeScenarioResult> {
  const key = "telegram:live-recall:user-1";
  const seeded = buildSessionSeed({
    provider: "telegram",
    conversationId: "live-recall",
    userId: "user-1",
    username: "benny",
    conversationVisibility: "private",
    receivedAt: new Date("2026-03-12T15:25:00.000Z").toISOString()
  });
  seeded.progressState = {
    status: "working",
    message: "building the landing page right now",
    jobId: "job-1",
    updatedAt: new Date("2026-03-12T15:25:00.000Z").toISOString()
  };
  seeded.pathDestinations = [
    {
      id: "dest-1",
      label: "Desktop folder 123",
      resolvedPath: "C:\\workspace\\Desktop\\123",
      sourceJobId: "job-1",
      updatedAt: new Date("2026-03-12T15:24:59.000Z").toISOString()
    }
  ];
  await harness.store.setSession(seeded);

  const reply = await harness.manager.handleMessage(
    buildMessage(
      "live-recall",
      "What are you doing right now and where did you put that file from earlier? I am trying to reopen it.",
      new Date("2026-03-12T15:25:05.000Z").toISOString()
    ),
    async (input) => {
      harness.executedInputs.push(input);
      return { summary: input };
    },
    async (message) => {
      harness.notifications.push(message);
    }
  );

  const reloaded = await harness.store.getSession(key);
  const passed =
    reply.includes("I'm working on")
    && reply.includes("Recent locations:")
    && reply.includes("C:\\workspace\\Desktop\\123")
    && reloaded?.queuedJobs.length === 0;
  return {
    scenarioId: "status_recall_live",
    passed,
    transcriptPreview: [
      "user: What are you doing right now and where did you put that file from earlier? I am trying to reopen it.",
      `assistant: ${reply}`
    ],
    checks: [
      {
        label: "status_recall_reply",
        passed,
        observed: reply
      }
    ]
  };
}

async function runEmptyInputScenario(harness: Harness): Promise<LiveSmokeScenarioResult> {
  const reply = await harness.manager.handleMessage(
    buildMessage(
      "live-empty",
      "   ",
      new Date("2026-03-12T15:30:00.000Z").toISOString()
    ),
    async (input) => {
      harness.executedInputs.push(input);
      return { summary: input };
    },
    async (message) => {
      harness.notifications.push(message);
    }
  );

  const passed = reply.includes(
    "I did not receive any text yet. Send a quick message or add a caption and I will continue."
  );
  return {
    scenarioId: "empty_input_recovery_live",
    passed,
    transcriptPreview: [
      "user: (empty message)",
      `assistant: ${reply}`
    ],
    checks: [
      {
        label: "empty_input_copy",
        passed,
        observed: reply
      }
    ]
  };
}

async function runLocalIntentModelScenario(harness: Harness): Promise<LiveSmokeScenarioResult | null> {
  if (!harness.localIntentModel.enabled) {
    return null;
  }
  if (harness.localIntentModel.status === "FAIL") {
    return {
      scenarioId: "local_intent_model_live",
      passed: false,
      transcriptPreview: [
        "user: Could you take care of this end to end and leave the browser open for me later tonight? I do not need the walkthrough first."
      ],
      checks: [
        {
          label: "local_model_available",
          passed: false,
          observed: harness.localIntentModel.note
        }
      ]
    };
  }

  let resolverCalls = 0;
  let observedMode: string | null = null;
  let observedConfidence: string | null = null;
  const baseResolver = createLocalIntentModelResolverFromEnv();
  if (!baseResolver) {
    return null;
  }
  const instrumentedResolver: LocalIntentModelResolver = async (request) => {
    resolverCalls += 1;
    const signal = await baseResolver(request);
    observedMode = signal?.mode ?? null;
    observedConfidence = signal?.confidence ?? null;
    return signal;
  };
  const tempManager = new ConversationManager(
    harness.store,
    {
      allowAutonomousViaInterface: true,
      maxConversationTurns: 40,
      maxContextTurnsForExecution: 10
    },
    {
      listAvailableSkills: async () => [
        {
          name: "planner-fix",
          description: "Repairs planner regressions.",
          userSummary: "Repairs planner regressions.",
          verificationStatus: "verified",
          riskLevel: "low",
          tags: ["planner"],
          invocationHints: ["Use when planning fails"],
          lifecycleStatus: "active",
          updatedAt: "2026-03-10T00:00:00.000Z"
        }
      ],
      describeRuntimeCapabilities: async () => CAPABILITY_SUMMARY_FIXTURE,
      localIntentModelResolver: instrumentedResolver
    }
  );

  const reply = await tempManager.handleMessage(
    buildMessage(
      "live-local-intent",
      "Could you own this for me and keep it open for me later tonight?",
      new Date("2026-03-12T15:35:00.000Z").toISOString()
    ),
    async (input) => {
      harness.executedInputs.push(input);
      return {
        summary: `local intent live smoke complete for ${input}`
      };
    },
    async (message) => {
      harness.notifications.push(message);
    }
  );
  await waitForSessionIdle(harness.store, "telegram:live-local-intent:user-1");

  harness.localIntentModel.invoked = resolverCalls > 0;
  harness.localIntentModel.observedMode = observedMode;
  harness.localIntentModel.observedConfidence = observedConfidence;
  const passed =
    resolverCalls > 0
    && (observedMode === "build" || observedMode === "autonomous")
    && (
      reply.startsWith("On it. I'll start with:")
      || reply.startsWith("I'm taking this end to end now.")
    );
  harness.localIntentModel.status = passed
    ? "PASS"
    : (harness.localIntentModel.required ? "FAIL" : "SKIPPED");
  harness.localIntentModel.note = passed
    ? "Live smoke used the real local intent model and it promoted a weak natural-language request into execution."
    : "Live smoke called the real local intent model, but it did not clearly promote the weak natural-language request into build or autonomous execution.";
  return {
    scenarioId: "local_intent_model_live",
    passed,
    transcriptPreview: [
      "user: Could you own this for me and keep it open for me later tonight?",
      `assistant: ${reply}`
    ],
    checks: [
      {
        label: "local_model_invoked",
        passed: resolverCalls > 0,
        observed: `calls=${resolverCalls}`
      },
      {
        label: "local_model_promoted_execution",
        passed: observedMode === "build" || observedMode === "autonomous",
        observed: `mode=${observedMode ?? "null"} confidence=${observedConfidence ?? "null"}`
      }
    ]
  };
}

function buildArtifact(
  scenarioResults: readonly LiveSmokeScenarioResult[],
  localIntentModel: HumanCentricExecutionUxLiveSmokeArtifact["localIntentModel"]
): HumanCentricExecutionUxLiveSmokeArtifact {
  const requiredProofs = {
    naturalBuildRequestWorked: scenarioResults.some(
      (scenario) => scenario.scenarioId === "natural_build_request_live" && scenario.passed
    ),
    clarificationRoundTripWorked: scenarioResults.some(
      (scenario) => scenario.scenarioId === "clarification_round_trip_live" && scenario.passed
    ),
    queueAndStatusCopyWorked: scenarioResults.some(
      (scenario) => scenario.scenarioId === "queue_status_copy_live" && scenario.passed
    ),
    capabilityDiscoveryWorked: scenarioResults.some(
      (scenario) => scenario.scenarioId === "capability_discovery_live" && scenario.passed
    ),
    voiceCommandAutoWorked: scenarioResults.some(
      (scenario) => scenario.scenarioId === "text_voice_auto_parity_live" && scenario.passed
    ),
    textVoiceAutoParityWorked: scenarioResults.some(
      (scenario) => scenario.scenarioId === "text_voice_auto_parity_live" && scenario.passed
    ),
    statusRecallWorked: scenarioResults.some(
      (scenario) => scenario.scenarioId === "status_recall_live" && scenario.passed
    ),
    emptyInputRecoveryWorked: scenarioResults.some(
      (scenario) => scenario.scenarioId === "empty_input_recovery_live" && scenario.passed
    )
  };
  const passedScenarios = scenarioResults.filter((scenario) => scenario.passed).length;
  const failedScenarios = scenarioResults.length - passedScenarios;
  return {
    generatedAt: new Date().toISOString(),
    command: COMMAND_NAME,
    status:
      failedScenarios === 0
      && localIntentModel.status !== "FAIL"
      && Object.values(requiredProofs).every(Boolean)
        ? "PASS"
        : "FAIL",
    summary: {
      scenarioCount: scenarioResults.length,
      passedScenarios,
      failedScenarios
    },
    requiredProofs,
    localIntentModel,
    scenarioResults
  };
}

export async function runHumanCentricExecutionUxLiveSmoke(): Promise<HumanCentricExecutionUxLiveSmokeArtifact> {
  ensureEnvLoaded();
  const harness = await createHarness();
  try {
    const scenarioResults = [
      await runNaturalBuildScenario(harness),
      await runClarificationScenario(harness),
      await runQueueAndStatusCopyScenario(harness),
      await runCapabilityScenario(harness),
      await runVoiceAndTextAutoParityScenario(harness),
      await runStatusRecallScenario(harness),
      await runEmptyInputScenario(harness)
    ] as LiveSmokeScenarioResult[];
    const localIntentModelScenario = await runLocalIntentModelScenario(harness);
    if (localIntentModelScenario) {
      scenarioResults.push(localIntentModelScenario);
    }
    const artifact = buildArtifact(scenarioResults, harness.localIntentModel);
    await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
    await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    return artifact;
  } finally {
    await disposeHarness(harness);
  }
}

async function main(): Promise<void> {
  const artifact = await runHumanCentricExecutionUxLiveSmoke();
  console.log(`Human-centric execution UX live smoke status: ${artifact.status}`);
  console.log(`Artifact: ${ARTIFACT_PATH}`);
  if (artifact.status === "FAIL") {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
