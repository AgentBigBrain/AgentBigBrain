/**
 * @fileoverview Fails closed when worker post-execution persistence throws after core execution completed.
 */

import {
  setProgressState,
  upsertRecentJob
} from "../conversationSessionMutations";
import type {
  ConversationJob,
  ConversationSession,
  InterfaceSessionStore
} from "../sessionStore";
import type { ConversationExecutionResult } from "./managerContracts";

export interface RecoveredWorkerTerminalState {
  session: ConversationSession;
  job: ConversationJob;
}

/**
 * Salvages a terminal recent-job snapshot when worker persistence throws after the governed run
 * already completed, so the session never remains stranded on a ghost running job.
 *
 * @param input - Session/job context needed to recover a terminal worker state.
 * @returns Best-effort recovered session and canonical terminal job record.
 */
export async function recoverPostExecutionPersistenceFailure(input: {
  sessionKey: string;
  store: InterfaceSessionStore;
  fallbackSession: ConversationSession;
  executedJob: ConversationJob;
  executionResult: ConversationExecutionResult | null;
  maxRecentJobs: number;
}): Promise<RecoveredWorkerTerminalState> {
  const {
    sessionKey,
    store,
    fallbackSession,
    executedJob,
    executionResult,
    maxRecentJobs
  } = input;
  const recoveredSession = (await store.getSession(sessionKey)) ?? fallbackSession;
  const recoveredJob =
    recoveredSession.recentJobs.find((candidate) => candidate.id === executedJob.id) ?? executedJob;
  const completedAt = executedJob.completedAt ?? new Date().toISOString();

  recoveredJob.status =
    executedJob.status === "completed" || executedJob.status === "failed"
      ? executedJob.status
      : executionResult
      ? "completed"
      : "failed";
  recoveredJob.startedAt = executedJob.startedAt;
  recoveredJob.completedAt = completedAt;
  recoveredJob.resultSummary =
    executedJob.resultSummary ??
    executionResult?.summary ??
    recoveredJob.resultSummary ??
    null;
  recoveredJob.errorMessage = executedJob.errorMessage ?? recoveredJob.errorMessage ?? null;
  recoveredJob.recoveryTrace =
    executedJob.recoveryTrace ?? recoveredJob.recoveryTrace ?? null;
  recoveredJob.finalDeliveryOutcome = "not_attempted";
  recoveredJob.finalDeliveryLastErrorCode = null;
  recoveredJob.finalDeliveryLastAttemptAt = null;

  recoveredSession.runningJobId = null;
  recoveredSession.updatedAt = completedAt;
  setProgressState(recoveredSession, null);
  upsertRecentJob(recoveredSession, recoveredJob, maxRecentJobs);
  await store.setSession(recoveredSession);

  return {
    session: recoveredSession,
    job: recoveredJob
  };
}
