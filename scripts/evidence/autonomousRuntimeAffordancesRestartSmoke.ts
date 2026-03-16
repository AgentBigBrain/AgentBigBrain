/**
 * @fileoverview Runs a restart-churn autonomy smoke through the real conversation runtime.
 *
 * This proof surface verifies that:
 * 1. a natural autonomous build can leave behind a real preview server and browser session
 * 2. a fresh runtime can reload persisted session/browser/process state and still classify it
 * 3. a natural follow-up like "close it" still closes the tracked preview after that reload
 * 4. unknown browser resources stop cleanly instead of widening into broad shutdown behavior
 */

import assert from "node:assert/strict";
import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createBrainConfigFromEnv } from "../../src/core/config";
import { buildDefaultBrain } from "../../src/core/buildBrain";
import { ensureEnvLoaded } from "../../src/core/envLoader";
import {
  buildConversationKey,
  buildSessionSeed
} from "../../src/interfaces/conversationManagerHelpers";
import { ConversationManager } from "../../src/interfaces/conversationManager";
import type {
  ConversationCapabilitySummary,
  ConversationDeliveryResult,
  ConversationExecutionResult,
  ConversationInboundMessage,
  ConversationNotifierTransport
} from "../../src/interfaces/conversationRuntime/managerContracts";
import { parseAutonomousExecutionInput } from "../../src/interfaces/conversationRuntime/managerContracts";
import type {
  ConversationJob,
  ConversationSession
} from "../../src/interfaces/conversationRuntime/sessionStateContracts";
import { InterfaceSessionStore } from "../../src/interfaces/sessionStore";
import { TelegramAdapter } from "../../src/interfaces/telegramAdapter";
import { runAutonomousTransportTask } from "../../src/interfaces/transportRuntime/deliveryLifecycle";
import { selectUserFacingSummary } from "../../src/interfaces/userFacingResult";
import {
  createLocalIntentModelResolverFromEnv,
  isLocalIntentModelRuntimeReady,
  probeLocalIntentModelFromEnv
} from "../../src/organs/languageUnderstanding/localIntentModelRuntime";
import {
  BrowserSessionRegistry,
  isCurrentTrackedBrowserSessionSnapshot,
  isOrphanedAttributableBrowserSessionSnapshot,
  isStaleTrackedBrowserSessionSnapshot
} from "../../src/organs/liveRun/browserSessionRegistry";
import { cleanupLingeringPlaywrightAutomationBrowsers } from "../../src/organs/liveRun/playwrightBrowserProcessIntrospection";
import {
  isCurrentTrackedManagedProcessSnapshot,
  isStaleTrackedManagedProcessSnapshot,
  ManagedProcessRegistry
} from "../../src/organs/liveRun/managedProcessRegistry";
import { resolveUserOwnedPathHints } from "../../src/organs/plannerPolicy/userOwnedPathHints";
import { ToolExecutorOrgan } from "../../src/organs/executor";

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

interface ReloadClassificationSnapshot {
  browserTrackedCurrent: boolean;
  browserTrackedOrphaned: boolean;
  browserTrackedStale: boolean;
  browserControlAvailable: boolean;
  browserStatus: string | null;
  processTrackedCurrent: boolean;
  processTrackedStale: boolean;
  processStatus: string | null;
  workspaceOwnershipState: string | null;
  workspacePreviewStackState: string | null;
}

export interface AutonomousRuntimeAffordancesRestartArtifact {
  generatedAt: string;
  command: string;
  status: ArtifactStatus;
  blockerReason: string | null;
  localIntentModel: LocalIntentProof;
  targetFolder: string | null;
  previewUrl: string | null;
  browserSessionId: string | null;
  previewProcessLeaseId: string | null;
  reloadBeforeClose: ReloadClassificationSnapshot;
  reloadAfterClose: ReloadClassificationSnapshot;
  checks: {
    survivesPersistedStateReload: boolean;
    reloadedBrowserStillTracked: boolean;
    reloadedPreviewProcessStillTracked: boolean;
    reloadedWorkspaceContinuityRetained: boolean;
    closeAfterReloadSucceeded: boolean;
    reloadedResourcesClassifiedStaleAfterClose: boolean;
    unknownResourceStoppedSafely: boolean;
    reviewableUserFacingCopy: boolean;
  };
  turns: readonly TurnCapture[];
}

interface Harness {
  adapter: TelegramAdapter;
  store: InterfaceSessionStore;
  manager: ConversationManager;
  conversationKey: string;
  abortControllers: Map<string, AbortController>;
}

