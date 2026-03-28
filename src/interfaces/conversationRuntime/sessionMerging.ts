/**
 * @fileoverview Canonical session merge and deduplication helpers for interface session runtime flows.
 */

import {
  buildConversationStackFromTurnsV1,
  isConversationStackV1
} from "../../core/stage6_86ConversationStack";
import { selectConversationDomainContext } from "../../core/sessionContext";
import type {
  ConversationBrowserSessionRecord,
  ConversationClassifierEvent,
  ConversationJob,
  ConversationJobStatus,
  ConversationRecentActionRecord,
  ConversationPathDestinationRecord,
  ConversationSession,
  ConversationTurn
} from "../sessionStore";
import {
  resolveMergedProgressState,
  selectActiveClarification,
  selectModeContinuity,
  selectProgressState,
  selectReturnHandoff
} from "./sessionMergeStateSelection";
import { selectActiveWorkspace } from "./workspaceMerge";

const TERMINAL_JOB_STATUSES = new Set<ConversationJobStatus>(["completed", "failed"]);

/**
 * Returns whether a conversation job status is terminal for merge policy purposes.
 */
function isTerminalConversationJobStatus(status: ConversationJobStatus): boolean {
  return TERMINAL_JOB_STATUSES.has(status);
}

/**
 * Chooses the preferred persisted job record when duplicate ids are merged.
 */
function choosePreferredConversationJob(
  existing: ConversationJob,
  incoming: ConversationJob
): ConversationJob {
  const existingTerminal = isTerminalConversationJobStatus(existing.status);
  const incomingTerminal = isTerminalConversationJobStatus(incoming.status);
  if (existingTerminal && !incomingTerminal) {
    return existing;
  }
  if (!existingTerminal && incomingTerminal) {
    return incoming;
  }

  const existingFinalAttempted = existing.finalDeliveryOutcome !== "not_attempted";
  const incomingFinalAttempted = incoming.finalDeliveryOutcome !== "not_attempted";
  if (existingFinalAttempted && !incomingFinalAttempted) {
    return existing;
  }
  if (!existingFinalAttempted && incomingFinalAttempted) {
    return incoming;
  }

  if (existing.resultSummary && !incoming.resultSummary) {
    return existing;
  }
  if (!existing.resultSummary && incoming.resultSummary) {
    return incoming;
  }

  if (existing.errorMessage && !incoming.errorMessage) {
    return existing;
  }
  if (!existing.errorMessage && incoming.errorMessage) {
    return incoming;
  }
  if (existing.recoveryTrace && !incoming.recoveryTrace) {
    return existing;
  }
  if (!existing.recoveryTrace && incoming.recoveryTrace) {
    return incoming;
  }
  if (
    existing.recoveryTrace &&
    incoming.recoveryTrace &&
    existing.recoveryTrace.updatedAt !== incoming.recoveryTrace.updatedAt
  ) {
    return existing.recoveryTrace.updatedAt > incoming.recoveryTrace.updatedAt
      ? existing
      : incoming;
  }
  if (existing.pauseRequestedAt && !incoming.pauseRequestedAt) {
    return existing;
  }
  if (!existing.pauseRequestedAt && incoming.pauseRequestedAt) {
    return incoming;
  }

  const existingTimestamp = existing.completedAt ?? existing.startedAt ?? existing.createdAt;
  const incomingTimestamp = incoming.completedAt ?? incoming.startedAt ?? incoming.createdAt;
  if (existingTimestamp > incomingTimestamp) {
    return existing;
  }
  if (incomingTimestamp > existingTimestamp) {
    return incoming;
  }

  return incoming;
}

/**
 * Merges queued/recent job collections into one deterministic deduplicated ordering.
 */
function mergeConversationJobs(
  existingJobs: readonly ConversationJob[],
  incomingJobs: readonly ConversationJob[]
): ConversationJob[] {
  const mergedById = new Map<string, ConversationJob>();

  for (const existingJob of existingJobs) {
    mergedById.set(existingJob.id, existingJob);
  }

  for (const incomingJob of incomingJobs) {
    const current = mergedById.get(incomingJob.id);
    if (!current) {
      mergedById.set(incomingJob.id, incomingJob);
      continue;
    }
    mergedById.set(incomingJob.id, choosePreferredConversationJob(current, incomingJob));
  }

  return [...mergedById.values()].sort((left, right) => {
    const timestampOrder = right.createdAt.localeCompare(left.createdAt);
    if (timestampOrder !== 0) {
      return timestampOrder;
    }
    return left.id.localeCompare(right.id);
  });
}

/**
 * Merges persisted conversation turns into one deterministic deduplicated ordering.
 */
