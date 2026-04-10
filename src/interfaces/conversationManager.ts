/** @fileoverview Handles conversational commands with per-session queueing, job-status visibility, and proposal approval workflows. */
import { AgentPulseMode, AgentPulseDecisionCode, AgentPulseRouteStrategy, ConversationSession, InterfaceSessionStore } from "./sessionStore";
import type { PulseEmissionRecordV1 } from "../core/stage6_86PulseCandidates";
import { processConversationMessage } from "./conversationIngressLifecycle";
import { type PulseLexicalRuleContext, createPulseLexicalRuleContext, createFollowUpRuleContext, type FollowUpRuleContext } from "./conversationManagerHelpers";
import { clearConversationAckTimer, enqueueConversationJob } from "./conversationRuntime/conversationLifecycle";
import { enqueueConversationSystemJob, setConversationWorkerBinding, startConversationWorkerIfNeeded, type SessionWorkerBinding } from "./conversationRuntime/conversationWorkerRuntime";
import { updateConversationAgentPulseState } from "./conversationRuntime/pulseState";
import { AUTONOMOUS_EXECUTION_PREFIX, buildAutonomousExecutionInput, type ConversationCheckpointReviewRunner, type ConversationIntentInterpreter, type ConversationManagerConfig, type ConversationManagerDependencies, type ConversationInboundMessage, type ConversationNotifier, type ExecuteConversationTask, type OpenConversationContinuityReadSession, type RememberConversationProfileInput, type QueryConversationContinuityFacts, type QueryConversationContinuityEpisodes } from "./conversationRuntime/managerContracts";
export { buildAutonomousExecutionInput, parseAutonomousExecutionInput } from "./conversationRuntime/managerContracts";
export type {
  ConversationCheckpointReviewResult, ConversationDeliveryResult, ConversationExecutionResult,
  ConversationInboundMessage, ConversationIntentInterpreter, ConversationManagerConfig, ConversationManagerDependencies,
  ConversationNotifier, ConversationNotifierCapabilities, ConversationNotifierTransport, ExecuteConversationTask
} from "./conversationRuntime/managerContracts";
const DEFAULT_CONVERSATION_MANAGER_CONFIG: ConversationManagerConfig = {
  maxProposalInputChars: 5_000,
  heartbeatIntervalMs: 15_000,
  ackDelayMs: 1_200,
  maxRecentJobs: 20,
  maxRecentActions: 12,
  maxBrowserSessions: 6,
  maxPathDestinations: 8,
  staleRunningJobRecoveryMs: 60_000,
  maxConversationTurns: 40,
  maxContextTurnsForExecution: 10,
  showCompletionPrefix: false,
  followUpOverridePath: null,
  pulseLexicalOverridePath: null,
  allowAutonomousViaInterface: false
};
const DEFAULT_INTENT_INTERPRETER_CONFIDENCE_THRESHOLD = 0.85;
export class ConversationManager {
  private readonly activeWorkers = new Set<string>();
  private readonly ackTimers = new Map<string, NodeJS.Timeout>();
  private readonly workerBindings = new Map<string, SessionWorkerBinding>();
  private readonly config: ConversationManagerConfig;
  private readonly interpretConversationIntent?: ConversationIntentInterpreter;
  private readonly runDirectConversationTurn?: ConversationManagerDependencies["runDirectConversationTurn"];
  private readonly localIntentModelResolver?: ConversationManagerDependencies["localIntentModelResolver"];
  private readonly autonomyBoundaryInterpretationResolver?: ConversationManagerDependencies["autonomyBoundaryInterpretationResolver"];
  private readonly statusRecallBoundaryInterpretationResolver?: ConversationManagerDependencies["statusRecallBoundaryInterpretationResolver"];
  private readonly continuationInterpretationResolver?: ConversationManagerDependencies["continuationInterpretationResolver"];
  private readonly contextualFollowupInterpretationResolver?: ConversationManagerDependencies["contextualFollowupInterpretationResolver"];
  private readonly contextualReferenceInterpretationResolver?: ConversationManagerDependencies["contextualReferenceInterpretationResolver"];
  private readonly entityReferenceInterpretationResolver?: ConversationManagerDependencies["entityReferenceInterpretationResolver"]; private readonly identityInterpretationResolver?: ConversationManagerDependencies["identityInterpretationResolver"];
  private readonly proposalReplyInterpretationResolver?: ConversationManagerDependencies["proposalReplyInterpretationResolver"];
  private readonly handoffControlInterpretationResolver?: ConversationManagerDependencies["handoffControlInterpretationResolver"];
  private readonly topicKeyInterpretationResolver?: ConversationManagerDependencies["topicKeyInterpretationResolver"];
  private readonly intentInterpreterConfidenceThreshold: number;
  private readonly runCheckpointReview?: ConversationCheckpointReviewRunner; private readonly queryContinuityEpisodes?: QueryConversationContinuityEpisodes;
  private readonly queryContinuityFacts?: QueryConversationContinuityFacts; private readonly getEntityGraph?: ConversationManagerDependencies["getEntityGraph"]; private readonly reconcileEntityAliasCandidate?: ConversationManagerDependencies["reconcileEntityAliasCandidate"];
  private readonly openContinuityReadSession?: OpenConversationContinuityReadSession;
  private readonly rememberConversationProfileInput?: RememberConversationProfileInput; private readonly reviewConversationMemory?: ConversationManagerDependencies["reviewConversationMemory"];
  private readonly reviewConversationMemoryFacts?: ConversationManagerDependencies["reviewConversationMemoryFacts"];
  private readonly resolveConversationMemoryEpisode?: ConversationManagerDependencies["resolveConversationMemoryEpisode"];
  private readonly markConversationMemoryEpisodeWrong?: ConversationManagerDependencies["markConversationMemoryEpisodeWrong"];
  private readonly forgetConversationMemoryEpisode?: ConversationManagerDependencies["forgetConversationMemoryEpisode"];
  private readonly correctConversationMemoryFact?: ConversationManagerDependencies["correctConversationMemoryFact"];
  private readonly forgetConversationMemoryFact?: ConversationManagerDependencies["forgetConversationMemoryFact"];
  private readonly listAvailableSkills?: ConversationManagerDependencies["listAvailableSkills"];
  private readonly describeRuntimeCapabilities?: ConversationManagerDependencies["describeRuntimeCapabilities"];
  private readonly listManagedProcessSnapshots?: ConversationManagerDependencies["listManagedProcessSnapshots"];
  private readonly listBrowserSessionSnapshots?: ConversationManagerDependencies["listBrowserSessionSnapshots"];
  private readonly memoryAccessAuditStore?: ConversationManagerDependencies["memoryAccessAuditStore"];
  private readonly abortActiveAutonomousRun?: ConversationManagerDependencies["abortActiveAutonomousRun"];
  private readonly followUpRuleContext: FollowUpRuleContext;
  private readonly pulseLexicalRuleContext: PulseLexicalRuleContext;
  /**
   * Creates the conversation queue/session coordinator used by interface gateways.
   *
   * **Why it exists:**
   * This manager owns draft flow, queueing, worker bindings, ack/final message lifecycle, and
   * follow-up classification state per interface session.
   *
   * **What it talks to:**
   * - Persists session state via `InterfaceSessionStore`.
   * - Uses classifier rule contexts and optional runtime dependencies from constructor input.
   */
  constructor(
    private readonly store: InterfaceSessionStore,
    config: Partial<ConversationManagerConfig> = {},
    dependencies: ConversationManagerDependencies = {}
  ) {
    this.config = { ...DEFAULT_CONVERSATION_MANAGER_CONFIG, ...config };
    this.interpretConversationIntent = dependencies.interpretConversationIntent;
    this.runDirectConversationTurn = dependencies.runDirectConversationTurn;
    this.localIntentModelResolver = dependencies.localIntentModelResolver;
    this.autonomyBoundaryInterpretationResolver = dependencies.autonomyBoundaryInterpretationResolver;
    this.statusRecallBoundaryInterpretationResolver = dependencies.statusRecallBoundaryInterpretationResolver;
    this.continuationInterpretationResolver = dependencies.continuationInterpretationResolver;
    this.contextualFollowupInterpretationResolver = dependencies.contextualFollowupInterpretationResolver;
    this.contextualReferenceInterpretationResolver = dependencies.contextualReferenceInterpretationResolver;
    this.entityReferenceInterpretationResolver = dependencies.entityReferenceInterpretationResolver;
    this.identityInterpretationResolver = dependencies.identityInterpretationResolver;
    this.proposalReplyInterpretationResolver = dependencies.proposalReplyInterpretationResolver;
    this.handoffControlInterpretationResolver = dependencies.handoffControlInterpretationResolver;
    this.topicKeyInterpretationResolver = dependencies.topicKeyInterpretationResolver;
    this.intentInterpreterConfidenceThreshold = Math.max(
      0,
      Math.min(
        1,
        dependencies.intentInterpreterConfidenceThreshold ??
        DEFAULT_INTENT_INTERPRETER_CONFIDENCE_THRESHOLD
      )
    );
    this.runCheckpointReview = dependencies.runCheckpointReview;
    this.queryContinuityEpisodes = dependencies.queryContinuityEpisodes;
    this.queryContinuityFacts = dependencies.queryContinuityFacts; this.openContinuityReadSession = dependencies.openContinuityReadSession; this.getEntityGraph = dependencies.getEntityGraph; this.reconcileEntityAliasCandidate = dependencies.reconcileEntityAliasCandidate;
    this.rememberConversationProfileInput = dependencies.rememberConversationProfileInput;
    this.reviewConversationMemory = dependencies.reviewConversationMemory;
    this.reviewConversationMemoryFacts = dependencies.reviewConversationMemoryFacts;
    this.resolveConversationMemoryEpisode = dependencies.resolveConversationMemoryEpisode;
    this.markConversationMemoryEpisodeWrong = dependencies.markConversationMemoryEpisodeWrong;
    this.forgetConversationMemoryEpisode = dependencies.forgetConversationMemoryEpisode;
    this.correctConversationMemoryFact = dependencies.correctConversationMemoryFact;
    this.forgetConversationMemoryFact = dependencies.forgetConversationMemoryFact;
    this.listAvailableSkills = dependencies.listAvailableSkills;
    this.describeRuntimeCapabilities = dependencies.describeRuntimeCapabilities;
    this.listManagedProcessSnapshots = dependencies.listManagedProcessSnapshots;
    this.listBrowserSessionSnapshots = dependencies.listBrowserSessionSnapshots;
    this.memoryAccessAuditStore = dependencies.memoryAccessAuditStore;
    this.abortActiveAutonomousRun = dependencies.abortActiveAutonomousRun;
    this.followUpRuleContext = createFollowUpRuleContext(this.config.followUpOverridePath);
    this.pulseLexicalRuleContext = createPulseLexicalRuleContext(this.config.pulseLexicalOverridePath);
  }
  /**
   * Enqueues an internal system-triggered job (for example Agent Pulse delivery).
   *
   * **Why it exists:**
   * Proactive/internal jobs share the same governed queue pipeline but require distinct safeguards:
   * no active draft collision, normalized input, and system-job tagging.
   *
   * **What it talks to:**
   * - Reads/writes session state via `InterfaceSessionStore`.
   * - Calls `normalizeWhitespace`, `setWorkerBinding`, `enqueueConversationJob`, and `startWorkerIfNeeded`.
   *
   * @param conversationKey - Target conversation key that will own the job.
   * @param systemInput - Internal execution input to enqueue.
   * @param receivedAt - Timestamp attached to queue/session updates.
   * @param executeTask - Execution callback for queue worker startup.
   * @param notify - Notifier callback/transport for async delivery.
   * @returns `true` when a system job was enqueued, otherwise `false`.
   */
  async enqueueSystemJob(
    conversationKey: string,
    systemInput: string,
    receivedAt: string,
    executeTask: ExecuteConversationTask,
    notify: ConversationNotifier
  ): Promise<boolean> {
    return enqueueConversationSystemJob({
      conversationKey,
      systemInput,
      receivedAt,
      executeTask,
      notify,
      store: this.store,
      config: {
        maxContextTurnsForExecution: this.config.maxContextTurnsForExecution
      },
      setWorkerBinding: (sessionKey, task, notifier) =>
        setConversationWorkerBinding(this.workerBindings, sessionKey, task, notifier),
      startWorkerIfNeeded: (sessionKey, task, notifier) =>
        startConversationWorkerIfNeeded({
          sessionKey,
          executeTask: task,
          notify: notifier,
          activeWorkers: this.activeWorkers,
          ackTimers: this.ackTimers,
          workerBindings: this.workerBindings,
          store: this.store,
          listManagedProcessSnapshots: this.listManagedProcessSnapshots,
          listBrowserSessionSnapshots: this.listBrowserSessionSnapshots,
          config: {
            ackDelayMs: this.config.ackDelayMs,
            heartbeatIntervalMs: this.config.heartbeatIntervalMs,
            maxRecentJobs: this.config.maxRecentJobs,
            maxRecentActions: this.config.maxRecentActions,
            maxBrowserSessions: this.config.maxBrowserSessions,
            maxPathDestinations: this.config.maxPathDestinations,
            maxConversationTurns: this.config.maxConversationTurns,
            showCompletionPrefix: this.config.showCompletionPrefix
          },
          autonomousExecutionPrefix: AUTONOMOUS_EXECUTION_PREFIX
        })
    });
  }

