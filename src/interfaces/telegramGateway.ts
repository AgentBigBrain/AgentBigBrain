/**
 * @fileoverview Implements Telegram long-poll transport that maps platform updates into secure adapter messages.
 */

import { TelegramAdapter, TelegramInboundMessage } from "./telegramAdapter";
import { AgentPulseScheduler } from "./agentPulseScheduler";
import {
  ConversationDeliveryResult,
  ConversationManager,
  ConversationNotifierTransport,
  parseAutonomousExecutionInput
} from "./conversationManager";
import { applyInvocationHints } from "./invocationHints";
import { applyInvocationPolicy } from "./invocationPolicy";
import { TelegramInterfaceConfig } from "./runtimeConfig";
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

interface TelegramGatewayOptions {
  sessionStore?: InterfaceSessionStore;
  entityGraphStore?: EntityGraphStore;
}

interface TelegramUpdateMessage {
  text?: string;
  chat?: { id?: number | string; type?: string };
  from?: { id?: number | string; username?: string };
  date?: number;
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramUpdateMessage;
}

interface TelegramGetUpdatesResponse {
  ok?: boolean;
  result?: TelegramUpdate[];
}

interface TelegramNotifierOptions {
  nativeDraftStreamingAllowed: boolean;
}

/**
 * Converts values into string id form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for string id deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function asStringId(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  return "";
}

/**
 * Converts a normalized chat identifier into Telegram API-compatible chat-id payload.
 *
 * **Why it exists:**
 * Telegram methods accept numeric chat identifiers for private chats; this helper preserves numeric
 * IDs when possible while keeping deterministic fallback to string identifiers.
 *
 * **What it talks to:**
 * - Uses local numeric parsing only.
 *
 * @param chatId - Normalized chat identifier from inbound update processing.
 * @returns Numeric chat ID when safely parseable, otherwise the original string.
 */
