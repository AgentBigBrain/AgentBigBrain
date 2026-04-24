/**
 * @fileoverview Runs a real conversation-manager smoke for the reusable Desktop React app
 * workflow: create or reuse `AI Drone City`, open it in the browser, keep it open through a
 * normal chat turn, then close it and prove the lifecycle truthfully.
 */

import assert from "node:assert/strict";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildDefaultBrain } from "../../src/core/buildBrain";
import { createBrainConfigFromEnv } from "../../src/core/config";
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
import type { ConversationSession } from "../../src/interfaces/conversationRuntime/sessionStateContracts";
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
import { buildSmokeModelEnvOverrides } from "./smokeModelEnv";

interface CapturedNotification {
  phase: "send" | "edit";
  messageId: string;
  text: string;
  at: string;
}

interface TurnCapture {
  turn: number;
  user: string;
  immediateReply: string;
  notifications: readonly CapturedNotification[];
  sessionSnapshot: ConversationSession;
}

interface EnvSnapshot {
  [key: string]: string | undefined;
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

interface AiDroneCityLifecycleArtifact {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL" | "BLOCKED";
  blockerReason: string | null;
  localIntentModel: LocalIntentProof;
  checks: {
    targetFolderPresent: boolean;
    packageJsonPresent: boolean;
    browserOpened: boolean;
    previewReadyAfterOpen: boolean;
    duplicateFolderCountStable: boolean;
    conversationStayedConversational: boolean;
    browserRemainedOpenDuringConversation: boolean;
    browserClosed: boolean;
    previewStoppedIfNeeded: boolean;
  };
  targetFolderPath: string;
  previewUrl: string | null;
  browserSessionId: string | null;
  existingVariantNamesBefore: readonly string[];
  existingVariantNamesAfterOpen: readonly string[];
  reusedExistingWorkspace: boolean;
  turns: readonly TurnCapture[];
}

const RUN_ID = `${Date.now()}`;
const COMMAND_NAME = "tsx scripts/evidence/aiDroneCityReactLifecycleLiveSmoke.ts";
const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/ai_drone_city_react_lifecycle_live_smoke_report.json"
);
const SESSION_PATH = path.resolve(
  process.cwd(),
  `runtime/ai-drone-city-react-lifecycle-smoke-sessions-${RUN_ID}.json`
);
const STATE_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-ai-drone-city-react-lifecycle-state-${RUN_ID}.json`
);
const LEDGER_SQLITE_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-ai-drone-city-react-lifecycle-ledgers-${RUN_ID}.sqlite`
);
const LIVE_RUN_RUNTIME_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-ai-drone-city-react-lifecycle-live-run-${RUN_ID}`
);
const CONVERSATION_ID = `ai-drone-city-react-lifecycle-smoke-${RUN_ID}`;
const USER_ID = "ai-drone-city-smoke-user";
const USERNAME = "fixtureuser";
const FOLDER_NAME = "AI Drone City";
const TURN_TIMEOUT_MS = 180_000;
const CONVERSATION_TIMEOUT_MS = 30_000;
const SMOKE_DEADLINE_MS = 360_000;
const CLEANUP_STEP_TIMEOUT_MS = 3_000;
const DIRECT_REPLY_SETTLE_MS = 2_000;
const PROVIDER_BLOCK_PATTERN =
/(?:429|exceeded your current quota|usage limit|purchase more credits|try again at|rate limit|fetch failed|request timed out|socket hang up|ECONNRESET|effective backend is mock|missing OPENAI_API_KEY)/i;

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: abortController.signal
    });
  } finally {
    clearTimeout(timeout);
  }
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
  timeoutMs = TURN_TIMEOUT_MS,
  allowDirectReplyCompletion = false
): Promise<ConversationSession> {
  const startedAt = Date.now();
  let observedExecution = false;

  while (Date.now() - startedAt < timeoutMs) {
    const session = await store.getSession(conversationKey);
    if (session) {
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
        hasFreshClarification
      ) {
        observedExecution = true;
      }
      const hasCompletedFreshJob = matchingJobs.some((job) => job.status !== "running");
      if (
        allowDirectReplyCompletion &&
        !observedExecution &&
        hasFreshAssistantTurn &&
        Date.now() - startedAt >= DIRECT_REPLY_SETTLE_MS
      ) {
        return session;
      }
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

async function awaitCleanup(operation: Promise<unknown>): Promise<void> {
  await Promise.race([
    operation.then(() => undefined).catch(() => undefined),
    sleep(CLEANUP_STEP_TIMEOUT_MS)
  ]);
}

async function pathExists(candidatePath: string): Promise<boolean> {
  return (await stat(candidatePath).catch(() => null)) !== null;
}

async function isDirectory(candidatePath: string): Promise<boolean> {
  const details = await stat(candidatePath).catch(() => null);
  return details?.isDirectory() === true;
}

async function resolveDesktopPath(): Promise<string> {
  const oneDriveDesktop = path.join(os.homedir(), "OneDrive", "Desktop");
  if (await isDirectory(oneDriveDesktop)) {
    return oneDriveDesktop;
  }
  return path.join(os.homedir(), "Desktop");
}

async function listTargetVariantNames(
  desktopPath: string,
  folderName: string
): Promise<string[]> {
  const entries = await readdir(desktopPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(folderName))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function extractPreviewUrl(session: ConversationSession | null): string | null {
  if (!session) {
    return null;
  }
  if (session.activeWorkspace?.previewUrl) {
    return session.activeWorkspace.previewUrl;
  }
  const openBrowser = session.browserSessions.find((entry) => entry.status === "open");
  if (openBrowser) {
    return openBrowser.url;
  }
  return null;
}

function normalizeTargetFolderCandidate(candidatePath: string): string {
  const trimmedPath = candidatePath.trim();
  if (trimmedPath.length === 0) {
    return trimmedPath;
  }
  return path.basename(trimmedPath).toLowerCase() === "dist"
    ? path.dirname(trimmedPath)
    : trimmedPath;
}

function extractTargetFolder(session: ConversationSession | null): string | null {
  if (!session) {
    return null;
  }
  if (session.activeWorkspace?.rootPath) {
    return normalizeTargetFolderCandidate(session.activeWorkspace.rootPath);
  }
  if (session.activeWorkspace?.primaryArtifactPath) {
    return normalizeTargetFolderCandidate(
      path.dirname(session.activeWorkspace.primaryArtifactPath)
    );
  }
  const browserWorkspacePath = session.browserSessions.find(
    (entry) => typeof entry.workspaceRootPath === "string" && entry.workspaceRootPath.trim().length > 0
  )?.workspaceRootPath;
  if (browserWorkspacePath) {
    return normalizeTargetFolderCandidate(browserWorkspacePath);
  }
  const previewUrl = extractPreviewUrl(session);
  if (previewUrl?.startsWith("file://")) {
    try {
      return normalizeTargetFolderCandidate(path.dirname(fileURLToPath(previewUrl)));
    } catch {
      return null;
    }
  }
  return null;
}

function extractTrackedBrowserSessionId(session: ConversationSession | null): string | null {
  if (!session) {
    return null;
  }
  const openBrowserSession = session.browserSessions.find((entry) => entry.status === "open");
  if (openBrowserSession) {
    return openBrowserSession.id;
  }
  return session.activeWorkspace?.browserSessionId ?? null;
}

function extractLatestUserVisibleReply(notifications: readonly CapturedNotification[]): string | null {
  for (const notification of [...notifications].reverse()) {
    const text = notification.text.trim();
    if (!text || /^Status:/i.test(text)) {
      continue;
    }
    return text;
  }
  return null;
}

async function isPreviewReady(url: string | null): Promise<boolean> {
  if (!url) {
    return false;
  }
  if (url.startsWith("file://")) {
    try {
      return await pathExists(fileURLToPath(url));
    } catch {
      return false;
    }
  }
  try {
    const response = await fetchWithTimeout(url, 5_000);
    return response.ok;
  } catch {
    return false;
  }
}

async function isPreviewStoppedIfNeeded(url: string | null): Promise<boolean> {
  if (!url || url.startsWith("file://")) {
    return true;
  }
  return !(await isPreviewReady(url));
}

function findProviderBlockerReason(
  session: ConversationSession | null,
  createdAtFloor?: string
): string | null {
  if (!session) {
    return null;
  }
  const blockedJob = [...session.recentJobs]
    .reverse()
    .find(
      (job) =>
        (!createdAtFloor || job.createdAt >= createdAtFloor) &&
        (
          (job.status === "failed" && typeof job.errorMessage === "string") ||
          typeof job.resultSummary === "string"
        ) &&
        PROVIDER_BLOCK_PATTERN.test(
          [job.errorMessage ?? "", job.resultSummary ?? ""].join("\n")
        )
    );
  if (blockedJob) {
    return [blockedJob.errorMessage ?? "", blockedJob.resultSummary ?? ""]
      .filter((value) => value.trim().length > 0)
      .join("\n");
  }
  const assistantTurn = [...session.conversationTurns]
    .reverse()
    .find(
      (turn) =>
        turn.role === "assistant" &&
        (!createdAtFloor || turn.at >= createdAtFloor) &&
        PROVIDER_BLOCK_PATTERN.test(turn.text)
    );
  return assistantTurn?.text ?? null;
}

async function cleanupTrackedSmokeResources(session: ConversationSession | null): Promise<void> {
  const browserSessionId = extractTrackedBrowserSessionId(session);
  if (!browserSessionId) {
    return;
  }
  const config = createBrainConfigFromEnv();
  const browserSessionRegistry = new (await import("../../src/organs/liveRun/browserSessionRegistry")).BrowserSessionRegistry();
  const managedProcessRegistry = new (await import("../../src/organs/liveRun/managedProcessRegistry")).ManagedProcessRegistry();
  const cleanupExecutor = new (await import("../../src/organs/executor")).ToolExecutorOrgan(
    config,
    undefined,
    managedProcessRegistry,
    undefined,
    browserSessionRegistry
  );
  await awaitCleanup(cleanupExecutor.executeWithOutcome({
    id: `cleanup:${browserSessionId}:close_browser`,
    type: "close_browser",
    description: `Close lingering AI Drone City smoke browser session ${browserSessionId}.`,
    params: {
      sessionId: browserSessionId
    },
    estimatedCostUsd: 0.01
  }));
}

async function main(): Promise<void> {
  ensureEnvLoaded();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await cleanupLingeringPlaywrightAutomationBrowsers().catch(() => undefined);
  await rm(SESSION_PATH, { force: true });
  await rm(`${SESSION_PATH}.lock`, { force: true });

  const desktopPath = await resolveDesktopPath();
  const targetFolderPath = path.join(desktopPath, FOLDER_NAME);
  const variantNamesBefore = await listTargetVariantNames(desktopPath, FOLDER_NAME);
  const packageJsonPath = path.join(targetFolderPath, "package.json");
  const distIndexPath = path.join(targetFolderPath, "dist", "index.html");
  const existingWorkspacePresent = await pathExists(packageJsonPath);
  const existingWorkspaceReady =
    existingWorkspacePresent && (await pathExists(distIndexPath));
  const envSnapshot = applyEnvOverrides({
    BRAIN_LIVE_RUN_RUNTIME_PATH: LIVE_RUN_RUNTIME_PATH,
    BRAIN_STATE_JSON_PATH: STATE_PATH,
    BRAIN_LEDGER_SQLITE_PATH: LEDGER_SQLITE_PATH,
    BRAIN_LEDGER_EXPORT_JSON_ON_WRITE: "false",
    BRAIN_ENABLE_EMBEDDINGS: "false",
    BRAIN_ENABLE_DYNAMIC_PULSE: "false"
  });
  let smokeModelSnapshot: EnvSnapshot | null = null;
  let latestSession: ConversationSession | null = null;

  try {
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
    smokeModelSnapshot = applyEnvOverrides(buildSmokeModelEnvOverrides(localProbe).envOverrides);

    const openTurnGoal = existingWorkspaceReady
      ? `Handle this end to end: reuse the existing ${FOLDER_NAME} React workspace on my desktop and open the built app in the browser for me. ` +
        `Do not recreate or reinstall the project if ${FOLDER_NAME}\\package.json and ${FOLDER_NAME}\\dist\\index.html are already present. ` +
        "Only repair what is missing, then leave the app open for me."
      : `Handle this end to end: build a small React landing page in a folder called ${FOLDER_NAME} on my desktop, ` +
        `open it in the browser, and leave it open for me. Reuse the existing ${FOLDER_NAME} workspace ` +
        "if it is already there instead of recreating it.";
    const openTurnInput = openTurnGoal;
    const conversationTurnInput =
      `Looks good. Before changing anything, just talk with me for a minute about what makes ${FOLDER_NAME} feel playful. ` +
      "Reply in two short paragraphs and keep the page open.";
    const closeTurnInput =
      `Thanks. Please close ${FOLDER_NAME} and anything it needs so we can move on.`;

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
    const localIntentModelResolver = createLocalIntentModelResolverFromEnv();
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
        localIntentModelResolver,
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
    const allTurns: TurnCapture[] = [];
    const deadlineAtMs = Date.now() + SMOKE_DEADLINE_MS;

    const runTurn = async (
      turn: number,
      userInput: string,
      receivedAt: string,
      allowDirectReplyCompletion = false
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

      const immediateReply = await manager.handleMessage(
        buildMessage(userInput, receivedAt),
        executeTask,
        notifier
      );
      const session = await waitForTurnCompletion(
        store,
        conversationKey,
        `turn_${turn}`,
        receivedAt,
        getRemainingSmokeBudget(
          deadlineAtMs,
          allowDirectReplyCompletion ? CONVERSATION_TIMEOUT_MS : TURN_TIMEOUT_MS,
          `turn ${turn}`
        ),
        allowDirectReplyCompletion
      );
      latestSession = cloneSessionSnapshot(session);
      allTurns.push({
        turn,
        user: userInput,
        immediateReply,
        notifications,
        sessionSnapshot: latestSession
      });
      return latestSession;
    };

    const turn1At = new Date().toISOString();
    const sessionAfterTurn1 = await runTurn(1, openTurnInput, turn1At);
    const turn1ProviderBlocker = findProviderBlockerReason(sessionAfterTurn1, turn1At);
    if (turn1ProviderBlocker) {
      throw new Error(turn1ProviderBlocker);
    }
    const previewUrl = extractPreviewUrl(sessionAfterTurn1);
    const browserSessionId = extractTrackedBrowserSessionId(sessionAfterTurn1);
    const variantNamesAfterOpen = await listTargetVariantNames(desktopPath, FOLDER_NAME);
    const openBrowserSession =
      sessionAfterTurn1.browserSessions.find((entry) => entry.status === "open") ?? null;
    const previewReadyAfterOpen = await isPreviewReady(previewUrl);
    assert.equal(extractTargetFolder(sessionAfterTurn1), targetFolderPath);
    assert.ok(await isDirectory(targetFolderPath), "AI Drone City target folder is missing.");
    assert.ok(
      await pathExists(packageJsonPath),
      "AI Drone City package.json is missing."
    );
    assert.ok(previewUrl, "Turn 1 did not record a preview URL.");
    assert.ok(browserSessionId, "Turn 1 did not leave a tracked browser session open.");
    assert.ok(openBrowserSession, "Turn 1 did not leave an open browser session.");
    assert.ok(previewReadyAfterOpen, "Turn 1 preview is not ready.");
    assert.ok(
      variantNamesAfterOpen.length <= Math.max(variantNamesBefore.length, 1),
      `AI Drone City created duplicate Desktop folders: before=${variantNamesBefore.join(",")} after=${variantNamesAfterOpen.join(",")}`
    );

    const turn2At = new Date(Date.now() + 5_000).toISOString();
    const sessionAfterTurn2 = await runTurn(2, conversationTurnInput, turn2At, true);
    const turn2Capture = allTurns[allTurns.length - 1];
    const latestAssistantTurn = [...sessionAfterTurn2.conversationTurns]
      .reverse()
      .find((turn) => turn.role === "assistant");
    const conversationReply =
      extractLatestUserVisibleReply(turn2Capture?.notifications ?? []) ??
      latestAssistantTurn?.text ??
      "";
    const browserDuringConversation =
      sessionAfterTurn2.browserSessions.find((entry) => entry.id === browserSessionId) ??
      sessionAfterTurn2.browserSessions.find((entry) => entry.status === "open") ??
      null;
    const turn2FreshJobs = sessionAfterTurn2.recentJobs.filter(
      (job) => job.createdAt >= turn2At
    );
    assert.match(conversationReply, /\n\n/, "Turn 2 did not stay conversational.");
    assert.equal(
      sessionAfterTurn2.queuedJobs.length,
      0,
      "Turn 2 unexpectedly left queued work behind."
    );
    assert.equal(
      sessionAfterTurn2.runningJobId,
      null,
      "Turn 2 unexpectedly left work running."
    );
    assert.equal(
      turn2FreshJobs.some((job) => job.executionInput.startsWith("[AUTONOMOUS_LOOP_GOAL]")),
      false,
      "Turn 2 unexpectedly restarted autonomous execution."
    );
    assert.equal(
      browserDuringConversation?.status,
      "open",
      "AI Drone City browser did not remain open during conversation."
    );

    const turn3At = new Date(Date.now() + 10_000).toISOString();
    const sessionAfterTurn3 = await runTurn(3, closeTurnInput, turn3At);
    const turn3ProviderBlocker = findProviderBlockerReason(sessionAfterTurn3, turn3At);
    if (turn3ProviderBlocker) {
      throw new Error(turn3ProviderBlocker);
    }
    const trackedBrowserAfterClose =
      sessionAfterTurn3.browserSessions.find((entry) => entry.id === browserSessionId) ??
      sessionAfterTurn3.browserSessions[0] ??
      null;
    const artifact: AiDroneCityLifecycleArtifact = {
      generatedAt: new Date().toISOString(),
      command: COMMAND_NAME,
      status:
        trackedBrowserAfterClose?.status === "closed" &&
        (await isPreviewStoppedIfNeeded(previewUrl))
          ? "PASS"
          : "FAIL",
      blockerReason: null,
      localIntentModel: {
        enabled: localProbe.enabled,
        required: localProbe.liveSmokeRequired,
        reachable: localProbe.reachable,
        modelPresent: localProbe.modelPresent,
        model: localProbe.model,
        provider: localProbe.provider,
        baseUrl: localProbe.baseUrl
      },
      checks: {
        targetFolderPresent: await isDirectory(targetFolderPath),
        packageJsonPresent: await pathExists(path.join(targetFolderPath, "package.json")),
        browserOpened: Boolean(browserSessionId),
        previewReadyAfterOpen,
        duplicateFolderCountStable: variantNamesAfterOpen.length <= Math.max(variantNamesBefore.length, 1),
        conversationStayedConversational: /\n\n/.test(conversationReply),
        browserRemainedOpenDuringConversation: browserDuringConversation?.status === "open",
        browserClosed: trackedBrowserAfterClose?.status === "closed",
        previewStoppedIfNeeded: await isPreviewStoppedIfNeeded(previewUrl)
      },
      targetFolderPath,
      previewUrl,
      browserSessionId,
      existingVariantNamesBefore: variantNamesBefore,
      existingVariantNamesAfterOpen: variantNamesAfterOpen,
      reusedExistingWorkspace: existingWorkspacePresent,
      turns: allTurns
    };

    await writeFile(ARTIFACT_PATH, JSON.stringify(artifact, null, 2) + os.EOL, "utf8");
    await cleanupTrackedSmokeResources(latestSession).catch(() => undefined);
    await cleanupLingeringPlaywrightAutomationBrowsers().catch(() => undefined);

    if (artifact.status !== "PASS") {
      throw new Error(
        "AI Drone City React lifecycle smoke failed. " +
        JSON.stringify(artifact.checks)
      );
    }
  } catch (error) {
    const localProbe = await probeLocalIntentModelFromEnv().catch(() => ({
      enabled: false,
      liveSmokeRequired: false,
      reachable: false,
      modelPresent: false,
      model: "unknown",
      provider: "unknown",
      baseUrl: "unknown"
    }));
    const variantNamesAfterOpen = await listTargetVariantNames(desktopPath, FOLDER_NAME).catch(() => []);
    const artifact: AiDroneCityLifecycleArtifact = {
      generatedAt: new Date().toISOString(),
      command: COMMAND_NAME,
      status: PROVIDER_BLOCK_PATTERN.test(String(error)) ? "BLOCKED" : "FAIL",
      blockerReason: error instanceof Error ? error.message : String(error),
      localIntentModel: {
        enabled: localProbe.enabled,
        required: localProbe.liveSmokeRequired,
        reachable: localProbe.reachable,
        modelPresent: localProbe.modelPresent,
        model: localProbe.model,
        provider: localProbe.provider,
        baseUrl: localProbe.baseUrl
      },
      checks: {
        targetFolderPresent: await isDirectory(targetFolderPath),
        packageJsonPresent: await pathExists(path.join(targetFolderPath, "package.json")),
        browserOpened: Boolean(extractTrackedBrowserSessionId(latestSession)),
        previewReadyAfterOpen: await isPreviewReady(extractPreviewUrl(latestSession)),
        duplicateFolderCountStable: variantNamesAfterOpen.length <= Math.max(variantNamesBefore.length, 1),
        conversationStayedConversational: false,
        browserRemainedOpenDuringConversation: false,
        browserClosed: latestSession?.browserSessions.every((entry) => entry.status === "closed") ?? false,
        previewStoppedIfNeeded: await isPreviewStoppedIfNeeded(extractPreviewUrl(latestSession))
      },
      targetFolderPath,
      previewUrl: extractPreviewUrl(latestSession),
      browserSessionId: extractTrackedBrowserSessionId(latestSession),
      existingVariantNamesBefore: variantNamesBefore,
      existingVariantNamesAfterOpen: variantNamesAfterOpen,
      reusedExistingWorkspace: existingWorkspacePresent,
      turns: []
    };
    await writeFile(ARTIFACT_PATH, JSON.stringify(artifact, null, 2) + os.EOL, "utf8");
    throw error;
  } finally {
    if (smokeModelSnapshot) {
      restoreEnv(smokeModelSnapshot);
    }
    await rm(LIVE_RUN_RUNTIME_PATH, { recursive: true, force: true }).catch(() => undefined);
    await rm(STATE_PATH, { force: true }).catch(() => undefined);
    await rm(`${STATE_PATH}.lock`, { force: true }).catch(() => undefined);
    await rm(LEDGER_SQLITE_PATH, { force: true }).catch(() => undefined);
    await rm(`${LEDGER_SQLITE_PATH}-shm`, { force: true }).catch(() => undefined);
    await rm(`${LEDGER_SQLITE_PATH}-wal`, { force: true }).catch(() => undefined);
    restoreEnv(envSnapshot);
  }
}

if (require.main === module) {
  void main()
    .then(() => {
      setImmediate(() => process.exit(process.exitCode ?? 0));
    })
    .catch((error) => {
      console.error(error);
      setImmediate(() => {
        process.exitCode = 1;
        process.exit(1);
      });
    });
}
