/**
 * @fileoverview Runs an interface-style OpenAI live smoke that exercises /auto,
 * generates a small landing page on the operator Desktop, and records evidence.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildDefaultBrain } from "../../src/core/buildBrain";
import { createBrainConfigFromEnv } from "../../src/core/config";
import { ensureEnvLoaded } from "../../src/core/envLoader";
import { StateStore } from "../../src/core/stateStore";
import type { TaskRunResult } from "../../src/core/types";
import {
  countApprovedArtifactMutationActions,
  countApprovedBrowserProofActions,
  countApprovedManagedProcessStopActions,
  countApprovedReadinessProofActions,
  countApprovedRealSideEffectActions
} from "../../src/core/autonomy/missionEvidence";
import { ConversationManager } from "../../src/interfaces/conversationManager";
import { buildConversationKey } from "../../src/interfaces/conversationManagerHelpers";
import type {
  ConversationNotifierTransport
} from "../../src/interfaces/conversationRuntime/managerContracts";
import { parseAutonomousExecutionInput } from "../../src/interfaces/conversationRuntime/managerContracts";
import { InterfaceSessionStore } from "../../src/interfaces/sessionStore";
import { TelegramAdapter, type TelegramAdapterConfig } from "../../src/interfaces/telegramAdapter";
import { createInterfaceRuntimeConfigFromEnv } from "../../src/interfaces/runtimeConfig";
import { runAutonomousTransportTask } from "../../src/interfaces/transportRuntime/deliveryLifecycle";
import { selectUserFacingSummary } from "../../src/interfaces/userFacing/resultSurface";
import {
  parseOpenAICompatibilityStrict,
  parseOpenAITransportMode,
  resolveOpenAITransportSelection
} from "../../src/models/openai/modelProfiles";

interface EnvSnapshot {
  [key: string]: string | undefined;
}

interface ModelCase {
  model: string;
  slug: string;
}

interface LiveSmokeRoleRouting {
  smallFast: string;
  smallPolicy: string;
  mediumGeneral: string;
  mediumPolicy: string;
  largeReasoning: string;
}

interface TurnResult {
  reply: string;
  replies: readonly string[];
  finalReply: string | null;
  idle: boolean;
  terminal: boolean;
  finalDeliveryOutcome: string;
  jobStatus: string | null;
}

interface PageProof {
  localUrl: string | null;
  screenshotPath: string | null;
  observedTitle: string | null;
  headlineText: string | null;
  ctaCount: number;
  productNamePresent: boolean;
  headlinePresent: boolean;
  ctaPresent: boolean;
  modernStylePresent: boolean;
  screenshotCaptured: boolean;
  failure: string | null;
}

const TERMINAL_ITERATION_SUMMARY_PATTERN =
  /Autonomous task (?:completed|stopped) after (\d+) iteration\(s\)\.|Finished after (\d+) iteration\(s\)\.|Stopped after (\d+) iteration\(s\)\./i;

interface ModelSmokeArtifact {
  model: string;
  modelSlug: string;
  resolvedTransport: string;
  profileId: string;
  roleRouting: LiveSmokeRoleRouting;
  desktopOutputPath: string;
  transcript: {
    userTurn1: string;
    assistantTurn1: string | null;
    userTurn2: string;
    assistantTurn2Replies: readonly string[];
    finalAssistantSummary: string | null;
  };
  filesWritten: readonly string[];
  htmlEntryPath: string | null;
  iterationsUsed: number;
  withinIterationBudget: boolean;
  actionSummary: {
    runCount: number;
    realSideEffectCount: number;
    artifactMutationCount: number;
    approvedWriteFileCount: number;
    approvedStartProcessCount: number;
    approvedReadinessProofCount: number;
    approvedBrowserProofCount: number;
    approvedProcessStopCount: number;
  };
  readinessProof: Record<string, unknown> | null;
  browserProof: Record<string, unknown> | null;
  stopProof: Record<string, unknown> | null;
  firstTurnTruthful: boolean;
  firstTurnDidNotExecute: boolean;
  finalDeliveryOutcome: string;
  pageProof: PageProof;
  failures: readonly string[];
  pass: boolean;
}

interface LiveSmokeArtifact {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL";
  modelsAttempted: readonly string[];
  modelResults: readonly ModelSmokeArtifact[];
  summary: {
    attempted: number;
    passed: number;
    failedModels: readonly string[];
  };
  failureMessage: string | null;
}

const COMMAND = "npm run test:openai:multi_model_live_smoke";
const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/openai_multi_model_live_smoke_report.json"
);
const CONFIRM_ENV = "OPENAI_MULTI_MODEL_LIVE_SMOKE_CONFIRM";
const DEFAULT_MODEL_SEQUENCE = ["gpt-4.1-mini"] as const;
const FULL_MODEL_SEQUENCE = [
  "gpt-4.1-mini",
  "gpt-4.1",
  "gpt-5",
  "gpt-5.1",
  "gpt-5.2",
  "gpt-5.3-codex"
] as const;
const USERNAME = "agentowner";
const USER_ID = "openai-live-smoke-user";
const PRODUCT_NAME = "Northstar Studio";
const STATUS_REPLY_PATTERN = /^Working on it\.\s+Use(?:\s+\w+)?\s+\/status\s+for\s+live\s+state\./i;
const FALSE_COMPLETION_PATTERN =
  /\b(?:i\s+(?:created|built|finished|completed|verified|launched|started|served)|it's\s+ready|done\b|live\s+on\s+localhost)\b/i;
const MODERN_STYLE_PATTERN =
  /(--[a-z0-9-]+|gradient|box-shadow|transition|transform|backdrop-filter)/i;
const STABLE_CONTROL_MODELS = {
  smallFast: "gpt-4.1-mini",
  smallPolicy: "gpt-4.1-mini",
  mediumPolicy: "gpt-4.1-mini"
} as const;

type LiveSmokeRoleMode = "compatibility_matrix" | "all_roles_under_test";

function parseBoolean(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

function parseTerminalIterationCount(summary: string | null): number | null {
  if (!summary) {
    return null;
  }
  const match = summary.match(TERMINAL_ITERATION_SUMMARY_PATTERN);
  if (!match) {
    return null;
  }
  const rawValue = match[1] ?? match[2] ?? match[3] ?? "";
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

function parseLiveSmokeRoleMode(
  argv: readonly string[],
  envValue: string | undefined
): LiveSmokeRoleMode {
  const explicitArg = argv.find((entry) => entry.startsWith("--role-mode="));
  const rawValue = explicitArg ? explicitArg.slice("--role-mode=".length) : envValue;
  const normalized = (rawValue ?? "").trim().toLowerCase();
  if (!normalized || normalized === "compatibility_matrix" || normalized === "compatibility") {
    return "compatibility_matrix";
  }
  if (normalized === "all_roles_under_test" || normalized === "all_roles") {
    return "all_roles_under_test";
  }
  throw new Error(
    "Live smoke role mode must be 'compatibility_matrix' or 'all_roles_under_test'."
  );
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

function modelSlug(model: string): string {
  return model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function parseRequestedModels(argv: readonly string[]): readonly ModelCase[] {
  const explicitModels = argv.find((entry) => entry.startsWith("--models="));
  const requestedModels = explicitModels
    ? explicitModels
        .slice("--models=".length)
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : argv.includes("--all")
      ? [...FULL_MODEL_SEQUENCE]
      : [...DEFAULT_MODEL_SEQUENCE];
  return requestedModels.map((model) => ({ model, slug: modelSlug(model) }));
}

function buildRoleRoutingForModel(
  modelCase: ModelCase,
  roleMode: LiveSmokeRoleMode
): LiveSmokeRoleRouting {
  if (roleMode === "all_roles_under_test") {
    return {
      smallFast: modelCase.model,
      smallPolicy: modelCase.model,
      mediumGeneral: modelCase.model,
      mediumPolicy: modelCase.model,
      largeReasoning: modelCase.model
    };
  }

  return {
    smallFast: STABLE_CONTROL_MODELS.smallFast,
    smallPolicy: STABLE_CONTROL_MODELS.smallPolicy,
    mediumGeneral: modelCase.model,
    mediumPolicy: STABLE_CONTROL_MODELS.mediumPolicy,
    largeReasoning: modelCase.model
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function waitForIdle(
  store: InterfaceSessionStore,
  conversationId: string
): Promise<boolean> {
  for (let attempt = 0; attempt < 720; attempt += 1) {
    await sleep(250);
    const session = await store.getSession(conversationId);
    if (!session || (!session.runningJobId && session.queuedJobs.length === 0)) {
      return true;
    }
  }
  return false;
}

async function waitForTerminalDelivery(
  store: InterfaceSessionStore,
  conversationId: string
): Promise<boolean> {
  for (let attempt = 0; attempt < 720; attempt += 1) {
    await sleep(250);
    const latestJob = (await store.getSession(conversationId))?.recentJobs?.[0];
    if (latestJob && latestJob.finalDeliveryOutcome !== "not_attempted") {
      return true;
    }
  }
  return false;
}

async function waitForReplyQuiescence(replies: string[]): Promise<void> {
  let priorLength = -1;
  let stableCount = 0;
  for (let attempt = 0; attempt < 36; attempt += 1) {
    const currentLength = replies.length;
    if (currentLength === priorLength) {
      stableCount += 1;
      if (stableCount >= 3) {
        return;
      }
    } else {
      priorLength = currentLength;
      stableCount = 0;
    }
    await sleep(150);
  }
}

function appendCoalescedReply(existing: readonly string[], nextReply: string): string[] {
  const trimmedNext = nextReply.trim();
  if (trimmedNext.length === 0) {
    return [...existing];
  }
  if (existing.length === 0) {
    return [nextReply];
  }

  const updated = [...existing];
  const lastIndex = updated.length - 1;
  const previousRaw = updated[lastIndex] ?? "";
  const previous = previousRaw.trim();
  const previousIsAck = STATUS_REPLY_PATTERN.test(previous);
  const nextIsAck = STATUS_REPLY_PATTERN.test(trimmedNext);

  if (!previousIsAck && !nextIsAck) {
    if (previous === trimmedNext) {
      return updated;
    }
    if (trimmedNext.startsWith(previous)) {
      updated[lastIndex] = nextReply;
      return updated;
    }
    if (previous.startsWith(trimmedNext)) {
      return updated;
    }
  }

  updated.push(nextReply);
  return updated;
}

function selectTransportFinalReply(replies: readonly string[]): string | null {
  const nonAckReplies = replies.filter((reply) => !STATUS_REPLY_PATTERN.test(reply.trim()));
  return nonAckReplies.length > 0 ? (nonAckReplies[nonAckReplies.length - 1] ?? null) : null;
}

function selectPersistedFinalReply(
  latestJob: { status: string; resultSummary: string | null; errorMessage: string | null } | null,
  showCompletionPrefix: boolean
): string | null {
  if (!latestJob) {
    return null;
  }
  if (latestJob.status === "completed") {
    const summary = latestJob.resultSummary?.trim() ?? "";
    if (!summary) {
      return "Request completed.";
    }
    return showCompletionPrefix ? `Done.\n${summary}` : summary;
  }
  return `Request failed: ${latestJob.errorMessage ?? "Unknown error"}.`;
}

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolutePath);
        continue;
      }
      files.push(path.relative(rootDir, absolutePath));
    }
  }

  if (!(await pathExists(rootDir))) {
    return [];
  }
  await walk(rootDir);
  files.sort();
  return files;
}

async function findHtmlEntryPath(rootDir: string): Promise<string | null> {
  const files = await listFilesRecursive(rootDir);
  const preferred = files.find((relativePath) => relativePath === "index.html");
  if (preferred) {
    return path.join(rootDir, preferred);
  }
  const firstHtml = files.find((relativePath) => relativePath.toLowerCase().endsWith(".html"));
  return firstHtml ? path.join(rootDir, firstHtml) : null;
}

function buildContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".html":
    default:
      return "text/html; charset=utf-8";
  }
}

async function reserveLoopbackPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate loopback port.")));
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

async function startStaticSiteServer(rootDir: string, entryRelativePath: string): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const port = await reserveLoopbackPort();
  const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      const normalizedPath =
        requestPath === "/"
          ? entryRelativePath
          : decodeURIComponent(requestPath.replace(/^\/+/, ""));
      const candidatePath = path.resolve(rootDir, normalizedPath);
      const normalizedRoot = path.resolve(rootDir);
      if (!candidatePath.startsWith(normalizedRoot)) {
        response.writeHead(403);
        response.end("Forbidden");
        return;
      }
      let finalPath = candidatePath;
      let contents: Buffer;
      try {
        contents = await readFile(finalPath);
      } catch {
        finalPath = path.join(candidatePath, "index.html");
        contents = await readFile(finalPath);
      }
      response.writeHead(200, {
        "content-type": buildContentType(finalPath),
        "cache-control": "no-store"
      });
      response.end(contents);
    } catch {
      response.writeHead(404);
      response.end("Not found");
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  return {
    port,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  };
}

async function verifyGeneratedPageAndCaptureScreenshot(
  targetDir: string,
  htmlEntryPath: string | null,
  screenshotPath: string,
  expectVisibleBrowser: boolean
): Promise<PageProof> {
  if (!htmlEntryPath) {
    return {
      localUrl: null,
      screenshotPath: null,
      observedTitle: null,
      headlineText: null,
      ctaCount: 0,
      productNamePresent: false,
      headlinePresent: false,
      ctaPresent: false,
      modernStylePresent: false,
      screenshotCaptured: false,
      failure: "missing_html_entry"
    };
  }

  const entryRelativePath = path.relative(targetDir, htmlEntryPath).replace(/\\/g, "/");
  const inlineHtml = await readFile(htmlEntryPath, "utf8");
  const cssFiles = (await listFilesRecursive(targetDir)).filter((relativePath) =>
    relativePath.toLowerCase().endsWith(".css")
  );
  const cssContents = await Promise.all(
    cssFiles.map((relativePath) => readFile(path.join(targetDir, relativePath), "utf8"))
  );
  const combinedStyleText = `${inlineHtml}\n${cssContents.join("\n")}`;
  const modernStylePresent = MODERN_STYLE_PATTERN.test(combinedStyleText);

  let staticServer: { port: number; close(): Promise<void> } | null = null;
  let browserModule: typeof import("playwright") | null = null;
  try {
    browserModule = await import("playwright");
  } catch (error) {
    return {
      localUrl: null,
      screenshotPath: null,
      observedTitle: null,
      headlineText: null,
      ctaCount: 0,
      productNamePresent: inlineHtml.includes(PRODUCT_NAME),
      headlinePresent: /<h1[\s>]/i.test(inlineHtml),
      ctaPresent: /<(a|button)\b/i.test(inlineHtml),
      modernStylePresent,
      screenshotCaptured: false,
      failure: `playwright_import_failed:${(error as Error).message}`
    };
  }

  try {
    staticServer = await startStaticSiteServer(targetDir, entryRelativePath);
    const localUrl = `http://127.0.0.1:${staticServer.port}/${entryRelativePath === "index.html" ? "" : entryRelativePath}`;
    const browser = await browserModule.chromium.launch({
      headless: !expectVisibleBrowser
    });
    try {
      const page = await browser.newPage({
        viewport: { width: 1440, height: 960 }
      });
      await page.goto(localUrl, {
        waitUntil: "domcontentloaded",
        timeout: 15_000
      });
      await mkdir(path.dirname(screenshotPath), { recursive: true });
      await page.screenshot({
        path: screenshotPath,
        fullPage: true
      });

      const observedTitle = (await page.title()).trim() || null;
      const bodyText = (await page.textContent("body")) ?? "";
      const headingLocator = page.locator("h1, h2, [role='heading']").first();
      const headlineText = (await headingLocator.textContent().catch(() => null))?.trim() ?? null;
      const ctaCount = await page.locator("a, button").count();
      return {
        localUrl,
        screenshotPath,
        observedTitle,
        headlineText,
        ctaCount,
        productNamePresent: bodyText.includes(PRODUCT_NAME),
        headlinePresent: typeof headlineText === "string" && headlineText.length > 0,
        ctaPresent: ctaCount > 0,
        modernStylePresent,
        screenshotCaptured: true,
        failure: null
      };
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch (error) {
    return {
      localUrl: null,
      screenshotPath: null,
      observedTitle: null,
      headlineText: null,
      ctaCount: 0,
      productNamePresent: inlineHtml.includes(PRODUCT_NAME),
      headlinePresent: /<h1[\s>]/i.test(inlineHtml),
      ctaPresent: /<(a|button)\b/i.test(inlineHtml),
      modernStylePresent,
      screenshotCaptured: false,
      failure: `page_verification_failed:${(error as Error).message}`
    };
  } finally {
    await staticServer?.close().catch(() => undefined);
  }
}

function flattenActionResults(runs: readonly TaskRunResult[]): Array<TaskRunResult["actionResults"][number]> {
  return runs.flatMap((run) => run.actionResults);
}

function sumAcrossRuns(
  runs: readonly TaskRunResult[],
  selector: (run: TaskRunResult) => number
): number {
  return runs.reduce((total, run) => total + selector(run), 0);
}

function countApprovedActionsByType(
  runs: readonly TaskRunResult[],
  actionType: string
): number {
  return flattenActionResults(runs).filter(
    (result) => result.approved && result.action.type === actionType
  ).length;
}

function findLatestApprovedActionMetadata(
  runs: readonly TaskRunResult[],
  predicate: (result: TaskRunResult["actionResults"][number]) => boolean
): Record<string, unknown> | null {
  for (let runIndex = runs.length - 1; runIndex >= 0; runIndex -= 1) {
    const run = runs[runIndex];
    for (let resultIndex = run.actionResults.length - 1; resultIndex >= 0; resultIndex -= 1) {
      const result = run.actionResults[resultIndex];
      if (result.approved && predicate(result) && result.executionMetadata) {
        return { ...result.executionMetadata };
      }
    }
  }
  return null;
}

async function runModelCase(
  modelCase: ModelCase,
  desktopRootDir: string,
  roleMode: LiveSmokeRoleMode
): Promise<ModelSmokeArtifact> {
  const targetDir = path.join(desktopRootDir, modelCase.slug);
  const sandboxHelperDir = path.resolve(
    process.cwd(),
    "runtime/sandbox/openai-live-smoke",
    modelCase.slug
  );
  const screenshotPath = path.resolve(
    process.cwd(),
    "output/playwright",
    `openai-live-smoke-${modelCase.slug}.png`
  );
  const requestedLoopbackPort = await reserveLoopbackPort();
  const requestedLoopbackUrl = `http://127.0.0.1:${requestedLoopbackPort}`;
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(sandboxHelperDir, { recursive: true });
  const roleRouting = buildRoleRoutingForModel(modelCase, roleMode);

  const envSnapshot = applyEnvOverrides({
    BRAIN_MODEL_BACKEND: "openai",
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true",
    BRAIN_ENABLE_REAL_SHELL: "true",
    BRAIN_ENABLE_REAL_NETWORK_WRITE: "true",
    BRAIN_ENABLE_EMBEDDINGS: "true",
    BRAIN_LEDGER_BACKEND: "json",
    BRAIN_LEDGER_EXPORT_JSON_ON_WRITE: "true",
    BRAIN_ALLOW_AUTONOMOUS_VIA_INTERFACE: "true",
    BRAIN_INTERFACE_PROVIDER: "telegram",
    BRAIN_INTERFACE_SHARED_SECRET: "openai-multi-model-live-smoke-secret",
    BRAIN_INTERFACE_ALLOWED_USERNAMES: USERNAME,
    BRAIN_INTERFACE_ALLOWED_USER_IDS: USER_ID,
    BRAIN_INTERFACE_REQUIRE_NAME_CALL: "false",
    BRAIN_INTERFACE_ACK_DELAY_MS: "250",
    TELEGRAM_BOT_TOKEN: "local-telegram-live-smoke-token",
    TELEGRAM_ALLOWED_CHAT_IDS: `tg-live-smoke-${modelCase.slug}`,
    TELEGRAM_STREAMING_TRANSPORT_MODE: "edit",
    BRAIN_BROWSER_VERIFY_VISIBLE: process.env.BRAIN_BROWSER_VERIFY_VISIBLE ?? "false",
    BRAIN_BROWSER_VERIFY_HEADLESS: process.env.BRAIN_BROWSER_VERIFY_HEADLESS ?? "true",
    BRAIN_MAX_AUTONOMOUS_ITERATIONS: "5",
    OPENAI_TIMEOUT_MS: process.env.OPENAI_TIMEOUT_MS ?? "300000",
    OPENAI_TRANSPORT_MODE: process.env.OPENAI_TRANSPORT_MODE ?? "auto",
    OPENAI_COMPATIBILITY_STRICT: process.env.OPENAI_COMPATIBILITY_STRICT ?? "false",
    OPENAI_MODEL_SMALL_FAST: roleRouting.smallFast,
    OPENAI_MODEL_SMALL_POLICY: roleRouting.smallPolicy,
    OPENAI_MODEL_MEDIUM_GENERAL: roleRouting.mediumGeneral,
    OPENAI_MODEL_MEDIUM_POLICY: roleRouting.mediumPolicy,
    OPENAI_MODEL_LARGE_REASONING: roleRouting.largeReasoning
  });

  const stateStore = new StateStore();
  const stateBefore = await stateStore.load();
  const preRunCount = stateBefore.runs.length;
  const tempSessionDir = await mkdtemp(
    path.join(os.tmpdir(), "agentbigbrain-openai-multi-model-live-smoke-")
  );

  try {
    const interfaceConfig = createInterfaceRuntimeConfigFromEnv();
    if (interfaceConfig.provider !== "telegram") {
      throw new Error("OpenAI multi-model live smoke requires BRAIN_INTERFACE_PROVIDER=telegram.");
    }

    const brainConfig = createBrainConfigFromEnv();
    const transportSelection = resolveOpenAITransportSelection(
      modelCase.model,
      parseOpenAITransportMode(process.env.OPENAI_TRANSPORT_MODE),
      process.env.OPENAI_COMPATIBILITY_STRICT === undefined
        ? false
        : parseOpenAICompatibilityStrict(process.env.OPENAI_COMPATIBILITY_STRICT)
    );

    const sessionStore = new InterfaceSessionStore(
      path.join(tempSessionDir, "interface_sessions.json"),
      {
        backend: brainConfig.persistence.ledgerBackend,
        sqlitePath: brainConfig.persistence.ledgerSqlitePath,
        exportJsonOnWrite: brainConfig.persistence.exportJsonOnWrite
      }
    );
    const brain = buildDefaultBrain();
    const adapterConfig: TelegramAdapterConfig = {
      auth: {
        requiredToken: interfaceConfig.security.sharedSecret
      },
      allowlist: {
        allowedUsernames: interfaceConfig.security.allowedUsernames,
        allowedUserIds: interfaceConfig.security.allowedUserIds,
        allowedChatIds: interfaceConfig.allowedChatIds
      },
      rateLimit: {
        windowMs: interfaceConfig.security.rateLimitWindowMs,
        maxEventsPerWindow: interfaceConfig.security.maxEventsPerWindow
      },
      replay: {
        maxTrackedUpdateIds: interfaceConfig.security.replayCacheSize
      }
    };
    const adapter = new TelegramAdapter(brain, adapterConfig);
    const conversationManager = new ConversationManager(
      sessionStore,
      {
        ackDelayMs: interfaceConfig.security.ackDelayMs,
        showCompletionPrefix: interfaceConfig.security.showCompletionPrefix,
        followUpOverridePath: interfaceConfig.security.followUpOverridePath,
        pulseLexicalOverridePath: interfaceConfig.security.pulseLexicalOverridePath,
        allowAutonomousViaInterface: interfaceConfig.security.allowAutonomousViaInterface
      },
      {
        interpretConversationIntent: async (input, recentTurns, pulseRuleContext) =>
          adapter.interpretConversationIntent(input, recentTurns, pulseRuleContext)
      }
    );

    const chatId = `tg-live-smoke-${modelCase.slug}`;
    const sessionKey = buildConversationKey({
      provider: "telegram",
      conversationId: chatId,
      userId: USER_ID,
      username: USERNAME,
      conversationVisibility: "private",
      receivedAt: new Date().toISOString()
    });
    await sessionStore.deleteSession(sessionKey);

    const abortControllers = new Map<string, AbortController>();
    let nextMessageId = 1;

    async function sendTurn(text: string, expectJob: boolean): Promise<TurnResult> {
      const replies: string[] = [];
      const notifier: ConversationNotifierTransport = {
        capabilities: {
          supportsEdit: true,
          supportsNativeStreaming: false
        },
        send: async (message) => {
          const updated = appendCoalescedReply(replies, message);
          replies.splice(0, replies.length, ...updated);
          return {
            ok: true,
            messageId: `msg-${nextMessageId++}`,
            errorCode: null
          };
        },
        edit: async (_messageId, message) => {
          const updated = appendCoalescedReply(replies, message);
          replies.splice(0, replies.length, ...updated);
          return {
            ok: true,
            messageId: `msg-edit-${nextMessageId++}`,
            errorCode: null
          };
        }
      };

      const receivedAt = new Date().toISOString();
      const inbound = {
        provider: "telegram" as const,
        conversationId: chatId,
        userId: USER_ID,
        username: USERNAME,
        conversationVisibility: "private" as const,
        text,
        receivedAt
      };

      const executeTask = async (taskInput: string, taskReceivedAt: string) => {
        const autonomousGoal = parseAutonomousExecutionInput(taskInput);
        if (autonomousGoal) {
          return await runAutonomousTransportTask({
            conversationId: sessionKey,
            goal: autonomousGoal.goal,
            initialExecutionInput: autonomousGoal.initialExecutionInput,
            receivedAt: taskReceivedAt,
            notifier,
            abortControllers,
            runAutonomousTask: async (
              goal,
              runReceivedAt,
              progressSender,
              signal,
              initialExecutionInput
            ) =>
              adapter.runAutonomousTask(
                goal,
                runReceivedAt,
                progressSender,
                signal,
                initialExecutionInput
              )
          });
        }
        return {
          summary: selectUserFacingSummary(
            await adapter.runTextTask(taskInput, taskReceivedAt),
            {
              showTechnicalSummary: interfaceConfig.security.showTechnicalSummary,
              showSafetyCodes: interfaceConfig.security.showSafetyCodes
            }
          )
        };
      };

      const reply = await conversationManager.handleMessage(inbound, executeTask, notifier);
      if (reply.trim().length > 0) {
        await notifier.send(reply);
      }

      let idle = true;
      let terminal = true;
      const sessionAfterReply = await sessionStore.getSession(sessionKey);
      const sessionHasBackgroundWork = Boolean(
        sessionAfterReply?.runningJobId || (sessionAfterReply?.queuedJobs.length ?? 0) > 0
      );
      if (expectJob || sessionHasBackgroundWork) {
        idle = await waitForIdle(sessionStore, sessionKey);
        terminal = await waitForTerminalDelivery(sessionStore, sessionKey);
      }
      await waitForReplyQuiescence(replies);

      const latestJob = (await sessionStore.getSession(sessionKey))?.recentJobs?.[0] ?? null;
      return {
        reply,
        replies,
        finalReply:
          selectPersistedFinalReply(latestJob, interfaceConfig.security.showCompletionPrefix) ??
          selectTransportFinalReply(replies),
        idle,
        terminal,
        finalDeliveryOutcome: latestJob?.finalDeliveryOutcome ?? "not_attempted",
        jobStatus: latestJob?.status ?? null
      };
    }

    const firstTurnPrompt =
      `/chat guidance only: In 2-3 sentences, outline a plan for a tiny landing page for ${PRODUCT_NAME}. ` +
      "Keep it modern, fresh, and lightweight. Do not execute anything yet.";
    const secondTurnPrompt =
      `/auto Build it as a small static site in ${targetDir}. Use zsh. ` +
      `The HTML title and hero headline must include "${PRODUCT_NAME}". ` +
      `If you need helper scripts, local servers, or Playwright runners, create and execute them from ${sandboxHelperDir}. ` +
      "Keep every shell cwd inside that runtime/sandbox path while serving or inspecting the Desktop directory. " +
      `Use the exact loopback URL ${requestedLoopbackUrl} for the live proof flow. ` +
      `Bind the local server to port ${requestedLoopbackPort} and do not switch to another localhost port unless the executor explicitly reports that exact port is unavailable. ` +
      "For any long-running local server, use start_process directly instead of shell_command or a foreground shell script. " +
      "The supported start_process params are `command`, `cwd`/`workdir`, `requestedShellKind`, and optional `timeoutMs`; do not invent `profile` keys. " +
      `For the local server, prefer start_process with command \`python3 -m http.server ${requestedLoopbackPort} --bind 127.0.0.1 --directory ${targetDir}\`, cwd \`${sandboxHelperDir}\`, and requestedShellKind \`zsh\`. ` +
      "Do not wrap the server command in `zsh -lc` or `bash -lc`; use `requestedShellKind` instead. " +
      `Keep the server running long enough for probe_http url="${requestedLoopbackUrl}" and verify_browser url="${requestedLoopbackUrl}", then stop it with stop_process. ` +
      "No framework scaffold. Keep it simple enough to finish in five iterations. " +
      "Use a non-flat background treatment such as a gradient or layered panel background, and include at least one CSS custom property. " +
      "Include a modern hero, one CTA, and one supporting section. " +
      `Start it locally on ${requestedLoopbackUrl}, prove readiness there with probe_http, verify it there in Playwright, then stop the server. Execute now.`;

    const firstTurn = await sendTurn(firstTurnPrompt, true);
    const stateAfterFirstTurn = await stateStore.load();
    const firstTurnDidNotExecute = !(await pathExists(targetDir));
    const firstTurnTruthful =
      Boolean(firstTurn.finalReply && firstTurn.finalReply.trim().length > 0) &&
      !FALSE_COMPLETION_PATTERN.test(firstTurn.finalReply ?? "");

    const secondTurn = await sendTurn(secondTurnPrompt, true);
    const stateAfterSecondTurn = await stateStore.load();
    const autoRuns = stateAfterSecondTurn.runs.slice(stateAfterFirstTurn.runs.length);
    const htmlEntryPath = await findHtmlEntryPath(targetDir);
    const filesWritten = await listFilesRecursive(targetDir);
    const iterationsUsed =
      parseTerminalIterationCount(secondTurn.finalReply) ??
      parseTerminalIterationCount(secondTurn.replies[secondTurn.replies.length - 1] ?? null) ??
      autoRuns.length;
    const pageProof = await verifyGeneratedPageAndCaptureScreenshot(
      targetDir,
      htmlEntryPath,
      screenshotPath,
      !brainConfig.browserVerification.headless
    );

    const readinessProof = findLatestApprovedActionMetadata(
      autoRuns,
      (result) =>
        result.action.type === "probe_http" &&
        result.executionMetadata?.processLifecycleStatus === "PROCESS_READY"
    );
    const browserProof = findLatestApprovedActionMetadata(
      autoRuns,
      (result) =>
        result.action.type === "verify_browser" &&
        result.executionMetadata?.browserVerification === true &&
        result.executionMetadata?.browserVerifyPassed === true
    );
    const stopProof = findLatestApprovedActionMetadata(
      autoRuns,
      (result) => {
        const lifecycle = result.executionMetadata?.processLifecycleStatus;
        return (
          (result.action.type === "stop_process" || result.action.type === "check_process") &&
          lifecycle === "PROCESS_STOPPED"
        );
      }
    );

    const htmlText = htmlEntryPath ? await readFile(htmlEntryPath, "utf8") : "";
    const cssPresent = filesWritten.some((relativePath) => relativePath.toLowerCase().endsWith(".css"));
    const inlineStylePresent = /<style[\s>]/i.test(htmlText);
    const hasGeneratedDesktopArtifacts = filesWritten.length > 0;
    const failures: string[] = [];
    if (!firstTurnTruthful) {
      failures.push("first_turn_truthfulness_failed");
    }
    if (!firstTurnDidNotExecute) {
      failures.push("first_turn_triggered_execution");
    }
    if ((!secondTurn.idle || !secondTurn.terminal) && secondTurn.jobStatus !== "completed") {
      failures.push("timed_out_waiting_for_autonomous_completion");
    }
    if (secondTurn.jobStatus !== "completed") {
      failures.push(`autonomous_job_status:${secondTurn.jobStatus ?? "unknown"}`);
    }
    if (secondTurn.finalDeliveryOutcome !== "sent") {
      failures.push(`final_delivery_outcome:${secondTurn.finalDeliveryOutcome}`);
    }
    if (!(await pathExists(targetDir))) {
      failures.push("desktop_output_missing");
    }
    if (!htmlEntryPath) {
      failures.push("html_entry_missing");
    }
    if (!htmlText.includes(PRODUCT_NAME)) {
      failures.push("product_name_missing_from_html");
    }
    if (!cssPresent && !inlineStylePresent) {
      failures.push("stylesheet_missing");
    }
    if (iterationsUsed > 5) {
      failures.push(`iteration_budget_exceeded:${iterationsUsed}`);
    }
    const realSideEffectCount = sumAcrossRuns(autoRuns, countApprovedRealSideEffectActions);
    const artifactMutationCount = sumAcrossRuns(autoRuns, countApprovedArtifactMutationActions);
    const readinessProofCount = sumAcrossRuns(
      autoRuns,
      (run) => countApprovedReadinessProofActions(run, true)
    );
    const browserProofCount = sumAcrossRuns(autoRuns, countApprovedBrowserProofActions);
    const processStopCount = sumAcrossRuns(autoRuns, countApprovedManagedProcessStopActions);

    if (realSideEffectCount <= 0) {
      failures.push("no_real_side_effect_evidence");
    }
    if (artifactMutationCount <= 0 && !hasGeneratedDesktopArtifacts) {
      failures.push("no_artifact_mutation_evidence");
    }
    if (countApprovedActionsByType(autoRuns, "start_process") <= 0) {
      failures.push("no_start_process_evidence");
    }
    if (readinessProofCount <= 0) {
      failures.push("no_readiness_proof_evidence");
    }
    if (browserProofCount <= 0) {
      failures.push("no_browser_proof_evidence");
    }
    if (processStopCount <= 0) {
      failures.push("no_process_stop_evidence");
    }
    if (!pageProof.productNamePresent) {
      failures.push("page_proof_missing_product_name");
    }
    if (!pageProof.headlinePresent) {
      failures.push("page_proof_missing_headline");
    }
    if (!pageProof.ctaPresent) {
      failures.push("page_proof_missing_cta");
    }
    if (!pageProof.modernStylePresent) {
      failures.push("page_proof_missing_modern_style_signals");
    }
    if (!pageProof.screenshotCaptured) {
      failures.push(`page_screenshot_missing:${pageProof.failure ?? "unknown"}`);
    }

    return {
      model: modelCase.model,
      modelSlug: modelCase.slug,
      resolvedTransport: transportSelection.transport,
      profileId: transportSelection.profile.id,
      roleRouting,
      desktopOutputPath: targetDir,
      transcript: {
        userTurn1: firstTurnPrompt,
        assistantTurn1: firstTurn.finalReply,
        userTurn2: secondTurnPrompt,
        assistantTurn2Replies: secondTurn.replies,
        finalAssistantSummary: secondTurn.finalReply
      },
      filesWritten,
      htmlEntryPath,
      iterationsUsed,
      withinIterationBudget: iterationsUsed <= 5,
      actionSummary: {
        runCount: autoRuns.length,
        realSideEffectCount,
        artifactMutationCount,
        approvedWriteFileCount: countApprovedActionsByType(autoRuns, "write_file"),
        approvedStartProcessCount: countApprovedActionsByType(autoRuns, "start_process"),
        approvedReadinessProofCount: readinessProofCount,
        approvedBrowserProofCount: browserProofCount,
        approvedProcessStopCount: processStopCount
      },
      readinessProof,
      browserProof,
      stopProof,
      firstTurnTruthful,
      firstTurnDidNotExecute,
      finalDeliveryOutcome: secondTurn.finalDeliveryOutcome,
      pageProof,
      failures,
      pass: failures.length === 0
    };
  } finally {
    await rm(tempSessionDir, { recursive: true, force: true }).catch(() => undefined);
    restoreEnv(envSnapshot);
    const stateAfterCase = await stateStore.load().catch(() => ({ runs: [] as TaskRunResult[] }));
    if (stateAfterCase.runs.length < preRunCount) {
      throw new Error("State store shrank during live smoke, which should not happen.");
    }
  }
}

async function runLiveSmoke(): Promise<LiveSmokeArtifact> {
  ensureEnvLoaded();
  if (!parseBoolean(process.env[CONFIRM_ENV])) {
    throw new Error(`Live smoke is fail-closed. Set ${CONFIRM_ENV}=true to run.`);
  }
  if (
    typeof process.env.OPENAI_API_KEY !== "string" ||
    process.env.OPENAI_API_KEY.trim().length === 0
  ) {
    throw new Error("OPENAI_API_KEY is required for the OpenAI live smoke.");
  }

  try {
    await import("playwright");
  } catch (error) {
    throw new Error(`Playwright is unavailable for live smoke: ${(error as Error).message}`);
  }

  const desktopDir = path.join(os.homedir(), "Desktop");
  if (!(await pathExists(desktopDir))) {
    throw new Error(`Desktop path could not be resolved at ${desktopDir}.`);
  }
  const desktopSmokeRoot = path.join(desktopDir, "agentbigbrain-live-smoke");
  await mkdir(desktopSmokeRoot, { recursive: true });

  const argv = process.argv.slice(2);
  const modelCases = parseRequestedModels(argv);
  const roleMode = parseLiveSmokeRoleMode(argv, process.env.OPENAI_LIVE_SMOKE_ROLE_MODE);
  const results: ModelSmokeArtifact[] = [];
  for (const modelCase of modelCases) {
    results.push(await runModelCase(modelCase, desktopSmokeRoot, roleMode));
    const perModelArtifactPath = path.resolve(
      process.cwd(),
      "runtime/evidence",
      `openai_multi_model_live_smoke_${modelCase.slug}.json`
    );
    await mkdir(path.dirname(perModelArtifactPath), { recursive: true });
    await writeFile(
      perModelArtifactPath,
      `${JSON.stringify(results[results.length - 1], null, 2)}\n`,
      "utf8"
    );
  }

  const failedModels = results.filter((result) => !result.pass).map((result) => result.model);
  return {
    generatedAt: new Date().toISOString(),
    command: COMMAND,
    status: failedModels.length === 0 ? "PASS" : "FAIL",
    modelsAttempted: modelCases.map((item) => item.model),
    modelResults: results,
    summary: {
      attempted: results.length,
      passed: results.length - failedModels.length,
      failedModels
    },
    failureMessage: null
  };
}

function buildFailureArtifact(error: unknown, requestedModels: readonly string[]): LiveSmokeArtifact {
  return {
    generatedAt: new Date().toISOString(),
    command: COMMAND,
    status: "FAIL",
    modelsAttempted: requestedModels,
    modelResults: [],
    summary: {
      attempted: requestedModels.length,
      passed: 0,
      failedModels: requestedModels
    },
    failureMessage: error instanceof Error ? error.message : String(error)
  };
}

async function main(): Promise<void> {
  const requestedModels = parseRequestedModels(process.argv.slice(2)).map((item) => item.model);
  let artifact: LiveSmokeArtifact;
  try {
    artifact = await runLiveSmoke();
  } catch (error) {
    artifact = buildFailureArtifact(error, requestedModels);
  }

  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`OpenAI multi-model live smoke status: ${artifact.status}`);
  console.log(`Artifact: ${ARTIFACT_PATH}`);
  if (artifact.failureMessage) {
    console.error(`Failure: ${artifact.failureMessage}`);
  }
  if (artifact.status !== "PASS") {
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
