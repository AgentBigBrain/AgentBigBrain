/**
 * @fileoverview Provides deterministic session mutation helpers for recent-job ledgers and bounded conversation turn history.
 */

import { applyDomainSignalWindow, type ConversationDomainSignalWindowUpdate } from "../core/sessionContext";
import {
  applyAssistantTurnToConversationStackV1,
  applyUserTurnToConversationStackV1,
  buildConversationStackFromTurnsV1,
  createEmptyConversationStackV1,
  isConversationStackV1,
  type TopicKeyInterpretationSignalV1
} from "../core/stage6_86ConversationStack";
import {
  ActiveClarificationState,
  ConversationActiveWorkspaceRecord,
  ConversationBrowserSessionRecord,
  ConversationJob,
  ConversationModeContinuityState,
  ConversationPathDestinationRecord,
  ConversationProgressState,
  ConversationReturnHandoffRecord,
  ConversationRecentActionRecord,
  ConversationSession,
  ConversationTurn
} from "./sessionStore";
import {
  normalizeAssistantTurnText,
  normalizeTurnText,
  sortTurnsByTime
} from "./conversationManagerHelpers";

/**
 * Narrows one shared domain lane into the persisted snapshot subset used on workspace and handoff records.
 *
 * @param lane - Candidate lane from the shared conversation-domain context.
 * @returns Persistable snapshot lane or `null` when the lane is unknown.
 */
function normalizePersistedDomainSnapshotLane(
  lane: ConversationSession["domainContext"]["dominantLane"] | null | undefined
): "profile" | "relationship" | "workflow" | "system_policy" | null {
  return lane === "profile" ||
    lane === "relationship" ||
    lane === "workflow" ||
    lane === "system_policy"
    ? lane
    : null;
}

/**
 * Resolves the current session-domain snapshot that should be stamped onto continuity records.
 *
 * @param session - Session carrying the shared domain context.
 * @param fallbackObservedAt - Best-effort timestamp when the shared context has not recorded one yet.
 * @returns Persistable snapshot lane plus recorded-at timestamp.
 */
function resolveSessionDomainSnapshot(
  session: ConversationSession,
  fallbackObservedAt: string | null
): {
  lane: "profile" | "relationship" | "workflow" | "system_policy" | null;
  recordedAt: string | null;
} {
  return {
    lane: normalizePersistedDomainSnapshotLane(session.domainContext.dominantLane),
    recordedAt:
      session.domainContext.lastUpdatedAt ??
      session.domainContext.activeSince ??
      fallbackObservedAt ??
      session.updatedAt
  };
}

/**
 * Finds a job by ID in a session's recent-job ledger.
 *
 * **Why it exists:**
 * Queue and delivery paths repeatedly need the canonical persisted job snapshot for a specific ID.
 * Keeping lookup logic in one helper prevents drift and duplicated null-handling.
 *
 * **What it talks to:**
 * - Reads `session.recentJobs`.
 *
 * @param session - Session snapshot containing recent jobs.
 * @param jobId - Job identifier to resolve.
 * @returns Matching job when found, otherwise `null`.
 */
export function findRecentJob(session: ConversationSession, jobId: string): ConversationJob | null {
  const job = session.recentJobs.find((candidate) => candidate.id === jobId);
  return job ?? null;
}

/**
 * Upserts a job into the recent-job ledger while preserving recency and a deterministic cap.
 *
 * **Why it exists:**
 * Session storage should keep exactly one authoritative copy per job ID, ordered from newest to
 * oldest, without unbounded growth.
 *
 * **What it talks to:**
 * - Mutates `session.recentJobs`.
 *
 * @param session - Session state receiving the mutation.
 * @param job - Job snapshot to insert or replace.
 * @param maxRecentJobs - Maximum number of recent jobs to retain.
 */