  /**
   * Applies a partial Agent Pulse state update for a single conversation session.
   *
   * **Why it exists:**
   * Pulse state is updated from scheduler, command handling, and runtime callbacks. This method
   * centralizes mutation rules and persistence so updates remain deterministic.
   *
   * **What it talks to:**
   * - Reads/writes `session.agentPulse`.
   * - Calls `appendPulseEmission` for bounded emission history updates.
   * - Persists via `InterfaceSessionStore`.
   *
   * @param conversationKey - Conversation key whose pulse state is being updated.
   * @param update - Partial patch object containing pulse field updates and optional emission.
   * @returns Promise resolving after the session write completes.
   */
  async updateAgentPulseState(
    conversationKey: string,
    update: Partial<{
      optIn: boolean;
      mode: AgentPulseMode;
      routeStrategy: AgentPulseRouteStrategy;
      lastPulseSentAt: string | null;
      lastPulseReason: string | null;
      lastPulseTargetConversationId: string | null;
      lastDecisionCode: AgentPulseDecisionCode;
      lastEvaluatedAt: string | null;
      lastContextualLexicalEvidence: ConversationSession["agentPulse"]["lastContextualLexicalEvidence"];
      updatedAt: string;
      newEmission: PulseEmissionRecordV1;
    }>
  ): Promise<void> {
    await updateConversationAgentPulseState({
      conversationKey,
      update,
      store: this.store
    });
  }

