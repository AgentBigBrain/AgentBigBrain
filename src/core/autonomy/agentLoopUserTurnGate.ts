/**
 * @fileoverview Detects when the autonomous loop's next-step output actually requires a human turn.
 */

const USER_TURN_GATE_PATTERNS: readonly RegExp[] = [
  /\bwait for the user to reply\b/i,
  /\bcontinue waiting for the user\b/i,
  /\bask the user\b/i,
  /\buser confirmation is required\b/i,
  /\bwhen the user replies\b/i,
  /\bonce (?:the )?user replies\b/i,
  /\breply with exactly ["']?ready["']?\b/i,
  /\bexact(?:ly)? ["']?ready["']?\b/i
] as const;

/**
 * Detects whether model-authored next-step text is really asking for a human turn instead of a
 * valid autonomous subtask.
 *
 * @param value - Candidate next-step text from the loop model.
 * @returns `true` when the text matches a bounded user-turn gate.
 */
function matchesUserTurnGate(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }
  return USER_TURN_GATE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Detects whether the model's next-step output is really a human-turn gate instead of a valid next
 * autonomous subtask.
 *
 * @param reasoning - Model reasoning for the next step.
 * @param nextUserInput - Model-authored next autonomous input.
 * @returns Human-readable abort reason, or `null` when the loop can continue autonomously.
 */
export function buildAutonomousUserTurnGateReason(
  reasoning: string,
  nextUserInput: string
): string | null {
  if (!matchesUserTurnGate(nextUserInput)) {
    return null;
  }
  const normalizedReasoning = reasoning.trim();
  return normalizedReasoning
    ? `Autonomous work paused because the next safe step requires your reply or confirmation before I can continue. ${normalizedReasoning}`
    : "Autonomous work paused because the next safe step requires your reply or confirmation before I can continue.";
}