export function upsertRecentJob(
  session: ConversationSession,
  job: ConversationJob,
  maxRecentJobs: number
): void {
  session.recentJobs = [job, ...session.recentJobs.filter((candidate) => candidate.id !== job.id)].slice(
    0,
    maxRecentJobs
  );
}

/**
 * Records one user-authored turn in bounded conversation history.
 *
 * **Why it exists:**
 * Keeps user and assistant history writes on the same normalization and capping path.
 *
 * **What it talks to:**
 * - Calls `pushConversationTurn`.
 *
 * @param session - Session receiving the turn.
 * @param text - Raw user text.
 * @param at - Turn timestamp.
 * @param maxConversationTurns - Maximum turns retained in history.
 */
export function recordUserTurn(
  session: ConversationSession,
  text: string,
  at: string,
  maxConversationTurns: number,
  options: {
    topicKeyInterpretation?: TopicKeyInterpretationSignalV1 | null;
  } = {}
): void {
  const recordedTurn = pushConversationTurn(session, "user", text, at, maxConversationTurns);
  if (!recordedTurn) {
    return;
  }
  syncConversationStackWithRecordedTurn(
    session,
    recordedTurn,
    options.topicKeyInterpretation ?? null
  );
}

/**
 * Records one assistant-authored turn in bounded conversation history.
 *
 * **Why it exists:**
 * Ensures assistant output is stored with identical normalization and cap behavior.
 *
 * **What it talks to:**
 * - Calls `pushConversationTurn`.
 *
 * @param session - Session receiving the turn.
 * @param text - Raw assistant text.
 * @param at - Turn timestamp.
 * @param maxConversationTurns - Maximum turns retained in history.
 */
export function recordAssistantTurn(
  session: ConversationSession,
  text: string,
  at: string,
  maxConversationTurns: number
): void {
  const recordedTurn = pushConversationTurn(session, "assistant", text, at, maxConversationTurns);
  if (!recordedTurn) {
    return;
  }
  syncConversationStackWithRecordedTurn(session, recordedTurn, null);
}

/**
 * Appends one normalized turn and enforces deterministic history bounds.
 *
 * **Why it exists:**
 * Conversation context should avoid empty/noisy entries and stay within a fixed memory budget.
 *
 * **What it talks to:**
 * - Calls `normalizeTurnText`.
 * - Mutates `session.conversationTurns`.
 *
 * @param session - Session receiving the turn.
 * @param role - Turn role (`user` or `assistant`).
 * @param text - Raw turn text before normalization.
 * @param at - Timestamp stored on the turn.
 * @param maxConversationTurns - Maximum turns retained in history.
 */
export function pushConversationTurn(
  session: ConversationSession,
  role: ConversationTurn["role"],
  text: string,
  at: string,
  maxConversationTurns: number
): ConversationTurn | null {
  const normalized = role === "assistant"
    ? normalizeAssistantTurnText(text)
    : normalizeTurnText(text);
  if (!normalized) {
    return null;
  }

  const turn: ConversationTurn = { role, text: normalized, at };
  session.conversationTurns = [...session.conversationTurns, turn].slice(
    -maxConversationTurns
  );
  return turn;
}

/**
 * Rebuilds turn history from recent jobs when legacy sessions have no stored turns.
 *
 * **Why it exists:**
 * Older session snapshots may include completed jobs but an empty turn array. This preserves
 * follow-up context after upgrades/restarts without asking the user to restate prior turns.
 *
 * **What it talks to:**
 * - Reads `session.recentJobs`.
 * - Calls `normalizeTurnText` and `sortTurnsByTime`.
 * - Mutates `session.conversationTurns`.
 *
 * @param session - Session snapshot to backfill.
 * @param maxContextTurnsForExecution - Number of recent jobs to inspect for reconstruction.
 * @param maxConversationTurns - Maximum turns retained after reconstruction.
 */
