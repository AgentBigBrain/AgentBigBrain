/**
 * @fileoverview Handles conversational commands with per-session queueing, job-status visibility, and proposal approval workflows.
 */

import { makeId } from "../core/ids";
import {
  AgentPulseMode,
  AgentPulseDecisionCode,
  AgentPulseRouteStrategy,
  ConversationAckLifecycleState,
  ConversationVisibility,
  ConversationJob,
  ConversationSession,
  InterfaceSessionStore,
  appendPulseEmission
} from "./sessionStore";
import type { PulseEmissionRecordV1 } from "../core/stage6_86PulseCandidates";
import { canTransitionAckLifecycleState } from "./ackStateMachine";
import {
  InterpretedConversationIntent,
  IntentInterpreterTurn
} from "../organs/intentInterpreter";
import { upsertRecentJob } from "./conversationSessionMutations";
import { buildAgentPulseExecutionInput } from "./conversationExecutionInputPolicy";
import {
  buildFinalMessageForJob,
  executeRunningJob,
  isBlockedSystemJobOutcome,
  markQueuedJobRunning,
  persistExecutedJobOutcome,
  shouldSuppressWorkerHeartbeat
} from "./conversationWorkerLifecycle";
import {
  ActiveAckTimerRecord,
  deliverFinalMessage,
  handleAckTimerFire,
  scheduleAckTimerForJob
} from "./conversationDeliveryLifecycle";
import { processConversationMessage } from "./conversationIngressLifecycle";
import {
  type PulseLexicalRuleContext,
  createPulseLexicalRuleContext,
  createFollowUpRuleContext,
  type FollowUpRuleContext,
  normalizeWhitespace
} from "./conversationManagerHelpers";

export interface ConversationInboundMessage {
  provider: "telegram" | "discord";
  conversationId: string;
  userId: string;
  username: string;
  conversationVisibility: ConversationVisibility;
  text: string;
  receivedAt: string;
}

export interface ConversationExecutionResult {
  summary: string;
}

export type ExecuteConversationTask = (input: string, receivedAt: string) => Promise<ConversationExecutionResult>;

export interface ConversationDeliveryResult {
  ok: boolean;
  messageId: string | null;
  errorCode: string | null;
}

export interface ConversationNotifierCapabilities {
  supportsEdit: boolean;
  supportsNativeStreaming: boolean;
}

export interface ConversationNotifierTransport {
  capabilities: ConversationNotifierCapabilities;
  send(message: string): Promise<ConversationDeliveryResult>;
  edit?(messageId: string, message: string): Promise<ConversationDeliveryResult>;
  stream?(message: string): Promise<ConversationDeliveryResult>;
}

export type ConversationNotifier = ConversationNotifierTransport | ((message: string) => Promise<void>);

export type ConversationIntentInterpreter = (
  input: string,
  recentTurns: IntentInterpreterTurn[],
  pulseRuleContext?: PulseLexicalRuleContext
) => Promise<InterpretedConversationIntent>;

export interface ConversationCheckpointReviewResult {
  checkpointId: string;
  overallPass: boolean;
  artifactPath: string;
  summaryLines: readonly string[];
}

export type ConversationCheckpointReviewRunner = (
  checkpointId: string
) => Promise<ConversationCheckpointReviewResult | null>;

export interface ConversationManagerConfig {
  maxProposalInputChars: number;
  heartbeatIntervalMs: number;
  ackDelayMs: number;
  maxRecentJobs: number;
  staleRunningJobRecoveryMs: number;
  maxConversationTurns: number;
  maxContextTurnsForExecution: number;
  showCompletionPrefix: boolean;
  followUpOverridePath: string | null;
  pulseLexicalOverridePath: string | null;
  allowAutonomousViaInterface: boolean;
}

export interface ConversationManagerDependencies {
  interpretConversationIntent?: ConversationIntentInterpreter;
  intentInterpreterConfidenceThreshold?: number;
  runCheckpointReview?: ConversationCheckpointReviewRunner;
}

interface EnqueueResult {
  reply: string;
  shouldStartWorker: boolean;
}

