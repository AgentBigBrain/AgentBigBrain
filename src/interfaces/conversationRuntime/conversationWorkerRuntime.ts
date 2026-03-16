/**
 * @fileoverview Owns internal system-job enqueue and worker-loop execution for ConversationManager.
 */
import { buildAgentPulseExecutionInput } from "../conversationExecutionInputPolicy";
import {
  deliverFinalMessage,
  handleAckTimerFire,
  scheduleAckTimerForJob,
  type ActiveAckTimerRecord
} from "../conversationDeliveryLifecycle";
import { normalizeWhitespace } from "../conversationManagerHelpers";
import { upsertRecentJob } from "../conversationSessionMutations";
import {
  buildFinalMessageForJob,
  type ConversationNotifierTransport,
  executeRunningJob,
  isBlockedSystemJobOutcome,
  markQueuedJobRunning,
  persistExecutedJobOutcome,
  shouldSuppressWorkerHeartbeat
} from "../conversationWorkerLifecycle";
import type { InterfaceSessionStore } from "../sessionStore";
import type {
  ListBrowserSessionSnapshots,
  ListManagedProcessSnapshots,
  ConversationNotifier,
  ExecuteConversationTask
} from "./managerContracts";
import {
  toConversationNotifierTransport
} from "./conversationNotifierTransport";
import { enqueueAutomaticTrackedWorkspaceRecoveryRetry } from "./conversationWorkerAutoRecovery";
import { persistConversationExecutionProgress } from "./conversationWorkerProgressPersistence";
import {
  canUseConversationAckTimerForSession,
  clearConversationAckTimer,
  enqueueConversationJob,
  setConversationAckLifecycleState
} from "./conversationLifecycle";
import { collectWorkerRuntimeSnapshots } from "./conversationWorkerRuntimeSnapshots";
export interface SessionWorkerBinding {
  executeTask: ExecuteConversationTask;
  notifier: ConversationNotifierTransport;
}

export interface ConversationWorkerRuntimeConfig {
  ackDelayMs: number;
  heartbeatIntervalMs: number;
  maxRecentJobs: number;
  maxRecentActions: number;
  maxBrowserSessions: number;
  maxPathDestinations: number;
  maxConversationTurns: number;
  maxContextTurnsForExecution: number;
  showCompletionPrefix: boolean;
}

export interface EnqueueConversationSystemJobInput {
  conversationKey: string;
  systemInput: string;
  receivedAt: string;
  executeTask: ExecuteConversationTask;
  notify: ConversationNotifier;
  store: InterfaceSessionStore;
  config: Pick<ConversationWorkerRuntimeConfig, "maxContextTurnsForExecution">;
  setWorkerBinding(
    sessionKey: string,
    executeTask: ExecuteConversationTask,
    notify: ConversationNotifier
  ): void;
  startWorkerIfNeeded(
    sessionKey: string,
    executeTask: ExecuteConversationTask,
    notify: ConversationNotifier
  ): Promise<void>;
}

export interface ProcessConversationQueueInput {
  sessionKey: string;
  executeTask: ExecuteConversationTask;
  notify: ConversationNotifierTransport;
  store: InterfaceSessionStore;
  listManagedProcessSnapshots?: ListManagedProcessSnapshots;
  listBrowserSessionSnapshots?: ListBrowserSessionSnapshots;
  config: Pick<
    ConversationWorkerRuntimeConfig,
    | "ackDelayMs"
    | "heartbeatIntervalMs"
    | "maxRecentJobs"
    | "maxRecentActions"
    | "maxBrowserSessions"
    | "maxPathDestinations"
    | "maxConversationTurns"
    | "showCompletionPrefix"
  >;
  ackTimers: Map<string, NodeJS.Timeout>;
  workerBindings: Map<string, SessionWorkerBinding>;
  autonomousExecutionPrefix: string;
}

/**
 * Stores the latest worker dependencies for one session key.
 *
 * @param workerBindings - Shared worker-binding map owned by the stable conversation manager.
 * @param sessionKey - Provider-scoped conversation/session key.
 * @param executeTask - Current governed execution callback for the session.
 * @param notify - Current notifier callback/object for the session.
 */
export function setConversationWorkerBinding(
  workerBindings: Map<string, SessionWorkerBinding>,
  sessionKey: string,
  executeTask: ExecuteConversationTask,
  notify: ConversationNotifier
): void {
  workerBindings.set(sessionKey, {
    executeTask,
    notifier: toConversationNotifierTransport(notify)
  });
}

