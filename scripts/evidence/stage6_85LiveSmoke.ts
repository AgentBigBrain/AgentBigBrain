/**
 * @fileoverview Runs deterministic Stage 6.85 Telegram-style live smoke prompts and records reply evidence.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildDefaultBrain } from "../../src/core/buildBrain";
import { createBrainConfigFromEnv } from "../../src/core/config";
import { ensureEnvLoaded } from "../../src/core/envLoader";
import { createInterfaceRuntimeConfigFromEnv } from "../../src/interfaces/runtimeConfig";
import { InterfaceSessionStore } from "../../src/interfaces/sessionStore";
import { TelegramAdapter } from "../../src/interfaces/telegramAdapter";
import { TelegramGateway } from "../../src/interfaces/telegramGateway";

interface Stage685LivePrompt {
  id: string;
  text: string;
}

interface Stage685LivePromptResult {
  id: string;
  prompt: string;
  attemptsUsed: number;
  timedOutWaitingForIdle: boolean;
  replyCount: number;
  ackReplyCount: number;
  ackAfterFinal: boolean;
  replies: readonly string[];
  finalReply: string | null;
  finalDeliveryOutcome: "not_attempted" | "sent" | "rate_limited" | "failed" | "unknown";
  ackLifecycleState: "NOT_SENT" | "SENT" | "REPLACED" | "FINAL_SENT_NO_EDIT" | "CANCELLED" | "unknown";
  qualityPass: boolean;
  qualityFailures: readonly string[];
}

interface Stage685LiveSmokeArtifact {
  generatedAt: string;
  status: "PASS" | "FAIL";
  backend: string;
  totalPrompts: number;
  promptResults: readonly Stage685LivePromptResult[];
  summary: {
    timedOutPrompts: number;
    noReplyPrompts: number;
    failedQualityPrompts: number;
    passCriteria: {
      noPromptTimeouts: boolean;
      allPromptsReceivedReplies: boolean;
      allPromptQualityChecksPass: boolean;
      overallPass: boolean;
    };
  };
}

interface Stage685PromptQualityExpectation {
  requiredAll?: readonly RegExp[];
  requiredAny?: readonly RegExp[];
  forbiddenAny?: readonly RegExp[];
}

const ARTIFACT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_85_live_smoke_report.json");
const WORKSPACE_ROOT = process.cwd();
const PROMPTS: readonly Stage685LivePrompt[] = [
  {
    id: "scenario_1_research",
    text: "BigBrain /chat Research deterministic sandboxing controls and provide distilled findings with proof refs."
  },
  {
    id: "scenario_2_build",
    text: "BigBrain /chat Build a minimal deterministic TypeScript CLI scaffold with README, runbook, and tests."
  },
  {
    id: "scenario_2b_playbook_candidate",
    text: "BigBrain /chat Build and test a deterministic TypeScript CLI scaffold, then propose a reusable playbook candidate if this workflow is repeatable."
  },
  {
    id: "scenario_3_approval",
    text: "BigBrain /chat Schedule 3 focus blocks next week and show exact approval diff before any write."
  },
  {
    id: "scenario_3b_diagnostics",
    text: "BigBrain /chat Show what will run, what ran, and why mission is blocked or waiting for approval."
  },
  {
    id: "scenario_3c_step_approval",
    text: "BigBrain /chat Show exact approval diff and wait for step-level approval."
  },
  {
    id: "scenario_4_workflow",
    text: "BigBrain /chat Capture this browser workflow, compile replay steps, and block if selector drift appears."
  },
  {
    id: "scenario_4b_workflow_replay",
    text: "BigBrain /chat Capture this flow, compile replay script, and block on selector mismatch."
  },
  {
    id: "scenario_5_clones",
    text: "BigBrain /chat Generate two clone-assisted plan variants and merge only safe packets."
  },
  {
    id: "scenario_5b_clone_block_reasons",
    text: "BigBrain /chat Show why non-mergeable clone packet kinds are blocked."
  },
  {
    id: "scenario_6_recovery_resume",
    text: "BigBrain /chat Continue the same mission safely after interruption and resume from the last durable checkpoint."
  },
  {
    id: "scenario_6b_recovery_retry_budget",
    text: "BigBrain /chat Retry this blocked step repeatedly and show when retry budget is exhausted and mission stop limit is reached."
  },
  {
    id: "scenario_7_verification_claim_gate",
    text: "BigBrain /chat Claim this task is complete only if deterministic proof artifacts exist; otherwise block the done claim."
  },
  {
    id: "scenario_7b_simulation_label",
    text: "BigBrain /chat If execution is simulated, label it explicitly as simulated and do not present it as completed."
  },
  {
    id: "scenario_8_latency",
    text: "BigBrain /chat Keep this mission interactive under latency budgets and tell me if any phase exceeded its budget."
  },
  {
    id: "scenario_8b_latency_cache",
    text: "BigBrain /chat Reuse safe deterministic cache paths but do not add extra model calls beyond baseline behavior."
  },
  {
    id: "scenario_9_observability_timeline",
    text: "BigBrain /chat Show the ordered mission timeline for the last run and explain the deterministic remediation for any failure."
  },
  {
    id: "scenario_9b_observability_bundle",
    text: "BigBrain /chat Export a redacted evidence bundle for this Stage 6.85 review."
  }
];
const BASE_UPDATE_ID = 1000;
const BASE_TELEGRAM_DATE_SECONDS = 1_700_000_000;
const STATUS_REPLY_PATTERN = /^Working on it\.\s+Use(?:\s+\w+)?\s+\/status\s+for\s+live\s+state\./i;
const PROMPT_MAX_ATTEMPTS = 2;
const TRANSIENT_FINAL_REPLY_PATTERNS: readonly RegExp[] = [
  /\brequest failed:\s*openai request timed out\b/i,
  /\bopenai request timed out\b/i
] as const;
const STAGE685_PROMPT_EXPECTATIONS: Readonly<Record<string, Stage685PromptQualityExpectation>> = {
  scenario_1_research: {
    requiredAll: [
      /\bsandbox(?:ing)?\b/i,
      /\b(proof|refs?|references?|sources?|citations?)\b/i
    ],
    requiredAny: [
      /\bno-op outcome:/i,
      /\bno side-effect action was executed\b/i,
      /\brun skill status:\b/i
    ],
    forbiddenAny: [
      /\bplease let me know how you would like to proceed\b/i
    ]
  },
  scenario_2_build: {
    requiredAll: [
      /\bno-op outcome:/i,
      /\breasonCode:\s*BUILD_NO_SIDE_EFFECT_EXECUTED\b/i,
      /\bnextStep:/i
    ],
    forbiddenAny: [
      /\bfollow these steps\b/i,
      /\bplease let me know if you need assistance with anything else\b/i,
      /\bplease let me know how you would like to proceed\b/i
    ]
  },
  scenario_2b_playbook_candidate: {
    requiredAny: [
      /\bno-op outcome:/i,
      /\brun skill status:/i
    ],
    forbiddenAny: [
      /\bfollow these steps\b/i,
      /\bplease let me know if you need assistance with anything else\b/i
    ]
  },
  scenario_3_approval: {
    requiredAll: [
      /\bno-op outcome:/i,
      /\breasonCode:\s*CALENDAR_PROPOSE_NOT_AVAILABLE\b/i,
      /\bnextStep:/i
    ]
  },
  scenario_3b_diagnostics: {
    requiredAll: [
      /\brun summary:/i,
      /what will run:/i,
      /what ran:/i
    ]
  },
  scenario_3c_step_approval: {
    requiredAll: [
      /\brun summary:/i,
      /approval diff:/i,
      /deterministic remediation:/i
    ]
  },
  scenario_4_workflow: {
    requiredAll: [
      /\bno-op outcome:/i,
      /\breasonCode:\s*WORKFLOW_REPLAY_NO_SIDE_EFFECT_EXECUTED\b/i,
      /\bnextStep:/i
    ],
    forbiddenAny: [
      /\bfollow these steps\b/i,
      /\bplease let me know if you need assistance with anything else\b/i,
      /\bi understand you want\b/i
    ]
  },
  scenario_4b_workflow_replay: {
    requiredAll: [
      /\bno-op outcome:/i,
      /\breasonCode:\s*WORKFLOW_REPLAY_NO_SIDE_EFFECT_EXECUTED\b/i,
      /\bnextStep:/i
    ],
    forbiddenAny: [
      /\bfollow these steps\b/i,
      /\bplease let me know how you would like to proceed\b/i
    ]
  },
  scenario_5_clones: {
    requiredAll: [
      /\bno-op outcome:/i,
      /\breasonCode:\s*CLONE_WORKFLOW_NO_SIDE_EFFECT_EXECUTED\b/i
    ]
  },
  scenario_5b_clone_block_reasons: {
    requiredAll: [
      /\bnon-mergeable clone packet kinds are blocked\b/i,
      /\bblocked kinds:/i,
      /\bnext step:/i
    ]
  },
  scenario_6_recovery_resume: {
    requiredAll: [
      /\bno-op outcome:/i,
      /\breasonCode:\s*RECOVERY_NO_SIDE_EFFECT_EXECUTED\b/i
    ]
  },
  scenario_6b_recovery_retry_budget: {
    requiredAll: [
      /\bno-op outcome:/i,
      /\breasonCode:\s*RECOVERY_NO_SIDE_EFFECT_EXECUTED\b/i
    ]
  },
  scenario_7_verification_claim_gate: {
    requiredAll: [
      /\bVERIFICATION_GATE_FAILED\b/i,
      /\brun summary:/i
    ]
  },
  scenario_7b_simulation_label: {
    requiredAny: [
      /\bsimulated\b/i,
      /\bwill explicitly label\b/i,
      /\bno-op outcome:/i
    ]
  },
  scenario_8_latency: {
    requiredAll: [
      /\bno-op outcome:/i,
      /\breasonCode:\s*LATENCY_NO_SIDE_EFFECT_EXECUTED\b/i
    ]
  },
  scenario_8b_latency_cache: {
    requiredAll: [
      /\bno-op outcome:/i,
      /\breasonCode:\s*LATENCY_NO_SIDE_EFFECT_EXECUTED\b/i,
      /\bnextStep:/i
    ]
  },
  scenario_9_observability_timeline: {
    requiredAll: [
      /\brun summary:/i,
      /\btimeline:/i,
      /\bdeterministic remediation:/i
    ]
  },
  scenario_9b_observability_bundle: {
    requiredAll: [
      /\bno-op outcome:/i,
      /\breasonCode:\s*OBSERVABILITY_NO_SIDE_EFFECT_EXECUTED\b/i,
      /\bnextStep:/i
    ],
    forbiddenAny: [
      /\bplease let me know how you would like to proceed\b/i,
      /\bi can assist with exporting\b/i
    ]
  }
};

type EnvSnapshot = Record<string, string | undefined>;

/**
 * Applies deterministic environment overrides and returns the previous values.
 *
 * **Why it exists:**
 * The live-smoke harness needs isolated runtime settings without leaking those overrides to the
 * caller process after completion.
 *
 * **What it talks to:**
 * - Uses `process.env` as the runtime configuration surface.
 *
 * @param overrides - Environment key/value pairs to apply for this harness run.
 * @returns Previous values used by `restoreEnv` after execution.
 */
