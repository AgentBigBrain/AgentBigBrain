/**
 * @fileoverview Provides a secure Telegram ingress adapter with auth, username allowlist, rate-limit, replay defense, and orchestrator routing.
 */

import { MAIN_AGENT_ID } from "../core/agentIdentity";
import { makeId } from "../core/ids";
import { BrainOrchestrator } from "../core/orchestrator";
import { TaskRequest, TaskRunResult } from "../core/types";
import {
  InterpretedConversationIntent,
  IntentInterpreterTurn
} from "../organs/intentInterpreter";
import { PulseLexicalRuleContext } from "../organs/pulseLexicalClassifier";
import {
  AgentPulseEvaluationRequest,
  AgentPulseEvaluationResult
} from "../core/profileMemoryStore";
import { AutonomousLoop, AutonomousLoopCallbacks } from "../core/agentLoop";
import { createModelClientFromEnv } from "../models/createModelClient";
import { createBrainConfigFromEnv } from "../core/config";
import {
  buildAutonomousGoalAbortedProgressMessage,
  buildAutonomousGoalMetProgressMessage,
  buildAutonomousIterationProgressMessage,
  buildAutonomousTerminalSummaryMessage
} from "./userFacing/stopSummarySurface";

export interface TelegramInboundMessage {
  updateId: number;
  chatId: string;
  userId: string;
  username: string;
  text: string;
  authToken: string;
  receivedAt?: string;
}

export interface TelegramAdapterConfig {
  auth: {
    requiredToken: string;
  };
  allowlist: {
    allowedUsernames: string[];
    allowedUserIds: string[];
    allowedChatIds: string[];
  };
  rateLimit: {
    windowMs: number;
    maxEventsPerWindow: number;
  };
  replay: {
    maxTrackedUpdateIds: number;
  };
}

export type TelegramAdapterRejectCode =
  | "UNAUTHORIZED"
  | "ALLOWLIST_DENIED"
  | "RATE_LIMITED"
  | "DUPLICATE_EVENT"
  | "EMPTY_MESSAGE";

export interface TelegramAdapterResult {
  accepted: boolean;
  code: "ACCEPTED" | TelegramAdapterRejectCode;
  message: string;
  runResult?: TaskRunResult;
}

export interface TelegramAdapterValidationResult {
  accepted: boolean;
  code: "ACCEPTED" | TelegramAdapterRejectCode;
  message: string;
}

/**
 * Normalizes username into a stable shape for `telegramAdapter` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for username so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeUsername(value: string): string {
  return value.trim().replace(/^@+/, "").toLowerCase();
}

/**
 * Builds task from text for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of task from text consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `MAIN_AGENT_ID` (import `MAIN_AGENT_ID`) from `../core/agentIdentity`.
 * - Uses `makeId` (import `makeId`) from `../core/ids`.
 * - Uses `TaskRequest` (import `TaskRequest`) from `../core/types`.
 *
 * @param text - Message/text content processed by this function.
 * @param receivedAt - Timestamp used for ordering, timeout, or recency decisions.
 * @returns Computed `TaskRequest` result.
 */
function buildTaskFromText(text: string, receivedAt: string): TaskRequest {
  return {
    id: makeId("task"),
    agentId: MAIN_AGENT_ID,
    goal: "Handle user request safely and efficiently.",
    userInput: text.trim(),
    createdAt: receivedAt
  };
}

export class TelegramAdapter {
  private readonly seenUpdateIds = new Set<number>();
  private readonly updateIdQueue: number[] = [];
  private readonly rateLimitBuckets = new Map<string, number[]>();

  /**
   * Initializes `TelegramAdapter` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Uses `BrainOrchestrator` (import `BrainOrchestrator`) from `../core/orchestrator`.
   *
   * @param brain - Value for brain.
   * @param config - Configuration or policy settings applied here.
   */
  constructor(
    private readonly brain: BrainOrchestrator,
    private readonly config: TelegramAdapterConfig
  ) { }

  /**
   * Executes message as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the message runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param message - Message/text content processed by this function.
   * @returns Promise resolving to TelegramAdapterResult.
   */
  async handleMessage(message: TelegramInboundMessage): Promise<TelegramAdapterResult> {
    const validation = this.validateMessage(message);
    if (!validation.accepted) {
      return validation;
    }

    const runResult = await this.runTextTask(
      message.text,
      message.receivedAt ?? new Date().toISOString()
    );
    return {
      accepted: true,
      code: "ACCEPTED",
      message: "Inbound message accepted and routed through orchestrator.",
      runResult
    };
  }

