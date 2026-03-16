/**
 * @fileoverview Runs the dedicated front-door autonomous runtime affordances live smoke.
 *
 * This proof surface composes:
 * 1. the real multi-turn browser workflow through the conversation front door
 * 2. the real exact-holder organization recovery flow through the conversation front door
 * 3. a real ambiguous non-preview-holder clarification flow through the conversation front door
 */

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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
import { resolveUserOwnedPathHints } from "../../src/organs/plannerPolicy/userOwnedPathHints";
import { buildSmokeModelEnvOverrides } from "./smokeModelEnv";

type ArtifactStatus = "PASS" | "FAIL" | "BLOCKED";

interface LocalIntentProof {
  enabled: boolean;
  required: boolean;
  reachable: boolean;
  modelPresent: boolean;
  model: string;
  provider: string;
  baseUrl: string;
}

interface ChildScriptRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

interface ChildScenarioAttemptResult<TArtifact> {
  childResult: ChildScriptRunResult;
  artifact: TArtifact | null;
  blockerReason: string | null;
  attempts: number;
}

interface FrontDoorScenarioSummary {
  status: ArtifactStatus;
  blockerReason: string | null;
  artifactPath: string | null;
  prompts: readonly string[];
  assistantReplies: readonly string[];
  checks: Record<string, boolean>;
  targetPath: string | null;
}

interface AmbiguousClarificationScenario {
  status: ArtifactStatus;
  blockerReason: string | null;
  prompt: string;
  assistantReply: string;
  clarificationQuestion: string | null;
  clarificationOptions: readonly string[];
  targetFolderPath: string;
  targetRootPath: string;
  holderPid: number | null;
  checks: {
    clarificationAsked: boolean;
    noAutomaticShutdown: boolean;
    exactHolderMentioned: boolean;
    projectAnchored: boolean;
    targetStillAtDesktopRoot: boolean;
  };
}

export interface AutonomousRuntimeAffordancesLiveSmokeArtifact {
  generatedAt: string;
  command: string;
  status: ArtifactStatus;
  blockerReason: string | null;
  localIntentModel: LocalIntentProof;
  checks: {
    naturalAutonomousStart: boolean;
    workspaceContinuity: boolean;
    exactHolderRecoveryWithoutClarification: boolean;
    ambiguousHolderClarification: boolean;
    reviewableUserFacingCopy: boolean;
  };
  browserWorkflowScenario: FrontDoorScenarioSummary;
  exactHolderRecoveryScenario: FrontDoorScenarioSummary;
  ambiguousClarificationScenario: AmbiguousClarificationScenario;
}

interface CapturedNotification {
  phase: "send" | "edit";
  messageId: string;
  text: string;
  at: string;
}

const COMMAND_NAME = "tsx scripts/evidence/autonomousRuntimeAffordancesLiveSmoke.ts";
const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/autonomous_runtime_affordances_live_smoke_report.json"
);
const REAL_THREE_STEP_ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/real_three_step_workflow_live_smoke_report.json"
);
const ORGANIZE_ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/organize_drone_projects_live_smoke_report.json"
);
const PROVIDER_BLOCK_PATTERN =
  /(?:429|exceeded your current quota|rate limit|fetch failed|request timed out|socket hang up|ECONNRESET)/i;
