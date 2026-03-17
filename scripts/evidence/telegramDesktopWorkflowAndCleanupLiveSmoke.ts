/**
 * @fileoverview Runs one real Telegram conversation that blends casual chat with a real Desktop
 * landing-page workflow and then asks the agent to move every `drone-company*` folder on the
 * actual Desktop into `drone-folder`.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildDefaultBrain } from "../../src/core/buildBrain";
import { ensureEnvLoaded } from "../../src/core/envLoader";
import type { ConversationSession } from "../../src/interfaces/conversationRuntime/sessionStateContracts";
import { TelegramAdapter } from "../../src/interfaces/telegramAdapter";
import {
  TelegramGateway,
  type TelegramOutboundDeliveryObservation
} from "../../src/interfaces/telegramGateway";
import { createInterfaceRuntimeConfigFromEnv } from "../../src/interfaces/runtimeConfig";
import { InterfaceSessionStore } from "../../src/interfaces/sessionStore";
import { probeLocalIntentModelFromEnv } from "../../src/organs/languageUnderstanding/localIntentModelRuntime";
import {
  buildSmokeModelEnvOverrides,
  resolveRequiredRealSmokeBackend
} from "./smokeModelEnv";

type StepKind = "conversation" | "workflow";

interface StepDefinition {
  id: string;
  kind: StepKind;
  prompt: string;
  requiredAny?: readonly RegExp[];
  forbiddenAny?: readonly RegExp[];
}

interface StepObservation {
  reply: string | null;
  sessionReply: string | null;
  session: ConversationSession | null;
  runningJobId: string | null;
  queuedJobs: number;
  recentJobs: number;
  newAssistantTurns: number;
  newRecentJobs: number;
  newOutboundDeliveries: number;
  observedWorkerActivity: boolean;
  outboundTexts: readonly string[];
  latestRecentJobStatus: string | null;
  latestRecentJobSummary: string | null;
}

interface StepResult {
  id: string;
  kind: StepKind;
  prompt: string;
  reply: string | null;
  sessionReply: string | null;
  outboundTexts: readonly string[];
  newAssistantTurns: number;
  newRecentJobs: number;
  newOutboundDeliveries: number;
  observedWorkerActivity: boolean;
  latestRecentJobStatus: string | null;
  latestRecentJobSummary: string | null;
  pass: boolean;
  failures: readonly string[];
}

interface LocalIntentProof {
  enabled: boolean;
  required: boolean;
  reachable: boolean;
  modelPresent: boolean;
  model: string;
  provider: string;
  baseUrl: string;
  effectiveBackend: string;
}

interface SmokeArtifact {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL" | "BLOCKED";
  provider: "telegram";
  blockerReason: string | null;
  desktopPath: string | null;
  droneFolderPath: string | null;
  targetFolderName: string;
  targetFolderPath: string | null;
  previewUrl: string | null;
  browserSessionId: string | null;
  cleanupBaselineRootFolders: readonly string[];
  finalRootFolders: readonly string[];
  checks: {
    conversationBeforeBuildStayedConversational: boolean;
    buildOpenedBrowser: boolean;
    conversationDuringWorkflowStayedConversational: boolean;
    editApplied: boolean;
    browserClosed: boolean;
    conversationAfterWorkflowStayedConversational: boolean;
    desktopCleanupMovedAllDroneCompanyFolders: boolean;
  };
  localIntentModel: LocalIntentProof;
  results: readonly StepResult[];
}

type EnvSnapshot = Record<string, string | undefined>;

const RUN_ID = `${Date.now()}`;
const COMMAND = "npx tsx scripts/evidence/telegramDesktopWorkflowAndCleanupLiveSmoke.ts";
const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/telegram_desktop_workflow_and_cleanup_live_smoke_report.json"
);
const CONFIRM_ENV = "BRAIN_TELEGRAM_HUMAN_LIVE_SMOKE_CONFIRM";
const SESSION_STATE_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-telegram-desktop-workflow-smoke-${RUN_ID}.json`
);
const CORE_STATE_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-telegram-desktop-workflow-core-${RUN_ID}.json`
);
const LEDGER_SQLITE_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-telegram-desktop-workflow-ledgers-${RUN_ID}.sqlite`
);
const LIVE_RUN_RUNTIME_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-telegram-desktop-workflow-live-run-${RUN_ID}`
);
const CONVERSATION_TIMEOUT_MS = 45_000;
const WORKFLOW_TIMEOUT_MS = 150_000;
const CLEANUP_TIMEOUT_MS = 180_000;
const SMOKE_DEADLINE_MS = 480_000;
const POLL_INTERVAL_MS = 250;
const PROVIDER_BLOCK_PATTERN =
  /(?:429|exceeded your current quota|rate limit|fetch failed|request timed out|socket hang up|ECONNRESET|effective backend is mock|missing OPENAI_API_KEY)/i;
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /I'?m starting on that now/i,
  /Working on your request now/i,
  /Request failed:/i
] as const;
const THIRD_PERSON_SELF_REFERENCE_PATTERNS: readonly RegExp[] = [
  /\bAI assistant here\b/i,
  /\bthis AI assistant\b/i,
  /\bBigBrain\s+(?:can|will|is|has|should|would|could)\b/i
] as const;
const LOCAL_ORGANIZATION_NO_PROOF_PATTERN =
  /I checked the requested folders, but this run did not prove that the matching folders were moved into the requested destination yet\./i;
const LOCAL_ORGANIZATION_MOVE_PROOF_PATTERN = /^I moved .+ into /i;

function parseBoolean(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
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

function normalizeForEquality(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function textsProbablyMatch(left: string | null, right: string | null): boolean {
  const normalizedLeft = normalizeForEquality(left);
  const normalizedRight = normalizeForEquality(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.includes(normalizedRight.slice(0, Math.min(160, normalizedRight.length))) ||
    normalizedRight.includes(normalizedLeft.slice(0, Math.min(160, normalizedLeft.length)))
  );
}

function selectConversationReply(
  outboundDeliveries: readonly TelegramOutboundDeliveryObservation[],
  latestWorkflowSummary: string | null,
  sessionReply: string | null
): string | null {
  for (let index = outboundDeliveries.length - 1; index >= 0; index -= 1) {
    const candidate = outboundDeliveries[index]?.text ?? null;
    if (!candidate?.trim()) {
      continue;
    }
    if (!textsProbablyMatch(candidate, latestWorkflowSummary)) {
      return candidate;
    }
  }
  return sessionReply;
}

function selectWorkflowReply(
  outboundDeliveries: readonly TelegramOutboundDeliveryObservation[],
  latestWorkflowSummary: string | null,
  sessionReply: string | null
): string | null {
  for (let index = outboundDeliveries.length - 1; index >= 0; index -= 1) {
    const candidate = outboundDeliveries[index]?.text ?? null;
    if (textsProbablyMatch(candidate, latestWorkflowSummary)) {
      return candidate;
    }
  }
  return latestWorkflowSummary ?? outboundDeliveries.slice(-1)[0]?.text ?? sessionReply;
}

function extractWorkspaceRoot(session: ConversationSession | null): string | null {
  if (!session) {
    return null;
  }
  if (session.activeWorkspace?.rootPath) {
    return session.activeWorkspace.rootPath;
  }
  if (session.activeWorkspace?.primaryArtifactPath) {
    return path.dirname(session.activeWorkspace.primaryArtifactPath);
  }
  const browserWorkspace = session.browserSessions.find(
    (entry) => typeof entry.workspaceRootPath === "string" && entry.workspaceRootPath.trim().length > 0
  )?.workspaceRootPath;
  if (browserWorkspace) {
    return browserWorkspace;
  }
  const processDestination = session.pathDestinations.find((entry) =>
    entry.id.startsWith("path:process:")
  );
  if (processDestination) {
    return processDestination.resolvedPath;
  }
  const fileDestination = session.pathDestinations.find((entry) =>
    entry.resolvedPath.endsWith("index.html")
  );
  if (fileDestination) {
    return path.dirname(fileDestination.resolvedPath);
  }
  return null;
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
  const recentUrl = session.recentActions.find(
    (entry) => entry.kind === "url" && typeof entry.location === "string"
  );
  return recentUrl?.location ?? null;
}

function extractBrowserSessionId(session: ConversationSession | null, previewUrl: string | null): string | null {
  if (!session) {
    return null;
  }
  const matchingBrowser = session.browserSessions.find(
    (entry) =>
      (previewUrl ? entry.url === previewUrl : true) &&
      (entry.status === "open" || entry.status === "closed")
  );
  if (matchingBrowser) {
    return matchingBrowser.id;
  }
  return session.activeWorkspace?.browserSessionId ?? null;
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

async function isPreviewReachable(url: string | null): Promise<boolean> {
  if (!url) {
    return false;
  }
  try {
    const response = await fetchWithTimeout(url, 5_000);
    return response.ok;
  } catch {
    return false;
  }
}

function isFilePreviewUrl(url: string | null): boolean {
  return typeof url === "string" && url.trim().toLowerCase().startsWith("file://");
}

async function isPreviewShownInBrowser(url: string | null): Promise<boolean> {
  if (isFilePreviewUrl(url)) {
    return true;
  }
  return isPreviewReachable(url);
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

async function listDroneCompanyFolders(rootPath: string): Promise<string[]> {
  const entries = await readdir(rootPath, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("drone-company"))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

async function readObservation(
  store: InterfaceSessionStore,
  sessionKey: string,
  kind: StepKind,
  previousAssistantTurnCount: number,
  previousRecentJobCount: number,
  outboundDeliveries: readonly TelegramOutboundDeliveryObservation[],
  previousOutboundDeliveryCount: number
): Promise<StepObservation> {
  const session = await store.getSession(sessionKey);
  const assistantTurns =
    session?.conversationTurns.filter((turn) => turn.role === "assistant") ?? [];
  const latestRecentJob = session?.recentJobs[0] ?? null;
  const newAssistantTurns = Math.max(0, assistantTurns.length - previousAssistantTurnCount);
  const newRecentJobs = Math.max(0, (session?.recentJobs.length ?? 0) - previousRecentJobCount);
  const currentOutboundDeliveries = outboundDeliveries.slice(previousOutboundDeliveryCount);
  const sessionReply = newAssistantTurns > 0
    ? assistantTurns.slice(-1)[0]?.text ?? null
    : null;
  const latestRecentJobSummary = latestRecentJob?.resultSummary ?? null;
  const reply = kind === "conversation"
    ? selectConversationReply(currentOutboundDeliveries, latestRecentJobSummary, sessionReply)
    : selectWorkflowReply(currentOutboundDeliveries, latestRecentJobSummary, sessionReply);

  return {
    reply,
    sessionReply,
    session,
    runningJobId: session?.runningJobId ?? null,
    queuedJobs: session?.queuedJobs.length ?? 0,
    recentJobs: session?.recentJobs.length ?? 0,
    newAssistantTurns,
    newRecentJobs,
    newOutboundDeliveries: currentOutboundDeliveries.length,
    observedWorkerActivity:
      Boolean(session?.runningJobId) ||
      (session?.queuedJobs.length ?? 0) > 0 ||
      newRecentJobs > 0,
    outboundTexts: currentOutboundDeliveries.map((delivery) => delivery.text),
    latestRecentJobStatus: latestRecentJob?.status ?? null,
    latestRecentJobSummary
  };
}

async function settleWorkflowObservation(
  store: InterfaceSessionStore,
  sessionKey: string,
  previousAssistantTurnCount: number,
  previousRecentJobCount: number,
  outboundDeliveries: readonly TelegramOutboundDeliveryObservation[],
  previousOutboundDeliveryCount: number
): Promise<StepObservation> {
  let previous = await readObservation(
    store,
    sessionKey,
    "workflow",
    previousAssistantTurnCount,
    previousRecentJobCount,
    outboundDeliveries,
    previousOutboundDeliveryCount
  );
  for (let index = 0; index < 8; index += 1) {
    await sleep(POLL_INTERVAL_MS);
    const current = await readObservation(
      store,
      sessionKey,
      "workflow",
      previousAssistantTurnCount,
      previousRecentJobCount,
      outboundDeliveries,
      previousOutboundDeliveryCount
    );
    if (
      current.newAssistantTurns === previous.newAssistantTurns &&
      current.newRecentJobs === previous.newRecentJobs &&
      current.newOutboundDeliveries === previous.newOutboundDeliveries &&
      current.runningJobId === null &&
      current.queuedJobs === 0
    ) {
      return current;
    }
    previous = current;
  }
  return previous;
}

async function waitForConversationOutcome(
  store: InterfaceSessionStore,
  sessionKey: string,
  previousAssistantTurnCount: number,
  previousRecentJobCount: number,
  outboundDeliveries: readonly TelegramOutboundDeliveryObservation[],
  previousOutboundDeliveryCount: number,
  timeoutMs: number
): Promise<StepObservation> {
  const maxPolls = Math.ceil(timeoutMs / POLL_INTERVAL_MS);
  for (let index = 0; index < maxPolls; index += 1) {
    const observation = await readObservation(
      store,
      sessionKey,
      "conversation",
      previousAssistantTurnCount,
      previousRecentJobCount,
      outboundDeliveries,
      previousOutboundDeliveryCount
    );
    if (
      observation.reply?.trim() &&
      observation.newOutboundDeliveries > 0 &&
      observation.observedWorkerActivity === false
    ) {
      return observation;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return readObservation(
    store,
    sessionKey,
    "conversation",
    previousAssistantTurnCount,
    previousRecentJobCount,
    outboundDeliveries,
    previousOutboundDeliveryCount
  );
}

async function waitForWorkflowOutcome(
  store: InterfaceSessionStore,
  sessionKey: string,
  previousAssistantTurnCount: number,
  previousRecentJobCount: number,
  outboundDeliveries: readonly TelegramOutboundDeliveryObservation[],
  previousOutboundDeliveryCount: number,
  timeoutMs: number,
  readinessCheck?: (observation: StepObservation) => Promise<boolean>
): Promise<StepObservation> {
  const maxPolls = Math.ceil(timeoutMs / POLL_INTERVAL_MS);
  for (let index = 0; index < maxPolls; index += 1) {
    const observation = await readObservation(
      store,
      sessionKey,
      "workflow",
      previousAssistantTurnCount,
      previousRecentJobCount,
      outboundDeliveries,
      previousOutboundDeliveryCount
    );
    const finishedNewJob =
      observation.newRecentJobs > 0 &&
      observation.runningJobId === null &&
      observation.queuedJobs === 0 &&
      observation.latestRecentJobStatus !== null &&
      observation.latestRecentJobStatus !== "running";
    if (finishedNewJob) {
      if (observation.latestRecentJobStatus !== "completed") {
        return settleWorkflowObservation(
          store,
          sessionKey,
          previousAssistantTurnCount,
          previousRecentJobCount,
          outboundDeliveries,
          previousOutboundDeliveryCount
        );
      }
      if (!readinessCheck || (await readinessCheck(observation))) {
        return settleWorkflowObservation(
          store,
          sessionKey,
          previousAssistantTurnCount,
          previousRecentJobCount,
          outboundDeliveries,
          previousOutboundDeliveryCount
        );
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return readObservation(
    store,
    sessionKey,
    "workflow",
    previousAssistantTurnCount,
    previousRecentJobCount,
    outboundDeliveries,
    previousOutboundDeliveryCount
  );
}

function collectTextPool(observation: StepObservation): string[] {
  return [
    observation.reply ?? "",
    observation.sessionReply ?? "",
    observation.latestRecentJobSummary ?? "",
    ...observation.outboundTexts
  ].filter((value, index, array) => value.trim().length > 0 && array.indexOf(value) === index);
}

function hasMoveProofLanguage(observation: StepObservation): boolean {
  return collectTextPool(observation).some((text) =>
    LOCAL_ORGANIZATION_MOVE_PROOF_PATTERN.test(text.replace(/\s+/g, " ").trim())
  );
}

function detectForbiddenPatterns(
  patterns: readonly RegExp[],
  observation: StepObservation
): string[] {
  const textPool = collectTextPool(observation);
  const failures: string[] = [];
  for (const pattern of patterns) {
    if (textPool.some((text) => pattern.test(text))) {
      failures.push(`forbidden_reply_shape:${pattern.source}`);
    }
  }
  return failures;
}

function findProviderBlockerReason(session: ConversationSession | null): string | null {
  if (!session) {
    return null;
  }
  const blockedJob = [...session.recentJobs]
    .reverse()
    .find((job) => {
      const combined = [job.errorMessage ?? "", job.resultSummary ?? ""].join("\n");
      return PROVIDER_BLOCK_PATTERN.test(combined);
    });
  if (blockedJob) {
    return [blockedJob.errorMessage ?? "", blockedJob.resultSummary ?? ""]
      .filter((value) => value.trim().length > 0)
      .join("\n");
  }
  const assistantTurn = [...session.conversationTurns]
    .reverse()
    .find((turn) => turn.role === "assistant" && PROVIDER_BLOCK_PATTERN.test(turn.text));
  return assistantTurn?.text ?? null;
}

function classifyArtifactStatus(reason: string | null): SmokeArtifact["status"] {
  return reason && PROVIDER_BLOCK_PATTERN.test(reason) ? "BLOCKED" : "FAIL";
}

export async function runTelegramDesktopWorkflowAndCleanupLiveSmoke(): Promise<SmokeArtifact> {
  ensureEnvLoaded();
  if (!parseBoolean(process.env[CONFIRM_ENV])) {
    throw new Error(
      `Telegram Desktop workflow live smoke is fail-closed. Set ${CONFIRM_ENV}=true to send live Telegram replies.`
    );
  }

  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });

  const localProbe = await probeLocalIntentModelFromEnv();
  const realBackend = resolveRequiredRealSmokeBackend(localProbe);
  const envSnapshot = applyEnvOverrides({
    ...buildSmokeModelEnvOverrides(localProbe).envOverrides,
    BRAIN_LIVE_RUN_RUNTIME_PATH: LIVE_RUN_RUNTIME_PATH,
    BRAIN_STATE_JSON_PATH: CORE_STATE_PATH,
    BRAIN_LEDGER_SQLITE_PATH: LEDGER_SQLITE_PATH,
    BRAIN_LEDGER_EXPORT_JSON_ON_WRITE: "false",
    BRAIN_ENABLE_EMBEDDINGS: "false",
    BRAIN_ENABLE_DYNAMIC_PULSE: "false"
  });

  const localIntentModel: LocalIntentProof = {
    enabled: localProbe.enabled,
    required: localProbe.liveSmokeRequired,
    reachable: localProbe.reachable,
    modelPresent: localProbe.modelPresent,
    model: localProbe.model,
    provider: localProbe.provider,
    baseUrl: localProbe.baseUrl,
    effectiveBackend: realBackend.effectiveBackend
  };

  const desktopPath = await resolveDesktopPath();
  const droneFolderPath = path.join(desktopPath, "drone-folder");
  const targetFolderName = `drone-company-telegram-live-smoke-${RUN_ID}`;
  const targetFolderPath = path.join(desktopPath, targetFolderName);
  const results: StepResult[] = [];
  let blockerReason: string | null = realBackend.blockerReason;
  let previewUrl: string | null = null;
  let browserSessionId: string | null = null;
  let cleanupBaselineRootFolders: string[] = [];
  let finalRootFolders: string[] = [];

  try {
    if (realBackend.blockerReason) {
      return {
        generatedAt: new Date().toISOString(),
        command: COMMAND,
        status: "BLOCKED",
        provider: "telegram",
        blockerReason: realBackend.blockerReason,
        desktopPath,
        droneFolderPath,
        targetFolderName,
        targetFolderPath: null,
        previewUrl: null,
        browserSessionId: null,
        cleanupBaselineRootFolders: [],
        finalRootFolders: [],
        checks: {
          conversationBeforeBuildStayedConversational: false,
          buildOpenedBrowser: false,
          conversationDuringWorkflowStayedConversational: false,
          editApplied: false,
          browserClosed: false,
          conversationAfterWorkflowStayedConversational: false,
          desktopCleanupMovedAllDroneCompanyFolders: false
        },
        localIntentModel,
        results
      };
    }

    const config = createInterfaceRuntimeConfigFromEnv();
    if (config.provider !== "telegram" && config.provider !== "both") {
      throw new Error(`Telegram is not enabled in this environment (provider=${config.provider}).`);
    }
    const telegram = config.provider === "both" ? config.telegram : config;
    const username = telegram.security.allowedUsernames[0];
    const userId =
      telegram.security.allowedUserIds[0] ?? "telegram-desktop-workflow-live-smoke-user";
    const chatId = telegram.allowedChatIds[0];
    if (!username) {
      throw new Error("BRAIN_INTERFACE_ALLOWED_USERNAMES must include at least one username.");
    }
    if (!chatId) {
      throw new Error("TELEGRAM_ALLOWED_CHAT_IDS must include at least one chat id.");
    }

    const outboundDeliveries: TelegramOutboundDeliveryObservation[] = [];
    const sessionStore = new InterfaceSessionStore(SESSION_STATE_PATH, { backend: "json" });
    const brain = buildDefaultBrain();
    const gateway = new TelegramGateway(
      new TelegramAdapter(brain, {
        auth: {
          requiredToken: telegram.security.sharedSecret
        },
        allowlist: {
          allowedUsernames: telegram.security.allowedUsernames,
          allowedUserIds: telegram.security.allowedUserIds,
          allowedChatIds: telegram.allowedChatIds
        },
        rateLimit: {
          windowMs: telegram.security.rateLimitWindowMs,
          maxEventsPerWindow: Math.max(telegram.security.maxEventsPerWindow, 1000)
        },
        replay: {
          maxTrackedUpdateIds: telegram.security.replayCacheSize
        }
      }),
      telegram,
      {
        sessionStore,
        onOutboundDelivery: (event) => {
          outboundDeliveries.push(event);
        }
      }
    );
    const gatewayProcessor = gateway as unknown as {
      processUpdate(update: {
        update_id: number;
        message: {
          text: string;
          chat: { id: string; type: "private" };
          from: { id: string; username: string };
          date: number;
        };
      }): Promise<void>;
    };

    const sessionKey = `telegram:${chatId}:${userId}`;
    const deadlineAtMs = Date.now() + SMOKE_DEADLINE_MS;
    const conversationBefore: StepDefinition = {
      id: "conversation_before_build",
      kind: "conversation",
      prompt:
        "Hey BigBrain.\n\nI've had a long day and I'm still settling in. Before we start anything, can we just talk for a minute?\n\nPlease reply in two short paragraphs and don't start work yet.",
      requiredAny: [/\n\n/],
      forbiddenAny: [...PLACEHOLDER_PATTERNS, ...THIRD_PERSON_SELF_REFERENCE_PATTERNS]
    };
    const buildStep: StepDefinition = {
      id: "build_landing_page",
      kind: "workflow",
      prompt:
        `Alright, let's do something real. Please build a calm air-drone landing page on my desktop in a folder called ${targetFolderName}, open it in a browser, and leave it there for me when it's ready.`,
      forbiddenAny: [...PLACEHOLDER_PATTERNS, ...THIRD_PERSON_SELF_REFERENCE_PATTERNS]
    };
    const conversationDuring: StepDefinition = {
      id: "conversation_during_workflow",
      kind: "conversation",
      prompt:
        "Thanks. I'm getting in my own head a little tonight.\n\nBefore you change anything, can we just talk for a minute about keeping the tone calm and reassuring?\n\nPlease reply in two short paragraphs and don't do the edit yet.",
      requiredAny: [/\n\n/],
      forbiddenAny: [...PLACEHOLDER_PATTERNS, ...THIRD_PERSON_SELF_REFERENCE_PATTERNS]
    };
    const editStep: StepDefinition = {
      id: "edit_landing_page",
      kind: "workflow",
      prompt:
        "That helps. Please change the hero section so the headline literally says 'Calmer drone operations start here', and add a short trust bar that literally says 'Trusted by local teams'. Leave the updated page in the same place when you're done.",
      forbiddenAny: [...PLACEHOLDER_PATTERNS, ...THIRD_PERSON_SELF_REFERENCE_PATTERNS]
    };
    const closeStep: StepDefinition = {
      id: "close_preview",
      kind: "workflow",
      prompt:
        "Nice. Please close that landing page and anything it needs so we can move on.",
      forbiddenAny: [...PLACEHOLDER_PATTERNS, ...THIRD_PERSON_SELF_REFERENCE_PATTERNS]
    };
    const conversationAfter: StepDefinition = {
      id: "conversation_after_workflow",
      kind: "conversation",
      prompt:
        "Thanks. One more human question before we wrap up.\n\nWhen the day feels messy, how do you usually keep momentum without making things feel frantic?\n\nPlease reply in two short paragraphs.",
      requiredAny: [/\n\n/],
      forbiddenAny: [...PLACEHOLDER_PATTERNS, ...THIRD_PERSON_SELF_REFERENCE_PATTERNS]
    };
    const cleanupStep: StepDefinition = {
      id: "cleanup_desktop_drone_folders",
      kind: "workflow",
      prompt:
        "One last real-world thing: please go ahead and clean up my desktop now by moving every folder there that starts with drone-company into drone-folder. I do mean all of them, so you do not need to ask again before doing it.",
      forbiddenAny: [...PLACEHOLDER_PATTERNS, ...THIRD_PERSON_SELF_REFERENCE_PATTERNS]
    };

    const processStep = async (
      step: StepDefinition,
      timeoutMs: number,
      readinessCheck?: (observation: StepObservation) => Promise<boolean>
    ): Promise<StepObservation> => {
      const existingSession = await sessionStore.getSession(sessionKey);
      const previousAssistantTurnCount =
        existingSession?.conversationTurns.filter((turn) => turn.role === "assistant").length ?? 0;
      const previousRecentJobCount = existingSession?.recentJobs.length ?? 0;
      const previousOutboundDeliveryCount = outboundDeliveries.length;

      await gatewayProcessor.processUpdate({
        update_id: 98_000 + results.length,
        message: {
          text: step.prompt,
          chat: { id: chatId, type: "private" },
          from: { id: userId, username },
          date: Math.floor(Date.now() / 1000)
        }
      });

      if (step.kind === "conversation") {
        return waitForConversationOutcome(
          sessionStore,
          sessionKey,
          previousAssistantTurnCount,
          previousRecentJobCount,
          outboundDeliveries,
          previousOutboundDeliveryCount,
          getRemainingSmokeBudget(deadlineAtMs, timeoutMs, step.id)
        );
      }

      return waitForWorkflowOutcome(
        sessionStore,
        sessionKey,
        previousAssistantTurnCount,
        previousRecentJobCount,
        outboundDeliveries,
        previousOutboundDeliveryCount,
        getRemainingSmokeBudget(deadlineAtMs, timeoutMs, step.id),
        readinessCheck
      );
    };

    await sessionStore.deleteSession(sessionKey);

    const beforeBuildObservation = await processStep(conversationBefore, CONVERSATION_TIMEOUT_MS);
    const beforeBuildFailures = [
      ...(beforeBuildObservation.reply?.trim() ? [] : ["missing_conversation_reply"]),
      ...(beforeBuildObservation.observedWorkerActivity ? ["unexpected_worker_activity"] : []),
      ...(beforeBuildObservation.newRecentJobs > 0 ? [`unexpected_new_recent_jobs:${beforeBuildObservation.newRecentJobs}`] : []),
      ...detectForbiddenPatterns(conversationBefore.forbiddenAny ?? [], beforeBuildObservation)
    ];
    if ((conversationBefore.requiredAny?.length ?? 0) > 0) {
      const hasRequired = conversationBefore.requiredAny!.some((pattern) =>
        pattern.test(beforeBuildObservation.reply ?? "")
      );
      if (!hasRequired) {
        beforeBuildFailures.push("missing_required_reply_shape");
      }
    }
    results.push({
      id: conversationBefore.id,
      kind: conversationBefore.kind,
      prompt: conversationBefore.prompt,
      reply: beforeBuildObservation.reply,
      sessionReply: beforeBuildObservation.sessionReply,
      outboundTexts: beforeBuildObservation.outboundTexts,
      newAssistantTurns: beforeBuildObservation.newAssistantTurns,
      newRecentJobs: beforeBuildObservation.newRecentJobs,
      newOutboundDeliveries: beforeBuildObservation.newOutboundDeliveries,
      observedWorkerActivity: beforeBuildObservation.observedWorkerActivity,
      latestRecentJobStatus: beforeBuildObservation.latestRecentJobStatus,
      latestRecentJobSummary: beforeBuildObservation.latestRecentJobSummary,
      pass: beforeBuildFailures.length === 0,
      failures: beforeBuildFailures
    });

    const buildObservation = await processStep(
      buildStep,
      WORKFLOW_TIMEOUT_MS,
      async (observation) => {
        const session = observation.session;
        const builtFolderExists = await isDirectory(targetFolderPath);
        const preview = extractPreviewUrl(session);
        const previewShown = await isPreviewShownInBrowser(preview);
        const workspaceRoot = extractWorkspaceRoot(session);
        const browserOpen = session?.browserSessions.some(
          (entry) =>
            entry.status === "open" &&
            entry.workspaceRootPath === targetFolderPath
        ) ?? false;
        return builtFolderExists && previewShown && workspaceRoot === targetFolderPath && browserOpen;
      }
    );
    const buildWorkspaceRoot = extractWorkspaceRoot(buildObservation.session);
    previewUrl = extractPreviewUrl(buildObservation.session);
    browserSessionId = extractBrowserSessionId(buildObservation.session, previewUrl);
    const buildFailures = [
      ...(buildObservation.observedWorkerActivity ? [] : ["missing_worker_activity"]),
      ...(buildObservation.newRecentJobs > 0 ? [] : ["missing_new_recent_job"]),
      ...(buildObservation.latestRecentJobStatus === "completed"
        ? []
        : [`workflow_step_not_completed:${buildObservation.latestRecentJobStatus ?? "unknown"}`]),
      ...detectForbiddenPatterns(buildStep.forbiddenAny ?? [], buildObservation)
    ];
    if (!(await isDirectory(targetFolderPath))) {
      buildFailures.push("missing_target_folder");
    }
    if (buildWorkspaceRoot !== targetFolderPath) {
      buildFailures.push(`unexpected_workspace_root:${buildWorkspaceRoot ?? "null"}`);
    }
    if (!(await isPreviewShownInBrowser(previewUrl))) {
      buildFailures.push("preview_not_shown_in_browser");
    }
    if (
      !buildObservation.session?.browserSessions.some(
        (entry) => entry.status === "open" && entry.workspaceRootPath === targetFolderPath
      )
    ) {
      buildFailures.push("missing_open_browser_session");
    }
    let indexHtmlBeforeEdit = "";
    const indexPath = path.join(targetFolderPath, "index.html");
    indexHtmlBeforeEdit = await readFile(indexPath, "utf8").catch(() => "");
    if (!indexHtmlBeforeEdit) {
      buildFailures.push("missing_index_html_after_build");
    }
    results.push({
      id: buildStep.id,
      kind: buildStep.kind,
      prompt: buildStep.prompt,
      reply: buildObservation.reply,
      sessionReply: buildObservation.sessionReply,
      outboundTexts: buildObservation.outboundTexts,
      newAssistantTurns: buildObservation.newAssistantTurns,
      newRecentJobs: buildObservation.newRecentJobs,
      newOutboundDeliveries: buildObservation.newOutboundDeliveries,
      observedWorkerActivity: buildObservation.observedWorkerActivity,
      latestRecentJobStatus: buildObservation.latestRecentJobStatus,
      latestRecentJobSummary: buildObservation.latestRecentJobSummary,
      pass: buildFailures.length === 0,
      failures: buildFailures
    });

    const conversationDuringObservation = await processStep(
      conversationDuring,
      CONVERSATION_TIMEOUT_MS
    );
    const conversationDuringFailures = [
      ...(conversationDuringObservation.reply?.trim() ? [] : ["missing_conversation_reply"]),
      ...(conversationDuringObservation.observedWorkerActivity ? ["unexpected_worker_activity"] : []),
      ...(conversationDuringObservation.newRecentJobs > 0 ? [`unexpected_new_recent_jobs:${conversationDuringObservation.newRecentJobs}`] : []),
      ...detectForbiddenPatterns(conversationDuring.forbiddenAny ?? [], conversationDuringObservation)
    ];
    if ((conversationDuring.requiredAny?.length ?? 0) > 0) {
      const hasRequired = conversationDuring.requiredAny!.some((pattern) =>
        pattern.test(conversationDuringObservation.reply ?? "")
      );
      if (!hasRequired) {
        conversationDuringFailures.push("missing_required_reply_shape");
      }
    }
    results.push({
      id: conversationDuring.id,
      kind: conversationDuring.kind,
      prompt: conversationDuring.prompt,
      reply: conversationDuringObservation.reply,
      sessionReply: conversationDuringObservation.sessionReply,
      outboundTexts: conversationDuringObservation.outboundTexts,
      newAssistantTurns: conversationDuringObservation.newAssistantTurns,
      newRecentJobs: conversationDuringObservation.newRecentJobs,
      newOutboundDeliveries: conversationDuringObservation.newOutboundDeliveries,
      observedWorkerActivity: conversationDuringObservation.observedWorkerActivity,
      latestRecentJobStatus: conversationDuringObservation.latestRecentJobStatus,
      latestRecentJobSummary: conversationDuringObservation.latestRecentJobSummary,
      pass: conversationDuringFailures.length === 0,
      failures: conversationDuringFailures
    });

    const editObservation = await processStep(
      editStep,
      WORKFLOW_TIMEOUT_MS,
      async () => {
        const html = await readFile(indexPath, "utf8").catch(() => "");
        return (
          html.length > 0 &&
          html !== indexHtmlBeforeEdit &&
          /Calmer drone operations start here/i.test(html) &&
          /Trusted by local teams/i.test(html)
        );
      }
    );
    const indexHtmlAfterEdit = await readFile(indexPath, "utf8").catch(() => "");
    const editFailures = [
      ...(editObservation.observedWorkerActivity ? [] : ["missing_worker_activity"]),
      ...(editObservation.newRecentJobs > 0 ? [] : ["missing_new_recent_job"]),
      ...(editObservation.latestRecentJobStatus === "completed"
        ? []
        : [`workflow_step_not_completed:${editObservation.latestRecentJobStatus ?? "unknown"}`]),
      ...detectForbiddenPatterns(editStep.forbiddenAny ?? [], editObservation)
    ];
    if (!indexHtmlAfterEdit) {
      editFailures.push("missing_index_html_after_edit");
    }
    if (indexHtmlAfterEdit === indexHtmlBeforeEdit) {
      editFailures.push("edit_did_not_change_index_html");
    }
    if (!/Calmer drone operations start here/i.test(indexHtmlAfterEdit)) {
      editFailures.push("missing_updated_headline");
    }
    if (!/Trusted by local teams/i.test(indexHtmlAfterEdit)) {
      editFailures.push("missing_trust_bar");
    }
    results.push({
      id: editStep.id,
      kind: editStep.kind,
      prompt: editStep.prompt,
      reply: editObservation.reply,
      sessionReply: editObservation.sessionReply,
      outboundTexts: editObservation.outboundTexts,
      newAssistantTurns: editObservation.newAssistantTurns,
      newRecentJobs: editObservation.newRecentJobs,
      newOutboundDeliveries: editObservation.newOutboundDeliveries,
      observedWorkerActivity: editObservation.observedWorkerActivity,
      latestRecentJobStatus: editObservation.latestRecentJobStatus,
      latestRecentJobSummary: editObservation.latestRecentJobSummary,
      pass: editFailures.length === 0,
      failures: editFailures
    });

    const closeObservation = await processStep(
      closeStep,
      WORKFLOW_TIMEOUT_MS,
      async (observation) => {
        const trackedSession = observation.session?.browserSessions.find(
          (entry) => entry.id === browserSessionId
        );
        return trackedSession?.status === "closed" && !(await isPreviewReachable(previewUrl));
      }
    );
    const trackedBrowserAfterClose = closeObservation.session?.browserSessions.find(
      (entry) => entry.id === browserSessionId
    );
    const closeFailures = [
      ...(closeObservation.observedWorkerActivity ? [] : ["missing_worker_activity"]),
      ...(closeObservation.newRecentJobs > 0 ? [] : ["missing_new_recent_job"]),
      ...(closeObservation.latestRecentJobStatus === "completed"
        ? []
        : [`workflow_step_not_completed:${closeObservation.latestRecentJobStatus ?? "unknown"}`]),
      ...detectForbiddenPatterns(closeStep.forbiddenAny ?? [], closeObservation)
    ];
    if (trackedBrowserAfterClose?.status !== "closed") {
      closeFailures.push("browser_session_not_closed");
    }
    if (await isPreviewReachable(previewUrl)) {
      closeFailures.push("preview_still_reachable_after_close");
    }
    results.push({
      id: closeStep.id,
      kind: closeStep.kind,
      prompt: closeStep.prompt,
      reply: closeObservation.reply,
      sessionReply: closeObservation.sessionReply,
      outboundTexts: closeObservation.outboundTexts,
      newAssistantTurns: closeObservation.newAssistantTurns,
      newRecentJobs: closeObservation.newRecentJobs,
      newOutboundDeliveries: closeObservation.newOutboundDeliveries,
      observedWorkerActivity: closeObservation.observedWorkerActivity,
      latestRecentJobStatus: closeObservation.latestRecentJobStatus,
      latestRecentJobSummary: closeObservation.latestRecentJobSummary,
      pass: closeFailures.length === 0,
      failures: closeFailures
    });

    const conversationAfterObservation = await processStep(
      conversationAfter,
      CONVERSATION_TIMEOUT_MS
    );
    const conversationAfterFailures = [
      ...(conversationAfterObservation.reply?.trim() ? [] : ["missing_conversation_reply"]),
      ...(conversationAfterObservation.observedWorkerActivity ? ["unexpected_worker_activity"] : []),
      ...(conversationAfterObservation.newRecentJobs > 0 ? [`unexpected_new_recent_jobs:${conversationAfterObservation.newRecentJobs}`] : []),
      ...detectForbiddenPatterns(conversationAfter.forbiddenAny ?? [], conversationAfterObservation)
    ];
    if ((conversationAfter.requiredAny?.length ?? 0) > 0) {
      const hasRequired = conversationAfter.requiredAny!.some((pattern) =>
        pattern.test(conversationAfterObservation.reply ?? "")
      );
      if (!hasRequired) {
        conversationAfterFailures.push("missing_required_reply_shape");
      }
    }
    results.push({
      id: conversationAfter.id,
      kind: conversationAfter.kind,
      prompt: conversationAfter.prompt,
      reply: conversationAfterObservation.reply,
      sessionReply: conversationAfterObservation.sessionReply,
      outboundTexts: conversationAfterObservation.outboundTexts,
      newAssistantTurns: conversationAfterObservation.newAssistantTurns,
      newRecentJobs: conversationAfterObservation.newRecentJobs,
      newOutboundDeliveries: conversationAfterObservation.newOutboundDeliveries,
      observedWorkerActivity: conversationAfterObservation.observedWorkerActivity,
      latestRecentJobStatus: conversationAfterObservation.latestRecentJobStatus,
      latestRecentJobSummary: conversationAfterObservation.latestRecentJobSummary,
      pass: conversationAfterFailures.length === 0,
      failures: conversationAfterFailures
    });

    cleanupBaselineRootFolders = await listDroneCompanyFolders(desktopPath);
    const cleanupObservation = await processStep(
      cleanupStep,
      CLEANUP_TIMEOUT_MS,
      async () => {
        const remainingAtRoot = await listDroneCompanyFolders(desktopPath);
        if (remainingAtRoot.length > 0) {
          return false;
        }
        return (
          await Promise.all(
            cleanupBaselineRootFolders.map((name) =>
              isDirectory(path.join(droneFolderPath, name))
            )
          )
        ).every(Boolean);
      }
    );
    finalRootFolders = await listDroneCompanyFolders(desktopPath);
    const movedFolders = await Promise.all(
      cleanupBaselineRootFolders.map(async (name) => ({
        name,
        present: await isDirectory(path.join(droneFolderPath, name))
      }))
    );
    const cleanupFailures = [
      ...(cleanupObservation.observedWorkerActivity ? [] : ["missing_worker_activity"]),
      ...(cleanupObservation.newRecentJobs > 0 ? [] : ["missing_new_recent_job"]),
      ...(cleanupObservation.latestRecentJobStatus === "completed"
        ? []
        : [`workflow_step_not_completed:${cleanupObservation.latestRecentJobStatus ?? "unknown"}`]),
      ...detectForbiddenPatterns(cleanupStep.forbiddenAny ?? [], cleanupObservation)
    ];
    if (finalRootFolders.length > 0) {
      cleanupFailures.push(`remaining_root_folders:${finalRootFolders.join(",")}`);
    }
    const missingFromDroneFolder = movedFolders
      .filter((entry) => entry.present === false)
      .map((entry) => entry.name);
    if (missingFromDroneFolder.length > 0) {
      cleanupFailures.push(`missing_from_drone_folder:${missingFromDroneFolder.join(",")}`);
    }
    if (!hasMoveProofLanguage(cleanupObservation)) {
      cleanupFailures.push("cleanup_reply_missing_move_proof");
    }
    if (
      collectTextPool(cleanupObservation).some((text) =>
        LOCAL_ORGANIZATION_NO_PROOF_PATTERN.test(text)
      )
    ) {
      cleanupFailures.push("cleanup_reply_claimed_no_proof");
    }
    results.push({
      id: cleanupStep.id,
      kind: cleanupStep.kind,
      prompt: cleanupStep.prompt,
      reply: cleanupObservation.reply,
      sessionReply: cleanupObservation.sessionReply,
      outboundTexts: cleanupObservation.outboundTexts,
      newAssistantTurns: cleanupObservation.newAssistantTurns,
      newRecentJobs: cleanupObservation.newRecentJobs,
      newOutboundDeliveries: cleanupObservation.newOutboundDeliveries,
      observedWorkerActivity: cleanupObservation.observedWorkerActivity,
      latestRecentJobStatus: cleanupObservation.latestRecentJobStatus,
      latestRecentJobSummary: cleanupObservation.latestRecentJobSummary,
      pass: cleanupFailures.length === 0,
      failures: cleanupFailures
    });

    blockerReason = findProviderBlockerReason(cleanupObservation.session);
  } catch (error) {
    blockerReason =
      blockerReason ??
      (error instanceof Error ? error.stack ?? error.message : String(error));
  } finally {
    await rm(SESSION_STATE_PATH, { force: true }).catch(() => undefined);
    await rm(CORE_STATE_PATH, { force: true }).catch(() => undefined);
    await rm(`${CORE_STATE_PATH}.lock`, { force: true }).catch(() => undefined);
    await rm(LEDGER_SQLITE_PATH, { force: true }).catch(() => undefined);
    await rm(`${LEDGER_SQLITE_PATH}-shm`, { force: true }).catch(() => undefined);
    await rm(`${LEDGER_SQLITE_PATH}-wal`, { force: true }).catch(() => undefined);
    await rm(LIVE_RUN_RUNTIME_PATH, { recursive: true, force: true }).catch(() => undefined);
    restoreEnv(envSnapshot);
  }

  const checks = {
    conversationBeforeBuildStayedConversational:
      results.find((result) => result.id === "conversation_before_build")?.pass ?? false,
    buildOpenedBrowser:
      results.find((result) => result.id === "build_landing_page")?.pass ?? false,
    conversationDuringWorkflowStayedConversational:
      results.find((result) => result.id === "conversation_during_workflow")?.pass ?? false,
    editApplied:
      results.find((result) => result.id === "edit_landing_page")?.pass ?? false,
    browserClosed:
      results.find((result) => result.id === "close_preview")?.pass ?? false,
    conversationAfterWorkflowStayedConversational:
      results.find((result) => result.id === "conversation_after_workflow")?.pass ?? false,
    desktopCleanupMovedAllDroneCompanyFolders:
      results.find((result) => result.id === "cleanup_desktop_drone_folders")?.pass ?? false
  };

  const status =
    blockerReason
      ? classifyArtifactStatus(blockerReason)
      : results.length === 7 && results.every((result) => result.pass) && Object.values(checks).every(Boolean)
        ? "PASS"
        : "FAIL";

  return {
    generatedAt: new Date().toISOString(),
    command: COMMAND,
    status,
    provider: "telegram",
    blockerReason,
    desktopPath,
    droneFolderPath,
    targetFolderName,
    targetFolderPath: results.some((result) => result.id === "build_landing_page")
      ? targetFolderPath
      : null,
    previewUrl,
    browserSessionId,
    cleanupBaselineRootFolders,
    finalRootFolders,
    checks,
    localIntentModel,
    results
  };
}

async function main(): Promise<void> {
  const artifact = await runTelegramDesktopWorkflowAndCleanupLiveSmoke();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`Telegram Desktop workflow live smoke status: ${artifact.status}`);
  console.log(`Artifact: ${ARTIFACT_PATH}`);
  if (artifact.blockerReason) {
    console.error(`Blocker: ${artifact.blockerReason}`);
  }
  if (artifact.status !== "PASS") {
    process.exit(1);
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
