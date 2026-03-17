/**
 * @fileoverview Implements a minimal Discord gateway + REST transport that maps MESSAGE_CREATE events into secure adapter messages.
 */

import path from "node:path";
import { DiscordAdapter } from "./discordAdapter";
import { AgentPulseScheduler } from "./agentPulseScheduler";
import { ConversationManager } from "./conversationManager";
import { type ConversationNotifierTransport } from "./conversationRuntime/managerContracts";
import { DiscordInterfaceConfig } from "./runtimeConfig";
import { InterfaceSessionStore } from "./sessionStore";
import {
  deliverPreparedTransportResponse,
  handleAcceptedTransportConversation
} from "./transportRuntime/inboundDispatch";
import {
  createDiscordGatewayNotifier,
  type DiscordMessageCreateData,
  prepareDiscordMessageCreate,
  sendDiscordGatewayMessage
} from "./transportRuntime/discordGatewayRuntime";
import {
  attachDiscordSocketLifecycle,
  handleDiscordHelloLifecycle,
  reconnectWithBackoffLoop,
  routeDiscordDispatchEvent,
  DiscordSocket,
  handleDiscordGatewaySocketMessage,
  resolveDiscordGatewaySocketUrl,
  resolveWebSocketConstructor,
} from "./transportRuntime/gatewayLifecycle";
import { abortAutonomousTransportTask } from "./transportRuntime/autonomousAbortControl";
import { runStage685CheckpointLiveReview } from "./CheckpointReviewRunners/stage685CheckpointReviewRunner";
import { runGatewayCheckpointReview } from "./checkpointReviewRouting";
import { createDynamicPulseEntityGraphGetter } from "./entityGraphRuntime";
import { renderPulseUserFacingSummaryV1 } from "./pulseUxRuntime";
import { selectUserFacingSummary } from "./userFacingResult";
import { runCheckpoint611LiveReview } from "./CheckpointReviewRunners/stage6_5Checkpoint6_11Live";
import { runCheckpoint613LiveReview } from "./CheckpointReviewRunners/stage6_5Checkpoint6_13Live";
import { runCheckpoint675LiveReview } from "../core/stage6_75CheckpointLive";
import { EntityGraphStore } from "../core/entityGraphStore";
import { buildDiscordCapabilitySummary } from "./conversationRuntime/capabilityIntrospection";
import { SkillRegistryStore } from "../organs/skillRegistry/skillRegistryStore";
import type { LocalIntentModelResolver } from "../organs/languageUnderstanding/localIntentModelContracts";

interface DiscordGatewayOptions {
  sessionStore?: InterfaceSessionStore;
  entityGraphStore?: EntityGraphStore;
  localIntentModelResolver?: LocalIntentModelResolver;
}

/**
 * Evaluates interface debug enabled and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the interface debug enabled policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @returns `true` when this check passes.
 */
function isInterfaceDebugEnabled(): boolean {
  return (process.env.BRAIN_INTERFACE_DEBUG ?? "").trim().toLowerCase() === "true";
}

/**
 * Derives channel id from conversation key from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for channel id from conversation key in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param conversationKey - Lookup key or map field identifier.
 * @returns Computed `string | null` result.
 */
function extractChannelIdFromConversationKey(conversationKey: string): string | null {
  const segments = conversationKey.split(":");
  if (segments.length < 3 || segments[0] !== "discord") {
    return null;
  }
  return segments[1] || null;
}

export class DiscordGateway {
  private running = false;
  private socket: DiscordSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private sequence: number | null = null;
  private botUserId = "";
  private stopPromise: Promise<void> | null = null;
  private resolveStopPromise: (() => void) | null = null;
  private readonly sessionStore: InterfaceSessionStore;
  private readonly conversationManager: ConversationManager;
  private readonly pulseScheduler: AgentPulseScheduler;
  private readonly debugEnabled = isInterfaceDebugEnabled();
  private readonly autonomousAbortControllers = new Map<string, AbortController>();
  private readonly entityGraphStore: EntityGraphStore;
  private readonly skillRegistryStore = new SkillRegistryStore(path.resolve(process.cwd(), "runtime/skills"));