const SMOKE_DEADLINE_MS = 170_000;
const CHILD_SCENARIO_TIMEOUT_MS = 110_000;
const AMBIGUOUS_SCENARIO_TIMEOUT_MS = 70_000;
const MAX_PROVIDER_RETRY_ATTEMPTS = 2;
const FRESH_CHILD_ARTIFACT_MAX_AGE_MS = 15 * 60_000;
const LIVE_RUN_RUNTIME_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-autonomous-runtime-affordances-live-run-${Date.now()}`
);
const STATE_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-autonomous-runtime-affordances-live-state-${Date.now()}.json`
);
const LEDGER_SQLITE_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-autonomous-runtime-affordances-live-ledgers-${Date.now()}.sqlite`
);

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

function buildMessage(
  conversationId: string,
  userId: string,
  username: string,
  text: string,
  receivedAt: string
): ConversationInboundMessage {
  return {
    provider: "telegram",
    conversationId,
    userId,
    username,
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

function detectProviderBlockerReason(...texts: readonly string[]): string | null {
  const combined = texts.filter((value) => value.trim().length > 0).join("\n");
  return PROVIDER_BLOCK_PATTERN.test(combined) ? combined : null;
}

function classifyScenarioFailureStatus(
  blockerReason: string | null
): ArtifactStatus {
  return blockerReason ? "BLOCKED" : "FAIL";
}

function isBoundedSmokeBlockerReason(reason: string | null): boolean {
  if (!reason) {
    return false;
  }
  return /Timed out waiting|socket hang up|ECONNRESET|fetch failed|request timed out|429|rate limit/i.test(
    reason
  );
}

function buildScenarioFailureBlockerReason(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function buildChildScenarioTimeoutBlockerReason(scriptPath: string, timeoutMs: number): string {
  return `Timed out waiting for ${path.basename(scriptPath)} after ${timeoutMs}ms.`;
}

function buildFailedFrontDoorScenarioSummary(
  blockerReason: string | null
): FrontDoorScenarioSummary {
  return {
    status: classifyScenarioFailureStatus(blockerReason),
    blockerReason,
    artifactPath: null,
    prompts: [],
    assistantReplies: [],
    checks: {
      artifactWritten: false
    },
    targetPath: null
  };
}

function buildFailedAmbiguousClarificationScenario(
  blockerReason: string | null
): AmbiguousClarificationScenario {
  return {
    status: classifyScenarioFailureStatus(blockerReason),
    blockerReason,
    prompt: "",
    assistantReply: "",
    clarificationQuestion: null,
    clarificationOptions: [],
    targetFolderPath: "",
    targetRootPath: "",
    holderPid: null,
    checks: {
      clarificationAsked: false,
      noAutomaticShutdown: false,
      exactHolderMentioned: false,
      projectAnchored: false,
      targetStillAtDesktopRoot: false
    }
  };
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

function collectTrackedPidsFromRuntimeValue(value: unknown, pidSet: Set<number>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectTrackedPidsFromRuntimeValue(entry, pidSet);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, nestedValue] of Object.entries(value)) {
    if (
      (key === "pid" || key === "browserProcessPid" || key === "linkedProcessPid") &&
      typeof nestedValue === "number" &&
      Number.isInteger(nestedValue) &&
      nestedValue > 0
    ) {
      pidSet.add(nestedValue);
    }
    collectTrackedPidsFromRuntimeValue(nestedValue, pidSet);
  }
}

async function cleanupSmokeArtifactsByPrefix(prefixes: readonly string[]): Promise<void> {
  const runtimePath = path.resolve(process.cwd(), "runtime");
  const entries = await readdir(runtimePath, { withFileTypes: true }).catch(() => []);
  const matchingEntries = entries.filter((entry) =>
    prefixes.some((prefix) => entry.name.startsWith(prefix))
  );
  if (matchingEntries.length === 0) {
    return;
  }

  const pidSet = new Set<number>();
  for (const entry of matchingEntries) {
    const entryPath = path.join(runtimePath, entry.name);
    if (entry.isDirectory()) {
      const snapshotNames = ["managed_processes.json", "browser_sessions.json"];
      for (const snapshotName of snapshotNames) {
        const raw = await readFile(path.join(entryPath, snapshotName), "utf8").catch(() => null);
        if (!raw) {
          continue;
        }
        try {
          collectTrackedPidsFromRuntimeValue(JSON.parse(raw), pidSet);
        } catch {
          // Best effort only.
        }
      }
      continue;
    }
    const raw = await readFile(entryPath, "utf8").catch(() => null);
    if (!raw) {
      continue;
    }
    try {
      collectTrackedPidsFromRuntimeValue(JSON.parse(raw), pidSet);
    } catch {
      // Best effort only.
    }
  }

  for (const pid of pidSet) {
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill.exe", ["/PID", `${pid}`, "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true
        });
      } else {
        process.kill(pid, "SIGTERM");
      }
    } catch {
      // Best effort only.
    }
  }

  await Promise.all(
    matchingEntries.map((entry) =>
      rm(path.join(runtimePath, entry.name), {
        recursive: true,
        force: true
      }).catch(() => undefined)
    )
  );
}

function extractLatestAssistantReplyFromSession(session: ConversationSession): string {
  return [...session.conversationTurns]
    .reverse()
    .find((turn) => turn.role === "assistant")?.text ?? "";
}

function extractLatestAssistantReplyFromTurnRecord(
  turnRecord: Record<string, unknown>
): string {
  const sessionSnapshot = turnRecord.sessionSnapshot;
  if (!sessionSnapshot || typeof sessionSnapshot !== "object") {
    return "";
  }
  const conversationTurns = (sessionSnapshot as { conversationTurns?: unknown }).conversationTurns;
  if (!Array.isArray(conversationTurns)) {
    return "";
  }
  for (let index = conversationTurns.length - 1; index >= 0; index -= 1) {
    const turn = conversationTurns[index];
    if (
      turn &&
      typeof turn === "object" &&
      (turn as { role?: unknown }).role === "assistant" &&
      typeof (turn as { text?: unknown }).text === "string"
    ) {
      return (turn as { text: string }).text;
    }
  }
  return "";
}

async function waitForTurnCompletion(
  store: InterfaceSessionStore,
  conversationKey: string,
  turnStartedAt: string,
  timeoutMs = AMBIGUOUS_SCENARIO_TIMEOUT_MS
): Promise<ConversationSession> {
  const startedAt = Date.now();
  let observedExecution = false;
  let lastSessionSummary = "No session snapshot was persisted yet.";

  while (Date.now() - startedAt < timeoutMs) {
    const session = await store.getSession(conversationKey);
    if (session) {
      const latestJob = session.recentJobs
        .slice()
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
      const latestAssistantTurn = [...session.conversationTurns]
        .reverse()
        .find((turn) => turn.role === "assistant")?.text ?? "";
      lastSessionSummary = JSON.stringify(
        {
          mode: session.modeContinuity?.activeMode ?? null,
          runningJobId: session.runningJobId,
          queuedJobs: session.queuedJobs.length,
          progressState: session.progressState,
          activeClarification: session.activeClarification
            ? {
                kind: session.activeClarification.kind,
                requestedAt: session.activeClarification.requestedAt,
                question: session.activeClarification.question
              }
            : null,
          latestJob: latestJob
            ? {
                id: latestJob.id,
                createdAt: latestJob.createdAt,
                startedAt: latestJob.startedAt,
                completedAt: latestJob.completedAt,
                status: latestJob.status,
                errorMessage: latestJob.errorMessage,
                resultSummary: latestJob.resultSummary
              }
            : null,
          latestAssistantTurn
        },
        null,
        2
      );
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

  throw new Error(
    "Timed out waiting for the front-door clarification scenario to complete.\n" +
      `Last observed session state:\n${lastSessionSummary}`
  );
}

async function waitForChildSpawn(child: ChildProcess, timeoutMs: number): Promise<void> {
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
      finalize(() => reject(new Error(`Child process did not emit spawn within ${timeoutMs}ms.`)));
    }, timeoutMs);
    child.once("spawn", () => finalize(resolve));
    child.once("error", (error) => finalize(() => reject(error)));
    child.once("close", (code, signal) => {
      finalize(() =>
        reject(
          new Error(
            `Child process exited before startup completed (${code ?? "no-exit-code"}${
              signal ? `, signal ${signal}` : ""
            }).`
          )
        )
      );
    });
  });
}

async function terminateChildProcess(child: ChildProcess | null, timeoutMs = 2_000): Promise<void> {
  if (!child?.pid) {
    return;
  }

  const closePromise = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("exit", () => resolve());
  });

  try {
    if (process.platform === "win32") {
      spawnSync("taskkill.exe", ["/PID", `${child.pid}`, "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // Best effort only.
  }

  await Promise.race([closePromise, sleep(timeoutMs)]);
}

async function runChildScript(scriptPath: string, timeoutMs: number): Promise<ChildScriptRunResult> {
  const tsxPackagePath = require.resolve("tsx/package.json");
  const tsxCliPath = path.resolve(path.dirname(tsxPackagePath), "dist/cli.mjs");
  const child = spawn(process.execPath, [tsxCliPath, scriptPath], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    try {
      void spawn("taskkill.exe", ["/PID", `${child.pid ?? 0}`, "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
    } catch {
      // Best effort only.
    }
  }, timeoutMs);

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  }).finally(() => {
    clearTimeout(timeoutHandle);
  });

  return {
    exitCode,
    stdout,
    stderr,
    timedOut
  };
}

async function runChildScriptWithProviderRetry<TArtifact>(
  scriptPath: string,
  artifactPath: string,
  extractBlockerReason: (artifact: TArtifact | null, childResult: ChildScriptRunResult) => string | null,
  deadlineAtMs: number
): Promise<ChildScenarioAttemptResult<TArtifact>> {
  let lastChildResult: ChildScriptRunResult | null = null;
  let lastArtifact: TArtifact | null = null;
  let lastBlockerReason: string | null = null;

  for (let attempt = 1; attempt <= MAX_PROVIDER_RETRY_ATTEMPTS; attempt += 1) {
    const childTimeoutMs = getRemainingSmokeBudget(
      deadlineAtMs,
      CHILD_SCENARIO_TIMEOUT_MS,
      `child smoke ${path.basename(scriptPath)}`
    );
    const childResult = await runChildScript(scriptPath, childTimeoutMs);
    const artifact = await loadJsonArtifact<TArtifact>(artifactPath);
    const blockerReason = extractBlockerReason(artifact, childResult);
    lastChildResult = childResult;
    lastArtifact = artifact;
    lastBlockerReason = blockerReason;
    if (!blockerReason || childResult.timedOut || attempt === MAX_PROVIDER_RETRY_ATTEMPTS) {
      return {
        childResult,
        artifact,
        blockerReason,
        attempts: attempt
      };
    }
    await rm(artifactPath, { force: true }).catch(() => undefined);
  }

  return {
    childResult: lastChildResult ?? {
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false
    },
    artifact: lastArtifact,
    blockerReason: lastBlockerReason,
    attempts: MAX_PROVIDER_RETRY_ATTEMPTS
  };
}

async function loadJsonArtifact<T>(artifactPath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(artifactPath, "utf8")) as T;
  } catch {
    return null;
  }
}

function resolveArtifactGeneratedAtMs(candidate: unknown): number | null {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return null;
  }
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? parsed : null;
}

async function loadFreshPassingArtifact<T extends { status: string; generatedAt?: string }>(
  artifactPath: string,
  maxAgeMs: number
): Promise<T | null> {
  const artifact = await loadJsonArtifact<T>(artifactPath);
  if (!artifact || artifact.status !== "PASS") {
    return null;
  }
  const generatedAtMs = resolveArtifactGeneratedAtMs(artifact.generatedAt);
  if (generatedAtMs === null) {
    return null;
  }
  return Date.now() - generatedAtMs <= maxAgeMs ? artifact : null;
}

async function runFrontDoorBrowserWorkflowScenario(
  deadlineAtMs: number
): Promise<FrontDoorScenarioSummary> {
  const freshArtifact = await loadFreshPassingArtifact<{
    status: "PASS" | "FAIL";
    blockerReason?: string | null;
    targetFolder: string | null;
    turns: Array<Record<string, unknown>>;
    checks: Record<string, boolean>;
    generatedAt?: string;
  }>(REAL_THREE_STEP_ARTIFACT_PATH, FRESH_CHILD_ARTIFACT_MAX_AGE_MS);
  if (freshArtifact) {
    return {
      status: "PASS",
      blockerReason: null,
      artifactPath: REAL_THREE_STEP_ARTIFACT_PATH,
      prompts: freshArtifact.turns.map((turn) => String(turn.user ?? "")),
      assistantReplies: freshArtifact.turns.map((turn) =>
        extractLatestAssistantReplyFromTurnRecord(turn)
      ),
      checks: freshArtifact.checks,
      targetPath: freshArtifact.targetFolder
    };
  }
  await rm(REAL_THREE_STEP_ARTIFACT_PATH, { force: true }).catch(() => undefined);
  try {
    const {
      childResult,
      artifact,
      blockerReason
    } = await runChildScriptWithProviderRetry<{
      status: "PASS" | "FAIL";
      blockerReason?: string | null;
      targetFolder: string | null;
      turns: Array<Record<string, unknown>>;
      checks: Record<string, boolean>;
    }>(
      "scripts/evidence/realThreeStepWorkflowLiveSmoke.ts",
      REAL_THREE_STEP_ARTIFACT_PATH,
      (currentArtifact, currentChildResult) =>
        detectProviderBlockerReason(currentArtifact?.blockerReason ?? "") ??
        (currentArtifact
          ? null
          : detectProviderBlockerReason(currentChildResult.stdout, currentChildResult.stderr)),
      deadlineAtMs
    );
    if (!artifact) {
      const timeoutBlockerReason = childResult.timedOut
        ? buildChildScenarioTimeoutBlockerReason(
            "scripts/evidence/realThreeStepWorkflowLiveSmoke.ts",
            CHILD_SCENARIO_TIMEOUT_MS
          )
        : null;
      return {
        status: blockerReason || timeoutBlockerReason ? "BLOCKED" : "FAIL",
        blockerReason: blockerReason ?? timeoutBlockerReason,
        artifactPath: null,
        prompts: [],
        assistantReplies: [],
        checks: {
          artifactWritten: false
        },
        targetPath: null
      };
    }

    const artifactBlockerReason =
      typeof artifact.blockerReason === "string" && artifact.blockerReason.trim().length > 0
        ? artifact.blockerReason
        : null;
    const timeoutBlockerReason = childResult.timedOut
      ? buildChildScenarioTimeoutBlockerReason(
          "scripts/evidence/realThreeStepWorkflowLiveSmoke.ts",
          CHILD_SCENARIO_TIMEOUT_MS
        )
      : null;
    const scenarioBlockerReason =
      blockerReason ??
      artifactBlockerReason ??
      (artifact.status === "PASS" ? null : timeoutBlockerReason);
    const scenarioStatus =
      blockerReason || isBoundedSmokeBlockerReason(artifactBlockerReason)
        ? "BLOCKED"
        : artifact.status;

    return {
      status: scenarioStatus,
      blockerReason: scenarioBlockerReason,
      artifactPath: REAL_THREE_STEP_ARTIFACT_PATH,
      prompts: artifact.turns.map((turn) => String(turn.user ?? "")),
      assistantReplies: artifact.turns.map((turn) => extractLatestAssistantReplyFromTurnRecord(turn)),
      checks: artifact.checks,
      targetPath: artifact.targetFolder
    };
  } finally {
    await cleanupSmokeArtifactsByPrefix([
      "tmp-real-three-step-live-run-",
      "tmp-real-three-step-state-",
      "tmp-real-three-step-ledgers-",
      "real_three_step_smoke_sessions-"
    ]);
  }
}

async function runExactHolderRecoveryScenario(
  deadlineAtMs: number
): Promise<FrontDoorScenarioSummary> {
  const freshArtifact = await loadFreshPassingArtifact<{
    status: ArtifactStatus;
    blockerReason: string | null;
    targetRoot: string;
    prompts: Record<string, string>;
    turns: Array<Record<string, unknown>>;
    checks: Record<string, boolean>;
    generatedAt?: string;
  }>(ORGANIZE_ARTIFACT_PATH, FRESH_CHILD_ARTIFACT_MAX_AGE_MS);
  if (freshArtifact) {
    return {
      status: "PASS",
      blockerReason: null,
      artifactPath: ORGANIZE_ARTIFACT_PATH,
      prompts: Object.values(freshArtifact.prompts),
      assistantReplies: freshArtifact.turns.map((turn) =>
        extractLatestAssistantReplyFromTurnRecord(turn)
      ),
      checks: freshArtifact.checks,
      targetPath: freshArtifact.targetRoot
    };
  }
  await rm(ORGANIZE_ARTIFACT_PATH, { force: true }).catch(() => undefined);
  try {
    const {
      childResult,
      artifact,
      blockerReason: providerBlockerReason
    } = await runChildScriptWithProviderRetry<{
      status: ArtifactStatus;
      blockerReason: string | null;
      targetRoot: string;
      prompts: Record<string, string>;
      turns: Array<Record<string, unknown>>;
      checks: Record<string, boolean>;
    }>(
      "scripts/evidence/organizeDroneProjectsLiveSmoke.ts",
      ORGANIZE_ARTIFACT_PATH,
      (currentArtifact, currentChildResult) =>
        detectProviderBlockerReason(currentArtifact?.blockerReason ?? "") ??
        (currentArtifact
          ? null
          : detectProviderBlockerReason(currentChildResult.stdout, currentChildResult.stderr)),
      deadlineAtMs
    );
    if (!artifact) {
      const timeoutBlockerReason = childResult.timedOut
        ? buildChildScenarioTimeoutBlockerReason(
            "scripts/evidence/organizeDroneProjectsLiveSmoke.ts",
            CHILD_SCENARIO_TIMEOUT_MS
          )
        : null;
      return {
        status: providerBlockerReason || timeoutBlockerReason ? "BLOCKED" : "FAIL",
        blockerReason: providerBlockerReason ?? timeoutBlockerReason,
        artifactPath: null,
        prompts: [],
        assistantReplies: [],
        checks: {
          artifactWritten: false
        },
        targetPath: null
      };
    }

    const artifactBlockerReason =
      typeof artifact.blockerReason === "string" && artifact.blockerReason.trim().length > 0
        ? artifact.blockerReason
        : null;
    const timeoutBlockerReason = childResult.timedOut
      ? buildChildScenarioTimeoutBlockerReason(
          "scripts/evidence/organizeDroneProjectsLiveSmoke.ts",
          CHILD_SCENARIO_TIMEOUT_MS
        )
      : null;
    const scenarioBlockerReason =
      providerBlockerReason ??
      artifactBlockerReason ??
      (artifact.status === "PASS" ? null : timeoutBlockerReason);
    const scenarioStatus =
      providerBlockerReason || isBoundedSmokeBlockerReason(artifactBlockerReason)
        ? "BLOCKED"
        : artifact.status;

    return {
      status: scenarioStatus,
      blockerReason: scenarioBlockerReason,
      artifactPath: ORGANIZE_ARTIFACT_PATH,
      prompts: Object.values(artifact.prompts),
      assistantReplies: artifact.turns.map((turn) => extractLatestAssistantReplyFromTurnRecord(turn)),
      checks: artifact.checks,
      targetPath: artifact.targetRoot
    };
  } finally {
    await cleanupSmokeArtifactsByPrefix([
      "tmp-organize-live-run-",
      "tmp-organize-session-",
      "tmp-organize-state-",
      "tmp-organize-ledgers-"
    ]);
  }
}

function applyEnvOverrides(overrides: Readonly<Record<string, string>>): Map<string, string | undefined> {
  const snapshot = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    snapshot.set(key, process.env[key]);
    process.env[key] = value;
  }
  return snapshot;
}

function restoreEnv(snapshot: ReadonlyMap<string, string | undefined>): void {
  for (const [key, value] of snapshot.entries()) {
    if (value === undefined) {
      delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

async function runAmbiguousClarificationScenario(
  deadlineAtMs: number
): Promise<AmbiguousClarificationScenario> {
  const runId = `${Date.now()}`;
  const { desktopPath } = resolveUserOwnedPathHints();
  const sourceFolderName = `drone-company-clarify-smoke-${runId}`;
  const targetRootName = `drone-web-projects-clarify-smoke-${runId}`;
  const sourceFolderPath = path.join(desktopPath, sourceFolderName);
  const targetRootPath = path.join(desktopPath, targetRootName);
  const sessionPath = path.resolve(
    process.cwd(),
    `runtime/tmp-autonomous-runtime-affordances-live-smoke-${runId}.json`
  );
  const conversationId = `autonomy-front-door-clarify-${runId}`;
  const userId = "autonomy-live-smoke-user";
  const username = "anthonybenny";
  const prompt =
    `Please take this from start to finish: move the project folder named ${sourceFolderName} ` +
    `from my desktop into a folder called ${targetRootName} on my desktop. ` +
    "If something local is still using it, be careful and ask before you shut anything down.";
  const envSnapshot = applyEnvOverrides({
    BRAIN_LIVE_RUN_RUNTIME_PATH: LIVE_RUN_RUNTIME_PATH,
    BRAIN_STATE_JSON_PATH: STATE_PATH,
    BRAIN_LEDGER_SQLITE_PATH: LEDGER_SQLITE_PATH,
    BRAIN_LEDGER_EXPORT_JSON_ON_WRITE: "false",
    BRAIN_ENABLE_EMBEDDINGS: "false",
    BRAIN_ENABLE_DYNAMIC_PULSE: "false"
  });
  let holderChild: ChildProcess | null = null;

  try {
    await rm(sessionPath, { force: true }).catch(() => undefined);
    await rm(`${sessionPath}.lock`, { force: true }).catch(() => undefined);
    await rm(sourceFolderPath, { recursive: true, force: true }).catch(() => undefined);
    await rm(targetRootPath, { recursive: true, force: true }).catch(() => undefined);
    await mkdir(sourceFolderPath, { recursive: true });
    await writeFile(
      path.join(sourceFolderPath, "index.html"),
      `<!doctype html><title>${sourceFolderName}</title><main>${sourceFolderName}</main>`,
      "utf8"
    );

    const escapedPath = sourceFolderPath.replace(/'/g, "''");
    holderChild = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Set-Location '${escapedPath}'; Start-Sleep -Seconds 180`
      ],
      {
        cwd: sourceFolderPath,
        stdio: "ignore",
        windowsHide: true
      }
    );
    await waitForChildSpawn(holderChild, 2_000);
    await sleep(500);

    const localProbe = await probeLocalIntentModelFromEnv();
    if (
      localProbe.enabled &&
      localProbe.liveSmokeRequired &&
      !isLocalIntentModelRuntimeReady(localProbe)
    ) {
      throw new Error(
        `Local intent model is required for this smoke but not ready: provider=${localProbe.provider} model=${localProbe.model}`
      );
    }

    const brain = buildDefaultBrain();
    const adapter = new TelegramAdapter(brain, {
      auth: {
        requiredToken: "shared-secret"
      },
      allowlist: {
        allowedUsernames: [username],
        allowedUserIds: [userId],
        allowedChatIds: [conversationId]
      },
      rateLimit: {
        windowMs: 60_000,
        maxEventsPerWindow: 25
      },
      replay: {
        maxTrackedUpdateIds: 64
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
        localIntentModelResolver: createLocalIntentModelResolverFromEnv(),
        listManagedProcessSnapshots: async () => adapter.listManagedProcessSnapshots(),
        listBrowserSessionSnapshots: async () => adapter.listBrowserSessionSnapshots(),
        listAvailableSkills: async () => [],
        describeRuntimeCapabilities: async () => CAPABILITY_SUMMARY_FIXTURE
      }
    );
    const conversationKey = buildConversationKey({
      provider: "telegram",
      conversationId,
      userId,
      username,
      conversationVisibility: "private",
      receivedAt: new Date().toISOString()
    });
    const notifications: CapturedNotification[] = [];
    const notifier = createNotifierTransport(notifications);
    const abortControllers = new Map<string, AbortController>();
    const receivedAt = new Date().toISOString();
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

    await manager.handleMessage(
      buildMessage(conversationId, userId, username, prompt, receivedAt),
      executeTask,
      notifier
    );
    const session = await waitForTurnCompletion(
      store,
      conversationKey,
      receivedAt,
      getRemainingSmokeBudget(
        deadlineAtMs,
        AMBIGUOUS_SCENARIO_TIMEOUT_MS,
        "the front-door clarification scenario"
      )
    );
    const latestAssistantReply = extractLatestAssistantReplyFromSession(session);
    const latestJob = session.recentJobs
      .filter((job) => job.createdAt >= receivedAt)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] ?? null;
    const providerBlockerReason = detectProviderBlockerReason(
      latestJob?.errorMessage ?? "",
      latestAssistantReply,
      notifications.map((entry) => entry.text).join("\n")
    );
    const latestJobActionRecords = session.recentActions.filter(
      (action) => action.sourceJobId === latestJob?.id
    );
    const targetStillAtDesktopRoot = await stat(sourceFolderPath)
      .then((result) => result.isDirectory())
      .catch(() => false);
    const clarificationQuestion = session.activeClarification?.question ?? null;
    const clarificationOptions = session.activeClarification?.options.map((option) => option.label) ?? [];
    const exactHolderMentioned =
      /powershell/i.test(clarificationQuestion ?? latestAssistantReply) ||
      /high-confidence local holder|exact process/i.test(
        clarificationQuestion ?? latestAssistantReply
      );
    const projectAnchored =
      new RegExp(sourceFolderName, "i").test(prompt) &&
      /folder|move/i.test(clarificationQuestion ?? latestAssistantReply) &&
      !/policy/i.test(clarificationQuestion ?? latestAssistantReply);
    const noAutomaticShutdown = latestJobActionRecords.every(
      (action) => !(action.kind === "process" && action.status === "closed")
    );

    return {
      status: providerBlockerReason
        ? "BLOCKED"
        : session.activeClarification?.kind === "task_recovery" &&
            noAutomaticShutdown &&
            projectAnchored &&
            targetStillAtDesktopRoot
          ? "PASS"
          : "FAIL",
      blockerReason: providerBlockerReason,
      prompt,
      assistantReply: latestAssistantReply,
      clarificationQuestion,
      clarificationOptions,
      targetFolderPath: sourceFolderPath,
      targetRootPath,
      holderPid: holderChild.pid ?? null,
      checks: {
        clarificationAsked: session.activeClarification?.kind === "task_recovery",
        noAutomaticShutdown,
        exactHolderMentioned,
        projectAnchored,
        targetStillAtDesktopRoot
      }
    };
  } finally {
    await terminateChildProcess(holderChild).catch(() => undefined);
    await rm(sourceFolderPath, { recursive: true, force: true }).catch(() => undefined);
    await rm(targetRootPath, { recursive: true, force: true }).catch(() => undefined);
    await rm(sessionPath, { force: true }).catch(() => undefined);
    await rm(`${sessionPath}.lock`, { force: true }).catch(() => undefined);
    await rm(LIVE_RUN_RUNTIME_PATH, { recursive: true, force: true }).catch(() => undefined);
    await rm(STATE_PATH, { force: true }).catch(() => undefined);
    await rm(`${STATE_PATH}.lock`, { force: true }).catch(() => undefined);
    await rm(LEDGER_SQLITE_PATH, { force: true }).catch(() => undefined);
    await rm(`${LEDGER_SQLITE_PATH}-shm`, { force: true }).catch(() => undefined);
    await rm(`${LEDGER_SQLITE_PATH}-wal`, { force: true }).catch(() => undefined);
    restoreEnv(envSnapshot);
  }
}