  /**
   * Applies deterministic validity checks for message.
   *
   * **Why it exists:**
   * Fails fast when message is invalid so later control flow stays safe and predictable.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param message - Message/text content processed by this function.
   * @returns Computed `TelegramAdapterValidationResult` result.
   */
  validateMessage(message: TelegramInboundMessage): TelegramAdapterValidationResult {
    if (!this.isAuthorized(message)) {
      return {
        accepted: false,
        code: "UNAUTHORIZED",
        message: "Inbound message rejected: authentication failed."
      };
    }

    if (!message.text || !message.text.trim()) {
      return {
        accepted: false,
        code: "EMPTY_MESSAGE",
        message: "Inbound message rejected: text payload is empty."
      };
    }

    if (!this.isAllowlisted(message)) {
      return {
        accepted: false,
        code: "ALLOWLIST_DENIED",
        message: "Inbound message rejected: user identity is not allowlisted."
      };
    }

    if (this.isDuplicate(message.updateId)) {
      return {
        accepted: false,
        code: "DUPLICATE_EVENT",
        message: "Inbound message rejected: duplicate update detected."
      };
    }

    if (!this.consumeRateLimit(message)) {
      return {
        accepted: false,
        code: "RATE_LIMITED",
        message: "Inbound message rejected: rate limit exceeded."
      };
    }

    this.trackUpdateId(message.updateId);
    return {
      accepted: true,
      code: "ACCEPTED",
      message: "Inbound message accepted."
    };
  }

  /**
   * Executes text task as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the text task runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses `TaskRunResult` (import `TaskRunResult`) from `../core/types`.
   *
   * @param text - Message/text content processed by this function.
   * @param receivedAt - Timestamp used for ordering, timeout, or recency decisions.
   * @returns Promise resolving to TaskRunResult.
   */
  async runTextTask(text: string, receivedAt: string): Promise<TaskRunResult> {
    const task = buildTaskFromText(text, receivedAt);
    return this.brain.runTask(task);
  }

  /**
   * Runs the full autonomous goal-resolution loop, delivering throttled progress
   * to the chat.  Messages are consolidated: only the first iteration, every Nth
   * iteration with real progress, and terminal events (goal met / abort) send a
   * Telegram message.  Returns a summary string.
   *
   * @param signal Optional AbortSignal for external cancellation.
   */
  async runAutonomousTask(
    goal: string,
    receivedAt: string,
    onProgress: (message: string) => Promise<void>,
    signal?: AbortSignal
  ): Promise<string> {
    const config = createBrainConfigFromEnv();
    const modelClient = createModelClientFromEnv();
    const loop = new AutonomousLoop(this.brain, modelClient, config);

    let totalIterations = 0;
    let totalApproved = 0;
    let totalBlocked = 0;
    let terminalAborted = false;
    let terminalReason = "";
    let lastProgressMessageAt = 0;
    const THROTTLE_MS = 30_000;

    /**
     * Decides whether the current autonomous-loop iteration should emit progress.
     *
     * **Why it exists:**
     * Telegram chats should get useful status updates without noisy spam. This helper keeps updates
     * deterministic: always send first-step and productive-step progress, otherwise throttle by time.
     *
     * **What it talks to:**
     * - Reads local throttling state (`lastProgressMessageAt`, `THROTTLE_MS`).
     *
     * @param iteration - Current autonomous iteration number.
     * @param approved - Number of approved actions for this iteration.
     * @returns `true` when a progress message should be sent.
     */
    const shouldSendProgress = (iteration: number, approved: number): boolean => {
      if (iteration === 1) return true;
      if (approved > 0) return true;
      const now = Date.now();
      if (now - lastProgressMessageAt >= THROTTLE_MS) return true;
      return false;
    };

    const callbacks: AutonomousLoopCallbacks = {
      onIterationStart: async (iteration, input) => {
        totalIterations = iteration;
        if (iteration === 1) {
          const preview = input.length > 150 ? input.slice(0, 150) + "..." : input;
          await onProgress(`Autonomous task started: ${preview}`);
          lastProgressMessageAt = Date.now();
        }
      },
      onIterationComplete: async (iteration, _summary, approved, blocked) => {
        totalIterations = iteration;
        totalApproved += approved;
        totalBlocked += blocked;
        if (shouldSendProgress(iteration, approved)) {
          await onProgress(
            buildAutonomousIterationProgressMessage(
              iteration,
              approved,
              blocked,
              totalApproved,
              totalBlocked
            )
          );
          lastProgressMessageAt = Date.now();
        }
      },
      onGoalMet: async (reasoning) => {
        await onProgress(
          buildAutonomousGoalMetProgressMessage(
            totalIterations,
            totalApproved,
            totalBlocked,
            reasoning
          )
        );
      },
      onGoalAborted: async (reason) => {
        terminalAborted = true;
        terminalReason = reason;
        await onProgress(
          buildAutonomousGoalAbortedProgressMessage(
            totalIterations,
            totalApproved,
            totalBlocked,
            reason
          )
        );
      }
    };

    try {
      await loop.run(goal, callbacks, signal);
    } catch (error) {
      if (!terminalAborted) {
        terminalAborted = true;
        const errorMessage = (error as Error).message || "Unknown runtime error.";
        terminalReason =
          `[reasonCode=AUTONOMOUS_LOOP_RUNTIME_ERROR] Autonomous loop runtime failure: ${errorMessage}`;
        await onProgress(
          buildAutonomousGoalAbortedProgressMessage(
            totalIterations,
            totalApproved,
            totalBlocked,
            terminalReason
          )
        );
      }
    }
    return buildAutonomousTerminalSummaryMessage(
      !terminalAborted,
      totalIterations,
      totalApproved,
      totalBlocked,
      terminalReason
    );
  }