function applyEnvOverrides(overrides: Readonly<Record<string, string>>): EnvSnapshot {
  const snapshot: EnvSnapshot = {};
  for (const [key, value] of Object.entries(overrides)) {
    snapshot[key] = process.env[key];
    process.env[key] = value;
  }
  return snapshot;
}

/**
 * Restores environment values captured before temporary overrides.
 *
 * **Why it exists:**
 * Guarantees this script leaves process-level configuration unchanged for subsequent commands.
 *
 * **What it talks to:**
 * - Uses `process.env` for deterministic restore/delete behavior.
 *
 * @param snapshot - Previous values captured by `applyEnvOverrides`.
 */
function restoreEnv(snapshot: EnvSnapshot): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

/**
 * Polls session state until queue and running-job fields both report idle.
 *
 * **Why it exists:**
 * The smoke harness must wait for asynchronous queue work to finish before evaluating a prompt's
 * final reply and quality expectations.
 *
 * **What it talks to:**
 * - Reads session snapshots from `TelegramGateway`'s `InterfaceSessionStore`.
 *
 * @param gateway - Gateway instance used to access live session state.
 * @param conversationId - Session key for the prompt under evaluation.
 * @returns `true` when session reaches idle state before timeout; otherwise `false`.
 */
async function waitForSessionIdle(
  gateway: TelegramGateway,
  conversationId: string
): Promise<boolean> {
  const maxAttempts = 240;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const session = await (gateway as never as { sessionStore: InterfaceSessionStore }).sessionStore.getSession(
      conversationId
    );
    if (!session) {
      return true;
    }
    if (!session.runningJobId && session.queuedJobs.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      return true;
    }
  }
  return false;
}

