/**
 * @fileoverview Runs runtime-backed live smoke for Telegram media ingest and execution-intent clarification.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { EntityGraphStore } from "../../src/core/entityGraphStore";
import { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import type {
  AgentPulseEvaluationRequest,
  AgentPulseEvaluationResult,
  ProfileReadableEpisode
} from "../../src/core/profileMemoryStore";
import type {
  InterpretedConversationIntent,
  IntentInterpreterTurn
} from "../../src/organs/intentInterpreter";
import type { PulseLexicalRuleContext } from "../../src/organs/pulseLexicalClassifier";
import type { TelegramAdapter } from "../../src/interfaces/telegramAdapter";
import { TelegramGateway } from "../../src/interfaces/telegramGateway";
import { buildConversationKey } from "../../src/interfaces/conversationManagerHelpers";
import type {
  ConversationContinuityEpisodeQueryRequest,
  ConversationContinuityEpisodeRecord,
  ConversationContinuityFactQueryRequest,
  ConversationContinuityFactRecord,
  ConversationMemoryReviewRecord
} from "../../src/interfaces/conversationRuntime/managerContracts";
import { InterfaceSessionStore } from "../../src/interfaces/sessionStore";
import type { TelegramInterfaceConfig } from "../../src/interfaces/runtimeConfig";
import type { EntityGraphV1, TaskRunResult } from "../../src/core/types";
import type {
  LanguageEpisodeExtractionModelOutput,
  ModelClient,
  StructuredCompletionRequest
} from "../../src/models/types";
import { LanguageUnderstandingOrgan } from "../../src/organs/languageUnderstanding/episodeExtraction";
import { MediaUnderstandingOrgan } from "../../src/organs/mediaUnderstanding/mediaInterpretation";
import {
  buildTelegramUpdateForScenario,
  createMediaFixtureCatalog,
  ensureMediaIngestEvidenceDirectory,
  loadMediaFixtureBuffers,
  loadMediaIngestExecutionIntentScenarioInventory,
  type MediaIngestExecutionIntentScenario,
  MEDIA_INGEST_EXECUTION_INTENT_LIVE_SMOKE_ARTIFACT_PATH,
  MEDIA_INGEST_EXECUTION_INTENT_LIVE_SMOKE_COMMAND
} from "./mediaIngestExecutionIntentSupport";

type LiveSmokeScenarioId =
  | "image_fix_now"
  | "video_plan_or_build"
  | "voice_fix_now"
  | "voice_memory_followup";

interface ScenarioCheck {
  label: string;
  passed: boolean;
  observed: string;
}

interface MediaIngestExecutionIntentLiveSmokeScenarioResult {
  scenarioId: LiveSmokeScenarioId;
  title: string;
  passed: boolean;
  transcriptPreview: readonly string[];
  checks: readonly ScenarioCheck[];
}

interface MediaIngestExecutionIntentLiveSmokeArtifact {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL";
  summary: {
    scenarioCount: number;
    passedScenarios: number;
    failedScenarios: number;
  };
  requiredProofs: {
    imageFixNowDirectExecution: boolean;
    videoClarification: boolean;
    voiceFixNowDirectExecution: boolean;
    voiceMemoryBoundedPersistence: boolean;
  };
  scenarioResults: readonly MediaIngestExecutionIntentLiveSmokeScenarioResult[];
}

interface CapturedTelegramSend {
  method: "sendMessage" | "editMessageText" | "sendMessageDraft";
  text: string;
}

interface CapturedTextTaskRun {
  input: string;
  receivedAt: string;
}

interface TelegramLiveSmokeHarness {
  tempDir: string;
  sessionStore: InterfaceSessionStore;
  entityGraphStore: EntityGraphStore;
  profileStore: ProfileMemoryStore;
  sends: CapturedTelegramSend[];
  textTaskRuns: CapturedTextTaskRun[];
  restoreFetch(): void;
}

class MediaIngestLiveSmokeEpisodeModelClient implements ModelClient {
  readonly backend = "mock" as const;

  /**
   * Returns bounded episode candidates for the live-smoke scenarios.
   *
   * @param request - Structured completion request from the language-understanding organ.
   * @returns Stable structured episode output.
   */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    const payload = JSON.parse(request.userPrompt) as { text?: string };
    const text = (payload.text ?? "").trim();
    const lower = text.toLowerCase();
    const supportingSnippet = text.split(/(?<=[.!?])\s+/)[0]?.trim() ?? text;
    const output: LanguageEpisodeExtractionModelOutput = { episodes: [] };

    if (lower.includes("billy") && lower.includes("mri")) {
      output.episodes.push({
        subjectName: "Billy",
        eventSummary: "was waiting on MRI results",
        supportingSnippet,
        status: "outcome_unknown",
        confidence: 0.9,
        tags: ["medical", "followup"]
      });
    }

    return output as T;
  }
}