function mergeConversationTurns(
  existingTurns: readonly ConversationTurn[],
  incomingTurns: readonly ConversationTurn[]
): ConversationTurn[] {
  const mergedByKey = new Map<string, ConversationTurn>();
  for (const turn of existingTurns) {
    mergedByKey.set(`${turn.at}|${turn.role}|${turn.text}`, turn);
  }
  for (const turn of incomingTurns) {
    mergedByKey.set(`${turn.at}|${turn.role}|${turn.text}`, turn);
  }

  return [...mergedByKey.values()].sort((left, right) => {
    const atOrder = left.at.localeCompare(right.at);
    if (atOrder !== 0) {
      return atOrder;
    }
    const roleOrder = left.role.localeCompare(right.role);
    if (roleOrder !== 0) {
      return roleOrder;
    }
    return left.text.localeCompare(right.text);
  });
}

/**
 * Merges classifier telemetry events into one deterministic deduplicated ordering.
 */
function mergeClassifierEvents(
  existingEvents: readonly ConversationClassifierEvent[],
  incomingEvents: readonly ConversationClassifierEvent[]
): ConversationClassifierEvent[] {
  const mergedByKey = new Map<string, ConversationClassifierEvent>();
  for (const event of existingEvents) {
    mergedByKey.set(
      `${event.classifier}|${event.at}|${event.input}|${event.matchedRuleId}|${event.intent ?? "none"}|${event.conflict ? "1" : "0"}`,
      event
    );
  }
  for (const event of incomingEvents) {
    mergedByKey.set(
      `${event.classifier}|${event.at}|${event.input}|${event.matchedRuleId}|${event.intent ?? "none"}|${event.conflict ? "1" : "0"}`,
      event
    );
  }

  return [...mergedByKey.values()].sort((left, right) => left.at.localeCompare(right.at));
}

/**
 * Resolves the canonical running job id after merged queued/recent job state is known.
 */
function selectRunningJobId(
  existingRunningJobId: string | null,
  incomingRunningJobId: string | null,
  queuedJobs: readonly ConversationJob[],
  recentJobs: readonly ConversationJob[]
): string | null {
  const jobsById = new Map<string, ConversationJob>();
  for (const job of queuedJobs) {
    jobsById.set(job.id, job);
  }
  for (const job of recentJobs) {
    jobsById.set(job.id, job);
  }

  const isRunnable = (jobId: string | null): boolean => {
    if (!jobId) {
      return false;
    }
    const job = jobsById.get(jobId);
    if (!job) {
      return false;
    }
    return job.status === "running" || job.status === "queued";
  };

  if (isRunnable(incomingRunningJobId)) {
    return incomingRunningJobId;
  }
  if (isRunnable(existingRunningJobId)) {
    return existingRunningJobId;
  }
  return null;
}

/**
 * Merges recent action records into a deterministic deduplicated ordering.
 */
function mergeRecentActions(
  existingActions: readonly ConversationRecentActionRecord[],
  incomingActions: readonly ConversationRecentActionRecord[]
): ConversationRecentActionRecord[] {
  const mergedById = new Map<string, ConversationRecentActionRecord>();
  for (const action of existingActions) {
    mergedById.set(action.id, action);
  }
  for (const action of incomingActions) {
    const current = mergedById.get(action.id);
    if (!current || action.at >= current.at) {
      mergedById.set(action.id, action);
    }
  }
  return [...mergedById.values()].sort((left, right) => right.at.localeCompare(left.at));
}

/**
 * Merges browser session records into a deterministic deduplicated ordering.
 */
function mergeBrowserSessions(
  existingSessions: readonly ConversationBrowserSessionRecord[],
  incomingSessions: readonly ConversationBrowserSessionRecord[]
): ConversationBrowserSessionRecord[] {
  const mergedById = new Map<string, ConversationBrowserSessionRecord>();
  for (const session of existingSessions) {
    mergedById.set(session.id, session);
  }
  for (const session of incomingSessions) {
    const current = mergedById.get(session.id);
    if (!current) {
      mergedById.set(session.id, session);
      continue;
    }
    const preferred = session.openedAt >= current.openedAt ? session : current;
    const fallback = preferred === session ? current : session;
    mergedById.set(session.id, {
      ...preferred,
      browserProcessPid:
        preferred.browserProcessPid ?? fallback.browserProcessPid ?? null,
      workspaceRootPath:
        preferred.workspaceRootPath ?? fallback.workspaceRootPath ?? null,
      linkedProcessLeaseId:
        preferred.linkedProcessLeaseId ?? fallback.linkedProcessLeaseId ?? null,
      linkedProcessCwd:
        preferred.linkedProcessCwd ?? fallback.linkedProcessCwd ?? null,
      linkedProcessPid:
        preferred.linkedProcessPid ?? fallback.linkedProcessPid ?? null
    });
  }
  return [...mergedById.values()].sort((left, right) => right.openedAt.localeCompare(left.openedAt));
}

