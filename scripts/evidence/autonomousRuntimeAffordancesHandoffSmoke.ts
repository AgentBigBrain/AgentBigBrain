/**
 * @fileoverview Runs a front-door autonomous handoff smoke through the real conversation runtime.
 *
 * This proof surface verifies that:
 * 1. a natural autonomous request leaves behind a useful draft and durable checkpoint
 * 2. return-style review prompts answer from the saved handoff without queueing new work
 * 3. a natural resume request stays tied to the same workspace and continues from that checkpoint
 * 4. the resulting workspace can still be cleaned up naturally at the end
 */

import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildDefaultBrain } from "../../src/core/buildBrain";
import { ensureEnvLoaded } from "../../src/core/envLoader";
import { buildConversationKey } from "../../src/interfaces/conversationManagerHelpers";
import { ConversationManager } from "../../src/interfaces/conversationManager";
import type {
  ConversationCapabilitySummary,
  ConversationDeliveryResult,
  ConversationExecutionResult,
  ConversationInboundMessage,
  ConversationNotifierTransport
} from "../../src/interfaces/conversationRuntime/managerContracts";
import { parseAutonomousExecutionInput } from "../../src/interfaces/conversationRuntime/managerContracts";
import type { ConversationJob, ConversationSession } from "../../src/interfaces/conversationRuntime/sessionStateContracts";
import { InterfaceSessionStore } from "../../src/interfaces/sessionStore";
import { TelegramAdapter } from "../../src/interfaces/telegramAdapter";
import { runAutonomousTransportTask } from "../../src/interfaces/transportRuntime/deliveryLifecycle";
import { selectUserFacingSummary } from "../../src/interfaces/userFacingResult";
import {
  createLocalIntentModelResolverFromEnv,
  isLocalIntentModelRuntimeReady,
  probeLocalIntentModelFromEnv
} from "../../src/organs/languageUnderstanding/localIntentModelRuntime";
import { cleanupLingeringPlaywrightAutomationBrowsers } from "../../src/organs/liveRun/playwrightBrowserProcessIntrospection";

type ArtifactStatus = "PASS" | "FAIL" | "BLOCKED";

interface CapturedNotification {
  phase: "send" | "edit";
  messageId: string;
  text: string;
  at: string;
}

interface TurnCapture {
  turn: number;
  receivedAt: string;
  user: string;
  immediateReply: string;
  notifications: readonly CapturedNotification[];
  sessionSnapshot: ConversationSession;
}

interface LocalIntentProof {
  enabled: boolean;
  required: boolean;
  reachable: boolean;
  modelPresent: boolean;
  model: string;
  provider: string;
  baseUrl: string;
}

interface EnvSnapshot {
  [key: string]: string | undefined;
}

const LIVE_RUN_RUNTIME_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-autonomous-runtime-affordances-handoff-live-run-${Date.now()}`
);
const STATE_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-autonomous-runtime-affordances-handoff-state-${Date.now()}.json`
);

export interface AutonomousRuntimeAffordancesHandoffArtifact {
  generatedAt: string;
  command: string;
  status: ArtifactStatus;
  blockerReason: string | null;
  localIntentModel: LocalIntentProof;
  targetFolder: string | null;
  previewUrl: string | null;
  browserSessionId: string | null;
  checks: {
    naturalAutonomousStart: boolean;
    roughDraftReviewWithoutNewWork: boolean;
    roughDraftReviewSurfaced: boolean;
    pauseCheckpointSaved: boolean;
    whileAwaySummaryWithoutNewWork: boolean;
    whileAwaySummarySurfaced: boolean;
    resumeContinuationUsed: boolean;
    resumeStayedOnSameWorkspace: boolean;
    sliderAppliedOnResume: boolean;
    browserClosed: boolean;
    reviewableUserFacingCopy: boolean;
  };
  turns: readonly TurnCapture[];
}

const COMMAND_NAME = "tsx scripts/evidence/autonomousRuntimeAffordancesHandoffSmoke.ts";
const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/autonomous_runtime_affordances_handoff_report.json"
);
const SESSION_PATH = path.resolve(
  process.cwd(),
  "runtime/autonomous_runtime_affordances_handoff_sessions.json"
);
const CONVERSATION_ID = `autonomous-runtime-handoff-smoke-${Date.now()}`;
const USER_ID = "autonomous-handoff-smoke-user";
const USERNAME = "anthonybenny";
const PROVIDER_BLOCK_PATTERN =
  /(?:429|exceeded your current quota|rate limit|fetch failed|request timed out)/i;