/**
 * Selects the last non-ack reply for one prompt interaction.
 *
 * **Why it exists:**
 * Quality checks should evaluate the final user-facing answer, not interim status acks.
 *
 * **What it talks to:**
 * - Uses `STATUS_REPLY_PATTERN` to filter ack/status replies.
 *
 * @param replies - Ordered replies captured for one prompt attempt.
 * @returns Final non-status reply, or `null` when only status replies were observed.
 */
function selectFinalPromptReply(replies: readonly string[]): string | null {
  const nonStatusReplies = replies.filter((reply) => !STATUS_REPLY_PATTERN.test(reply.trim()));
  if (nonStatusReplies.length === 0) {
    return null;
  }
  return nonStatusReplies[nonStatusReplies.length - 1] ?? null;
}

/**
 * Counts status/ack replies in one prompt reply stream.
 *
 * @param replies - Ordered replies captured for one prompt attempt.
 * @returns Number of ack/status replies.
 */
function countAckReplies(replies: readonly string[]): number {
  return replies.filter((reply) => STATUS_REPLY_PATTERN.test(reply.trim())).length;
}

/**
 * Detects whether an ack/status reply was emitted after the final non-status reply.
 *
 * **Why it exists:**
 * Stage 6.85 UX contracts require clean terminal delivery ordering with no trailing ack noise.
 *
 * @param replies - Ordered replies captured for one prompt attempt.
 * @returns `true` when a status ack appears after the last non-status reply.
 */
