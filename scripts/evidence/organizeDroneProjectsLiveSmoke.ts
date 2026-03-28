import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildDefaultBrain } from "../../src/core/buildBrain";
import { createBrainConfigFromEnv } from "../../src/core/config";
import { hashSha256 } from "../../src/core/cryptoUtils";
import { ensureEnvLoaded } from "../../src/core/envLoader";
import type {
  ActionRunResult,
  ExecutorExecutionOutcome,
  PlannedAction,
  TaskRunResult
} from "../../src/core/types";
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
import { normalizeSession } from "../../src/interfaces/conversationRuntime/sessionNormalization";
import type {
  ConversationJob,
  ConversationSession
} from "../../src/interfaces/conversationRuntime/sessionStateContracts";
import { recordUserTurn } from "../../src/interfaces/conversationSessionMutations";
import { persistExecutedJobOutcome } from "../../src/interfaces/conversationWorkerLifecycle";
import { InterfaceSessionStore } from "../../src/interfaces/sessionStore";
import { TelegramAdapter } from "../../src/interfaces/telegramAdapter";
import { runAutonomousTransportTask } from "../../src/interfaces/transportRuntime/deliveryLifecycle";
import { selectUserFacingSummary } from "../../src/interfaces/userFacingResult";
import { ToolExecutorOrgan } from "../../src/organs/executor";
import {
  buildManagedProcessExecutionMetadata,
  buildReadinessProbeExecutionMetadata,
  findAvailableLoopbackPort,
  waitForLocalHttpReadiness
} from "../../src/organs/liveRun/contracts";
import { BrowserSessionRegistry } from "../../src/organs/liveRun/browserSessionRegistry";
import { ManagedProcessRegistry } from "../../src/organs/liveRun/managedProcessRegistry";
import { cleanupLingeringPlaywrightAutomationBrowsers } from "../../src/organs/liveRun/playwrightBrowserProcessIntrospection";
import {
  createLocalIntentModelResolverFromEnv,
  isLocalIntentModelRuntimeReady,
  probeLocalIntentModelFromEnv
} from "../../src/organs/languageUnderstanding/localIntentModelRuntime";
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

interface LocalIntentProof {
  enabled: boolean;
  required: boolean;
  reachable: boolean;
  modelPresent: boolean;
  model: string;
  provider: string;
  baseUrl: string;
}

interface SeededPreviewHolder {
  folderName: string;
  folderPath: string;
  prompt: string;
  taskRunResult: TaskRunResult;
  createdAt: string;
  completedAt: string;
  previewUrl: string;
  processLeaseId: string;
  browserSessionId: string;
}

interface SeededProjectFolder {
  folderName: string;
  folderPath: string;
  prompt: string;
  taskRunResult: TaskRunResult;
  createdAt: string;
  completedAt: string;
}

type ArtifactStatus = "PASS" | "FAIL" | "BLOCKED";

interface Artifact {
  generatedAt: string;
  command: string;
  status: ArtifactStatus;
  blockerReason: string | null;
  localIntentModel: LocalIntentProof;
  prompts: { organize: string; retry: string };
  seededPreviewHolders: readonly Omit<SeededPreviewHolder, "taskRunResult" | "createdAt" | "completedAt" | "prompt">[];
  targetRoot: string;
  movedEntries: readonly string[];
  remainingDesktopMatches: readonly string[];
  checks: {
    routedAutonomous: boolean;
    previewsSeeded: boolean;
    recoveryClarificationAsked: boolean;
    autoRecoveredWithoutClarification: boolean;
    foldersMoved: boolean;
    previewsStopped: boolean;
    browserSessionsClosed: boolean;
  };
  cleanupChecks: {
    previewsStoppedAfterCleanup: boolean;
    browserSessionsClosedAfterCleanup: boolean;
    trackedRuntimeHandlesClosedAfterCleanup: boolean;
  };
  turns: readonly TurnCapture[];
}

interface EnvSnapshot {
  [key: string]: string | undefined;
}

