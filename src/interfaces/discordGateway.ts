/**
 * @fileoverview Implements a minimal Discord gateway + REST transport that maps MESSAGE_CREATE events into secure adapter messages.
 */

import { DiscordAdapter, DiscordInboundMessage } from "./discordAdapter";
import { AgentPulseScheduler } from "./agentPulseScheduler";
import {
  ConversationDeliveryResult,
  ConversationManager,
  ConversationNotifierTransport,
  parseAutonomousExecutionInput
} from "./conversationManager";
import { buildDiscordApiUrl } from "./discordApiUrl";
import { parseDiscordRetryAfterMs } from "./discordRateLimit";
import { applyInvocationHints } from "./invocationHints";
import { applyInvocationPolicy } from "./invocationPolicy";
import { DiscordInterfaceConfig } from "./runtimeConfig";
import { InterfaceSessionStore } from "./sessionStore";
import { runStage685CheckpointLiveReview } from "./CheckpointReviewRunners/stage685CheckpointReviewRunner";
import { runGatewayCheckpointReview } from "./checkpointReviewRouting";
import {
  createDynamicPulseEntityGraphGetter,
  maybeRecordInboundEntityGraphMutation
} from "./entityGraphRuntime";
import { renderPulseUserFacingSummaryV1 } from "./pulseUxRuntime";
import { selectUserFacingSummary } from "./userFacingResult";
import { runCheckpoint611LiveReview } from "./CheckpointReviewRunners/stage6_5Checkpoint6_11Live";
import { runCheckpoint613LiveReview } from "./CheckpointReviewRunners/stage6_5Checkpoint6_13Live";
import { runCheckpoint675LiveReview } from "../core/stage6_75CheckpointLive";
import { EntityGraphStore } from "../core/entityGraphStore";

interface DiscordGatewayOptions {
  sessionStore?: InterfaceSessionStore;
  entityGraphStore?: EntityGraphStore;
}

interface DiscordSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  readyState: number;
}

interface DiscordGatewayPayload {
  op?: number;
  t?: string | null;
  s?: number | null;
  d?: unknown;
}

interface DiscordAuthor {
  id?: string;
  username?: string;
  bot?: boolean;
}

interface DiscordMessageCreateData {
  id?: string;
  channel_id?: string;
  guild_id?: string;
  content?: string;
  author?: DiscordAuthor;
  timestamp?: string;
}

interface DiscordGatewayBotResponse {
  url?: string;
}