export function backfillTurnsFromRecentJobsIfNeeded(
  session: ConversationSession,
  maxContextTurnsForExecution: number,
  maxConversationTurns: number
): void {
  if (session.conversationTurns.length > 0 || session.recentJobs.length === 0) {
    return;
  }

  const sourceJobs = [...session.recentJobs]
    .slice(0, maxContextTurnsForExecution)
    .reverse();

  const recoveredTurns: ConversationTurn[] = [];
  for (const job of sourceJobs) {
    const normalizedUser = normalizeTurnText(job.input);
    if (normalizedUser) {
      recoveredTurns.push({
        role: "user",
        text: normalizedUser,
        at: job.createdAt
      });
    }

    if (job.status === "completed" && job.resultSummary) {
      const normalizedAssistant = normalizeAssistantTurnText(job.resultSummary);
      if (normalizedAssistant) {
        recoveredTurns.push({
          role: "assistant",
          text: normalizedAssistant,
          at: job.completedAt ?? job.createdAt
        });
      }
    }
  }

  if (recoveredTurns.length === 0) {
    return;
  }

  session.conversationTurns = sortTurnsByTime(recoveredTurns).slice(-maxConversationTurns);
  const latestTurnAt = session.conversationTurns[session.conversationTurns.length - 1]?.at ?? session.updatedAt;
  session.conversationStack = buildConversationStackFromTurnsV1(
    session.conversationTurns,
    latestTurnAt,
    {}
  );
}

/**
 * Rebuilds stack state for all historical turns before the newest recorded turn.
 *
 * **Why it exists:**
 * Legacy sessions may still lack a valid persisted `conversationStack`. Rebuilding only the prior
 * history lets the newest user turn apply one bounded interpreted topic-key signal without replaying
 * that signal across older turns.
 *
 * **What it talks to:**
 * - Calls `buildConversationStackFromTurnsV1` and `createEmptyConversationStackV1`.
 *
 * @param session - Session whose bounded turn history has already been updated.
 * @param recordedTurn - The newest stored turn that still needs incremental stack application.
 * @returns Canonical stack state for all turns that came before `recordedTurn`.
 */
function rebuildConversationStackBeforeRecordedTurn(
  session: ConversationSession,
  recordedTurn: ConversationTurn
) {
  const historicalTurns = session.conversationTurns.slice(0, -1);
  if (historicalTurns.length === 0) {
    return createEmptyConversationStackV1(recordedTurn.at);
  }
  const historicalUpdatedAt = historicalTurns[historicalTurns.length - 1]?.at ?? recordedTurn.at;
  return buildConversationStackFromTurnsV1(historicalTurns, historicalUpdatedAt, {});
}

/**
 * Applies one newly stored turn to the session's Stage 6.86 conversation stack incrementally.
 *
 * **Why it exists:**
 * Live ingress should keep `conversationStack` current on every stored turn instead of waiting for
 * later normalization or merge replay, while still allowing one precomputed topic-key signal on the
 * newest ambiguous user turn only.
 *
 * **What it talks to:**
 * - Calls Stage 6.86 stack helpers from `../core/stage6_86ConversationStack`.
 * - Mutates `session.conversationStack`.
 *
 * @param session - Session whose stack should advance by one turn.
 * @param recordedTurn - Newly stored turn already present in `session.conversationTurns`.
 * @param topicKeyInterpretation - Optional validated topic-key interpretation for the newest user turn.
 */
function syncConversationStackWithRecordedTurn(
  session: ConversationSession,
  recordedTurn: ConversationTurn,
  topicKeyInterpretation: TopicKeyInterpretationSignalV1 | null
): void {
  const baseStack = isConversationStackV1(session.conversationStack)
    ? session.conversationStack
    : rebuildConversationStackBeforeRecordedTurn(session, recordedTurn);
  session.conversationStack = recordedTurn.role === "user"
    ? applyUserTurnToConversationStackV1(baseStack, recordedTurn, {
        topicKeyInterpretation
      })
    : applyAssistantTurnToConversationStackV1(baseStack, recordedTurn);
}

