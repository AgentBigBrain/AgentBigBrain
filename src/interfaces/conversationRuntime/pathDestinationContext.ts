/**
 * @fileoverview Builds user-facing path and destination context blocks for natural follow-up execution.
 */

import { extractExecutionPreferences } from "./executionPreferenceExtraction";
import type { ConversationSession } from "../sessionStore";

const DESTINATION_REFERENCE_PATTERNS: readonly RegExp[] = [
  /\bsame place as before\b/i,
  /\bsame place as last time\b/i,
  /\bsame folder\b/i,
  /\bsame destination\b/i,
  /\bleave it where you put (?:it|that|this|the last one)\b/i,
  /\bdesktop\b/i,
  /\bfolder called\b/i,
  /\bput it\b/i,
  /\bsave it\b/i
] as const;

/**
 * Builds a bounded destination-memory block when the current turn refers to remembered save/open
 * locations such as "same place as before" or "put it on my desktop".
 *
 * @param session - Current conversation session with recent destination history.
 * @param userInput - Raw current user wording.
 * @returns Destination-memory prompt block, or `null` when the current turn does not need it.
 */
export function buildPathDestinationContextBlock(
  session: ConversationSession,
  userInput: string
): string | null {
  if (session.pathDestinations.length === 0) {
    return null;
  }

  const normalized = userInput.trim();
  const preferences = extractExecutionPreferences(normalized);
  const refersToDestination =
    DESTINATION_REFERENCE_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    preferences.presentation.keepVisible ||
    preferences.presentation.leaveOpen ||
    preferences.presentation.runLocally;

  if (!refersToDestination) {
    return null;
  }

  const lines = session.pathDestinations.slice(0, 3).map((destination) =>
    `- ${destination.label}: ${destination.resolvedPath}`
  );
  if (session.activeWorkspace?.rootPath && session.activeWorkspace.ownershipState !== "tracked") {
    lines.push(
      `- The most recent workspace in this chat is ${session.activeWorkspace.ownershipState} at ${session.activeWorkspace.rootPath}. Reuse that path for continuity only, and require fresh inspection before assuming preview or process control still exists.`
    );
  }
  return [
    "Remembered save/open locations from this chat:",
    ...lines,
    "- If the user says 'same place as before' or names a simple desktop folder, prefer these remembered destinations before guessing a new path."
  ].join("\n");
}
