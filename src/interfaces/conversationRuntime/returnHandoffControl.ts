/**
 * @fileoverview Natural pause and review helpers for durable return-handoff checkpoints.
 */

import { normalizeWhitespace } from "../conversationManagerHelpers";
import { findRecentJob, setProgressState, setReturnHandoff } from "../conversationSessionMutations";
import type {
  ConversationJob,
  ConversationProgressState,
  ConversationReturnHandoffRecord,
  ConversationSession
} from "../sessionStore";
import { AUTONOMOUS_EXECUTION_PREFIX } from "./managerContracts";

const RETURN_HANDOFF_PAUSE_PATTERNS: readonly RegExp[] = [
  /\bleave the rest for later\b/i,
  /\blet(?:'s| us)? leave (?:the )?(?:rest|remainder) for later\b/i,
  /\bpause (?:here|that|it|this)(?: for now)?\b/i,
  /\bhold (?:here|that|it|this) for now\b/i,
  /\bwe can come back to (?:that|it|this) later\b/i,
  /\bsave (?:the )?(?:rest|remainder|that|it|this) for later\b/i
] as const;

const RETURN_HANDOFF_WHILE_AWAY_PATTERNS: readonly RegExp[] = [
  /\bwhile i was away\b/i,
  /\bwhile i was gone\b/i,
  /\bwhile i was out\b/i
] as const;

const RETURN_HANDOFF_REVIEW_PATTERNS: readonly RegExp[] = [
  /\bwhat(?:'s| is) ready(?: for (?:me to )?review)?\b/i,
  /\bshow me what(?:'s| is) ready(?: for (?:me to )?review)?\b/i,
  /\bshow me (?:the )?(?:rough |current )?draft\b/i,
  /\bwhat do you have ready(?: for me)?\b/i,
  /\bshow me what you(?:'ve| have) got(?: so far)?\b/i
] as const;

const RETURN_HANDOFF_GUIDED_REVIEW_PATTERNS: readonly RegExp[] = [
  /\bwhat should i look at first\b/i,
  /\bwhat should i review first\b/i,
  /\bwhere should i start\b/i,
  /\bshow me what i should look at first\b/i,
  /\bwhat do you want me to look at first\b/i
] as const;

const RETURN_HANDOFF_WHILE_AWAY_COMPLETION_PATTERNS: readonly RegExp[] = [
  /\bwhat did you finish while i was (?:away|gone|out)\b/i,
  /\bwhat did you complete while i was (?:away|gone|out)\b/i,
  /\bwhat got finished while i was (?:away|gone|out)\b/i,
  /\bwhat got completed while i was (?:away|gone|out)\b/i
] as const;

const PAUSED_RETURN_HANDOFF_MESSAGE =
  "pick this back up when you're ready, and I'll continue from the saved checkpoint";
const ACTIVE_AUTONOMOUS_PAUSE_MESSAGE =
  "stopping here and keeping the latest checkpoint ready so you can pick it back up later";

/**
 * Returns whether the user is explicitly asking to leave the current checkpoint for later.
 *
 * @param userInput - Raw inbound user wording.
 * @returns `true` when the wording means pause here and preserve the checkpoint.
 */
export function isReturnHandoffPauseRequest(userInput: string): boolean {
  const normalized = normalizeWhitespace(userInput);
  if (!normalized) {
    return false;
  }
  return RETURN_HANDOFF_PAUSE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Returns whether the user is asking for a checkpoint-style summary of what changed while away.
 *
 * @param userInput - Raw inbound user wording.
 * @returns `true` when the wording references work done while away.
 */
export function isWhileAwayReviewRequest(userInput: string): boolean {
  const normalized = normalizeWhitespace(userInput);
  if (!normalized) {
    return false;
  }
  return (
    RETURN_HANDOFF_WHILE_AWAY_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    RETURN_HANDOFF_WHILE_AWAY_COMPLETION_PATTERNS.some((pattern) => pattern.test(normalized))
  );
}

/**
 * Returns whether the user is asking to review the current rough draft or latest ready checkpoint.
 *
 * @param userInput - Raw inbound user wording.
 * @returns `true` when the wording asks what is ready to review.
 */
export function isReturnHandoffReviewRequest(userInput: string): boolean {
  const normalized = normalizeWhitespace(userInput);
  if (!normalized) {
    return false;
  }
  return RETURN_HANDOFF_REVIEW_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Returns whether the user is asking where to start reviewing the saved work.
 *
 * @param userInput - Raw inbound user wording.
 * @returns `true` when the wording asks for a guided first-look recommendation.
 */
export function isReturnHandoffGuidedReviewRequest(userInput: string): boolean {
  const normalized = normalizeWhitespace(userInput);
  if (!normalized) {
    return false;
  }
  return RETURN_HANDOFF_GUIDED_REVIEW_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Builds the canonical waiting checkpoint that says the user chose to leave the remaining work for
 * later.
 *
 * @param handoff - Existing durable handoff snapshot.
 * @param receivedAt - Timestamp for the explicit pause mutation.
 * @returns Updated durable handoff record.
 */
export function buildPausedReturnHandoff(
  handoff: ConversationReturnHandoffRecord,
  receivedAt: string
): ConversationReturnHandoffRecord {
  return {
    ...handoff,
    status: "waiting_for_user",
    nextSuggestedStep: PAUSED_RETURN_HANDOFF_MESSAGE,
    updatedAt: receivedAt
  };
}

/**
 * Builds the matching progress state for a "leave the rest for later" checkpoint.
 *
 * @param sourceJobId - Source job id associated with the handoff, if known.
 * @param receivedAt - Timestamp for the explicit pause mutation.
 * @returns Waiting-for-user progress snapshot.
 */
export function buildPausedReturnHandoffProgressState(
  sourceJobId: string | null,
  receivedAt: string
): ConversationProgressState {
  return {
    status: "waiting_for_user",
    message: PAUSED_RETURN_HANDOFF_MESSAGE,
    jobId: sourceJobId,
    updatedAt: receivedAt
  };
}

/**
 * Builds a human reply when the user chooses to leave the rest of the work for later.
 *
 * @param handoff - Updated durable handoff snapshot.
 * @returns User-facing checkpoint preservation reply.
 */
export function renderReturnHandoffPauseReply(
  handoff: ConversationReturnHandoffRecord
): string {
  const lines = [
    "Okay. I'll leave the rest for later and keep this checkpoint ready for you."
  ];
  if (handoff.workspaceRootPath) {
    lines.push(`Workspace: ${handoff.workspaceRootPath}`);
  }
  if (handoff.previewUrl) {
    lines.push(`Preview: ${handoff.previewUrl}`);
  }
  lines.push("When you're ready, say `pick that back up` and I'll continue from here.");
  return lines.join("\n");
}

/**
 * Resolves the currently running autonomous job from session state when one is still active.
 *
 * @param session - Current conversation session.
 * @returns Running autonomous job, or `null` when the active job is not autonomous.
 */
function resolveRunningAutonomousJob(session: ConversationSession): ConversationJob | null {
  if (!session.runningJobId) {
    return null;
  }
  const runningJob = findRecentJob(session, session.runningJobId);
  if (!runningJob) {
    return null;
  }
  return runningJob.executionInput?.startsWith(AUTONOMOUS_EXECUTION_PREFIX) ? runningJob : null;
}

/**
 * Builds the interim checkpoint shown while an active autonomous run is stopping at the user's
 * request.
 *
 * @param session - Current conversation session.
 * @param runningJob - Running autonomous job that is being paused.
 * @param receivedAt - Timestamp for the pause mutation.
 * @returns Provisional waiting checkpoint anchored to the active autonomous job.
 */
function buildActiveAutonomousPauseHandoff(
  session: ConversationSession,
  runningJob: ConversationJob,
  receivedAt: string
): ConversationReturnHandoffRecord {
  return {
    id: `handoff:${runningJob.id}`,
    status: "waiting_for_user",
    goal: runningJob.input,
    summary: "I am stopping the active autonomous run and keeping the latest checkpoint ready for you.",
    nextSuggestedStep: PAUSED_RETURN_HANDOFF_MESSAGE,
    workspaceRootPath:
      session.activeWorkspace?.rootPath ?? session.returnHandoff?.workspaceRootPath ?? null,
    primaryArtifactPath:
      session.activeWorkspace?.primaryArtifactPath ?? session.returnHandoff?.primaryArtifactPath ?? null,
    previewUrl:
      session.activeWorkspace?.previewUrl ?? session.returnHandoff?.previewUrl ?? null,
    changedPaths:
      session.activeWorkspace?.lastChangedPaths.slice(0, 5) ??
      session.returnHandoff?.changedPaths.slice(0, 5) ??
      [],
    sourceJobId: runningJob.id,
    updatedAt: receivedAt
  };
}

/**
 * Renders the immediate human reply for an in-flight autonomous pause request.
 *
 * @param handoff - Interim checkpoint describing the active paused workspace.
 * @returns Human-facing acknowledgement for the pause request.
 */
function renderActiveAutonomousPauseReply(
  handoff: ConversationReturnHandoffRecord
): string {
  const lines = [
    "Okay. I'm stopping here and keeping the latest checkpoint ready for you."
  ];
  if (handoff.workspaceRootPath) {
    lines.push(`Workspace: ${handoff.workspaceRootPath}`);
  }
  if (handoff.previewUrl) {
    lines.push(`Preview: ${handoff.previewUrl}`);
  }
  lines.push("When you're ready, say `pick that back up` and I'll continue from there.");
  return lines.join("\n");
}

/**
 * Applies a durable pause mutation when the user explicitly wants to leave the rest of the work for
 * later.
 *
 * @param session - Current conversation session.
 * @param userInput - Raw inbound user wording.
 * @param receivedAt - Timestamp for the pause mutation.
 * @returns User-facing reply, or `null` when the turn is not a pause request or no durable handoff exists.
 */
export function applyReturnHandoffPauseRequest(
  session: ConversationSession,
  userInput: string,
  receivedAt: string
): string | null {
  if (!session.returnHandoff || !isReturnHandoffPauseRequest(userInput)) {
    return null;
  }
  const pausedHandoff = buildPausedReturnHandoff(session.returnHandoff, receivedAt);
  setReturnHandoff(session, pausedHandoff);
  setProgressState(
    session,
    buildPausedReturnHandoffProgressState(pausedHandoff.sourceJobId, receivedAt)
  );
  return renderReturnHandoffPauseReply(pausedHandoff);
}

/**
 * Applies a live autonomous pause request by aborting the active autonomous run and preserving an
 * interim checkpoint until the worker persists the settled result.
 *
 * @param session - Current conversation session.
 * @param userInput - Raw inbound user wording.
 * @param receivedAt - Timestamp for the pause mutation.
 * @param abortActiveAutonomousRun - Real abort callback for the active transport-managed run.
 * @returns User-facing reply, or `null` when the turn is not a pausable active autonomous run.
 */
export function applyActiveAutonomousPauseRequest(
  session: ConversationSession,
  userInput: string,
  receivedAt: string,
  abortActiveAutonomousRun?: (() => boolean) | null
): string | null {
  if (!isReturnHandoffPauseRequest(userInput)) {
    return null;
  }
  const runningAutonomousJob = resolveRunningAutonomousJob(session);
  if (!runningAutonomousJob) {
    return null;
  }
  if (!abortActiveAutonomousRun || !abortActiveAutonomousRun()) {
    return "I couldn't confirm a live stop handle for the autonomous run from this interface, so I haven't paused it yet.";
  }

  runningAutonomousJob.pauseRequestedAt = receivedAt;
  const pausedHandoff = buildActiveAutonomousPauseHandoff(
    session,
    runningAutonomousJob,
    receivedAt
  );
  setReturnHandoff(session, pausedHandoff);
  setProgressState(session, {
    status: "stopped",
    message: ACTIVE_AUTONOMOUS_PAUSE_MESSAGE,
    jobId: null,
    updatedAt: receivedAt
  });
  return renderActiveAutonomousPauseReply(pausedHandoff);
}