function toTelegramChatIdValue(chatId: string): number | string {
  const parsed = Number(chatId);
  if (Number.isSafeInteger(parsed)) {
    return parsed;
  }
  return chatId;
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
 * Derives chat id from conversation key from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for chat id from conversation key in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param conversationKey - Lookup key or map field identifier.
 * @returns Computed `string | null` result.
 */
function extractChatIdFromConversationKey(conversationKey: string): string | null {
  const segments = conversationKey.split(":");
  if (segments.length < 3 || segments[0] !== "telegram") {
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
 * @param chatType - Value for chat type.
 * @param chatId - Stable identifier used to reference an entity or record.
 * @param userId - Stable identifier used to reference an entity or record.
 * @returns Computed `"private" | "public" | "unknown"` result.
 */
function resolveConversationVisibility(
  chatType: string | undefined,
  chatId: string,
  userId: string
): "private" | "public" | "unknown" {
  const normalizedType = (chatType ?? "").trim().toLowerCase();
  if (normalizedType === "private") {
    return "private";
  }
  if (normalizedType === "group" || normalizedType === "supergroup" || normalizedType === "channel") {
    return "public";
  }

  // Heuristic fallback for older payloads that omitted chat.type.
  if (chatId === userId) {
    return "private";
  }
  return "unknown";
}

export class TelegramGateway {
  private running = false;
  private nextOffset = 0;
  private readonly sessionStore: InterfaceSessionStore;
  private readonly conversationManager: ConversationManager;
  private readonly pulseScheduler: AgentPulseScheduler;
  private readonly autonomousAbortControllers = new Map<string, AbortController>();
  private readonly entityGraphStore: EntityGraphStore;
  private nextDraftId = 1;

  /**
   * Initializes `TelegramGateway` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Uses `EntityGraphStore` (import `EntityGraphStore`) from `../core/entityGraphStore`.
   * - Uses `runCheckpoint675LiveReview` (import `runCheckpoint675LiveReview`) from `../core/stage6_75CheckpointLive`.
   * - Uses `AgentPulseScheduler` (import `AgentPulseScheduler`) from `./agentPulseScheduler`.
   * - Uses `runCheckpoint611LiveReview` (import `runCheckpoint611LiveReview`) from `./CheckpointReviewRunners/stage6_5Checkpoint6_11Live`.
   * - Uses `runCheckpoint613LiveReview` (import `runCheckpoint613LiveReview`) from `./CheckpointReviewRunners/stage6_5Checkpoint6_13Live`.
   * - Uses `runStage685CheckpointLiveReview` (import `runStage685CheckpointLiveReview`) from `./CheckpointReviewRunners/stage685CheckpointReviewRunner`.
   * - Additional imported collaborators are also used in this function body.
   *
   * @param adapter - Value for adapter.
   * @param config - Configuration or policy settings applied here.
   * @param options - Optional tuning knobs for this operation.
   */
  constructor(
    private readonly adapter: TelegramAdapter,
    private readonly config: TelegramInterfaceConfig,
    options: TelegramGatewayOptions = {}
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
        provider: "telegram",
        sessionStore: this.sessionStore,
        evaluateAgentPulse: async (request) => this.adapter.evaluateAgentPulse(request),
        enqueueSystemJob: async (session, systemInput, receivedAt) => {
          const chatId = extractChatIdFromConversationKey(session.conversationId);
          if (!chatId) {
            return false;
          }
          const notifier = this.createConversationNotifier(chatId, {
            nativeDraftStreamingAllowed: session.conversationVisibility === "private"
          });
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
   * Ignites the Telegram gateway and begins polling for inbound messages.
   * 
   * **Why it exists:**  
   * Acts as the primary lifecycle hook for the Telegram transport. Binds the autonomous system 
   * layer to the internet, allowing humans to invoke routines securely.
   * 
   * **What it talks to:**  
   * - Starts the `AgentPulseScheduler` to wake up background thoughts securely.
   * - Triggers continuous asynchronous loops via `pollOnce()`.
   */
  async start(): Promise<void> {
    this.running = true;
    this.pulseScheduler.start();
    while (this.running) {
      try {
        await this.pollOnce();
      } catch (error) {
        console.error(`[TelegramGateway] poll error: ${(error as Error).message}`);
      }

      if (this.running) {
        await sleep(this.config.pollIntervalMs);
      }
    }
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
    this.running = false;
    this.pulseScheduler.stop();
  }

  /**
   * Implements poll once behavior used by `telegramGateway`.
   *
   * **Why it exists:**
   * Keeps `poll once` logic in one place to reduce behavior drift.
   *
   * **What it talks to:**
   * - Uses local constants/helpers within this module.
   * @returns Promise resolving to void.
   */
  private async pollOnce(): Promise<void> {
    const url = new URL(`/bot${this.config.botToken}/getUpdates`, this.config.apiBaseUrl);
    url.searchParams.set("timeout", String(this.config.pollTimeoutSeconds));
    if (this.nextOffset > 0) {
      url.searchParams.set("offset", String(this.nextOffset));
    }

    const response = await fetch(url.toString(), { method: "GET" });
    if (!response.ok) {
      throw new Error(`getUpdates failed with status ${response.status}.`);
    }

    const payload = (await response.json()) as TelegramGetUpdatesResponse;
    if (!payload.ok || !Array.isArray(payload.result)) {
      return;
    }

    for (const update of payload.result) {
      if (typeof update.update_id === "number") {
        this.nextOffset = Math.max(this.nextOffset, update.update_id + 1);
      }
      await this.processUpdate(update);
    }
  }

  /**
   * Processes a single inbound payload from the Telegram proxy API.
   * 
   * **Why it exists:**  
   * Transforms raw API payloads into strongly-typed `TelegramInboundMessage` objects, evaluates 
   * cryptographic validation policies, and routes accepted intents directly to the engine's 
   * `ConversationManager`. Acts as the first line of defense physically shielding the brain.
   * 
   * **What it talks to:**  
   * - Parses `TelegramUpdate` objects out of the poll queue.
   * - Calls `applyInvocationPolicy` & `validateMessage` to strictly filter bad actors.
   * - Plumbs verified inputs directly to the `ConversationManager.handleMessage` pipeline.
   * 
   * @param update - The raw JSON update payload yielded by Telegram's `/getUpdates` queue.
   */
  private async processUpdate(update: TelegramUpdate): Promise<void> {
    if (typeof update.update_id !== "number") {
      return;
    }

    const message = update.message;
    const text = message?.text ?? "";
    const chatId = asStringId(message?.chat?.id);
    const userId = asStringId(message?.from?.id);
    const username = message?.from?.username ?? "";
    if (!text.trim() || !chatId || !userId || !username) {
      return;
    }
    const conversationVisibility = resolveConversationVisibility(
      message?.chat?.type,
      chatId,
      userId
    );

    const invocation = applyInvocationPolicy(text, this.config.security.invocation);
    if (!invocation.accepted) {
      return;
    }

    const inbound: TelegramInboundMessage = {
      updateId: update.update_id,
      chatId,
      userId,
      username,
      text: invocation.normalizedText,
      authToken: this.config.security.sharedSecret,
      receivedAt: new Date((message?.date ?? Math.floor(Date.now() / 1000)) * 1000).toISOString()
    };

    const validation = this.adapter.validateMessage(inbound);
    if (!validation.accepted) {
      if (shouldNotifyReject(validation.code)) {
        const sendResult = await this.sendReply(
          chatId,
          applyInvocationHints(validation.message, this.config.security.invocation)
        );
        if (!sendResult.ok) {
          throw new Error(sendResult.errorCode ?? "TELEGRAM_SEND_FAILED");
        }
      }
      return;
    }

    const stopController = this.tryAbortAutonomousLoop(chatId, invocation.normalizedText);
    if (stopController) {
      const ack = await this.sendReply(
        chatId,
        applyInvocationHints("Autonomous loop cancelled.", this.config.security.invocation)
      );
      if (!ack.ok) {
        throw new Error(ack.errorCode ?? "TELEGRAM_SEND_FAILED");
      }
      return;
    }

    await maybeRecordInboundEntityGraphMutation(
      this.entityGraphStore,
      this.config.security.enableDynamicPulse,
      {
        provider: "telegram",
        conversationId: chatId,
        eventId: String(update.update_id),
        text: invocation.normalizedText,
        observedAt: inbound.receivedAt ?? new Date().toISOString()
      },
      (error) => {
        console.warn(`[TelegramGateway] entity-graph mutation skipped: ${error.message}`);
      }
    );

    const notifier = this.createConversationNotifier(chatId, {
      nativeDraftStreamingAllowed: conversationVisibility === "private"
    });
    const reply = await this.conversationManager.handleMessage(
      {
        provider: "telegram",
        conversationId: chatId,
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
          this.autonomousAbortControllers.set(chatId, abortController);
          /**
           * Bridges autonomous-loop progress callbacks into Telegram message delivery.
           *
           * **Why it exists:**
           * The autonomous adapter expects a generic progress callback. This scoped bridge binds that
           * callback to the current notifier while keeping send failures non-fatal for loop execution.
           *
           * **What it talks to:**
           * - Calls `notifier.send(...)` with best-effort failure swallowing.
           *
           * @param msg - Progress text emitted by autonomous loop callbacks.
           * @returns Promise that resolves after the send attempt completes.
           */
          const progressSender = async (msg: string): Promise<void> => {
            if (
              notifier.capabilities.supportsNativeStreaming &&
              typeof notifier.stream === "function"
            ) {
              await notifier.stream(msg).catch(() => undefined);
              return;
            }
            await notifier.send(msg).catch(() => undefined);
          };
          try {
            const summary = await this.adapter.runAutonomousTask(
              autonomousGoal, receivedAt, progressSender, abortController.signal
            );
            return { summary };
          } finally {
            this.autonomousAbortControllers.delete(chatId);
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
      return;
    }
    const sendResult = await this.sendReply(
      chatId,
      applyInvocationHints(reply, this.config.security.invocation)
    );
    if (!sendResult.ok) {
      throw new Error(sendResult.errorCode ?? "TELEGRAM_SEND_FAILED");
    }
  }

  /**
   * Detects stop/cancel intent in the user message and aborts any running
   * autonomous loop for the given chat.  Returns `true` if an abort was triggered.
   */
  private tryAbortAutonomousLoop(chatId: string, text: string): boolean {
    const normalized = text.trim().toLowerCase();
    const isStopIntent =
      normalized === "/stop" ||
      normalized === "stop" ||
      normalized === "stop!" ||
      normalized === "/cancel" ||
      normalized.startsWith("/stop ") ||
      normalized.startsWith("stop ");
    if (!isStopIntent) return false;

    const controller = this.autonomousAbortControllers.get(chatId);
    if (!controller) return false;

    controller.abort();
    this.autonomousAbortControllers.delete(chatId);
    return true;
  }

  /**
   * Creates a notifier transport bound to a specific Telegram chat.
   *
   * **Why it exists:**
   * Conversation workers require a transport contract that can support standard send/edit delivery
   * and optional Telegram native draft-stream updates.
   *
   * **What it talks to:**
   * - Uses `sendReply` and `editReply` for persisted message delivery.
   * - Uses `sendDraftUpdate` when native draft streaming is enabled for this notifier context.
   *
   * @param chatId - Target Telegram chat identifier.
   * @param options - Per-notifier transport capability options.
   * @returns Conversation notifier transport bound to this chat.
   */
  private createConversationNotifier(
    chatId: string,
    options: TelegramNotifierOptions
  ): ConversationNotifierTransport {
    const useNativeDraftStreaming =
      this.config.streamingTransportMode === "native_draft" &&
      this.config.nativeDraftStreaming &&
      options.nativeDraftStreamingAllowed;
    const draftId = useNativeDraftStreaming ? this.allocateDraftId() : null;

    return {
      capabilities: {
        supportsEdit: !useNativeDraftStreaming,
        supportsNativeStreaming: useNativeDraftStreaming
      },
      send: async (messageText: string) =>
        this.sendReply(chatId, applyInvocationHints(messageText, this.config.security.invocation)),
      edit: useNativeDraftStreaming
        ? undefined
        : async (messageId: string, messageText: string) =>
          this.editReply(
            chatId,
            messageId,
            applyInvocationHints(messageText, this.config.security.invocation)
          ),
      stream: useNativeDraftStreaming && draftId !== null
        ? async (messageText: string) =>
          this.sendDraftUpdate(
            chatId,
            draftId,
            applyInvocationHints(messageText, this.config.security.invocation)
          )
        : undefined
    };
  }

  /**
   * Allocates a bounded deterministic draft identifier for Telegram native streaming updates.
   *
   * **Why it exists:**
   * `sendMessageDraft` requires a non-zero integer `draft_id`; reuse of the same ID keeps draft
   * changes animated while avoiding unbounded identifier growth.
   *
   * **What it talks to:**
   * - Uses in-memory `nextDraftId` counter state.
   *
   * @returns Non-zero draft identifier suitable for `sendMessageDraft`.
   */
  private allocateDraftId(): number {
    const current = this.nextDraftId;
    const next = current + 1;
    this.nextDraftId = next > 2_147_483_647 ? 1 : next;
    return current;
  }

  /**
   * Streams partial text updates through Telegram native draft transport.
   *
   * **Why it exists:**
   * Native draft updates provide smoother in-progress status rendering than repeated persistent
   * message edits while preserving fail-closed fallback to normal final-message delivery.
   *
   * **What it talks to:**
   * - Calls Telegram `sendMessageDraft` API endpoint.
   *
   * @param chatId - Target Telegram private-chat identifier.
   * @param draftId - Stable non-zero draft identifier for the current stream.
   * @param text - Draft text update to display to the user.
   * @returns Delivery result describing transport success/failure.
   */
  private async sendDraftUpdate(
    chatId: string,
    draftId: number,
    text: string
  ): Promise<ConversationDeliveryResult> {
    const normalizedText = text.trim();
    if (!normalizedText) {
      return {
        ok: false,
        messageId: null,
        errorCode: "EMPTY_MESSAGE"
      };
    }

    const url = new URL(`/bot${this.config.botToken}/sendMessageDraft`, this.config.apiBaseUrl);
    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: toTelegramChatIdValue(chatId),
          draft_id: draftId,
          text: normalizedText
        })
      });

      if (!response.ok) {
        const errorCode = response.status === 429
          ? "TELEGRAM_RATE_LIMITED"
          : `TELEGRAM_DRAFT_HTTP_${response.status}`;
        return {
          ok: false,
          messageId: null,
          errorCode
        };
      }

      return {
        ok: true,
        messageId: null,
        errorCode: null
      };
    } catch {
      return {
        ok: false,
        messageId: null,
        errorCode: "TELEGRAM_DRAFT_FAILED"
      };
    }
  }

  /**
   * Sends reply through the module's deterministic transport path.
   *
   * **Why it exists:**
   * Keeps outbound transport behavior for reply consistent across runtime call sites.
   *
   * **What it talks to:**
   * - Uses `ConversationDeliveryResult` (import `ConversationDeliveryResult`) from `./conversationManager`.
   *
   * @param chatId - Stable identifier used to reference an entity or record.
   * @param text - Message/text content processed by this function.
   * @returns Promise resolving to ConversationDeliveryResult.
   */
  private async sendReply(chatId: string, text: string): Promise<ConversationDeliveryResult> {
    const url = new URL(`/bot${this.config.botToken}/sendMessage`, this.config.apiBaseUrl);
    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: toTelegramChatIdValue(chatId),
          text
        })
      });

      if (!response.ok) {
        const errorCode = response.status === 429
          ? "TELEGRAM_RATE_LIMITED"
          : `TELEGRAM_SEND_HTTP_${response.status}`;
        return {
          ok: false,
          messageId: null,
          errorCode
        };
      }

      const payload = (await response.json().catch(() => null)) as
        | { result?: { message_id?: string | number } }
        | null;
      const messageIdRaw = payload?.result?.message_id;
      const messageId = typeof messageIdRaw === "number" || typeof messageIdRaw === "string"
        ? String(messageIdRaw)
        : null;
      return {
        ok: true,
        messageId,
        errorCode: null
      };
    } catch {
      return {
        ok: false,
        messageId: null,
        errorCode: "TELEGRAM_SEND_FAILED"
      };
    }
  }

  /**
   * Implements edit reply behavior used by `telegramGateway`.
   *
   * **Why it exists:**
   * Keeps `edit reply` behavior centralized so collaborating call sites stay consistent.
   *
   * **What it talks to:**
   * - Uses `ConversationDeliveryResult` (import `ConversationDeliveryResult`) from `./conversationManager`.
   *
   * @param chatId - Stable identifier used to reference an entity or record.
   * @param messageId - Stable identifier used to reference an entity or record.
   * @param text - Message/text content processed by this function.
   * @returns Promise resolving to ConversationDeliveryResult.
   */
  private async editReply(
    chatId: string,
    messageId: string,
    text: string
  ): Promise<ConversationDeliveryResult> {
    const url = new URL(`/bot${this.config.botToken}/editMessageText`, this.config.apiBaseUrl);
    try {
      const response = await fetch(url.toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: toTelegramChatIdValue(chatId),
          message_id: messageId,
          text
        })
      });
      if (!response.ok) {
        const errorCode = response.status === 429
          ? "TELEGRAM_RATE_LIMITED"
          : `TELEGRAM_EDIT_HTTP_${response.status}`;
        return {
          ok: false,
          messageId: null,
          errorCode
        };
      }
      return {
        ok: true,
        messageId,
        errorCode: null
      };
    } catch {
      return {
        ok: false,
        messageId: null,
        errorCode: "TELEGRAM_EDIT_FAILED"
      };
    }
  }
}
