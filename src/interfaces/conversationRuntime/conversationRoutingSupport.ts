/**
 * @fileoverview Small helper utilities reused by the stable conversation-routing entrypoint.
 */

import type { ConversationSession } from "../sessionStore";
import type {
  AutonomyBoundaryInterpretationResolver,
  LocalIntentModelSessionHints
} from "../../organs/languageUnderstanding/localIntentModelContracts";
import type {
  ContinuationInterpretationResolver,
  StatusRecallBoundaryFocus,
  StatusRecallBoundaryInterpretationResolver
} from "../../organs/languageUnderstanding/localIntentModelContracts";
import {
  routeAutonomyBoundaryInterpretationModel,
  routeContinuationInterpretationModel,
  routeStatusRecallBoundaryInterpretationModel
} from "../../organs/languageUnderstanding/localIntentModelRouter";
import type { RoutingMapClassificationV1 } from "../routingMap";
import type { ResolvedConversationIntentMode } from "./intentModeContracts";
import { isLikelyAssistantClarificationPrompt } from "../conversationManagerHelpers";
import {
  buildRecentIdentityInterpretationContext
} from "./chatTurnSignals";
import {
  buildModeContinuityInterpretationResolution,
  shouldAttemptModeContinuityInterpretation
} from "./modeContinuity";
import { buildRecentAssistantTurnContext } from "./recentAssistantTurnContext";
import {
  buildReturnHandoffContinuationInterpretationResolution,
  shouldAttemptReturnHandoffContinuationInterpretation
} from "./returnHandoffContinuation";
import {
  buildConversationDomainSessionHints,
  hasConversationDomainSessionHints
} from "./sessionDomainRouting";

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
  const lastAssistantTurn = [...session.conversationTurns]
    .reverse()
    .find((turn) => turn.role === "assistant");
  const recentAssistantTurnContext = buildRecentAssistantTurnContext(session);
  const recentTurns = session.conversationTurns.slice(-4);
  const recentIdentityContext = buildRecentIdentityInterpretationContext(recentTurns);
  const hasRecentAssistantIdentityPrompt =
    recentIdentityContext.recentAssistantIdentityPrompt === true;
  const hasRecentAssistantIdentityAnswer =
    recentIdentityContext.recentAssistantIdentityAnswer === true;
  const recentIdentityConversationActive =
    recentIdentityContext.recentIdentityConversationActive === true;
  if (
    !session.returnHandoff &&
    !session.modeContinuity &&
    !session.activeWorkspace &&
    !hasConversationDomainSessionHints(session) &&
    !hasRecentAssistantIdentityPrompt &&
    !hasRecentAssistantIdentityAnswer &&
    !recentIdentityConversationActive
  ) {
    return null;
  }

  const domainHints = buildConversationDomainSessionHints(session);
  return {
    hasActiveWorkspace: domainHints.hasActiveWorkspace,
    hasReturnHandoff: session.returnHandoff !== null,
    hasRecentAssistantQuestion:
      typeof lastAssistantTurn?.text === "string" &&
      isLikelyAssistantClarificationPrompt(lastAssistantTurn.text),
    hasRecentAssistantIdentityPrompt,
    hasRecentAssistantIdentityAnswer,
    recentAssistantTurnKind: recentAssistantTurnContext.recentAssistantTurnKind,
    recentAssistantAnswerThreadActive:
      recentAssistantTurnContext.recentAssistantAnswerThreadActive,
    recentIdentityConversationActive,
    returnHandoffStatus: session.returnHandoff?.status ?? null,
    returnHandoffPreviewAvailable: session.returnHandoff?.previewUrl !== null,
    returnHandoffPrimaryArtifactAvailable:
      session.returnHandoff?.primaryArtifactPath !== null,
    returnHandoffChangedPathCount: session.returnHandoff?.changedPaths.length ?? 0,
    returnHandoffNextSuggestedStepAvailable:
      session.returnHandoff?.nextSuggestedStep !== null &&
      session.returnHandoff?.nextSuggestedStep !== undefined,
    modeContinuity: session.modeContinuity?.activeMode ?? null,
    domainDominantLane: domainHints.domainDominantLane,
    domainContinuityActive: domainHints.domainContinuityActive,
    workflowContinuityActive: domainHints.workflowContinuityActive
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

/**
 * Resolves one bounded autonomy-boundary interpretation for ambiguous ownership wording after the
 * deterministic strong path declined to promote.
 *
 * @param userInput - Raw current user wording.
 * @param routingClassification - Deterministic routing hint for the same turn.
 * @param sessionHints - Bounded session hints exposed to the shared local conversational runtime.
 * @param autonomyBoundaryInterpretationResolver - Optional autonomy-boundary interpreter.
 * @returns Promoted canonical intent result when the bounded model result is validated, otherwise
 *   `null`.
 */
export async function resolveConversationAutonomyBoundaryInterpretationIntent(
  userInput: string,
  routingClassification: RoutingMapClassificationV1 | null,
  sessionHints: LocalIntentModelSessionHints | null,
  autonomyBoundaryInterpretationResolver?: AutonomyBoundaryInterpretationResolver
): Promise<ResolvedConversationIntentMode | null> {
  const autonomyBoundaryInterpretation = await routeAutonomyBoundaryInterpretationModel(
    {
      userInput,
      routingClassification,
      sessionHints,
      deterministicSignalStrength: "ambiguous"
    },
    autonomyBoundaryInterpretationResolver
  );
  if (
    !autonomyBoundaryInterpretation ||
    autonomyBoundaryInterpretation.confidence === "low" ||
    autonomyBoundaryInterpretation.kind === "uncertain"
  ) {
    return null;
  }
  switch (autonomyBoundaryInterpretation.kind) {
    case "promote_to_autonomous":
      return {
        mode: "autonomous",
        confidence: autonomyBoundaryInterpretation.confidence,
        matchedRuleId: "intent_mode_autonomy_boundary_model_autonomous",
        explanation: autonomyBoundaryInterpretation.explanation,
        clarification: null
      };
    case "keep_as_build":
      return {
        mode: "build",
        confidence: autonomyBoundaryInterpretation.confidence,
        matchedRuleId: "intent_mode_autonomy_boundary_model_build",
        explanation: autonomyBoundaryInterpretation.explanation,
        clarification: null
      };
    case "keep_as_chat":
      return {
        mode: "chat",
        confidence: autonomyBoundaryInterpretation.confidence,
        matchedRuleId: "intent_mode_autonomy_boundary_model_chat",
        explanation: autonomyBoundaryInterpretation.explanation,
        clarification: null
      };
    default:
      return null;
  }
}

/**
 * Maps one bounded status/recall focus emitted by the shared interpreter back into the existing
 * semantic-hint contract consumed by status rendering.
 *
 * @param focus - Optional bounded status focus from the interpreter.
 * @returns Canonical semantic hint used by downstream status rendering, or `null`.
 */
function mapStatusRecallBoundaryFocusToSemanticHint(
  focus: StatusRecallBoundaryFocus
): ResolvedConversationIntentMode["semanticHint"] {
  switch (focus) {
    case "change_summary":
      return "status_change_summary";
    case "return_handoff":
      return "status_return_handoff";
    case "location":
      return "status_location";
    case "browser":
      return "status_browser";
    case "progress":
      return "status_progress";
    case "waiting":
      return "status_waiting";
    default:
      return null;
  }
}

/**
 * Resolves one bounded status/recall-vs-execute-now boundary interpretation for ambiguous mixed
 * wording after deterministic lexical paths found both signals.
 *
 * @param userInput - Raw current user wording.
 * @param routingClassification - Deterministic routing hint for the same turn.
 * @param sessionHints - Bounded session hints exposed to the shared local conversational runtime.
 * @param statusRecallBoundaryInterpretationResolver - Optional boundary interpreter.
 * @returns Validated canonical intent result when the bounded model result is accepted, otherwise
 *   `null`.
 */
export async function resolveConversationStatusRecallBoundaryInterpretationIntent(
  userInput: string,
  routingClassification: RoutingMapClassificationV1 | null,
  sessionHints: LocalIntentModelSessionHints | null,
  statusRecallBoundaryInterpretationResolver?: StatusRecallBoundaryInterpretationResolver
): Promise<ResolvedConversationIntentMode | null> {
  const boundaryInterpretation = await routeStatusRecallBoundaryInterpretationModel(
    {
      userInput,
      routingClassification,
      sessionHints,
      deterministicPreference: "status_or_recall"
    },
    statusRecallBoundaryInterpretationResolver
  );
  if (
    !boundaryInterpretation ||
    boundaryInterpretation.confidence === "low" ||
    boundaryInterpretation.kind === "uncertain" ||
    boundaryInterpretation.kind === "non_status_boundary"
  ) {
    return null;
  }
  switch (boundaryInterpretation.kind) {
    case "status_or_recall":
      return {
        mode: "status_or_recall",
        confidence: boundaryInterpretation.confidence,
        matchedRuleId: "intent_mode_status_recall_boundary_model_status",
        explanation: boundaryInterpretation.explanation,
        clarification: null,
        semanticHint: mapStatusRecallBoundaryFocusToSemanticHint(boundaryInterpretation.focus)
      };
    case "execute_now":
      return {
        mode: "build",
        confidence: boundaryInterpretation.confidence,
        matchedRuleId: "intent_mode_status_recall_boundary_model_build",
        explanation: boundaryInterpretation.explanation,
        clarification: null
      };
    default:
      return null;
  }
}

/**
 * Resolves one bounded continuation-interpretation promotion for ambiguous continuity leftovers
 * after deterministic resume/continuation fast paths failed.
 *
 * @param session - Current conversation session.
 * @param userInput - Raw current user wording.
 * @param resolvedIntentMode - Canonical pre-promotion intent result.
 * @param continuationInterpretationResolver - Optional shared continuation interpreter.
 * @param routingClassification - Deterministic routing hint for the same turn.
 * @returns Promoted continuation intent when the bounded model result is validated, otherwise `null`.
 */
export async function resolveConversationContinuationInterpretationIntent(
  session: ConversationSession,
  userInput: string,
  resolvedIntentMode: ResolvedConversationIntentMode,
  continuationInterpretationResolver?: ContinuationInterpretationResolver,
  routingClassification: RoutingMapClassificationV1 | null = null
): Promise<ResolvedConversationIntentMode | null> {
  const shouldAttemptReturnHandoff = shouldAttemptReturnHandoffContinuationInterpretation(
    session,
    userInput,
    resolvedIntentMode
  );
  const shouldAttemptModeContinuity = shouldAttemptModeContinuityInterpretation(
    session,
    userInput,
    resolvedIntentMode
  );
  if (!continuationInterpretationResolver || (!shouldAttemptReturnHandoff && !shouldAttemptModeContinuity)) {
    return null;
  }
  const lastAssistantTurn = [...session.conversationTurns]
    .reverse()
    .find((turn) => turn.role === "assistant");
  const continuationInterpretation = await routeContinuationInterpretationModel(
    {
      userInput,
      routingClassification,
      sessionHints: buildLocalIntentSessionHints(session),
      recentAssistantTurn: typeof lastAssistantTurn?.text === "string" ? lastAssistantTurn.text : null
    },
    continuationInterpretationResolver
  );
  if (!continuationInterpretation || continuationInterpretation.confidence === "low") {
    return null;
  }
  if (
    shouldAttemptReturnHandoff &&
    continuationInterpretation.kind === "return_handoff_resume" &&
    continuationInterpretation.continuationTarget === "return_handoff"
  ) {
    return buildReturnHandoffContinuationInterpretationResolution(
      session,
      continuationInterpretation.explanation,
      continuationInterpretation.confidence
    );
  }
  if (
    shouldAttemptModeContinuity &&
    continuationInterpretation.kind === "mode_continuation" &&
    continuationInterpretation.continuationTarget === "mode_continuity"
  ) {
    return buildModeContinuityInterpretationResolution(
      session,
      continuationInterpretation.explanation,
      continuationInterpretation.confidence
    );
  }
  return null;
}