interface EnvSnapshot {
  [key: string]: string | undefined;
}

const COMMAND_NAME = "tsx scripts/evidence/autonomousRuntimeAffordancesRestartSmoke.ts";
const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/autonomous_runtime_affordances_restart_report.json"
);
const SESSION_DIRECTORY = path.resolve(process.cwd(), "runtime");
const RESTART_RUN_ID = `${Date.now()}`;
const LIVE_RUN_RUNTIME_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-autonomous-runtime-affordances-restart-live-run-${RESTART_RUN_ID}`
);
const BROWSER_SNAPSHOT_PATH = path.join(LIVE_RUN_RUNTIME_PATH, "browser_sessions.json");
const MANAGED_PROCESS_SNAPSHOT_PATH = path.join(LIVE_RUN_RUNTIME_PATH, "managed_processes.json");
const CONVERSATION_ID = "autonomous-runtime-restart-smoke";
const USER_ID = "autonomous-restart-smoke-user";
const USERNAME = "anthonybenny";
const PROVIDER_BLOCK_PATTERN =
  /(?:429|exceeded your current quota|rate limit|fetch failed|request timed out)/i;
const UNKNOWN_PREVIEW_URL = "http://127.0.0.1:59999/index.html";
const TURN_TIMEOUT_MS = 75_000;
const MANAGER_IDLE_TIMEOUT_MS = 10_000;
const SMOKE_DEADLINE_MS = 120_000;
const CLEANUP_STEP_TIMEOUT_MS = 5_000;

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

async function isPreviewReachable(url: string | null): Promise<boolean> {
  if (!url || /^file:/i.test(url)) {
    return false;
  }
  try {
    const response = await fetchWithTimeout(url, 5_000);
    return response.ok;
  } catch {
    return false;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function allocateLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a loopback port.")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
    server.once("error", reject);
  });
}

function hashSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function waitForSeededProcessSpawn(child: ChildProcess, timeoutMs: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finalize = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      child.removeAllListeners("spawn");
      child.removeAllListeners("error");
      child.removeAllListeners("close");
      callback();
    };
    const timeoutHandle = setTimeout(() => {
      finalize(() => reject(new Error(`Seeded process did not emit spawn within ${timeoutMs}ms.`)));
    }, timeoutMs);
    child.once("spawn", () => finalize(resolve));
    child.once("error", (error) => finalize(() => reject(error)));
    child.once("close", (code, signal) => {
      finalize(() =>
        reject(
          new Error(
            `Seeded process exited before startup completed (${code ?? "no-exit-code"}${
              signal ? `, signal ${signal}` : ""
            }).`
          )
        )
      );
    });
  });
}

async function waitForSeededPreviewReadiness(
  executor: ToolExecutorOrgan,
  previewUrl: string,
  attempts = 8
): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const probeOutcome = await executor.executeWithOutcome({
      id: `seed_probe_http_${attempt}`,
      type: "probe_http",
      description: `Verify the seeded restart-smoke preview is ready at ${previewUrl}.`,
      params: {
        url: previewUrl,
        expectedStatus: 200,
        timeoutMs: 5_000
      },
      estimatedCostUsd: 0.01
    });
    if (probeOutcome.status === "success") {
      return;
    }
    await sleep(750);
  }
  throw new Error(`Seeded preview never became ready at ${previewUrl}.`);
}

async function seedRestartWorkspaceSession(
  sessionPath: string,
  targetFolderPath: string
): Promise<{
  session: ConversationSession;
  targetFolder: string;
  previewUrl: string;
  browserSessionId: string;
  previewProcessLeaseId: string;
}> {
  const openedAt = new Date().toISOString();
  const seedJobId = "job_seed_restart_smoke";
  const previousUserRequest =
    "Please build a calm air-drone landing page on my desktop, run it from a local preview server, and leave it open for me.";
  const primaryArtifactPath = path.join(targetFolderPath, "index.html");
  const serverScriptPath = path.join(targetFolderPath, "restart-smoke-server.cjs");
  const previewPort = await allocateLoopbackPort();
  const previewUrl = `http://127.0.0.1:${previewPort}/index.html`;

  await mkdir(targetFolderPath, { recursive: true });
  await writeFile(
    primaryArtifactPath,
    [
      "<!doctype html>",
      "<html lang=\"en\">",
      "<head>",
      "  <meta charset=\"utf-8\" />",
      "  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
      "  <title>Restart Smoke</title>",
      "  <style>",
      "    body { font-family: Georgia, serif; background: #f1f5ef; color: #142315; margin: 0; }",
      "    main { min-height: 100vh; display: grid; place-items: center; padding: 48px; }",
      "    section { max-width: 720px; background: rgba(255,255,255,0.82); border: 1px solid #cfd8ca; border-radius: 24px; padding: 40px; }",
      "    h1 { font-size: 3rem; margin: 0 0 16px; }",
      "    p { font-size: 1.1rem; line-height: 1.6; }",
      "  </style>",
      "</head>",
      "<body>",
      "  <main>",
      "    <section>",
      "      <h1>Quiet Skies</h1>",
      "      <p>A calm drone landing page left open for restart-safe preview control.</p>",
      "    </section>",
      "  </main>",
      "</body>",
      "</html>"
    ].join("\n"),
    "utf8"
  );
  await writeFile(
    serverScriptPath,
    [
      "const fs = require('node:fs');",
      "const http = require('node:http');",
      "const path = require('node:path');",
      `const port = ${previewPort};`,
      "const htmlPath = path.join(process.cwd(), 'index.html');",
      "const server = http.createServer((_req, res) => {",
      "  const html = fs.readFileSync(htmlPath, 'utf8');",
      "  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });",
      "  res.end(html);",
      "});",
      "const shutdown = () => {",
      "  server.close(() => process.exit(0));",
      "};",
      "process.on('SIGTERM', shutdown);",
      "process.on('SIGINT', shutdown);",
      "server.listen(port, '127.0.0.1');"
    ].join("\n"),
    "utf8"
  );

  const config = createBrainConfigFromEnv();
  const managedProcessRegistry = new ManagedProcessRegistry({
    snapshotPath: MANAGED_PROCESS_SNAPSHOT_PATH
  });
  const browserSessionRegistry = new BrowserSessionRegistry({
    snapshotPath: BROWSER_SNAPSHOT_PATH
  });
  const executor = new ToolExecutorOrgan(
    config,
    undefined,
    managedProcessRegistry,
    undefined,
    browserSessionRegistry
  );

  const previewCommand = "node restart-smoke-server.cjs";
  const child = spawn("node", ["restart-smoke-server.cjs"], {
    cwd: targetFolderPath,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  }) as ChildProcessWithoutNullStreams;
  child.stdout?.resume();
  child.stderr?.resume();
  await waitForSeededProcessSpawn(child, 2_000);
  const processSnapshot = managedProcessRegistry.registerStarted({
    actionId: "seed_start_preview_process",
    child,
    commandFingerprint: hashSha256(previewCommand),
    cwd: targetFolderPath,
    shellExecutable: "node",
    shellKind: "direct",
    taskId: seedJobId
  });
  const previewProcessLeaseId = processSnapshot.leaseId;

  await waitForSeededPreviewReadiness(executor, previewUrl);

  const openOutcome = await executor.executeWithOutcome({
    id: "seed_open_browser",
    type: "open_browser",
    description: "Open the seeded restart-smoke preview in a browser window.",
    params: {
      url: previewUrl,
      rootPath: targetFolderPath,
      previewProcessLeaseId
    },
    estimatedCostUsd: 0.02
  });
  assert.equal(openOutcome.status, "success", "Could not open the seeded preview browser session.");
  const browserSessionId = openOutcome.executionMetadata?.browserSessionId;
  assert.equal(typeof browserSessionId, "string", "Seeded browser session id was missing.");

  const browserSnapshot = browserSessionRegistry.getSnapshot(browserSessionId);
  assert.ok(processSnapshot, "Seeded managed process snapshot was missing.");
  assert.ok(browserSnapshot, "Seeded browser session snapshot was missing.");

  const store = new InterfaceSessionStore(sessionPath);
  const session = buildSessionSeed({
    provider: "telegram",
    conversationId: CONVERSATION_ID,
    userId: USER_ID,
    username: USERNAME,
    conversationVisibility: "private",
    receivedAt: openedAt
  });
  session.updatedAt = openedAt;
  session.modeContinuity = {
    activeMode: "autonomous",
    source: "natural_intent",
    confidence: "HIGH",
    lastAffirmedAt: openedAt,
    lastUserInput: previousUserRequest,
    lastClarificationId: null
  };
  session.returnHandoff = {
    id: "handoff:restart_smoke",
    status: "waiting_for_user",
    goal: previousUserRequest,
    summary: "The seeded landing page is ready and the preview was left open for follow-up control.",
    nextSuggestedStep: "Review the page or close the preview when you are done.",
    workspaceRootPath: targetFolderPath,
    primaryArtifactPath,
    previewUrl,
    changedPaths: [primaryArtifactPath],
    sourceJobId: seedJobId,
    updatedAt: openedAt
  };
  session.recentJobs = [
    {
      id: seedJobId,
      input: previousUserRequest,
      executionInput: previousUserRequest,
      createdAt: openedAt,
      startedAt: openedAt,
      completedAt: openedAt,
      status: "completed",
      resultSummary: `Opened ${previewUrl} and left the preview ready for follow-up control.`,
      errorMessage: null,
      ackTimerGeneration: 0,
      ackEligibleAt: null,
      ackLifecycleState: "FINAL_SENT_NO_EDIT",
      ackMessageId: null,
      ackSentAt: null,
      ackEditAttemptCount: 0,
      ackLastErrorCode: null,
      finalDeliveryOutcome: "sent",
      finalDeliveryAttemptCount: 1,
      finalDeliveryLastErrorCode: null,
      finalDeliveryLastAttemptAt: openedAt,
      isSystemJob: false,
      pauseRequestedAt: null
    }
  ];
  session.recentActions = [
    {
      id: `seed:file:${primaryArtifactPath}`,
      kind: "file",
      label: "File index.html",
      location: primaryArtifactPath,
      status: "updated",
      sourceJobId: seedJobId,
      at: openedAt,
      summary: `Write success: ${primaryArtifactPath}`
    },
    {
      id: `seed:process:${processSnapshot?.leaseId}`,
      kind: "process",
      label: "Process in seeded workspace",
      location: targetFolderPath,
      status: "running",
      sourceJobId: seedJobId,
      at: openedAt,
      summary: `Process started: lease ${processSnapshot?.leaseId} (pid ${processSnapshot?.pid ?? "unknown"}).`
    },
    {
      id: `seed:url:${previewUrl}`,
      kind: "url",
      label: "Verified local URL",
      location: previewUrl,
      status: "completed",
      sourceJobId: seedJobId,
      at: openedAt,
      summary: `HTTP ready: ${previewUrl} responded with expected status 200.`
    },
    {
      id: `seed:browser_session:${browserSnapshot?.sessionId}`,
      kind: "browser_session",
      label: "Browser window",
      location: previewUrl,
      status: "open",
      sourceJobId: seedJobId,
      at: openedAt,
      summary: `Opened ${previewUrl} in a visible browser window and left it open for you.`
    }
  ];
  session.browserSessions = [
    {
      id: browserSnapshot!.sessionId,
      label: "Browser window",
      url: browserSnapshot!.url,
      status: browserSnapshot!.status,
      openedAt: browserSnapshot!.openedAt,
      closedAt: browserSnapshot!.closedAt,
      sourceJobId: seedJobId,
      visibility: browserSnapshot!.visibility,
      controllerKind: browserSnapshot!.controllerKind,
      controlAvailable: browserSnapshot!.controlAvailable,
      browserProcessPid: browserSnapshot!.browserProcessPid,
      workspaceRootPath: browserSnapshot!.workspaceRootPath,
      linkedProcessLeaseId: browserSnapshot!.linkedProcessLeaseId,
      linkedProcessCwd: browserSnapshot!.linkedProcessCwd,
      linkedProcessPid: browserSnapshot!.linkedProcessPid
    }
  ];
  session.pathDestinations = [
    {
      id: `path:process:${processSnapshot!.leaseId}`,
      label: "Process working folder",
      resolvedPath: targetFolderPath,
      sourceJobId: seedJobId,
      updatedAt: openedAt
    },
    {
      id: `path:file:${primaryArtifactPath}`,
      label: "File index.html",
      resolvedPath: primaryArtifactPath,
      sourceJobId: seedJobId,
      updatedAt: openedAt
    }
  ];
  session.activeWorkspace = {
    id: `workspace:${targetFolderPath}`,
    label: "Current project workspace",
    rootPath: targetFolderPath,
    primaryArtifactPath,
    previewUrl,
    browserSessionId: browserSnapshot!.sessionId,
    browserSessionIds: [browserSnapshot!.sessionId],
    browserSessionStatus: browserSnapshot!.status,
    browserProcessPid: browserSnapshot!.browserProcessPid,
    previewProcessLeaseId: processSnapshot!.leaseId,
    previewProcessLeaseIds: [processSnapshot!.leaseId],
    previewProcessCwd: targetFolderPath,
    lastKnownPreviewProcessPid: processSnapshot!.pid,
    stillControllable: true,
    ownershipState: "tracked",
    previewStackState: "browser_and_preview",
    lastChangedPaths: [primaryArtifactPath],
    sourceJobId: seedJobId,
    updatedAt: openedAt
  };
  session.conversationTurns = [
    {
      role: "user",
      text: previousUserRequest,
      at: openedAt
    },
    {
      role: "assistant",
      text: `I opened ${previewUrl} in your browser and left the landing page ready for you.`,
      at: openedAt
    }
  ];
  await store.setSession(session);

  return {
    session,
    targetFolder: targetFolderPath,
    previewUrl,
    browserSessionId,
    previewProcessLeaseId
  };
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

  const config = createBrainConfigFromEnv();
  const browserSessionRegistry = new BrowserSessionRegistry({
    snapshotPath: BROWSER_SNAPSHOT_PATH
  });
  const managedProcessRegistry = new ManagedProcessRegistry({
    snapshotPath: MANAGED_PROCESS_SNAPSHOT_PATH
  });
  const cleanupExecutor = new ToolExecutorOrgan(
    config,
    undefined,
    managedProcessRegistry,
    undefined,
    browserSessionRegistry
  );

  for (const browserSessionId of browserSessionIds) {
    const closePromise = cleanupExecutor.executeWithOutcome({
      id: `cleanup:${browserSessionId}:close_browser`,
      type: "close_browser",
      description: `Close lingering restart-smoke browser session ${browserSessionId}.`,
      params: {
        sessionId: browserSessionId
      },
      estimatedCostUsd: 0.01
    }).catch(() => undefined);
    await Promise.race([
      closePromise,
      sleep(CLEANUP_STEP_TIMEOUT_MS)
    ]);
  }
}