export interface StartConversationWorkerIfNeededInput {
  sessionKey: string;
  executeTask: ExecuteConversationTask;
  notify: ConversationNotifier;
  activeWorkers: Set<string>;
  ackTimers: Map<string, NodeJS.Timeout>;
  workerBindings: Map<string, SessionWorkerBinding>;
  store: InterfaceSessionStore;
  listManagedProcessSnapshots?: ListManagedProcessSnapshots;
  listBrowserSessionSnapshots?: ListBrowserSessionSnapshots;
  config: Pick<
    ConversationWorkerRuntimeConfig,
    | "ackDelayMs"
    | "heartbeatIntervalMs"
    | "maxRecentJobs"
    | "maxRecentActions"
    | "maxBrowserSessions"
    | "maxPathDestinations"
    | "maxConversationTurns"
    | "showCompletionPrefix"
  >;
  autonomousExecutionPrefix: string;
}

/**
 * Starts the session worker loop only when there is queued work and no active worker already
 * processing the same session.
 *
 * @param input - Worker state, persistence, and callback dependencies.
 */
export async function startConversationWorkerIfNeeded(
  input: StartConversationWorkerIfNeededInput
): Promise<void> {
  const {
    sessionKey,
    executeTask,
    notify,
    activeWorkers,
    ackTimers,
    workerBindings,
    store,
    listManagedProcessSnapshots,
    listBrowserSessionSnapshots,
    config,
    autonomousExecutionPrefix
  } = input;

  setConversationWorkerBinding(workerBindings, sessionKey, executeTask, notify);
  if (activeWorkers.has(sessionKey)) {
    return;
  }

  activeWorkers.add(sessionKey);
  const binding = workerBindings.get(sessionKey);
  if (!binding) {
    activeWorkers.delete(sessionKey);
    return;
  }

  try {
    await processConversationQueue({
      sessionKey,
      executeTask: binding.executeTask,
      notify: binding.notifier,
      store,
      listManagedProcessSnapshots,
      listBrowserSessionSnapshots,
      config,
      ackTimers,
      workerBindings,
      autonomousExecutionPrefix
    });
  } finally {
    clearConversationAckTimer(sessionKey, ackTimers);
    activeWorkers.delete(sessionKey);
    const latestSession = await store.getSession(sessionKey);
    const latestBinding = workerBindings.get(sessionKey);
    if (
      latestSession &&
      latestBinding &&
      latestSession.runningJobId === null &&
      latestSession.queuedJobs.length > 0
    ) {
      void startConversationWorkerIfNeeded({
        sessionKey,
        executeTask: latestBinding.executeTask,
        notify: latestBinding.notifier,
        activeWorkers,
        ackTimers,
        workerBindings,
        store,
        listManagedProcessSnapshots,
        listBrowserSessionSnapshots,
        config,
        autonomousExecutionPrefix
      });
    } else if (!latestSession || latestSession.runningJobId === null) {
      workerBindings.delete(sessionKey);
    }
  }
}

/**
 * Enqueues an internal system-triggered job while preserving the stable conversation-manager
 * public entrypoint.
 *
 * @param input - Session binding, persistence, and worker-start dependencies.
 * @returns `true` when the normalized system input was queued.
 */
export async function enqueueConversationSystemJob(
  input: EnqueueConversationSystemJobInput
): Promise<boolean> {
  const {
    conversationKey,
    systemInput,
    receivedAt,
    executeTask,
    notify,
    store,
    config,
    setWorkerBinding,
    startWorkerIfNeeded
  } = input;
  const session = await store.getSession(conversationKey);
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

  setWorkerBinding(conversationKey, executeTask, notify);

  enqueueConversationJob(
    session,
    normalizedInput,
    receivedAt,
    buildAgentPulseExecutionInput(
      session,
      normalizedInput,
      config.maxContextTurnsForExecution
    ),
    true
  );
  session.updatedAt = receivedAt;
  await store.setSession(session);
  if (session.queuedJobs.length > 0) {
    void startWorkerIfNeeded(conversationKey, executeTask, notify);
  }
  return true;
}

/**
 * Runs the persisted queue loop for one interface session until work is exhausted or blocked.
 *
 * @param input - Queue/session state, lifecycle helpers, and worker callbacks.
 */
