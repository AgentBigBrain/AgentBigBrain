/**
 * @fileoverview Runs a real conversation-manager smoke for a fresh Desktop React preview
 * workflow: create a new React landing-page workspace, start a localhost preview server, open it
 * in the browser, keep it open through a normal chat turn, then close both the browser and linked
 * preview process.
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
const USERNAME = "averybrooks11";
const FOLDER_NAME = `Drone React Preview Smoke ${RUN_ID}`;
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
  /(?:429|exceeded your current quota|usage limit|purchase more credits|try again at|rate limit|fetch failed|request timed out|socket hang up|ECONNRESET|effective backend is mock|missing OPENAI_API_KEY|provider or runtime step timed out)/i;
const BOUNDED_RUNTIME_BLOCK_PATTERN =
  /(?:\bEXECUTABLE_NOT_FOUND\b|\bCOMMAND_TOO_LONG\b|\bDEPENDENCY_MISSING\b|\bVERSION_INCOMPATIBLE\b|\bPROCESS_NOT_READY\b|\bTARGET_NOT_RUNNING\b|unable to resolve pwsh or powershell executable|Deterministic recovery stopped for (?:EXECUTABLE_NOT_FOUND|COMMAND_TOO_LONG|DEPENDENCY_MISSING|VERSION_INCOMPATIBLE|PROCESS_NOT_READY|TARGET_NOT_RUNNING)|Timed out waiting for turn_\d+ to complete|(?:Turn \d+ )?React preview smoke dist\/index\.html is missing|Landing page build proof missing: dist\/index\.html)/i;

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

function findBoundedRuntimeBlockerReason(
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
        BOUNDED_RUNTIME_BLOCK_PATTERN.test(
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
        BOUNDED_RUNTIME_BLOCK_PATTERN.test(turn.text)
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
      description: `Close lingering React preview browser session ${browserSessionId}.`,
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
      description: `Stop lingering React preview process ${previewProcessLeaseId}.`,
      params: {
        leaseId: previewProcessLeaseId
      },
      estimatedCostUsd: 0.01
    }));
  }
}

export async function runAiDroneCityReactPreviewLifecycleLiveSmoke():
Promise<AiDroneCityPreviewLifecycleArtifact> {
  ensureEnvLoaded();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await cleanupLingeringPlaywrightAutomationBrowsers().catch(() => undefined);
  await rm(SESSION_PATH, { force: true });
  await rm(`${SESSION_PATH}.lock`, { force: true });

  const desktopPath = await resolveDesktopPath();
  const targetFolderPath = path.join(desktopPath, FOLDER_NAME);
  await rm(targetFolderPath, { recursive: true, force: true }).catch(() => undefined);
  const variantNamesBefore = await listTargetVariantNames(desktopPath, FOLDER_NAME);
  const packageJsonPath = path.join(targetFolderPath, "package.json");
  const distIndexPath = path.join(targetFolderPath, "dist", "index.html");
  const nodeModulesPath = path.join(targetFolderPath, "node_modules");
  const existingWorkspacePresent = await pathExists(packageJsonPath);
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

    const scaffoldTurnInput =
      `Handle this first step only: create a new React single page app in a folder called ${FOLDER_NAME} on my desktop. ` +
      "Use a real scaffold-capable toolchain step, then install dependencies so package.json and node_modules exist. " +
      "For this turn, stop after the workspace is ready for edits. Do not start a preview server, do not verify localhost, and do not open a browser yet.";
    const buildTurnInput =
      `Reuse the existing ${FOLDER_NAME} workspace on my desktop. ` +
      "Turn it into a calm drone-themed landing page with one homepage hero and four additional sections. " +
      "Write the real page implementation, then run the build so dist/index.html exists. " +
      "For this turn, stop after the source edits and build proof exist. Do not start a preview server, do not verify localhost, and do not open a browser yet.";
    const previewTurnInput =
      `Reuse the existing ${FOLDER_NAME} workspace on my desktop. ` +
      `Start its localhost preview server using host 127.0.0.1 and port ${previewPort}, leave that preview running, and do not open a browser yet. ` +
      "Do not open dist/index.html directly when a real localhost preview server can be started.";
    const openBrowserTurnInput =
      `Open the running localhost preview for ${FOLDER_NAME} in the browser and leave it open for me. ` +
      `Use the tracked preview that is already running on host 127.0.0.1 port ${previewPort}.`;
    const conversationTurnInput =
      `Looks good. Before changing anything, just talk with me for a minute about whether ${FOLDER_NAME} feels calm enough. ` +
      "Reply in two short paragraphs and keep the page open.";
    const closeTurnInput =
      `Thanks. Please close ${FOLDER_NAME}, the browser window, and the localhost preview server so we can move on.`;

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
    const sessionAfterTurn1 = await runTurn(1, scaffoldTurnInput, turn1At);
    const turn1ProviderBlocker = findProviderBlockerReason(sessionAfterTurn1, turn1At);
    if (turn1ProviderBlocker) {
      throw new Error(turn1ProviderBlocker);
    }
    const turn1RuntimeBlocker = findBoundedRuntimeBlockerReason(sessionAfterTurn1, turn1At);
    if (turn1RuntimeBlocker) {
      throw new Error(turn1RuntimeBlocker);
    }
    assert.equal(extractTargetFolder(sessionAfterTurn1), targetFolderPath);
    assert.ok(await isDirectory(targetFolderPath), "React preview smoke target folder is missing.");
    assert.ok(
      await pathExists(packageJsonPath),
      "React preview smoke package.json is missing."
    );
    assert.ok(await isDirectory(nodeModulesPath), "React preview smoke node_modules is missing.");
    assert.equal(
      sessionAfterTurn1.browserSessions.some((entry) => entry.status === "open"),
      false,
      "Turn 1 unexpectedly opened a browser before the preview-open step."
    );
    assert.equal(
      Boolean(extractPreviewProcessLeaseId(sessionAfterTurn1)),
      false,
      "Turn 1 unexpectedly started a preview process before the preview-start step."
    );

    const turn2At = new Date(Date.now() + 5_000).toISOString();
    const sessionAfterTurn2 = await runTurn(2, buildTurnInput, turn2At);
    const turn2ProviderBlocker = findProviderBlockerReason(sessionAfterTurn2, turn2At);
    if (turn2ProviderBlocker) {
      throw new Error(turn2ProviderBlocker);
    }
    const turn2RuntimeBlocker = findBoundedRuntimeBlockerReason(sessionAfterTurn2, turn2At);
    if (turn2RuntimeBlocker) {
      throw new Error(turn2RuntimeBlocker);
    }
    assert.equal(extractTargetFolder(sessionAfterTurn2), targetFolderPath);
    assert.ok(await pathExists(distIndexPath), "Turn 2 React preview smoke dist/index.html is missing.");
    assert.equal(
      sessionAfterTurn2.browserSessions.some((entry) => entry.status === "open"),
      false,
      "Turn 2 unexpectedly opened a browser before the browser-open step."
    );
    assert.equal(
      Boolean(extractPreviewProcessLeaseId(sessionAfterTurn2)),
      false,
      "Turn 2 unexpectedly started a preview process before the preview-start step."
    );

    const turn3At = new Date(Date.now() + 10_000).toISOString();
    const sessionAfterTurn3 = await runTurn(3, previewTurnInput, turn3At);
    const turn3ProviderBlocker = findProviderBlockerReason(sessionAfterTurn3, turn3At);
    if (turn3ProviderBlocker) {
      throw new Error(turn3ProviderBlocker);
    }
    const turn3RuntimeBlocker = findBoundedRuntimeBlockerReason(sessionAfterTurn3, turn3At);
    if (turn3RuntimeBlocker) {
      throw new Error(turn3RuntimeBlocker);
    }
    const previewUrl = extractPreviewUrl(sessionAfterTurn3);
    const previewProcessLeaseId = extractPreviewProcessLeaseId(sessionAfterTurn3);
    const runningWorkspacePreviewProcessCountAfterStart =
      await countRunningWorkspacePreviewProcesses(adapter, targetFolderPath);
    assert.ok(isLoopbackHttpPreviewUrl(previewUrl), "Turn 3 did not record a localhost preview URL.");
    assert.ok(
      previewUrl?.startsWith(expectedPreviewBaseUrl),
      `Turn 3 did not use the requested preview URL ${expectedPreviewBaseUrl}/.`
    );
    assert.ok(previewProcessLeaseId, "Turn 3 did not leave a linked preview-process lease.");
    assert.equal(
      sessionAfterTurn3.browserSessions.some((entry) => entry.status === "open"),
      false,
      "Turn 3 unexpectedly opened a browser before the browser-open step."
    );
    const previewReadyAfterOpen = await isPreviewReady(previewUrl);
    const previewProcessRunningAfterOpen = await isPreviewProcessRunning(
      adapter,
      previewProcessLeaseId
    );
    assert.ok(previewReadyAfterOpen, "Turn 3 preview is not ready.");
    assert.ok(previewProcessRunningAfterOpen, "Turn 3 preview process is not still running.");
    assert.ok(
      runningWorkspacePreviewProcessCountAfterStart >= 1,
      "Turn 3 did not leave any React preview process running."
    );

    const turn4At = new Date(Date.now() + 15_000).toISOString();
    const sessionAfterTurn4 = await runTurn(4, openBrowserTurnInput, turn4At);
    const turn4ProviderBlocker = findProviderBlockerReason(sessionAfterTurn4, turn4At);
    if (turn4ProviderBlocker) {
      throw new Error(turn4ProviderBlocker);
    }
    const turn4RuntimeBlocker = findBoundedRuntimeBlockerReason(sessionAfterTurn4, turn4At);
    if (turn4RuntimeBlocker) {
      throw new Error(turn4RuntimeBlocker);
    }
    const browserSessionId = extractTrackedBrowserSessionId(sessionAfterTurn4);
    const variantNamesAfterOpen = await listTargetVariantNames(desktopPath, FOLDER_NAME);
    const openBrowserSession =
      sessionAfterTurn4.browserSessions.find((entry) => entry.status === "open") ?? null;
    const runningWorkspacePreviewProcessCountAfterOpen =
      await countRunningWorkspacePreviewProcesses(adapter, targetFolderPath);
    assert.ok(browserSessionId, "Turn 4 did not leave a tracked browser session open.");
    assert.ok(openBrowserSession, "Turn 4 did not leave an open browser session.");
    assert.ok(
      runningWorkspacePreviewProcessCountAfterOpen >= 1,
      "Turn 4 did not keep the React preview process running after opening the browser."
    );
    assert.ok(
      variantNamesAfterOpen.length <= Math.max(variantNamesBefore.length, 1),
      `React preview smoke created duplicate Desktop folders: before=${variantNamesBefore.join(",")} after=${variantNamesAfterOpen.join(",")}`
    );

    const turn5At = new Date(Date.now() + 20_000).toISOString();
    const sessionAfterTurn5 = await runTurn(5, conversationTurnInput, turn5At, true);
    const turn5Capture = allTurns[allTurns.length - 1];
    const latestAssistantTurn = [...sessionAfterTurn5.conversationTurns]
      .reverse()
      .find((turn) => turn.role === "assistant");
    const conversationReply =
      extractLatestUserVisibleReply(turn5Capture?.notifications ?? []) ??
      latestAssistantTurn?.text ??
      "";
    const browserDuringConversation =
      sessionAfterTurn5.browserSessions.find((entry) => entry.id === browserSessionId) ??
      sessionAfterTurn5.browserSessions.find((entry) => entry.status === "open") ??
      null;
    const turn5FreshJobs = sessionAfterTurn5.recentJobs.filter(
      (job) => job.createdAt >= turn5At
    );
    const previewProcessStillRunningDuringConversation = await isPreviewProcessRunning(
      adapter,
      previewProcessLeaseId
    );
    assert.match(conversationReply, /\n\n/, "Turn 5 did not stay conversational.");
    assert.equal(
      sessionAfterTurn5.queuedJobs.length,
      0,
      "Turn 5 unexpectedly left queued work behind."
    );
    assert.equal(
      sessionAfterTurn5.runningJobId,
      null,
      "Turn 5 unexpectedly left work running."
    );
    assert.equal(
      turn5FreshJobs.some((job) => job.executionInput?.startsWith("[AUTONOMOUS_LOOP_GOAL]") === true),
      false,
      "Turn 5 unexpectedly restarted autonomous execution."
    );
    assert.equal(
      browserDuringConversation?.status,
      "open",
      "React preview browser did not remain open during conversation."
    );
    assert.equal(
      previewProcessStillRunningDuringConversation,
      true,
      "React preview process did not remain running during conversation."
    );
    assert.equal(
      await isPreviewReady(previewUrl),
      true,
      "React localhost preview stopped responding during conversation."
    );

    const turn6At = new Date(Date.now() + 25_000).toISOString();
    const sessionAfterTurn6 = await runTurn(6, closeTurnInput, turn6At);
    const turn6ProviderBlocker = findProviderBlockerReason(sessionAfterTurn6, turn6At);
    if (turn6ProviderBlocker) {
      throw new Error(turn6ProviderBlocker);
    }
    const turn6RuntimeBlocker = findBoundedRuntimeBlockerReason(sessionAfterTurn6, turn6At);
    if (turn6RuntimeBlocker) {
      throw new Error(turn6RuntimeBlocker);
    }
    const trackedBrowserAfterClose =
      sessionAfterTurn6.browserSessions.find((entry) => entry.id === browserSessionId) ??
      sessionAfterTurn6.browserSessions[0] ??
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
        "React preview lifecycle smoke failed. " +
        JSON.stringify(artifact.checks)
      );
    }
    return artifact;
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
      status:
        PROVIDER_BLOCK_PATTERN.test(String(error)) ||
        BOUNDED_RUNTIME_BLOCK_PATTERN.test(String(error))
          ? "BLOCKED"
          : "FAIL",
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
        browserClosed:
          (latestSession as ConversationSession | null)?.browserSessions.every(
            (entry) => entry.status === "closed"
          ) ?? false,
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

async function main(): Promise<void> {
  await runAiDroneCityReactPreviewLifecycleLiveSmoke();
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
