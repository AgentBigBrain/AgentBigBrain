/**
 * @fileoverview Builds bounded reuse-intent context blocks for natural "same as before" requests.
 */

import { extractExecutionPreferences } from "./executionPreferenceExtraction";
import type { ConversationRecentActionRecord, ConversationSession } from "../sessionStore";

/**
 * Returns the most relevant recent action for natural "same as before" requests.
 *
 * @param session - Current conversation session.
 * @returns Most concrete recent action, or `null` when none exist.
 */
function latestConcreteRecentAction(
  session: ConversationSession
): ConversationRecentActionRecord | null {
  return (
    session.recentActions.find((action) => action.kind !== "task_summary") ??
    session.recentActions[0] ??
    null
  );
}

/**
 * Builds a bounded reuse block when the user asks to use the same approach, tool, workflow, or
 * destination from earlier in the chat.
 *
 * @param session - Current conversation session with recent work state.
 * @param userInput - Raw current user wording.
 * @returns Reuse guidance block, or `null` when the user did not ask for reuse.
 */
export function buildReuseIntentContextBlock(
  session: ConversationSession,
  userInput: string
): string | null {
  const preferences = extractExecutionPreferences(userInput);
  if (!preferences.reusePriorApproach) {
    return null;
  }

  const lines = [
    "Natural reuse preference:",
    "- The user asked to reuse the same approach, trusted tool, workflow, or destination from earlier in this chat when it is still relevant and safe."
  ];

  if (session.modeContinuity) {
    lines.push(
      `- Current working mode: ${session.modeContinuity.activeMode}`,
      `- Last affirmed wording: ${session.modeContinuity.lastUserInput}`
    );
  }

  const recentAction = latestConcreteRecentAction(session);
  if (recentAction) {
    lines.push(
      recentAction.location
        ? `- Most recent concrete result: ${recentAction.label} at ${recentAction.location}`
        : `- Most recent concrete result: ${recentAction.label} (${recentAction.summary})`
    );
  }

  if (session.pathDestinations.length > 0) {
    lines.push(`- Most recent destination: ${session.pathDestinations[0].resolvedPath}`);
  }

  return lines.join("\n");
}
