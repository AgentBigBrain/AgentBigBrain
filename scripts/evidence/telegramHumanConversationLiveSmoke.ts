/**
 * @fileoverview Runs a real Telegram human-conversation live smoke for casual chat and capability discovery.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildDefaultBrain } from "../../src/core/buildBrain";
import { ensureEnvLoaded } from "../../src/core/envLoader";
import { TelegramAdapter } from "../../src/interfaces/telegramAdapter";
import { TelegramGateway } from "../../src/interfaces/telegramGateway";
import { createInterfaceRuntimeConfigFromEnv } from "../../src/interfaces/runtimeConfig";
import { InterfaceSessionStore } from "../../src/interfaces/sessionStore";

interface Scenario {
  id: string;
  prompt: string;
  requiredAny?: readonly RegExp[];
  forbiddenAny?: readonly RegExp[];
  expectWorkerActivity?: boolean;
  requireReplyAfterWorker?: boolean;
}

interface ScenarioResult {
  id: string;
  prompt: string;
  reply: string | null;
  runningJobId: string | null;
  queuedJobs: number;
  recentJobs: number;
  observedWorkerActivity: boolean;
  latestRecentJobStatus: string | null;
  latestRecentJobSummary: string | null;
  pass: boolean;
  failures: readonly string[];
}

interface SmokeArtifact {
  generatedAt: string;
  command: string;
  status: "PASS" | "FAIL";
  provider: "telegram";
  results: readonly ScenarioResult[];
  failureMessage: string | null;
}

const COMMAND = "npx tsx scripts/evidence/telegramHumanConversationLiveSmoke.ts";
const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/telegram_human_conversation_live_smoke_report.json"
);
const CONFIRM_ENV = "BRAIN_TELEGRAM_HUMAN_LIVE_SMOKE_CONFIRM";
const POLL_INTERVAL_MS = 250;
const CONVERSATION_TIMEOUT_MS = 45_000;
const WORKFLOW_TIMEOUT_MS = 300_000;
const PLACEHOLDER_PATTERNS: readonly RegExp[] = [
  /I'?m starting on that now/i,
  /Working on your request now/i,
  /Request failed:/i
] as const;
const SCENARIOS: readonly Scenario[] = [
  {
    id: "greeting",
    prompt: "Hi",
    forbiddenAny: PLACEHOLDER_PATTERNS
  },
  {
    id: "conversation",
    prompt:
      "I've had a long day and I'm still deciding what I want to work on.\n\nCan we talk for a minute before you start anything?",
    forbiddenAny: PLACEHOLDER_PATTERNS
  },
  {
    id: "identity",
    prompt: "BigBrain what's your name",
    requiredAny: [/\bBigBrain\b/i],
    forbiddenAny: PLACEHOLDER_PATTERNS
  },
  {
    id: "capabilities",
    prompt: "What can you help me with?",
    requiredAny: [/\bhelp\b/i, /\bplan\b/i, /\bbuild\b/i, /\breview\b/i],
    forbiddenAny: PLACEHOLDER_PATTERNS
  },
  {
    id: "task_switch",
    prompt:
      "Please plan a calm air-sample landing page in three concise steps. Do not build anything yet.",
    expectWorkerActivity: true,
    requireReplyAfterWorker: true,
    requiredAny: [
      /(?:^|\s)(?:1\.|step\s*1\b)[\s\S]*\s(?:2\.|step\s*2\b)[\s\S]*\s(?:3\.|step\s*3\b)/i
    ],
    forbiddenAny: [
      /Request failed:/i,
      /governance blocked/i,
      /couldn'?t execute/i,
      /security governor/i,
      /MISSION_STOP_LIMIT/i,
      /objective_not_met/i
    ]
  }
] as const;

function parseBoolean(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

async function waitForAssistantTurn(
  store: InterfaceSessionStore,
  sessionKey: string,
  previousAssistantTurnCount: number,
  expectWorkerActivity: boolean,
  requireReplyAfterWorker: boolean
): Promise<{
  reply: string | null;
  runningJobId: string | null;
  queuedJobs: number;
  recentJobs: number;
  observedWorkerActivity: boolean;
  latestRecentJobStatus: string | null;
  latestRecentJobSummary: string | null;
}> {
  let sawWorkerActivity = false;
  const timeoutMs =
    expectWorkerActivity && requireReplyAfterWorker
      ? WORKFLOW_TIMEOUT_MS
      : CONVERSATION_TIMEOUT_MS;
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    const session = await store.getSession(sessionKey);
    const assistantTurns =
      session?.conversationTurns.filter((turn) => turn.role === "assistant") ?? [];
    const latestRecentJob = session?.recentJobs[0] ?? null;
    const observedWorkerActivity =
      Boolean(session?.runningJobId) ||
      (session?.queuedJobs.length ?? 0) > 0 ||
      (session?.recentJobs.length ?? 0) > 0;
    if (observedWorkerActivity) {
      sawWorkerActivity = true;
    }
    const hasNewAssistantTurn = assistantTurns.length > previousAssistantTurnCount;
    const reply = hasNewAssistantTurn
      ? assistantTurns.slice(-1)[0]?.text ?? null
      : null;
    if (latestRecentJob?.completedAt) {
      return {
        reply,
        runningJobId: session?.runningJobId ?? null,
        queuedJobs: session?.queuedJobs.length ?? 0,
        recentJobs: session?.recentJobs.length ?? 0,
        observedWorkerActivity: sawWorkerActivity || observedWorkerActivity,
        latestRecentJobStatus: latestRecentJob?.status ?? null,
        latestRecentJobSummary: latestRecentJob?.resultSummary ?? null
      };
    }
    if (hasNewAssistantTurn && (!expectWorkerActivity || !requireReplyAfterWorker)) {
      return {
        reply,
        runningJobId: session?.runningJobId ?? null,
        queuedJobs: session?.queuedJobs.length ?? 0,
        recentJobs: session?.recentJobs.length ?? 0,
        observedWorkerActivity: sawWorkerActivity || observedWorkerActivity,
        latestRecentJobStatus: latestRecentJob?.status ?? null,
        latestRecentJobSummary: latestRecentJob?.resultSummary ?? null
      };
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  const session = await store.getSession(sessionKey);
  return {
    reply:
      (session?.conversationTurns.filter((turn) => turn.role === "assistant").length ?? 0) >
      previousAssistantTurnCount
        ? session?.conversationTurns.filter((turn) => turn.role === "assistant").slice(-1)[0]
            ?.text ?? null
        : null,
    runningJobId: session?.runningJobId ?? null,
    queuedJobs: session?.queuedJobs.length ?? 0,
    recentJobs: session?.recentJobs.length ?? 0,
    observedWorkerActivity:
      sawWorkerActivity ||
      Boolean(session?.runningJobId) ||
      (session?.queuedJobs.length ?? 0) > 0 ||
      (session?.recentJobs.length ?? 0) > 0,
    latestRecentJobStatus: session?.recentJobs[0]?.status ?? null,
    latestRecentJobSummary: session?.recentJobs[0]?.resultSummary ?? null
  };
}

async function runSmoke(): Promise<SmokeArtifact> {
  ensureEnvLoaded();
  if (!parseBoolean(process.env[CONFIRM_ENV])) {
    throw new Error(
      `Telegram human-conversation live smoke is fail-closed. Set ${CONFIRM_ENV}=true to send live Telegram replies.`
    );
  }

  const config = createInterfaceRuntimeConfigFromEnv();
  if (config.provider !== "telegram" && config.provider !== "both") {
    throw new Error(`Telegram is not enabled in this environment (provider=${config.provider}).`);
  }
  const telegram = config.provider === "both" ? config.telegram : config;
  const username = telegram.security.allowedUsernames[0];
  const userId = telegram.security.allowedUserIds[0] ?? "telegram-human-live-smoke-user";
  const chatId = telegram.allowedChatIds[0];
  if (!username) {
    throw new Error("BRAIN_INTERFACE_ALLOWED_USERNAMES must include at least one username.");
  }
  if (!chatId) {
    throw new Error("TELEGRAM_ALLOWED_CHAT_IDS must include at least one chat id.");
  }

  const tempStatePath = path.resolve(
    process.cwd(),
    `runtime/tmp-telegram-human-live-smoke-${Date.now()}.json`
  );
  const sessionStore = new InterfaceSessionStore(tempStatePath, { backend: "json" });
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
    { sessionStore }
  );

  const sessionKey = `telegram:${chatId}:${userId}`;
  const results: ScenarioResult[] = [];

  try {
    await sessionStore.deleteSession(sessionKey);
    for (let index = 0; index < SCENARIOS.length; index += 1) {
      const scenario = SCENARIOS[index];
      const existingSession = await sessionStore.getSession(sessionKey);
      const previousAssistantTurnCount =
        existingSession?.conversationTurns.filter((turn) => turn.role === "assistant")
          .length ?? 0;
      await gateway.processUpdate({
        update_id: 96_000 + index,
        message: {
          text: scenario.prompt,
          chat: { id: chatId, type: "private" },
          from: { id: userId, username },
          date: Math.floor(Date.now() / 1000)
        }
      });

      const observed = await waitForAssistantTurn(
        sessionStore,
        sessionKey,
        previousAssistantTurnCount,
        scenario.expectWorkerActivity === true,
        scenario.requireReplyAfterWorker === true
      );
      const failures: string[] = [];
      if (
        !observed.reply &&
        !observed.latestRecentJobSummary &&
        !scenario.expectWorkerActivity
      ) {
        failures.push("missing_assistant_reply");
      }
      if (scenario.expectWorkerActivity) {
        if (!observed.observedWorkerActivity) {
          failures.push("missing_worker_activity");
        }
        if (
          scenario.requireReplyAfterWorker &&
          !observed.reply &&
          !observed.latestRecentJobSummary
        ) {
          failures.push("missing_worker_result");
        }
      } else if (observed.runningJobId) {
        failures.push(`unexpected_running_job:${observed.runningJobId}`);
      }
      if (!scenario.expectWorkerActivity && observed.queuedJobs > 0) {
        failures.push(`unexpected_queued_jobs:${observed.queuedJobs}`);
      }
      if (!scenario.expectWorkerActivity && observed.recentJobs > 0) {
        failures.push(`unexpected_recent_jobs:${observed.recentJobs}`);
      }
      const validationText = [observed.reply, observed.latestRecentJobSummary]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join("\n");
      if ((scenario.requiredAny?.length ?? 0) > 0) {
        const hasAny = scenario.requiredAny!.some((pattern) => pattern.test(validationText));
        if (!hasAny) {
          failures.push("missing_required_reply_shape");
        }
      }
      for (const pattern of scenario.forbiddenAny ?? []) {
        if (pattern.test(validationText)) {
          failures.push(`forbidden_reply_shape:${pattern.source}`);
        }
      }

      results.push({
        id: scenario.id,
        prompt: scenario.prompt,
        reply: observed.reply,
        runningJobId: observed.runningJobId,
        queuedJobs: observed.queuedJobs,
        recentJobs: observed.recentJobs,
        observedWorkerActivity: observed.observedWorkerActivity,
        latestRecentJobStatus: observed.latestRecentJobStatus,
        latestRecentJobSummary: observed.latestRecentJobSummary,
        pass: failures.length === 0,
        failures
      });
    }
  } finally {
    await rm(tempStatePath, { force: true });
  }

  const status = results.every((result) => result.pass) ? "PASS" : "FAIL";
  return {
    generatedAt: new Date().toISOString(),
    command: COMMAND,
    status,
    provider: "telegram",
    results,
    failureMessage: null
  };
}

function buildFailureArtifact(error: unknown): SmokeArtifact {
  return {
    generatedAt: new Date().toISOString(),
    command: COMMAND,
    status: "FAIL",
    provider: "telegram",
    results: [],
    failureMessage: error instanceof Error ? error.message : String(error)
  };
}

async function main(): Promise<void> {
  let artifact: SmokeArtifact;
  try {
    artifact = await runSmoke();
  } catch (error) {
    artifact = buildFailureArtifact(error);
  }

  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`Telegram human-conversation live smoke status: ${artifact.status}`);
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