export async function processConversationQueue(
  input: ProcessConversationQueueInput
): Promise<void> {
  const {
    sessionKey,
    executeTask,
    notify,
    store,
    listManagedProcessSnapshots,
    listBrowserSessionSnapshots,
    config,
    ackTimers,
    workerBindings,
    autonomousExecutionPrefix
  } = input;
  let activeExecuteTask = executeTask;
  let activeNotify = notify;
  while (true) {
    const session = await store.getSession(sessionKey);
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

    const latestBinding = workerBindings.get(sessionKey);
    if (latestBinding) {
      activeExecuteTask = latestBinding.executeTask;
      activeNotify = latestBinding.notifier;
    }

    markQueuedJobRunning({
      session,
      job: nextJob,
      ackDelayMs: config.ackDelayMs,
      maxRecentJobs: config.maxRecentJobs
    });
    await store.setSession(session);
    scheduleAckTimerForJob({
      sessionKey,
      runningJob: nextJob,
      notify: activeNotify,
      ackTimers,
      clearAckTimer: (key) => clearConversationAckTimer(key, ackTimers),
      canUseAckTimerForSession: (candidateSessionKey, candidateNotifier) =>
        canUseConversationAckTimerForSession(candidateSessionKey, candidateNotifier),
      onTimerFire: async (timerRecord: ActiveAckTimerRecord) => {
        await handleAckTimerFire({
          sessionKey,
          timerRecord,
          notify: activeNotify,
          store,
          maxRecentJobs: config.maxRecentJobs,
          canUseAckTimerForSession: (candidateSessionKey, candidateNotifier) =>
            canUseConversationAckTimerForSession(candidateSessionKey, candidateNotifier),
          setAckLifecycleState: (job, nextState, fallbackErrorCode) =>
            setConversationAckLifecycleState(job, nextState, fallbackErrorCode)
        });
      }
    });

    const executionResult = await executeRunningJob({
      job: nextJob,
      executeTask: activeExecuteTask,
      notify: activeNotify,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
      suppressHeartbeat: shouldSuppressWorkerHeartbeat(
        nextJob,
        autonomousExecutionPrefix,
        activeNotify
      ),
      onProgressUpdate: async (update) => {
        await persistConversationExecutionProgress(
          sessionKey,
          nextJob.id,
          update,
          store
        );
      },
      onExecutionSettled: () => clearConversationAckTimer(sessionKey, ackTimers)
    });

    const updatedSession = (await store.getSession(sessionKey)) ?? session;
    const {
      managedProcessSnapshots,
      browserSessionSnapshots
    } = await collectWorkerRuntimeSnapshots({
      listManagedProcessSnapshots,
      listBrowserSessionSnapshots
    });
    const persistedRunningJob = persistExecutedJobOutcome({
      session: updatedSession,
      executedJob: nextJob,
      executionResult,
      browserSessionSnapshots,
      managedProcessSnapshots,
      maxRecentJobs: config.maxRecentJobs,
      maxRecentActions: config.maxRecentActions,
      maxBrowserSessions: config.maxBrowserSessions,
      maxPathDestinations: config.maxPathDestinations,
      maxConversationTurns: config.maxConversationTurns
    });
    if (
      persistedRunningJob.status === "completed" &&
      executionResult?.taskRunResult &&
      enqueueAutomaticTrackedWorkspaceRecoveryRetry(
        updatedSession,
        persistedRunningJob,
        executionResult.taskRunResult
      )
    ) {
      upsertRecentJob(updatedSession, persistedRunningJob, config.maxRecentJobs);
    }
    await store.setSession(updatedSession);

    if (isBlockedSystemJobOutcome(persistedRunningJob)) {
      persistedRunningJob.finalDeliveryOutcome = "sent";
      upsertRecentJob(updatedSession, persistedRunningJob, config.maxRecentJobs);
      await store.setSession(updatedSession);
      continue;
    }

    const finalMessage = buildFinalMessageForJob(
      persistedRunningJob,
      config.showCompletionPrefix
    );

    await deliverFinalMessage({
      sessionKey,
      jobId: persistedRunningJob.id,
      finalMessage,
      notify: activeNotify,
      store,
      maxRecentJobs: config.maxRecentJobs,
      canUseAckTimerForSession: (candidateSessionKey, candidateNotifier) =>
        canUseConversationAckTimerForSession(candidateSessionKey, candidateNotifier),
      setAckLifecycleState: (job, nextState, fallbackErrorCode) =>
        setConversationAckLifecycleState(job, nextState, fallbackErrorCode)
    });
  }
}
