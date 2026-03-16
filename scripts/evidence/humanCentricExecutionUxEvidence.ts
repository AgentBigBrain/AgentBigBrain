/**
 * @fileoverview Runs deterministic scenario-driven evidence for the human-centric execution UX plan.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { ensureEnvLoaded } from "../../src/core/envLoader";
import { buildSessionSeed, createFollowUpRuleContext } from "../../src/interfaces/conversationManagerHelpers";
import { buildConversationInboundUserInput } from "../../src/interfaces/mediaRuntime/mediaNormalization";
import { resolveConversationIntentMode } from "../../src/interfaces/conversationRuntime/intentModeResolution";
import {
  createLocalIntentModelResolverFromEnv,
  isLocalIntentModelRuntimeReady,
  probeLocalIntentModelFromEnv
} from "../../src/organs/languageUnderstanding/localIntentModelRuntime";
import {
  routeConversationMessageInput,
  type ConversationRoutingDependencies
} from "../../src/interfaces/conversationRuntime/conversationRouting";
import type { ConversationCapabilitySummary } from "../../src/interfaces/conversationRuntime/managerContracts";
import type { ConversationSession } from "../../src/interfaces/sessionStore";
import type {
  HumanCentricExecutionUxScenario,
  HumanCentricExecutionUxScenarioCategory,
  HumanCentricExecutionUxScenarioPolarity
} from "./humanCentricExecutionUxSupport";
import {
  computeHumanCentricExecutionUxScenarioDiagnostics,
  loadHumanCentricExecutionUxScenarioInventory
} from "./humanCentricExecutionUxSupport";

interface ScenarioBehaviorResult {
  behavior: string;
  passed: boolean;
  note: string;
}

interface HumanCentricExecutionUxScenarioResult {
  scenarioId: string;
  category: HumanCentricExecutionUxScenarioCategory;
  polarity: HumanCentricExecutionUxScenarioPolarity;
  title: string;
  passed: boolean;
  transcriptPreview: readonly string[];
  observed: readonly ScenarioBehaviorResult[];
}

interface HumanCentricExecutionUxEvidenceArtifact {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL";
  summary: {
    scenarioCount: number;
    passedScenarios: number;
    failedScenarios: number;
    categoryCounts: Record<HumanCentricExecutionUxScenarioCategory, number>;
    polarityCounts: Record<HumanCentricExecutionUxScenarioPolarity, number>;
  };
  requiredProofs: {
    naturalIntentBuildWorks: boolean;
    clarificationPromptWorks: boolean;
    statusRecallWorks: boolean;
    capabilityDiscoveryWorks: boolean;
    voiceCommandPromotionWorks: boolean;
    voiceUnknownCommandSuppressed: boolean;
    negativeControlsHold: boolean;
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
    sampleInput: string | null;
    observedMode: string | null;
    observedConfidence: string | null;
    observedMatchedRuleId: string | null;
  };
  errors: readonly { scenarioId: string; message: string }[];
  warnings: readonly { scenarioId: string; message: string }[];
  scenarioResults: readonly HumanCentricExecutionUxScenarioResult[];
}

const WORKSPACE_ROOT = process.cwd();
const ARTIFACT_PATH = path.resolve(
  WORKSPACE_ROOT,
  "runtime/evidence/human_centric_execution_ux_report.json"
);
const COMMAND_NAME = "tsx scripts/evidence/humanCentricExecutionUxEvidence.ts";

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
      summary: "You can talk naturally in text or voice."
    },
    {
      id: "autonomous_execution",
      label: "Autonomous execution",
      status: "available",
      summary: "I can run clear requests end to end with normal safety checks."
    }
  ]
};

function getLastUserTurn(scenario: HumanCentricExecutionUxScenario): string {
  const turn = [...scenario.transcript].reverse().find((entry) => entry.speaker === "user");
  if (!turn) {
    throw new Error(`Scenario ${scenario.id} has no user turn.`);
  }
  return turn.text;
}

function buildTranscriptPreview(
  scenario: HumanCentricExecutionUxScenario
): readonly string[] {
  return scenario.transcript.map((turn) => `${turn.speaker}: ${turn.text}`);
}

function buildRoutingSession(
  conversationId: string,
  receivedAt: string
): ConversationSession {
  return buildSessionSeed({
    provider: "telegram",
    conversationId,
    userId: "user-1",
    username: "evidence-user",
    conversationVisibility: "private",
    receivedAt
  });
}

function buildRoutingDependencies(
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

async function evaluateNaturalIntentScenario(
  scenario: HumanCentricExecutionUxScenario
): Promise<HumanCentricExecutionUxScenarioResult> {
  const userInput = getLastUserTurn(scenario);
  const resolution = await resolveConversationIntentMode(userInput);
  const expectBuild = scenario.polarity === "positive";
  const passed = expectBuild ? resolution.mode === "build" : resolution.mode === "chat";
  return {
    scenarioId: scenario.id,
    category: scenario.category,
    polarity: scenario.polarity,
    title: scenario.title,
    passed,
    transcriptPreview: buildTranscriptPreview(scenario),
    observed: [
      {
        behavior: expectBuild ? "intent_mode_build" : "intent_mode_chat",
        passed,
        note: `Resolved mode '${resolution.mode}' with confidence '${resolution.confidence}'.`
      }
    ]
  };
}

async function evaluateClarificationScenario(
  scenario: HumanCentricExecutionUxScenario
): Promise<HumanCentricExecutionUxScenarioResult> {
  const userInput = getLastUserTurn(scenario);
  const resolution = await resolveConversationIntentMode(userInput);
  const expectClarification = scenario.polarity === "positive";
  const passed = expectClarification
    ? resolution.mode === "unclear" && resolution.clarification?.kind === "execution_mode"
    : resolution.mode === "build" && resolution.clarification === null;
  return {
    scenarioId: scenario.id,
    category: scenario.category,
    polarity: scenario.polarity,
    title: scenario.title,
    passed,
    transcriptPreview: buildTranscriptPreview(scenario),
    observed: [
      {
        behavior: expectClarification ? "clarify_plan_or_build" : "no_clarification_needed",
        passed,
        note: expectClarification
          ? `Resolved mode '${resolution.mode}' with question '${resolution.clarification?.question ?? "none"}'.`
          : `Resolved mode '${resolution.mode}' with clarification=${String(resolution.clarification !== null)}.`
      }
    ]
  };
}

async function evaluateStatusRecallScenario(
  scenario: HumanCentricExecutionUxScenario
): Promise<HumanCentricExecutionUxScenarioResult> {
  const receivedAt = "2026-03-12T14:00:00.000Z";
  const session = buildRoutingSession(`status-${scenario.id}`, receivedAt);
  if (scenario.polarity === "positive") {
    session.progressState = {
      status: "working",
      message: "building a landing page now",
      jobId: "job-1",
      updatedAt: receivedAt
    };
    session.pathDestinations = [
      {
        id: "dest-1",
        label: "Landing page folder",
        resolvedPath: "C:\\workspace\\Desktop\\123",
        sourceJobId: "job-1",
        updatedAt: receivedAt
      }
    ];
  }

  let enqueueCalled = false;
  const result = await routeConversationMessageInput(
    session,
    getLastUserTurn(scenario),
    receivedAt,
    buildRoutingDependencies((currentSession, input, createdAt, executionInput) => {
      enqueueCalled = true;
      currentSession.queuedJobs.push({
        id: "job-queued",
        input,
        executionInput: executionInput ?? input,
        createdAt,
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
      });
      return {
        reply: "",
        shouldStartWorker: true
      };
    })
  );

  const expectStatusMode = scenario.polarity === "positive";
  const passed = expectStatusMode
    ? !enqueueCalled && result.reply.includes("Recent locations:") && result.reply.includes("C:\\workspace\\Desktop\\123")
    : enqueueCalled;
  return {
    scenarioId: scenario.id,
    category: scenario.category,
    polarity: scenario.polarity,
    title: scenario.title,
    passed,
    transcriptPreview: buildTranscriptPreview(scenario),
    observed: [
      {
        behavior: expectStatusMode ? "status_or_recall_reply" : "non_status_route",
        passed,
        note: expectStatusMode
          ? `Reply preview: ${result.reply}`
          : `enqueueCalled=${String(enqueueCalled)}`
      }
    ]
  };
}

async function evaluateCapabilityDiscoveryScenario(
  scenario: HumanCentricExecutionUxScenario
): Promise<HumanCentricExecutionUxScenarioResult> {
  const receivedAt = "2026-03-12T14:05:00.000Z";
  const session = buildRoutingSession(`capability-${scenario.id}`, receivedAt);
  let enqueueCalled = false;
  const result = await routeConversationMessageInput(
    session,
    getLastUserTurn(scenario),
    receivedAt,
    buildRoutingDependencies((currentSession, input, createdAt, executionInput) => {
      enqueueCalled = true;
      currentSession.queuedJobs.push({
        id: "job-queued",
        input,
        executionInput: executionInput ?? input,
        createdAt,
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
      });
      return {
        reply: "",
        shouldStartWorker: true
      };
    }, {
      describeRuntimeCapabilities: async () => CAPABILITY_SUMMARY_FIXTURE,
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
      ]
    })
  );

  const expectCapability = scenario.polarity === "positive";
  const passed = expectCapability
    ? !enqueueCalled
      && result.reply.includes("Here is what I can help with in this Telegram chat right now:")
      && result.reply.includes("Reusable skills I can lean on:")
      && result.reply.includes("planner-fix")
    : enqueueCalled;
  return {
    scenarioId: scenario.id,
    category: scenario.category,
    polarity: scenario.polarity,
    title: scenario.title,
    passed,
    transcriptPreview: buildTranscriptPreview(scenario),
    observed: [
      {
        behavior: expectCapability ? "capability_reply" : "non_capability_route",
        passed,
        note: expectCapability
          ? `replyIncludesCapabilities=${String(result.reply.includes("Here is what I can help with"))}; replyIncludesSkills=${String(result.reply.includes("Reusable skills I can lean on:"))}`
          : `enqueueCalled=${String(enqueueCalled)}`
      }
    ]
  };
}

async function evaluateVoiceConvergenceScenario(
  scenario: HumanCentricExecutionUxScenario
): Promise<HumanCentricExecutionUxScenarioResult> {
  const transcript = getLastUserTurn(scenario);
  const normalized = buildConversationInboundUserInput("", {
    attachments: [
      {
        kind: "voice",
        provider: "telegram",
        fileId: "voice-1",
        fileUniqueId: "voice-1-uniq",
        mimeType: "audio/ogg",
        fileName: null,
        sizeBytes: 512,
        caption: null,
        durationSeconds: 4,
        width: null,
        height: null,
        interpretation: {
          summary: transcript,
          transcript,
          ocrText: null,
          confidence: 0.95,
          provenance: "fixture transcript",
          source: "fixture_catalog",
          entityHints: []
        }
      }
    ]
  });
  const expectPromotion = scenario.polarity === "positive";
  const promoted = normalized.startsWith("/auto");
  const passed = expectPromotion ? promoted : !normalized.startsWith("/");
  return {
    scenarioId: scenario.id,
    category: scenario.category,
    polarity: scenario.polarity,
    title: scenario.title,
    passed,
    transcriptPreview: buildTranscriptPreview(scenario),
    observed: [
      {
        behavior: expectPromotion ? "voice_command_promoted" : "voice_command_not_promoted",
        passed,
        note: `Normalized input: ${normalized}`
      }
    ]
  };
}

async function evaluateScenario(
  scenario: HumanCentricExecutionUxScenario
): Promise<HumanCentricExecutionUxScenarioResult> {
  switch (scenario.category) {
    case "natural_intent":
      return evaluateNaturalIntentScenario(scenario);
    case "clarification":
      return evaluateClarificationScenario(scenario);
    case "status_recall":
      return evaluateStatusRecallScenario(scenario);
    case "capability_discovery":
      return evaluateCapabilityDiscoveryScenario(scenario);
    case "voice_convergence":
      return evaluateVoiceConvergenceScenario(scenario);
    default: {
      const neverCategory: never = scenario.category;
      throw new Error(`Unsupported scenario category: ${neverCategory}`);
    }
  }
}

async function evaluateLocalIntentModelEvidence(): Promise<HumanCentricExecutionUxEvidenceArtifact["localIntentModel"]> {
  const probe = await probeLocalIntentModelFromEnv();
  if (!probe.enabled) {
    return {
      enabled: false,
      required: false,
      provider: probe.provider,
      model: probe.model,
      baseUrl: probe.baseUrl,
      reachable: false,
      modelPresent: false,
      status: "SKIPPED",
      note: "Local intent model is disabled in the current environment.",
      sampleInput: null,
      observedMode: null,
      observedConfidence: null,
      observedMatchedRuleId: null
    };
  }
  if (!isLocalIntentModelRuntimeReady(probe)) {
    return {
      enabled: true,
      required: probe.liveSmokeRequired,
      provider: probe.provider,
      model: probe.model,
      baseUrl: probe.baseUrl,
      reachable: probe.reachable,
      modelPresent: probe.modelPresent,
      status: probe.liveSmokeRequired ? "FAIL" : "SKIPPED",
      note: probe.reachable
        ? "Ollama is reachable, but the configured local intent model is missing."
        : "Ollama is not reachable from the configured base URL.",
      sampleInput: null,
      observedMode: null,
      observedConfidence: null,
      observedMatchedRuleId: null
    };
  }

  const resolver = createLocalIntentModelResolverFromEnv();
  const sampleInput =
    "Could you own this for me and keep the browser open later tonight? I do not need the walkthrough first.";
  const signal = resolver
    ? await resolver({
      userInput: sampleInput,
      routingClassification: null
    })
    : null;
  const passed = signal !== null && ["build", "autonomous"].includes(signal.mode);
  return {
    enabled: true,
    required: probe.liveSmokeRequired,
    provider: probe.provider,
    model: probe.model,
    baseUrl: probe.baseUrl,
    reachable: probe.reachable,
    modelPresent: probe.modelPresent,
    status: passed ? "PASS" : (probe.liveSmokeRequired ? "FAIL" : "SKIPPED"),
    note: passed
      ? "The live local intent model promoted a weak natural-language request into an execution mode."
      : "The live local intent model did not promote the weak natural-language request into build or autonomous mode.",
    sampleInput,
    observedMode: signal?.mode ?? null,
    observedConfidence: signal?.confidence ?? null,
    observedMatchedRuleId: signal?.matchedRuleId ?? null
  };
}

export async function runHumanCentricExecutionUxEvidence(): Promise<HumanCentricExecutionUxEvidenceArtifact> {
  ensureEnvLoaded();
  const inventory = await loadHumanCentricExecutionUxScenarioInventory();
  const diagnostics = computeHumanCentricExecutionUxScenarioDiagnostics(inventory);
  const scenarioResults = diagnostics.errors.length === 0
    ? await Promise.all(inventory.scenarios.map((scenario) => evaluateScenario(scenario)))
    : [];
  const localIntentModel = await evaluateLocalIntentModelEvidence();
  const scenarioFailures = scenarioResults
    .filter((scenario) => !scenario.passed)
    .flatMap((scenario) =>
      scenario.observed
        .filter((behavior) => !behavior.passed)
        .map((behavior) => ({
          scenarioId: scenario.scenarioId,
          message: `${behavior.behavior}: ${behavior.note}`
        }))
    );
  const passedScenarios = scenarioResults.filter((scenario) => scenario.passed).length;
  const failedScenarios = scenarioResults.length - passedScenarios;

  const requiredProofs = {
    naturalIntentBuildWorks: scenarioResults.some(
      (scenario) => scenario.scenarioId === "natural_build_now_positive" && scenario.passed
    ),
    clarificationPromptWorks: scenarioResults.some(
      (scenario) => scenario.scenarioId === "clarification_plan_or_build_positive" && scenario.passed
    ),
    statusRecallWorks: scenarioResults.some(
      (scenario) => scenario.scenarioId === "status_recall_positive" && scenario.passed
    ),
    capabilityDiscoveryWorks: scenarioResults.some(
      (scenario) => scenario.scenarioId === "capability_discovery_positive" && scenario.passed
    ),
    voiceCommandPromotionWorks: scenarioResults.some(
      (scenario) => scenario.scenarioId === "voice_command_auto_positive" && scenario.passed
    ),
    voiceUnknownCommandSuppressed: scenarioResults.some(
      (scenario) => scenario.scenarioId === "voice_command_unknown_negative" && scenario.passed
    ),
    negativeControlsHold: scenarioResults
      .filter((scenario) => scenario.polarity === "negative")
      .every((scenario) => scenario.passed)
  };

  const artifact: HumanCentricExecutionUxEvidenceArtifact = {
    generatedAt: new Date().toISOString(),
    command: COMMAND_NAME,
    status:
      diagnostics.errors.length === 0
      && scenarioFailures.length === 0
      && localIntentModel.status !== "FAIL"
      && Object.values(requiredProofs).every(Boolean)
        ? "PASS"
        : "FAIL",
    summary: {
      scenarioCount: diagnostics.summary.scenarioCount,
      passedScenarios,
      failedScenarios,
      categoryCounts: diagnostics.summary.categoryCounts,
      polarityCounts: diagnostics.summary.polarityCounts
    },
    requiredProofs,
    localIntentModel,
    errors: [...diagnostics.errors, ...scenarioFailures],
    warnings: diagnostics.warnings,
    scenarioResults
  };

  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifact;
}

async function main(): Promise<void> {
  const artifact = await runHumanCentricExecutionUxEvidence();
  console.log(`Human-centric execution UX evidence status: ${artifact.status}`);
  console.log(`Artifact: ${ARTIFACT_PATH}`);
  if (artifact.status === "FAIL") {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