function isReviewableReply(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length >= 24 &&
    !/^\/auto\b/i.test(trimmed) &&
    !/^\s*{\s*"/.test(trimmed)
  );
}

function buildArtifact(
  localIntentModel: LocalIntentProof,
  browserWorkflowScenario: FrontDoorScenarioSummary,
  exactHolderRecoveryScenario: FrontDoorScenarioSummary,
  ambiguousClarificationScenario: AmbiguousClarificationScenario
): AutonomousRuntimeAffordancesLiveSmokeArtifact {
  const blockerReason = [
    browserWorkflowScenario.blockerReason,
    exactHolderRecoveryScenario.blockerReason,
    ambiguousClarificationScenario.blockerReason
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");

  const checks = {
    naturalAutonomousStart:
      Boolean(browserWorkflowScenario.checks.routedAutonomous) ||
      Boolean(exactHolderRecoveryScenario.checks.routedAutonomous),
    workspaceContinuity:
      Boolean(browserWorkflowScenario.checks.folderCreated) &&
      Boolean(browserWorkflowScenario.checks.browserOpened) &&
      Boolean(browserWorkflowScenario.checks.sliderApplied) &&
      Boolean(browserWorkflowScenario.checks.changeRecallExplained) &&
      Boolean(browserWorkflowScenario.checks.browserClosed) &&
      Boolean(browserWorkflowScenario.checks.previewStopped),
    exactHolderRecoveryWithoutClarification:
      Boolean(exactHolderRecoveryScenario.checks.previewsSeeded) &&
      Boolean(exactHolderRecoveryScenario.checks.autoRecoveredWithoutClarification) &&
      Boolean(exactHolderRecoveryScenario.checks.foldersMoved) &&
      Boolean(exactHolderRecoveryScenario.checks.previewsStopped) &&
      Boolean(exactHolderRecoveryScenario.checks.browserSessionsClosed),
    ambiguousHolderClarification:
      ambiguousClarificationScenario.checks.clarificationAsked &&
      ambiguousClarificationScenario.checks.noAutomaticShutdown &&
      ambiguousClarificationScenario.checks.projectAnchored &&
      ambiguousClarificationScenario.checks.targetStillAtDesktopRoot,
    reviewableUserFacingCopy:
      browserWorkflowScenario.assistantReplies.every(isReviewableReply) &&
      exactHolderRecoveryScenario.assistantReplies.every(isReviewableReply) &&
      isReviewableReply(ambiguousClarificationScenario.assistantReply) &&
      isReviewableReply(ambiguousClarificationScenario.clarificationQuestion ?? "")
  };

  return {
    generatedAt: new Date().toISOString(),
    command: COMMAND_NAME,
    status: blockerReason
      ? "BLOCKED"
      : Object.values(checks).every(Boolean) &&
          browserWorkflowScenario.status === "PASS" &&
          exactHolderRecoveryScenario.status === "PASS" &&
          ambiguousClarificationScenario.status === "PASS"
        ? "PASS"
        : "FAIL",
    blockerReason: blockerReason || null,
    localIntentModel,
    checks,
    browserWorkflowScenario,
    exactHolderRecoveryScenario,
    ambiguousClarificationScenario
  };
}

export async function runAutonomousRuntimeAffordancesLiveSmoke():
Promise<AutonomousRuntimeAffordancesLiveSmokeArtifact> {
  ensureEnvLoaded();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await removeRuntimeArtifactsByPrefix(path.resolve(process.cwd(), "runtime"), [
    "tmp-autonomous-runtime-affordances-live-run-",
    "tmp-autonomous-runtime-affordances-live-state-",
    "tmp-autonomous-runtime-affordances-live-ledgers-",
    "tmp-autonomous-runtime-affordances-live-smoke-"
  ]);
  const deadlineAtMs = Date.now() + SMOKE_DEADLINE_MS;
  const localProbe = await probeLocalIntentModelFromEnv();
  if (
    localProbe.enabled &&
    localProbe.liveSmokeRequired &&
    !isLocalIntentModelRuntimeReady(localProbe)
  ) {
    throw new Error(
      `Local intent model is required for this smoke but not ready: provider=${localProbe.provider} model=${localProbe.model} reachable=${localProbe.reachable} modelPresent=${localProbe.modelPresent}`
    );
  }
  const smokeModelSnapshot = applyEnvOverrides(buildSmokeModelEnvOverrides(localProbe).envOverrides);

  try {
    let browserWorkflowScenario = buildFailedFrontDoorScenarioSummary(null);
    let exactHolderRecoveryScenario = buildFailedFrontDoorScenarioSummary(null);
    let ambiguousClarificationScenario = buildFailedAmbiguousClarificationScenario(null);

    try {
      exactHolderRecoveryScenario = await runExactHolderRecoveryScenario(deadlineAtMs);
    } catch (error) {
      exactHolderRecoveryScenario = buildFailedFrontDoorScenarioSummary(
        detectProviderBlockerReason(buildScenarioFailureBlockerReason(error)) ??
          buildScenarioFailureBlockerReason(error)
      );
    }

    if (deadlineAtMs - Date.now() <= 1_000) {
      ambiguousClarificationScenario = buildFailedAmbiguousClarificationScenario(
        "Skipped the front-door clarification scenario because earlier child scenarios consumed the bounded smoke budget."
      );
    } else {
      try {
        ambiguousClarificationScenario = await runAmbiguousClarificationScenario(deadlineAtMs);
      } catch (error) {
        ambiguousClarificationScenario = buildFailedAmbiguousClarificationScenario(
          detectProviderBlockerReason(buildScenarioFailureBlockerReason(error)) ??
            buildScenarioFailureBlockerReason(error)
        );
      }
    }

    try {
      browserWorkflowScenario = await runFrontDoorBrowserWorkflowScenario(deadlineAtMs);
    } catch (error) {
      browserWorkflowScenario = buildFailedFrontDoorScenarioSummary(
        detectProviderBlockerReason(buildScenarioFailureBlockerReason(error)) ??
          buildScenarioFailureBlockerReason(error)
      );
    }

    const artifact = buildArtifact(
      {
        enabled: localProbe.enabled,
        required: localProbe.liveSmokeRequired,
        reachable: localProbe.reachable,
        modelPresent: localProbe.modelPresent,
        model: localProbe.model,
        provider: localProbe.provider,
        baseUrl: localProbe.baseUrl
      },
      browserWorkflowScenario,
      exactHolderRecoveryScenario,
      ambiguousClarificationScenario
    );
    await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}${os.EOL}`, "utf8");
    return artifact;
  } finally {
    restoreEnv(smokeModelSnapshot);
  }
}

async function main(): Promise<void> {
  const artifact = await runAutonomousRuntimeAffordancesLiveSmoke();
  console.log(`Autonomous runtime affordances live smoke status: ${artifact.status}`);
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
    .catch(async (error: unknown) => {
      const localProbe = await probeLocalIntentModelFromEnv().catch(() => null);
      const blockerReason = buildScenarioFailureBlockerReason(error);
      const artifact = buildArtifact(
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
        buildFailedFrontDoorScenarioSummary(blockerReason),
        buildFailedFrontDoorScenarioSummary(blockerReason),
        buildFailedAmbiguousClarificationScenario(blockerReason)
      );
      await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}${os.EOL}`, "utf8").catch(
        () => undefined
      );
      console.error(blockerReason);
      process.exit(1);
    });
}
