/**
 * @fileoverview Provides a secure Discord ingress adapter with auth, username allowlist, rate-limit, replay defense, and orchestrator routing.
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

export interface DiscordInboundMessage {
  messageId: string;
  channelId: string;
  userId: string;
  username: string;
  text: string;
  authToken: string;
  receivedAt?: string;
}

export interface DiscordAdapterConfig {
  auth: {
    requiredToken: string;
  };
  allowlist: {
    allowedUsernames: string[];
    allowedUserIds: string[];
    allowedChannelIds: string[];
  };
  rateLimit: {
    windowMs: number;
    maxEventsPerWindow: number;
  };
  replay: {
    maxTrackedMessageIds: number;
  };
}

export type DiscordAdapterRejectCode =
  | "UNAUTHORIZED"
  | "ALLOWLIST_DENIED"
  | "RATE_LIMITED"
  | "DUPLICATE_EVENT"
  | "EMPTY_MESSAGE";

export interface DiscordAdapterResult {
  accepted: boolean;
  code: "ACCEPTED" | DiscordAdapterRejectCode;
  message: string;
  runResult?: TaskRunResult;
}

export interface DiscordAdapterValidationResult {
  accepted: boolean;
  code: "ACCEPTED" | DiscordAdapterRejectCode;
  message: string;
}

/**
 * Normalizes username into a stable shape for `discordAdapter` logic.
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

export class DiscordAdapter {
  private readonly seenMessageIds = new Set<string>();
  private readonly messageIdQueue: string[] = [];
  private readonly rateLimitBuckets = new Map<string, number[]>();

  /**
   * Initializes `DiscordAdapter` with deterministic runtime dependencies.
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
    private readonly config: DiscordAdapterConfig
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
   * @returns Promise resolving to DiscordAdapterResult.
   */
  async handleMessage(message: DiscordInboundMessage): Promise<DiscordAdapterResult> {
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
   * @returns Computed `DiscordAdapterValidationResult` result.
   */
  validateMessage(message: DiscordInboundMessage): DiscordAdapterValidationResult {
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

    if (this.isDuplicate(message.messageId)) {
      return {
        accepted: false,
        code: "DUPLICATE_EVENT",
        message: "Inbound message rejected: duplicate message detected."
      };
    }

    if (!this.consumeRateLimit(message)) {
      return {
        accepted: false,
        code: "RATE_LIMITED",
        message: "Inbound message rejected: rate limit exceeded."
      };
    }

    this.trackMessageId(message.messageId);
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
    return this.brain.runTask(buildTaskFromText(text, receivedAt));
  }

  /**
   * Runs the full autonomous goal-resolution loop, delivering throttled progress
   * to the channel.  Messages are consolidated: only the first iteration, iterations
   * with real progress, and terminal events send a Discord message.
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
     * Decides whether this iteration should emit a progress message.
     *
     * **Why it exists:**
     * Autonomous runs can be long; this keeps Discord output useful (first step, meaningful progress,
     * and periodic heartbeat) without flooding the channel.
     *
     * **What it talks to:**
     * - Reads local throttling state (`lastProgressMessageAt`, `THROTTLE_MS`).
     *
     * @param iteration - Current loop iteration number.
     * @param approved - Number of approved actions in this iteration.
     * @returns `true` when a progress update should be sent.
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
            `[${iteration}] ${approved} approved, ${blocked} blocked ` +
            `(totals: ${totalApproved} approved, ${totalBlocked} blocked)`
          );
          lastProgressMessageAt = Date.now();
        }
      },
      onGoalMet: async (reasoning) => {
        const preview = reasoning.length > 300 ? reasoning.slice(0, 300) + "..." : reasoning;
        await onProgress(
          `Done in ${totalIterations} iteration(s). ` +
          `${totalApproved} action(s) approved, ${totalBlocked} blocked.\n${preview}`
        );
      },
      onGoalAborted: async (reason) => {
        terminalAborted = true;
        terminalReason = reason;
        await onProgress(
          `Stopped after ${totalIterations} iteration(s): ${reason}\n` +
          `${totalApproved} action(s) approved, ${totalBlocked} blocked.`
        );
      }
    };

    await loop.run(goal, callbacks, signal);
    if (terminalAborted) {
      return `Autonomous task stopped after ${totalIterations} iteration(s). ` +
        `${totalApproved} approved, ${totalBlocked} blocked. Reason: ${terminalReason}`;
    }
    return `Autonomous task completed after ${totalIterations} iteration(s). ` +
      `${totalApproved} approved, ${totalBlocked} blocked.`;
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
  private isAuthorized(message: DiscordInboundMessage): boolean {
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
  private isAllowlisted(message: DiscordInboundMessage): boolean {
    const username = normalizeUsername(message.username);
    const allowedUsernames = new Set(this.config.allowlist.allowedUsernames.map(normalizeUsername));
    const allowedUserIds = new Set(this.config.allowlist.allowedUserIds);
    const allowedChannelIds = new Set(this.config.allowlist.allowedChannelIds);

    if (allowedUsernames.size === 0 || !allowedUsernames.has(username)) {
      return false;
    }

    if (allowedUserIds.size > 0 && !allowedUserIds.has(message.userId)) {
      return false;
    }

    if (allowedChannelIds.size > 0 && !allowedChannelIds.has(message.channelId)) {
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
   * @param messageId - Stable identifier used to reference an entity or record.
   * @returns `true` when this check passes.
   */
  private isDuplicate(messageId: string): boolean {
    return this.seenMessageIds.has(messageId);
  }

  /**
   * Tracks message id for audit, retry, or telemetry decisions.
   *
   * **Why it exists:**
   * Centralizes lifecycle tracking for message id so audit and retry flows share one source of truth.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param messageId - Stable identifier used to reference an entity or record.
   */
  private trackMessageId(messageId: string): void {
    this.seenMessageIds.add(messageId);
    this.messageIdQueue.push(messageId);

    while (this.messageIdQueue.length > this.config.replay.maxTrackedMessageIds) {
      const oldest = this.messageIdQueue.shift();
      if (typeof oldest === "string") {
        this.seenMessageIds.delete(oldest);
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
  private consumeRateLimit(message: DiscordInboundMessage): boolean {
    const key = `${normalizeUsername(message.username)}:${message.channelId}`;
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
