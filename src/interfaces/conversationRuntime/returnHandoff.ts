/**
 * @fileoverview Builds durable return-handoff checkpoints from completed governed work.
 */

import type {
  ConversationActiveWorkspaceRecord,
  ConversationJob,
  ConversationProgressState,
  ConversationReturnHandoffRecord
} from "../sessionStore";

/**
 * Extracts a concise next-step hint from a user-facing completion or stop summary.
 *
 * @param summary - User-facing summary text.
 * @returns Next-step hint when one is present, otherwise `null`.
 */
function extractNextSuggestedStep(summary: string): string | null {
  const nextMatch = summary.match(/(?:^|\n)(?:Next|What to do next):\s*(.+)$/im);
  return nextMatch?.[1]?.trim() || null;
}

/**
 * Builds a durable return-handoff checkpoint from the latest completed job and workspace state.
 *
 * @param job - Completed governed job whose summary should anchor the handoff.
 * @param progressState - Persisted terminal or waiting progress state, when present.
 * @param activeWorkspace - Latest tracked workspace snapshot after job persistence.
 * @returns Durable return-handoff record, or `null` when no meaningful summary exists.
 */
export function buildConversationReturnHandoff(
  job: ConversationJob,
  progressState: ConversationProgressState | null,
  activeWorkspace: ConversationActiveWorkspaceRecord | null
): ConversationReturnHandoffRecord | null {
  const summary = job.resultSummary?.trim();
  if (!summary) {
    return null;
  }

  const status =
    progressState?.status === "waiting_for_user"
      ? "waiting_for_user"
      : progressState?.status === "stopped"
        ? "stopped"
        : "completed";

  return {
    id: `handoff:${job.id}`,
    status,
    goal: job.input,
    summary,
    nextSuggestedStep:
      status === "waiting_for_user"
        ? progressState?.message ?? null
        : extractNextSuggestedStep(summary),
    workspaceRootPath: activeWorkspace?.rootPath ?? null,
    primaryArtifactPath: activeWorkspace?.primaryArtifactPath ?? null,
    previewUrl: activeWorkspace?.previewUrl ?? null,
    changedPaths: activeWorkspace?.lastChangedPaths.slice(0, 5) ?? [],
    sourceJobId: job.id,
    domainSnapshotLane: activeWorkspace?.domainSnapshotLane ?? null,
    domainSnapshotRecordedAt: activeWorkspace?.domainSnapshotRecordedAt ?? null,
    updatedAt: job.completedAt ?? new Date().toISOString()
  };
}
