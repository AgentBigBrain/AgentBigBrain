/**
 * @fileoverview Implements Telegram long-poll transport that maps platform updates into secure adapter messages.
 */
import path from "node:path";
import { TelegramAdapter } from "./telegramAdapter";
import { AgentPulseScheduler } from "./agentPulseScheduler";
import { ConversationManager } from "./conversationManager";
import { type ConversationNotifierTransport } from "./conversationRuntime/managerContracts";
import { TelegramInterfaceConfig } from "./runtimeConfig";
import { InterfaceSessionStore } from "./sessionStore";
import type { TelegramNotifierOptions } from "./transportRuntime/contracts";
import { deliverPreparedTransportResponse, handleAcceptedTransportConversation } from "./transportRuntime/inboundDispatch";
import { pollTelegramUpdatesOnce, runTelegramPollingLoop } from "./transportRuntime/gatewayLifecycle";
import { abortAutonomousTransportTask } from "./transportRuntime/autonomousAbortControl";
import {
  allocateNextTelegramDraftId,
  createTelegramGatewayNotifier,
  prepareTelegramUpdate,
  sendTelegramGatewayReply,
  type TelegramUpdate
} from "./transportRuntime/telegramGatewayRuntime";
import {
  enrichAcceptedTelegramUpdateWithMedia,
  extractTelegramChatIdFromConversationKey
} from "./transportRuntime/telegramConversationDispatch";
import { runStage685CheckpointLiveReview } from "./CheckpointReviewRunners/stage685CheckpointReviewRunner";
import { runGatewayCheckpointReview } from "./checkpointReviewRouting";
import { createDynamicPulseEntityGraphGetter } from "./entityGraphRuntime";
import { renderPulseUserFacingSummaryV1 } from "./pulseUxRuntime";
import { selectUserFacingSummary } from "./userFacingResult";
import { runCheckpoint611LiveReview } from "./CheckpointReviewRunners/stage6_5Checkpoint6_11Live";
import { runCheckpoint613LiveReview } from "./CheckpointReviewRunners/stage6_5Checkpoint6_13Live";
import { runCheckpoint675LiveReview } from "../core/stage6_75CheckpointLive";
import { EntityGraphStore } from "../core/entityGraphStore";
import { MediaUnderstandingOrgan } from "../organs/mediaUnderstanding/mediaInterpretation";
import { SkillRegistryStore } from "../organs/skillRegistry/skillRegistryStore";
import type { LocalIntentModelResolver } from "../organs/languageUnderstanding/localIntentModelContracts";

interface TelegramGatewayOptions {
  sessionStore?: InterfaceSessionStore;
  entityGraphStore?: EntityGraphStore;
  mediaUnderstandingOrgan?: MediaUnderstandingOrgan;
  localIntentModelResolver?: LocalIntentModelResolver;
}

export class TelegramGateway {
  private running = false;
  private nextOffset = 0;
  private readonly sessionStore: InterfaceSessionStore;
  private readonly conversationManager: ConversationManager;
  private readonly pulseScheduler: AgentPulseScheduler;
  private readonly autonomousAbortControllers = new Map<string, AbortController>();
  private readonly entityGraphStore: EntityGraphStore;
  private readonly mediaUnderstandingOrgan?: MediaUnderstandingOrgan;
  private readonly skillRegistryStore = new SkillRegistryStore(path.resolve(process.cwd(), "runtime/skills"));
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
    this.mediaUnderstandingOrgan = options.mediaUnderstandingOrgan;
    this.conversationManager = new ConversationManager(this.sessionStore, {
      ackDelayMs: this.config.security.ackDelayMs,
      showCompletionPrefix: this.config.security.showCompletionPrefix,
      followUpOverridePath: this.config.security.followUpOverridePath,
      pulseLexicalOverridePath: this.config.security.pulseLexicalOverridePath,
      allowAutonomousViaInterface: this.config.security.allowAutonomousViaInterface
    }, {
      interpretConversationIntent: async (input, recentTurns, pulseRuleContext) =>
        this.adapter.interpretConversationIntent(input, recentTurns, pulseRuleContext),
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
        provider: "telegram",
        sessionStore: this.sessionStore,
        evaluateAgentPulse: async (request) => this.adapter.evaluateAgentPulse(request),
        enqueueSystemJob: async (session, systemInput, receivedAt) => {
          const chatId = extractTelegramChatIdFromConversationKey(session.conversationId);
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
      mediaConfig: this.config.media,
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

    const enrichedPrepared = await enrichAcceptedTelegramUpdateWithMedia({
      prepared,
      config: this.config,
      mediaUnderstandingOrgan: this.mediaUnderstandingOrgan
    });
    if (enrichedPrepared.kind === "rejected") {
      await deliverPreparedTransportResponse(
        enrichedPrepared.responseText,
        (text: string) => sendTelegramGatewayReply(this.config, enrichedPrepared.chatId, text),
        "TELEGRAM_SEND_FAILED"
      );
      return;
    }

    const notifier = this.createConversationNotifier(enrichedPrepared.chatId, {
      nativeDraftStreamingAllowed: enrichedPrepared.conversationVisibility === "private"
    });
    await handleAcceptedTransportConversation({
      inbound: {
        provider: "telegram",
        conversationId: enrichedPrepared.chatId,
        userId: enrichedPrepared.userId,
        username: enrichedPrepared.username,
        conversationVisibility: enrichedPrepared.conversationVisibility,
        text: enrichedPrepared.inbound.text,
        media: enrichedPrepared.inbound.media ?? null,
        receivedAt: enrichedPrepared.inbound.receivedAt ?? new Date().toISOString()
      },
      entityGraphEvent: enrichedPrepared.entityGraphEvent,
      notifier,
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
      deliverReply: (reply: string) => sendTelegramGatewayReply(this.config, enrichedPrepared.chatId, reply),
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