const TURN_TIMEOUT_MS = 45_000;
const SMOKE_DEADLINE_MS = 120_000;
const BOUNDED_BLOCK_PATTERN =
  /(?:Timed out waiting|429|exceeded your current quota|rate limit|fetch failed|request timed out|socket hang up|ECONNRESET)/i;

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
      id: "plan_and_build",
      label: "Plan and build",
      status: "available",
      summary: "I can build, edit, and verify local work when the request is clear."
    },
    {
      id: "autonomous_execution",
      label: "Autonomous execution",
      status: "available",
      summary: "I can keep going until the task is finished or I hit a real blocker."
    }
  ]
};

function cloneSessionSnapshot(session: ConversationSession): ConversationSession {
  return JSON.parse(JSON.stringify(session)) as ConversationSession;
}

function buildMessage(text: string, receivedAt: string): ConversationInboundMessage {
  return {
    provider: "telegram",
    conversationId: CONVERSATION_ID,
    userId: USER_ID,
    username: USERNAME,
    conversationVisibility: "private",
    text,
    receivedAt
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function applyEnvOverrides(overrides: Readonly<Record<string, string>>): EnvSnapshot {
  const snapshot: EnvSnapshot = {};
  for (const [key, value] of Object.entries(overrides)) {
    snapshot[key] = process.env[key];
    process.env[key] = value;
  }
  return snapshot;
}

function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

function getRemainingSmokeBudget(deadlineAtMs: number, capMs: number, label: string): number {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(`Timed out waiting for ${label}; smoke exceeded ${SMOKE_DEADLINE_MS}ms overall.`);
  }
  return Math.min(capMs, remainingMs);
}

function createNotifierTransport(
  notificationSink: CapturedNotification[]
): ConversationNotifierTransport {
  let nextMessageId = 1;
  const capture = async (
    phase: "send" | "edit",
    text: string,
    messageId?: string
  ): Promise<ConversationDeliveryResult> => {
    const resolvedMessageId = messageId ?? `msg-${nextMessageId++}`;
    notificationSink.push({
      phase,
      messageId: resolvedMessageId,
      text,
      at: new Date().toISOString()
    });
    console.log(`[notify/${phase}:${resolvedMessageId}] ${text}`);
    return {
      ok: true,
      messageId: resolvedMessageId,
      errorCode: null
    };
  };
  return {
    capabilities: {
      supportsEdit: true,
      supportsNativeStreaming: false
    },
    send: async (message) => capture("send", message),
    edit: async (messageId, message) => capture("edit", message, messageId)
  };
}

async function waitForTurnCompletion(
  store: InterfaceSessionStore,
  conversationKey: string,
  turnLabel: string,
  turnStartedAt: string,
  timeoutMs = TURN_TIMEOUT_MS
): Promise<ConversationSession> {
  const startedAt = Date.now();
  let observedExecution = false;
  let lastHeartbeatAt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const session = await store.getSession(conversationKey);
    if (session) {
      const now = Date.now();
      if (now - lastHeartbeatAt >= 3_000) {
        console.log(
          `[heartbeat:${turnLabel}] runningJob=${session.runningJobId ?? "null"} ` +
          `queued=${session.queuedJobs.length} progress=${session.progressState?.status ?? "none"}:` +
          `${session.progressState?.message ?? ""}`
        );
        lastHeartbeatAt = now;
      }

      const matchingJobs = session.recentJobs.filter((job) => job.createdAt >= turnStartedAt);
      const hasFreshClarification =
        session.activeClarification?.requestedAt !== undefined &&
        session.activeClarification.requestedAt >= turnStartedAt;
      const hasFreshAssistantTurn = session.conversationTurns.some(
        (turn) => turn.role === "assistant" && turn.at >= turnStartedAt
      );

      if (
        matchingJobs.length > 0 ||
        session.runningJobId !== null ||
        session.queuedJobs.length > 0 ||
        hasFreshClarification ||
        hasFreshAssistantTurn
      ) {
        observedExecution = true;
      }

      const hasCompletedFreshJob = matchingJobs.some((job) => job.status !== "running");
      if (
        observedExecution &&
        session.runningJobId === null &&
        session.queuedJobs.length === 0 &&
        (hasCompletedFreshJob || hasFreshClarification || hasFreshAssistantTurn)
      ) {
        return session;
      }
    }

    await sleep(200);
  }

  throw new Error(`Timed out waiting for ${turnLabel} to complete.`);
}

