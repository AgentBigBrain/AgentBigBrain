/**
 * @fileoverview Canonical session merge and deduplication helpers for interface session runtime flows.
 */

import {
  buildConversationStackFromTurnsV1,
  isConversationStackV1
} from "../../core/stage6_86ConversationStack";
import type {
  ConversationClassifierEvent,
  ConversationJob,
  ConversationJobStatus,
  ConversationSession,
  ConversationTurn
} from "../sessionStore";

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
 * Merges two normalized conversation sessions into one deterministic persisted session shape.
 */
export function mergeConversationSession(
  existing: ConversationSession,
  incoming: ConversationSession
): ConversationSession {
  const mergedRecentJobs = mergeConversationJobs(existing.recentJobs, incoming.recentJobs);
  const mergedQueuedCandidates = mergeConversationJobs(existing.queuedJobs, incoming.queuedJobs);
  const completedRecentIds = new Set(
    mergedRecentJobs.filter((job) => isTerminalConversationJobStatus(job.status)).map((job) => job.id)
  );
  const mergedQueuedJobs = mergedQueuedCandidates.filter(
    (job) => !completedRecentIds.has(job.id) && !isTerminalConversationJobStatus(job.status)
  );
  const mergedConversationTurns = mergeConversationTurns(
    existing.conversationTurns,
    incoming.conversationTurns
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

  return {
    ...existing,
    ...incoming,
    sessionSchemaVersion: "v2",
    conversationStack: mergedConversationStack,
    updatedAt: mergedUpdatedAt,
    runningJobId: selectRunningJobId(
      existing.runningJobId,
      incoming.runningJobId,
      mergedQueuedJobs,
      mergedRecentJobs
    ),
    queuedJobs: mergedQueuedJobs,
    recentJobs: mergedRecentJobs,
    conversationTurns: mergedConversationTurns,
    classifierEvents: mergeClassifierEvents(
      existing.classifierEvents ?? [],
      incoming.classifierEvents ?? []
    )
  };
}