  /**
   * Evaluates agent pulse and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps the agent pulse policy check explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses `AgentPulseEvaluationRequest` (import `AgentPulseEvaluationRequest`) from `../core/profileMemoryStore`.
   * - Uses `AgentPulseEvaluationResult` (import `AgentPulseEvaluationResult`) from `../core/profileMemoryStore`.
   *
   * @param request - Structured input object for this operation.
   * @returns Promise resolving to AgentPulseEvaluationResult.
   */
  async evaluateAgentPulse(
    request: AgentPulseEvaluationRequest
  ): Promise<AgentPulseEvaluationResult> {
    return this.brain.evaluateAgentPulse(request);
  }

  /**
   * Interprets conversation intent into a typed decision signal.
   *
   * **Why it exists:**
   * Provides one interpretation path for conversation intent so policy consumers receive stable typed signals.
   *
   * **What it talks to:**
   * - Uses `IntentInterpreterTurn` (import `IntentInterpreterTurn`) from `../organs/intentInterpreter`.
   * - Uses `InterpretedConversationIntent` (import `InterpretedConversationIntent`) from `../organs/intentInterpreter`.
   * - Uses `PulseLexicalRuleContext` (import `PulseLexicalRuleContext`) from `../organs/pulseLexicalClassifier`.
   *
   * @param text - Message/text content processed by this function.
   * @param recentTurns - Value for recent turns.
   * @param pulseRuleContext - Message/text content processed by this function.
   * @returns Promise resolving to InterpretedConversationIntent.
   */
  async interpretConversationIntent(
    text: string,
    recentTurns: IntentInterpreterTurn[],
    pulseRuleContext?: PulseLexicalRuleContext
  ): Promise<InterpretedConversationIntent> {
    return this.brain.interpretConversationIntent(text, recentTurns, pulseRuleContext);
  }

  /**
   * Evaluates authorized and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps the authorized policy check explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param message - Message/text content processed by this function.
   * @returns `true` when this check passes.
   */
  private isAuthorized(message: TelegramInboundMessage): boolean {
    return message.authToken === this.config.auth.requiredToken;
  }

  /**
   * Evaluates allowlisted and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps the allowlisted policy check explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param message - Message/text content processed by this function.
   * @returns `true` when this check passes.
   */
  private isAllowlisted(message: TelegramInboundMessage): boolean {
    const username = normalizeUsername(message.username);
    const allowedUsernames = new Set(this.config.allowlist.allowedUsernames.map(normalizeUsername));
    const allowedUserIds = new Set(this.config.allowlist.allowedUserIds);
    const allowedChatIds = new Set(this.config.allowlist.allowedChatIds);

    if (allowedUsernames.size === 0 || !allowedUsernames.has(username)) {
      return false;
    }

    if (allowedUserIds.size > 0 && !allowedUserIds.has(message.userId)) {
      return false;
    }

    if (allowedChatIds.size > 0 && !allowedChatIds.has(message.chatId)) {
      return false;
    }

    return true;
  }

  /**
   * Evaluates duplicate and returns a deterministic policy signal.
   *
   * **Why it exists:**
   * Keeps the duplicate policy check explicit and testable before side effects.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param updateId - Timestamp used for ordering, timeout, or recency decisions.
   * @returns `true` when this check passes.
   */
  private isDuplicate(updateId: number): boolean {
    return this.seenUpdateIds.has(updateId);
  }

  /**
   * Tracks update id for audit, retry, or telemetry decisions.
   *
   * **Why it exists:**
   * Centralizes lifecycle tracking for update id so audit and retry flows share one source of truth.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param updateId - Timestamp used for ordering, timeout, or recency decisions.
   */
  private trackUpdateId(updateId: number): void {
    this.seenUpdateIds.add(updateId);
    this.updateIdQueue.push(updateId);

    while (this.updateIdQueue.length > this.config.replay.maxTrackedUpdateIds) {
      const oldest = this.updateIdQueue.shift();
      if (typeof oldest === "number") {
        this.seenUpdateIds.delete(oldest);
      }
    }
  }

  /**
   * Consumes rate limit and applies deterministic state updates.
   *
   * **Why it exists:**
   * Keeps rate limit lifecycle mutation logic centralized to reduce drift in state transitions.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param message - Message/text content processed by this function.
   * @returns `true` when this check passes.
   */
  private consumeRateLimit(message: TelegramInboundMessage): boolean {
    const key = `${normalizeUsername(message.username)}:${message.chatId}`;
    const nowMs = Date.now();
    const windowStart = nowMs - this.config.rateLimit.windowMs;
    const bucket = this.rateLimitBuckets.get(key) ?? [];
    const activeEntries = bucket.filter((entry) => entry >= windowStart);
    if (activeEntries.length >= this.config.rateLimit.maxEventsPerWindow) {
      this.rateLimitBuckets.set(key, activeEntries);
      return false;
    }

    activeEntries.push(nowMs);
    this.rateLimitBuckets.set(key, activeEntries);
    return true;
  }
}
