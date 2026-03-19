/**
 * @fileoverview Runs a real conversation-manager smoke for the reusable Desktop React preview
 * workflow: reuse `AI Drone City`, start a localhost preview server, open it in the browser, keep
 * it open through a normal chat turn, then close both the browser and linked preview process.
 */

import assert from "node:assert/strict";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
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

interface AiDroneCityPreviewLifecycleArtifact {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL" | "BLOCKED";
  blockerReason: string | null;
  localIntentModel: LocalIntentProof;
  checks: {
    targetFolderPresent: boolean;
    packageJsonPresent: boolean;
    nodeModulesPresent: boolean;
    distIndexPresent: boolean;
    browserOpened: boolean;
    localhostPreviewUrl: boolean;
    previewReadyAfterOpen: boolean;
    previewLeaseTracked: boolean;
    previewProcessRunningAfterOpen: boolean;
    duplicateFolderCountStable: boolean;
    conversationStayedConversational: boolean;
    browserRemainedOpenDuringConversation: boolean;
    previewProcessStillRunningDuringConversation: boolean;
    browserClosed: boolean;
    previewStopped: boolean;
  };
  targetFolderPath: string;
  previewUrl: string | null;
  browserSessionId: string | null;
  previewProcessLeaseId: string | null;
  existingVariantNamesBefore: readonly string[];
  existingVariantNamesAfterOpen: readonly string[];
  reusedExistingWorkspace: boolean;
  turns: readonly TurnCapture[];
}