function extractPreviewUrl(session: ConversationSession): string | null {
  if (session.activeWorkspace?.previewUrl) {
    return session.activeWorkspace.previewUrl;
  }
  const openBrowser = session.browserSessions.find((entry) => entry.status === "open");
  if (openBrowser) {
    return openBrowser.url;
  }
  const recentUrl = session.recentActions.find((entry) => entry.kind === "url" && entry.location);
  return recentUrl?.location ?? null;
}

function extractTargetFolder(session: ConversationSession): string | null {
  if (session.activeWorkspace?.rootPath) {
    return session.activeWorkspace.rootPath;
  }
  if (session.activeWorkspace?.primaryArtifactPath) {
    return path.dirname(session.activeWorkspace.primaryArtifactPath);
  }
  const browserWorkspacePath = session.browserSessions.find(
    (entry) => typeof entry.workspaceRootPath === "string" && entry.workspaceRootPath.trim().length > 0
  )?.workspaceRootPath;
  if (browserWorkspacePath) {
    return browserWorkspacePath;
  }
  const processPath = session.pathDestinations.find((entry) => entry.id.startsWith("path:process:"));
  if (processPath) {
    return processPath.resolvedPath;
  }
  const filePath = session.pathDestinations.find((entry) => entry.resolvedPath.endsWith("index.html"));
  if (filePath) {
    return path.dirname(filePath.resolvedPath);
  }
  const previewUrl = extractPreviewUrl(session);
  if (previewUrl?.startsWith("file://")) {
    try {
      return path.dirname(fileURLToPath(previewUrl));
    } catch {
      return null;
    }
  }
  return null;
}

function extractLatestAssistantReply(session: ConversationSession): string {
  return [...session.conversationTurns]
    .reverse()
    .find((turn) => turn.role === "assistant")?.text ?? "";
}

function detectProviderBlockerReason(...texts: readonly unknown[]): string | null {
  const combined = texts
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  return PROVIDER_BLOCK_PATTERN.test(combined) ? combined : null;
}

function detectBoundedHandoffBlockerReason(error: unknown): string | null {
  const combined =
    error instanceof Error
      ? error.stack ?? error.message
      : typeof error === "string"
        ? error
        : JSON.stringify(error);
  return BOUNDED_BLOCK_PATTERN.test(combined) ? combined : null;
}

