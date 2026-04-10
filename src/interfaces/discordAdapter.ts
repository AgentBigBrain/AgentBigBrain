/**
 * @fileoverview Provides a secure Discord ingress adapter with auth, username allowlist, rate-limit, replay defense, and orchestrator routing.
 */

import { MAIN_AGENT_ID } from "../core/agentIdentity";
import { makeId } from "../core/ids";
import { BrainOrchestrator } from "../core/orchestrator";
import { TaskRequest, TaskRunResult } from "../core/types";
import type { EntityGraphV1 } from "../core/types";
import {
  InterpretedConversationIntent,
  IntentInterpreterTurn
} from "../organs/intentInterpreter";
import { PulseLexicalRuleContext } from "../organs/pulseLexicalClassifier";
import {
  AgentPulseEvaluationRequest,
  AgentPulseEvaluationResult
} from "../core/profileMemoryStore";
import type {
  ProfileMemoryIngestRequest,
  ProfileReadableFact
} from "../core/profileMemoryRuntime/contracts";
import type { ProfileFactContinuityResult } from "../core/profileMemoryRuntime/profileMemoryQueryContracts";
import { AutonomousLoop, AutonomousLoopCallbacks } from "../core/agentLoop";
import { createModelClientFromEnv } from "../models/createModelClient";
import { createBrainConfigFromEnv } from "../core/config";
import {
  buildAutonomousGoalAbortedProgressMessage,
  buildAutonomousGoalMetProgressMessage,
  buildAutonomousIterationProgressMessage,
  buildAutonomousTerminalSummaryMessage,
  humanizeAutonomousStopReason
} from "./userFacing/stopSummarySurface";
import { buildAutonomousConversationExecutionResult } from "./autonomousConversationExecutionResult";
import { runDirectConversationReply } from "./conversationRuntime/directConversationReply";
import type {
  ConversationContinuityFactQueryRequest,
  ConversationContinuityFactResult,
  ConversationContinuityFactRecord,
  ConversationExecutionResult,
  ConversationExecutionProgressUpdate,
  ConversationContinuityEpisodeQueryRequest,
  ConversationContinuityEpisodeRecord,
  ConversationContinuityReadSession,
  ConversationMemoryFactReviewRecord,
  ConversationMemoryFactReviewResult,
  ConversationMemoryReviewRecord
} from "./conversationRuntime/managerContracts";
import type { ManagedProcessSnapshot } from "../organs/liveRun/managedProcessRegistry";
import type { BrowserSessionSnapshot } from "../organs/liveRun/browserSessionRegistry";
import type { ConversationTransportIdentityRecord } from "./sessionStore";
import { toLaneBoundary } from "../organs/memorySynthesis/temporalSynthesisAdapterCompatibilitySupport";