/**
 * Merges path destination records into a deterministic deduplicated ordering.
 */
function mergePathDestinations(
  existingDestinations: readonly ConversationPathDestinationRecord[],
  incomingDestinations: readonly ConversationPathDestinationRecord[]
): ConversationPathDestinationRecord[] {
  const mergedByKey = new Map<string, ConversationPathDestinationRecord>();
  for (const destination of existingDestinations) {
    mergedByKey.set(destination.label.toLowerCase(), destination);
  }
  for (const destination of incomingDestinations) {
    const key = destination.label.toLowerCase();
    const current = mergedByKey.get(key);
    if (!current || destination.updatedAt >= current.updatedAt) {
      mergedByKey.set(key, destination);
    }
  }
  return [...mergedByKey.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * Merges two normalized conversation sessions into one deterministic persisted session shape.
 */
export function mergeConversationSession(
  existing: ConversationSession,
  incoming: ConversationSession
): ConversationSession {
  const mergedRecentJobs = mergeConversationJobs(existing.recentJobs, incoming.recentJobs);
  const mergedQueuedCandidates = mergeConversationJobs(existing.queuedJobs, incoming.queuedJobs);
  const nonQueuedRecentIds = new Set(
    mergedRecentJobs.filter((job) => job.status !== "queued").map((job) => job.id)
  );
  const mergedQueuedJobs = mergedQueuedCandidates.filter(
    (job) => !nonQueuedRecentIds.has(job.id) && !isTerminalConversationJobStatus(job.status)
  );
  const mergedConversationTurns = mergeConversationTurns(
    existing.conversationTurns,
    incoming.conversationTurns
  );
  const mergedRecentActions = mergeRecentActions(
    existing.recentActions ?? [],
    incoming.recentActions ?? []
  );
  const mergedBrowserSessions = mergeBrowserSessions(
    existing.browserSessions ?? [],
    incoming.browserSessions ?? []
  );
  const mergedPathDestinations = mergePathDestinations(
    existing.pathDestinations ?? [],
    incoming.pathDestinations ?? []
  );
  const mergedUpdatedAt = existing.updatedAt > incoming.updatedAt ? existing.updatedAt : incoming.updatedAt;
  const preferredStackSource = existing.updatedAt >= incoming.updatedAt ? existing : incoming;
  const preferredStack = isConversationStackV1(preferredStackSource.conversationStack)
    ? preferredStackSource.conversationStack
    : null;
  const mergedConversationStack = buildConversationStackFromTurnsV1(
    mergedConversationTurns,
    mergedUpdatedAt,
    {},
    preferredStack
  );
  const mergedRunningJobId = selectRunningJobId(
    existing.runningJobId,
    incoming.runningJobId,
    mergedQueuedJobs,
    mergedRecentJobs
  );
  const mergedProgressState = resolveMergedProgressState(
    selectProgressState(existing.progressState ?? null, incoming.progressState ?? null),
    mergedRunningJobId,
    mergedQueuedJobs
  );

  return {
    ...existing,
    ...incoming,
    sessionSchemaVersion: "v2",
    conversationStack: mergedConversationStack,
    updatedAt: mergedUpdatedAt,
    activeClarification: selectActiveClarification(
      existing.activeClarification,
      incoming.activeClarification
    ),
    domainContext: selectConversationDomainContext(
      existing.domainContext,
      incoming.domainContext,
      existing.conversationId
    ),
    modeContinuity: selectModeContinuity(existing.modeContinuity ?? null, incoming.modeContinuity ?? null),
    progressState: mergedProgressState,
    returnHandoff: selectReturnHandoff(existing.returnHandoff ?? null, incoming.returnHandoff ?? null),
    runningJobId: mergedRunningJobId,
    queuedJobs: mergedQueuedJobs,
    recentJobs: mergedRecentJobs,
    recentActions: mergedRecentActions,
    browserSessions: mergedBrowserSessions,
    pathDestinations: mergedPathDestinations,
    activeWorkspace: selectActiveWorkspace(
      existing.activeWorkspace ?? null,
      incoming.activeWorkspace ?? null
    ),
    conversationTurns: mergedConversationTurns,
    classifierEvents: mergeClassifierEvents(
      existing.classifierEvents ?? [],
      incoming.classifierEvents ?? []
    )
  };
}
