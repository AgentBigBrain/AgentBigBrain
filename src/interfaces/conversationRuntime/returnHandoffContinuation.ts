/**
 * @fileoverview Session-aware continuation helpers for durable return-handoff checkpoints.
 */

import { normalizeWhitespace } from "../conversationManagerHelpers";
import type { ConversationIntentMode, ConversationSession } from "../sessionStore";
import {
  buildConversationSemanticRouteMetadata,
  ConversationIntentSemanticHint,
  ResolvedConversationIntentMode
} from "./intentModeContracts";
import {
  buildRecentIdentityInterpretationContext,
  shouldPreserveDeterministicDirectChatTurn
} from "./chatTurnSignals";
import {
  buildRecentAssistantTurnContext,
  isRecentAssistantAnswerThreadContinuationCandidate
} from "./recentAssistantTurnContext";
import { collectConversationChatTurnRawTokens } from "./chatTurnSignalAnalysis";

const RETURN_HANDOFF_CONTINUATION_SEQUENCES: readonly (readonly string[])[] = [
  ["pick", "that", "back", "up"],
  ["pick", "it", "back", "up"],
  ["pick", "this", "back", "up"],
  ["resume", "that"],
  ["resume", "it"],
  ["resume", "this"],
  ["continue", "from", "there"],
  ["continue", "from", "where", "you", "left", "off"],
  ["continue", "from", "the", "last", "checkpoint"],
  ["continue", "that", "from", "where", "you", "left", "off"],
  ["continue", "it", "from", "where", "you", "left", "off"],
  ["continue", "this", "from", "where", "you", "left", "off"],
  ["go", "back", "to", "that"],
  ["go", "back", "to", "it"],
  ["go", "back", "to", "this"],
  ["finish", "that", "from", "where", "you", "left", "off"],
  ["finish", "it", "from", "where", "you", "left", "off"],
  ["finish", "this", "from", "where", "you", "left", "off"]
] as const;

const CONTINUABLE_HANDOFF_MODES = new Set<ConversationIntentMode>([
  "build",
  "static_html_build",
  "framework_app_build",
  "autonomous",
  "review"
]);
const RETURN_HANDOFF_INTERPRETATION_MAX_CHARS = 160;

/**
 * Attaches explicit return-handoff route metadata before downstream prompt assembly consumes this
 * as workflow context.
 *
 * @param resolution - Resume intent selected by handoff continuity policy.
 * @returns The same intent with typed continuation metadata attached.
 */
function withReturnHandoffRouteMetadata(
  resolution: ResolvedConversationIntentMode
): ResolvedConversationIntentMode {
  const semanticRoute = buildConversationSemanticRouteMetadata(resolution, {
    continuationKind: "return_handoff"
  });
  return {
    ...resolution,
    semanticRouteId: semanticRoute.routeId,
    semanticRoute
  };
}

/**
 * Returns whether one bounded token sequence appears contiguously inside the current token list.
 *
 * @param tokens - Normalized raw token sequence for the current user turn.
 * @param sequence - Candidate ordered token sequence.
 * @returns `true` when every token appears contiguously in order.
 */