function detectAckAfterFinal(replies: readonly string[]): boolean {
  let lastNonStatusIndex = -1;
  for (let index = 0; index < replies.length; index += 1) {
    if (!STATUS_REPLY_PATTERN.test(replies[index].trim())) {
      lastNonStatusIndex = index;
    }
  }
  if (lastNonStatusIndex < 0) {
    return false;
  }
  for (let index = lastNonStatusIndex + 1; index < replies.length; index += 1) {
    if (STATUS_REPLY_PATTERN.test(replies[index].trim())) {
      return true;
    }
  }
  return false;
}

/**
 * Classifies final replies that represent transient runtime failures worth one retry.
 *
 * @param finalReply - Final reply selected for a prompt attempt.
 * @returns `true` when retry logic should treat this as transient.
 */
function isTransientFinalReplyFailure(finalReply: string | null): boolean {
  if (!finalReply || finalReply.trim().length === 0) {
    return false;
  }
  return TRANSIENT_FINAL_REPLY_PATTERNS.some((pattern) => pattern.test(finalReply));
}

/**
 * Evaluates one prompt's final reply and runtime metadata against Stage 6.85 quality rules.
 *
 * **Why it exists:**
 * Live-smoke readiness should fail closed when reply content, delivery state, or ack lifecycle
 * drift away from deterministic manual-review expectations.
 *
 * **What it talks to:**
 * - Reads per-scenario expectations from `STAGE685_PROMPT_EXPECTATIONS`.
 *
 * @param promptId - Scenario identifier for expectation lookup.
 * @param finalReply - Final non-ack reply text.
 * @param runtimeChecks - Delivery/ack runtime checks captured for this prompt.
 * @returns Pass/fail result with explicit quality failure codes.
 */