interface WebSocketLikeConstructor {
  new(url: string): DiscordSocket;
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
 * Pauses execution for a bounded interval used by retry/backoff flows.
 *
 * **Why it exists:**
 * Avoids ad-hoc wait behavior by keeping retry/backoff timing in one deterministic helper.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param ms - Duration value in milliseconds.
 * @returns Promise resolving to void.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Evaluates notify reject and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the notify reject policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param code - Value for code.
 * @returns `true` when this check passes.
 */
function shouldNotifyReject(code: string): boolean {
  return code === "RATE_LIMITED" || code === "EMPTY_MESSAGE";
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

/**
 * Resolves conversation visibility from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of conversation visibility by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param guildId - Stable identifier used to reference an entity or record.
 * @returns Computed `"private" | "public"` result.
 */
function resolveConversationVisibility(guildId: string | undefined): "private" | "public" {
  return guildId ? "public" : "private";
}

/**
 * Resolves web socket constructor from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of web socket constructor by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @returns Computed `WebSocketLikeConstructor` result.
 */
function resolveWebSocketConstructor(): WebSocketLikeConstructor {
  const maybeGlobal = (globalThis as unknown as { WebSocket?: WebSocketLikeConstructor }).WebSocket;
  if (maybeGlobal) {
    return maybeGlobal;
  }

  // Fallback for Node runtimes where WebSocket is not exposed globally.
  const wsModule = require("ws") as { WebSocket?: WebSocketLikeConstructor; default?: WebSocketLikeConstructor };
  const maybeModuleCtor = wsModule.WebSocket ?? wsModule.default;
  if (!maybeModuleCtor) {
    throw new Error("No WebSocket implementation found. Install dependency `ws`.");
  }
  return maybeModuleCtor;
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
    const socketUrl = await this.resolveGatewaySocketUrl();
    const WebSocketCtor = resolveWebSocketConstructor();
    const socket = new WebSocketCtor(socketUrl);
    this.socket = socket;

    socket.onopen = () => {
      console.log("[DiscordGateway] Connected.");
    };
    socket.onmessage = (event) => {
      void this.handleSocketMessage(event.data).catch((error) => {
        console.error(`[DiscordGateway] message handling error: ${(error as Error).message}`);
      });
    };
    socket.onerror = (error) => {
      console.error(`[DiscordGateway] socket error: ${String(error)}`);
    };
    socket.onclose = () => {
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
    };
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
    await sleep(2_000);
    if (!this.running) {
      return;
    }
    try {
      await this.connect();
    } catch (error) {
      console.error(`[DiscordGateway] reconnect failed: ${(error as Error).message}`);
      await this.reconnectWithBackoff();
    }
  }

  /**
   * Resolves gateway socket url from available runtime context.
   *
   * **Why it exists:**
   * Prevents divergent selection of gateway socket url by keeping rules in one function.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   * @returns Promise resolving to string.
   */
  private async resolveGatewaySocketUrl(): Promise<string> {
    const response = await fetch(this.config.gatewayUrl, {
      method: "GET",
      headers: {
        Authorization: `Bot ${this.config.botToken}`
      }
    });
    if (!response.ok) {
      throw new Error(`Discord gateway discovery failed with status ${response.status}.`);
    }

    const payload = (await response.json()) as DiscordGatewayBotResponse;
    const baseUrl = payload.url ?? "wss://gateway.discord.gg";
    const url = new URL(baseUrl);
    url.searchParams.set("v", "10");
    url.searchParams.set("encoding", "json");
    return url.toString();
  }

  /**
   * Executes socket message as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the socket message runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param rawData - Value for raw data.
   * @returns Promise resolving to void.
   */
  private async handleSocketMessage(rawData: string): Promise<void> {
    let payload: DiscordGatewayPayload;
    try {
      payload = JSON.parse(rawData) as DiscordGatewayPayload;
    } catch {
      return;
    }

    if (typeof payload.s === "number") {
      this.sequence = payload.s;
    }

    if (payload.op === 10) {
      await this.handleHello(payload.d as { heartbeat_interval?: number } | undefined);
      return;
    }

    if (payload.op === 0 && typeof payload.t === "string") {
      await this.handleDispatch(payload.t, payload.d);
    }
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
    const heartbeatInterval = data?.heartbeat_interval ?? 41_250;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      this.sendGatewayPayload({
        op: 1,
        d: this.sequence
      });
    }, heartbeatInterval);

    this.sendGatewayPayload({
      op: 1,
      d: this.sequence
    });