function hasTokenSequence(
  tokens: readonly string[],
  sequence: readonly string[]
): boolean {
  if (sequence.length === 0 || sequence.length > tokens.length) {
    return false;
  }
  for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (tokens[index + offset] !== sequence[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

/**
 * Returns whether any candidate continuation sequence appears in the current token list.
 *
 * @param tokens - Normalized raw token sequence for the current user turn.
 * @param sequences - Candidate ordered continuation sequences.
 * @returns `true` when at least one continuation sequence matches.
 */
function hasAnyTokenSequence(
  tokens: readonly string[],
  sequences: readonly (readonly string[])[]
): boolean {
  return sequences.some((sequence) => hasTokenSequence(tokens, sequence));
}

/**
 * Returns whether the session still carries workflow-compatible evidence for durable handoff resume.
 *
 * @param session - Current conversation session with optional handoff and workspace continuity.
 * @returns `true` when explicit resume behavior should remain eligible.
 */
function hasWorkflowCompatibleReturnHandoffContext(session: ConversationSession): boolean {
  const handoffSnapshotLane = session.returnHandoff?.domainSnapshotLane ?? null;
  const workspaceSnapshotLane = session.activeWorkspace?.domainSnapshotLane ?? null;
  if (handoffSnapshotLane === "workflow") {
    return true;
  }
  if (workspaceSnapshotLane === "workflow") {
    return true;
  }
  if (
    handoffSnapshotLane === "profile" ||
    handoffSnapshotLane === "relationship" ||
    handoffSnapshotLane === "system_policy" ||
    workspaceSnapshotLane === "profile" ||
    workspaceSnapshotLane === "relationship" ||
    workspaceSnapshotLane === "system_policy"
  ) {
    return false;
  }
  if (session.domainContext.dominantLane === "workflow") {
    return true;
  }
  if (session.domainContext.dominantLane === "profile" ||
      session.domainContext.dominantLane === "relationship" ||
      session.domainContext.dominantLane === "system_policy") {
    return false;
  }
  return Boolean(
    session.modeContinuity?.activeMode &&
      CONTINUABLE_HANDOFF_MODES.has(session.modeContinuity.activeMode)
  ) || session.domainContext.dominantLane === "unknown";
}

/**
 * Returns whether a bounded model-assisted resume check is allowed for this turn after the
 * deterministic return-handoff fast path has already failed.
 *
 * @param session - Current conversation session with durable handoff state.
 * @param userInput - Raw inbound user wording.
 * @param resolvedIntentMode - Canonical pre-continuity intent result.
 * @returns `true` when a bounded return-handoff interpretation call is allowed.
 */
export function shouldAttemptReturnHandoffContinuationInterpretation(
  session: ConversationSession,
  userInput: string,
  resolvedIntentMode: ResolvedConversationIntentMode
): boolean {
  if (!session.returnHandoff || !hasWorkflowCompatibleReturnHandoffContext(session)) {
    return false;
  }
  if (resolvedIntentMode.mode !== "chat" && resolvedIntentMode.mode !== "unclear") {
    return false;
  }
  if (resolvedIntentMode.clarification) {
    return false;
  }
  const normalized = normalizeWhitespace(userInput);
  if (!normalized || normalized.includes("\n") || normalized.length > RETURN_HANDOFF_INTERPRETATION_MAX_CHARS) {
    return false;
  }
  const recentIdentityContext = buildRecentIdentityInterpretationContext(
    session.conversationTurns.slice(-4)
  );
  if (shouldPreserveDeterministicDirectChatTurn(normalized, recentIdentityContext)) {
    return false;
  }
  if (
    isRecentAssistantAnswerThreadContinuationCandidate(
      normalized,
      buildRecentAssistantTurnContext(session)
    )
  ) {
    return false;
  }
  return resolveReturnHandoffContinuationIntent(session, userInput, resolvedIntentMode) === null;
}

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
  return hasAnyTokenSequence(
    collectConversationChatTurnRawTokens(normalized),
    RETURN_HANDOFF_CONTINUATION_SEQUENCES
  );
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
  if (!hasWorkflowCompatibleReturnHandoffContext(session)) {
    return null;
  }
  if (resolvedIntentMode.clarification) {
    return null;
  }

  const preferredMode = session.modeContinuity?.activeMode;
  const fallbackResumedMode = preferredMode && CONTINUABLE_HANDOFF_MODES.has(preferredMode)
    ? preferredMode
    : "build";
  const resumeRequested = isReturnHandoffContinuationRequest(userInput);
  if (isReturnHandoffContinuationSemanticHint(resolvedIntentMode.semanticHint)) {
    const resumedMode =
      CONTINUABLE_HANDOFF_MODES.has(resolvedIntentMode.mode)
        ? resolvedIntentMode.mode
        : fallbackResumedMode;
    return withReturnHandoffRouteMetadata({
      ...resolvedIntentMode,
      mode: resumedMode,
      matchedRuleId: "intent_mode_return_handoff_resume_semantic",
      explanation:
        "The intent layer recognized that the user wants to continue from the saved checkpoint instead of starting over.",
      clarification: null,
      semanticHint: "resume_handoff"
    });
  }
  if (
    isRecentAssistantAnswerThreadContinuationCandidate(
      userInput,
      buildRecentAssistantTurnContext(session)
    )
  ) {
    return null;
  }
  if (!resumeRequested) {
    if (resolvedIntentMode.mode !== "chat" && resolvedIntentMode.mode !== "unclear") {
      return null;
    }
    return null;
  }

  return withReturnHandoffRouteMetadata({
    mode: fallbackResumedMode,
    confidence: "high",
    matchedRuleId: "intent_mode_return_handoff_resume",
    explanation:
      "The user asked to continue prior work, and the session has a durable handoff checkpoint that can resume from the last completed or blocked state.",
    clarification: null,
    semanticHint: "resume_handoff"
  });
}

/**
 * Builds a promoted return-handoff continuation intent from a validated continuation-interpreter
 * result.
 *
 * @param session - Current conversation session.
 * @param explanation - Bounded explanation returned by continuation interpretation.
 * @param confidence - Confidence returned by continuation interpretation.
 * @returns Promoted continuation intent when durable handoff state supports resume.
 */
export function buildReturnHandoffContinuationInterpretationResolution(
  session: ConversationSession,
  explanation: string,
  confidence: "high" | "medium" | "low"
): ResolvedConversationIntentMode {
  const preferredMode = session.modeContinuity?.activeMode;
  const fallbackResumedMode =
    preferredMode && CONTINUABLE_HANDOFF_MODES.has(preferredMode) ? preferredMode : "build";
  return withReturnHandoffRouteMetadata({
    mode: fallbackResumedMode,
    confidence: confidence === "high" ? "high" : "medium",
    matchedRuleId: "intent_mode_return_handoff_resume_local_interpretation",
    explanation,
    clarification: null,
    semanticHint: "resume_handoff"
  });
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
    !hasWorkflowCompatibleReturnHandoffContext(session) ||
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