function evaluatePromptQuality(
  promptId: string,
  finalReply: string | null,
  runtimeChecks: {
    ackReplyCount: number;
    ackAfterFinal: boolean;
    finalDeliveryOutcome: Stage685LivePromptResult["finalDeliveryOutcome"];
    ackLifecycleState: Stage685LivePromptResult["ackLifecycleState"];
  }
): { pass: boolean; failures: readonly string[] } {
  const expectation = STAGE685_PROMPT_EXPECTATIONS[promptId];
  const failures: string[] = [];

  if (runtimeChecks.ackReplyCount > 1) {
    failures.push("multiple_ack_replies");
  }
  if (runtimeChecks.ackAfterFinal) {
    failures.push("ack_after_final_reply");
  }
  if (runtimeChecks.finalDeliveryOutcome === "not_attempted") {
    failures.push("final_delivery_limbo");
  }
  if (
    runtimeChecks.finalDeliveryOutcome === "sent" &&
    runtimeChecks.ackLifecycleState === "SENT"
  ) {
    failures.push("ack_state_not_terminal_after_send");
  }

  if (!expectation) {
    return {
      pass: failures.length === 0,
      failures
    };
  }
  if (!finalReply || finalReply.trim().length === 0) {
    failures.push("missing_final_reply");
    return { pass: false, failures };
  }

  const normalizedReply = finalReply.trim();
  if (/\bdeterministic mission diagnostics requested\b/i.test(normalizedReply)) {
    failures.push("robotic_diagnostics_banner");
  }
  if (/\bmission diagnostics:\b/i.test(normalizedReply)) {
    failures.push("legacy_diagnostics_label");
  }
  if (/no-op outcome:/i.test(normalizedReply)) {
    if (!/reasonCode:\s*[A-Z0-9_]+/.test(normalizedReply)) {
      failures.push("no_op_missing_reason_code");
    }
    if (!/nextStep:\s*\S/.test(normalizedReply)) {
      failures.push("no_op_missing_next_step");
    }
  }

  if (expectation.requiredAll) {
    for (const pattern of expectation.requiredAll) {
      if (!pattern.test(normalizedReply)) {
        failures.push(`required_all_miss:${pattern.source}`);
      }
    }
  }

  if (expectation.requiredAny && expectation.requiredAny.length > 0) {
    const hasAnyRequiredMatch = expectation.requiredAny.some((pattern) => pattern.test(normalizedReply));
    if (!hasAnyRequiredMatch) {
      failures.push("required_any_miss");
    }
  }

  if (expectation.forbiddenAny) {
    for (const pattern of expectation.forbiddenAny) {
      if (pattern.test(normalizedReply)) {
        failures.push(`forbidden_match:${pattern.source}`);
      }
    }
  }

  return {
    pass: failures.length === 0,
    failures
  };
}

/**
 * Runs the Stage 6.85 Telegram live smoke harness and writes the artifact report.
 *
 * **Why it exists:**
 * Produces scenario-first runtime evidence that validates production-path UX behavior under
 * deterministic quality gates.
 *
 * **What it talks to:**
 * - Builds runtime dependencies via `buildDefaultBrain` and `TelegramGateway`.
 * - Executes prompt sequence and writes `runtime/evidence/stage6_85_live_smoke_report.json`.
 */