  /**
   * Handles one inbound interface message end-to-end for a conversation session.
   *
   * **Why it exists:**
   * This is the main ingress for queue/session behavior: load session state, classify command vs
   * natural input, update turns/pulse metadata, enqueue work, persist session, and start workers.
   *
   * **What it talks to:**
   * - Delegates ingress/command/proposal/session updates to `processConversationMessage`.
   * - Passes queue-worker binding callbacks and execution config into ingress lifecycle dependencies.
   *
   * @param message - Inbound provider message normalized by gateway.
   * @param executeTask - Worker callback that runs governed execution for queued jobs.
   * @param notify - Transport callback used for async progress/final messages.
   * @returns Immediate user reply text for this turn.
   */
  async handleMessage(
    message: ConversationInboundMessage,
    executeTask: ExecuteConversationTask,
    notify: ConversationNotifier
  ): Promise<string> {
    return processConversationMessage(message, executeTask, notify, {
      store: this.store,
      config: this.config,
      followUpRuleContext: this.followUpRuleContext,
      pulseLexicalRuleContext: this.pulseLexicalRuleContext,
      interpretConversationIntent: this.interpretConversationIntent,
      runDirectConversationTurn: this.runDirectConversationTurn,
        localIntentModelResolver: this.localIntentModelResolver,
        autonomyBoundaryInterpretationResolver: this.autonomyBoundaryInterpretationResolver,
        statusRecallBoundaryInterpretationResolver: this.statusRecallBoundaryInterpretationResolver,
        continuationInterpretationResolver: this.continuationInterpretationResolver,
        contextualFollowupInterpretationResolver: this.contextualFollowupInterpretationResolver,
        contextualReferenceInterpretationResolver: this.contextualReferenceInterpretationResolver,
      entityReferenceInterpretationResolver: this.entityReferenceInterpretationResolver,
      handoffControlInterpretationResolver: this.handoffControlInterpretationResolver,
      identityInterpretationResolver: this.identityInterpretationResolver,
      proposalReplyInterpretationResolver: this.proposalReplyInterpretationResolver,
      topicKeyInterpretationResolver: this.topicKeyInterpretationResolver,
      intentInterpreterConfidenceThreshold: this.intentInterpreterConfidenceThreshold,
      runCheckpointReview: this.runCheckpointReview,
      queryContinuityEpisodes: this.queryContinuityEpisodes,
      queryContinuityFacts: this.queryContinuityFacts,
      openContinuityReadSession: this.openContinuityReadSession,
      getEntityGraph: this.getEntityGraph,
      reconcileEntityAliasCandidate: this.reconcileEntityAliasCandidate,
      rememberConversationProfileInput: this.rememberConversationProfileInput,
      reviewConversationMemory: this.reviewConversationMemory,
      reviewConversationMemoryFacts: this.reviewConversationMemoryFacts,
      resolveConversationMemoryEpisode: this.resolveConversationMemoryEpisode,
      markConversationMemoryEpisodeWrong: this.markConversationMemoryEpisodeWrong,
      forgetConversationMemoryEpisode: this.forgetConversationMemoryEpisode,
      correctConversationMemoryFact: this.correctConversationMemoryFact,
      forgetConversationMemoryFact: this.forgetConversationMemoryFact,
      listAvailableSkills: this.listAvailableSkills,
      describeRuntimeCapabilities: this.describeRuntimeCapabilities,
      listManagedProcessSnapshots: this.listManagedProcessSnapshots,
      listBrowserSessionSnapshots: this.listBrowserSessionSnapshots,
      memoryAccessAuditStore: this.memoryAccessAuditStore,
      abortActiveAutonomousRun: this.abortActiveAutonomousRun,
      isWorkerActive: (sessionKey) => this.activeWorkers.has(sessionKey),
      clearAckTimer: (sessionKey) => clearConversationAckTimer(sessionKey, this.ackTimers),
      setWorkerBinding: (sessionKey, task, notifier) =>
        setConversationWorkerBinding(this.workerBindings, sessionKey, task, notifier),
      startWorkerIfNeeded: (sessionKey, task, notifier) =>
        startConversationWorkerIfNeeded({
          sessionKey,
          executeTask: task,
          notify: notifier,
          activeWorkers: this.activeWorkers,
          ackTimers: this.ackTimers,
          workerBindings: this.workerBindings,
          store: this.store,
          listManagedProcessSnapshots: this.listManagedProcessSnapshots,
          listBrowserSessionSnapshots: this.listBrowserSessionSnapshots,
          config: {
            ackDelayMs: this.config.ackDelayMs,
            heartbeatIntervalMs: this.config.heartbeatIntervalMs,
            maxRecentJobs: this.config.maxRecentJobs,
            maxRecentActions: this.config.maxRecentActions,
            maxBrowserSessions: this.config.maxBrowserSessions,
            maxPathDestinations: this.config.maxPathDestinations,
            maxConversationTurns: this.config.maxConversationTurns,
            showCompletionPrefix: this.config.showCompletionPrefix
          },
          autonomousExecutionPrefix: AUTONOMOUS_EXECUTION_PREFIX
        }),
      enqueueJob: (session, input, receivedAt, executionInput, isSystemJob) =>
        enqueueConversationJob(session, input, receivedAt, executionInput, isSystemJob),
      buildAutonomousExecutionInput: (goal) => buildAutonomousExecutionInput(goal)
    });
  }
  /**
   * Waits for queued background worker activity and notifier timers to settle for this manager.
   *
   * **Why it exists:**
   * Tests and controlled shutdown flows sometimes need a truthful "fully idle" boundary so they do
   * not tear down session persistence while worker or delivery cleanup is still flushing.
   *
   * @param timeoutMs - Upper bound for waiting on active workers, bindings, and timers.
   * @returns Promise resolving once the manager is idle.
   */
  async waitForIdle(timeoutMs = 30_000): Promise<void> {
    const startedAt = Date.now();
    while (
      this.activeWorkers.size > 0 ||
      this.ackTimers.size > 0
    ) {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for conversation manager to go idle after ${timeoutMs}ms.`);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
}
