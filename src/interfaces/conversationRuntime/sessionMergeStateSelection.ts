/**
 * @fileoverview State-selection helpers used by deterministic conversation session merging.
 */

import type {
  ActiveClarificationState,
  ConversationJob,
  ConversationModeContinuityState,
  ConversationProgressState,
  ConversationReturnHandoffRecord
} from "../sessionStore";

/**
 * Chooses the preferred active clarification state when both session snapshots contain one.
 */
export function selectActiveClarification(
  existing: ActiveClarificationState | null,
  incoming: ActiveClarificationState | null
): ActiveClarificationState | null {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }
  if (incoming.requestedAt > existing.requestedAt) {
    return incoming;
  }
  if (existing.requestedAt > incoming.requestedAt) {
    return existing;
  }
  return incoming;
}

/**
 * Chooses the newer mode continuity snapshot when both sessions provide one.
 */
export function selectModeContinuity(
  existing: ConversationModeContinuityState | null,
  incoming: ConversationModeContinuityState | null
): ConversationModeContinuityState | null {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }
  return incoming.lastAffirmedAt >= existing.lastAffirmedAt ? incoming : existing;
}

/**
 * Chooses the newer progress snapshot when both sessions provide one.
 */
export function selectProgressState(
  existing: ConversationProgressState | null,
  incoming: ConversationProgressState | null
): ConversationProgressState | null {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }
  return incoming.updatedAt >= existing.updatedAt ? incoming : existing;
}

/**
 * Chooses the newer durable return-handoff snapshot when both sessions provide one.
 */
export function selectReturnHandoff(
  existing: ConversationReturnHandoffRecord | null,
  incoming: ConversationReturnHandoffRecord | null
): ConversationReturnHandoffRecord | null {
  if (!existing) {
    return incoming;
  }
  if (!incoming) {
    return existing;
  }
  const preferred = incoming.updatedAt >= existing.updatedAt ? incoming : existing;
  const fallback = preferred === incoming ? existing : incoming;
  return {
    ...preferred,
    domainSnapshotLane:
      preferred.domainSnapshotLane ?? fallback.domainSnapshotLane ?? null,
    domainSnapshotRecordedAt:
      preferred.domainSnapshotRecordedAt ?? fallback.domainSnapshotRecordedAt ?? null
  };
}

/**
 * Clears stale in-flight progress once no runnable work remains in the merged session.
 */
export function resolveMergedProgressState(
  progressState: ConversationProgressState | null,
  runningJobId: string | null,
  queuedJobs: readonly ConversationJob[]
): ConversationProgressState | null {
  if (!progressState) {
    return null;
  }
  if (
    progressState.status !== "starting" &&
    progressState.status !== "working" &&
    progressState.status !== "retrying" &&
    progressState.status !== "verifying"
  ) {
    return progressState;
  }
  if (runningJobId !== null) {
    return progressState;
  }
  if (queuedJobs.length > 0) {
    return progressState;
  }
  return null;
}
