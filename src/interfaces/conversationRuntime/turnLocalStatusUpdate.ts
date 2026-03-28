/**
 * @fileoverview Shared deterministic detection and rendering for first-person turn-local status updates.
 */

import { normalizeWhitespace } from "../conversationManagerHelpers";

const FIRST_PERSON_STATUS_UPDATE_PATTERN =
  /\bmy\s+[a-z0-9][a-z0-9_.\-/\s]{0,120}\s+is\s+[a-z0-9][^.!?\n]{0,120}/i;
const STATUS_UPDATE_VALUE_MARKER_PATTERN =
  /\b(?:pending|open|stuck|unresolved|incomplete|complete|completed|done|resolved)\b/i;

/**
 * Returns whether the current turn contains a bounded first-person status update that should stay
 * authoritative for this turn.
 *
 * @param userInput - Raw current user wording.
 * @returns `true` when the turn states a first-person status fact such as `my tax filing is pending`.
 */
export function hasTurnLocalFirstPersonStatusUpdate(userInput: string): boolean {
  const normalizedInput = normalizeWhitespace(userInput);
  if (!normalizedInput) {
    return false;
  }
  return (
    FIRST_PERSON_STATUS_UPDATE_PATTERN.test(normalizedInput) &&
    STATUS_UPDATE_VALUE_MARKER_PATTERN.test(normalizedInput)
  );
}

/**
 * Builds a prompt guardrail block when the user gives a first-person status update.
 *
 * @param userInput - Current raw user message.
 * @returns Instruction block appended to execution input, or `null` when no status update is detected.
 */
export function buildTurnLocalStatusUpdateInstructionBlock(
  userInput: string
): string | null {
  const normalizedInput = normalizeWhitespace(userInput);
  if (!normalizedInput || !hasTurnLocalFirstPersonStatusUpdate(normalizedInput)) {
    return null;
  }

  return [
    "Turn-local status update (authoritative for this turn):",
    `- User stated: ${normalizedInput}`,
    "- Response rule: acknowledge this latest status and do not assert an older contradictory status as fact."
  ].join("\n");
}
