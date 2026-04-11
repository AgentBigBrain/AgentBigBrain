/**
 * @fileoverview Persists terminal worker execution outcomes and recovers fail-closed when that write path throws.
 */

import { upsertRecentJob } from "../conversationSessionMutations";
import {
  persistExecutedJobOutcome,
  type ConversationExecutionResult
} from "../conversationWorkerLifecycle";
import type {
  ConversationJob,
  ConversationSession,
  InterfaceSessionStore
} from "../sessionStore";
import { enqueueAutomaticTrackedWorkspaceRecoveryRetry } from "./conversationWorkerAutoRecovery";
import { type ListBrowserSessionSnapshots, type ListManagedProcessSnapshots } from "./managerContracts";
import { collectWorkerRuntimeSnapshots } from "./conversationWorkerRuntimeSnapshots";
import { recoverPostExecutionPersistenceFailure } from "./conversationWorkerTerminalRecovery";

export interface PersistWorkerExecutionOutcomeInput {
  sessionKey: string;
  store: InterfaceSessionStore;
  session: ConversationSession;
  executedJob: ConversationJob;
  executionResult: ConversationExecutionResult | null;
  listManagedProcessSnapshots?: ListManagedProcessSnapshots;
  listBrowserSessionSnapshots?: ListBrowserSessionSnapshots;
  maxRecentJobs: number;
  maxRecentActions: number;
  maxBrowserSessions: number;
  maxPathDestinations: number;
  maxConversationTurns: number;
}

export interface PersistedWorkerExecutionOutcome {
  updatedSession: ConversationSession;
  persistedRunningJob: ConversationJob;
}

/**
 * Applies the canonical worker post-execution persistence flow and falls back to a minimal terminal
 * checkpoint when that flow throws after the governed run already finished.
 *
 * @param input - Session/job context and runtime snapshot readers for the completed worker run.
 * @returns Persisted session plus canonical terminal recent-job record.
 */
export async function persistWorkerExecutionOutcome(
  input: PersistWorkerExecutionOutcomeInput
): Promise<PersistedWorkerExecutionOutcome> {
  const {
    sessionKey,
    store,
    executedJob,
    executionResult,
    listManagedProcessSnapshots,
    listBrowserSessionSnapshots,
    maxRecentJobs,
    maxRecentActions,
    maxBrowserSessions,
    maxPathDestinations,
    maxConversationTurns
  } = input;
  let updatedSession = (await store.getSession(sessionKey)) ?? input.session;
  let persistedRunningJob: ConversationJob;

  try {
    const {
      managedProcessSnapshots,
      browserSessionSnapshots
    } = await collectWorkerRuntimeSnapshots({
      listManagedProcessSnapshots,
      listBrowserSessionSnapshots
    });
    persistedRunningJob = persistExecutedJobOutcome({
      session: updatedSession,
      executedJob,
      executionResult,
      browserSessionSnapshots,
      managedProcessSnapshots,
      maxRecentJobs,
      maxRecentActions,
      maxBrowserSessions,
      maxPathDestinations,
      maxConversationTurns
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
      upsertRecentJob(updatedSession, persistedRunningJob, maxRecentJobs);
    }
    await store.setSession(updatedSession);
  } catch {
    const recoveredTerminalState = await recoverPostExecutionPersistenceFailure({
      sessionKey,
      store,
      fallbackSession: updatedSession,
      executedJob,
      executionResult,
      maxRecentJobs
    });
    updatedSession = recoveredTerminalState.session;
    persistedRunningJob = recoveredTerminalState.job;
  }

  return {
    updatedSession,
    persistedRunningJob
  };
}
