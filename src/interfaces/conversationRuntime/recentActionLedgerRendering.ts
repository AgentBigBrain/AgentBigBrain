/**
 * @fileoverview Small rendering helpers for recent-action, path, browser, and workspace recall surfaces.
 */

import type {
  ConversationBrowserSessionRecord,
  ConversationPathDestinationRecord,
  ConversationProgressState,
  ConversationRecentActionRecord,
  ConversationReturnHandoffRecord,
  ConversationSession
} from "../sessionStore";
import type { ConversationIntentSemanticHint } from "./intentModeContracts";
import {
  isReturnHandoffGuidedReviewRequest,
  isReturnHandoffReviewRequest,
  isWhileAwayReviewRequest
} from "./returnHandoffControl";

/**
 * Renders one recent-action line for natural status and recall answers.
 *
 * @param action - Recent action record.
 * @returns Human-readable bullet line.
 */
export function renderRecentActionLine(action: ConversationRecentActionRecord): string {
  if (action.location) {
    return `- ${action.label}: ${action.location}`;
  }
  return `- ${action.label}: ${action.summary}`;
}

/**
 * Renders a short, human-readable list like "index.html and styles.css".
 *
 * @param values - Ordered value list.
 * @returns Joined phrase for user-facing prose.
 */
export function joinNaturalList(values: readonly string[]): string {
  if (values.length === 0) {
    return "";
  }
  if (values.length === 1) {
    return values[0] ?? "";
  }
  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

/**
 * Renders one remembered destination line for natural location recall.
 *
 * @param destination - Remembered destination record.
 * @returns Human-readable bullet line.
 */
export function renderPathDestinationLine(
  destination: ConversationPathDestinationRecord
): string {
  return `- ${destination.label}: ${destination.resolvedPath}`;
}

/**
 * Renders the tracked workspace root for natural "where did you put it?" questions.
 *
 * @param session - Current conversation session state.
 * @returns Human-readable workspace line, or `null` when no workspace is tracked.
 */
export function renderActiveWorkspaceLocation(session: ConversationSession): string | null {
  if (!session.activeWorkspace?.rootPath) {
    return null;
  }
  if (session.activeWorkspace.ownershipState === "orphaned") {
    return `- Last attributable workspace: ${session.activeWorkspace.rootPath}`;
  }
  if (session.activeWorkspace.ownershipState === "stale") {
    return `- Last remembered workspace: ${session.activeWorkspace.rootPath}`;
  }
  return `- ${session.activeWorkspace.label}: ${session.activeWorkspace.rootPath}`;
}

/**
 * Renders the workspace-location heading that matches the current ownership state.
 *
 * @param session - Current conversation session state.
 * @returns Human-readable heading for workspace recall.
 */
export function renderActiveWorkspaceHeading(session: ConversationSession): string {
  if (session.activeWorkspace?.ownershipState === "orphaned") {
    return "Most recent attributable workspace:";
  }
  if (session.activeWorkspace?.ownershipState === "stale") {
    return "Most recent remembered workspace:";
  }
  return "Current workspace:";
}

/**
 * Renders one short workspace-preview summary that stays truthful about ownership state.
 *
 * @param session - Current conversation session state.
 * @returns Human-readable preview summary, or `null` when no preview is tracked.
 */
export function renderActiveWorkspacePreviewLine(
  session: ConversationSession
): string | null {
  if (!session.activeWorkspace?.previewUrl || !session.activeWorkspace.browserSessionStatus) {
    return null;
  }
  if (session.activeWorkspace.ownershipState === "orphaned") {
    return `Last attributable workspace preview: ${session.activeWorkspace.previewUrl} (${session.activeWorkspace.browserSessionStatus}).`;
  }
  if (session.activeWorkspace.ownershipState === "stale") {
    return `Last remembered workspace preview: ${session.activeWorkspace.previewUrl} (${session.activeWorkspace.browserSessionStatus}).`;
  }
  return `Tracked workspace preview: ${session.activeWorkspace.previewUrl} (${session.activeWorkspace.browserSessionStatus}).`;
}

/**
 * Renders one tracked browser session line for natural browser recall.
 *
 * @param browserSession - Remembered browser session record.
 * @returns Human-readable bullet line.
 */
export function renderBrowserSessionLine(
  browserSession: ConversationBrowserSessionRecord
): string {
  if (browserSession.linkedProcessLeaseId) {
    return `- ${browserSession.label}: ${browserSession.url} (linked preview lease ${browserSession.linkedProcessLeaseId})`;
  }
  return `- ${browserSession.label}: ${browserSession.url}`;
}

/**
 * Renders one human-first progress summary line for status and recall questions.
 *
 * @param progressState - Canonical persisted progress snapshot.
 * @returns Human-readable sentence describing the current or last-known runtime state.
 */
export function renderProgressStateLine(
  progressState: ConversationProgressState
): string {
  switch (progressState.status) {
    case "starting":
      return `I'm starting the work now: ${progressState.message}.`;
    case "working":
      return `I'm working on ${progressState.message}.`;
    case "retrying":
      return `I'm retrying with a narrower recovery step: ${progressState.message}.`;
    case "verifying":
      return `I'm verifying the result now: ${progressState.message}.`;
    case "waiting_for_user":
      return `I'm waiting on you for ${progressState.message}.`;
    case "completed":
      return `I finished the last autonomous run: ${progressState.message}.`;
    case "stopped":
      return `I stopped the last autonomous run: ${progressState.message}.`;
    default:
      return "I'm not actively working on anything right now.";
  }
}

interface ReviewEntryPointLabels {
  start: string;
  follow: string;
  next: string;
}

interface NextReviewStepGuidance {
  current: string;
  later: readonly string[];
}

/**
 * Chooses the human-facing labels for review-entry guidance based on the user's return style.
 *
 * @param guidedReviewRequest - Whether the user explicitly asked where to start reviewing.
 * @param whileAwayReview - Whether the user is returning after being away.
 * @returns Review guidance labels, or `null` when no ordered review guidance is needed.
 */
function resolveReviewEntryPointLabels(
  guidedReviewRequest: boolean,
  whileAwayReview: boolean
): ReviewEntryPointLabels | null {
  if (guidedReviewRequest) {
    return {
      start: "Start here",
      follow: "After that",
      next: "After your review"
    };
  }
  if (whileAwayReview) {
    return {
      start: "Best first look",
      follow: "Then review",
      next: "After you review it"
    };
  }
  return null;
}

/**
 * Builds the most useful first review surface for a durable checkpoint.
 *
 * @param handoff - Durable return-handoff snapshot.
 * @returns Human-readable review entry point, or `null` when no review target exists.
 */
function resolveReviewEntryPoint(
  handoff: ConversationReturnHandoffRecord
): string | null {
  if (handoff.previewUrl) {
    return `open the preview at ${handoff.previewUrl}.`;
  }
  if (handoff.primaryArtifactPath) {
    return `review ${handoff.primaryArtifactPath}.`;
  }
  if (handoff.workspaceRootPath) {
    return `open the workspace at ${handoff.workspaceRootPath}.`;
  }
  return null;
}

/**
 * Builds a short ordered checklist for review-style return prompts.
 *
 * @param handoff - Durable return-handoff snapshot.
 * @returns Ordered review checklist lines.
 */
function buildReviewChecklist(
  handoff: ConversationReturnHandoffRecord
): string[] {
  const checklist: string[] = [];
  const seenPaths = new Set<string>();

  if (handoff.previewUrl) {
    checklist.push(`Preview the page at ${handoff.previewUrl}.`);
  }
  if (handoff.primaryArtifactPath) {
    checklist.push(`Check the primary artifact at ${handoff.primaryArtifactPath}.`);
    seenPaths.add(handoff.primaryArtifactPath);
  }
  for (const changedPath of handoff.changedPaths) {
    if (seenPaths.has(changedPath)) {
      continue;
    }
    seenPaths.add(changedPath);
    checklist.push(`Review the changed file at ${changedPath}.`);
  }
  return checklist;
}

/**
 * Resolves the best next review step from the saved checklist without pretending the runtime knows
 * exactly what the user already finished reviewing.
 *
 * @param handoff - Durable return-handoff snapshot.
 * @returns Next-step guidance anchored to the saved review order.
 */
function resolveNextReviewStepGuidance(
  handoff: ConversationReturnHandoffRecord
): NextReviewStepGuidance | null {
  const checklist = buildReviewChecklist(handoff);
  if (checklist.length === 0) {
    return null;
  }
  return {
    current: checklist[1] ?? checklist[0] ?? "",
    later: checklist.slice(checklist.length > 1 ? 2 : 1)
  };
}

/**
 * Renders a durable return-handoff summary for users coming back to earlier work.
 *
 * @param handoff - Latest durable handoff snapshot.
 * @returns Human-readable multi-line handoff summary.
 */
export function renderReturnHandoffSummary(
  handoff: ConversationReturnHandoffRecord,
  userInput: string | null = null,
  semanticHint: ConversationIntentSemanticHint | null = null
): string {
  const explainHandoffRequest = semanticHint === "explain_handoff";
  const nextReviewStepRequest = semanticHint === "next_review_step";
  const wrapUpSummaryRequest = semanticHint === "wrap_up_summary";
  const whileAwayReview =
    semanticHint === "while_away_review" ||
    (userInput ? isWhileAwayReviewRequest(userInput) : false);
  const reviewRequest =
    semanticHint === "review_ready" ||
    (userInput ? isReturnHandoffReviewRequest(userInput) : false);
  const guidedReviewRequest =
    semanticHint === "guided_review" ||
    (userInput ? isReturnHandoffGuidedReviewRequest(userInput) : false);
  const reviewLabels = resolveReviewEntryPointLabels(guidedReviewRequest, whileAwayReview);
  const reviewEntryPoint = reviewLabels ? resolveReviewEntryPoint(handoff) : null;
  const nextReviewStep = nextReviewStepRequest ? resolveNextReviewStepGuidance(handoff) : null;
  const heading =
    explainHandoffRequest
      ? `Here is what I changed in the saved work: ${handoff.summary}`
      : wrapUpSummaryRequest
      ? `Here is what I wrapped up for you: ${handoff.summary}`
      : nextReviewStepRequest
      ? `Here is the next thing I would review from the saved work: ${handoff.summary}`
      : whileAwayReview
      ? `While you were away, ${handoff.summary}`
      : reviewRequest
        ? `Here is what is ready to review: ${handoff.summary}`
      : handoff.status === "waiting_for_user"
        ? `Paused work: ${handoff.summary}`
        : `Last completed work: ${handoff.summary}`;
  const lines = [heading];
  if (reviewRequest || explainHandoffRequest || nextReviewStepRequest || wrapUpSummaryRequest) {
    lines.push(
      handoff.status === "waiting_for_user"
        ? "Status: Paused here with a saved checkpoint ready for your review or next change request."
        : "Status: Finished and ready for your review."
    );
  }
  if (nextReviewStep) {
    lines.push(`Next review step: ${nextReviewStep.current}`);
    if (nextReviewStep.later.length > 0) {
      lines.push(`After that: ${joinNaturalList(nextReviewStep.later)}`);
    }
  }
  if (reviewLabels && reviewEntryPoint) {
    lines.push(`${reviewLabels.start}: ${reviewEntryPoint}`);
  }
  if (handoff.workspaceRootPath) {
    lines.push(`Workspace: ${handoff.workspaceRootPath}`);
  }
  if (handoff.previewUrl) {
    lines.push(`Preview: ${handoff.previewUrl}`);
  }
  if (handoff.primaryArtifactPath) {
    lines.push(`Primary artifact: ${handoff.primaryArtifactPath}`);
  }
  if (handoff.changedPaths.length > 0) {
    lines.push(
      explainHandoffRequest
        ? `What I changed: ${joinNaturalList(handoff.changedPaths)}.`
        : wrapUpSummaryRequest
        ? `What I wrapped up: ${joinNaturalList(handoff.changedPaths)}.`
        : `Changed paths: ${joinNaturalList(handoff.changedPaths)}`
    );
    if (reviewLabels) {
      lines.push(`${reviewLabels.follow}: review ${joinNaturalList(handoff.changedPaths)}.`);
    }
  }
  if (guidedReviewRequest) {
    const reviewChecklist = buildReviewChecklist(handoff);
    if (reviewChecklist.length > 0) {
      lines.push("Review order:");
      lines.push(
        ...reviewChecklist.map((item, index) => `${index + 1}. ${item}`)
      );
    }
  }
  if (handoff.nextSuggestedStep) {
    lines.push(
      reviewLabels
        ? `${reviewLabels.next}: ${handoff.nextSuggestedStep}`
        : `Next step: ${handoff.nextSuggestedStep}`
    );
  }
  return lines.join("\n");
}