/**
 * Persists one active clarification state on the session.
 *
 * **Why it exists:**
 * Clarification should survive the next turn instead of behaving like a disposable prompt.
 *
 * **What it talks to:**
 * - Mutates `session.activeClarification`.
 *
 * @param session - Session receiving the clarification state.
 * @param clarification - Clarification state to store.
 */
export function setActiveClarification(
  session: ConversationSession,
  clarification: ActiveClarificationState
): void {
  session.activeClarification = clarification;
}

/**
 * Clears the currently active clarification state from the session.
 *
 * **Why it exists:**
 * Keeps clarification cleanup explicit when the user answers or the flow resets.
 *
 * **What it talks to:**
 * - Mutates `session.activeClarification`.
 *
 * @param session - Session having its clarification state cleared.
 */
export function clearActiveClarification(session: ConversationSession): void {
  session.activeClarification = null;
  if (session.progressState?.status === "waiting_for_user") {
    session.progressState = null;
  }
}

/**
 * Persists the current front-door mode continuity snapshot for the session.
 *
 * **Why it exists:**
 * Human-centric routing should remember the user's current working mode instead of forcing the
 * same phrasing every turn.
 *
 * **What it talks to:**
 * - Mutates `session.modeContinuity`.
 *
 * @param session - Session receiving the continuity state.
 * @param modeContinuity - Canonical mode continuity snapshot.
 */
export function setModeContinuity(
  session: ConversationSession,
  modeContinuity: ConversationModeContinuityState
): void {
  session.modeContinuity = modeContinuity;
}

/**
 * Persists the current user-facing progress state for the session.
 *
 * **Why it exists:**
 * Queue/execution flows need one canonical place to explain whether the assistant is working,
 * waiting, or idle.
 *
 * **What it talks to:**
 * - Mutates `session.progressState`.
 *
 * @param session - Session receiving the progress state.
 * @param progressState - Progress snapshot to store.
 */
export function setProgressState(
  session: ConversationSession,
  progressState: ConversationProgressState | null
): void {
  session.progressState = progressState;
}

/**
 * Persists the latest durable return-handoff snapshot for later resume and review turns.
 *
 * @param session - Session receiving the handoff snapshot.
 * @param returnHandoff - Durable work handoff state to store.
 */
export function setReturnHandoff(
  session: ConversationSession,
  returnHandoff: ConversationReturnHandoffRecord | null
): void {
  if (!returnHandoff) {
    session.returnHandoff = null;
    return;
  }
  const snapshot = resolveSessionDomainSnapshot(session, returnHandoff.updatedAt);
  session.returnHandoff = {
    ...returnHandoff,
    domainSnapshotLane:
      returnHandoff.domainSnapshotLane ??
      session.activeWorkspace?.domainSnapshotLane ??
      snapshot.lane,
    domainSnapshotRecordedAt:
      returnHandoff.domainSnapshotRecordedAt ??
      session.activeWorkspace?.domainSnapshotRecordedAt ??
      snapshot.recordedAt
  };
}

/**
 * Upserts one recent action record into bounded user-facing session state.
 *
 * **Why it exists:**
 * Recent user-visible outcomes should be queryable later without reverse-parsing job summaries.
 *
 * **What it talks to:**
 * - Mutates `session.recentActions`.
 *
 * @param session - Session receiving the action record.
 * @param action - Recent action snapshot to insert or replace.
 * @param maxRecentActions - Maximum number of records to retain.
 */
export function upsertRecentAction(
  session: ConversationSession,
  action: ConversationRecentActionRecord,
  maxRecentActions: number
): void {
  session.recentActions = [action, ...(session.recentActions ?? []).filter((candidate) => candidate.id !== action.id)]
    .sort((left, right) => right.at.localeCompare(left.at))
    .slice(0, maxRecentActions);
}

