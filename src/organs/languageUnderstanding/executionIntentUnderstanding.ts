/**
 * @fileoverview Canonical combination logic between deterministic front-door intent routing and the optional local intent-model path.
 */

import { routeLocalIntentModel } from "./localIntentModelRouter";
import type {
  ContextualFollowupInterpretationResolver,
  LocalIntentModelSessionHints,
  LocalIntentModelResolver
} from "./localIntentModelContracts";
import type { RoutingMapClassificationV1 } from "../../interfaces/routingMap";
import type { ResolvedConversationIntentMode } from "../../interfaces/conversationRuntime/intentModeContracts";
import {
  analyzeConversationChatTurnSignals,
  assessIdentityInterpretationEligibility,
  isRelationshipConversationRecallTurn,
  shouldPreserveDeterministicDirectChatTurn
} from "../../interfaces/conversationRuntime/chatTurnSignals";
import { resolveContextualFollowupIntentResolution } from "../../interfaces/conversationRuntime/contextualFollowupInterpretationSupport";
import { hasTurnLocalFirstPersonStatusUpdate } from "../../interfaces/conversationRuntime/turnLocalStatusUpdate";

/**
 * Maps intent-mode confidence labels to an ordinal rank so the deterministic path and local-model
 * path can be compared without opening a second planner surface.
 *
 * @param value - Intent-mode confidence label.
 * @returns Numeric rank where larger means stronger confidence.
 */
function confidenceRank(value: ResolvedConversationIntentMode["confidence"]): number {
  switch (value) {
    case "high":
      return 3;
    case "medium":
      return 2;
    default:
      return 1;
  }
}

/**
 * Returns whether a low-confidence direct-chat turn should stay deterministic instead of allowing
 * session-conditioned local-model reinterpretation.
 *
 * Ordinary greetings and direct identity-recall questions are frequently sent during or after
 * workflow sessions, but they should not be reclassified into status/recall just because the
 * session still carries a saved return-handoff checkpoint.
 *
 * @param userInput - Raw current user input.
 * @param deterministicResolution - Deterministic front-door resolution.
 * @returns `true` when the deterministic chat result should be preserved as-is.
 */
function shouldPreserveDeterministicDirectChat(
  userInput: string,
  deterministicResolution: ResolvedConversationIntentMode,
  sessionHints: LocalIntentModelSessionHints | null
): boolean {
  if (deterministicResolution.mode !== "chat") {
    return false;
  }
  const normalized = userInput.trim();
  if (!normalized) {
    return false;
  }
  if (hasTurnLocalFirstPersonStatusUpdate(normalized)) {
    return true;
  }
  if (isRelationshipConversationRecallTurn(normalized)) {
    return true;
  }
  const identityEligibility = assessIdentityInterpretationEligibility(normalized, {
    recentIdentityConversationActive: sessionHints?.recentIdentityConversationActive,
    recentAssistantIdentityPrompt: sessionHints?.hasRecentAssistantIdentityPrompt,
    recentAssistantIdentityAnswer: sessionHints?.hasRecentAssistantIdentityAnswer
  });
  if (
    shouldPreserveDeterministicDirectChatTurn(normalized, {
      recentIdentityConversationActive: sessionHints?.recentIdentityConversationActive,
      recentAssistantIdentityPrompt: sessionHints?.hasRecentAssistantIdentityPrompt,
      recentAssistantIdentityAnswer: sessionHints?.hasRecentAssistantIdentityAnswer
    })
  ) {
    return true;
  }
  const signals = analyzeConversationChatTurnSignals(normalized);
  return (
    identityEligibility.eligible ||
    signals.primaryKind === "approval_or_control" &&
    sessionHints?.hasRecentAssistantQuestion !== true
  );
}

/**
 * Returns the final intent-mode understanding for one user input by preferring strong deterministic
 * matches and consulting the optional local model only when the deterministic path stays weak.
 *
 * @param userInput - Raw current user input.
 * @param routingClassification - Deterministic routing hints for the same input.
 * @param deterministicResolution - Deterministic intent-mode result produced by the front-door rules.
 * @param localIntentModelResolver - Optional local model resolver.
 * @returns Final resolved intent-mode signal.
 */
export async function resolveExecutionIntentUnderstanding(
  userInput: string,
  routingClassification: RoutingMapClassificationV1 | null,
  deterministicResolution: ResolvedConversationIntentMode,
  localIntentModelResolver?: LocalIntentModelResolver,
  sessionHints: LocalIntentModelSessionHints | null = null,
  contextualFollowupInterpretationResolver?: ContextualFollowupInterpretationResolver,
  options: {
    suppressGenericLocalIntentModel?: boolean;
  } = {}
): Promise<ResolvedConversationIntentMode> {
  if (confidenceRank(deterministicResolution.confidence) >= 3) {
    return deterministicResolution;
  }
  if (shouldPreserveDeterministicDirectChat(userInput, deterministicResolution, sessionHints)) {
    return deterministicResolution;
  }
  const contextualFollowupResolution = await resolveContextualFollowupIntentResolution(
    userInput,
    deterministicResolution,
    routingClassification,
    sessionHints,
    contextualFollowupInterpretationResolver
  );
  if (contextualFollowupResolution.resolvedIntentMode) {
    return contextualFollowupResolution.resolvedIntentMode;
  }
  if (contextualFollowupResolution.preserveDeterministic) {
    return deterministicResolution;
  }
  if (options.suppressGenericLocalIntentModel) {
    return deterministicResolution;
  }

  const localSignal = await routeLocalIntentModel(
    {
      userInput,
      routingClassification,
      sessionHints
    },
    localIntentModelResolver
  );

  if (!localSignal) {
    return deterministicResolution;
  }

  const localRank = confidenceRank(localSignal.confidence);
  const deterministicRank = confidenceRank(deterministicResolution.confidence);
  if (localRank > deterministicRank) {
    return localSignal;
  }
  if (
    localRank === deterministicRank &&
    localSignal.mode !== deterministicResolution.mode
  ) {
    return localSignal;
  }
  return deterministicResolution;
}