/**
 * Builds a minimal approved respond result for the live-smoke transport path.
 *
 * @param executionInput - Canonical execution input the runtime decided to run.
 * @param summary - Final natural-language reply summary.
 * @returns Minimal `TaskRunResult` that still exercises the real user-facing rendering path.
 */
function buildTaskRunResult(executionInput: string, summary: string): TaskRunResult {
  const nowIso = new Date("2026-03-10T18:00:00.000Z").toISOString();
  return {
    task: {
      id: "task_media_live_smoke",
      agentId: "main-agent",
      goal: "Handle the inbound Telegram request.",
      userInput: executionInput,
      createdAt: nowIso
    },
    plan: {
      taskId: "task_media_live_smoke",
      plannerNotes: "Live-smoke execution placeholder plan.",
      actions: [
        {
          id: "action_media_live_smoke_respond",
          type: "respond",
          description: "Reply to the user.",
          params: {
            message: summary
          },
          estimatedCostUsd: 0.01
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: "action_media_live_smoke_respond",
          type: "respond",
          description: "Reply to the user.",
          params: {
            message: summary
          },
          estimatedCostUsd: 0.01
        },
        mode: "fast_path",
        approved: true,
        output: summary,
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    summary,
    startedAt: nowIso,
    completedAt: nowIso
  };
}

/**
 * Returns the disabled pulse-evaluation result used by this bounded live smoke.
 *
 * @returns Stable pulse evaluation showing no proactive pulse path was requested here.
 */
function buildDisabledPulseEvaluation(): AgentPulseEvaluationResult {
  return {
    decision: {
      allowed: false,
      decisionCode: "OPT_OUT",
      suppressedBy: ["live_smoke_no_pulse"],
      nextEligibleAtIso: null
    },
    staleFactCount: 0,
    unresolvedCommitmentCount: 0,
    unresolvedCommitmentTopics: [],
    relevantEpisodes: [],
    relationship: {
      role: "unknown",
      roleFactId: null
    },
    contextDrift: {
      detected: false,
      domains: [],
      requiresRevalidation: false
    }
  };
}

/**
 * Maps profile-memory episode review records into conversation-review records.
 *
 * @param episodes - Readable episodes returned by profile-memory review.
 * @returns Conversation-facing review records.
 */
function toConversationMemoryReviewRecords(
  episodes: readonly ProfileReadableEpisode[]
): readonly ConversationMemoryReviewRecord[] {
  return episodes.map((episode) => ({
    episodeId: episode.episodeId,
    title: episode.title,
    summary: episode.summary,
    status: episode.status,
    lastMentionedAt: episode.lastMentionedAt,
    resolvedAt: episode.resolvedAt,
    confidence: episode.confidence,
    sensitive: episode.sensitive
  }));
}

/**
 * Builds one deterministic Telegram interface config for the media live smoke.
 *
 * @returns Stable Telegram interface runtime configuration.
 */
function buildTelegramConfig(): TelegramInterfaceConfig {
  return {
    provider: "telegram",
    botToken: "telegram-token",
    apiBaseUrl: "https://api.telegram.test",
    pollTimeoutSeconds: 30,
    pollIntervalMs: 1_000,
    streamingTransportMode: "edit",
    nativeDraftStreaming: false,
    allowedChatIds: [],
    media: {
      enabled: true,
      maxAttachments: 2,
      maxAttachmentBytes: 1_000_000,
      maxDownloadBytes: 1_000_000,
      maxVoiceSeconds: 120,
      maxVideoSeconds: 120,
      allowImages: true,
      allowVoiceNotes: true,
      allowVideos: true,
      allowDocuments: true
    },
    security: {
      sharedSecret: "shared-secret",
      allowedUsernames: ["anthonybenny"],
      allowedUserIds: [],
      rateLimitWindowMs: 60_000,
      maxEventsPerWindow: 20,
      replayCacheSize: 200,
      agentPulseTickIntervalMs: 60_000,
      ackDelayMs: 0,
      showTechnicalSummary: false,
      showSafetyCodes: false,
      showCompletionPrefix: false,
      followUpOverridePath: null,
      pulseLexicalOverridePath: null,
      allowAutonomousViaInterface: true,
      enableDynamicPulse: true,
      invocation: {
        requireNameCall: true,
        aliases: ["BigBrain"]
      }
    }
  };
}

/**
 * Polls until a predicate turns true or throws after a bounded timeout.
 *
 * @param predicate - Asynchronous condition function.
 * @param timeoutMs - Maximum wait time.
 * @returns Promise resolving once the predicate succeeds.
 */
async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for live-smoke condition.");
}

/**
 * Waits until the conversation worker drains queued/running jobs for one conversation.
 *
 * @param store - Session store used by the gateway.
 * @param conversationId - Conversation identifier.
 * @returns Promise resolving when the session is idle.
 */
async function waitForSessionIdle(
  store: InterfaceSessionStore,
  conversationId: string
): Promise<void> {
  let lastSnapshot = "<no session>";
  await waitFor(async () => {
    const session = await store.getSession(conversationId);
    if (!session) {
      lastSnapshot = "<missing session>";
      return false;
    }
    lastSnapshot = JSON.stringify({
      conversationId: session.conversationId,
      runningJobId: session.runningJobId,
      queuedJobs: session.queuedJobs.map((job) => ({
        id: job.id,
        status: job.status,
        input: job.input,
        executionInput: job.executionInput
      })),
      recentJobs: session.recentJobs.map((job) => ({
        id: job.id,
        status: job.status,
        finalDeliveryOutcome: job.finalDeliveryOutcome,
        ackLifecycleState: job.ackLifecycleState,
        input: job.input,
        executionInput: job.executionInput
      }))
    });
    return session.runningJobId === null && session.queuedJobs.length === 0;
  }).catch((error) => {
    const timeoutError = new Error(
      `Timed out waiting for session idle for ${conversationId}. Last session snapshot: ${lastSnapshot}`
    ) as Error & { cause?: unknown };
    timeoutError.cause = error;
    throw timeoutError;
  });
}

/**
 * Waits until the latest job records a final-delivery outcome.
 *
 * @param store - Session store used by the gateway.
 * @param conversationId - Conversation identifier.
 * @returns Promise resolving once final delivery has been attempted.
 */
async function waitForFinalDeliverySettled(
  store: InterfaceSessionStore,
  conversationId: string
): Promise<void> {
  await waitFor(async () => {
    const session = await store.getSession(conversationId);
    if (!session || session.recentJobs.length === 0) {
      return false;
    }
    return session.recentJobs[0]?.finalDeliveryOutcome !== "not_attempted";
  });
}

/**
 * Waits for temp file writes to settle before deleting the harness directory.
 *
 * @param tempDir - Harness temp directory.
 * @param timeoutMs - Maximum wait time.
 * @returns Promise resolving when pending temp writes have settled.
 */
async function waitForHarnessQuiescence(tempDir: string, timeoutMs = 1_000): Promise<void> {
  const startedAt = Date.now();
  let stableChecks = 0;
  while (Date.now() - startedAt < timeoutMs) {
    const entries = await readdir(tempDir).catch(() => [] as string[]);
    const hasPendingAtomicWrite = entries.some((entry) => entry.includes(".tmp-"));
    if (!hasPendingAtomicWrite) {
      stableChecks += 1;
      if (stableChecks >= 4) {
        return;
      }
    } else {
      stableChecks = 0;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Disposes the live-smoke harness temp state after the gateway is done.
 *
 * @param harness - Runtime harness to dispose.
 * @returns Promise resolving when temp state has been removed.
 */
async function disposeHarness(harness: TelegramLiveSmokeHarness): Promise<void> {
  let lastError: unknown = null;
  await waitForHarnessQuiescence(harness.tempDir);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(harness.tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        !["ENOTEMPTY", "EPERM", "EBUSY"].includes(String((error as { code?: string }).code))
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

/**
 * Creates the runtime harness and intercepts Telegram Bot API calls for one scenario.
 *
 * @param scenario - Scenario whose fixture should be served via the fake Bot API.
 * @param fixtureBuffer - Real fixture bytes served through the fake download endpoint.
 * @returns Runtime harness with captured transport calls.
 */
async function createHarness(
  scenario: MediaIngestExecutionIntentScenario,
  fixtureBuffer: Buffer
): Promise<TelegramLiveSmokeHarness> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-media-live-smoke-"));
  const sessionStore = new InterfaceSessionStore(path.join(tempDir, "interface_sessions.json"));
  const entityGraphStore = new EntityGraphStore(path.join(tempDir, "entity_graph.json"));
  const profileStore = new ProfileMemoryStore(
    path.join(tempDir, "profile_memory.enc"),
    Buffer.from("0123456789abcdef0123456789abcdef", "utf8")
  );
  const sends: CapturedTelegramSend[] = [];
  const textTaskRuns: CapturedTextTaskRun[] = [];
  const descriptorPath = `fixtures/${scenario.fixtureFile}`;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (input, init) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const url = new URL(rawUrl);
    if (url.pathname.endsWith("/getFile")) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            file_id: `fixture_${scenario.id}`,
            file_path: descriptorPath,
            file_size: fixtureBuffer.length
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.pathname.endsWith(`/${descriptorPath}`)) {
      const fixtureBytes = Uint8Array.from(fixtureBuffer);
      const fixtureBlob = new Blob([fixtureBytes], {
        type: "application/octet-stream"
      });
      return new Response(fixtureBlob, {
        status: 200,
        headers: {
          "Content-Type": "application/octet-stream"
        }
      });
    }
    if (
      url.pathname.endsWith("/sendMessage") ||
      url.pathname.endsWith("/editMessageText") ||
      url.pathname.endsWith("/sendMessageDraft")
    ) {
      const payload =
        typeof init?.body === "string"
          ? JSON.parse(init.body)
          : typeof (init?.body as { toString?: () => string } | undefined)?.toString === "function"
            ? JSON.parse((init?.body as { toString: () => string }).toString())
            : {};
      const method =
        url.pathname.endsWith("/sendMessage")
          ? "sendMessage"
          : url.pathname.endsWith("/editMessageText")
            ? "editMessageText"
            : "sendMessageDraft";
      sends.push({
        method,
        text: typeof payload.text === "string" ? payload.text : ""
      });
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: sends.length
          }
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error(`Unexpected Telegram live-smoke fetch URL: ${url.toString()}`);
  };

  return {
    tempDir,
    sessionStore,
    entityGraphStore,
    profileStore,
    sends,
    textTaskRuns,
    restoreFetch() {
      globalThis.fetch = originalFetch;
    }
  };
}

/**
 * Creates a minimal adapter-like object for the Telegram gateway live smoke.
 *
 * @param harness - Runtime harness for this scenario.
 * @returns Adapter-compatible object cast to the stable `TelegramAdapter` type.
 */
function createTelegramAdapterHarness(harness: TelegramLiveSmokeHarness): TelegramAdapter {
  const languageOrgan = new LanguageUnderstandingOrgan(new MediaIngestLiveSmokeEpisodeModelClient());

  return {
    validateMessage: () => ({
      accepted: true,
      code: "ACCEPTED",
      message: "Inbound message accepted."
    }),
    runTextTask: async (input: string, receivedAt: string) => {
      harness.textTaskRuns.push({ input, receivedAt });
      const additionalEpisodeCandidates = await languageOrgan.extractEpisodeCandidates({
        text: input,
        sourceTaskId: `media_live_smoke_${harness.textTaskRuns.length}`,
        observedAt: receivedAt
      });
      await harness.profileStore.ingestFromTaskInput(
        `media_live_smoke_${harness.textTaskRuns.length}`,
        input,
        receivedAt,
        { additionalEpisodeCandidates }
      );
      return buildTaskRunResult(input, "Understood. I'll take it from here.");
    },
    runAutonomousTask: async () => "Autonomous execution was not expected in this live smoke.",
    evaluateAgentPulse: async (_request: AgentPulseEvaluationRequest) => buildDisabledPulseEvaluation(),
    interpretConversationIntent: async (
      _input: string,
      _recentTurns: IntentInterpreterTurn[],
      _pulseRuleContext?: PulseLexicalRuleContext
    ): Promise<InterpretedConversationIntent> => ({
      intentType: "none",
      pulseMode: null,
      confidence: 0,
      rationale: "Live smoke does not use pulse-control intent interpretation.",
      source: "fallback"
    }),
    queryContinuityEpisodes: async (
      graph: EntityGraphV1,
      request: ConversationContinuityEpisodeQueryRequest
    ): Promise<readonly ConversationContinuityEpisodeRecord[]> => {
      const linkedEpisodes = await harness.profileStore.queryEpisodesForContinuity(
        graph,
        request.stack,
        {
          entityHints: request.entityHints,
          maxEpisodes: request.maxEpisodes
        }
      );
      return linkedEpisodes.map((entry) => ({
        episodeId: entry.episode.id,
        title: entry.episode.title,
        summary: entry.episode.summary,
        status: entry.episode.status,
        lastMentionedAt: entry.episode.lastMentionedAt,
        entityRefs: [...entry.episode.entityRefs],
        entityLinks: entry.entityLinks.map((link) => ({
          entityKey: link.entityKey,
          canonicalName: link.canonicalName
        })),
        openLoopLinks: entry.openLoopLinks.map((link) => ({
          loopId: link.loopId,
          threadKey: link.threadKey,
          status: link.status,
          priority: link.priority
        }))
      }));
    },
    queryContinuityFacts: async (
      graph: EntityGraphV1,
      request: ConversationContinuityFactQueryRequest
    ): Promise<readonly ConversationContinuityFactRecord[]> => {
      const facts = await harness.profileStore.queryFactsForContinuity(
        graph,
        request.stack,
        {
          entityHints: request.entityHints,
          maxFacts: request.maxFacts
        }
      );
      return facts.map((fact) => ({
        factId: fact.factId,
        key: fact.key,
        value: fact.value,
        status: fact.status,
        observedAt: fact.observedAt,
        lastUpdatedAt: fact.lastUpdatedAt,
        confidence: fact.confidence
      }));
    },
    reviewConversationMemory: async (
      _reviewTaskId: string,
      _query: string,
      nowIso: string,
      maxEpisodes = 5
    ): Promise<readonly ConversationMemoryReviewRecord[]> => {
      const episodes = await harness.profileStore.reviewEpisodesForUser(maxEpisodes, nowIso);
      return toConversationMemoryReviewRecords(episodes);
    },
    resolveConversationMemoryEpisode: async (
      episodeId: string,
      sourceTaskId: string,
      sourceText: string,
      nowIso: string,
      note?: string
    ): Promise<ConversationMemoryReviewRecord | null> => {
      const record = await harness.profileStore.updateEpisodeFromUser(
        episodeId,
        "resolved",
        sourceTaskId,
        sourceText,
        note,
        nowIso
      );
      return record ? toConversationMemoryReviewRecords([record])[0] ?? null : null;
    },
    markConversationMemoryEpisodeWrong: async (
      episodeId: string,
      sourceTaskId: string,
      sourceText: string,
      nowIso: string,
      note?: string
    ): Promise<ConversationMemoryReviewRecord | null> => {
      const record = await harness.profileStore.updateEpisodeFromUser(
        episodeId,
        "no_longer_relevant",
        sourceTaskId,
        sourceText,
        note,
        nowIso
      );
      return record ? toConversationMemoryReviewRecords([record])[0] ?? null : null;
    },
    forgetConversationMemoryEpisode: async (
      episodeId: string,
      sourceTaskId: string,
      sourceText: string,
      nowIso: string
    ): Promise<ConversationMemoryReviewRecord | null> => {
      const record = await harness.profileStore.forgetEpisodeFromUser(
        episodeId,
        sourceTaskId,
        sourceText,
        nowIso
      );
      return record ? toConversationMemoryReviewRecords([record])[0] ?? null : null;
    },
    listManagedProcessSnapshots: async () => [],
    listBrowserSessionSnapshots: async () => []
  } as unknown as TelegramAdapter;
}

/**
 * Builds a short human-readable transcript preview for artifact rendering.
 *
 * @param scenario - Scenario under test.
 * @returns Up to four non-empty preview lines.
 */
function buildTranscriptPreview(
  scenario: MediaIngestExecutionIntentScenario
): readonly string[] {
  const transcriptSource =
    scenario.userText.trim() ||
    scenario.expectedInterpretation.transcript ||
    scenario.expectedInterpretation.summary;
  return transcriptSource
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 4);
}

/**
 * Executes one scenario through the real Telegram gateway path and returns pass/fail checks.
 *
 * @param scenario - Scenario under test.
 * @param fixtureBuffer - Real fixture bytes for this scenario.
 * @param organ - Canonical media-understanding organ with fixture-catalog support.
 * @returns Scenario result for the live-smoke artifact.
 */
async function runScenario(
  scenario: MediaIngestExecutionIntentScenario,
  fixtureBuffer: Buffer,
  organ: MediaUnderstandingOrgan
): Promise<MediaIngestExecutionIntentLiveSmokeScenarioResult> {
  const harness = await createHarness(scenario, fixtureBuffer);
  try {
    const adapter = createTelegramAdapterHarness(harness);
    const gateway = new TelegramGateway(adapter, buildTelegramConfig(), {
      sessionStore: harness.sessionStore,
      entityGraphStore: harness.entityGraphStore,
      mediaUnderstandingOrgan: organ
    });

    const update = buildTelegramUpdateForScenario(scenario, fixtureBuffer.length, {
      chatId: `chat_${scenario.id}`,
      userId: "3001",
      username: "anthonybenny",
      updateId: Math.abs(scenario.id.split("").reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) | 0, 17)),
      dateSeconds: Date.UTC(2026, 2, 10, 18, 0, 0) / 1000
    });

    const gatewayInternal = gateway as unknown as {
      processUpdate(updateArg: typeof update): Promise<void>;
    };
    await gatewayInternal.processUpdate(update);

    const sessionKey = buildConversationKey({
      provider: "telegram",
      conversationId: `chat_${scenario.id}`,
      userId: "3001",
      username: "anthonybenny",
      conversationVisibility: "private",
      receivedAt: new Date(Date.UTC(2026, 2, 10, 18, 0, 0)).toISOString()
    });
    if (scenario.expectedBehavior.includes("direct_execute") || scenario.expectedBehavior.includes("memory_update")) {
      await waitForSessionIdle(harness.sessionStore, sessionKey);
      await waitForFinalDeliverySettled(harness.sessionStore, sessionKey);
    }

    const session = await harness.sessionStore.getSession(sessionKey);
    const recentJob = session?.recentJobs[0] ?? null;
    const reviewedEpisodes = await harness.profileStore.reviewEpisodesForUser(
      5,
      new Date("2026-03-10T18:05:00.000Z").toISOString()
    );
    const reviewedEpisodeJson = JSON.stringify(reviewedEpisodes);

    const checks: ScenarioCheck[] = [];
    if (scenario.id === "image_fix_now") {
      checks.push({
        label: "direct_execute_selected",
        passed: harness.textTaskRuns.length === 1 && recentJob?.status === "completed",
        observed: recentJob?.status ?? `runTextTask calls: ${harness.textTaskRuns.length}`
      });
      checks.push({
        label: "execution_input_contains_image_context",
        passed:
          Boolean(recentJob?.executionInput?.includes("Attached media context:")) &&
          Boolean(recentJob?.executionInput?.includes(scenario.expectedInterpretation.summary)) &&
          Boolean(recentJob?.executionInput?.includes(scenario.expectedInterpretation.ocrText ?? "")),
        observed: recentJob?.executionInput ?? "<missing execution input>"
      });
      checks.push({
        label: "final_delivery_attempted",
        passed: recentJob?.finalDeliveryOutcome === "sent",
        observed: recentJob?.finalDeliveryOutcome ?? "<missing>"
      });
    } else if (scenario.id === "video_plan_or_build") {
      const lastSend = harness.sends[harness.sends.length - 1] ?? null;
      checks.push({
        label: "plan_or_build_clarification",
        passed:
          harness.textTaskRuns.length === 0 &&
          lastSend?.text === "Do you want me to plan it first or build it now?",
        observed: lastSend?.text ?? "<missing>"
      });
      checks.push({
        label: "no_execution_job_started",
        passed: !session || session.recentJobs.length === 0,
        observed: session ? `recentJobs=${session.recentJobs.length}` : "no session job"
      });
    } else if (scenario.id === "voice_fix_now") {
      checks.push({
        label: "direct_execute_selected",
        passed: harness.textTaskRuns.length === 1 && recentJob?.status === "completed",
        observed: recentJob?.status ?? `runTextTask calls: ${harness.textTaskRuns.length}`
      });
      checks.push({
        label: "execution_input_contains_voice_transcript",
        passed:
          Boolean(recentJob?.executionInput?.includes("Voice note transcript:")) &&
          Boolean(
            recentJob?.executionInput?.includes(
              scenario.expectedInterpretation.transcript ?? ""
            )
          ),
        observed: recentJob?.executionInput ?? "<missing execution input>"
      });
      checks.push({
        label: "final_delivery_attempted",
        passed: recentJob?.finalDeliveryOutcome === "sent",
        observed: recentJob?.finalDeliveryOutcome ?? "<missing>"
      });
    } else {
      const billyEpisode = reviewedEpisodes.find((episode) =>
        episode.title.toLowerCase().includes("billy") ||
        episode.summary.toLowerCase().includes("billy") ||
        episode.entityRefs.some((entity) => entity.toLowerCase().includes("billy"))
      );
      checks.push({
        label: "voice_followup_memory_written",
        passed: Boolean(billyEpisode),
        observed: billyEpisode?.summary ?? "<missing Billy episode>"
      });
      checks.push({
        label: "raw_media_not_persisted",
        passed:
          !reviewedEpisodeJson.includes("OggS") &&
          !reviewedEpisodeJson.includes("fixture_") &&
          !reviewedEpisodeJson.includes("Attached media context:"),
        observed: reviewedEpisodeJson
      });
      checks.push({
        label: "voice_input_reached_runtime",
        passed:
          harness.textTaskRuns.length === 1 &&
          Boolean(
            recentJob?.executionInput?.includes(
              scenario.expectedInterpretation.transcript ?? ""
            )
          ),
        observed: recentJob?.executionInput ?? "<missing execution input>"
      });
    }

    return {
      scenarioId: scenario.id as LiveSmokeScenarioId,
      title: scenario.title,
      passed: checks.every((check) => check.passed),
      transcriptPreview: buildTranscriptPreview(scenario),
      checks
    };
  } finally {
    harness.restoreFetch();
    await disposeHarness(harness);
  }
}

