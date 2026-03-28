/**
 * @fileoverview Persists structured execution progress updates back into canonical conversation session state.
 */

import { setProgressState } from "../conversationSessionMutations";
import type { InterfaceSessionStore } from "../sessionStore";
import type { ConversationExecutionProgressUpdate } from "./managerContracts";

/**
 * Persists one execution progress update back into canonical session state while a job is running.
 *
 * @param sessionKey - Provider-scoped session key owning the active job.
 * @param jobId - Running job whose progress is being updated.
 * @param update - Structured progress update emitted by the execution runtime.
 * @param store - Session store used for canonical persistence.
 */
export async function persistConversationExecutionProgress(
  sessionKey: string,
  jobId: string,
  update: ConversationExecutionProgressUpdate,
  store: InterfaceSessionStore
): Promise<void> {
  const session = await store.getSession(sessionKey);
  if (!session) {
    return;
  }
  const isCurrentJob =
    session.runningJobId === jobId ||
    session.recentJobs.some((candidate) => candidate.id === jobId && candidate.status === "running");
  if (!isCurrentJob) {
    return;
  }
  const updatedAt = new Date().toISOString();
  const persistedRecoveryTrace = update.recoveryTrace
    ? {
        ...update.recoveryTrace,
        updatedAt
      }
    : null;
  setProgressState(session, {
    status: update.status,
    message: update.message,
    jobId:
      update.status === "waiting_for_user" ||
      update.status === "completed" ||
      update.status === "stopped"
        ? null
        : jobId,
    updatedAt,
    recoveryTrace: persistedRecoveryTrace
  });
  const runningJob = session.recentJobs.find((candidate) => candidate.id === jobId);
  if (runningJob) {
    runningJob.recoveryTrace = persistedRecoveryTrace;
  }
  session.updatedAt = updatedAt;
  await store.setSession(session);
}