const RUN_ID = `${Date.now()}`;
const COMMAND_NAME = "tsx scripts/evidence/organizeDroneProjectsLiveSmoke.ts";
const CONVERSATION_ID = `organize-drone-projects-smoke-${RUN_ID}`;
const USER_ID = "real-smoke-user";
const USERNAME = "anthonybenny";
const SESSION_PATH = path.resolve(process.cwd(), `runtime/tmp-organize-session-${RUN_ID}.json`);
const STATE_PATH = path.resolve(process.cwd(), `runtime/tmp-organize-state-${RUN_ID}.json`);
const LEDGER_SQLITE_PATH = path.resolve(process.cwd(), `runtime/tmp-organize-ledgers-${RUN_ID}.sqlite`);
const LATEST_SESSION_PATH = path.resolve(process.cwd(), "runtime/organize_drone_projects_smoke_sessions.json");
const ARTIFACT_PATH = path.resolve(process.cwd(), "runtime/evidence/organize_drone_projects_live_smoke_report.json");
const LIVE_RUN_RUNTIME_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-organize-live-run-${RUN_ID}`
);
const MANAGED_PROCESS_SNAPSHOT_PATH = path.join(LIVE_RUN_RUNTIME_PATH, "managed_processes.json");
const BROWSER_SESSION_SNAPSHOT_PATH = path.join(LIVE_RUN_RUNTIME_PATH, "browser_sessions.json");
const PROVIDER_BLOCK_PATTERN =
/(?:429|exceeded your current quota|usage limit|purchase more credits|try again at|rate limit|fetch failed|request timed out|socket hang up|ECONNRESET)/i;
const TURN_TIMEOUT_MS = 50_000;
const SMOKE_DEADLINE_MS = 70_000;
const CLEANUP_STEP_TIMEOUT_MS = 3_000;
const CLEANUP_SETTLE_TIMEOUT_MS = 4_000;

const CAPABILITY_SUMMARY_FIXTURE: ConversationCapabilitySummary = {
  provider: "telegram",
  privateChatAliasOptional: true,
  supportsNaturalConversation: true,
  supportsAutonomousExecution: true,
  supportsMemoryReview: true,
  capabilities: [
    { id: "natural_chat", label: "Natural conversation", status: "available", summary: "You can talk naturally without special syntax." },
    { id: "plan_and_build", label: "Plan and build", status: "available", summary: "I can build, edit, and verify local work when the request is clear." },
    { id: "autonomous_execution", label: "Autonomous execution", status: "available", summary: "I can keep going until the task is finished or I hit a real blocker." }
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

function buildMessage(text: string, receivedAt: string): ConversationInboundMessage {
  return { provider: "telegram", conversationId: CONVERSATION_ID, userId: USER_ID, username: USERNAME, conversationVisibility: "private", text, receivedAt };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    return await fetch(url, { signal: abortController.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function removeSmokeFoldersByPrefix(
  desktopPath: string,
  prefixes: readonly string[]
): Promise<void> {
  const entries = await readdir(desktopPath, { withFileTypes: true }).catch(() => []);
  const removalTasks = entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        prefixes.some((prefix) => entry.name.startsWith(prefix))
    )
    .map((entry) =>
      rm(path.join(desktopPath, entry.name), {
        recursive: true,
        force: true
      }).catch(() => undefined)
    );
  await Promise.all(removalTasks);
}

async function removeRuntimeArtifactsByPrefix(
  runtimePath: string,
  prefixes: readonly string[]
): Promise<void> {
  const entries = await readdir(runtimePath, { withFileTypes: true }).catch(() => []);
  const removalTasks = entries
    .filter((entry) => prefixes.some((prefix) => entry.name.startsWith(prefix)))
    .map((entry) =>
      rm(path.join(runtimePath, entry.name), {
        recursive: true,
        force: true
      }).catch(() => undefined)
    );
  await Promise.all(removalTasks);
}

function cloneSessionSnapshot(session: ConversationSession): ConversationSession {
  return JSON.parse(JSON.stringify(session)) as ConversationSession;
}

function createNotifierTransport(notificationSink: CapturedNotification[]): ConversationNotifierTransport {
  let nextMessageId = 1;
  const capture = async (phase: "send" | "edit", text: string, messageId?: string): Promise<ConversationDeliveryResult> => {
    const resolvedMessageId = messageId ?? `msg-${nextMessageId++}`;
    notificationSink.push({ phase, messageId: resolvedMessageId, text, at: new Date().toISOString() });
    console.log(`[notify/${phase}:${resolvedMessageId}] ${text}`);
    return { ok: true, messageId: resolvedMessageId, errorCode: null };
  };
  return {
    capabilities: { supportsEdit: true, supportsNativeStreaming: false },
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
        console.log(`[heartbeat:${turnLabel}] runningJob=${session.runningJobId ?? "null"} queued=${session.queuedJobs.length} progress=${session.progressState?.status ?? "none"}:${session.progressState?.message ?? ""}`);
        lastHeartbeatAt = now;
      }

      const matchingJobs = session.recentJobs.filter(
        (job) => job.createdAt >= turnStartedAt
      );
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

/**
 * Awaits one best-effort cleanup operation without letting teardown hang indefinitely.
 *
 * @param operation - Cleanup promise to bound.
 */
async function awaitCleanup(operation: Promise<unknown>): Promise<void> {
  await Promise.race([
    operation.then(() => undefined).catch(() => undefined),
    sleep(CLEANUP_STEP_TIMEOUT_MS)
  ]);
}

function latestAssistantReply(session: ConversationSession): string {
  return [...session.conversationTurns].reverse().find((turn) => turn.role === "assistant")?.text ?? "";
}

async function isPreviewReachable(url: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(url, 5_000);
    return response.ok;
  } catch {
    return false;
  }
}

function buildCompletedConversationJob(id: string, input: string, createdAt: string, completedAt: string, resultSummary: string): ConversationJob {
  return {
    id,
    input,
    executionInput: input,
    createdAt,
    startedAt: createdAt,
    completedAt,
    status: "completed",
    resultSummary,
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

function buildApprovedActionResult(action: PlannedAction, outcome: ExecutorExecutionOutcome): ActionRunResult {
  return { action, mode: "fast_path", approved: true, output: outcome.output, executionStatus: outcome.status, executionFailureCode: outcome.failureCode, executionMetadata: outcome.executionMetadata, blockedBy: [], violations: [], votes: [] };
}

function buildSeededWriteFileActionResult(actionId: string, filePath: string, content: string): ActionRunResult {
  return {
    action: { id: actionId, type: "write_file", description: `Write ${path.basename(filePath)}`, params: { path: filePath, content }, estimatedCostUsd: 0.02 },
    mode: "fast_path",
    approved: true,
    output: `Write success: ${filePath} (${content.length} chars)`,
    executionStatus: "success",
    executionMetadata: { filePath },
    blockedBy: [],
    violations: [],
    votes: []
  };
}

function buildFixtureHtml(title: string, heading: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:"Segoe UI",sans-serif;background:linear-gradient(135deg,#0f172a,#1d4ed8 55%,#38bdf8);color:#f8fafc}main{width:min(720px,92vw);padding:3rem;border-radius:24px;background:rgba(15,23,42,.72);box-shadow:0 30px 80px rgba(15,23,42,.35)}h1{margin:0 0 1rem;font-size:clamp(2rem,5vw,3.25rem)}p{margin:0;font-size:1.05rem;line-height:1.7}</style></head><body><main><h1>${heading}</h1><p>This seeded preview holder exists only to prove lock-aware recovery for project organization.</p></main></body></html>`;
}

async function waitForSeededProcessSpawn(
  child: ReturnType<typeof spawn>,
  timeoutMs: number
): Promise<void> {
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
      finalize(() => reject(new Error(`Seeded process exited before startup completed (${code ?? "no-exit-code"}${signal ? `, signal ${signal}` : ""}).`)));
    });
  });
}

