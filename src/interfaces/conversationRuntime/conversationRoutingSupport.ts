/**
 * @fileoverview Small helper utilities reused by the stable conversation-routing entrypoint.
 */

import type { ConversationSession } from "../sessionStore";
import type { LocalIntentModelSessionHints } from "../../organs/languageUnderstanding/localIntentModelContracts";

/**
 * Maps resolver confidence into the persisted continuity enum.
 *
 * @param confidence - Lowercase confidence emitted by intent resolution.
 * @returns Uppercase continuity confidence used by session state.
 */
export function toContinuityConfidence(
  confidence: "high" | "medium" | "low"
): "HIGH" | "MED" | "LOW" {
  switch (confidence) {
    case "high":
      return "HIGH";
    case "medium":
      return "MED";
    default:
      return "LOW";
  }
}

/**
 * Builds the bounded session-hint block exposed to the optional local intent model.
 *
 * @param session - Current conversation session.
 * @returns Minimal session hints that improve meaning resolution without exposing authorization.
 */
export function buildLocalIntentSessionHints(
  session: ConversationSession
): LocalIntentModelSessionHints | null {
  if (!session.returnHandoff && !session.modeContinuity) {
    return null;
  }

  return {
    hasReturnHandoff: session.returnHandoff !== null,
    returnHandoffStatus: session.returnHandoff?.status ?? null,
    returnHandoffPreviewAvailable: session.returnHandoff?.previewUrl !== null,
    returnHandoffPrimaryArtifactAvailable:
      session.returnHandoff?.primaryArtifactPath !== null,
    returnHandoffChangedPathCount: session.returnHandoff?.changedPaths.length ?? 0,
    returnHandoffNextSuggestedStepAvailable:
      session.returnHandoff?.nextSuggestedStep !== null &&
      session.returnHandoff?.nextSuggestedStep !== undefined,
    modeContinuity: session.modeContinuity?.activeMode ?? null
  };
}

/**
 * Builds the first autonomous execution brief when no richer conversation expansion is needed.
 *
 * @param goal - Raw autonomous goal text.
 * @param conversationAwareExecutionInput - Execution input already expanded with conversation state.
 * @param routingHint - Optional deterministic routing hint to preserve.
 * @returns Bounded autonomous first-step execution brief.
 */
export function buildAutonomousInitialExecutionInput(
  goal: string,
  conversationAwareExecutionInput: string,
  routingHint: string | null
): string {
  const trimmedGoal = goal.trim();
  const trimmedExecutionInput = conversationAwareExecutionInput.trim();
  if (trimmedExecutionInput && trimmedExecutionInput !== trimmedGoal) {
    return trimmedExecutionInput;
  }
  return [
    "Autonomous execution request.",
    "Own this task end to end and keep working until it is complete or a real blocker stops you.",
    "Do not switch to guidance-only output when governed execution can continue.",
    "Use the smallest real proof chain that can finish truthfully.",
    "",
    ...(routingHint ? ["Deterministic routing hint:", routingHint, ""] : []),
    "Current user request:",
    trimmedGoal
  ].join("\n");
}