function buildLocalIntentProof(
  probe: Awaited<ReturnType<typeof probeLocalIntentModelFromEnv>>
): LocalIntentProof {
  return {
    enabled: probe.enabled,
    required: probe.liveSmokeRequired,
    reachable: probe.reachable,
    modelPresent: probe.modelPresent,
    model: probe.model,
    provider: probe.provider,
    baseUrl: probe.baseUrl
  };
}

function buildHarness(sessionPath: string): Harness {
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
  const store = new InterfaceSessionStore(sessionPath);
  const manager = new ConversationManager(
    store,
    {
      allowAutonomousViaInterface: true,
      ackDelayMs: 300,
      heartbeatIntervalMs: 5_000,
      maxConversationTurns: 40,
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
  return {
    adapter,
    store,
    manager,
    conversationKey,
    abortControllers: new Map<string, AbortController>()
  };
}

async function runTurn(
  harness: Harness,
  turn: number,
  userInput: string,
  receivedAt: string,
  turns: TurnCapture[]
): Promise<ConversationSession> {
  const notifications: CapturedNotification[] = [];
  const notifier = createNotifierTransport(notifications);
  const executeTask = async (
    taskInput: string,
    taskReceivedAt: string
  ): Promise<ConversationExecutionResult> => {
    const autonomousGoal = parseAutonomousExecutionInput(taskInput);
    if (autonomousGoal) {
      return await runAutonomousTransportTask({
        conversationId: harness.conversationKey,
        goal: autonomousGoal.goal,
        initialExecutionInput: autonomousGoal.initialExecutionInput,
        receivedAt: taskReceivedAt,
        notifier,
        abortControllers: harness.abortControllers,
        runAutonomousTask: async (
          goal,
          startedAt,
          progressSender,
          signal,
          initialExecutionInput
        ) =>
          harness.adapter.runAutonomousTask(
            goal,
            startedAt,
            progressSender,
            signal,
            initialExecutionInput
          )
      });
    }

    const runResult = await harness.adapter.runTextTask(taskInput, taskReceivedAt);
    return {
      summary: selectUserFacingSummary(runResult, {
        showTechnicalSummary: false,
        showSafetyCodes: false
      }),
      taskRunResult: runResult
    };
  };

  console.log(`\n=== TURN ${turn} USER ===\n${userInput}\n`);
  const immediateReply = await harness.manager.handleMessage(
    buildMessage(userInput, receivedAt),
    executeTask,
    notifier
  );
  console.log(`=== TURN ${turn} IMMEDIATE REPLY ===\n${immediateReply}`);
  await waitForTurnCompletion(
    harness.store,
    harness.conversationKey,
    `turn_${turn}`,
    receivedAt,
    TURN_TIMEOUT_MS
  );
  await harness.manager.waitForIdle(MANAGER_IDLE_TIMEOUT_MS);
  const session = await harness.store.getSession(harness.conversationKey);
  if (!session) {
    throw new Error(`Turn ${turn} finished but the conversation session was missing afterward.`);
  }
  const sessionSnapshot = cloneSessionSnapshot(session);
  console.log(
    `=== TURN ${turn} SESSION SNAPSHOT ===\n${JSON.stringify(
      {
        runningJobId: sessionSnapshot.runningJobId,
        queuedJobs: sessionSnapshot.queuedJobs.length,
        progressState: sessionSnapshot.progressState,
        activeClarification: sessionSnapshot.activeClarification,
        browserSessions: sessionSnapshot.browserSessions,
        activeWorkspace: sessionSnapshot.activeWorkspace,
        recentJobs: sessionSnapshot.recentJobs
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
}

function captureReloadClassification(
  reloadedSession: ConversationSession | null,
  browserSessionId: string | null,
  previewProcessLeaseId: string | null
): ReloadClassificationSnapshot {
  const browserSessionRegistry = new BrowserSessionRegistry({
    snapshotPath: BROWSER_SNAPSHOT_PATH
  });
  const managedProcessRegistry = new ManagedProcessRegistry({
    snapshotPath: MANAGED_PROCESS_SNAPSHOT_PATH
  });
  const browserSnapshot = browserSessionId
    ? browserSessionRegistry.getSnapshot(browserSessionId)
    : null;
  const processSnapshot = previewProcessLeaseId
    ? managedProcessRegistry.getSnapshot(previewProcessLeaseId)
    : null;

  return {
    browserTrackedCurrent:
      browserSnapshot !== null && isCurrentTrackedBrowserSessionSnapshot(browserSnapshot),
    browserTrackedOrphaned:
      browserSnapshot !== null && isOrphanedAttributableBrowserSessionSnapshot(browserSnapshot),
    browserTrackedStale:
      browserSnapshot !== null && isStaleTrackedBrowserSessionSnapshot(browserSnapshot),
    browserControlAvailable: browserSnapshot?.controlAvailable ?? false,
    browserStatus: browserSnapshot?.status ?? null,
    processTrackedCurrent:
      processSnapshot !== null && isCurrentTrackedManagedProcessSnapshot(processSnapshot),
    processTrackedStale:
      processSnapshot !== null && isStaleTrackedManagedProcessSnapshot(processSnapshot),
    processStatus: processSnapshot?.statusCode ?? null,
    workspaceOwnershipState: reloadedSession?.activeWorkspace?.ownershipState ?? null,
    workspacePreviewStackState: reloadedSession?.activeWorkspace?.previewStackState ?? null
  };
}

export async function runAutonomousRuntimeAffordancesRestartSmoke():
Promise<AutonomousRuntimeAffordancesRestartArtifact> {
  ensureEnvLoaded();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await cleanupLingeringPlaywrightAutomationBrowsers().catch(() => undefined);

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

  const { desktopPath } = resolveUserOwnedPathHints();
  const targetFolderName = `drone-company-restart-smoke-${Date.now()}`;
  const targetFolderPath = path.join(desktopPath, targetFolderName);
  const sessionPath = path.resolve(
    SESSION_DIRECTORY,
    `autonomous_runtime_affordances_restart_sessions_${Date.now()}.json`
  );
  const tempLedgerPath = path.resolve(
    process.cwd(),
    `runtime/tmp-autonomous-runtime-affordances-restart-${Date.now()}.sqlite`
  );
  const tempStatePath = path.resolve(
    process.cwd(),
    `runtime/tmp-autonomous-runtime-affordances-restart-${Date.now()}.json`
  );
  const envSnapshot = applyEnvOverrides({
    BRAIN_LIVE_RUN_RUNTIME_PATH: LIVE_RUN_RUNTIME_PATH,
    BRAIN_STATE_JSON_PATH: tempStatePath,
    BRAIN_LEDGER_SQLITE_PATH: tempLedgerPath,
    BRAIN_LEDGER_EXPORT_JSON_ON_WRITE: "false",
    BRAIN_ENABLE_EMBEDDINGS: "false",
    BRAIN_ENABLE_DYNAMIC_PULSE: "false"
  });
  const turns: TurnCapture[] = [];

  const turn1Input =
    "I just restarted things on my side. Please close the landing page we left open earlier so we can move on.";
  const turn2Input =
    `There is another localhost page I opened myself earlier. If you cannot prove it belongs to this project, ` +
    `leave it alone instead of guessing. Please close ${UNKNOWN_PREVIEW_URL} only if it is actually the page from this project.`;

  let latestSession: ConversationSession | null = null;

  try {
    await rm(targetFolderPath, { recursive: true, force: true }).catch(() => undefined);

    const seeded = await seedRestartWorkspaceSession(sessionPath, targetFolderPath);
    latestSession = seeded.session;
    const targetFolder = seeded.targetFolder;
    const previewUrl = seeded.previewUrl;
    const browserSessionId = seeded.browserSessionId;
    const previewProcessLeaseId = seeded.previewProcessLeaseId;

    assert.equal(await pathExists(targetFolder), true, "Seeded target folder was not created.");
    assert.equal(await isPreviewReachable(previewUrl), true, "Seeded preview URL was not reachable.");

    const harness2 = buildHarness(sessionPath);
    const reloadedSessionBeforeClose = await harness2.store.getSession(harness2.conversationKey);
    const reloadBeforeClose = captureReloadClassification(
      reloadedSessionBeforeClose,
      browserSessionId,
      previewProcessLeaseId
    );

    const turn1At = new Date().toISOString();
    const turn1Session = await runTurn(harness2, 1, turn1Input, turn1At, turns);
    latestSession = turn1Session;

    const turn1Job = findLatestJobSince(turn1Session, turn1At);
    const turn1BrowserActions = turn1Job
      ? turn1Session.recentActions.filter(
          (action) => action.sourceJobId === turn1Job.id && action.kind === "browser_session"
        )
      : [];
    const turn1ProcessActions = turn1Job
      ? turn1Session.recentActions.filter(
          (action) => action.sourceJobId === turn1Job.id && action.kind === "process"
        )
      : [];

    const reloadAfterClose = captureReloadClassification(
      await harness2.store.getSession(harness2.conversationKey),
      browserSessionId,
      previewProcessLeaseId
    );
    const previewReachableAfterClose = await isPreviewReachable(previewUrl);

    const turn2At = new Date().toISOString();
    const turn2Session = await runTurn(harness2, 2, turn2Input, turn2At, turns);
    latestSession = turn2Session;
    const turn2Reply = extractLatestAssistantReply(turn2Session);
    const turn2Job = findLatestJobSince(turn2Session, turn2At);
    const turn2ProcessActions = turn2Job
      ? turn2Session.recentActions.filter(
          (action) => action.sourceJobId === turn2Job.id && action.kind === "process"
        )
      : [];

    const reviewableCopy = turns.every(
      (turn) =>
        isReviewableReply(turn.immediateReply) ||
        turn.notifications.some((notification) => isReviewableReply(notification.text))
    );

    const checks = {
      survivesPersistedStateReload: reloadedSessionBeforeClose !== null,
      reloadedBrowserStillTracked:
        reloadBeforeClose.browserStatus === "open" &&
        (reloadBeforeClose.browserTrackedCurrent || reloadBeforeClose.browserTrackedOrphaned),
      reloadedPreviewProcessStillTracked:
        reloadBeforeClose.processTrackedCurrent &&
        reloadBeforeClose.processStatus !== "PROCESS_STOPPED",
      reloadedWorkspaceContinuityRetained:
        reloadedSessionBeforeClose?.activeWorkspace?.rootPath === targetFolder &&
        reloadedSessionBeforeClose?.activeWorkspace?.ownershipState === "tracked",
      closeAfterReloadSucceeded:
        turn1Session.browserSessions.every((entry) => entry.status === "closed") &&
        previewReachableAfterClose === false &&
        turn1BrowserActions.some((action) => action.status === "closed") &&
        turn1ProcessActions.some((action) => action.status === "closed"),
      reloadedResourcesClassifiedStaleAfterClose:
        reloadAfterClose.browserTrackedStale &&
        reloadAfterClose.processTrackedStale &&
        reloadAfterClose.workspaceOwnershipState === "stale",
      unknownResourceStoppedSafely:
        turn2ProcessActions.length === 0 &&
        turn2Session.browserSessions.every((entry) => entry.status === "closed") &&
        /cannot prove|can't prove|no verifiable link|from the evidence|leav(?:e|ing)\s+.*(?:alone|untouched)|did not close|leave .* alone|untouched to avoid guessing/i.test(
          turn2Reply
        ),
      reviewableUserFacingCopy: reviewableCopy
    };

    const status: ArtifactStatus = Object.values(checks).every(Boolean) ? "PASS" : "FAIL";
    const artifact: AutonomousRuntimeAffordancesRestartArtifact = {
      generatedAt: new Date().toISOString(),
      command: COMMAND_NAME,
      status,
      blockerReason: null,
      localIntentModel: buildLocalIntentProof(localProbe),
      targetFolder,
      previewUrl,
      browserSessionId,
      previewProcessLeaseId,
      reloadBeforeClose,
      reloadAfterClose,
      checks,
      turns
    };
    await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    return artifact;
  } finally {
    await cleanupTrackedSmokeResources(latestSession).catch(() => undefined);
    await cleanupLingeringPlaywrightAutomationBrowsers().catch(() => undefined);
    await rm(targetFolderPath, { recursive: true, force: true }).catch(() => undefined);
    await rm(sessionPath, { force: true }).catch(() => undefined);
    await rm(`${sessionPath}.lock`, { force: true }).catch(() => undefined);
    await rm(tempLedgerPath, { force: true }).catch(() => undefined);
    await rm(`${tempLedgerPath}-shm`, { force: true }).catch(() => undefined);
    await rm(`${tempLedgerPath}-wal`, { force: true }).catch(() => undefined);
    await rm(LIVE_RUN_RUNTIME_PATH, { recursive: true, force: true }).catch(() => undefined);
    await rm(tempStatePath, { force: true }).catch(() => undefined);
    await rm(`${tempStatePath}.lock`, { force: true }).catch(() => undefined);
    restoreEnv(envSnapshot);
  }
}

async function writeRestartArtifact(
  artifact: AutonomousRuntimeAffordancesRestartArtifact
): Promise<void> {
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

function buildRestartBlockedArtifact(
  blockerReason: string,
  localProbe: Awaited<ReturnType<typeof probeLocalIntentModelFromEnv>> | null
): AutonomousRuntimeAffordancesRestartArtifact {
  return {
    generatedAt: new Date().toISOString(),
    command: COMMAND_NAME,
    status: "BLOCKED",
    blockerReason,
    localIntentModel: localProbe
      ? buildLocalIntentProof(localProbe)
      : {
          enabled: false,
          required: false,
          reachable: false,
          modelPresent: false,
          model: "unknown",
          provider: "unknown",
          baseUrl: ""
        },
    targetFolder: null,
    previewUrl: null,
    browserSessionId: null,
    previewProcessLeaseId: null,
    reloadBeforeClose: {
      browserTrackedCurrent: false,
      browserTrackedOrphaned: false,
      browserTrackedStale: false,
      browserControlAvailable: false,
      browserStatus: null,
      processTrackedCurrent: false,
      processTrackedStale: false,
      processStatus: null,
      workspaceOwnershipState: null,
      workspacePreviewStackState: null
    },
    reloadAfterClose: {
      browserTrackedCurrent: false,
      browserTrackedOrphaned: false,
      browserTrackedStale: false,
      browserControlAvailable: false,
      browserStatus: null,
      processTrackedCurrent: false,
      processTrackedStale: false,
      processStatus: null,
      workspaceOwnershipState: null,
      workspacePreviewStackState: null
    },
    checks: {
      survivesPersistedStateReload: false,
      reloadedBrowserStillTracked: false,
      reloadedPreviewProcessStillTracked: false,
      reloadedWorkspaceContinuityRetained: false,
      closeAfterReloadSucceeded: false,
      reloadedResourcesClassifiedStaleAfterClose: false,
      unknownResourceStoppedSafely: false,
      reviewableUserFacingCopy: false
    },
    turns: []
  };
}

async function main(): Promise<void> {
  ensureEnvLoaded();
  const localProbe = await probeLocalIntentModelFromEnv().catch(() => null);
  let deadlineHandle: NodeJS.Timeout | null = null;
  try {
    const deadlinePromise = new Promise<AutonomousRuntimeAffordancesRestartArtifact>((resolve) => {
      deadlineHandle = setTimeout(() => {
        resolve(
          buildRestartBlockedArtifact(
            `Restart smoke timed out after ${SMOKE_DEADLINE_MS}ms before it exited cleanly.`,
            localProbe
          )
        );
      }, SMOKE_DEADLINE_MS);
    });
    const artifact = await Promise.race([
      runAutonomousRuntimeAffordancesRestartSmoke(),
      deadlinePromise
    ]);
    if (artifact.blockerReason?.includes(`Restart smoke timed out after ${SMOKE_DEADLINE_MS}ms`)) {
      await writeRestartArtifact(artifact);
    }
    console.log(JSON.stringify(artifact, null, 2));
    if (artifact.status !== "PASS") {
      process.exitCode = 1;
    }
  } catch (error) {
    const artifact = buildRestartBlockedArtifact(
      error instanceof Error ? error.stack ?? error.message : String(error),
      localProbe
    );
    await writeRestartArtifact(artifact);
    console.error(artifact.blockerReason);
    process.exitCode = 1;
  } finally {
    if (deadlineHandle) {
      clearTimeout(deadlineHandle);
    }
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
