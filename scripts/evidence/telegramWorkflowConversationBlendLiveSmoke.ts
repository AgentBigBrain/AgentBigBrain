/**
 * @fileoverview Runs a real Telegram live smoke that mixes normal conversation with a multi-step workflow in one session.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
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

interface Scenario {
  id: string;
  prompt: string;
  kind: "conversation" | "workflow";
  forbiddenAny?: readonly RegExp[];
  requiredAny?: readonly RegExp[];
}

interface ScenarioResult {
  id: string;
  kind: "conversation" | "workflow";
  prompt: string;
  reply: string | null;
  sessionReply: string | null;
  newAssistantTurns: number;
  newOutboundDeliveries: number;
  outboundDeliveryKinds: readonly TelegramOutboundDeliveryObservation["kind"][];
  runningJobId: string | null;
  queuedJobs: number;
  recentJobs: number;
  newRecentJobs: number;
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
  checks: {
    conversationBeforeWorkflowStayedConversational: boolean;
    firstWorkflowStepCompleted: boolean;
    midWorkflowConversationStayedConversational: boolean;
    workflowResumedAfterConversation: boolean;
    issueConversationStayedConversational: boolean;
    finalWorkflowStepCompleted: boolean;
  };
  results: readonly ScenarioResult[];
  failureMessage: string | null;
}

interface StepObservation {
  reply: string | null;
  sessionReply: string | null;
  newAssistantTurns: number;
  newOutboundDeliveries: number;
  outboundDeliveryKinds: readonly TelegramOutboundDeliveryObservation["kind"][];
  runningJobId: string | null;
  queuedJobs: number;
  recentJobs: number;
  newRecentJobs: number;
  observedWorkerActivity: boolean;
  latestRecentJobStatus: string | null;
  latestRecentJobSummary: string | null;
}

const COMMAND =
  "npx tsx scripts/evidence/telegramWorkflowConversationBlendLiveSmoke.ts";
const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/telegram_workflow_conversation_blend_live_smoke_report.json"
);
const CONFIRM_ENV = "BRAIN_TELEGRAM_HUMAN_LIVE_SMOKE_CONFIRM";
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
const SCENARIOS: readonly Scenario[] = [
  {
    id: "conversation_before_work",
    kind: "conversation",
    prompt:
      "Hey BigBrain.\n\nI've had a long day and I'm still settling down a bit. Before we start anything, can we just talk for a minute?\n\nPlease reply in two short paragraphs and do not start work yet.",
    forbiddenAny: [...PLACEHOLDER_PATTERNS, ...THIRD_PERSON_SELF_REFERENCE_PATTERNS],
    requiredAny: [/\n\n/]
  },
  {
    id: "workflow_plan",
    kind: "workflow",
    prompt:
      "Please plan a calm air-sample landing page in three concise steps. Do not build anything yet.",
    forbiddenAny: [/Request failed:/i, ...THIRD_PERSON_SELF_REFERENCE_PATTERNS]
  },
  {
    id: "conversation_mid_workflow",
    kind: "conversation",
    prompt:
      "Thanks. I'm still a little scattered tonight.\n\nBefore the next step, can we just chat for a minute so I can reset?\n\nPlease reply in two short paragraphs and do not continue the landing-page workflow in this reply.",
    forbiddenAny: [...PLACEHOLDER_PATTERNS, ...THIRD_PERSON_SELF_REFERENCE_PATTERNS],
    requiredAny: [/\n\n/]
  },
  {
    id: "workflow_outline",
    kind: "workflow",
    prompt:
      "That plan works. Please do the next workflow step now: turn it into a short section-by-section outline for the same landing page. Keep this in planning mode only and do not build anything yet.",
    forbiddenAny: [/Request failed:/i, ...THIRD_PERSON_SELF_REFERENCE_PATTERNS]
  },
  {
    id: "issue_conversation",
    kind: "conversation",
    prompt:
      "One more thing before the last step.\n\nI'm second-guessing myself and feeling a bit stuck tonight. Can we just talk through how to keep the tone calm without doing new work yet?\n\nPlease reply in two short paragraphs and keep this as conversation, not workflow output.",
    forbiddenAny: [...PLACEHOLDER_PATTERNS, ...THIRD_PERSON_SELF_REFERENCE_PATTERNS],
    requiredAny: [/\n\n/]
  },
  {
    id: "workflow_copy",
    kind: "workflow",
    prompt:
      "That helps. Please do the next step now and draft the actual hero copy for the same landing page: one headline, one short supporting paragraph, and one call-to-action button.",
    forbiddenAny: [/Request failed:/i, ...THIRD_PERSON_SELF_REFERENCE_PATTERNS]
  }
] as const;

function parseBoolean(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

async function waitForScenarioOutcome(
  store: InterfaceSessionStore,
  sessionKey: string,
  scenarioKind: Scenario["kind"],
  previousAssistantTurnCount: number,
  previousRecentJobCount: number,
  outboundDeliveries: readonly TelegramOutboundDeliveryObservation[],
  previousOutboundDeliveryCount: number
): Promise<StepObservation> {
  const readObservation = async (): Promise<StepObservation> => {
    const session = await store.getSession(sessionKey);
    const assistantTurns =
      session?.conversationTurns.filter((turn) => turn.role === "assistant") ?? [];
    const latestRecentJob = session?.recentJobs[0] ?? null;
    const newAssistantTurns = Math.max(
      0,
      assistantTurns.length - previousAssistantTurnCount
    );
    const newRecentJobs = Math.max(
      0,
      (session?.recentJobs.length ?? 0) - previousRecentJobCount
    );
    const currentOutboundDeliveries = outboundDeliveries.slice(previousOutboundDeliveryCount);
    const newOutboundDeliveries = currentOutboundDeliveries.length;
    const observedWorkerActivity =
      Boolean(session?.runningJobId) ||
      (session?.queuedJobs.length ?? 0) > 0 ||
      newRecentJobs > 0;
    const sessionReply = newAssistantTurns > 0
      ? assistantTurns.slice(-1)[0]?.text ?? null
      : null;
    const latestRecentJobSummary = latestRecentJob?.resultSummary ?? null;
    const reply = scenarioKind === "conversation"
      ? selectConversationReply(currentOutboundDeliveries, latestRecentJobSummary, sessionReply)
      : selectWorkflowReply(currentOutboundDeliveries, latestRecentJobSummary, sessionReply);

    return {
      reply,
      sessionReply,
      newAssistantTurns,
      newOutboundDeliveries,
      outboundDeliveryKinds: currentOutboundDeliveries.map((delivery) => delivery.kind),
      runningJobId: session?.runningJobId ?? null,
      queuedJobs: session?.queuedJobs.length ?? 0,
      recentJobs: session?.recentJobs.length ?? 0,
      newRecentJobs,
      observedWorkerActivity,
      latestRecentJobStatus: latestRecentJob?.status ?? null,
      latestRecentJobSummary
    };
  };

  const settleWorkflowObservation = async (): Promise<StepObservation> => {
    let previous = await readObservation();
    for (let index = 0; index < 8; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      const current = await readObservation();
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
  };

  const maxPolls = scenarioKind === "workflow" ? 240 : 120;
  for (let index = 0; index < maxPolls; index += 1) {
    const observed = await readObservation();

    if (scenarioKind === "conversation") {
      if (observed.newOutboundDeliveries > 0 && !observed.observedWorkerActivity) {
        return observed;
      }
    } else if (
      observed.newRecentJobs > 0 &&
      observed.latestRecentJobStatus === "completed" &&
      textsProbablyMatch(observed.reply, observed.latestRecentJobSummary)
    ) {
      return settleWorkflowObservation();
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return readObservation();
}

function buildChecks(results: readonly ScenarioResult[]): SmokeArtifact["checks"] {
  const byId = new Map(results.map((result) => [result.id, result]));
  return {
    conversationBeforeWorkflowStayedConversational:
      byId.get("conversation_before_work")?.pass ?? false,
    firstWorkflowStepCompleted:
      byId.get("workflow_plan")?.pass ?? false,
    midWorkflowConversationStayedConversational:
      byId.get("conversation_mid_workflow")?.pass ?? false,
    workflowResumedAfterConversation:
      byId.get("workflow_outline")?.pass ?? false,
    issueConversationStayedConversational:
      byId.get("issue_conversation")?.pass ?? false,
    finalWorkflowStepCompleted:
      byId.get("workflow_copy")?.pass ?? false
  };
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

function isRepeatedWorkflowSummary(
  reply: string | null,
  latestWorkflowSummary: string | null
): boolean {
  return textsProbablyMatch(reply, latestWorkflowSummary);
}

export async function runTelegramWorkflowConversationBlendLiveSmoke(): Promise<SmokeArtifact> {
  ensureEnvLoaded();
  if (!parseBoolean(process.env[CONFIRM_ENV])) {
    throw new Error(
      `Telegram workflow-conversation blend live smoke is fail-closed. Set ${CONFIRM_ENV}=true to send live Telegram replies.`
    );
  }

  const config = createInterfaceRuntimeConfigFromEnv();
  if (config.provider !== "telegram" && config.provider !== "both") {
    throw new Error(`Telegram is not enabled in this environment (provider=${config.provider}).`);
  }
  const telegram = config.provider === "both" ? config.telegram : config;
  const username = telegram.security.allowedUsernames[0];
  const userId =
    telegram.security.allowedUserIds[0] ?? "telegram-workflow-blend-live-smoke-user";
  const chatId = telegram.allowedChatIds[0];
  if (!username) {
    throw new Error("BRAIN_INTERFACE_ALLOWED_USERNAMES must include at least one username.");
  }
  if (!chatId) {
    throw new Error("TELEGRAM_ALLOWED_CHAT_IDS must include at least one chat id.");
  }

  const tempStatePath = path.resolve(
    process.cwd(),
    `runtime/tmp-telegram-workflow-blend-live-smoke-${Date.now()}.json`
  );
  const sessionStore = new InterfaceSessionStore(tempStatePath, { backend: "json" });
  const brain = buildDefaultBrain();
  const outboundDeliveries: TelegramOutboundDeliveryObservation[] = [];
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
  const results: ScenarioResult[] = [];

  try {
    await sessionStore.deleteSession(sessionKey);
    for (let index = 0; index < SCENARIOS.length; index += 1) {
      const scenario = SCENARIOS[index];
      const existingSession = await sessionStore.getSession(sessionKey);
      const previousAssistantTurnCount =
        existingSession?.conversationTurns.filter((turn) => turn.role === "assistant")
          .length ?? 0;
      const previousRecentJobCount = existingSession?.recentJobs.length ?? 0;
      const previousOutboundDeliveryCount = outboundDeliveries.length;

      await gatewayProcessor.processUpdate({
        update_id: 97_000 + index,
        message: {
          text: scenario.prompt,
          chat: { id: chatId, type: "private" },
          from: { id: userId, username },
          date: Math.floor(Date.now() / 1000)
        }
      });

      const observed = await waitForScenarioOutcome(
        sessionStore,
        sessionKey,
        scenario.kind,
        previousAssistantTurnCount,
        previousRecentJobCount,
        outboundDeliveries,
        previousOutboundDeliveryCount
      );

      const failures: string[] = [];
      if (scenario.kind === "conversation") {
        if (!observed.reply) {
          failures.push("missing_conversation_reply");
        }
        if (observed.observedWorkerActivity) {
          failures.push("unexpected_worker_activity");
        }
        if (observed.newRecentJobs > 0) {
          failures.push(`unexpected_new_recent_jobs:${observed.newRecentJobs}`);
        }
        if (isRepeatedWorkflowSummary(observed.reply, observed.latestRecentJobSummary)) {
          failures.push("conversation_reply_repeated_latest_workflow_summary");
        }
      } else {
        if (!observed.observedWorkerActivity) {
          failures.push("missing_worker_activity");
        }
        if (observed.newRecentJobs === 0) {
          failures.push("missing_new_recent_job");
        }
        if (observed.latestRecentJobStatus !== "completed") {
          failures.push(
            `workflow_step_not_completed:${observed.latestRecentJobStatus ?? "unknown"}`
          );
        }
        if (!observed.reply && !observed.latestRecentJobSummary) {
          failures.push("missing_workflow_result");
        }
      }

      if ((scenario.requiredAny?.length ?? 0) > 0) {
        const hasAny = scenario.requiredAny!.some((pattern) =>
          pattern.test(observed.reply ?? observed.latestRecentJobSummary ?? "")
        );
        if (!hasAny) {
          failures.push("missing_required_reply_shape");
        }
      }
      for (const pattern of scenario.forbiddenAny ?? []) {
        if (pattern.test(observed.reply ?? observed.latestRecentJobSummary ?? "")) {
          failures.push(`forbidden_reply_shape:${pattern.source}`);
        }
      }

      results.push({
        id: scenario.id,
        kind: scenario.kind,
        prompt: scenario.prompt,
        reply: observed.reply,
        sessionReply: observed.sessionReply,
        newAssistantTurns: observed.newAssistantTurns,
        newOutboundDeliveries: observed.newOutboundDeliveries,
        outboundDeliveryKinds: observed.outboundDeliveryKinds,
        runningJobId: observed.runningJobId,
        queuedJobs: observed.queuedJobs,
        recentJobs: observed.recentJobs,
        newRecentJobs: observed.newRecentJobs,
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

  const checks = buildChecks(results);
  const status =
    results.every((result) => result.pass) &&
    Object.values(checks).every(Boolean)
      ? "PASS"
      : "FAIL";
  return {
    generatedAt: new Date().toISOString(),
    command: COMMAND,
    status,
    provider: "telegram",
    checks,
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
    checks: {
      conversationBeforeWorkflowStayedConversational: false,
      firstWorkflowStepCompleted: false,
      midWorkflowConversationStayedConversational: false,
      workflowResumedAfterConversation: false,
      issueConversationStayedConversational: false,
      finalWorkflowStepCompleted: false
    },
    results: [],
    failureMessage: error instanceof Error ? error.message : String(error)
  };
}

async function main(): Promise<void> {
  let artifact: SmokeArtifact;
  try {
    artifact = await runTelegramWorkflowConversationBlendLiveSmoke();
  } catch (error) {
    artifact = buildFailureArtifact(error);
  }

  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  console.log(`Telegram workflow-conversation blend live smoke status: ${artifact.status}`);
  console.log(`Artifact: ${ARTIFACT_PATH}`);
  if (artifact.failureMessage) {
    console.error(`Failure: ${artifact.failureMessage}`);
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