async function main(): Promise<void> {
  ensureEnvLoaded();
  const runId = `run_${Date.now()}`;
  const isolatedRunRoot = path.resolve(WORKSPACE_ROOT, "runtime/sandbox/stage6_85_live_smoke", runId);
  await mkdir(path.resolve(isolatedRunRoot, "runtime"), { recursive: true });
  const existingProtectedPaths = (process.env.BRAIN_USER_PROTECTED_PATHS ?? "").trim();
  const protectedPaths = [existingProtectedPaths, WORKSPACE_ROOT, isolatedRunRoot]
    .filter((value) => value.length > 0)
    .join(",");
  const previousEnv = applyEnvOverrides({
    BRAIN_RUNTIME_MODE: "isolated",
    BRAIN_ALLOW_FULL_ACCESS: "false",
    BRAIN_ENABLE_REAL_SHELL: "false",
    BRAIN_ENABLE_REAL_NETWORK_WRITE: "false",
    BRAIN_PROFILE_MEMORY_ENABLED: "false",
    BRAIN_USER_PROTECTED_PATHS: protectedPaths,
    BRAIN_LEDGER_SQLITE_PATH: path.resolve(isolatedRunRoot, "runtime/ledgers.sqlite"),
    BRAIN_VECTOR_SQLITE_PATH: path.resolve(isolatedRunRoot, "runtime/vectors.sqlite"),
    BRAIN_TRACE_LOG_PATH: path.resolve(isolatedRunRoot, "runtime/runtime_trace.jsonl"),
    BRAIN_PROFILE_MEMORY_PATH: path.resolve(isolatedRunRoot, "runtime/profile_memory.secure.json")
  });
  const originalCwd = process.cwd();
  process.chdir(isolatedRunRoot);

  try {
    const backend = (process.env.BRAIN_MODEL_BACKEND ?? "").trim().toLowerCase();
    const config = createInterfaceRuntimeConfigFromEnv();
    const brainConfig = createBrainConfigFromEnv();

    const sessionStore = new InterfaceSessionStore(undefined, {
      backend: brainConfig.persistence.ledgerBackend,
      sqlitePath: brainConfig.persistence.ledgerSqlitePath,
      exportJsonOnWrite: brainConfig.persistence.exportJsonOnWrite
    });

    const brain = buildDefaultBrain();

    if (config.provider === "discord") {
      throw new Error("This smoke test only supports Telegram provider logic.");
    }

    const telegramConfig = config.provider === "both" ? config.telegram : config;

    const adapter = new TelegramAdapter(brain, {
      auth: {
        requiredToken: telegramConfig.security.sharedSecret
      },
      allowlist: {
        allowedUsernames: telegramConfig.security.allowedUsernames,
        allowedUserIds: telegramConfig.security.allowedUserIds,
        allowedChatIds: telegramConfig.allowedChatIds
      },
      rateLimit: {
        windowMs: telegramConfig.security.rateLimitWindowMs,
        maxEventsPerWindow: Math.max(telegramConfig.security.maxEventsPerWindow, 1000)
      },
      replay: {
        maxTrackedUpdateIds: telegramConfig.security.replayCacheSize
      }
    });

    const gateway = new TelegramGateway(adapter, telegramConfig, {
      sessionStore
    });

    const mockChatId = telegramConfig.allowedChatIds[0] ?? telegramConfig.security.allowedUserIds[0] ?? "chat-123";
    const mockUserId = telegramConfig.security.allowedUserIds[0] ?? mockChatId;
    const mockUsername =
      process.env.BRAIN_INTERFACE_ALLOWED_USERNAMES
        ?.split(",")
        .map((value) => value.trim())
        .find((value) => value.length > 0) ?? "testuser";
    const conversationId = `telegram:${mockChatId}:${mockUserId}`;

    const replyLog = new Map<string, string[]>();
    const originalFetch = global.fetch;
    let activePromptId: string | null = null;
    let nextMockMessageId = 1;

    global.fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
      const urlStr = String(input);
      if (urlStr.includes("sendMessage")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        const text = String(body.text ?? "");
        const messageId = nextMockMessageId;
        nextMockMessageId += 1;
        if (activePromptId) {
          const currentReplies = replyLog.get(activePromptId) ?? [];
          replyLog.set(activePromptId, [...currentReplies, text]);
        }
        console.log(`\n\n[REPLY TO TELEGRAM CHAT ${String(body.chat_id ?? "")}]`);
        console.log("--------------------------------------------------");
        console.log(text);
        console.log("--------------------------------------------------\n\n");
        return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 });
      }
      if (urlStr.includes("editMessageText")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        const text = String(body.text ?? "");
        if (activePromptId) {
          const currentReplies = replyLog.get(activePromptId) ?? [];
          replyLog.set(activePromptId, [...currentReplies, text]);
        }
        console.log(`\n\n[EDIT TELEGRAM MESSAGE ${String(body.message_id ?? "")}]`);
        console.log("--------------------------------------------------");
        console.log(text);
        console.log("--------------------------------------------------\n\n");
        return new Response(JSON.stringify({ ok: true, result: { message_id: body.message_id ?? 1 } }), {
          status: 200
        });
      }
      return originalFetch(input as Request | URL | string, init);
    };

    const promptResults: Stage685LivePromptResult[] = [];
    let updateId = BASE_UPDATE_ID;

    try {
      console.log("Starting Stage 6.85 Telegram live smoke harness...");
      for (const prompt of PROMPTS) {
        activePromptId = prompt.id;
        let attemptsUsed = 0;
        let idle = false;
        let replies: string[] = [];
        let finalReply: string | null = null;

        for (let attempt = 1; attempt <= PROMPT_MAX_ATTEMPTS; attempt += 1) {
          attemptsUsed = attempt;
          await sessionStore.deleteSession(conversationId);
          replyLog.set(prompt.id, []);
          console.log(`\n>>> INBOUND FROM TELEGRAM [${prompt.id}] (attempt ${attempt}/${PROMPT_MAX_ATTEMPTS}): ${prompt.text}`);

          await (gateway as unknown as { processUpdate: (update: unknown) => Promise<void> }).processUpdate({
            update_id: updateId,
            message: {
              text: prompt.text,
              chat: { id: mockChatId, type: "private" },
              from: { id: mockUserId, username: mockUsername },
              date: BASE_TELEGRAM_DATE_SECONDS + updateId
            }
          });
          updateId += 1;

          idle = await waitForSessionIdle(gateway, conversationId);
          replies = replyLog.get(prompt.id) ?? [];
          finalReply = selectFinalPromptReply(replies);
          const transientFailure = !idle || isTransientFinalReplyFailure(finalReply);
          if (!transientFailure || attempt >= PROMPT_MAX_ATTEMPTS) {
            break;
          }
          console.log(
            `Retrying prompt ${prompt.id} due transient delivery/runtime failure in attempt ${attempt}.`
          );
        }

        const ackReplyCount = countAckReplies(replies);
        const ackAfterFinal = detectAckAfterFinal(replies);
        const sessionSnapshot = await sessionStore.getSession(conversationId);
        const latestJob = sessionSnapshot?.recentJobs[0];
        const finalDeliveryOutcome = latestJob?.finalDeliveryOutcome ?? "unknown";
        const ackLifecycleState = latestJob?.ackLifecycleState ?? "unknown";
        const quality = evaluatePromptQuality(prompt.id, finalReply, {
          ackReplyCount,
          ackAfterFinal,
          finalDeliveryOutcome,
          ackLifecycleState
        });
        promptResults.push({
          id: prompt.id,
          prompt: prompt.text,
          attemptsUsed,
          timedOutWaitingForIdle: !idle,
          replyCount: replies.length,
          ackReplyCount,
          ackAfterFinal,
          replies,
          finalReply,
          finalDeliveryOutcome,
          ackLifecycleState,
          qualityPass: quality.pass,
          qualityFailures: quality.failures
        });
      }
    } finally {
      global.fetch = originalFetch;
    }

    const timedOutPrompts = promptResults.filter((result) => result.timedOutWaitingForIdle).length;
    const noReplyPrompts = promptResults.filter((result) => result.replyCount === 0).length;
    const failedQualityPrompts = promptResults.filter((result) => !result.qualityPass).length;
    const overallPass = timedOutPrompts === 0 && noReplyPrompts === 0 && failedQualityPrompts === 0;
    const artifact: Stage685LiveSmokeArtifact = {
      generatedAt: new Date().toISOString(),
      status: overallPass ? "PASS" : "FAIL",
      backend,
      totalPrompts: PROMPTS.length,
      promptResults,
      summary: {
        timedOutPrompts,
        noReplyPrompts,
        failedQualityPrompts,
        passCriteria: {
          noPromptTimeouts: timedOutPrompts === 0,
          allPromptsReceivedReplies: noReplyPrompts === 0,
          allPromptQualityChecksPass: failedQualityPrompts === 0,
          overallPass
        }
      }
    };

    await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
    await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    console.log(`Stage 6.85 Telegram live smoke status: ${artifact.status}`);
    console.log(`Artifact: ${ARTIFACT_PATH}`);
    if (!overallPass) {
      process.exit(1);
    }
  } finally {
    process.chdir(originalCwd);
    restoreEnv(previousEnv);
  }
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