interface SessionWorkerBinding {
  executeTask: ExecuteConversationTask;
  notifier: ConversationNotifierTransport;
}

const DEFAULT_CONVERSATION_MANAGER_CONFIG: ConversationManagerConfig = {
  maxProposalInputChars: 5_000,
  heartbeatIntervalMs: 15_000,
  ackDelayMs: 1_200,
  maxRecentJobs: 20,
  staleRunningJobRecoveryMs: 60_000,
  maxConversationTurns: 40,
  maxContextTurnsForExecution: 10,
  showCompletionPrefix: false,
  followUpOverridePath: null,
  pulseLexicalOverridePath: null,
  allowAutonomousViaInterface: false
};

const DEFAULT_INTENT_INTERPRETER_CONFIDENCE_THRESHOLD = 0.85;
const AUTONOMOUS_EXECUTION_PREFIX = "[AUTONOMOUS_LOOP_GOAL]";

/**
 * Tags an execution input as an autonomous loop goal so the gateway executeTask callback
 * can detect it and route to the autonomous loop instead of a single-task execution.
 */
export function buildAutonomousExecutionInput(goal: string): string {
  return `${AUTONOMOUS_EXECUTION_PREFIX} ${goal}`;
}

/**
 * Detects whether an execution input was tagged as an autonomous loop goal.
 * Returns the extracted goal string, or null if not an autonomous input.
 */
export function parseAutonomousExecutionInput(executionInput: string): string | null {
  if (!executionInput.startsWith(AUTONOMOUS_EXECUTION_PREFIX)) {
    return null;
  }
  return executionInput.slice(AUTONOMOUS_EXECUTION_PREFIX.length).trim();
}

/**
 * Evaluates conversation notifier transport and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * The manager accepts two notifier shapes (simple callback and richer transport object). This
 * guard distinguishes transport-capable notifiers before wrapping/fallback logic runs.
 *
 * **What it talks to:**
 * - Reads runtime shape of notifier object (`send`, `capabilities.supportsEdit`).
 *
 * @param notify - Notifier candidate passed into `handleMessage`.
 * @returns `true` when notifier already implements transport capabilities.
 */
function isConversationNotifierTransport(
  notify: ConversationNotifier
): notify is ConversationNotifierTransport {
  if (!notify || typeof notify !== "object") {
    return false;
  }
  const candidate = notify as Partial<ConversationNotifierTransport>;
  const supportsEdit = candidate.capabilities?.supportsEdit;
  const supportsNativeStreaming = candidate.capabilities?.supportsNativeStreaming;
  return (
    typeof candidate.send === "function" &&
    Boolean(candidate.capabilities) &&
    typeof supportsEdit === "boolean" &&
    typeof supportsNativeStreaming === "boolean"
  );
}

