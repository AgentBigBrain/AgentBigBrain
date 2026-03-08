/**
 * @fileoverview Implements Telegram long-poll transport that maps platform updates into secure adapter messages.
 */

import { TelegramAdapter } from "./telegramAdapter";
import { AgentPulseScheduler } from "./agentPulseScheduler";
import {
  ConversationManager
} from "./conversationManager";
import {
  type ConversationNotifierTransport
} from "./conversationRuntime/managerContracts";
import { TelegramInterfaceConfig } from "./runtimeConfig";
import { InterfaceSessionStore } from "./sessionStore";
import type { TelegramNotifierOptions } from "./transportRuntime/contracts";
import {
  deliverPreparedTransportResponse,
  handleAcceptedTransportConversation
} from "./transportRuntime/inboundDispatch";
import {
  pollTelegramUpdatesOnce,
  runTelegramPollingLoop
} from "./transportRuntime/gatewayLifecycle";
import {
  allocateNextTelegramDraftId,
  createTelegramGatewayNotifier,
  prepareTelegramUpdate,
  sendTelegramGatewayReply,
  type TelegramUpdate
} from "./transportRuntime/telegramGatewayRuntime";
import { runStage685CheckpointLiveReview } from "./CheckpointReviewRunners/stage685CheckpointReviewRunner";
import { runGatewayCheckpointReview } from "./checkpointReviewRouting";
import {
  createDynamicPulseEntityGraphGetter
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
    await runTelegramPollingLoop({
      isRunning: () => this.running,
      pollOnce: async () => this.pollOnce(),
      pollIntervalMs: this.config.pollIntervalMs,
      onPollError: (error) => {
        console.error(`[TelegramGateway] poll error: ${error.message}`);
      }
    });
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
    this.nextOffset = await pollTelegramUpdatesOnce({
      apiBaseUrl: this.config.apiBaseUrl,
      botToken: this.config.botToken,
      pollTimeoutSeconds: this.config.pollTimeoutSeconds,
      nextOffset: this.nextOffset,
      processUpdate: async (update: TelegramUpdate) => this.processUpdate(update)
    });
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
   * - Uses `prepareTelegramUpdate(...)` for provider-specific parse/validation.
   * - Uses `handleAcceptedTransportConversation(...)` for shared accepted-update dispatch.
   * - Uses `sendTelegramGatewayReply(...)` for reject/stop/final delivery.
   * 
   * @param update - The raw JSON update payload yielded by Telegram's `/getUpdates` queue.
   */
  private async processUpdate(update: TelegramUpdate): Promise<void> {
    const prepared = prepareTelegramUpdate({
      update,
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
        (text: string) => sendTelegramGatewayReply(this.config, prepared.chatId, text),
        "TELEGRAM_SEND_FAILED"
      );
      return;
    }
    if (prepared.kind === "stop") {
      await deliverPreparedTransportResponse(
        prepared.responseText,
        (text: string) => sendTelegramGatewayReply(this.config, prepared.chatId, text),
        "TELEGRAM_SEND_FAILED"
      );
      return;
    }

    const notifier = this.createConversationNotifier(prepared.chatId, {
      nativeDraftStreamingAllowed: prepared.conversationVisibility === "private"
    });
    await handleAcceptedTransportConversation({
      inbound: {
        provider: "telegram",
        conversationId: prepared.chatId,
        userId: prepared.userId,
        username: prepared.username,
        conversationVisibility: prepared.conversationVisibility,
        text: prepared.inbound.text,
        receivedAt: prepared.inbound.receivedAt ?? new Date().toISOString()
      },
      entityGraphEvent: prepared.entityGraphEvent,
      notifier,
      conversationManager: this.conversationManager,
      entityGraphStore: this.entityGraphStore,
      dynamicPulseEnabled: this.config.security.enableDynamicPulse,
      abortControllers: this.autonomousAbortControllers,
      runTextTask: async (input: string, receivedAt: string) => {
        const runResult = await this.adapter.runTextTask(input, receivedAt);
        return selectUserFacingSummary(runResult, {
          showTechnicalSummary: this.config.security.showTechnicalSummary,
          showSafetyCodes: this.config.security.showSafetyCodes
        });
      },
      runAutonomousTask: (goal, timestamp, progressSender, signal) =>
        this.adapter.runAutonomousTask(goal, timestamp, progressSender, signal),
      deliverReply: (reply: string) => sendTelegramGatewayReply(this.config, prepared.chatId, reply),
      deliveryFailureCode: "TELEGRAM_SEND_FAILED",
      onEntityGraphMutationFailure: (error) => {
        console.warn(`[TelegramGateway] entity-graph mutation skipped: ${error.message}`);
      }
    });
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
    return createTelegramGatewayNotifier(this.config, chatId, options, () => this.allocateDraftId());
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
    const allocation = allocateNextTelegramDraftId(this.nextDraftId);
    this.nextDraftId = allocation.nextDraftId;
    return allocation.draftId;
  }
}