async function seedPreviewHolder(
  executor: ToolExecutorOrgan,
  managedProcessRegistry: ManagedProcessRegistry,
  folderName: string,
  folderPath: string,
  title: string,
  heading: string
): Promise<SeededPreviewHolder> {
  await rm(folderPath, { recursive: true, force: true });
  await mkdir(folderPath, { recursive: true });
  const indexPath = path.join(folderPath, "index.html");
  const html = buildFixtureHtml(title, heading);
  await writeFile(indexPath, html, "utf8");
  const port = await findAvailableLoopbackPort();
  assert.ok(port, `No free loopback port was available for ${folderName}.`);
  const previewUrl = `http://localhost:${port}/index.html`;
  const createdAt = new Date().toISOString();
  const taskId = `seed_preview_${folderName}`;
  const prompt = `Please build a small drone project in a folder called ${folderName} and leave the preview open for me.`;
  const command = `python -m http.server ${port} --bind 127.0.0.1`;
  const child = spawn("python", ["-m", "http.server", String(port), "--bind", "127.0.0.1"], {
    cwd: folderPath,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.resume();
  child.stderr?.resume();
  await waitForSeededProcessSpawn(child, 2_000);
  const snapshot = managedProcessRegistry.registerStarted({
    actionId: `${taskId}:start_process`,
    child,
    commandFingerprint: hashSha256(command),
    cwd: folderPath,
    shellExecutable: "python",
    shellKind: "direct",
    taskId
  });
  const readiness = await waitForLocalHttpReadiness(new URL(previewUrl), 15_000, null);
  assert.equal(readiness.ready, true, `Failed to prove preview readiness for ${folderName}: observedStatus=${readiness.observedStatus ?? "none"} attempts=${readiness.attempts}`);
  const openBrowserAction: PlannedAction = {
    id: `${taskId}:open_browser`,
    type: "open_browser",
    description: `Open preview browser for ${folderName}`,
    params: {
      url: previewUrl,
      timeoutMs: 15_000,
      rootPath: folderPath,
      previewProcessLeaseId: snapshot.leaseId
    },
    estimatedCostUsd: 0.03
  };
  const openBrowserOutcome = await executor.executeWithOutcome(openBrowserAction, undefined, taskId);
  assert.equal(openBrowserOutcome.status, "success", `Failed to open preview browser for ${folderName}: ${openBrowserOutcome.output}`);
  const startAction: PlannedAction = { id: `${taskId}:start_process`, type: "start_process", description: `Start preview server for ${folderName}`, params: { command, cwd: folderPath }, estimatedCostUsd: 0.08 };
  const probeAction: PlannedAction = { id: `${taskId}:probe_http`, type: "probe_http", description: `Wait for preview readiness for ${folderName}`, params: { url: previewUrl, timeoutMs: 15_000 }, estimatedCostUsd: 0.02 };
  const processLeaseId = snapshot.leaseId;
  const browserSessionId = String(openBrowserOutcome.executionMetadata?.browserSessionId ?? "");
  assert.ok(processLeaseId, `Missing process lease id for ${folderName}.`);
  assert.ok(browserSessionId, `Missing browser session id for ${folderName}.`);
  const completedAt = new Date().toISOString();
  return {
    folderName,
    folderPath,
    previewUrl,
    processLeaseId,
    browserSessionId,
    prompt,
    taskRunResult: {
      task: { id: taskId, goal: prompt, userInput: prompt, createdAt },
      plan: { taskId, plannerNotes: "Seeded preview holder for the organization recovery smoke.", actions: [startAction, probeAction, openBrowserAction] },
      actionResults: [
        buildSeededWriteFileActionResult(`${taskId}:write_file`, indexPath, html),
        {
          action: startAction,
          mode: "fast_path",
          approved: true,
          output: `Process started: lease ${snapshot.leaseId} (pid ${snapshot.pid ?? "unknown"}).`,
          executionStatus: "success",
          executionMetadata: buildManagedProcessExecutionMetadata(snapshot, "PROCESS_STARTED"),
          blockedBy: [],
          violations: [],
          votes: []
        },
        {
          action: probeAction,
          mode: "fast_path",
          approved: true,
          output: `HTTP ready: ${previewUrl} responded with expected status ${readiness.observedStatus ?? 200}.`,
          executionStatus: "success",
          executionMetadata: buildReadinessProbeExecutionMetadata({
            probeKind: "http",
            ready: true,
            lifecycleCode: "PROCESS_READY",
            url: previewUrl,
            host: "localhost",
            port,
            timeoutMs: 15_000,
            attempts: readiness.attempts,
            expectedStatus: null,
            observedStatus: readiness.observedStatus
          }),
          blockedBy: [],
          violations: [],
          votes: []
        },
        buildApprovedActionResult(openBrowserAction, openBrowserOutcome)
      ],
      summary: openBrowserOutcome.output,
      startedAt: createdAt,
      completedAt
    },
    createdAt,
    completedAt
  };
}

async function seedPlainProjectFolder(
  folderName: string,
  folderPath: string,
  title: string,
  heading: string
): Promise<SeededProjectFolder> {
  await rm(folderPath, { recursive: true, force: true });
  await mkdir(folderPath, { recursive: true });
  const indexPath = path.join(folderPath, "index.html");
  const html = buildFixtureHtml(title, heading);
  await writeFile(indexPath, html, "utf8");
  const createdAt = new Date().toISOString();
  const prompt = `Please build a small drone project in a folder called ${folderName}.`;
  const taskId = `seed_project_${folderName}`;
  const completedAt = new Date().toISOString();
  return {
    folderName,
    folderPath,
    prompt,
    taskRunResult: {
      task: { id: taskId, goal: prompt, userInput: prompt, createdAt },
      plan: {
        taskId,
        plannerNotes: "Seeded plain project folder for the organization recovery smoke.",
        actions: [
          {
            id: `${taskId}:write_file`,
            type: "write_file",
            description: `Write ${path.basename(indexPath)}`,
            params: { path: indexPath, content: html },
            estimatedCostUsd: 0.02
          }
        ]
      },
      actionResults: [
        buildSeededWriteFileActionResult(`${taskId}:write_file`, indexPath, html)
      ],
      summary: `Created ${indexPath} for you.`,
      startedAt: createdAt,
      completedAt
    },
    createdAt,
    completedAt
  };
}

async function seedConversationState(
  store: InterfaceSessionStore,
  conversationKey: string,
  folders: readonly SeededProjectFolder[]
): Promise<void> {
  const session = normalizeSession({ conversationId: conversationKey, userId: USER_ID, username: USERNAME, conversationVisibility: "private", updatedAt: new Date().toISOString() });
  assert.ok(session, "Failed to create the seeded smoke session.");
  for (const folder of folders) {
    recordUserTurn(session, folder.prompt, folder.createdAt, 50);
    persistExecutedJobOutcome({
      session,
      executedJob: buildCompletedConversationJob(`seed_job_${folder.folderName}`, folder.prompt, folder.createdAt, folder.completedAt, folder.taskRunResult.summary),
      executionResult: { summary: folder.taskRunResult.summary, taskRunResult: folder.taskRunResult },
      maxRecentJobs: 20,
      maxRecentActions: 20,
      maxBrowserSessions: 10,
      maxPathDestinations: 10,
      maxConversationTurns: 50
    });
  }
  await store.setSession(session);
}

async function cleanupSeededPreviewHolders(executor: ToolExecutorOrgan, holders: readonly SeededPreviewHolder[]): Promise<void> {
  for (const holder of holders) {
    await awaitCleanup(executor.executeWithOutcome({ id: `cleanup:${holder.browserSessionId}:close_browser`, type: "close_browser", description: `Close ${holder.folderName} browser`, params: { sessionId: holder.browserSessionId }, estimatedCostUsd: 0.01 }));
    await awaitCleanup(executor.executeWithOutcome({ id: `cleanup:${holder.processLeaseId}:stop_process`, type: "stop_process", description: `Stop ${holder.folderName} preview process`, params: { leaseId: holder.processLeaseId }, estimatedCostUsd: 0.01 }));
  }
}

function extractOpenBrowserSessionIds(session: ConversationSession | null): string[] {
  if (!session) {
    return [];
  }
  const sessionIds = new Set<string>();
  for (const browserSession of session.browserSessions) {
    if (browserSession.status === "open") {
      sessionIds.add(browserSession.id);
    }
  }
  for (const browserSessionId of session.activeWorkspace?.browserSessionIds ?? []) {
    if (browserSessionId.trim().length > 0) {
      sessionIds.add(browserSessionId);
    }
  }
  return [...sessionIds];
}

function extractTrackedProcessLeaseIds(session: ConversationSession | null): string[] {
  if (!session) {
    return [];
  }
  const leaseIds = new Set<string>();
  for (const browserSession of session.browserSessions) {
    if (browserSession.linkedProcessLeaseId) {
      leaseIds.add(browserSession.linkedProcessLeaseId);
    }
  }
  for (const previewProcessLeaseId of session.activeWorkspace?.previewProcessLeaseIds ?? []) {
    if (previewProcessLeaseId.trim().length > 0) {
      leaseIds.add(previewProcessLeaseId);
    }
  }
  return [...leaseIds];
}

function findProviderBlockerReason(session: ConversationSession | null): string | null {
  if (!session) {
    return null;
  }
  const blockedJob = [...session.recentJobs]
    .reverse()
    .find(
      (job) =>
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
        PROVIDER_BLOCK_PATTERN.test(turn.text)
    );
  return assistantTurn?.text ?? null;
}

async function cleanupRuntimeSessionResources(
  config: ReturnType<typeof createBrainConfigFromEnv>,
  session: ConversationSession | null
): Promise<void> {
  if (!session) {
    return;
  }
  const browserSessionRegistry = new BrowserSessionRegistry({
    snapshotPath: BROWSER_SESSION_SNAPSHOT_PATH
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

  for (const browserSessionId of extractOpenBrowserSessionIds(session)) {
    await awaitCleanup(cleanupExecutor.executeWithOutcome({
      id: `cleanup_runtime:${browserSessionId}:close_browser`,
      type: "close_browser",
      description: `Close lingering smoke browser session ${browserSessionId}.`,
      params: {
        sessionId: browserSessionId
      },
      estimatedCostUsd: 0.01
    }));
  }

  for (const leaseId of extractTrackedProcessLeaseIds(session)) {
    await awaitCleanup(cleanupExecutor.executeWithOutcome({
      id: `cleanup_runtime:${leaseId}:stop_process`,
      type: "stop_process",
      description: `Stop lingering smoke preview process ${leaseId}.`,
      params: {
        leaseId
      },
      estimatedCostUsd: 0.01
    }));
  }
}

async function collectPostCleanupChecks(
  holders: readonly SeededPreviewHolder[]
): Promise<Artifact["cleanupChecks"]> {
  const browserSessionRegistry = new BrowserSessionRegistry({
    snapshotPath: BROWSER_SESSION_SNAPSHOT_PATH
  });
  const managedProcessRegistry = new ManagedProcessRegistry({
    snapshotPath: MANAGED_PROCESS_SNAPSHOT_PATH
  });
  const browserSnapshots = browserSessionRegistry.listSnapshots();
  const managedSnapshots = managedProcessRegistry.listSnapshots();
  const previewsStoppedAfterCleanup =
    (await Promise.all(
      holders.map(async (holder) => !(await isPreviewReachable(holder.previewUrl)))
    )).every(Boolean) &&
    holders.every((holder) => {
      const managedSnapshot = managedSnapshots.find(
        (snapshot) =>
          snapshot.leaseId === holder.processLeaseId || snapshot.cwd === holder.folderPath
      );
      return !managedSnapshot || managedSnapshot.statusCode === "PROCESS_STOPPED";
    });
  const browserSessionsClosedAfterCleanup = holders.every((holder) => {
    const browserSnapshot = browserSnapshots.find(
      (snapshot) => snapshot.sessionId === holder.browserSessionId
    );
    return !browserSnapshot || browserSnapshot.status === "closed";
  });
  return {
    previewsStoppedAfterCleanup,
    browserSessionsClosedAfterCleanup,
    trackedRuntimeHandlesClosedAfterCleanup:
      previewsStoppedAfterCleanup && browserSessionsClosedAfterCleanup
  };
}

async function collectSettledPostCleanupChecks(
  holders: readonly SeededPreviewHolder[],
  timeoutMs = CLEANUP_SETTLE_TIMEOUT_MS
): Promise<Artifact["cleanupChecks"]> {
  const deadlineAt = Date.now() + timeoutMs;
  let latestChecks = holders.length > 0
    ? await collectPostCleanupChecks(holders)
    : buildFallbackCleanupChecks();
  while (!latestChecks.trackedRuntimeHandlesClosedAfterCleanup && Date.now() < deadlineAt) {
    await sleep(200);
    latestChecks = holders.length > 0
      ? await collectPostCleanupChecks(holders)
      : buildFallbackCleanupChecks();
  }
  return latestChecks;
}

function buildFallbackCleanupChecks(): Artifact["cleanupChecks"] {
  try {
    const browserSessionRegistry = new BrowserSessionRegistry({
      snapshotPath: BROWSER_SESSION_SNAPSHOT_PATH
    });
    const managedProcessRegistry = new ManagedProcessRegistry({
      snapshotPath: MANAGED_PROCESS_SNAPSHOT_PATH
    });
    const browserSessionsClosedAfterCleanup = browserSessionRegistry
      .listSnapshots()
      .every((snapshot) => snapshot.status === "closed");
    const previewsStoppedAfterCleanup = managedProcessRegistry
      .listSnapshots()
      .every((snapshot) => snapshot.statusCode === "PROCESS_STOPPED");
    return {
      previewsStoppedAfterCleanup,
      browserSessionsClosedAfterCleanup,
      trackedRuntimeHandlesClosedAfterCleanup:
        previewsStoppedAfterCleanup && browserSessionsClosedAfterCleanup
    };
  } catch {
    return {
      previewsStoppedAfterCleanup: false,
      browserSessionsClosedAfterCleanup: false,
      trackedRuntimeHandlesClosedAfterCleanup: false
    };
  }
}

function buildBlockedOrganizationArtifact(blockerReason: string): Artifact {
  const localIntentModel: LocalIntentProof = {
    enabled: false,
    required: false,
    reachable: false,
    modelPresent: false,
    model: "unknown",
    provider: "unknown",
    baseUrl: ""
  };
  const desktopPath = path.join(os.homedir(), "OneDrive", "Desktop");
  const targetRootName = `drone-web-projects-organize-smoke-${RUN_ID}`;
  return {
    generatedAt: new Date().toISOString(),
    command: COMMAND_NAME,
    status: PROVIDER_BLOCK_PATTERN.test(blockerReason) ? "BLOCKED" : "FAIL",
    blockerReason,
    localIntentModel,
    prompts: {
    organize: `Please take this from start to finish: move the earlier drone-company-organize-smoke project folders into a folder called ${targetRootName} on my desktop.`,
      retry: "Yes, shut them down and retry the move."
    },
    seededPreviewHolders: [],
    targetRoot: path.join(desktopPath, targetRootName),
    movedEntries: [],
    remainingDesktopMatches: [],
    checks: {
      routedAutonomous: false,
      previewsSeeded: false,
      recoveryClarificationAsked: false,
      autoRecoveredWithoutClarification: false,
      foldersMoved: false,
      previewsStopped: false,
      browserSessionsClosed: false
    },
    cleanupChecks: buildFallbackCleanupChecks(),
    turns: []
  };
}

let fatalSmokeErrorHandled = false;
let lastFatalOrganizeSmokeMessage: string | null = null;
let currentRunArtifactWritten = false;
let fatalCleanupConfig: ReturnType<typeof createBrainConfigFromEnv> | null = null;
let fatalCleanupExecutor: ToolExecutorOrgan | null = null;
let fatalSeededPreviewHolders: SeededPreviewHolder[] = [];
let fatalSeededProjectFolders: SeededProjectFolder[] = [];
let fatalLatestSession: ConversationSession | null = null;
let fatalDesktopPath: string | null = null;
let fatalTargetRootPath: string | null = null;

async function handleFatalOrganizeSmokeError(error: unknown): Promise<void> {
  if (fatalSmokeErrorHandled) {
    return;
  }
  fatalSmokeErrorHandled = true;
  const blockerReason = error instanceof Error ? error.stack ?? error.message : String(error);
  lastFatalOrganizeSmokeMessage = blockerReason;
  if (currentRunArtifactWritten) {
    console.error(blockerReason);
    return;
  }
  if (fatalCleanupConfig) {
    await cleanupRuntimeSessionResources(fatalCleanupConfig, fatalLatestSession).catch(() => undefined);
  }
  if (fatalCleanupExecutor && fatalSeededPreviewHolders.length > 0) {
    await cleanupSeededPreviewHolders(fatalCleanupExecutor, fatalSeededPreviewHolders).catch(
      () => undefined
    );
  }
  await cleanupLingeringPlaywrightAutomationBrowsers().catch(() => undefined);
  const artifact = buildBlockedOrganizationArtifact(blockerReason);
  artifact.cleanupChecks = await collectSettledPostCleanupChecks(fatalSeededPreviewHolders).catch(
    () => buildFallbackCleanupChecks()
  );
  await writeFile(
    ARTIFACT_PATH,
    `${JSON.stringify(artifact, null, 2)}${os.EOL}`,
    "utf8"
  )
    .then(() => {
      currentRunArtifactWritten = true;
    })
    .catch(() => undefined);
  if (fatalTargetRootPath) {
    await rm(fatalTargetRootPath, { recursive: true, force: true }).catch(() => undefined);
  }
  if (fatalDesktopPath) {
    await removeSmokeFoldersByPrefix(fatalDesktopPath, [
      "drone-company-organize-smoke-"
    ]).catch(() => undefined);
  }
  await rm(LIVE_RUN_RUNTIME_PATH, { recursive: true, force: true }).catch(() => undefined);
  await rm(STATE_PATH, { force: true }).catch(() => undefined);
  await rm(`${STATE_PATH}.lock`, { force: true }).catch(() => undefined);
  await rm(LEDGER_SQLITE_PATH, { force: true }).catch(() => undefined);
  await rm(`${LEDGER_SQLITE_PATH}-shm`, { force: true }).catch(() => undefined);
  await rm(`${LEDGER_SQLITE_PATH}-wal`, { force: true }).catch(() => undefined);
  console.error(blockerReason);
}

function writeFallbackOrganizationArtifactSync(blockerReason: string): void {
  if (currentRunArtifactWritten) {
    return;
  }
  try {
    mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
    writeFileSync(
      ARTIFACT_PATH,
      `${JSON.stringify(buildBlockedOrganizationArtifact(blockerReason), null, 2)}${os.EOL}`,
      "utf8"
    );
    currentRunArtifactWritten = true;
  } catch {
    // Best effort only. The process is already exiting.
  }
}

function refreshExistingOrganizationArtifactCleanupChecksSync(): void {
  if (!existsSync(ARTIFACT_PATH)) {
    return;
  }
  try {
    const persistedArtifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) as Artifact;
    persistedArtifact.cleanupChecks = buildFallbackCleanupChecks();
    writeFileSync(
      ARTIFACT_PATH,
      `${JSON.stringify(persistedArtifact, null, 2)}${os.EOL}`,
      "utf8"
    );
    currentRunArtifactWritten = true;
  } catch {
    // Best effort only. The process is already exiting.
  }
}

function scheduleForcedFailureExit(delayMs = 5_000): void {
  const timer = setTimeout(() => {
    process.exit(1);
  }, delayMs);
  timer.unref();
}

function terminatePidSync(pid: number | null): void {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      return;
    }
    process.kill(pid, "SIGTERM");
  } catch {
    // Best effort only during crash cleanup.
  }
}

function performEmergencyOrganizeSmokeCleanupSync(): void {
  try {
    if (existsSync(MANAGED_PROCESS_SNAPSHOT_PATH)) {
      const persisted = JSON.parse(readFileSync(MANAGED_PROCESS_SNAPSHOT_PATH, "utf8")) as {
        snapshots?: Array<{ pid?: number | null; statusCode?: string }>;
      };
      for (const snapshot of persisted.snapshots ?? []) {
        if (snapshot?.statusCode !== "PROCESS_STOPPED") {
          terminatePidSync(
            typeof snapshot?.pid === "number" && Number.isInteger(snapshot.pid)
              ? snapshot.pid
              : null
          );
        }
      }
    }
  } catch {
    // Best effort only during crash cleanup.
  }

  try {
    if (existsSync(BROWSER_SESSION_SNAPSHOT_PATH)) {
      const persisted = JSON.parse(readFileSync(BROWSER_SESSION_SNAPSHOT_PATH, "utf8")) as {
        sessions?: Array<{ browserProcessPid?: number | null; status?: string }>;
      };
      for (const session of persisted.sessions ?? []) {
        if (session?.status === "open") {
          terminatePidSync(
            typeof session?.browserProcessPid === "number" &&
              Number.isInteger(session.browserProcessPid)
              ? session.browserProcessPid
              : null
          );
        }
      }
    }
  } catch {
    // Best effort only during crash cleanup.
  }
  try {
    new ManagedProcessRegistry({
      snapshotPath: MANAGED_PROCESS_SNAPSHOT_PATH
    }).listSnapshots();
  } catch {
    // Best effort only during crash cleanup.
  }
  try {
    new BrowserSessionRegistry({
      snapshotPath: BROWSER_SESSION_SNAPSHOT_PATH
    }).listSnapshots();
  } catch {
    // Best effort only during crash cleanup.
  }
}

function removeSmokeArtifactsSync(): void {
  try {
    rmSync(fatalTargetRootPath ?? "", { recursive: true, force: true });
  } catch {
    // Best effort only during crash cleanup.
  }
  for (const holder of fatalSeededPreviewHolders) {
    try {
      rmSync(holder.folderPath, { recursive: true, force: true });
    } catch {
      // Best effort only during crash cleanup.
    }
  }
  for (const folder of fatalSeededProjectFolders) {
    try {
      rmSync(folder.folderPath, { recursive: true, force: true });
    } catch {
      // Best effort only during crash cleanup.
    }
  }
  try {
    rmSync(LIVE_RUN_RUNTIME_PATH, { recursive: true, force: true });
  } catch {
    // Best effort only during crash cleanup.
  }
  try {
    rmSync(STATE_PATH, { force: true });
  } catch {
    // Best effort only during crash cleanup.
  }
  try {
    rmSync(`${STATE_PATH}.lock`, { force: true });
  } catch {
    // Best effort only during crash cleanup.
  }
  try {
    rmSync(LEDGER_SQLITE_PATH, { force: true });
    rmSync(`${LEDGER_SQLITE_PATH}-shm`, { force: true });
    rmSync(`${LEDGER_SQLITE_PATH}-wal`, { force: true });
  } catch {
    // Best effort only during crash cleanup.
  }
}

async function runTurn(turn: number, userInput: string, receivedAt: string, manager: ConversationManager, store: InterfaceSessionStore, adapter: TelegramAdapter, conversationKey: string, abortControllers: Map<string, AbortController>, turns: TurnCapture[], deadlineAtMs: number): Promise<ConversationSession> {
  const notifications: CapturedNotification[] = [];
  const notifier = createNotifierTransport(notifications);
  const executeTask = async (taskInput: string, taskReceivedAt: string): Promise<ConversationExecutionResult> => {
    const autonomousGoal = parseAutonomousExecutionInput(taskInput);
    if (autonomousGoal) {
      return runAutonomousTransportTask({
        conversationId: conversationKey,
        goal: autonomousGoal.goal,
        initialExecutionInput: autonomousGoal.initialExecutionInput,
        receivedAt: taskReceivedAt,
        notifier,
        abortControllers,
        runAutonomousTask: async (goal, startedAt, progressSender, signal, initialExecutionInput) =>
          adapter.runAutonomousTask(goal, startedAt, progressSender, signal, initialExecutionInput)
      });
    }
    const runResult = await adapter.runTextTask(taskInput, taskReceivedAt);
    return { summary: selectUserFacingSummary(runResult, { showTechnicalSummary: false, showSafetyCodes: false }), taskRunResult: runResult };
  };
  console.log(`\n=== TURN ${turn} USER ===\n${userInput}\n`);
  const immediateReply = await manager.handleMessage(buildMessage(userInput, receivedAt), executeTask, notifier);
  console.log(`=== TURN ${turn} IMMEDIATE REPLY ===\n${immediateReply}`);
  try {
    const session = await waitForTurnCompletion(
      store,
      conversationKey,
      `turn_${turn}`,
      receivedAt,
      getRemainingSmokeBudget(deadlineAtMs, TURN_TIMEOUT_MS, `turn ${turn}`)
    );
    const snapshot = cloneSessionSnapshot(session);
    console.log(`=== TURN ${turn} SESSION SNAPSHOT ===\n${JSON.stringify({ runningJobId: snapshot.runningJobId, queuedJobs: snapshot.queuedJobs.length, progressState: snapshot.progressState, activeClarification: snapshot.activeClarification, recentActions: snapshot.recentActions, browserSessions: snapshot.browserSessions, pathDestinations: snapshot.pathDestinations, activeWorkspace: snapshot.activeWorkspace, modeContinuity: snapshot.modeContinuity }, null, 2)}`);
    turns.push({ turn, user: userInput, immediateReply, notifications, sessionSnapshot: snapshot });
    return snapshot;
  } catch (error) {
    const partialSession = await store.getSession(conversationKey).catch(() => null);
    if (partialSession) {
      turns.push({
        turn,
        user: userInput,
        immediateReply,
        notifications,
        sessionSnapshot: cloneSessionSnapshot(partialSession)
      });
    }
    throw error;
  }
}

async function main(): Promise<void> {
  ensureEnvLoaded();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await rm(ARTIFACT_PATH, { force: true }).catch(() => undefined);
  currentRunArtifactWritten = false;
  await cleanupLingeringPlaywrightAutomationBrowsers().catch(() => undefined);
  await rm(SESSION_PATH, { force: true });
  const deadlineAtMs = Date.now() + SMOKE_DEADLINE_MS;
  const previousEnv = applyEnvOverrides({
    BRAIN_LIVE_RUN_RUNTIME_PATH: LIVE_RUN_RUNTIME_PATH,
    BRAIN_STATE_JSON_PATH: STATE_PATH,
    BRAIN_LEDGER_SQLITE_PATH: LEDGER_SQLITE_PATH,
    BRAIN_LEDGER_EXPORT_JSON_ON_WRITE: "false",
    BRAIN_ENABLE_EMBEDDINGS: "false",
    BRAIN_ENABLE_DYNAMIC_PULSE: "false"
  });
  let smokeModelSnapshot: EnvSnapshot | null = null;
  let config: ReturnType<typeof createBrainConfigFromEnv> | null = null;
  let setupExecutor: ToolExecutorOrgan | null = null;
  const seededPreviewHolders: SeededPreviewHolder[] = [];
  const seededProjectFolders: SeededProjectFolder[] = [];
  let latestSession: ConversationSession | null = null;
  let desktopPath: string | null = null;
  let targetRootPath: string | null = null;
  let artifact: Artifact | null = null;
  fatalSeededPreviewHolders = seededPreviewHolders;
  fatalSeededProjectFolders = seededProjectFolders;
  fatalLatestSession = null;
  fatalCleanupConfig = null;
  fatalCleanupExecutor = null;
  fatalDesktopPath = null;
  fatalTargetRootPath = null;

  try {
    try {
    const localProbe = await probeLocalIntentModelFromEnv();
    if (localProbe.enabled && localProbe.liveSmokeRequired && !isLocalIntentModelRuntimeReady(localProbe)) {
      throw new Error(`Local intent model is required for this smoke but not ready: provider=${localProbe.provider} model=${localProbe.model} reachable=${localProbe.reachable} modelPresent=${localProbe.modelPresent}`);
    }
    smokeModelSnapshot = applyEnvOverrides(buildSmokeModelEnvOverrides(localProbe).envOverrides);

    config = createBrainConfigFromEnv();
    fatalCleanupConfig = config;
    if (!config.permissions.allowRealShellExecution) {
      throw new Error("This live smoke requires BRAIN_ENABLE_REAL_SHELL=true.");
    }

    desktopPath = path.join(os.homedir(), "OneDrive", "Desktop");
    fatalDesktopPath = desktopPath;
    await removeRuntimeArtifactsByPrefix(path.resolve(process.cwd(), "runtime"), [
      "tmp-organize-live-run-",
      "tmp-organize-session-",
      "tmp-organize-state-",
      "tmp-organize-ledgers-"
    ]);
    await removeSmokeFoldersByPrefix(desktopPath, [
      "drone-company-organize-smoke-",
      "drone-web-projects-organize-smoke-"
    ]);
    const sourceFolderAName = `drone-company-organize-smoke-${RUN_ID}-a`;
    const sourceFolderBName = `drone-company-organize-smoke-${RUN_ID}-b`;
    const sourceFolderAPath = path.join(desktopPath, sourceFolderAName);
    const sourceFolderBPath = path.join(desktopPath, sourceFolderBName);
    const targetRootName = `drone-web-projects-organize-smoke-${RUN_ID}`;
    targetRootPath = path.join(desktopPath, targetRootName);
    fatalTargetRootPath = targetRootPath;
    const organizePrompt = `Please take this from start to finish: move the earlier drone-company-organize-smoke project folders into a folder called ${targetRootName} on my desktop.`;
    const retryPrompt = "Yes, shut them down and retry the move.";

    const managedProcessRegistry = new ManagedProcessRegistry({ snapshotPath: MANAGED_PROCESS_SNAPSHOT_PATH });
    const browserSessionRegistry = new BrowserSessionRegistry({ snapshotPath: BROWSER_SESSION_SNAPSHOT_PATH });
    setupExecutor = new ToolExecutorOrgan(config, undefined, managedProcessRegistry, undefined, browserSessionRegistry);
    fatalCleanupExecutor = setupExecutor;

    const previewHolder = await seedPreviewHolder(
      setupExecutor,
      managedProcessRegistry,
      sourceFolderAName,
      sourceFolderAPath,
      "Drone Company Preview A",
      "Drone Project Alpha"
    );
    const plainProjectFolder = await seedPlainProjectFolder(
      sourceFolderBName,
      sourceFolderBPath,
      "Drone Company Project B",
      "Drone Project Beta"
    );
    seededPreviewHolders.push(previewHolder);
    seededProjectFolders.push(previewHolder, plainProjectFolder);
    assert.equal(await isPreviewReachable(previewHolder.previewUrl), true, "Preview A did not become reachable.");

    const brain = buildDefaultBrain();
    const adapter = new TelegramAdapter(brain, {
      auth: { requiredToken: "shared-secret" },
      allowlist: { allowedUsernames: [USERNAME], allowedUserIds: [USER_ID], allowedChatIds: [CONVERSATION_ID] },
      rateLimit: { windowMs: 60_000, maxEventsPerWindow: 50 },
      replay: { maxTrackedUpdateIds: 200 }
    });
    const store = new InterfaceSessionStore(SESSION_PATH);
    const conversationKey = buildConversationKey({ provider: "telegram", conversationId: CONVERSATION_ID, userId: USER_ID, username: USERNAME, conversationVisibility: "private", receivedAt: new Date().toISOString() });
    await seedConversationState(store, conversationKey, seededProjectFolders);

    const manager = new ConversationManager(
      store,
      { allowAutonomousViaInterface: true, ackDelayMs: 300, heartbeatIntervalMs: 5_000, maxConversationTurns: 50, maxContextTurnsForExecution: 12 },
      {
        interpretConversationIntent: async (input, recentTurns, pulseRuleContext) => adapter.interpretConversationIntent(input, recentTurns, pulseRuleContext),
        localIntentModelResolver: createLocalIntentModelResolverFromEnv(),
        listManagedProcessSnapshots: async () => adapter.listManagedProcessSnapshots(),
        listBrowserSessionSnapshots: async () => adapter.listBrowserSessionSnapshots(),
        listAvailableSkills: async () => [],
        describeRuntimeCapabilities: async () => CAPABILITY_SUMMARY_FIXTURE
      }
    );

    const turns: TurnCapture[] = [];
    const abortControllers = new Map<string, AbortController>();
    const sessionAfterTurn1 = await runTurn(1, organizePrompt, new Date().toISOString(), manager, store, adapter, conversationKey, abortControllers, turns, deadlineAtMs);
    latestSession = sessionAfterTurn1;
    fatalLatestSession = latestSession;
    const recoveryClarificationAsked =
      sessionAfterTurn1.activeClarification?.kind === "task_recovery" &&
      /shut down the matching preview holders|retry the move/i.test(latestAssistantReply(sessionAfterTurn1));
    const autoRecoveredWithoutClarification =
      !recoveryClarificationAsked &&
      sessionAfterTurn1.recentActions.some(
        (action) => action.kind === "process" && action.status === "closed"
      );

    const finalSession = recoveryClarificationAsked
      ? await runTurn(2, retryPrompt, new Date(Date.now() + 5_000).toISOString(), manager, store, adapter, conversationKey, abortControllers, turns, deadlineAtMs)
      : sessionAfterTurn1;
    latestSession = finalSession;
    fatalLatestSession = latestSession;
    const movedEntries = (await readdir(targetRootPath).catch(() => [])).filter((name) => name.startsWith("drone-company-organize-smoke-"));
    const remainingDesktopMatches = (await Promise.all([sourceFolderAPath, sourceFolderBPath].map(async (candidatePath) => (await stat(candidatePath).catch(() => null))?.isDirectory() ? path.basename(candidatePath) : null))).filter((value): value is string => value !== null);
    const liveManagedProcesses = (await adapter.listManagedProcessSnapshots()).filter((snapshot) => snapshot.statusCode !== "PROCESS_STOPPED").filter((snapshot) => seededPreviewHolders.some((holder) => snapshot.cwd === holder.folderPath));
    const liveBrowserSessions = await adapter.listBrowserSessionSnapshots();
    const previewStopped = (await Promise.all(seededPreviewHolders.map(async (holder) => !(await isPreviewReachable(holder.previewUrl))))).every(Boolean) && liveManagedProcesses.length === 0;
    const browserSessionsClosed = seededPreviewHolders.every((holder) => {
      const liveBrowserSession = liveBrowserSessions.find((session) => session.sessionId === holder.browserSessionId);
      if (liveBrowserSession) {
        return liveBrowserSession.status === "closed";
      }
      const browserSession = finalSession.browserSessions.find(
        (session) => session.id === holder.browserSessionId
      );
      if (browserSession?.status === "closed") {
        return true;
      }
      const workspaceOwnsHolderSession =
        finalSession.activeWorkspace?.browserSessionId === holder.browserSessionId ||
        finalSession.activeWorkspace?.browserSessionIds.includes(holder.browserSessionId) === true;
      return workspaceOwnsHolderSession && finalSession.activeWorkspace?.browserSessionStatus === "closed";
    });
    const previewsSeeded = seededPreviewHolders.every((holder) => holder.previewUrl.length > 0);
    const foldersMoved = movedEntries.includes(sourceFolderAName) && movedEntries.includes(sourceFolderBName) && remainingDesktopMatches.length === 0;
    const providerBlockerReason = findProviderBlockerReason(finalSession);

    await writeFile(LATEST_SESSION_PATH, `${JSON.stringify(finalSession, null, 2)}${os.EOL}`, "utf8");

    artifact = {
      generatedAt: new Date().toISOString(),
      command: COMMAND_NAME,
      status: providerBlockerReason
        ? "BLOCKED"
        : previewsSeeded &&
            (recoveryClarificationAsked || autoRecoveredWithoutClarification) &&
            foldersMoved &&
            previewStopped &&
            browserSessionsClosed
          ? "PASS"
          : "FAIL",
      blockerReason: providerBlockerReason,
      localIntentModel: { enabled: localProbe.enabled, required: localProbe.liveSmokeRequired, reachable: localProbe.reachable, modelPresent: localProbe.modelPresent, model: localProbe.model, provider: localProbe.provider, baseUrl: localProbe.baseUrl },
      prompts: { organize: organizePrompt, retry: retryPrompt },
      seededPreviewHolders: seededPreviewHolders.map(({ folderName, folderPath, previewUrl, processLeaseId, browserSessionId }) => ({ folderName, folderPath, previewUrl, processLeaseId, browserSessionId })),
      targetRoot: targetRootPath,
      movedEntries,
      remainingDesktopMatches,
      checks: {
        routedAutonomous: finalSession.modeContinuity?.activeMode === "autonomous",
        previewsSeeded,
        recoveryClarificationAsked,
        autoRecoveredWithoutClarification,
        foldersMoved,
        previewsStopped: previewStopped,
        browserSessionsClosed
      },
      cleanupChecks: {
        previewsStoppedAfterCleanup: false,
        browserSessionsClosedAfterCleanup: false,
        trackedRuntimeHandlesClosedAfterCleanup: false
      },
      turns
    };

    await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}${os.EOL}`, "utf8");
    currentRunArtifactWritten = true;
    console.log(`=== ARTIFACT ===\n${JSON.stringify(artifact, null, 2)}`);
    if (artifact.status === "FAIL") {
      throw new Error(`Organization recovery smoke failed. ${JSON.stringify(artifact.checks)}`);
    }
    } catch (error) {
      if (!artifact) {
        const blockerReason = error instanceof Error ? error.stack ?? error.message : String(error);
        artifact = buildBlockedOrganizationArtifact(blockerReason);
      }
      throw error;
    }
  } finally {
    if (smokeModelSnapshot) {
      restoreEnv(smokeModelSnapshot);
    }
    if (config) {
      await cleanupRuntimeSessionResources(config, latestSession).catch(() => undefined);
    }
    if (setupExecutor && seededPreviewHolders.length > 0) {
      await cleanupSeededPreviewHolders(setupExecutor, seededPreviewHolders).catch(() => undefined);
    }
    await cleanupLingeringPlaywrightAutomationBrowsers().catch(() => undefined);
    if (artifact) {
      artifact.cleanupChecks = await collectSettledPostCleanupChecks(seededPreviewHolders).catch(
        () => artifact?.cleanupChecks ?? {
          previewsStoppedAfterCleanup: false,
          browserSessionsClosedAfterCleanup: false,
          trackedRuntimeHandlesClosedAfterCleanup: false
        }
      );
      await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}${os.EOL}`, "utf8").catch(
        () => undefined
      );
      currentRunArtifactWritten = true;
    }
    if (targetRootPath) {
      await rm(targetRootPath, { recursive: true, force: true }).catch(() => undefined);
    }
    if (desktopPath) {
      await removeSmokeFoldersByPrefix(desktopPath, [
        "drone-company-organize-smoke-"
      ]).catch(() => undefined);
    }
    await rm(LIVE_RUN_RUNTIME_PATH, { recursive: true, force: true }).catch(() => undefined);
    await rm(STATE_PATH, { force: true }).catch(() => undefined);
    await rm(`${STATE_PATH}.lock`, { force: true }).catch(() => undefined);
    await rm(LEDGER_SQLITE_PATH, { force: true }).catch(() => undefined);
    await rm(`${LEDGER_SQLITE_PATH}-shm`, { force: true }).catch(() => undefined);
    await rm(`${LEDGER_SQLITE_PATH}-wal`, { force: true }).catch(() => undefined);
    fatalCleanupConfig = null;
    fatalCleanupExecutor = null;
    fatalSeededPreviewHolders = [];
    fatalSeededProjectFolders = [];
    fatalLatestSession = null;
    fatalDesktopPath = null;
    fatalTargetRootPath = null;
    restoreEnv(previousEnv);
  }
}

if (require.main === module) {
  process.once("exit", (code) => {
    if (code === 0) {
      return;
    }
    performEmergencyOrganizeSmokeCleanupSync();
    refreshExistingOrganizationArtifactCleanupChecksSync();
    if (!existsSync(ARTIFACT_PATH)) {
      writeFallbackOrganizationArtifactSync(
        lastFatalOrganizeSmokeMessage ??
          `Organize smoke exited with code ${code} before it wrote an artifact.`
      );
    }
    removeSmokeArtifactsSync();
  });
  process.once("uncaughtException", (error) => {
    void handleFatalOrganizeSmokeError(error).finally(() => {
      process.exitCode = 1;
      scheduleForcedFailureExit();
    });
  });
  process.once("unhandledRejection", (reason) => {
    void handleFatalOrganizeSmokeError(reason).finally(() => {
      process.exitCode = 1;
      scheduleForcedFailureExit();
    });
  });
  void main()
    .then(() => {
      setImmediate(() => process.exit(process.exitCode ?? 0));
    })
    .catch(async (error) => {
      await handleFatalOrganizeSmokeError(error);
      process.exit(1);
    });
}