export class ConversationManager {
  private readonly activeWorkers = new Set<string>();
  private readonly ackTimers = new Map<string, NodeJS.Timeout>();
  private readonly workerBindings = new Map<string, SessionWorkerBinding>();
  private readonly config: ConversationManagerConfig;
  private readonly interpretConversationIntent?: ConversationIntentInterpreter;
  private readonly intentInterpreterConfidenceThreshold: number;
  private readonly runCheckpointReview?: ConversationCheckpointReviewRunner;
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
    this.config = {
      ...DEFAULT_CONVERSATION_MANAGER_CONFIG,
      ...config
    };
    this.interpretConversationIntent = dependencies.interpretConversationIntent;
    this.intentInterpreterConfidenceThreshold = Math.max(
      0,
      Math.min(
        1,
        dependencies.intentInterpreterConfidenceThreshold ??
        DEFAULT_INTENT_INTERPRETER_CONFIDENCE_THRESHOLD
      )
    );
    this.runCheckpointReview = dependencies.runCheckpointReview;
    this.followUpRuleContext = createFollowUpRuleContext(this.config.followUpOverridePath);
    this.pulseLexicalRuleContext = createPulseLexicalRuleContext(this.config.pulseLexicalOverridePath);
  }

  /**
   * Normalizes notifier callbacks into a transport-capable notifier object.
   *
   * **Why it exists:**
   * Worker logic expects a unified notifier contract with capability flags and delivery metadata.
   * This adapter keeps that contract stable for both legacy callback and transport inputs.
   *
   * **What it talks to:**
   * - Calls `isConversationNotifierTransport` for shape detection.
   *
   * @param notify - Incoming notifier function/object from gateway call site.
   * @returns Transport-capable notifier used by queue workers.
   */
  private toNotifierTransport(notify: ConversationNotifier): ConversationNotifierTransport {
    if (isConversationNotifierTransport(notify)) {
      return notify;
    }

    return {
      capabilities: {
        supportsEdit: false,
        supportsNativeStreaming: false
      },
      send: async (message: string) => {
        await notify(message);
        return {
          ok: true,
          messageId: null,
          errorCode: null
        };
      }
    };
  }

  /**
   * Stores the latest worker dependencies for a session key.
   *
   * **Why it exists:**
   * Gateways can reconnect/rebind while a session is active. The worker loop needs one canonical
   * place to fetch the current execute callback and notifier transport.
   *
   * **What it talks to:**
   * - Writes `workerBindings` map entries.
   * - Calls `toNotifierTransport` to normalize notifier shape.
   *
   * @param sessionKey - Provider-scoped session key (`provider:conversation:user`).
   * @param executeTask - Callback that executes governed work for queued jobs.
   * @param notify - Notifier callback/transport used for async status/final delivery.
   */
  private setWorkerBinding(
    sessionKey: string,
    executeTask: ExecuteConversationTask,
    notify: ConversationNotifier
  ): void {
    this.workerBindings.set(sessionKey, {
      executeTask,
      notifier: this.toNotifierTransport(notify)
    });
  }

  /**
   * Determines whether a session can use delayed ack + later edit replacement flow.
   *
   * **Why it exists:**
   * Not every provider supports editing a previously-sent message. Ack timers are only useful when
   * the platform and notifier capabilities can replace the ack with the final response.
   *
   * **What it talks to:**
   * - Reads provider prefix from `sessionKey`.
   * - Reads `notifier.capabilities.supportsEdit`.
   *
   * @param sessionKey - Provider-scoped session key.
   * @param notifier - Normalized notifier transport capabilities.
   * @returns `true` when ack-timer/edit behavior is supported for this session.
   */
  private canUseAckTimerForSession(
    sessionKey: string,
    notifier: ConversationNotifierTransport
  ): boolean {
    const provider = sessionKey.split(":")[0]?.trim().toLowerCase();
    return (
      provider === "telegram" &&
      notifier.capabilities.supportsEdit &&
      !notifier.capabilities.supportsNativeStreaming
    );
  }

  /**
   * Applies an ack lifecycle transition with deterministic fallback behavior on invalid moves.
   *
   * **Why it exists:**
   * Ack state can be updated from timer/send/edit/final-delivery paths. This helper enforces
   * state-machine rules consistently and records fallback errors when a transition is illegal.
   *
   * **What it talks to:**
   * - Calls `canTransitionAckLifecycleState`.
   * - Mutates `job.ackLifecycleState` and `job.ackLastErrorCode`.
   *
   * @param job - Job record whose ack lifecycle is being updated.
   * @param nextState - Desired next ack lifecycle state.
   * @param fallbackErrorCode - Error code stored when transition is rejected.
   */
  private setAckLifecycleState(
    job: ConversationJob,
    nextState: ConversationAckLifecycleState,
    fallbackErrorCode: string
  ): void {
    if (job.ackLifecycleState === nextState) {
      return;
    }
    if (!canTransitionAckLifecycleState(job.ackLifecycleState, nextState)) {
      if (canTransitionAckLifecycleState(job.ackLifecycleState, "CANCELLED")) {
        job.ackLifecycleState = "CANCELLED";
      }
      job.ackLastErrorCode = fallbackErrorCode;
      return;
    }
    job.ackLifecycleState = nextState;
  }

  /**
   * Cancels and removes any active ack timer for a session.
   *
   * **Why it exists:**
   * Acks are scheduled opportunistically; queue transitions and failures must reliably tear down
   * stale timers to prevent duplicate sends.
   *
   * **What it talks to:**
   * - Reads/writes `ackTimers` map.
   * - Calls Node `clearTimeout`.
   *
   * @param sessionKey - Session key whose ack timer should be cleared.
   */
  private clearAckTimer(sessionKey: string): void {
    const timer = this.ackTimers.get(sessionKey);
    if (timer) {
      clearTimeout(timer);
      this.ackTimers.delete(sessionKey);
    }
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
   * - Calls `normalizeWhitespace`, `setWorkerBinding`, `enqueueJob`, and `startWorkerIfNeeded`.
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
    const session = await this.store.getSession(conversationKey);
    if (!session) {
      return false;
    }

    const normalizedInput = normalizeWhitespace(systemInput);
    if (!normalizedInput) {
      return false;
    }

    if (session.activeProposal) {
      return false;
    }

    this.setWorkerBinding(conversationKey, executeTask, notify);

    const enqueueResult = this.enqueueJob(
      session,
      normalizedInput,
      receivedAt,
      buildAgentPulseExecutionInput(
        session,
        normalizedInput,
        this.config.maxContextTurnsForExecution
      ),
      true
    );
    session.updatedAt = receivedAt;
    await this.store.setSession(session);
    if (session.queuedJobs.length > 0) {
      void this.startWorkerIfNeeded(conversationKey, executeTask, notify);
    }
    return true;
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
    const session = await this.store.getSession(conversationKey);
    if (!session) {
      return;
    }

    if (typeof update.optIn === "boolean") {
      session.agentPulse.optIn = update.optIn;
    }
    if (update.mode === "private" || update.mode === "public") {
      session.agentPulse.mode = update.mode;
    }
    if (update.routeStrategy === "last_private_used" || update.routeStrategy === "current_conversation") {
      session.agentPulse.routeStrategy = update.routeStrategy;
    }
    if ("lastPulseSentAt" in update) {
      session.agentPulse.lastPulseSentAt = update.lastPulseSentAt ?? null;
    }
    if ("lastPulseReason" in update) {
      session.agentPulse.lastPulseReason = update.lastPulseReason ?? null;
    }
    if ("lastPulseTargetConversationId" in update) {
      session.agentPulse.lastPulseTargetConversationId = update.lastPulseTargetConversationId ?? null;
    }
    if (update.lastDecisionCode) {
      session.agentPulse.lastDecisionCode = update.lastDecisionCode;
    }
    if ("lastEvaluatedAt" in update) {
      session.agentPulse.lastEvaluatedAt = update.lastEvaluatedAt ?? null;
    }
    if ("lastContextualLexicalEvidence" in update) {
      session.agentPulse.lastContextualLexicalEvidence = update.lastContextualLexicalEvidence ?? null;
    }
    if (update.newEmission) {
      appendPulseEmission(session.agentPulse, update.newEmission);
    }
    if (typeof update.updatedAt === "string" && update.updatedAt.trim()) {
      session.updatedAt = update.updatedAt;
    }

    await this.store.setSession(session);
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
      intentInterpreterConfidenceThreshold: this.intentInterpreterConfidenceThreshold,
      runCheckpointReview: this.runCheckpointReview,
      isWorkerActive: (sessionKey) => this.activeWorkers.has(sessionKey),
      clearAckTimer: (sessionKey) => this.clearAckTimer(sessionKey),
      setWorkerBinding: (sessionKey, task, notifier) =>
        this.setWorkerBinding(sessionKey, task, notifier),
      startWorkerIfNeeded: (sessionKey, task, notifier) =>
        this.startWorkerIfNeeded(sessionKey, task, notifier),
      enqueueJob: (session, input, receivedAt, executionInput, isSystemJob) =>
        this.enqueueJob(session, input, receivedAt, executionInput, isSystemJob),
      buildAutonomousExecutionInput: (goal) => buildAutonomousExecutionInput(goal)
    });
  }

  /**
   * Enqueues a new job into the session queue and decides whether a worker should start now.
   *
   * **Why it exists:**
   * Queue insertion must be deterministic and preserve ack/final-delivery defaults while returning
   * immediate UX guidance (start now vs queued behind active work).
   *
   * **What it talks to:**
   * - Uses `makeId` (import `makeId`) from `../core/ids`.
   * - Uses `ConversationJob` (import `ConversationJob`) from `./sessionStore`.
   * - Uses `ConversationSession` (import `ConversationSession`) from `./sessionStore`.
   *
   * @param session - Mutable session state.
   * @param input - User-visible input summary for the job.
   * @param receivedAt - Job creation timestamp.
   * @param executionInput - Full execution payload sent to worker callback.
   * @param isSystemJob - Marks job as system-generated vs user-originated.
   * @returns Enqueue result indicating worker start behavior and reply text.
   */
  private enqueueJob(
    session: ConversationSession,
    input: string,
    receivedAt: string,
    executionInput: string = input,
    isSystemJob = false
  ): EnqueueResult {
    const job: ConversationJob = {
      id: makeId("job"),
      input,
      executionInput,
      createdAt: receivedAt,
      startedAt: null,
      completedAt: null,
      status: "queued",
      resultSummary: null,
      errorMessage: null,
      isSystemJob,
      ackTimerGeneration: 0,
      ackEligibleAt: null,
      ackLifecycleState: "NOT_SENT",
      ackMessageId: null,
      ackSentAt: null,
      ackEditAttemptCount: 0,
      ackLastErrorCode: null,
      finalDeliveryOutcome: "not_attempted",
      finalDeliveryAttemptCount: 0,
      finalDeliveryLastErrorCode: null,
      finalDeliveryLastAttemptAt: null
    };
    session.queuedJobs.push(job);
    session.updatedAt = receivedAt;

    const hadActiveWork = Boolean(session.runningJobId) || session.queuedJobs.length > 1;
    if (hadActiveWork) {
      return {
        shouldStartWorker: false,
        reply: `Queued your request. Queue depth: ${session.queuedJobs.length}. Use /status to monitor progress.`
      };
    }

    return {
      shouldStartWorker: true,
      reply: ""
    };
  }

  /**
   * Starts the session worker loop when there is queued work and no active worker.
   *
   * **Why it exists:**
   * Worker lifecycle is concurrency-sensitive; this gate prevents duplicate workers while supporting
   * restart/rebind behavior after each queue-processing cycle.
   *
   * **What it talks to:**
   * - Uses in-memory worker/ack maps and persisted session state for restart checks.
   *
   * @param sessionKey - Conversation/session key.
   * @param executeTask - Worker execution callback.
   * @param notify - Notifier used for progress/final message delivery.
   * @returns Promise that resolves when current worker cycle exits.
   */
  private async startWorkerIfNeeded(
    sessionKey: string,
    executeTask: ExecuteConversationTask,
    notify: ConversationNotifier
  ): Promise<void> {
    this.setWorkerBinding(sessionKey, executeTask, notify);
    if (this.activeWorkers.has(sessionKey)) {
      return;
    }

    this.activeWorkers.add(sessionKey);
    const binding = this.workerBindings.get(sessionKey);
    if (!binding) {
      this.activeWorkers.delete(sessionKey);
      return;
    }
    try {
      await this.processQueue(sessionKey, binding.executeTask, binding.notifier);
    } finally {
      this.clearAckTimer(sessionKey);
      this.activeWorkers.delete(sessionKey);
      const latestSession = await this.store.getSession(sessionKey);
      const latestBinding = this.workerBindings.get(sessionKey);
      if (
        latestSession &&
        latestBinding &&
        latestSession.runningJobId === null &&
        latestSession.queuedJobs.length > 0
      ) {
        void this.startWorkerIfNeeded(
          sessionKey,
          latestBinding.executeTask,
          latestBinding.notifier
        );
      } else if (!latestSession || latestSession.runningJobId === null) {
        this.workerBindings.delete(sessionKey);
      }
    }
  }

  /**
   * Processes queued jobs for one session until work is exhausted or blocked.
   *
   * **Why it exists:**
   * Queue execution coordinates job state transitions, ack timers, task execution callbacks, and
   * final delivery behavior while maintaining persisted session integrity.
   *
   * **What it talks to:**
   * - Uses worker lifecycle helpers from `./conversationWorkerLifecycle`.
   * - Uses final-delivery persistence helpers from `./conversationDeliveryLifecycle`.
   *
   * @param sessionKey - Conversation/session key being processed.
   * @param executeTask - Task execution callback bound to this session.
   * @param notify - Transport notifier used during processing.
   * @returns Promise that resolves when the queue loop exits for this session.
   */
  private async processQueue(
    sessionKey: string,
    executeTask: ExecuteConversationTask,
    notify: ConversationNotifierTransport
  ): Promise<void> {
    let activeExecuteTask = executeTask;
    let activeNotify = notify;
    while (true) {
      const session = await this.store.getSession(sessionKey);
      if (!session) {
        return;
      }

      if (session.runningJobId) {
        return;
      }

      const nextJob = session.queuedJobs.shift();
      if (!nextJob) {
        return;
      }

      const latestBinding = this.workerBindings.get(sessionKey);
      if (latestBinding) {
        activeExecuteTask = latestBinding.executeTask;
        activeNotify = latestBinding.notifier;
      }

      markQueuedJobRunning({
        session,
        job: nextJob,
        ackDelayMs: this.config.ackDelayMs,
        maxRecentJobs: this.config.maxRecentJobs
      });
      await this.store.setSession(session);
      scheduleAckTimerForJob({
        sessionKey,
        runningJob: nextJob,
        notify: activeNotify,
        ackTimers: this.ackTimers,
        clearAckTimer: (key) => this.clearAckTimer(key),
        canUseAckTimerForSession: (candidateSessionKey, candidateNotifier) =>
          this.canUseAckTimerForSession(candidateSessionKey, candidateNotifier),
        onTimerFire: async (timerRecord: ActiveAckTimerRecord) => {
          await handleAckTimerFire({
            sessionKey,
            timerRecord,
            notify: activeNotify,
            store: this.store,
            maxRecentJobs: this.config.maxRecentJobs,
            canUseAckTimerForSession: (candidateSessionKey, candidateNotifier) =>
              this.canUseAckTimerForSession(candidateSessionKey, candidateNotifier),
            setAckLifecycleState: (job, nextState, fallbackErrorCode) =>
              this.setAckLifecycleState(job, nextState, fallbackErrorCode)
          });
        }
      });

      await executeRunningJob({
        job: nextJob,
        executeTask: activeExecuteTask,
        notify: activeNotify,
        heartbeatIntervalMs: this.config.heartbeatIntervalMs,
        suppressHeartbeat: shouldSuppressWorkerHeartbeat(
          nextJob,
          AUTONOMOUS_EXECUTION_PREFIX,
          activeNotify
        ),
        onExecutionSettled: () => this.clearAckTimer(sessionKey)
      });

      const updatedSession = (await this.store.getSession(sessionKey)) ?? session;
      const persistedRunningJob = persistExecutedJobOutcome({
        session: updatedSession,
        executedJob: nextJob,
        maxRecentJobs: this.config.maxRecentJobs,
        maxConversationTurns: this.config.maxConversationTurns
      });
      await this.store.setSession(updatedSession);

      if (isBlockedSystemJobOutcome(persistedRunningJob)) {
        persistedRunningJob.finalDeliveryOutcome = "sent";
        upsertRecentJob(updatedSession, persistedRunningJob, this.config.maxRecentJobs);
        await this.store.setSession(updatedSession);
        continue;
      }

      const finalMessage = buildFinalMessageForJob(
        persistedRunningJob,
        this.config.showCompletionPrefix
      );

      await deliverFinalMessage({
        sessionKey,
        jobId: persistedRunningJob.id,
        finalMessage,
        notify: activeNotify,
        store: this.store,
        maxRecentJobs: this.config.maxRecentJobs,
        canUseAckTimerForSession: (candidateSessionKey, candidateNotifier) =>
          this.canUseAckTimerForSession(candidateSessionKey, candidateNotifier),
        setAckLifecycleState: (job, nextState, fallbackErrorCode) =>
          this.setAckLifecycleState(job, nextState, fallbackErrorCode)
      });
    }
  }

}