  /**
   * Initializes `DiscordGateway` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Uses `EntityGraphStore` (import `EntityGraphStore`) from `../core/entityGraphStore`.
   * - Uses `AgentPulseScheduler` (import `AgentPulseScheduler`) from `./agentPulseScheduler`.
   * - Uses `runCheckpoint611LiveReview` (import `runCheckpoint611LiveReview`) from `./CheckpointReviewRunners/stage6_5Checkpoint6_11Live`.
   * - Uses `runCheckpoint613LiveReview` (import `runCheckpoint613LiveReview`) from `./CheckpointReviewRunners/stage6_5Checkpoint6_13Live`.
   * - Uses `runStage685CheckpointLiveReview` (import `runStage685CheckpointLiveReview`) from `./CheckpointReviewRunners/stage685CheckpointReviewRunner`.
   * - Uses `ConversationManager` (import `ConversationManager`) from `./conversationManager`.
   * - Additional imported collaborators are also used in this function body.
   *
   * @param adapter - Value for adapter.
   * @param config - Configuration or policy settings applied here.
   * @param options - Optional tuning knobs for this operation.
   */
  constructor(
    private readonly adapter: DiscordAdapter,
    private readonly config: DiscordInterfaceConfig,
    options: DiscordGatewayOptions = {}
  ) {
    this.sessionStore = options.sessionStore ?? new InterfaceSessionStore();
    this.entityGraphStore = options.entityGraphStore ?? new EntityGraphStore();
    this.conversationManager = new ConversationManager(this.sessionStore, {
      ackDelayMs: this.config.security.ackDelayMs,
      showCompletionPrefix: this.config.security.showCompletionPrefix,
      followUpOverridePath: this.config.security.followUpOverridePath,
      pulseLexicalOverridePath: this.config.security.pulseLexicalOverridePath,
      allowAutonomousViaInterface: this.config.security.allowAutonomousViaInterface
    }, {
      interpretConversationIntent: async (input, recentTurns, pulseRuleContext) =>
        this.adapter.interpretConversationIntent(input, recentTurns, pulseRuleContext),
      runDirectConversationTurn: async (input, receivedAt) =>
        this.adapter.runDirectConversationTurn(input, receivedAt),
      queryContinuityEpisodes: async (request) => {
        const graph = await this.entityGraphStore.getGraph();
        return this.adapter.queryContinuityEpisodes(graph, request);
      },
      queryContinuityFacts: async (request) => {
        const graph = await this.entityGraphStore.getGraph();
        return this.adapter.queryContinuityFacts(graph, request);
      },
      reviewConversationMemory: async (request) =>
        this.adapter.reviewConversationMemory(
          request.reviewTaskId,
          request.query,
          request.nowIso,
          request.maxEpisodes
        ),
      resolveConversationMemoryEpisode: async (request) =>
        this.adapter.resolveConversationMemoryEpisode(
          request.episodeId,
          request.sourceTaskId,
          request.sourceText,
          request.nowIso,
          request.note
        ),
      markConversationMemoryEpisodeWrong: async (request) =>
        this.adapter.markConversationMemoryEpisodeWrong(
          request.episodeId,
          request.sourceTaskId,
          request.sourceText,
          request.nowIso,
          request.note
        ),
      forgetConversationMemoryEpisode: async (request) =>
        this.adapter.forgetConversationMemoryEpisode(
          request.episodeId,
          request.sourceTaskId,
          request.sourceText,
          request.nowIso
        ),
      localIntentModelResolver: options.localIntentModelResolver,
      listAvailableSkills: async () => this.skillRegistryStore.listAvailableSkills(),
      describeRuntimeCapabilities: async () =>
        buildDiscordCapabilitySummary(
          this.config.security.allowAutonomousViaInterface
        ),
      listManagedProcessSnapshots: async () => this.adapter.listManagedProcessSnapshots(),
      listBrowserSessionSnapshots: async () => this.adapter.listBrowserSessionSnapshots(),
      abortActiveAutonomousRun: (conversationId) =>
        abortAutonomousTransportTask(conversationId, this.autonomousAbortControllers),
      runCheckpointReview: async (checkpointId) =>
        runGatewayCheckpointReview(checkpointId, {
          runCheckpoint611LiveReview,
          runCheckpoint613LiveReview,
          runCheckpoint675LiveReview,
          runStage685CheckpointLiveReview
        })
    });
    this.pulseScheduler = new AgentPulseScheduler(
      {
        provider: "discord",
        sessionStore: this.sessionStore,
        evaluateAgentPulse: async (request) => this.adapter.evaluateAgentPulse(request),
        enqueueSystemJob: async (session, systemInput, receivedAt) => {
          const channelId = extractChannelIdFromConversationKey(session.conversationId);
          if (!channelId) {
            return false;
          }
          const notifier = this.createConversationNotifier(channelId);
          return this.conversationManager.enqueueSystemJob(
            session.conversationId,
            systemInput,
            receivedAt,
            async (input, timestamp) => {
              const runResult = await this.adapter.runTextTask(input, timestamp);
              const baseSummary = selectUserFacingSummary(runResult, {
                showTechnicalSummary: false,
                showSafetyCodes: false
              });
              return {
                summary: renderPulseUserFacingSummaryV1(
                  session,
                  systemInput,
                  baseSummary,
                  timestamp
                )
              };
            },
            notifier
          );
        },
        updatePulseState: async (conversationKey, update) =>
          this.conversationManager.updateAgentPulseState(conversationKey, update),
        enableDynamicPulse: this.config.security.enableDynamicPulse,
        getEntityGraph: createDynamicPulseEntityGraphGetter(
          this.config.security.enableDynamicPulse,
          this.entityGraphStore
        )
      },
      {
        tickIntervalMs: this.config.security.agentPulseTickIntervalMs,
        reasonPriority: ["unresolved_commitment", "stale_fact_revalidation"]
      }
    );
  }

