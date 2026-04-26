/**
 * @fileoverview Runs one real Telegram live smoke for the exact Calm Sample static-site voice-note workflow.
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildDefaultBrain } from "../../src/core/buildBrain";
import { ensureEnvLoaded } from "../../src/core/envLoader";
import { TelegramAdapter } from "../../src/interfaces/telegramAdapter";
import {
  TelegramGateway,
  type TelegramOutboundDeliveryObservation
} from "../../src/interfaces/telegramGateway";
import { createInterfaceRuntimeConfigFromEnv } from "../../src/interfaces/runtimeConfig";
import { InterfaceSessionStore } from "../../src/interfaces/sessionStore";
import { probeLocalIntentModelFromEnv } from "../../src/organs/languageUnderstanding/localIntentModelRuntime";
import { MediaUnderstandingOrgan } from "../../src/organs/mediaUnderstanding/mediaInterpretation";
import {
  buildTelegramUpdateForScenario,
  createMediaFixtureCatalog,
  type MediaIngestExecutionIntentScenario
} from "./mediaIngestExecutionIntentSupport";
import {
  buildSmokeModelEnvOverrides,
  resolveRequiredRealSmokeBackend
} from "./smokeModelEnv";

interface VoiceDesktopWorkflowSmokeArtifact {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL" | "BLOCKED";
  blockerReason: string | null;
  transcript: string;
  backend: string;
  targetFolderPath: string;
  workspaceRoot: string | null;
  previewUrl: string | null;
  previewReachable: boolean;
  browserSessionStatus: string | null;
  packageJsonExists: boolean;
  reactEntryExists: boolean;
  cssEntryExists: boolean;
  latestAssistantReply: string | null;
  latestJob: {
    id: string;
    status: string;
    summary: string | null;
    errorMessage: string | null;
    recoveryKind: string | null;
    recoveryStatus: string | null;
    recoveryClass: string | null;
    recoverySummary: string | null;
    approvedActionCount: number | null;
    blockedActionCount: number | null;
    startedAt: string | null;
    completedAt: string | null;
  } | null;
  recoveryAttempted: boolean;
  recoveryRecovered: boolean;
  outboundDeliveries: readonly {
    kind: TelegramOutboundDeliveryObservation["kind"];
    text: string;
    sequence: number;
    jobId: string | null;
  }[];
}

type EnvSnapshot = Record<string, string | undefined>;

const RUN_ID = `${Date.now()}`;
const COMMAND = "npx tsx scripts/evidence/telegramVoiceDesktopWorkflowLiveSmoke.ts";
const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/telegram_voice_desktop_workflow_live_smoke_report.json"
);
const CONFIRM_ENV = "BRAIN_TELEGRAM_HUMAN_LIVE_SMOKE_CONFIRM";
const SESSION_STATE_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-telegram-voice-desktop-workflow-smoke-${RUN_ID}.json`
);
const CORE_STATE_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-telegram-voice-desktop-workflow-core-${RUN_ID}.json`
);
const LEDGER_SQLITE_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-telegram-voice-desktop-workflow-ledgers-${RUN_ID}.sqlite`
);
const LIVE_RUN_RUNTIME_PATH = path.resolve(
  process.cwd(),
  `runtime/tmp-telegram-voice-desktop-workflow-live-run-${RUN_ID}`
);
const FIXTURE_DOWNLOAD_PATH = "fixtures/fix_request.ogg";
const TIMEOUT_MS = 14 * 60 * 1000;
const TRANSCRIPT =
  "I would like you to build a landing page called Calm Sample as a static HTML website and put it on my desktop. There should be a little flying sample in the hero and it should be a five section landing page with a footer and a navigation. It should feel calm. Also this should be done end to end and I would like you to leave it open in the browser so I can take a look at it.";

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

function extractWorkspaceRoot(session: {
  activeWorkspace?: { rootPath?: string | null; primaryArtifactPath?: string | null } | null;
  browserSessions?: { workspaceRootPath?: string | null }[];
} | null): string | null {
  if (!session) {
    return null;
  }
  if (session.activeWorkspace?.rootPath) {
    return session.activeWorkspace.rootPath;
  }
  if (session.activeWorkspace?.primaryArtifactPath) {
    return path.dirname(session.activeWorkspace.primaryArtifactPath);
  }
  return (
    session.browserSessions?.find(
      (entry) =>
        typeof entry.workspaceRootPath === "string" &&
        entry.workspaceRootPath.trim().length > 0
    )?.workspaceRootPath ?? null
  );
}

function extractPreviewUrl(session: {
  activeWorkspace?: { previewUrl?: string | null } | null;
  browserSessions?: { status: string; url: string }[];
} | null): string | null {
  if (!session) {
    return null;
  }
  if (session.activeWorkspace?.previewUrl) {
    return session.activeWorkspace.previewUrl;
  }
  return session.browserSessions?.find((entry) => entry.status === "open")?.url ?? null;
}

function extractBrowserSessionStatus(
  session: {
    browserSessions?: { status: string; url: string }[];
  } | null,
  previewUrl: string | null
): string | null {
  if (!session) {
    return null;
  }
  return (
    session.browserSessions?.find((entry) =>
      previewUrl ? entry.url === previewUrl : true
    )?.status ?? null
  );
}

async function isPreviewReachable(url: string | null): Promise<boolean> {
  if (!url) {
    return false;
  }
  if (url.trim().toLowerCase().startsWith("file://")) {
    return true;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5_000);
    try {
      const response = await fetch(url, { signal: controller.signal });
      return response.ok;
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return false;
  }
}

async function waitForWorkflowCompletion(
  store: InterfaceSessionStore,
  sessionKey: string
) {
  const startedAt = Date.now();
  let lastSession = await store.getSession(sessionKey);
  while (Date.now() - startedAt < TIMEOUT_MS) {
    const session = await store.getSession(sessionKey);
    lastSession = session;
    const latestJob = session?.recentJobs[0] ?? null;
    if (
      latestJob &&
      session?.runningJobId === null &&
      session.queuedJobs.length === 0 &&
      latestJob.status !== "running"
    ) {
      await sleep(1_500);
      return (await store.getSession(sessionKey)) ?? session;
    }
    await sleep(1_000);
  }
  return lastSession;
}

function buildScenario(): MediaIngestExecutionIntentScenario {
  return {
    id: "calm_sample_voice_live_smoke",
    title: "Exact Calm Sample voice note",
    summary:
      "Voice note asks for a Calm Sample static HTML landing page on the Desktop with a calm hero sample, five sections, navigation, footer, and the browser left open.",
    mediaKind: "voice",
    fixtureFile: "fix_request.ogg",
    userText: "",
    expectedInterpretation: {
      summary:
        "Voice note asks for a Calm Sample static HTML landing page on the Desktop with a calm hero sample, five sections, navigation, footer, and the browser left open.",
      transcript: TRANSCRIPT,
      ocrText: null,
      confidence: 0.99,
      provenance: "exact user-provided Calm Sample voice note transcript",
      entityHints: ["Calm Sample", "static HTML", "landing page", "Desktop", "browser preview"]
    },
    expectedBehavior: [
      "direct_execute",
      "voice_transcript",
      "bounded_media_context",
      "desktop_workflow"
    ]
  };
}

function buildFailureArtifact(error: unknown): VoiceDesktopWorkflowSmokeArtifact {
  return {
    generatedAt: new Date().toISOString(),
    command: COMMAND,
    status: "BLOCKED",
    blockerReason: error instanceof Error ? error.message : String(error),
    transcript: TRANSCRIPT,
    backend: "",
    targetFolderPath: "",
    workspaceRoot: null,
    previewUrl: null,
    previewReachable: false,
    browserSessionStatus: null,
    packageJsonExists: false,
    reactEntryExists: false,
    cssEntryExists: false,
    latestAssistantReply: null,
    latestJob: null,
    recoveryAttempted: false,
    recoveryRecovered: false,
    outboundDeliveries: []
  };
}

export async function runTelegramVoiceDesktopWorkflowLiveSmoke(): Promise<VoiceDesktopWorkflowSmokeArtifact> {
  ensureEnvLoaded();
  if (!parseBoolean(process.env[CONFIRM_ENV])) {
    throw new Error(
      `Telegram voice desktop workflow live smoke is fail-closed. Set ${CONFIRM_ENV}=true to send live Telegram replies.`
    );
  }

  const localProbe = await probeLocalIntentModelFromEnv();
  const realBackend = resolveRequiredRealSmokeBackend(localProbe);
  if (realBackend.blockerReason) {
    throw new Error(realBackend.blockerReason);
  }

  const envSnapshot = applyEnvOverrides({
    ...buildSmokeModelEnvOverrides(localProbe).envOverrides,
    BRAIN_LIVE_RUN_RUNTIME_PATH: LIVE_RUN_RUNTIME_PATH,
    BRAIN_STATE_JSON_PATH: CORE_STATE_PATH,
    BRAIN_LEDGER_SQLITE_PATH: LEDGER_SQLITE_PATH,
    BRAIN_LEDGER_EXPORT_JSON_ON_WRITE: "false",
    BRAIN_ENABLE_EMBEDDINGS: "false",
    BRAIN_ENABLE_DYNAMIC_PULSE: "false"
  });
  const originalFetch = globalThis.fetch;

  try {
    const config = createInterfaceRuntimeConfigFromEnv();
    if (config.provider !== "telegram" && config.provider !== "both") {
      throw new Error(`Telegram is not enabled in this environment (provider=${config.provider}).`);
    }

    const telegram = config.provider === "both" ? config.telegram : config;
    const username = telegram.security.allowedUsernames[0];
    const userId =
      telegram.security.allowedUserIds[0] ??
      "telegram-voice-desktop-workflow-live-smoke-user";
    const chatId = telegram.allowedChatIds[0];
    if (!username) {
      throw new Error("BRAIN_INTERFACE_ALLOWED_USERNAMES must include at least one username.");
    }
    if (!chatId) {
      throw new Error("TELEGRAM_ALLOWED_CHAT_IDS must include at least one chat id.");
    }

    const scenario = buildScenario();
    const fixturePath = path.resolve(process.cwd(), "tests/fixtures/media/fix_request.ogg");
    const fixtureBuffer = await readFile(fixturePath);
    const fixtureCatalog = createMediaFixtureCatalog(
      { schemaVersion: 1, scenarios: [scenario] },
      new Map([[scenario.fixtureFile, fixtureBuffer]])
    );
    const mediaUnderstandingOrgan = new MediaUnderstandingOrgan(undefined, fixtureCatalog);
    const sessionStore = new InterfaceSessionStore(SESSION_STATE_PATH, { backend: "json" });
    const brain = buildDefaultBrain();
    const outboundDeliveries: TelegramOutboundDeliveryObservation[] = [];
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
              file_id: "fixture_calm_sample_voice_live_smoke",
              file_path: FIXTURE_DOWNLOAD_PATH,
              file_size: fixtureBuffer.length
            }
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.pathname.endsWith(`/${FIXTURE_DOWNLOAD_PATH}`)) {
        const bytes = Uint8Array.from(fixtureBuffer);
        const blob = new Blob([bytes], { type: "audio/ogg" });
        return new Response(blob, {
          status: 200,
          headers: {
            "Content-Type": "audio/ogg"
          }
        });
      }
      return originalFetch(input, init);
    };
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
        mediaUnderstandingOrgan,
        onOutboundDelivery: (event) => {
          outboundDeliveries.push(event);
        }
      }
    );
    const gatewayProcessor = gateway as unknown as {
      processUpdate(update: ReturnType<typeof buildTelegramUpdateForScenario>): Promise<void>;
    };
    const sessionKey = `telegram:${chatId}:${userId}`;
    await sessionStore.deleteSession(sessionKey);

    await gatewayProcessor.processUpdate(
      buildTelegramUpdateForScenario(scenario, fixtureBuffer.length, {
        chatId,
        userId,
        username,
        updateId: 990_001,
        dateSeconds: Math.floor(Date.now() / 1_000)
      })
    );

    const finalSession = await waitForWorkflowCompletion(sessionStore, sessionKey);
    const latestJob = finalSession?.recentJobs[0] ?? null;
    const latestAssistantReply =
      finalSession?.conversationTurns
        .filter((turn) => turn.role === "assistant")
        .slice(-1)[0]?.text ?? null;

    const desktopPath = await resolveDesktopPath();
    const targetFolderPath = path.join(desktopPath, "Calm Sample");
    const workspaceRoot = extractWorkspaceRoot(finalSession);
    const previewUrl = extractPreviewUrl(finalSession);
    const previewReachable = await isPreviewReachable(previewUrl);
    const browserSessionStatus = extractBrowserSessionStatus(finalSession, previewUrl);
    const packageJsonExists = await pathExists(path.join(targetFolderPath, "package.json"));
    const reactEntryExists =
      (await pathExists(path.join(targetFolderPath, "src", "App.jsx"))) ||
      (await pathExists(path.join(targetFolderPath, "src", "App.tsx"))) ||
      (await pathExists(path.join(targetFolderPath, "src", "App.js")));
    const cssEntryExists =
      (await pathExists(path.join(targetFolderPath, "src", "index.css"))) ||
      (await pathExists(path.join(targetFolderPath, "src", "App.css")));
    const blockedActionCount = null;
    const approvedActionCount = null;
    const blockerReason = latestJob?.errorMessage ?? null;
    const recoveryAttempted = Boolean(latestJob?.recoveryTrace);
    const recoveryRecovered = latestJob?.recoveryTrace?.status === "recovered";

    const status =
      latestJob?.status === "completed" &&
      (blockedActionCount ?? 0) === 0 &&
      (approvedActionCount ?? 0) > 0 &&
      (await isDirectory(targetFolderPath)) &&
      workspaceRoot === targetFolderPath &&
      packageJsonExists &&
      reactEntryExists &&
      cssEntryExists &&
      browserSessionStatus === "open" &&
      previewReachable
        ? "PASS"
        : latestJob
          ? "FAIL"
          : "BLOCKED";

    return {
      generatedAt: new Date().toISOString(),
      command: COMMAND,
      status,
      blockerReason,
      transcript: TRANSCRIPT,
      backend: realBackend.effectiveBackend,
      targetFolderPath,
      workspaceRoot,
      previewUrl,
      previewReachable,
      browserSessionStatus,
      packageJsonExists,
      reactEntryExists,
      cssEntryExists,
      latestAssistantReply,
      latestJob: latestJob
        ? {
            id: latestJob.id,
            status: latestJob.status,
            summary: latestJob.resultSummary ?? null,
            errorMessage: latestJob.errorMessage ?? null,
            recoveryKind: latestJob.recoveryTrace?.kind ?? null,
            recoveryStatus: latestJob.recoveryTrace?.status ?? null,
            recoveryClass: latestJob.recoveryTrace?.recoveryClass ?? null,
            recoverySummary: latestJob.recoveryTrace?.summary ?? null,
            approvedActionCount,
            blockedActionCount,
            startedAt: latestJob.startedAt ?? null,
            completedAt: latestJob.completedAt ?? null
          }
        : null,
      recoveryAttempted,
      recoveryRecovered,
      outboundDeliveries: outboundDeliveries.map((entry) => ({
        kind: entry.kind,
        text: entry.text,
        sequence: entry.sequence,
        jobId: entry.jobId ?? null
      }))
    };
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(envSnapshot);
    await rm(SESSION_STATE_PATH, { force: true }).catch(() => undefined);
    await rm(CORE_STATE_PATH, { force: true }).catch(() => undefined);
    await rm(`${CORE_STATE_PATH}.lock`, { force: true }).catch(() => undefined);
    await rm(LEDGER_SQLITE_PATH, { force: true }).catch(() => undefined);
    await rm(`${LEDGER_SQLITE_PATH}-shm`, { force: true }).catch(() => undefined);
    await rm(`${LEDGER_SQLITE_PATH}-wal`, { force: true }).catch(() => undefined);
    await rm(LIVE_RUN_RUNTIME_PATH, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  let artifact: VoiceDesktopWorkflowSmokeArtifact;
  try {
    artifact = await runTelegramVoiceDesktopWorkflowLiveSmoke();
  } catch (error) {
    artifact = buildFailureArtifact(error);
  }

  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`Telegram voice desktop workflow live smoke status: ${artifact.status}`);
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
