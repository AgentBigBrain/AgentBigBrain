/**
 * @fileoverview Runs a real three-step landing-page workflow through the actual conversation manager
 * and governed brain, then proves the preview browser and linked server both shut down.
 */

import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
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

const RUN_ID = `${Date.now()}`;

function cloneSessionSnapshot(session: ConversationSession): ConversationSession {
  return JSON.parse(JSON.stringify(session)) as ConversationSession;
}

interface RealThreeStepWorkflowArtifact {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL" | "BLOCKED";
  blockerReason: string | null;
  localIntentModel: LocalIntentProof;
  checks: {
    routedAutonomous: boolean;
    folderCreated: boolean;
    browserOpened: boolean;
    sliderApplied: boolean;
    changeRecallExplained: boolean;
    browserClosed: boolean;
    previewStopped: boolean;
  };
  targetFolder: string | null;
  previewUrl: string | null;
  browserSessionId: string | null;
  turns: readonly TurnCapture[];
}

const COMMAND_NAME = "tsx scripts/evidence/realThreeStepWorkflowLiveSmoke.ts";
const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/real_three_step_workflow_live_smoke_report.json"
);
const SESSION_PATH = path.resolve(
  process.cwd(),
  `runtime/real_three_step_smoke_sessions-${RUN_ID}.json`
);
const STATE_PATH = path.resolve(process.cwd(), `runtime/tmp-real-three-step-state-${RUN_ID}.json`);
const LEDGER_SQLITE_PATH = path.resolve(process.cwd(), `runtime/tmp-real-three-step-ledgers-${RUN_ID}.sqlite`);
const LIVE_RUN_RUNTIME_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-real-three-step-live-run-${RUN_ID}`
);
const CONVERSATION_ID = `real-three-step-smoke-${RUN_ID}`;
const USER_ID = "real-smoke-user";
const USERNAME = "anthonybenny";
const TURN_TIMEOUT_MS = 60_000;
const SMOKE_DEADLINE_MS = 120_000;
const CLEANUP_STEP_TIMEOUT_MS = 3_000;
const DIRECT_REPLY_SETTLE_MS = 2_000;
const PROVIDER_BLOCK_PATTERN =
  /(?:429|exceeded your current quota|rate limit|fetch failed|request timed out|socket hang up|ECONNRESET)/i;

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

function getRemainingSmokeBudget(deadlineAtMs: number, capMs: number, label: string): number {
  const remainingMs = deadlineAtMs - Date.now();
  if (remainingMs <= 0) {
    throw new Error(`Timed out waiting for ${label}; smoke exceeded ${SMOKE_DEADLINE_MS}ms overall.`);
  }
  return Math.min(capMs, remainingMs);
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

/**
 * Awaits one best-effort cleanup operation without letting smoke teardown hang forever.
 *
 * @param operation - Cleanup promise to bound.
 */
async function awaitCleanup(operation: Promise<unknown>): Promise<void> {
  await Promise.race([
    operation.then(() => undefined).catch(() => undefined),
    sleep(CLEANUP_STEP_TIMEOUT_MS)
  ]);
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

function extractLatestAssistantReply(session: ConversationSession): string | null {
  const latestAssistantTurn = [...session.conversationTurns]
    .reverse()
    .find((turn) => turn.role === "assistant");
  return latestAssistantTurn?.text ?? null;
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

async function isPreviewReachable(url: string): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(url, 5_000);
    return response.ok;
  } catch {
    return false;
  }
}

function extractProcessPidsFromSessionJson(raw: string): number[] {
  const matches = [...raw.matchAll(/\(pid\s+(\d+)\)/g)];
  return matches
    .map((match) => Number(match[1]))
    .filter((value) => Number.isInteger(value) && value > 0);
}

async function cleanupLingeringSmokeProcesses(): Promise<void> {
  const runtimePath = path.resolve(process.cwd(), "runtime");
  const sessionEntries = await readdir(runtimePath, { withFileTypes: true }).catch(() => []);
  const sessionFiles = sessionEntries
    .filter(
      (entry) =>
        entry.isFile() &&
        /^real_three_step_smoke_sessions(?:-\d+)?\.json$/i.test(entry.name)
    )
    .map((entry) => path.join(runtimePath, entry.name));
  if (sessionFiles.length === 0) {
    return;
  }

  const pidSet = new Set<number>();
  for (const sessionFile of sessionFiles) {
    const raw = await readFile(sessionFile, "utf8").catch(() => null);
    if (!raw) {
      continue;
    }
    for (const pid of extractProcessPidsFromSessionJson(raw)) {
      pidSet.add(pid);
    }
  }

  for (const pid of pidSet) {
    try {
      process.kill(pid);
      console.log(`[cleanup] Stopped lingering smoke process pid=${pid}`);
    } catch {
      // Best-effort cleanup only.
    }
  }
}

async function cleanupTrackedSmokeResources(
  session: ConversationSession | null
): Promise<void> {
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
  const browserSessionRegistry = new (await import("../../src/organs/liveRun/browserSessionRegistry")).BrowserSessionRegistry();
  const managedProcessRegistry = new (await import("../../src/organs/liveRun/managedProcessRegistry")).ManagedProcessRegistry();
  const cleanupExecutor = new (await import("../../src/organs/executor")).ToolExecutorOrgan(
    config,
    undefined,
    managedProcessRegistry,
    undefined,
    browserSessionRegistry
  );

  for (const browserSessionId of browserSessionIds) {
    await awaitCleanup(cleanupExecutor.executeWithOutcome({
      id: `cleanup:${browserSessionId}:close_browser`,
      type: "close_browser",
      description: `Close lingering real smoke browser session ${browserSessionId}.`,
      params: {
        sessionId: browserSessionId
      },
      estimatedCostUsd: 0.01
    }));
  }
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

function isBoundedTurnTimeoutBlocker(
  blockerReason: string,
  session: ConversationSession | null
): boolean {
  return (
    /Timed out waiting for turn_\d+ to complete\./i.test(blockerReason) &&
    session?.runningJobId !== null &&
    session?.progressState?.status === "working"
  );
}

export function classifyThreeStepArtifactStatus(
  blockerReason: string,
  session: ConversationSession | null = null
): "FAIL" | "BLOCKED" {
  return PROVIDER_BLOCK_PATTERN.test(blockerReason) || isBoundedTurnTimeoutBlocker(blockerReason, session)
    ? "BLOCKED"
    : "FAIL";
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

async function writeThreeStepFailureArtifact(
  blockerReason: string,
  localIntentModel: LocalIntentProof,
  session: ConversationSession | null
): Promise<void> {
  const targetFolder = session ? extractTargetFolder(session) : null;
  const previewUrl = session ? extractPreviewUrl(session) : null;
  const browserSessionId = extractTrackedBrowserSessionId(session);
  const artifact: RealThreeStepWorkflowArtifact = {
    generatedAt: new Date().toISOString(),
    command: COMMAND_NAME,
    status: classifyThreeStepArtifactStatus(blockerReason, session),
    blockerReason,
    localIntentModel,
    checks: {
      routedAutonomous: session?.modeContinuity?.activeMode === "autonomous",
      folderCreated: Boolean(targetFolder),
      browserOpened: Boolean(browserSessionId),
      sliderApplied: false,
      changeRecallExplained: false,
      browserClosed: session?.browserSessions.every((entry) => entry.status === "closed") ?? false,
      previewStopped: false
    },
    targetFolder,
    previewUrl,
    browserSessionId,
    turns: []
  };
  await writeFile(ARTIFACT_PATH, JSON.stringify(artifact, null, 2) + os.EOL, "utf8");
}

async function main(): Promise<void> {
  ensureEnvLoaded();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await cleanupLingeringPlaywrightAutomationBrowsers().catch(() => undefined);
  await cleanupLingeringSmokeProcesses();
  await rm(SESSION_PATH, { force: true });
  await rm(`${SESSION_PATH}.lock`, { force: true });
  const envSnapshot = applyEnvOverrides({
    BRAIN_LIVE_RUN_RUNTIME_PATH: LIVE_RUN_RUNTIME_PATH,
    BRAIN_STATE_JSON_PATH: STATE_PATH,
    BRAIN_LEDGER_SQLITE_PATH: LEDGER_SQLITE_PATH,
    BRAIN_LEDGER_EXPORT_JSON_ON_WRITE: "false",
    BRAIN_ENABLE_EMBEDDINGS: "false",
    BRAIN_ENABLE_DYNAMIC_PULSE: "false"
  });
  let smokeModelSnapshot: EnvSnapshot | null = null;
  const deadlineAtMs = Date.now() + SMOKE_DEADLINE_MS;

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

    const targetFolderName = `drone-company-live-smoke-${Date.now()}`;
    const turn1Input =
      `Please build a small drone landing page in a folder called ${targetFolderName} ` +
      `on my desktop, then open it in a browser and leave it open for me.`;
    const turn2Input = "Change the hero section to a slider instead of a single static image.";
    const turn3Input = "Okay tell me about your changes so I know what you changed";
    const turn4Input = "close the landing page so we can work on something else";

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
    let latestSession: ConversationSession | null = null;

  const runTurn = async (
    turn: number,
    userInput: string,
    receivedAt: string,
    options: {
      allowDirectReplyCompletion?: boolean;
    } = {}
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
    try {
      const session = await waitForTurnCompletion(
        store,
        conversationKey,
        `turn_${turn}`,
        receivedAt,
        getRemainingSmokeBudget(deadlineAtMs, TURN_TIMEOUT_MS, `turn ${turn}`),
        options.allowDirectReplyCompletion ?? false
      );
      const sessionSnapshot = cloneSessionSnapshot(session);
      latestSession = sessionSnapshot;
      console.log(
        `=== TURN ${turn} SESSION SNAPSHOT ===\n${JSON.stringify(
          {
            runningJobId: sessionSnapshot.runningJobId,
            queuedJobs: sessionSnapshot.queuedJobs.length,
            progressState: sessionSnapshot.progressState,
            recentActions: sessionSnapshot.recentActions,
            browserSessions: sessionSnapshot.browserSessions,
            pathDestinations: sessionSnapshot.pathDestinations,
            activeWorkspace: sessionSnapshot.activeWorkspace,
            modeContinuity: sessionSnapshot.modeContinuity
          },
          null,
          2
        )}`
      );
      allTurns.push({
        turn,
        user: userInput,
        immediateReply,
        notifications,
        sessionSnapshot
      });
      return sessionSnapshot;
    } catch (error) {
      const partialSession = await store.getSession(conversationKey).catch(() => null);
      if (partialSession) {
        const partialSnapshot = cloneSessionSnapshot(partialSession);
        latestSession = partialSnapshot;
        allTurns.push({
          turn,
          user: userInput,
          immediateReply,
          notifications,
          sessionSnapshot: partialSnapshot
        });
      }
      throw error;
    }
  };

    const turn1At = new Date().toISOString();
    const sessionAfterTurn1 = await runTurn(1, turn1Input, turn1At);
    const turn1ProviderBlocker = findProviderBlockerReason(sessionAfterTurn1, turn1At);
    if (turn1ProviderBlocker) {
      throw new Error(turn1ProviderBlocker);
    }
    const targetFolder = extractTargetFolder(sessionAfterTurn1);
    const previewUrl = extractPreviewUrl(sessionAfterTurn1);
    const openBrowserSession = sessionAfterTurn1.browserSessions.find((entry) => entry.status === "open");

    assert.ok(targetFolder, "Turn 1 did not record a target folder.");
    assert.ok(previewUrl, "Turn 1 did not record a preview URL.");
    assert.ok(openBrowserSession, "Turn 1 did not leave a tracked browser session open.");

    const turn2At = new Date(Date.now() + 5_000).toISOString();
    const sessionAfterTurn2 = await runTurn(2, turn2Input, turn2At);
    const turn2ProviderBlocker = findProviderBlockerReason(sessionAfterTurn2, turn2At);
    if (turn2ProviderBlocker) {
      throw new Error(turn2ProviderBlocker);
    }
    const finalTargetFolder = extractTargetFolder(sessionAfterTurn2) ?? targetFolder;
    const finalPreviewUrl = extractPreviewUrl(sessionAfterTurn2) ?? previewUrl;
    assert.ok(finalTargetFolder, "Turn 2 lost the tracked target folder.");
    assert.ok(finalPreviewUrl, "Turn 2 lost the tracked preview URL.");

    const indexPath = path.join(finalTargetFolder, "index.html");
    const indexHtmlAfterTurn2 = await readFile(indexPath, "utf8");
    const sliderApplied =
      /slider/i.test(indexHtmlAfterTurn2) || /carousel/i.test(indexHtmlAfterTurn2);
    assert.ok(sliderApplied, "Turn 2 did not apply a slider/carousel update to index.html.");

    const sessionAfterTurn3 = await runTurn(
      3,
      turn3Input,
      new Date(Date.now() + 10_000).toISOString(),
      {
        allowDirectReplyCompletion: true
      }
    );
    const turn3Reply = extractLatestAssistantReply(sessionAfterTurn3) ?? "";
    const latestChangedFileNames = extractLatestChangedFileNames(sessionAfterTurn2);
    assert.ok(latestChangedFileNames.length > 0, "Turn 2 did not record any changed files to explain.");
    const changeRecallExplained =
      latestChangedFileNames.every((fileName) => turn3Reply.toLowerCase().includes(fileName.toLowerCase())) &&
      /slider|carousel/i.test(turn3Reply);
    assert.ok(changeRecallExplained, "Turn 3 did not explain the recent file changes clearly.");

    const turn4At = new Date(Date.now() + 15_000).toISOString();
    const sessionAfterTurn4 = await runTurn(4, turn4Input, turn4At);
    const turn4ProviderBlocker = findProviderBlockerReason(sessionAfterTurn4, turn4At);
    if (turn4ProviderBlocker) {
      throw new Error(turn4ProviderBlocker);
    }
    const trackedBrowserSession = sessionAfterTurn4.browserSessions.find(
      (entry) => entry.id === openBrowserSession.id
    ) ?? sessionAfterTurn4.browserSessions[0] ?? null;
    const browserClosed = trackedBrowserSession?.status === "closed";
    const previewStopped = await isPreviewReachable(finalPreviewUrl) === false;

    const artifact: RealThreeStepWorkflowArtifact = {
      generatedAt: new Date().toISOString(),
      command: COMMAND_NAME,
      status:
        browserClosed &&
        previewStopped &&
        sliderApplied &&
        changeRecallExplained &&
        Boolean(finalTargetFolder) &&
        Boolean(openBrowserSession)
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
        routedAutonomous: sessionAfterTurn1.modeContinuity?.activeMode === "autonomous",
        folderCreated: Boolean(finalTargetFolder),
        browserOpened: Boolean(openBrowserSession),
        sliderApplied,
        changeRecallExplained,
        browserClosed,
        previewStopped
      },
      targetFolder: finalTargetFolder,
      previewUrl: finalPreviewUrl,
      browserSessionId: trackedBrowserSession?.id ?? null,
      turns: allTurns
    };

    await writeFile(ARTIFACT_PATH, JSON.stringify(artifact, null, 2) + os.EOL, "utf8");
    console.log(`\n=== REAL THREE-STEP SUMMARY ===\n${JSON.stringify(artifact, null, 2)}`);
    await cleanupTrackedSmokeResources(latestSession).catch(() => undefined);
    await cleanupLingeringSmokeProcesses().catch(() => undefined);
    await cleanupLingeringPlaywrightAutomationBrowsers().catch(() => undefined);

    if (artifact.status !== "PASS") {
      throw new Error(
        "Real three-step workflow smoke failed. " +
        JSON.stringify(artifact.checks)
      );
    }
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
    .catch(async (error) => {
      const store = new InterfaceSessionStore(SESSION_PATH);
      const conversationKey = buildConversationKey({
        provider: "telegram",
        conversationId: CONVERSATION_ID,
        userId: USER_ID,
        username: USERNAME,
        conversationVisibility: "private",
        receivedAt: new Date().toISOString()
      });
      const session = await store.getSession(conversationKey).catch(() => null);
      const localProbe = await probeLocalIntentModelFromEnv().catch(() => null);
      const blockerReason =
        error instanceof Error ? error.stack ?? error.message : String(error);
      await writeThreeStepFailureArtifact(
        blockerReason,
        localProbe
          ? {
              enabled: localProbe.enabled,
              required: localProbe.liveSmokeRequired,
              reachable: localProbe.reachable,
              modelPresent: localProbe.modelPresent,
              model: localProbe.model,
              provider: localProbe.provider,
              baseUrl: localProbe.baseUrl
            }
          : {
              enabled: false,
              required: false,
              reachable: false,
              modelPresent: false,
              model: "unknown",
              provider: "unknown",
              baseUrl: ""
            },
        session
      ).catch(() => undefined);
      await cleanupTrackedSmokeResources(session ?? null).catch(() => undefined);
      await cleanupLingeringSmokeProcesses().catch(() => undefined);
      await cleanupLingeringPlaywrightAutomationBrowsers().catch(() => undefined);
      console.error(blockerReason);
      process.exit(1);
    });
}