    this.sendGatewayPayload({
      op: 2,
      d: {
        token: this.config.botToken,
        intents: this.config.intents,
        properties: {
          $os: "windows",
          $browser: "agentbigbrain",
          $device: "agentbigbrain"
        }
      }
    });
  }

  /**
   * Sends gateway payload through the module's deterministic transport path.
   *
   * **Why it exists:**
   * Keeps outbound transport behavior for gateway payload consistent across runtime call sites.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   *
   * @param payload - Structured input object for this operation.
   */
  private sendGatewayPayload(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== 1) {
      return;
    }
    this.socket.send(JSON.stringify(payload));
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
    if (eventType === "READY") {
      const ready = data as { user?: { id?: string } };
      this.botUserId = ready.user?.id ?? "";
      return;
    }

    if (eventType === "MESSAGE_CREATE") {
      await this.handleMessageCreate(data as DiscordMessageCreateData);
    }
  }

  /**
   * Executes message create as part of this module's control flow.
   *
   * **Why it exists:**
   * Isolates the message create runtime step so higher-level orchestration stays readable.
   *
   * **What it talks to:**
   * - Uses `parseAutonomousExecutionInput` (import `parseAutonomousExecutionInput`) from `./conversationManager`.
   * - Uses `DiscordInboundMessage` (import `DiscordInboundMessage`) from `./discordAdapter`.
   * - Uses `applyInvocationHints` (import `applyInvocationHints`) from `./invocationHints`.
   * - Uses `applyInvocationPolicy` (import `applyInvocationPolicy`) from `./invocationPolicy`.
   * - Uses `selectUserFacingSummary` (import `selectUserFacingSummary`) from `./userFacingResult`.
   *
   * @param data - Value for data.
   * @returns Promise resolving to void.
   */
  private async handleMessageCreate(data: DiscordMessageCreateData): Promise<void> {
    const messageId = data.id ?? "";
    const channelId = data.channel_id ?? "";
    const text = data.content ?? "";
    const userId = data.author?.id ?? "";
    const username = data.author?.username ?? "";
    const isBotAuthor = data.author?.bot === true;
    if (!messageId || !channelId || !text.trim() || !userId || !username) {
      return;
    }
    if (isBotAuthor || (this.botUserId && userId === this.botUserId)) {
      return;
    }
    const conversationVisibility = resolveConversationVisibility(data.guild_id);
    this.logDebug(
      `Inbound MESSAGE_CREATE id=${messageId} channel=${channelId} user=${username}(${userId}) textLength=${text.length}`
    );
    const invocation = applyInvocationPolicy(text, this.config.security.invocation);
    if (!invocation.accepted) {
      this.logDebug(
        `Invocation policy skipped id=${messageId} channel=${channelId} user=${username}(${userId}) reason=${invocation.reason}`
      );
      return;
    }

    const inbound: DiscordInboundMessage = {
      messageId,
      channelId,
      userId,
      username,
      text: invocation.normalizedText,
      authToken: this.config.security.sharedSecret,
      receivedAt: data.timestamp ?? new Date().toISOString()
    };
    const validation = this.adapter.validateMessage(inbound);
    if (!validation.accepted) {
      this.logDebug(
        `Validation rejected id=${messageId} channel=${channelId} user=${username}(${userId}) code=${validation.code}`
      );
      if (shouldNotifyReject(validation.code)) {
        const sendResult = await this.sendChannelMessage(
          channelId,
          applyInvocationHints(validation.message, this.config.security.invocation)
        );
        if (!sendResult.ok) {
          throw new Error(sendResult.errorCode ?? "DISCORD_SEND_FAILED");
        }
      }
      return;
    }

    const stopController = this.tryAbortAutonomousLoop(channelId, invocation.normalizedText);
    if (stopController) {
      const ack = await this.sendChannelMessage(
        channelId,
        applyInvocationHints("Autonomous loop cancelled.", this.config.security.invocation)
      );
      if (!ack.ok) {
        throw new Error(ack.errorCode ?? "DISCORD_SEND_FAILED");
      }
      return;
    }

    await maybeRecordInboundEntityGraphMutation(
      this.entityGraphStore,
      this.config.security.enableDynamicPulse,
      {
        provider: "discord",
        conversationId: channelId,
        eventId: messageId,
        text: invocation.normalizedText,
        observedAt: inbound.receivedAt ?? new Date().toISOString()
      },
      (error) => {
        console.warn(`[DiscordGateway] entity-graph mutation skipped: ${error.message}`);
      }
    );

    const notifier = this.createConversationNotifier(channelId);
    const reply = await this.conversationManager.handleMessage(
      {
        provider: "discord",
        conversationId: channelId,
        userId,
        username,
        conversationVisibility,
        text: invocation.normalizedText,
        receivedAt: inbound.receivedAt ?? new Date().toISOString()
      },
      async (input, receivedAt) => {
        const autonomousGoal = parseAutonomousExecutionInput(input);
        if (autonomousGoal) {
          const abortController = new AbortController();
          this.autonomousAbortControllers.set(channelId, abortController);
          /**
           * Forwards autonomous-loop progress text to the active notifier channel.
           *
           * **Why it exists:**
           * The adapter loop expects a generic progress callback; this bridge binds that callback to
           * Discord delivery with fail-safe send handling.
           *
           * **What it talks to:**
           * - Calls `notifier.send(...)` with best-effort error swallowing.
           *
           * @param msg - Progress line generated by autonomous loop callbacks.
           * @returns Promise that resolves after send attempt completes.
           */
          const progressSender = async (msg: string): Promise<void> => {
            await notifier.send(msg).catch(() => undefined);
          };
          try {
            const summary = await this.adapter.runAutonomousTask(
              autonomousGoal, receivedAt, progressSender, abortController.signal
            );
            return { summary };
          } finally {
            this.autonomousAbortControllers.delete(channelId);
          }
        }
        const runResult = await this.adapter.runTextTask(input, receivedAt);
        return {
          summary: selectUserFacingSummary(runResult, {
            showTechnicalSummary: this.config.security.showTechnicalSummary,
            showSafetyCodes: this.config.security.showSafetyCodes
          })
        };
      },
      notifier
    );

    if (!reply.trim()) {
      this.logDebug(`No reply generated for message id=${messageId}.`);
      return;
    }
    const sendResult = await this.sendChannelMessage(
      channelId,
      applyInvocationHints(reply, this.config.security.invocation)
    );
    if (!sendResult.ok) {
      throw new Error(sendResult.errorCode ?? "DISCORD_SEND_FAILED");
    }
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
   * Detects stop/cancel intent and aborts any running autonomous loop for the channel.
   */
  private tryAbortAutonomousLoop(channelId: string, text: string): boolean {
    const normalized = text.trim().toLowerCase();
    const isStopIntent =
      normalized === "/stop" ||
      normalized === "stop" ||
      normalized === "stop!" ||
      normalized === "/cancel" ||
      normalized.startsWith("/stop ") ||
      normalized.startsWith("stop ");
    if (!isStopIntent) return false;

    const controller = this.autonomousAbortControllers.get(channelId);
    if (!controller) return false;

    controller.abort();
    this.autonomousAbortControllers.delete(channelId);
    return true;
  }

  /**
   * Creates a notifier transport bound to a specific Discord channel.
   */
  private createConversationNotifier(channelId: string): ConversationNotifierTransport {
    return {
      capabilities: {
        supportsEdit: false,
        supportsNativeStreaming: false
      },
      send: async (messageText: string) =>
        this.sendChannelMessage(
          channelId,
          applyInvocationHints(messageText, this.config.security.invocation)
        )
    };
  }

  /**
   * Sends channel message through the module's deterministic transport path.
   *
   * **Why it exists:**
   * Keeps outbound transport behavior for channel message consistent across runtime call sites.
   *
   * **What it talks to:**
   * - Uses `ConversationDeliveryResult` (import `ConversationDeliveryResult`) from `./conversationManager`.
   * - Uses `buildDiscordApiUrl` (import `buildDiscordApiUrl`) from `./discordApiUrl`.
   * - Uses `parseDiscordRetryAfterMs` (import `parseDiscordRetryAfterMs`) from `./discordRateLimit`.
   *
   * @param channelId - Stable identifier used to reference an entity or record.
   * @param text - Message/text content processed by this function.
   * @returns Promise resolving to ConversationDeliveryResult.
   */
  private async sendChannelMessage(channelId: string, text: string): Promise<ConversationDeliveryResult> {
    const url = buildDiscordApiUrl(this.config.apiBaseUrl, `/channels/${channelId}/messages`);
    try {
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const response = await fetch(url.toString(), {
          method: "POST",
          headers: {
            Authorization: `Bot ${this.config.botToken}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            content: text
          })
        });

        if (response.ok) {
          this.logDebug(`Sent message to channel=${channelId} textLength=${text.length}.`);
          const payload = (await response.json().catch(() => null)) as
            | { id?: string | number }
            | null;
          const messageIdRaw = payload?.id;
          const messageId =
            typeof messageIdRaw === "string" || typeof messageIdRaw === "number"
              ? String(messageIdRaw)
              : null;
          return {
            ok: true,
            messageId,
            errorCode: null
          };
        }

        if (response.status === 429 && attempt === 1) {
          const payload = (await response.json().catch(() => null)) as unknown;
          const retryAfterMs = parseDiscordRetryAfterMs(payload);
          this.logDebug(
            `Discord rate-limited outbound send for channel=${channelId}; retrying in ${retryAfterMs}ms.`
          );
          await sleep(retryAfterMs);
          continue;
        }

        const responseText = await response.text().catch(() => "");
        return {
          ok: false,
          messageId: null,
          errorCode:
            response.status === 429
              ? "DISCORD_RATE_LIMITED"
              : `DISCORD_SEND_HTTP_${response.status}${responseText ? "_WITH_BODY" : ""}`
        };
      }
    } catch {
      return {
        ok: false,
        messageId: null,
        errorCode: "DISCORD_SEND_FAILED"
      };
    }

    return {
      ok: false,
      messageId: null,
      errorCode: "DISCORD_SEND_FAILED"
    };
  }
}
