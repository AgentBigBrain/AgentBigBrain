/**
 * @fileoverview Provides deterministic session mutation helpers for recent-job ledgers and bounded conversation turn history.
 */

import {
  ConversationJob,
  ConversationSession,
  ConversationTurn
} from "./sessionStore";
import {
  normalizeTurnText,
  sortTurnsByTime
} from "./conversationManagerHelpers";

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
  maxConversationTurns: number
): void {
  pushConversationTurn(session, "user", text, at, maxConversationTurns);
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
  pushConversationTurn(session, "assistant", text, at, maxConversationTurns);
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
): void {
  const normalized = normalizeTurnText(text);
  if (!normalized) {
    return;
  }

  session.conversationTurns = [...session.conversationTurns, { role, text: normalized, at }].slice(
    -maxConversationTurns
  );
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
      const normalizedAssistant = normalizeTurnText(job.resultSummary);
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
}