function isReviewableReply(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length >= 24 && !/^\s*{\s*"/.test(trimmed) && !/^\/auto\b/i.test(trimmed);
}

function findLatestJobSince(
  session: ConversationSession,
  turnStartedAt: string
): ConversationJob | null {
  const matchingJobs = session.recentJobs.filter((job) => job.createdAt >= turnStartedAt);
  if (matchingJobs.length === 0) {
    return null;
  }
  return matchingJobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
}

function extractLatestChangedFileNames(session: ConversationSession): string[] {
  const latestCompletedJob = session.recentJobs
    .filter((job) => job.status === "completed")
    .sort((left, right) => {
      const leftTimestamp = left.completedAt ?? left.startedAt ?? left.createdAt;
      const rightTimestamp = right.completedAt ?? right.startedAt ?? right.createdAt;
      return rightTimestamp.localeCompare(leftTimestamp);
    })[0];
  if (!latestCompletedJob) {
    return [];
  }
  return session.recentActions
    .filter(
      (action) =>
        action.sourceJobId === latestCompletedJob.id &&
        action.kind === "file" &&
        typeof action.location === "string"
    )
    .map((action) => path.basename(action.location as string))
    .filter((fileName, index, array) => fileName.length > 0 && array.indexOf(fileName) === index);
}

async function cleanupTrackedSmokeResources(session: ConversationSession | null): Promise<void> {
  if (!session) {
    return;
  }

  const browserSessionIds = new Set<string>();
  for (const browserSession of session.browserSessions) {
    if (browserSession.status === "open") {
      browserSessionIds.add(browserSession.id);
    }
  }
  for (const browserSessionId of session.activeWorkspace?.browserSessionIds ?? []) {
    if (browserSessionId.trim().length > 0) {
      browserSessionIds.add(browserSessionId);
    }
  }

  if (browserSessionIds.size === 0) {
    return;
  }

  const { createBrainConfigFromEnv } = await import("../../src/core/config");
  const { BrowserSessionRegistry } = await import("../../src/organs/liveRun/browserSessionRegistry");
  const { ManagedProcessRegistry } = await import("../../src/organs/liveRun/managedProcessRegistry");
  const { ToolExecutorOrgan } = await import("../../src/organs/executor");

  const config = createBrainConfigFromEnv();
  const browserSessionRegistry = new BrowserSessionRegistry();
  const managedProcessRegistry = new ManagedProcessRegistry();
  const cleanupExecutor = new ToolExecutorOrgan(
    config,
    undefined,
    managedProcessRegistry,
    undefined,
    browserSessionRegistry
  );

  for (const browserSessionId of browserSessionIds) {
    await cleanupExecutor.executeWithOutcome({
      id: `cleanup:${browserSessionId}:close_browser`,
      type: "close_browser",
      description: `Close lingering handoff-smoke browser session ${browserSessionId}.`,
      params: {
        sessionId: browserSessionId
      },
      estimatedCostUsd: 0.01
    }).catch(() => undefined);
  }
}

export async function runAutonomousRuntimeAffordancesHandoffSmoke():
Promise<AutonomousRuntimeAffordancesHandoffArtifact> {
  ensureEnvLoaded();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await cleanupLingeringPlaywrightAutomationBrowsers().catch(() => undefined);
  await rm(SESSION_PATH, { force: true }).catch(() => undefined);
  await rm(`${SESSION_PATH}.lock`, { force: true }).catch(() => undefined);
  const deadlineAtMs = Date.now() + SMOKE_DEADLINE_MS;
  const envSnapshot = applyEnvOverrides({
    BRAIN_LIVE_RUN_RUNTIME_PATH: LIVE_RUN_RUNTIME_PATH,
    BRAIN_STATE_JSON_PATH: STATE_PATH,
    BRAIN_ENABLE_EMBEDDINGS: "false",
    BRAIN_ENABLE_DYNAMIC_PULSE: "false"
  });

  const localProbe = await probeLocalIntentModelFromEnv();
  if (
    localProbe.enabled &&
    localProbe.liveSmokeRequired &&
    !isLocalIntentModelRuntimeReady(localProbe)
  ) {
    throw new Error(
      `Local intent model is required for this smoke but not ready: provider=${localProbe.provider} ` +
      `model=${localProbe.model} reachable=${localProbe.reachable} modelPresent=${localProbe.modelPresent}`
    );
  }

  const targetFolderName = `drone-company-handoff-smoke-${Date.now()}`;
  const targetFolderPath = path.join(os.homedir(), "OneDrive", "Desktop", targetFolderName);
  const turn1Input =
    `hey I'd like to build a calm air-drone landing page, be creative, and go until you finish, ` +
    `do it on my desktop, create a folder called ${targetFolderName}, when you're done run it on a browser and leave it open for me`;
  const turn2Input = "When I get back later, what should I inspect first from the draft you left me?";
  const turn3Input = "Okay, leave the rest for later.";
  const turn4Input = "What did you get done while I was away?";
  const turn5Input =
    "Pick that back up and change the hero into a slider while keeping the same preview ready for review.";
  const turn6Input = "Close the landing page so we can work on something else.";

  const brain = buildDefaultBrain();
  const adapter = new TelegramAdapter(brain, {
    auth: {
      requiredToken: "shared-secret"
    },
    allowlist: {
      allowedUsernames: [USERNAME],
      allowedUserIds: [USER_ID],
      allowedChatIds: [CONVERSATION_ID]
    },
    rateLimit: {
      windowMs: 60_000,
      maxEventsPerWindow: 50
    },
    replay: {
      maxTrackedUpdateIds: 200
    }
  });
  const store = new InterfaceSessionStore(SESSION_PATH);
  const manager = new ConversationManager(
    store,
    {
      allowAutonomousViaInterface: true,
      ackDelayMs: 300,
      heartbeatIntervalMs: 5_000,
      maxConversationTurns: 50,
      maxContextTurnsForExecution: 12
    },
    {
      interpretConversationIntent: async (input, recentTurns, pulseRuleContext) =>
        adapter.interpretConversationIntent(input, recentTurns, pulseRuleContext),
      listManagedProcessSnapshots: async () => adapter.listManagedProcessSnapshots(),
      listBrowserSessionSnapshots: async () => adapter.listBrowserSessionSnapshots(),
      localIntentModelResolver: createLocalIntentModelResolverFromEnv(),
      listAvailableSkills: async () => [],
      describeRuntimeCapabilities: async () => CAPABILITY_SUMMARY_FIXTURE
    }
  );

  const conversationKey = buildConversationKey({
    provider: "telegram",
    conversationId: CONVERSATION_ID,
    userId: USER_ID,
    username: USERNAME,
    conversationVisibility: "private",
    receivedAt: new Date().toISOString()
  });
  const abortControllers = new Map<string, AbortController>();
  const turns: TurnCapture[] = [];
  let latestSession: ConversationSession | null = null;

  const runTurn = async (
    turn: number,
    userInput: string,
    receivedAt: string
  ): Promise<ConversationSession> => {
    const notifications: CapturedNotification[] = [];
    const notifier = createNotifierTransport(notifications);
    const executeTask = async (
      taskInput: string,
      taskReceivedAt: string
    ): Promise<ConversationExecutionResult> => {
      const autonomousGoal = parseAutonomousExecutionInput(taskInput);
      if (autonomousGoal) {
        return await runAutonomousTransportTask({
          conversationId: conversationKey,
          goal: autonomousGoal.goal,
          initialExecutionInput: autonomousGoal.initialExecutionInput,
          receivedAt: taskReceivedAt,
          notifier,
          abortControllers,
          runAutonomousTask: async (
            goal,
            startedAt,
            progressSender,
            signal,
            initialExecutionInput
          ) =>
            adapter.runAutonomousTask(
              goal,
              startedAt,
              progressSender,
              signal,
              initialExecutionInput
            )
        });
      }

      const runResult = await adapter.runTextTask(taskInput, taskReceivedAt);
      return {
        summary: selectUserFacingSummary(runResult, {
          showTechnicalSummary: false,
          showSafetyCodes: false
        }),
        taskRunResult: runResult
      };
    };

    console.log(`\n=== TURN ${turn} USER ===\n${userInput}\n`);
    const immediateReply = await manager.handleMessage(
      buildMessage(userInput, receivedAt),
      executeTask,
      notifier
    );
    console.log(`=== TURN ${turn} IMMEDIATE REPLY ===\n${immediateReply}`);
    const session = await waitForTurnCompletion(
      store,
      conversationKey,
      `turn_${turn}`,
      receivedAt,
      getRemainingSmokeBudget(deadlineAtMs, TURN_TIMEOUT_MS, `turn ${turn}`)
    );
    const sessionSnapshot = cloneSessionSnapshot(session);
    latestSession = sessionSnapshot;
    console.log(
      `=== TURN ${turn} SESSION SNAPSHOT ===\n${JSON.stringify(
        {
          runningJobId: sessionSnapshot.runningJobId,
          queuedJobs: sessionSnapshot.queuedJobs.length,
          progressState: sessionSnapshot.progressState,
          recentJobs: sessionSnapshot.recentJobs,
          activeClarification: sessionSnapshot.activeClarification,
          browserSessions: sessionSnapshot.browserSessions,
          activeWorkspace: sessionSnapshot.activeWorkspace,
          returnHandoff: sessionSnapshot.returnHandoff,
          modeContinuity: sessionSnapshot.modeContinuity
        },
        null,
        2
      )}`
    );
    turns.push({
      turn,
      receivedAt,
      user: userInput,
      immediateReply,
      notifications,
      sessionSnapshot
    });
    return sessionSnapshot;
  };

  try {
    await rm(targetFolderPath, { recursive: true, force: true }).catch(() => undefined);

    const turn1At = new Date().toISOString();
    const sessionAfterTurn1 = await runTurn(1, turn1Input, turn1At);
    const targetFolder = extractTargetFolder(sessionAfterTurn1);
    const previewUrl = extractPreviewUrl(sessionAfterTurn1);
    const initialBrowserSession =
      sessionAfterTurn1.browserSessions.find((entry) => entry.status === "open") ??
      sessionAfterTurn1.browserSessions[0] ??
      null;

    assert.ok(targetFolder, "Turn 1 did not record a target folder.");
    assert.ok(previewUrl, "Turn 1 did not record a preview URL.");
    assert.ok(sessionAfterTurn1.returnHandoff, "Turn 1 did not persist a durable handoff.");

    const turn2At = new Date(Date.now() + 5_000).toISOString();
    const sessionAfterTurn2 = await runTurn(2, turn2Input, turn2At);
    const turn2Reply = turns[turns.length - 1]?.immediateReply ?? extractLatestAssistantReply(sessionAfterTurn2);
    const turn2QueuedNoNewWork = findLatestJobSince(sessionAfterTurn2, turn2At) === null;

    const turn3At = new Date(Date.now() + 10_000).toISOString();
    const sessionAfterTurn3 = await runTurn(3, turn3Input, turn3At);
    const turn3Reply = turns[turns.length - 1]?.immediateReply ?? extractLatestAssistantReply(sessionAfterTurn3);

    const turn4At = new Date(Date.now() + 15_000).toISOString();
    const sessionAfterTurn4 = await runTurn(4, turn4Input, turn4At);
    const turn4Reply = turns[turns.length - 1]?.immediateReply ?? extractLatestAssistantReply(sessionAfterTurn4);
    const turn4QueuedNoNewWork = findLatestJobSince(sessionAfterTurn4, turn4At) === null;

    const turn5At = new Date(Date.now() + 20_000).toISOString();
    const sessionAfterTurn5 = await runTurn(5, turn5Input, turn5At);
    const latestResumeJob = findLatestJobSince(sessionAfterTurn5, turn5At);
    const resumedTargetFolder = extractTargetFolder(sessionAfterTurn5) ?? targetFolder;
    assert.ok(resumedTargetFolder, "Turn 5 lost the tracked workspace.");

    const indexPath = path.join(resumedTargetFolder, "index.html");
    const indexHtmlAfterTurn5 = await readFile(indexPath, "utf8");
    const sliderAppliedOnResume = /slider/i.test(indexHtmlAfterTurn5) || /carousel/i.test(indexHtmlAfterTurn5);

    const turn6At = new Date(Date.now() + 25_000).toISOString();
    const sessionAfterTurn6 = await runTurn(6, turn6Input, turn6At);
    const finalBrowserSession =
      sessionAfterTurn6.browserSessions.find((entry) => entry.id === initialBrowserSession?.id) ??
      sessionAfterTurn6.browserSessions[0] ??
      null;
    const browserClosed = finalBrowserSession?.status === "closed";

    const roughDraftReviewSurfaced =
      /start here:/i.test(turn2Reply) &&
      /review order:/i.test(turn2Reply) &&
      /after that:/i.test(turn2Reply) &&
      /preview:/i.test(turn2Reply) &&
      /changed paths:/i.test(turn2Reply);
    const pauseCheckpointSaved =
      /leave the rest for later/i.test(turn3Reply) &&
      /checkpoint ready/i.test(turn3Reply) &&
      sessionAfterTurn3.returnHandoff?.status === "waiting_for_user";
    const whileAwaySummarySurfaced =
      /while you were away/i.test(turn4Reply) &&
      /best first look:/i.test(turn4Reply) &&
      /preview:/i.test(turn4Reply);
    const resumeExecutionInput = latestResumeJob?.executionInput ?? null;
    const resumeContinuationUsed =
      resumeExecutionInput?.includes("Durable return-handoff continuation:") === true &&
      resumeExecutionInput.includes(resumedTargetFolder) &&
      /pick that back up/i.test(turn5Input);
    const resumeStayedOnSameWorkspace =
      sessionAfterTurn5.activeWorkspace?.rootPath === targetFolder &&
      sessionAfterTurn5.returnHandoff?.workspaceRootPath === targetFolder;
    const reviewableUserFacingCopy = [
      extractLatestAssistantReply(sessionAfterTurn1),
      turn2Reply,
      turn3Reply,
      turn4Reply,
      extractLatestAssistantReply(sessionAfterTurn5),
      extractLatestAssistantReply(sessionAfterTurn6)
    ].every(isReviewableReply);

    const artifact: AutonomousRuntimeAffordancesHandoffArtifact = {
      generatedAt: new Date().toISOString(),
      command: COMMAND_NAME,
      status:
        sessionAfterTurn1.modeContinuity?.activeMode === "autonomous" &&
        roughDraftReviewSurfaced &&
        pauseCheckpointSaved &&
        whileAwaySummarySurfaced &&
        turn2QueuedNoNewWork &&
        turn4QueuedNoNewWork &&
        resumeContinuationUsed &&
        resumeStayedOnSameWorkspace &&
        sliderAppliedOnResume &&
        browserClosed &&
        reviewableUserFacingCopy
          ? "PASS"
          : "FAIL",
      blockerReason: detectProviderBlockerReason(
        turns.flatMap((turn) => [
          turn.immediateReply,
          ...turn.notifications.map((notification) => notification.text),
          extractLatestAssistantReply(turn.sessionSnapshot)
        ])
      ),
      localIntentModel: {
        enabled: localProbe.enabled,
        required: localProbe.liveSmokeRequired,
        reachable: localProbe.reachable,
        modelPresent: localProbe.modelPresent,
        model: localProbe.model,
        provider: localProbe.provider,
        baseUrl: localProbe.baseUrl
      },
      targetFolder,
      previewUrl,
      browserSessionId: finalBrowserSession?.id ?? initialBrowserSession?.id ?? null,
      checks: {
        naturalAutonomousStart: sessionAfterTurn1.modeContinuity?.activeMode === "autonomous",
        roughDraftReviewWithoutNewWork: turn2QueuedNoNewWork,
        roughDraftReviewSurfaced,
        pauseCheckpointSaved,
        whileAwaySummaryWithoutNewWork: turn4QueuedNoNewWork,
        whileAwaySummarySurfaced,
        resumeContinuationUsed,
        resumeStayedOnSameWorkspace,
        sliderAppliedOnResume,
        browserClosed,
        reviewableUserFacingCopy
      },
      turns
    };

    if (artifact.blockerReason) {
      artifact.status = "BLOCKED";
    }

    await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}${os.EOL}`, "utf8");
    return artifact;
  } catch (error) {
    const blockerReason = detectBoundedHandoffBlockerReason(error);
    const artifact: AutonomousRuntimeAffordancesHandoffArtifact = {
      generatedAt: new Date().toISOString(),
      command: COMMAND_NAME,
      status: blockerReason ? "BLOCKED" : "FAIL",
      blockerReason,
      localIntentModel: {
        enabled: localProbe.enabled,
        required: localProbe.liveSmokeRequired,
        reachable: localProbe.reachable,
        modelPresent: localProbe.modelPresent,
        model: localProbe.model,
        provider: localProbe.provider,
        baseUrl: localProbe.baseUrl
      },
      targetFolder: latestSession ? extractTargetFolder(latestSession) : null,
      previewUrl: latestSession ? extractPreviewUrl(latestSession) : null,
      browserSessionId: latestSession?.browserSessions[0]?.id ?? null,
      checks: {
        naturalAutonomousStart: false,
        roughDraftReviewWithoutNewWork: false,
        roughDraftReviewSurfaced: false,
        pauseCheckpointSaved: false,
        whileAwaySummaryWithoutNewWork: false,
        whileAwaySummarySurfaced: false,
        resumeContinuationUsed: false,
        resumeStayedOnSameWorkspace: false,
        sliderAppliedOnResume: false,
        browserClosed: false,
        reviewableUserFacingCopy: turns.every((turn) =>
          [turn.immediateReply, ...turn.notifications.map((notification) => notification.text)].every(
            isReviewableReply
          )
        )
      },
      turns
    };
    await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}${os.EOL}`, "utf8");
    return artifact;
  } finally {
    await cleanupTrackedSmokeResources(latestSession).catch(() => undefined);
    await cleanupLingeringPlaywrightAutomationBrowsers().catch(() => undefined);
    await rm(targetFolderPath, { recursive: true, force: true }).catch(() => undefined);
    await rm(SESSION_PATH, { force: true }).catch(() => undefined);
    await rm(`${SESSION_PATH}.lock`, { force: true }).catch(() => undefined);
    await rm(LIVE_RUN_RUNTIME_PATH, { recursive: true, force: true }).catch(() => undefined);
    await rm(STATE_PATH, { force: true }).catch(() => undefined);
    await rm(`${STATE_PATH}.lock`, { force: true }).catch(() => undefined);
    restoreEnv(envSnapshot);
  }
}

async function main(): Promise<void> {
  const artifact = await runAutonomousRuntimeAffordancesHandoffSmoke();
  console.log(`Autonomous runtime affordances handoff smoke status: ${artifact.status}`);
  console.log(`Artifact: ${ARTIFACT_PATH}`);
  if (artifact.status === "FAIL") {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  void main()
    .then(() => {
      setImmediate(() => process.exit(process.exitCode ?? 0));
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exit(1);
    });
}