/**
 * Upserts one browser session record into bounded session state.
 *
 * **Why it exists:**
 * User-visible browser sessions should be closable and recallable later without relying on
 * ephemeral worker memory.
 *
 * **What it talks to:**
 * - Mutates `session.browserSessions`.
 *
 * @param session - Session receiving the browser session record.
 * @param browserSession - Browser session snapshot to insert or replace.
 * @param maxBrowserSessions - Maximum number of records to retain.
 */
export function upsertBrowserSession(
  session: ConversationSession,
  browserSession: ConversationBrowserSessionRecord,
  maxBrowserSessions: number
): void {
  const existingBrowserSession =
    (session.browserSessions ?? []).find((candidate) => candidate.id === browserSession.id) ?? null;
  const mergedBrowserSession: ConversationBrowserSessionRecord = {
    ...browserSession,
    workspaceRootPath:
      browserSession.workspaceRootPath ?? existingBrowserSession?.workspaceRootPath ?? null,
    linkedProcessLeaseId:
      browserSession.linkedProcessLeaseId ?? existingBrowserSession?.linkedProcessLeaseId ?? null,
    linkedProcessCwd:
      browserSession.linkedProcessCwd ?? existingBrowserSession?.linkedProcessCwd ?? null
  };
  session.browserSessions = [
    mergedBrowserSession,
    ...(session.browserSessions ?? []).filter((candidate) => candidate.id !== browserSession.id)
  ]
    .sort((left, right) => right.openedAt.localeCompare(left.openedAt))
    .slice(0, maxBrowserSessions);
}

/**
 * Upserts one remembered path/destination record into bounded session state.
 *
 * **Why it exists:**
 * Natural phrases like "same place as before" should resolve from structured destination memory.
 *
 * **What it talks to:**
 * - Mutates `session.pathDestinations`.
 *
 * @param session - Session receiving the destination record.
 * @param destination - Destination snapshot to insert or replace.
 * @param maxDestinations - Maximum number of records to retain.
 */
export function upsertPathDestination(
  session: ConversationSession,
  destination: ConversationPathDestinationRecord,
  maxDestinations: number
): void {
  session.pathDestinations = [
    destination,
    ...(session.pathDestinations ?? []).filter((candidate) => candidate.id !== destination.id)
  ]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, maxDestinations);
}

/**
 * Persists the current canonical workspace/project record for this conversation.
 *
 * **Why it exists:**
 * Follow-up requests like "edit it", "tell me what changed", and "close it" need one explicit
 * workspace record instead of re-deriving continuity from unrelated ledgers every turn.
 *
 * **What it talks to:**
 * - Mutates `session.activeWorkspace`.
 *
 * @param session - Session receiving the workspace snapshot.
 * @param workspace - Canonical workspace snapshot to store, or `null` to clear it.
 */
export function setActiveWorkspace(
  session: ConversationSession,
  workspace: ConversationActiveWorkspaceRecord | null
): void {
  if (!workspace) {
    session.activeWorkspace = null;
    return;
  }
  const snapshot = resolveSessionDomainSnapshot(session, workspace.updatedAt);
  session.activeWorkspace = {
    ...workspace,
    domainSnapshotLane: workspace.domainSnapshotLane ?? snapshot.lane,
    domainSnapshotRecordedAt:
      workspace.domainSnapshotRecordedAt ?? snapshot.recordedAt
  };
}

/**
 * Applies one bounded domain-context update to the current session.
 *
 * **Why it exists:**
 * Routing, memory, and lifecycle surfaces need one canonical mutation path for persisted
 * conversation-domain signals instead of open-coding window merges.
 *
 * **What it talks to:**
 * - Calls `applyDomainSignalWindow`.
 * - Mutates `session.domainContext`.
 *
 * @param session - Session receiving the domain-context update.
 * @param update - Bounded lane, routing, and continuity signals for the current turn.
 */
export function applyConversationDomainSignalWindow(
  session: ConversationSession,
  update: ConversationDomainSignalWindowUpdate
): void {
  session.domainContext = applyDomainSignalWindow(session.domainContext, update);
}
