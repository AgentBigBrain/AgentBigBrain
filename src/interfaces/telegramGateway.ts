/** @fileoverview Implements Telegram long-poll transport that maps platform updates into secure adapter messages. */
import path from "node:path";
import { TelegramAdapter } from "./telegramAdapter";
import { AgentPulseScheduler } from "./agentPulseScheduler";
import { ConversationManager } from "./conversationManager";
import { type ConversationNotifierTransport } from "./conversationRuntime/managerContracts";
import { TelegramInterfaceConfig } from "./runtimeConfig";
import { InterfaceSessionStore } from "./sessionStore";
import type { TelegramNotifierOptions, TelegramOutboundDeliveryObserver } from "./transportRuntime/contracts";
import { deliverPreparedTransportResponse, handleAcceptedTransportConversation } from "./transportRuntime/inboundDispatch";
import { pollTelegramUpdatesOnce, runTelegramPollingLoop } from "./transportRuntime/gatewayLifecycle";
import { abortAutonomousTransportTask } from "./transportRuntime/autonomousAbortControl";
import { prepareTelegramUpdate, type TelegramUpdate } from "./transportRuntime/telegramGatewayRuntime";
import { allocateNextTelegramDraftId, createTelegramGatewayNotifier } from "./transportRuntime/telegramGatewayNotifier";
import { sendObservedTelegramGatewayReply } from "./transportRuntime/telegramGatewayObservation";
import { buildTelegramDirectReplyObservation, buildTelegramNotifierBaseTrace, buildTelegramTransportResponseObservation } from "./transportRuntime/telegramOutboundDeliveryTracing";
import { enrichAcceptedTelegramUpdateWithMedia, extractTelegramChatIdFromConversationKey } from "./transportRuntime/telegramConversationDispatch";
import { runStage685CheckpointLiveReview } from "./CheckpointReviewRunners/stage685CheckpointReviewRunner";
import { runGatewayCheckpointReview } from "./checkpointReviewRouting";
import { createDynamicPulseEntityGraphGetter } from "./entityGraphRuntime";
import {
  renderPulseUserFacingSummaryV1,
  shouldSuppressPulseUserFacingDeliveryV1
} from "./pulseUxRuntime";
import { selectUserFacingSummary } from "./userFacingResult";
import { runGatewaySessionAutonomousTask, runGatewaySessionTextTask } from "./gatewaySessionExecution";
import { runCheckpoint611LiveReview } from "./CheckpointReviewRunners/stage6_5Checkpoint6_11Live";
import { runCheckpoint613LiveReview } from "./CheckpointReviewRunners/stage6_5Checkpoint6_13Live";
import { runCheckpoint675LiveReview } from "../core/stage6_75CheckpointLive";
import { EntityGraphStore } from "../core/entityGraphStore";
import { MediaArtifactStore } from "../core/mediaArtifactStore";
import { buildTelegramCapabilitySummary } from "./conversationRuntime/capabilityIntrospection";
import { MediaUnderstandingOrgan } from "../organs/mediaUnderstanding/mediaInterpretation";
import { SkillRegistryStore } from "../organs/skillRegistry/skillRegistryStore";
import type { AutonomyBoundaryInterpretationResolver, ContinuationInterpretationResolver, ContextualFollowupInterpretationResolver, ContextualReferenceInterpretationResolver, EntityDomainHintInterpretationResolver, EntityReferenceInterpretationResolver, EntityTypeInterpretationResolver, HandoffControlInterpretationResolver, IdentityInterpretationResolver, LocalIntentModelResolver, StatusRecallBoundaryInterpretationResolver, TopicKeyInterpretationResolver } from "../organs/languageUnderstanding/localIntentModelContracts";
import type { ProposalReplyInterpretationResolver } from "../organs/languageUnderstanding/localIntentModelProposalReplyContracts";
import { InterfaceBrainRegistry } from "./interfaceBrainRegistry"; export type { TelegramOutboundDeliveryObservation } from "./transportRuntime/contracts"; interface TelegramGatewayOptions { sessionStore?: InterfaceSessionStore; entityGraphStore?: EntityGraphStore; mediaArtifactStore?: MediaArtifactStore; mediaUnderstandingOrgan?: MediaUnderstandingOrgan; localIntentModelResolver?: LocalIntentModelResolver; autonomyBoundaryInterpretationResolver?: AutonomyBoundaryInterpretationResolver; statusRecallBoundaryInterpretationResolver?: StatusRecallBoundaryInterpretationResolver; continuationInterpretationResolver?: ContinuationInterpretationResolver; contextualFollowupInterpretationResolver?: ContextualFollowupInterpretationResolver; contextualReferenceInterpretationResolver?: ContextualReferenceInterpretationResolver; entityDomainHintInterpretationResolver?: EntityDomainHintInterpretationResolver; entityReferenceInterpretationResolver?: EntityReferenceInterpretationResolver; entityTypeInterpretationResolver?: EntityTypeInterpretationResolver; handoffControlInterpretationResolver?: HandoffControlInterpretationResolver; identityInterpretationResolver?: IdentityInterpretationResolver; proposalReplyInterpretationResolver?: ProposalReplyInterpretationResolver; topicKeyInterpretationResolver?: TopicKeyInterpretationResolver; brainRegistry?: InterfaceBrainRegistry; onOutboundDelivery?: TelegramOutboundDeliveryObserver; }
export class TelegramGateway {
  private running = false; private nextOffset = 0; private nextOutboundDeliverySequence = 1;
  private readonly sessionStore: InterfaceSessionStore;
  private readonly conversationManager: ConversationManager;
  private readonly pulseScheduler: AgentPulseScheduler;
  private readonly autonomousAbortControllers = new Map<string, AbortController>();
  private readonly entityGraphStore: EntityGraphStore;
  private readonly mediaArtifactStore?: MediaArtifactStore; private readonly mediaUnderstandingOrgan?: MediaUnderstandingOrgan;
  private readonly onOutboundDelivery?: TelegramOutboundDeliveryObserver;
  private readonly entityDomainHintInterpretationResolver?: EntityDomainHintInterpretationResolver;
  private readonly entityTypeInterpretationResolver?: EntityTypeInterpretationResolver;
  private readonly skillRegistryStore = new SkillRegistryStore(path.resolve(process.cwd(), "runtime/skills"));
  private readonly brainRegistry: InterfaceBrainRegistry;
  private nextDraftId = 1;
  /**
   * Initializes the TelegramGateway instance with its runtime dependencies.
   *
   * **Why it exists:**
   * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
   *
   * **What it talks to:**
   * - Uses `EntityGraphStore` (import `EntityGraphStore`) from `../core/entityGraphStore`.
   * - Uses `runCheckpoint675LiveReview` (import `runCheckpoint675LiveReview`) from `../core/stage6_75CheckpointLive`.
   * - Uses `AgentPulseScheduler` (import `AgentPulseScheduler`) from `./agentPulseScheduler`.
   * - Uses `runGatewayCheckpointReview` (import `runGatewayCheckpointReview`) from `./checkpointReviewRouting`.
   * - Uses `runCheckpoint611LiveReview` (import `runCheckpoint611LiveReview`) from `./CheckpointReviewRunners/stage6_5Checkpoint6_11Live`.
   * - Uses `runCheckpoint613LiveReview` (import `runCheckpoint613LiveReview`) from `./CheckpointReviewRunners/stage6_5Checkpoint6_13Live`.
   * - Uses `runStage685CheckpointLiveReview` (import `runStage685CheckpointLiveReview`) from `./CheckpointReviewRunners/stage685CheckpointReviewRunner`.
   * - Uses `ConversationManager` (import `ConversationManager`) from `./conversationManager`.
   * - Uses `buildTelegramCapabilitySummary` (import `buildTelegramCapabilitySummary`) from `./conversationRuntime/capabilityIntrospection`.
   * - Uses `createDynamicPulseEntityGraphGetter` (import `createDynamicPulseEntityGraphGetter`) from `./entityGraphRuntime`.
   * - Uses `InterfaceBrainRegistry` (import `InterfaceBrainRegistry`) from `./interfaceBrainRegistry`.
   * - Uses `renderPulseUserFacingSummaryV1` (import `renderPulseUserFacingSummaryV1`) from `./pulseUxRuntime`.
   * - Uses `shouldSuppressPulseUserFacingDeliveryV1` (import `shouldSuppressPulseUserFacingDeliveryV1`) from `./pulseUxRuntime`.
   * - Uses `TelegramInterfaceConfig` (import `TelegramInterfaceConfig`) from `./runtimeConfig`.
   * - Uses `InterfaceSessionStore` (import `InterfaceSessionStore`) from `./sessionStore`.
   * - Uses `TelegramAdapter` (import `TelegramAdapter`) from `./telegramAdapter`.
   * - Uses `abortAutonomousTransportTask` (import `abortAutonomousTransportTask`) from `./transportRuntime/autonomousAbortControl`.
   * - Uses `extractTelegramChatIdFromConversationKey` (import `extractTelegramChatIdFromConversationKey`) from `./transportRuntime/telegramConversationDispatch`.
   * - Uses `selectUserFacingSummary` (import `selectUserFacingSummary`) from `./userFacingResult`.
   * @param adapter - Input consumed by this helper.
   * @param config - Input consumed by this helper.
   * @param options - Input consumed by this helper.
   */
  constructor(private readonly adapter: TelegramAdapter, private readonly config: TelegramInterfaceConfig, options: TelegramGatewayOptions = {}) {
    const listManagedProcessSnapshots = typeof this.adapter.listManagedProcessSnapshots === "function" ? async () => this.adapter.listManagedProcessSnapshots() : undefined;
    const listBrowserSessionSnapshots = typeof this.adapter.listBrowserSessionSnapshots === "function" ? async () => this.adapter.listBrowserSessionSnapshots() : undefined;
    this.sessionStore = options.sessionStore ?? new InterfaceSessionStore();
    this.entityGraphStore = options.entityGraphStore ?? new EntityGraphStore();
    this.mediaArtifactStore = options.mediaArtifactStore;
    this.mediaUnderstandingOrgan = options.mediaUnderstandingOrgan;
    this.onOutboundDelivery = options.onOutboundDelivery;
    this.entityDomainHintInterpretationResolver = options.entityDomainHintInterpretationResolver;
    this.entityTypeInterpretationResolver = options.entityTypeInterpretationResolver;
    this.brainRegistry = options.brainRegistry ?? new InterfaceBrainRegistry();
    this.conversationManager = new ConversationManager(this.sessionStore, {
      ackDelayMs: this.config.security.ackDelayMs,
      showCompletionPrefix: this.config.security.showCompletionPrefix,
      followUpOverridePath: this.config.security.followUpOverridePath,
      pulseLexicalOverridePath: this.config.security.pulseLexicalOverridePath,
      allowAutonomousViaInterface: this.config.security.allowAutonomousViaInterface
    }, {
      interpretConversationIntent: async (input, recentTurns, pulseRuleContext) =>
        this.adapter.interpretConversationIntent(input, recentTurns, pulseRuleContext),
      runDirectConversationTurn: async (input, receivedAt, session) => {
        return this.brainRegistry.runDirectConversationForSession(session ?? null, input, receivedAt);
      },
      queryContinuityEpisodes: async (request) => {
        const graph = await this.entityGraphStore.getGraph();
        return this.adapter.queryContinuityEpisodes(graph, request);
      },
      queryContinuityFacts: async (request) =>
        this.adapter.queryContinuityFacts(await this.entityGraphStore.getGraph(), request),
      openContinuityReadSession: async () =>
        this.adapter.openContinuityReadSession(await this.entityGraphStore.getGraph()),
      rememberConversationProfileInput: async (userInput, receivedAt) =>
        this.adapter.rememberConversationProfileInput(userInput, receivedAt),
      reviewConversationMemory: async (request) => this.adapter.reviewConversationMemory(
        request.reviewTaskId, request.query, request.nowIso, request.maxEpisodes
      ),
      reviewConversationMemoryFacts: async (request) => this.adapter.reviewConversationMemoryFacts(
        request.reviewTaskId, request.query, request.nowIso, request.maxFacts ?? 5
      ),
      resolveConversationMemoryEpisode: async (request) => this.adapter.resolveConversationMemoryEpisode(
        request.episodeId, request.sourceTaskId, request.sourceText, request.nowIso, request.note
      ),
      markConversationMemoryEpisodeWrong: async (request) => this.adapter.markConversationMemoryEpisodeWrong(
        request.episodeId, request.sourceTaskId, request.sourceText, request.nowIso, request.note
      ),
      forgetConversationMemoryEpisode: async (request) => this.adapter.forgetConversationMemoryEpisode(
        request.episodeId, request.sourceTaskId, request.sourceText, request.nowIso
      ),
      correctConversationMemoryFact: async (request) => this.adapter.correctConversationMemoryFact(
        request.factId, request.replacementValue, request.sourceTaskId, request.sourceText, request.nowIso, request.note
      ),
      forgetConversationMemoryFact: async (request) => this.adapter.forgetConversationMemoryFact(
        request.factId, request.sourceTaskId, request.sourceText, request.nowIso
      ),
      localIntentModelResolver: options.localIntentModelResolver,
      autonomyBoundaryInterpretationResolver: options.autonomyBoundaryInterpretationResolver,
      statusRecallBoundaryInterpretationResolver: options.statusRecallBoundaryInterpretationResolver,
      continuationInterpretationResolver: options.continuationInterpretationResolver,
      contextualFollowupInterpretationResolver: options.contextualFollowupInterpretationResolver,
      contextualReferenceInterpretationResolver: options.contextualReferenceInterpretationResolver,
      entityReferenceInterpretationResolver: options.entityReferenceInterpretationResolver,
      handoffControlInterpretationResolver: options.handoffControlInterpretationResolver,
      identityInterpretationResolver: options.identityInterpretationResolver,
      proposalReplyInterpretationResolver: options.proposalReplyInterpretationResolver,
      topicKeyInterpretationResolver: options.topicKeyInterpretationResolver,
      getEntityGraph: async () => this.entityGraphStore.getGraph(),
      reconcileEntityAliasCandidate: async (request) => { const result = await this.entityGraphStore.reconcileAliasCandidate(request); return { acceptedAlias: result.acceptedAlias, rejectionReason: result.rejectionReason }; },
      listAvailableSkills: async () => this.skillRegistryStore.listAvailableSkills(),
      describeRuntimeCapabilities: async () => buildTelegramCapabilitySummary(this.config),
      listManagedProcessSnapshots,
      listBrowserSessionSnapshots,
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
          }, {
            sessionKey: session.conversationId
          });
          return this.conversationManager.enqueueSystemJob(
            session.conversationId,
            systemInput,
            receivedAt,
            async (input, timestamp) => {
              const execution = await this.brainRegistry.runTaskForSession(session, input, timestamp);
              const baseSummary = execution.taskRunResult
                ? selectUserFacingSummary(execution.taskRunResult, {
                    showTechnicalSummary: false,
                    showSafetyCodes: false
                  })
                : execution.summary;
              return {
                summary: renderPulseUserFacingSummaryV1(session, systemInput, baseSummary, timestamp),
                taskRunResult: execution.taskRunResult ?? null,
                suppressUserDelivery: shouldSuppressPulseUserFacingDeliveryV1(
                  systemInput,
                  baseSummary
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

  /** Starts Telegram polling and pulse scheduling for this gateway instance. */
  async start(): Promise<void> {
    if (this.running) {
      return;
    }
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

  /** Stops Telegram polling and background pulse work for this gateway instance. */
  stop(): void { this.running = false; this.pulseScheduler.stop(); }

  /** Polls Telegram once and advances the gateway offset cursor. */
  private async pollOnce(): Promise<void> {
    this.nextOffset = await pollTelegramUpdatesOnce({
      apiBaseUrl: this.config.apiBaseUrl,
      botToken: this.config.botToken,
      pollTimeoutSeconds: this.config.pollTimeoutSeconds,
      nextOffset: this.nextOffset,
      processUpdate: async (update: TelegramUpdate) => this.processUpdate(update)
    });
  }

  /** Processes one Telegram update through validation, enrichment, and conversation handling. */
  private async processUpdate(update: TelegramUpdate): Promise<void> {
    const inboundEventId = String(update.update_id ?? "");
    const deliverTransportResponse = async (
      chatId: string,
      text: string
    ) =>
      sendObservedTelegramGatewayReply(
        this.config,
        chatId,
        text,
        this.onOutboundDelivery,
        buildTelegramTransportResponseObservation(
          this.allocateOutboundDeliverySequence(),
          inboundEventId
        )
      );
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
        (text: string) => deliverTransportResponse(prepared.chatId, text),
        "TELEGRAM_SEND_FAILED"
      );
      return;
    }
    if (prepared.kind === "stop") {
      await deliverPreparedTransportResponse(
        prepared.responseText,
        (text: string) => deliverTransportResponse(prepared.chatId, text),
        "TELEGRAM_SEND_FAILED"
      );
      return;
    }

    const enrichedPrepared = await enrichAcceptedTelegramUpdateWithMedia({
      prepared,
      config: this.config,
      mediaUnderstandingOrgan: this.mediaUnderstandingOrgan,
      mediaArtifactStore: this.mediaArtifactStore
    });
    if (enrichedPrepared.kind === "rejected") {
      await deliverPreparedTransportResponse(
        enrichedPrepared.responseText,
        (text: string) => deliverTransportResponse(enrichedPrepared.chatId, text),
        "TELEGRAM_SEND_FAILED"
      );
      return;
    }

    const sessionKey = `telegram:${enrichedPrepared.chatId}:${enrichedPrepared.userId}`;
    const notifier = this.createConversationNotifier(enrichedPrepared.chatId, {
      nativeDraftStreamingAllowed: enrichedPrepared.conversationVisibility === "private"
    }, buildTelegramNotifierBaseTrace(sessionKey, inboundEventId, enrichedPrepared.inbound.receivedAt ?? null));
    await handleAcceptedTransportConversation({
      inbound: {
        provider: "telegram",
        conversationId: enrichedPrepared.chatId,
        userId: enrichedPrepared.userId,
        username: enrichedPrepared.username,
        transportIdentity: enrichedPrepared.transportIdentity ?? null,
        conversationVisibility: enrichedPrepared.conversationVisibility,
        text: enrichedPrepared.inbound.text,
        commandRoutingText: enrichedPrepared.inbound.commandRoutingText,
        media: enrichedPrepared.inbound.media ?? null,
        receivedAt: enrichedPrepared.inbound.receivedAt ?? new Date().toISOString()
      },
      entityGraphEvent: enrichedPrepared.entityGraphEvent,
      notifier,
      conversationManager: this.conversationManager,
      entityGraphStore: this.entityGraphStore,
      dynamicPulseEnabled: this.config.security.enableDynamicPulse,
      entityDomainHintInterpretationResolver: this.config.security.enableDynamicPulse ? this.entityDomainHintInterpretationResolver : undefined,
      entityTypeInterpretationResolver: this.config.security.enableDynamicPulse ? this.entityTypeInterpretationResolver : undefined,
      abortControllers: this.autonomousAbortControllers,
      resolveEntityGraphDomainHint: async () => {
        const domainHint = (await this.sessionStore.getSession(sessionKey))?.domainContext.dominantLane ?? "unknown";
        return domainHint === "unknown" ? null : domainHint;
      },
      runTextTask: (input: string, receivedAt: string) =>
        runGatewaySessionTextTask(
          this.sessionStore,
          this.brainRegistry,
          sessionKey,
          input,
          receivedAt,
          {
            showTechnicalSummary: this.config.security.showTechnicalSummary,
            showSafetyCodes: this.config.security.showSafetyCodes
          }
        ),
      runAutonomousTask: (goal, timestamp, progressSender, signal, initialExecutionInput) =>
        runGatewaySessionAutonomousTask(
          this.sessionStore,
          this.brainRegistry,
          sessionKey,
          goal,
          timestamp,
          progressSender,
          signal,
          initialExecutionInput
        ),
      deliverReply: (reply: string) =>
        sendObservedTelegramGatewayReply(
          this.config,
          enrichedPrepared.chatId,
          reply,
          this.onOutboundDelivery,
          buildTelegramDirectReplyObservation(
            this.allocateOutboundDeliverySequence(),
            sessionKey,
            inboundEventId,
            enrichedPrepared.inbound.receivedAt ?? null
          )
        ),
      deliveryFailureCode: "TELEGRAM_SEND_FAILED",
      onEntityGraphMutationFailure: (error) => {
        console.warn(`[TelegramGateway] entity-graph mutation skipped: ${error.message}`);
      }
    });
  }
  /** Creates the notifier transport used for one Telegram conversation. */
  private createConversationNotifier(
    chatId: string,
    options: TelegramNotifierOptions,
    baseTrace?: {
      sessionKey?: string | null;
      inboundEventId?: string | null;
      inboundReceivedAt?: string | null;
    }
  ): ConversationNotifierTransport {
    return createTelegramGatewayNotifier(
      this.config,
      chatId,
      options,
      () => this.allocateDraftId(),
      () => this.allocateOutboundDeliverySequence(),
      baseTrace,
      this.onOutboundDelivery
    );
  }
  /** Allocates the next deterministic Telegram draft identifier for native draft streaming. */
  private allocateDraftId(): number {
    const allocation = allocateNextTelegramDraftId(this.nextDraftId);
    this.nextDraftId = allocation.nextDraftId;
    return allocation.draftId;
  }
  /** Allocates a monotonic sequence for observed outbound deliveries in this gateway instance. */
  private allocateOutboundDeliverySequence(): number {
    const sequence = this.nextOutboundDeliverySequence;
    this.nextOutboundDeliverySequence += 1;
    return sequence;
  }
}
