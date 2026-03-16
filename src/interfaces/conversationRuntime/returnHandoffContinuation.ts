/**
 * @fileoverview Session-aware continuation helpers for durable return-handoff checkpoints.
 */

import { normalizeWhitespace } from "../conversationManagerHelpers";
import type { ConversationIntentMode, ConversationSession } from "../sessionStore";
import type {
  ConversationIntentSemanticHint,
  ResolvedConversationIntentMode
} from "./intentModeContracts";

const RETURN_HANDOFF_CONTINUATION_PATTERNS: readonly RegExp[] = [
  /\bpick (?:that|it|this) back up\b/i,
  /\bresume (?:that|it|this)\b/i,
  /\bcontinue from (?:there|where you left off|the last checkpoint)\b/i,
  /\bcontinue (?:that|it|this) from where you left off\b/i,
  /\bgo back to (?:that|it|this)\b/i,
  /\bkeep working on (?:that|it|this)\b/i,
  /\bfinish (?:that|it|this) from where you left off\b/i
] as const;

const CONTINUABLE_HANDOFF_MODES = new Set<ConversationIntentMode>([
  "build",
  "autonomous",
  "review"
]);

/**
 * Returns whether the user is naturally asking to continue from the last durable checkpoint.
 *
 * @param userInput - Raw inbound user wording.
 * @returns `true` when the wording is a resume-style follow-up.
 */
export function isReturnHandoffContinuationRequest(userInput: string): boolean {
  const normalized = normalizeWhitespace(userInput);
  if (!normalized) {
    return false;
  }
  return RETURN_HANDOFF_CONTINUATION_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Returns whether the intent layer has already recognized a durable handoff continuation request.
 *
 * @param semanticHint - Optional semantic hint emitted by intent understanding.
 * @returns `true` when the hint means resume prior saved work.
 */
export function isReturnHandoffContinuationSemanticHint(
  semanticHint: ConversationIntentSemanticHint | null | undefined
): boolean {
  return semanticHint === "resume_handoff";
}

/**
 * Promotes a resume-style utterance into the last durable working mode when session state proves
 * there is prior assistant work worth continuing.
 *
 * @param session - Current conversation session.
 * @param userInput - Raw inbound user wording.
 * @param resolvedIntentMode - Canonical pre-continuity intent result.
 * @returns Promoted continuation intent when durable handoff state supports it; otherwise `null`.
 */
export function resolveReturnHandoffContinuationIntent(
  session: ConversationSession,
  userInput: string,
  resolvedIntentMode: ResolvedConversationIntentMode
): ResolvedConversationIntentMode | null {
  if (!session.returnHandoff) {
    return null;
  }
  if (resolvedIntentMode.clarification) {
    return null;
  }

  const preferredMode = session.modeContinuity?.activeMode;
  const fallbackResumedMode = preferredMode && CONTINUABLE_HANDOFF_MODES.has(preferredMode)
    ? preferredMode
    : "build";
  if (isReturnHandoffContinuationSemanticHint(resolvedIntentMode.semanticHint)) {
    const resumedMode =
      CONTINUABLE_HANDOFF_MODES.has(resolvedIntentMode.mode)
        ? resolvedIntentMode.mode
        : fallbackResumedMode;
    return {
      ...resolvedIntentMode,
      mode: resumedMode,
      matchedRuleId: "intent_mode_return_handoff_resume_semantic",
      explanation:
        "The intent layer recognized that the user wants to continue from the saved checkpoint instead of starting over.",
      clarification: null,
      semanticHint: "resume_handoff"
    };
  }
  if (resolvedIntentMode.mode !== "chat" && resolvedIntentMode.mode !== "unclear") {
    return null;
  }
  if (!isReturnHandoffContinuationRequest(userInput)) {
    return null;
  }

  return {
    mode: fallbackResumedMode,
    confidence: "high",
    matchedRuleId: "intent_mode_return_handoff_resume",
    explanation:
      "The user asked to continue prior work, and the session has a durable handoff checkpoint that can resume from the last completed or blocked state.",
    clarification: null,
    semanticHint: "resume_handoff"
  };
}

/**
 * Builds an execution-input block that tells downstream planning to continue from the last durable
 * checkpoint instead of restarting from scratch.
 *
 * @param session - Current conversation session.
 * @param userInput - Raw inbound user wording.
 * @returns Continuation block, or `null` when no resume-style handoff exists.
 */
export function buildReturnHandoffContinuationBlock(
  session: ConversationSession,
  userInput: string,
  semanticHint: ConversationIntentSemanticHint | null = null
): string | null {
  if (
    !session.returnHandoff ||
    (!isReturnHandoffContinuationRequest(userInput) &&
      !isReturnHandoffContinuationSemanticHint(semanticHint))
  ) {
    return null;
  }

  const lines = [
    "Durable return-handoff continuation:",
    "- The user wants to continue from the last durable checkpoint in this chat instead of restarting the work from scratch.",
    `- Resume request: ${normalizeWhitespace(userInput)}`,
    `- Prior goal: ${session.returnHandoff.goal}`,
    `- Durable summary: ${session.returnHandoff.summary}`,
    `- Handoff status: ${session.returnHandoff.status}`,
    `- Handoff updated at: ${session.returnHandoff.updatedAt}`
  ];
  if (session.returnHandoff.workspaceRootPath) {
    lines.push(`- Resume workspace root: ${session.returnHandoff.workspaceRootPath}`);
  }
  if (session.returnHandoff.primaryArtifactPath) {
    lines.push(`- Resume primary artifact: ${session.returnHandoff.primaryArtifactPath}`);
  }
  if (session.returnHandoff.previewUrl) {
    lines.push(`- Resume preview URL: ${session.returnHandoff.previewUrl}`);
  }
  if (session.returnHandoff.changedPaths.length > 0) {
    lines.push(
      `- Recent changed paths from that checkpoint: ${session.returnHandoff.changedPaths.join(", ")}`
    );
  }
  if (session.returnHandoff.nextSuggestedStep) {
    lines.push(`- Suggested next step: ${session.returnHandoff.nextSuggestedStep}`);
  }
  lines.push(
    "- Continue from the existing checkpoint when it still matches the user's wording. Do not rebuild or restart from scratch unless the tracked workspace or artifact no longer fits, and if that happens explain why."
  );
  return lines.join("\n");
}