const RUN_ID = `${Date.now()}`;
const COMMAND_NAME = "tsx scripts/evidence/aiDroneCityReactPreviewLifecycleLiveSmoke.ts";
const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/ai_drone_city_react_preview_lifecycle_live_smoke_report.json"
);
const SESSION_PATH = path.resolve(
  process.cwd(),
  `runtime/ai-drone-city-react-preview-lifecycle-smoke-sessions-${RUN_ID}.json`
);
const STATE_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-ai-drone-city-react-preview-lifecycle-state-${RUN_ID}.json`
);
const LEDGER_SQLITE_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-ai-drone-city-react-preview-lifecycle-ledgers-${RUN_ID}.sqlite`
);
const LIVE_RUN_RUNTIME_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-ai-drone-city-react-preview-lifecycle-live-run-${RUN_ID}`
);
const CONVERSATION_ID = `ai-drone-city-react-preview-lifecycle-smoke-${RUN_ID}`;
const USER_ID = "ai-drone-city-preview-smoke-user";
const USERNAME = "anthonybenny";
const FOLDER_NAME = "AI Drone City";
const TURN_TIMEOUT_MS = Number.isFinite(Number(process.env.AI_DRONE_CITY_PREVIEW_SMOKE_TURN_TIMEOUT_MS))
  ? Math.max(60_000, Number(process.env.AI_DRONE_CITY_PREVIEW_SMOKE_TURN_TIMEOUT_MS))
  : 300_000;
const CONVERSATION_TIMEOUT_MS = 30_000;
const SMOKE_DEADLINE_MS = 420_000;
const CLEANUP_STEP_TIMEOUT_MS = 3_000;
const DIRECT_REPLY_SETTLE_MS = 2_000;
const KEEP_TEMP_ARTIFACTS =
  process.env.AI_DRONE_CITY_PREVIEW_SMOKE_KEEP_TMP?.trim().toLowerCase() === "true";
const PROVIDER_BLOCK_PATTERN =
  /(?:429|exceeded your current quota|rate limit|fetch failed|request timed out|socket hang up|ECONNRESET|effective backend is mock|missing OPENAI_API_KEY)/i;

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

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve a numeric loopback port.")));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
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

function isLoopbackHttpPreviewUrl(url: string | null): boolean {
  if (!url) {
    return false;
  }
  try {
    const parsedUrl = new URL(url);
    return (
      (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") &&
      (parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost" || parsedUrl.hostname === "::1")
    );
  } catch {
    return false;
  }
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

function extractPreviewProcessLeaseId(session: ConversationSession | null): string | null {
  if (!session) {
    return null;
  }
  const openBrowserSession = session.browserSessions.find(
    (entry) =>
      typeof entry.linkedProcessLeaseId === "string" &&
      entry.linkedProcessLeaseId.trim().length > 0
  );
  if (openBrowserSession?.linkedProcessLeaseId) {
    return openBrowserSession.linkedProcessLeaseId;
  }
  return session.activeWorkspace?.previewProcessLeaseId ?? null;
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
  if (!isLoopbackHttpPreviewUrl(url)) {
    return false;
  }
  try {
    const response = await fetchWithTimeout(url!, 5_000);
    return response.ok;
  } catch {
    return false;
  }
}

async function isPreviewProcessRunning(
  adapter: TelegramAdapter,
  leaseId: string | null
): Promise<boolean> {
  if (!leaseId) {
    return false;
  }
  const snapshots = await adapter.listManagedProcessSnapshots();
  const snapshot = snapshots.find((entry) => entry.leaseId === leaseId) ?? null;
  return snapshot !== null && snapshot.statusCode !== "PROCESS_STOPPED";
}

async function isPreviewProcessStopped(
  adapter: TelegramAdapter,
  leaseId: string | null
): Promise<boolean> {
  if (!leaseId) {
    return false;
  }
  const snapshots = await adapter.listManagedProcessSnapshots();
  const snapshot = snapshots.find((entry) => entry.leaseId === leaseId) ?? null;
  return snapshot !== null && snapshot.statusCode === "PROCESS_STOPPED";
}

async function countRunningWorkspacePreviewProcesses(
  adapter: TelegramAdapter,
  workspaceRootPath: string
): Promise<number> {
  const normalizedWorkspaceRoot = path.normalize(workspaceRootPath).toLowerCase();
  const snapshots = await adapter.listManagedProcessSnapshots();
  return snapshots.filter((snapshot) => {
    const normalizedCwd = path.normalize(snapshot.cwd).toLowerCase();
    return (
      normalizedCwd === normalizedWorkspaceRoot &&
      snapshot.statusCode !== "PROCESS_STOPPED"
    );
  }).length;
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
  const previewProcessLeaseId = extractPreviewProcessLeaseId(session);
  if (!browserSessionId && !previewProcessLeaseId) {
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
  if (browserSessionId) {
    await awaitCleanup(cleanupExecutor.executeWithOutcome({
      id: `cleanup:${browserSessionId}:close_browser`,
      type: "close_browser",
      description: `Close lingering AI Drone City preview browser session ${browserSessionId}.`,
      params: {
        sessionId: browserSessionId
      },
      estimatedCostUsd: 0.01
    }));
  }
  if (previewProcessLeaseId) {
    await awaitCleanup(cleanupExecutor.executeWithOutcome({
      id: `cleanup:${previewProcessLeaseId}:stop_process`,
      type: "stop_process",
      description: `Stop lingering AI Drone City preview process ${previewProcessLeaseId}.`,
      params: {
        leaseId: previewProcessLeaseId
      },
      estimatedCostUsd: 0.01
    }));
  }
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
  const nodeModulesPath = path.join(targetFolderPath, "node_modules");
  const existingWorkspacePresent = await pathExists(packageJsonPath);
  const existingWorkspaceReady =
    existingWorkspacePresent &&
    (await isDirectory(nodeModulesPath)) &&
    (await pathExists(distIndexPath));
  const previewPort = await reserveLoopbackPort();
  const expectedPreviewBaseUrl = `http://127.0.0.1:${previewPort}`;
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

    const openTurnInput = existingWorkspaceReady
      ? `Handle this end to end: reuse the existing ${FOLDER_NAME} React workspace on my desktop. ` +
        `Start its local preview server from that workspace on the exact loopback URL ${expectedPreviewBaseUrl}/, open that running localhost preview in the browser for me, and leave it open. ` +
        `Do not recreate the project or reinstall packages if ${FOLDER_NAME}\\package.json, ${FOLDER_NAME}\\node_modules, and ${FOLDER_NAME}\\dist\\index.html are already present. ` +
        `Only repair what is missing. Use host 127.0.0.1 and port ${previewPort}. Do not open dist/index.html directly when a real localhost preview server can be started.`
      : `Handle this end to end: build or repair the ${FOLDER_NAME} React workspace on my desktop, then start its local preview server on ${expectedPreviewBaseUrl}/, open that localhost preview in the browser, and leave it open for me. Use host 127.0.0.1 and port ${previewPort}.`;
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
        runDirectConversationTurn: async (input, receivedAt, session) =>
          adapter.runDirectConversationTurn(input, receivedAt, session),
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
    const previewProcessLeaseId = extractPreviewProcessLeaseId(sessionAfterTurn1);
    const variantNamesAfterOpen = await listTargetVariantNames(desktopPath, FOLDER_NAME);
    const openBrowserSession =
      sessionAfterTurn1.browserSessions.find((entry) => entry.status === "open") ?? null;
    const previewReadyAfterOpen = await isPreviewReady(previewUrl);
    const previewProcessRunningAfterOpen = await isPreviewProcessRunning(
      adapter,
      previewProcessLeaseId
    );
    const runningWorkspacePreviewProcessCountAfterOpen =
      await countRunningWorkspacePreviewProcesses(adapter, targetFolderPath);
    assert.equal(extractTargetFolder(sessionAfterTurn1), targetFolderPath);
    assert.ok(await isDirectory(targetFolderPath), "AI Drone City target folder is missing.");
    assert.ok(
      await pathExists(packageJsonPath),
      "AI Drone City package.json is missing."
    );
    assert.ok(await isDirectory(nodeModulesPath), "AI Drone City node_modules is missing.");
    assert.ok(await pathExists(distIndexPath), "AI Drone City dist/index.html is missing.");
    assert.ok(isLoopbackHttpPreviewUrl(previewUrl), "Turn 1 did not record a localhost preview URL.");
    assert.ok(
      previewUrl?.startsWith(expectedPreviewBaseUrl),
      `Turn 1 did not use the requested preview URL ${expectedPreviewBaseUrl}/.`
    );
    assert.ok(browserSessionId, "Turn 1 did not leave a tracked browser session open.");
    assert.ok(openBrowserSession, "Turn 1 did not leave an open browser session.");
    assert.ok(previewProcessLeaseId, "Turn 1 did not leave a linked preview-process lease.");
    assert.ok(previewReadyAfterOpen, "Turn 1 preview is not ready.");
    assert.ok(previewProcessRunningAfterOpen, "Turn 1 preview process is not still running.");
    assert.ok(
      runningWorkspacePreviewProcessCountAfterOpen >= 1,
      "Turn 1 did not leave any AI Drone City preview process running."
    );
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
    const previewProcessStillRunningDuringConversation = await isPreviewProcessRunning(
      adapter,
      previewProcessLeaseId
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
    assert.equal(
      previewProcessStillRunningDuringConversation,
      true,
      "AI Drone City preview process did not remain running during conversation."
    );
    assert.equal(
      await isPreviewReady(previewUrl),
      true,
      "AI Drone City localhost preview stopped responding during conversation."
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
    const previewStopped = !(await isPreviewReady(previewUrl));
    const previewProcessStopped = await isPreviewProcessStopped(adapter, previewProcessLeaseId);
    const runningWorkspacePreviewProcessCountAfterClose =
      await countRunningWorkspacePreviewProcesses(adapter, targetFolderPath);
    const artifact: AiDroneCityPreviewLifecycleArtifact = {
      generatedAt: new Date().toISOString(),
      command: COMMAND_NAME,
      status:
        trackedBrowserAfterClose?.status === "closed" &&
        previewStopped &&
        previewProcessStopped &&
        runningWorkspacePreviewProcessCountAfterClose === 0
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
        nodeModulesPresent: await isDirectory(nodeModulesPath),
        distIndexPresent: await pathExists(distIndexPath),
        browserOpened: Boolean(browserSessionId),
        localhostPreviewUrl: isLoopbackHttpPreviewUrl(previewUrl),
        previewReadyAfterOpen,
        previewLeaseTracked: Boolean(previewProcessLeaseId),
        previewProcessRunningAfterOpen,
        duplicateFolderCountStable: variantNamesAfterOpen.length <= Math.max(variantNamesBefore.length, 1),
        conversationStayedConversational: /\n\n/.test(conversationReply),
        browserRemainedOpenDuringConversation: browserDuringConversation?.status === "open",
        previewProcessStillRunningDuringConversation,
        browserClosed: trackedBrowserAfterClose?.status === "closed",
        previewStopped:
          previewStopped &&
          previewProcessStopped &&
          runningWorkspacePreviewProcessCountAfterClose === 0
      },
      targetFolderPath,
      previewUrl,
      browserSessionId,
      previewProcessLeaseId,
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
        "AI Drone City React preview lifecycle smoke failed. " +
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
    const artifact: AiDroneCityPreviewLifecycleArtifact = {
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
        nodeModulesPresent: await isDirectory(nodeModulesPath),
        distIndexPresent: await pathExists(distIndexPath),
        browserOpened: Boolean(extractTrackedBrowserSessionId(latestSession)),
        localhostPreviewUrl: isLoopbackHttpPreviewUrl(extractPreviewUrl(latestSession)),
        previewReadyAfterOpen: await isPreviewReady(extractPreviewUrl(latestSession)),
        previewLeaseTracked: Boolean(extractPreviewProcessLeaseId(latestSession)),
        previewProcessRunningAfterOpen: false,
        duplicateFolderCountStable: variantNamesAfterOpen.length <= Math.max(variantNamesBefore.length, 1),
        conversationStayedConversational: false,
        browserRemainedOpenDuringConversation: false,
        previewProcessStillRunningDuringConversation: false,
        browserClosed: latestSession?.browserSessions.every((entry) => entry.status === "closed") ?? false,
        previewStopped: false
      },
      targetFolderPath,
      previewUrl: extractPreviewUrl(latestSession),
      browserSessionId: extractTrackedBrowserSessionId(latestSession),
      previewProcessLeaseId: extractPreviewProcessLeaseId(latestSession),
      existingVariantNamesBefore: variantNamesBefore,
      existingVariantNamesAfterOpen: variantNamesAfterOpen,
      reusedExistingWorkspace: existingWorkspacePresent,
      turns: []
    };
    await writeFile(ARTIFACT_PATH, JSON.stringify(artifact, null, 2) + os.EOL, "utf8");
    throw error;
  } finally {
    await cleanupTrackedSmokeResources(latestSession).catch(() => undefined);
    await cleanupLingeringPlaywrightAutomationBrowsers().catch(() => undefined);
    if (smokeModelSnapshot) {
      restoreEnv(smokeModelSnapshot);
    }
    if (!KEEP_TEMP_ARTIFACTS) {
      await rm(LIVE_RUN_RUNTIME_PATH, { recursive: true, force: true }).catch(() => undefined);
      await rm(STATE_PATH, { force: true }).catch(() => undefined);
      await rm(`${STATE_PATH}.lock`, { force: true }).catch(() => undefined);
      await rm(LEDGER_SQLITE_PATH, { force: true }).catch(() => undefined);
      await rm(`${LEDGER_SQLITE_PATH}-shm`, { force: true }).catch(() => undefined);
      await rm(`${LEDGER_SQLITE_PATH}-wal`, { force: true }).catch(() => undefined);
    }
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