/**
 * Executes the real media-ingest live smoke and persists a report artifact.
 *
 * @returns Final live-smoke artifact.
 */
export async function runMediaIngestExecutionIntentLiveSmoke(): Promise<MediaIngestExecutionIntentLiveSmokeArtifact> {
  const inventory = await loadMediaIngestExecutionIntentScenarioInventory();
  const fixtureBuffers = await loadMediaFixtureBuffers(inventory);
  const fixtureCatalog = createMediaFixtureCatalog(inventory, fixtureBuffers);
  const organ = new MediaUnderstandingOrgan(undefined, fixtureCatalog);
  const scenarioResults: MediaIngestExecutionIntentLiveSmokeScenarioResult[] = [];

  for (const scenario of inventory.scenarios) {
    const fixtureBuffer = fixtureBuffers.get(scenario.fixtureFile);
    assert.ok(fixtureBuffer, `Missing fixture buffer for ${scenario.fixtureFile}.`);
    scenarioResults.push(await runScenario(scenario, fixtureBuffer, organ));
  }

  const failedScenarios = scenarioResults.filter((scenario) => !scenario.passed).length;
  const requiredProofs = {
    imageFixNowDirectExecution: scenarioResults.some((entry) => entry.scenarioId === "image_fix_now" && entry.passed),
    videoClarification: scenarioResults.some((entry) => entry.scenarioId === "video_plan_or_build" && entry.passed),
    voiceFixNowDirectExecution: scenarioResults.some((entry) => entry.scenarioId === "voice_fix_now" && entry.passed),
    voiceMemoryBoundedPersistence: scenarioResults.some((entry) => entry.scenarioId === "voice_memory_followup" && entry.passed)
  };

  const artifact: MediaIngestExecutionIntentLiveSmokeArtifact = {
    generatedAt: new Date().toISOString(),
    command: MEDIA_INGEST_EXECUTION_INTENT_LIVE_SMOKE_COMMAND,
    status:
      failedScenarios === 0 && Object.values(requiredProofs).every(Boolean)
        ? "PASS"
        : "FAIL",
    summary: {
      scenarioCount: scenarioResults.length,
      passedScenarios: scenarioResults.length - failedScenarios,
      failedScenarios
    },
    requiredProofs,
    scenarioResults
  };

  await ensureMediaIngestEvidenceDirectory();
  await mkdir(path.dirname(MEDIA_INGEST_EXECUTION_INTENT_LIVE_SMOKE_ARTIFACT_PATH), {
    recursive: true
  });
  await writeFile(
    MEDIA_INGEST_EXECUTION_INTENT_LIVE_SMOKE_ARTIFACT_PATH,
    `${JSON.stringify(artifact, null, 2)}\n`,
    "utf8"
  );
  return artifact;
}

/**
 * Runs the media-ingest live smoke script and exits non-zero on failure.
 */
async function main(): Promise<void> {
  const artifact = await runMediaIngestExecutionIntentLiveSmoke();
  console.log(`Media-ingest execution-intent live smoke status: ${artifact.status}`);
  console.log(`Artifact: ${MEDIA_INGEST_EXECUTION_INTENT_LIVE_SMOKE_ARTIFACT_PATH}`);
  if (artifact.status !== "PASS") {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main();
}