  /**
   * Starts input within this module's managed runtime lifecycle.
   *
   * **Why it exists:**
   * Keeps startup sequencing for input explicit and deterministic.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   * @returns Promise resolving to void.
   */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.pulseScheduler.start();
    await this.connect();
    this.stopPromise = new Promise<void>((resolve) => {
      this.resolveStopPromise = resolve;
    });
    await this.stopPromise;
  }

  /**
   * Stops or clears input to keep runtime state consistent.
   *
   * **Why it exists:**
   * Centralizes teardown/reset behavior for input so lifecycle handling stays predictable.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   */
  stop(): void {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.pulseScheduler.stop();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.socket) {
      this.socket.close(1000, "shutdown");
      this.socket = null;
    }
    if (this.resolveStopPromise) {
      this.resolveStopPromise();
      this.resolveStopPromise = null;
    }
    this.stopPromise = null;
  }

  /**
   * Starts input within this module's managed runtime lifecycle.
   *
   * **Why it exists:**
   * Keeps startup sequencing for input explicit and deterministic.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   * @returns Promise resolving to void.
   */
  private async connect(): Promise<void> {
    const socketUrl = await resolveDiscordGatewaySocketUrl({
      gatewayUrl: this.config.gatewayUrl,
      botToken: this.config.botToken
    });
    const WebSocketCtor = resolveWebSocketConstructor();
    const socket = new WebSocketCtor(socketUrl);
    this.socket = socket;

    attachDiscordSocketLifecycle({
      socket,
      onOpen: () => {
        console.log("[DiscordGateway] Connected.");
      },
      onMessage: async (rawData) =>
        handleDiscordGatewaySocketMessage({
          rawData,
          onSequence: (sequence: number) => {
            this.sequence = sequence;
          },
          onHello: async (data) => this.handleHello(data),
          onDispatch: async (eventType, data) => this.handleDispatch(eventType, data)
        }),
      onMessageError: (error) => {
        console.error(`[DiscordGateway] message handling error: ${error.message}`);
      },
      onError: (error) => {
        console.error(`[DiscordGateway] socket error: ${String(error)}`);
      },
      onClose: () => {
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        this.socket = null;
        if (this.running) {
          void this.reconnectWithBackoff();
          return;
        }
        if (this.resolveStopPromise) {
          this.resolveStopPromise();
          this.resolveStopPromise = null;
        }
      }
    });
  }

  /**
   * Implements reconnect with backoff behavior used by `discordGateway`.
   *
   * **Why it exists:**
   * Keeps `reconnect with backoff` logic in one place to reduce behavior drift.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   * @returns Promise resolving to void.
   */
  private async reconnectWithBackoff(): Promise<void> {
    await reconnectWithBackoffLoop({
      delayMs: 2_000,
      isRunning: () => this.running,
      reconnect: async () => this.connect(),
      onReconnectError: (error) => {
        console.error(`[DiscordGateway] reconnect failed: ${error.message}`);
      }
    });
  }

  /**
   * Executes hello as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the hello runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param data - Value for data.
   * @returns Promise resolving to void.
   */
  private async handleHello(data: { heartbeat_interval?: number } | undefined): Promise<void> {
    this.heartbeatTimer = handleDiscordHelloLifecycle({
      data,
      existingHeartbeatTimer: this.heartbeatTimer,
      sequenceProvider: () => this.sequence,
      socket: this.socket,
      botToken: this.config.botToken,
      intents: this.config.intents
    });
  }

  /**
   * Executes dispatch as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the dispatch runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param eventType - Value for event type.
   * @param data - Value for data.
   * @returns Promise resolving to void.
   */
  private async handleDispatch(eventType: string, data: unknown): Promise<void> {
    await routeDiscordDispatchEvent({
      eventType,
      data,
      onReady: async (ready) => {
        this.botUserId = ready.user?.id ?? "";
      },
      onMessageCreate: async (messageData) =>
        this.handleMessageCreate(messageData as DiscordMessageCreateData)
    });
  }

  /**
   * Executes message create as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the message create runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses `prepareDiscordMessageCreate(...)` for provider-specific parse/validation.
   * - Uses `handleAcceptedTransportConversation(...)` for shared accepted-message dispatch.
   * - Uses `sendDiscordGatewayMessage(...)` for reject/stop/final delivery.
   *
   * @param data - Value for data.
   * @returns Promise resolving to void.
   */
  private async handleMessageCreate(data: DiscordMessageCreateData): Promise<void> {
    const prepared = prepareDiscordMessageCreate({
      data,
      botUserId: this.botUserId,
      sharedSecret: this.config.security.sharedSecret,
      invocationPolicy: this.config.security.invocation,
      validateMessage: (message) => this.adapter.validateMessage(message),
      abortControllers: this.autonomousAbortControllers
    });
    if (prepared.kind === "ignored") {
      return;
    }
    if (prepared.kind === "rejected") {
      await deliverPreparedTransportResponse(
        prepared.responseText,
        (text: string) =>
          sendDiscordGatewayMessage(
            this.config,
            prepared.channelId,
            text,
            (message: string) => this.logDebug(message)
          ),
        "DISCORD_SEND_FAILED"
      );
      return;
    }
    if (prepared.kind === "stop") {
      await deliverPreparedTransportResponse(
        prepared.responseText,
        (text: string) =>
          sendDiscordGatewayMessage(
            this.config,
            prepared.channelId,
            text,
            (message: string) => this.logDebug(message)
          ),
        "DISCORD_SEND_FAILED"
      );
      return;
    }

    this.logDebug(
      `Inbound MESSAGE_CREATE id=${prepared.messageId} channel=${prepared.channelId} user=${prepared.username}(${prepared.userId}) textLength=${prepared.inbound.text.length}`
    );

    const notifier = this.createConversationNotifier(prepared.channelId);
    await handleAcceptedTransportConversation({
      inbound: {
        provider: "discord",
        conversationId: prepared.channelId,
        userId: prepared.userId,
        username: prepared.username,
        conversationVisibility: prepared.conversationVisibility,
        text: prepared.inbound.text,
        receivedAt: prepared.inbound.receivedAt ?? new Date().toISOString()
      },
      entityGraphEvent: prepared.entityGraphEvent,
      notifier
      ,
      conversationManager: this.conversationManager,
      entityGraphStore: this.entityGraphStore,
      dynamicPulseEnabled: this.config.security.enableDynamicPulse,
      abortControllers: this.autonomousAbortControllers,
      runTextTask: async (input: string, receivedAt: string) => {
        const runResult = await this.adapter.runTextTask(input, receivedAt);
        return {
          summary: selectUserFacingSummary(runResult, {
            showTechnicalSummary: this.config.security.showTechnicalSummary,
            showSafetyCodes: this.config.security.showSafetyCodes
          }),
          taskRunResult: runResult
        };
      },
      runAutonomousTask: (goal, timestamp, progressSender, signal, initialExecutionInput) =>
        this.adapter.runAutonomousTask(
          goal,
          timestamp,
          progressSender,
          signal,
          initialExecutionInput
        ),
      deliverReply: (reply: string) =>
        sendDiscordGatewayMessage(
          this.config,
          prepared.channelId,
          reply,
          (message: string) => this.logDebug(message)
        ),
      deliveryFailureCode: "DISCORD_SEND_FAILED",
      onEntityGraphMutationFailure: (error) => {
        console.warn(`[DiscordGateway] entity-graph mutation skipped: ${error.message}`);
      },
      onEmptyReply: () => {
        this.logDebug(`No reply generated for message id=${prepared.messageId}.`);
      }
    });
  }

  /**
   * Implements log debug behavior used by `discordGateway`.
   *
   * **Why it exists:**
   * Keeps `log debug` logic in one place to reduce behavior drift.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param message - Message/text content processed by this function.
   */
  private logDebug(message: string): void {
    if (!this.debugEnabled) {
      return;
    }
    console.log(`[DiscordGateway] ${message}`);
  }

  /**
   * Creates a notifier transport bound to a specific Discord channel.
   */
  private createConversationNotifier(channelId: string): ConversationNotifierTransport {
    return createDiscordGatewayNotifier(
      this.config,
      channelId,
      (message: string) => this.logDebug(message)
    );
  }
}