export interface DiscordInboundMessage {
  messageId: string;
  channelId: string;
  userId: string;
  username: string;
  transportIdentity?: ConversationTransportIdentityRecord | null;
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

/**
 * Maps core continuity episode results into the interface-facing continuity shape.
 *
 * @param entry - Core continuity episode match from the orchestrator boundary.
 * @returns Interface continuity episode record.
 */
function toConversationContinuityEpisodeRecord(
  entry: Awaited<ReturnType<BrainOrchestrator["queryContinuityEpisodes"]>>[number]
): ConversationContinuityEpisodeRecord {
  return {
    episodeId: entry.episode.id,
    title: entry.episode.title,
    summary: entry.episode.summary,
    status: entry.episode.status,
    lastMentionedAt: entry.episode.lastMentionedAt,
    entityRefs: [...entry.episode.entityRefs],
    entityLinks: entry.entityLinks.map((link) => ({
      entityKey: link.entityKey,
      canonicalName: link.canonicalName
    })),
    openLoopLinks: entry.openLoopLinks.map((link) => ({
      loopId: link.loopId,
      threadKey: link.threadKey,
      status: link.status,
      priority: link.priority
    }))
  };
}

/**
 * Maps core continuity fact results into the interface-facing continuity shape.
 *
 * @param fact - Core continuity fact match from the orchestrator boundary.
 * @returns Interface continuity fact record.
 */
function toConversationContinuityFactRecord(
  fact: ProfileFactContinuityResult[number]
): ConversationContinuityFactRecord {
  return {
    factId: fact.factId,
    key: fact.key,
    value: fact.value,
    status: fact.status,
    observedAt: fact.observedAt,
    lastUpdatedAt: fact.lastUpdatedAt,
    confidence: fact.confidence
  };
}

/**
 * Maps one core continuity fact result into the interface-facing continuity shape.
 *
 * @param facts - Core continuity fact result from the orchestrator boundary.
 * @returns Interface continuity fact result with temporal metadata attached.
 */
function toConversationContinuityFactResult(
  facts: ProfileFactContinuityResult | readonly ProfileReadableFact[]
): ConversationContinuityFactResult {
  const temporalSynthesis = "temporalSynthesis" in facts ? facts.temporalSynthesis : null;
  const semanticMode = "semanticMode" in facts ? facts.semanticMode : "relationship_inventory";
  const relevanceScope = "relevanceScope" in facts ? facts.relevanceScope : "global_profile";
  const scopedThreadKeys = "scopedThreadKeys" in facts ? facts.scopedThreadKeys : [];
  return Object.assign(
    facts.map(toConversationContinuityFactRecord),
    {
      semanticMode,
      relevanceScope,
      scopedThreadKeys: [...scopedThreadKeys],
      temporalSynthesis,
      laneBoundaries: temporalSynthesis
        ? temporalSynthesis.laneMetadata.map((lane) =>
            toLaneBoundary(lane, {
              semanticMode,
              relevanceScope,
              scopedThreadKeys
            })
          )
        : []
    }
  ) as ConversationContinuityFactResult;
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
   * Generates a direct conversational reply without entering the durable task-run path.
   *
   * **Why it exists:**
   * Ordinary conversation should remain model-authored even when another task is using the shared
   * runtime state file.
   *
   * @param text - Current conversational turn, optionally enriched with bounded chat context.
   * @param receivedAt - Timestamp used for deterministic synthetic task metadata.
   * @returns Model-authored conversational reply payload.
   */
  async runDirectConversationTurn(
    text: string,
    receivedAt: string,
    _session?: { modelBackendOverride?: string | null; codexAuthProfileId?: string | null } | null
  ): Promise<ConversationExecutionResult> {
    return {
      summary: await runDirectConversationReply(text, receivedAt),
      taskRunResult: null
    };
  }

  /**
   * Lists managed-process lease snapshots currently owned by the shared runtime.
   *
   * **Why it exists:**
   * Gateway conversation flows use this to surface already-running local previews when a follow-up
   * request needs to reorganize or close user-owned workspaces safely.
   *
   * **What it talks to:**
   * - Uses `BrainOrchestrator.listManagedProcessSnapshots()` from `../core/orchestrator`.
   *
   * @returns Caller-owned managed-process snapshots.
   */
  async listManagedProcessSnapshots(): Promise<readonly ManagedProcessSnapshot[]> {
    return this.brain.listManagedProcessSnapshots();
  }

  /**
   * Lists browser-session snapshots currently owned by the shared runtime.
   *
   * **Why it exists:**
   * Gateway conversation flows use this to ground close/reopen follow-ups in live browser control
   * state instead of stale persisted session metadata after restart churn.
   *
   * **What it talks to:**
   * - Uses `BrainOrchestrator.listBrowserSessionSnapshots()` from `../core/orchestrator`.
   *
   * @returns Caller-owned browser-session snapshots.
   */
  async listBrowserSessionSnapshots(): Promise<readonly BrowserSessionSnapshot[]> {
    return this.brain.listBrowserSessionSnapshots();
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
    signal?: AbortSignal,
    initialExecutionInput?: string | null,
    onProgressUpdate?: (update: ConversationExecutionProgressUpdate) => Promise<void>
  ): Promise<ConversationExecutionResult> {
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
    let latestTaskRunResult: TaskRunResult | null = null;
    const aggregatedActionResults: TaskRunResult["actionResults"] = [];
    let firstTaskStartedAt: string | null = null;
    let latestTaskCompletedAt: string | null = null;
    let lastStateMessageKey = "";
    let terminalProgressStateEmitted = false;
    let terminalProgressMessageEmitted = false;

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
      onStateChange: async (update) => {
        await onProgressUpdate?.({
          status: update.state,
          message: update.message
        });
        if (update.state === "completed" || update.state === "stopped") {
          terminalProgressStateEmitted = true;
          return;
        }
        if (update.state === "working" && update.iteration === 1) {
          return;
        }
        const stateMessage = update.message.trim();
        const stateKey = `${update.state}|${update.iteration}|${stateMessage}`;
        const now = Date.now();
        if (
          stateKey === lastStateMessageKey ||
          (update.state === "working" && now - lastProgressMessageAt < THROTTLE_MS)
        ) {
          return;
        }
        lastStateMessageKey = stateKey;
        await onProgress(stateMessage);
        lastProgressMessageAt = now;
      },
      onIterationStart: async (iteration, input) => {
        totalIterations = iteration;
        if (iteration === 1) {
          const preview = input.length > 150 ? input.slice(0, 150) + "..." : input;
          await onProgress(`Autonomous task started: ${preview}`);
          lastProgressMessageAt = Date.now();
        }
      },
      onIterationComplete: async (iteration, _summary, approved, blocked, result) => {
        totalIterations = iteration;
        totalApproved += approved;
        totalBlocked += blocked;
        latestTaskRunResult = result;
        aggregatedActionResults.push(...result.actionResults);
        firstTaskStartedAt ??= result.startedAt;
        latestTaskCompletedAt = result.completedAt;
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
        lastStateMessageKey = "";
        if (!terminalProgressStateEmitted) {
          await onProgressUpdate?.({
            status: "completed",
            message: reasoning
          });
          terminalProgressStateEmitted = true;
        }
        await onProgress(
          buildAutonomousGoalMetProgressMessage(
            totalIterations,
            totalApproved,
            totalBlocked,
            reasoning
          )
        );
        terminalProgressMessageEmitted = true;
      },
      onGoalAborted: async (reason) => {
        terminalAborted = true;
        terminalReason = reason;
        lastStateMessageKey = "";
        if (!terminalProgressStateEmitted) {
          await onProgressUpdate?.({
            status: "stopped",
            message: humanizeAutonomousStopReason(reason)
          });
          terminalProgressStateEmitted = true;
        }
        await onProgress(
          buildAutonomousGoalAbortedProgressMessage(
            totalIterations,
            totalApproved,
            totalBlocked,
            reason
          )
        );
        terminalProgressMessageEmitted = true;
      }
    };

    try {
      await loop.run(goal, callbacks, signal, undefined, initialExecutionInput ?? null);
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
        terminalProgressMessageEmitted = true;
      }
    }
    if (terminalAborted) {
      if (!terminalProgressStateEmitted) {
        await onProgressUpdate?.({
          status: "stopped",
          message: humanizeAutonomousStopReason(terminalReason)
        });
        terminalProgressStateEmitted = true;
      }
      if (!terminalProgressMessageEmitted) {
        await onProgress(
          buildAutonomousGoalAbortedProgressMessage(
            totalIterations,
            totalApproved,
            totalBlocked,
            terminalReason
          )
        );
        terminalProgressMessageEmitted = true;
      }
    }
    const summary = buildAutonomousTerminalSummaryMessage(
      !terminalAborted,
      totalIterations,
      totalApproved,
      totalBlocked,
      terminalReason
    );
    return buildAutonomousConversationExecutionResult(
      summary,
      latestTaskRunResult,
      aggregatedActionResults,
      firstTaskStartedAt,
      latestTaskCompletedAt
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
   * Queries bounded episodic-memory matches linked to the current continuity state.
   *
   * @param graph - Current Stage 6.86 entity graph.
   * @param request - Continuity-aware episode query request from interface runtime.
   * @returns Bounded recall-ready episodic-memory records.
   */
  async queryContinuityEpisodes(
    graph: EntityGraphV1,
    request: ConversationContinuityEpisodeQueryRequest
  ): Promise<readonly ConversationContinuityEpisodeRecord[]> {
    const linkedEpisodes = await this.brain.queryContinuityEpisodes(
      graph,
      request.stack,
      request.entityHints,
      request.maxEpisodes,
      {
        semanticMode: request.semanticMode,
        relevanceScope: request.relevanceScope,
        asOfValidTime: request.asOfValidTime,
        asOfObservedTime: request.asOfObservedTime
      }
    );
    return linkedEpisodes.map(toConversationContinuityEpisodeRecord);
  }

  /**
   * Queries bounded profile facts linked to the current continuity state.
   *
   * @param graph - Current Stage 6.86 entity graph.
   * @param request - Continuity-aware fact query request from interface runtime.
   * @returns Bounded recall/planning-ready profile facts.
   */
  async queryContinuityFacts(
    graph: EntityGraphV1,
    request: ConversationContinuityFactQueryRequest
  ): Promise<ConversationContinuityFactResult> {
    const facts = await this.brain.queryContinuityFacts(
      graph,
      request.stack,
      request.entityHints,
      request.maxFacts,
      {
        semanticMode: request.semanticMode,
        relevanceScope: request.relevanceScope,
        asOfValidTime: request.asOfValidTime,
        asOfObservedTime: request.asOfObservedTime
      }
    );
    return toConversationContinuityFactResult(facts);
  }

  /**
   * Opens one bounded continuity read session that reuses the same graph and profile-memory
   * snapshot across multiple continuity queries for one conversation turn.
   *
   * @param graph - Current Stage 6.86 entity graph.
   * @returns Conversation continuity read session, or `null` when continuity is unavailable.
   */
  async openContinuityReadSession(
    graph: EntityGraphV1
  ): Promise<ConversationContinuityReadSession | null> {
    const readSession = await this.brain.openContinuityReadSession(graph);
    if (!readSession) {
      return null;
    }
    return {
      queryContinuityEpisodes: async (request) =>
        (
          await readSession.queryContinuityEpisodes(
            request.stack,
            request.entityHints,
            request.maxEpisodes,
            {
              semanticMode: request.semanticMode,
              relevanceScope: request.relevanceScope,
              asOfValidTime: request.asOfValidTime,
              asOfObservedTime: request.asOfObservedTime
            }
          )
        ).map(toConversationContinuityEpisodeRecord),
      queryContinuityFacts: async (request) =>
        toConversationContinuityFactResult(
          await readSession.queryContinuityFacts(
            request.stack,
            request.entityHints,
            request.maxFacts,
            {
              semanticMode: request.semanticMode,
              relevanceScope: request.relevanceScope,
              asOfValidTime: request.asOfValidTime,
              asOfObservedTime: request.asOfObservedTime
            }
          )
        )
    };
  }

  /**
   * Persists bounded direct-conversation profile memory through the orchestrator seam.
   *
   * @param input - Raw direct conversational user wording or validated fact candidates.
   * @param receivedAt - Observation timestamp for the turn.
   * @returns `true` when profile memory accepted at least one canonical fact or episode update.
   */
  async rememberConversationProfileInput(
    input: string | ProfileMemoryIngestRequest,
    receivedAt: string
  ): Promise<boolean> {
    return this.brain.rememberConversationProfileInput(input, receivedAt);
  }

  /**
   * Returns bounded remembered situations for explicit user review commands.
   *
   * @param reviewTaskId - Synthetic task id for audit linkage.
   * @param query - User-facing review command text.
   * @param nowIso - Timestamp applied to ranking/audit.
   * @param maxEpisodes - Maximum number of situations to surface.
   * @returns Bounded remembered situations for command rendering.
   */
  async reviewConversationMemory(
    reviewTaskId: string,
    query: string,
    nowIso: string,
    maxEpisodes = 5
  ): Promise<readonly ConversationMemoryReviewRecord[]> {
    return this.brain.reviewRememberedSituations(reviewTaskId, query, nowIso, maxEpisodes);
  }

  /**
   * Returns bounded remembered facts for explicit user review commands.
   *
   * @param reviewTaskId - Synthetic task id for audit linkage.
   * @param query - User-facing review command text.
   * @param nowIso - Timestamp applied to ranking/audit.
   * @param maxFacts - Maximum number of facts to surface.
   * @returns Bounded remembered facts for future command rendering.
   */
  async reviewConversationMemoryFacts(
    reviewTaskId: string,
    query: string,
    nowIso: string,
    maxFacts = 5
  ): Promise<ConversationMemoryFactReviewResult> {
    return this.brain.reviewRememberedFacts(reviewTaskId, query, nowIso, maxFacts);
  }

  /**
   * Marks one remembered situation resolved through an explicit user command.
   *
   * @param episodeId - Episode identifier targeted by the user.
   * @param sourceTaskId - Synthetic task id for mutation provenance.
   * @param sourceText - User command text that triggered the mutation.
   * @param nowIso - Timestamp applied to the mutation.
   * @param note - Optional bounded outcome note.
   * @returns Updated remembered situation, or `null` when unavailable.
   */
  async resolveConversationMemoryEpisode(
    episodeId: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso: string,
    note?: string
  ): Promise<ConversationMemoryReviewRecord | null> {
    return this.brain.resolveRememberedSituation(
      episodeId,
      sourceTaskId,
      sourceText,
      nowIso,
      note
    );
  }

  /**
   * Marks one remembered situation wrong/no longer relevant through an explicit user command.
   *
   * @param episodeId - Episode identifier targeted by the user.
   * @param sourceTaskId - Synthetic task id for mutation provenance.
   * @param sourceText - User command text that triggered the mutation.
   * @param nowIso - Timestamp applied to the mutation.
   * @param note - Optional bounded correction note.
   * @returns Updated remembered situation, or `null` when unavailable.
   */
  async markConversationMemoryEpisodeWrong(
    episodeId: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso: string,
    note?: string
  ): Promise<ConversationMemoryReviewRecord | null> {
    return this.brain.markRememberedSituationWrong(
      episodeId,
      sourceTaskId,
      sourceText,
      nowIso,
      note
    );
  }

  /**
   * Forgets one remembered situation through an explicit user command.
   *
   * @param episodeId - Episode identifier targeted by the user.
   * @param nowIso - Timestamp applied to the mutation.
   * @returns Removed remembered situation, or `null` when unavailable.
   */
  async forgetConversationMemoryEpisode(
    episodeId: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso: string
  ): Promise<ConversationMemoryReviewRecord | null> {
    return this.brain.forgetRememberedSituation(
      episodeId,
      sourceTaskId,
      sourceText,
      nowIso
    );
  }

  /**
   * Corrects one bounded remembered fact through an explicit user command.
   *
   * @param factId - Fact identifier targeted by the user.
   * @param replacementValue - Replacement value approved by the user.
   * @param sourceTaskId - Synthetic task id for mutation provenance.
   * @param sourceText - User command text that triggered the mutation.
   * @param nowIso - Timestamp applied to the mutation.
   * @param note - Optional bounded correction note.
   * @returns Updated remembered fact, or `null` when unavailable.
   */
  async correctConversationMemoryFact(
    factId: string,
    replacementValue: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso: string,
    note?: string
  ): Promise<ConversationMemoryFactReviewRecord | null> {
    return this.brain.correctRememberedFact(
      factId,
      replacementValue,
      sourceTaskId,
      sourceText,
      nowIso,
      note
    );
  }

  /**
   * Forgets one bounded remembered fact through an explicit user command.
   *
   * @param factId - Fact identifier targeted by the user.
   * @param sourceTaskId - Synthetic task id for mutation provenance.
   * @param sourceText - User command text that triggered the mutation.
   * @param nowIso - Timestamp applied to the mutation.
   * @returns Updated remembered fact, or `null` when unavailable.
   */
  async forgetConversationMemoryFact(
    factId: string,
    sourceTaskId: string,
    sourceText: string,
    nowIso: string
  ): Promise<ConversationMemoryFactReviewRecord | null> {
    return this.brain.forgetRememberedFact(
      factId,
      sourceTaskId,
      sourceText,
      nowIso
    );
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
