/**
 * @fileoverview Resolves canonical intent modes and clarification candidates for the human-centric execution front door.
 */

import {
  classifyRoutingIntentV1,
  type RoutingMapClassificationV1
} from "../routingMap";
import type {
  AutonomyBoundaryInterpretationResolver,
  ContextualFollowupInterpretationResolver,
  LocalIntentModelResolver,
  LocalIntentModelSessionHints,
  StatusRecallBoundaryInterpretationResolver
} from "../../organs/languageUnderstanding/localIntentModelContracts";
import { resolveClarificationOptions } from "../../organs/languageUnderstanding/clarificationIntentRanking";
import { resolveExecutionIntentUnderstanding } from "../../organs/languageUnderstanding/executionIntentUnderstanding";
import { resolveExecutionIntentClarification } from "./executionIntentClarification";
import { extractExecutionPreferences } from "./executionPreferenceExtraction";
import { isDirectConversationOnlyRequest } from "./directConversationIntent";
import {
  type ResolvedConversationIntentMode,
  withSemanticRouteId
} from "./intentModeContracts";
import { resolveExplicitBuildFormatMetadata } from "./buildFormatMetadata";
import {
  resolveConversationAutonomyBoundaryInterpretationIntent,
  resolveConversationStatusRecallBoundaryInterpretationIntent
} from "./conversationRoutingSupport";
import {
  buildBuildFormatClarificationResolution,
  ensureStructuredBuildFormatClarification,
  EXPLICIT_FRAMEWORK_MENTION_PATTERN,
  hasReviewFeedbackShape
} from "./intentModeBuildFormatSupport";
import {
  analyzeConversationChatTurnSignals,
  isRelationshipConversationRecallTurn
} from "./chatTurnSignals";
import { isRecentAssistantAnswerThreadContinuationCandidate } from "./recentAssistantTurnContext";
import {
  resolveContextualFollowupIntentResolution,
  resolveDeterministicContextualFollowupIntent
} from "./contextualFollowupInterpretationSupport";
import {
  shouldAttemptAutonomyBoundaryInterpretation,
  shouldPromoteAmbiguousAutonomousExecution
} from "./sessionDomainRouting";
import {
  isDeterministicFrameworkBuildLaneRequest,
  isStaticHtmlExecutionStyleRequest
} from "../../organs/plannerPolicy/liveVerificationPolicy";
import {
  buildDefaultChatIntentMode,
  shouldClarifyBuildFormatRequest
} from "./intentModeResolutionSupport";

/**
 * Resolves one user utterance into a canonical intent mode plus optional clarification candidate.
 *
 * @param userInput - Raw user text being classified.
 * @param routingClassification - Deterministic routing-map classification for supplemental hints.
 * @param localIntentModelResolver - Optional local intent-model resolver used only when deterministic confidence stays weak.
 * @returns Canonical intent-mode resolution for the conversation front door.
 */
export async function resolveConversationIntentMode(
  userInput: string,
  routingClassification: RoutingMapClassificationV1 | null = null,
  localIntentModelResolver?: LocalIntentModelResolver,
  sessionHints: LocalIntentModelSessionHints | null = null,
  contextualFollowupInterpretationResolver?: ContextualFollowupInterpretationResolver,
  autonomyBoundaryInterpretationResolver?: AutonomyBoundaryInterpretationResolver,
  statusRecallBoundaryInterpretationResolver?: StatusRecallBoundaryInterpretationResolver
): Promise<ResolvedConversationIntentMode> {
  const normalized = userInput.trim();
  const finalizeResolution = (
    resolution: ResolvedConversationIntentMode
  ): ResolvedConversationIntentMode => withSemanticRouteId(resolution);
  const effectiveRoutingClassification =
    routingClassification ?? classifyRoutingIntentV1(normalized);
  const resolveExecutionUnderstanding = async (
    deterministicResolution: ResolvedConversationIntentMode,
    options: {
      suppressGenericLocalIntentModel?: boolean;
    } = {}
  ): Promise<ResolvedConversationIntentMode> =>
    ensureStructuredBuildFormatClarification(
      await resolveExecutionIntentUnderstanding(
        normalized,
        effectiveRoutingClassification,
        deterministicResolution,
        localIntentModelResolver,
        sessionHints,
        contextualFollowupInterpretationResolver,
        options
      )
    );
  if (!normalized) {
    return finalizeResolution({
      mode: "chat",
      confidence: "low",
      matchedRuleId: "intent_mode_empty_input",
      explanation: "Empty input falls back to neutral chat mode.",
      clarification: null,
      semanticRouteId: "chat_answer"
    });
  }

  if (isDirectConversationOnlyRequest(normalized)) {
    return finalizeResolution({
      mode: "chat",
      confidence: "high",
      matchedRuleId: "intent_mode_direct_conversation_only",
      explanation:
        "The user explicitly asked for a conversational interlude before any further changes or workflow actions.",
      clarification: null,
      semanticRouteId: "chat_answer"
    });
  }

  if (
    isRecentAssistantAnswerThreadContinuationCandidate(normalized, {
      recentAssistantTurnKind: sessionHints?.recentAssistantTurnKind ?? null,
      recentAssistantAnswerThreadActive:
        sessionHints?.recentAssistantAnswerThreadActive === true
    })
  ) {
    return finalizeResolution({
      mode: "chat",
      confidence: "medium",
      matchedRuleId: "intent_mode_recent_answer_thread_chat",
      explanation:
        "The latest assistant turn was an informational answer, so this short ambiguous follow-up should stay on the conversational answer thread unless the user explicitly re-anchors to work.",
      clarification: null,
      semanticRouteId: "chat_answer"
    });
  }

  const preferences = extractExecutionPreferences(normalized);
  const explicitStaticHtmlBuildRequested = isStaticHtmlExecutionStyleRequest(normalized);
  const explicitFrameworkMention = EXPLICIT_FRAMEWORK_MENTION_PATTERN.test(normalized);
  const explicitFrameworkBuildRequested =
    explicitFrameworkMention &&
    isDeterministicFrameworkBuildLaneRequest(normalized);
  const explicitBuildFormat = resolveExplicitBuildFormatMetadata(
    normalized,
    explicitStaticHtmlBuildRequested,
    explicitFrameworkBuildRequested
  );
  const relationshipConversationRecall =
    isRelationshipConversationRecallTurn(normalized);
  const shouldDeterministicallyPromoteAmbiguousAutonomy =
    preferences.autonomousExecutionStrength === "ambiguous" &&
    shouldPromoteAmbiguousAutonomousExecution(
      normalized,
      effectiveRoutingClassification,
      sessionHints
    );
  const autonomousExecutionDetected =
    preferences.autonomousExecutionStrength === "strong" ||
    shouldDeterministicallyPromoteAmbiguousAutonomy;
  const shouldAttemptAutonomyBoundaryResolution =
    preferences.autonomousExecutionStrength === "ambiguous" &&
    !shouldDeterministicallyPromoteAmbiguousAutonomy &&
    shouldAttemptAutonomyBoundaryInterpretation(
      effectiveRoutingClassification,
      sessionHints
    );
  let suppressGenericLocalIntentModel = false;
  if (preferences.naturalSkillDiscovery) {
    return finalizeResolution(await resolveExecutionUnderstanding(
      {
        mode: "discover_available_capabilities",
        confidence: "high",
        matchedRuleId: "intent_mode_capability_discovery",
        explanation:
          "Natural-language request asks what the assistant can do here, including capabilities or reusable skills.",
        clarification: null,
        semanticRouteId: "capability_discovery"
      }
    ));
  }

  if (
    relationshipConversationRecall &&
    !preferences.executeNow
  ) {
    return finalizeResolution(await resolveExecutionUnderstanding(
      {
        mode: "chat",
        confidence: "medium",
        matchedRuleId: "intent_mode_relationship_recall_chat",
        explanation:
          "Status-shaped wording still targets a person or relationship recall question, so it should stay on the conversational memory path.",
        clarification: null,
        semanticRouteId: "relationship_recall"
      }
    ));
  }

  if (
    preferences.statusOrRecall
  ) {
    if (preferences.executeNow) {
      const statusRecallBoundaryResolution =
        await resolveConversationStatusRecallBoundaryInterpretationIntent(
          normalized,
          effectiveRoutingClassification,
          sessionHints,
          statusRecallBoundaryInterpretationResolver
      );
      if (statusRecallBoundaryResolution) {
        return finalizeResolution(statusRecallBoundaryResolution);
      }
    }
    return finalizeResolution(await resolveExecutionUnderstanding(
      {
        mode: "status_or_recall",
        confidence: "high",
        matchedRuleId: "intent_mode_status_or_recall",
        explanation: "User asked what was created, where it was placed, what is happening now, or what was left open.",
        clarification: null,
        semanticRouteId: "status_recall"
      }
    ));
  }

  if (preferences.planOnly) {
    return finalizeResolution(await resolveExecutionUnderstanding(
      {
        mode: "plan",
        confidence: "high",
        matchedRuleId: "intent_mode_plan_only",
        explanation: "User explicitly asked for planning or explanation without execution.",
        clarification: null,
        semanticRouteId: "plan_request"
      }
    ));
  }

  const deterministicContextualFollowupIntent = resolveDeterministicContextualFollowupIntent(
    normalized
  );
  if (deterministicContextualFollowupIntent) {
    return finalizeResolution(deterministicContextualFollowupIntent);
  }

  if (shouldClarifyBuildFormatRequest({
    normalized,
    planOnly: preferences.planOnly,
    statusOrRecall: preferences.statusOrRecall,
    explicitStaticHtmlBuildRequested,
    explicitFrameworkBuildRequested
  })) {
    return finalizeResolution(buildBuildFormatClarificationResolution(
      "intent_mode_build_format_clarify_execution_style",
      "The user is clearly asking for a build, and they either named an exact destination or explicitly signaled HTML-versus-framework ambiguity, so the runtime should ask whether they want plain HTML or a framework app."
    ));
  }

  if (autonomousExecutionDetected) {
    return finalizeResolution(await resolveExecutionUnderstanding(
      {
        mode: "autonomous",
        confidence: "high",
        matchedRuleId: "intent_mode_autonomous_execution",
        explanation:
          "User explicitly asked the assistant to own the task end to end until it is finished.",
        clarification: null,
        semanticRouteId: "autonomous_execution",
        buildFormat: explicitBuildFormat
      },
      {
        suppressGenericLocalIntentModel
      }
    ));
  }

  if (explicitStaticHtmlBuildRequested) {
    return finalizeResolution(await resolveExecutionUnderstanding(
      {
        mode: "static_html_build",
        confidence: "high",
        matchedRuleId: "intent_mode_static_html_build",
        explanation:
          "The request explicitly asks for a plain static HTML deliverable, so it should use the bounded static HTML build lane.",
        clarification: null,
        semanticRouteId: "static_html_build",
        buildFormat: explicitBuildFormat
      },
      {
        suppressGenericLocalIntentModel: true
      }
    ));
  }

  if (explicitFrameworkBuildRequested) {
    return finalizeResolution(await resolveExecutionUnderstanding(
      {
        mode: "framework_app_build",
        confidence: "high",
        matchedRuleId: "intent_mode_framework_app_build",
        explanation:
          "The request explicitly asks for a framework app build, so it should stay on the framework-app build lane.",
        clarification: null,
        semanticRouteId: "framework_app_build",
        buildFormat: explicitBuildFormat
      },
      {
        suppressGenericLocalIntentModel: true
      }
    ));
  }

  if (shouldAttemptAutonomyBoundaryResolution) {
    const autonomyBoundaryResolution =
      await resolveConversationAutonomyBoundaryInterpretationIntent(
        normalized,
        effectiveRoutingClassification,
        sessionHints,
        autonomyBoundaryInterpretationResolver
    );
    if (autonomyBoundaryResolution) {
      return finalizeResolution(autonomyBoundaryResolution);
    }
    suppressGenericLocalIntentModel = true;
  }

  const clarification = resolveExecutionIntentClarification(
    normalized,
    effectiveRoutingClassification
  );
  if (clarification.question && clarification.matchedRuleId && clarification.mode) {
    return finalizeResolution(await resolveExecutionUnderstanding(
      {
        mode: "unclear",
        confidence: "medium",
        matchedRuleId: clarification.matchedRuleId,
        explanation: "Execution-related request is ambiguous enough to require clarification.",
        clarification: {
          kind: "execution_mode",
          matchedRuleId: clarification.matchedRuleId,
          renderingIntent:
            clarification.mode === "plan_or_build"
              ? "plan_or_build"
              : "fix_or_explain",
          question: clarification.question,
          options: resolveClarificationOptions(clarification.mode)
        },
        semanticRouteId: "clarify_execution_mode"
      },
      {
        suppressGenericLocalIntentModel: true
      }
    ));
  }

  if (
    effectiveRoutingClassification?.category === "BUILD_SCAFFOLD" &&
    effectiveRoutingClassification.confidenceTier === "HIGH"
  ) {
    return finalizeResolution(await resolveExecutionUnderstanding(
      {
        mode: "build",
        confidence: "high",
        matchedRuleId: "intent_mode_routing_map_build_scaffold",
        explanation:
          "The deterministic routing map already classifies this as a high-confidence scaffold/build request with concrete execution context, so it should go straight to the build path instead of asking for another plan-or-build clarification.",
        clarification: null,
        semanticRouteId: "build_request"
      },
      {
        suppressGenericLocalIntentModel
      }
    ));
  }

  if (preferences.executeNow) {
    return finalizeResolution(await resolveExecutionUnderstanding(
      {
        mode: "build",
        confidence: "high",
        matchedRuleId: "intent_mode_execute_now",
        explanation: "User explicitly asked to build or execute immediately.",
        clarification: null,
        semanticRouteId: "build_request"
      },
      {
        suppressGenericLocalIntentModel
      }
    ));
  }

  if (hasReviewFeedbackShape(normalized)) {
    return finalizeResolution(await resolveExecutionUnderstanding(
      {
        mode: "review",
        confidence: "medium",
        matchedRuleId: "intent_mode_review_feedback",
        explanation: "User appears to be correcting or reviewing prior work.",
        clarification: null,
        semanticRouteId: "review_feedback"
      },
      {
        suppressGenericLocalIntentModel
      }
    ));
  }

  const structuralTurnSignals = analyzeConversationChatTurnSignals(normalized);
  if (
    structuralTurnSignals.primaryKind === "workflow_candidate" &&
    structuralTurnSignals.containsWorkflowCallbackCue
  ) {
    return finalizeResolution(await resolveExecutionUnderstanding(
      {
        mode: "build",
        confidence: "high",
        matchedRuleId: "intent_mode_structural_workflow_callback",
        explanation:
          "Structural turn signals detected callback-style workflow language that should stay on the work path rather than drifting onto identity chat.",
        clarification: null,
        semanticRouteId: "build_request"
      },
      {
        suppressGenericLocalIntentModel
      }
    ));
  }

  const contextualFollowupResolution = await resolveContextualFollowupIntentResolution(
    normalized,
    buildDefaultChatIntentMode(),
    effectiveRoutingClassification,
    sessionHints,
    contextualFollowupInterpretationResolver
  );
  if (contextualFollowupResolution.resolvedIntentMode) {
    return finalizeResolution(contextualFollowupResolution.resolvedIntentMode);
  }
  if (contextualFollowupResolution.preserveDeterministic) {
    return finalizeResolution(buildDefaultChatIntentMode());
  }

  return finalizeResolution(await resolveExecutionIntentUnderstanding(
    normalized,
    effectiveRoutingClassification,
    buildDefaultChatIntentMode(),
    suppressGenericLocalIntentModel ? undefined : localIntentModelResolver,
    sessionHints,
    contextualFollowupInterpretationResolver
  ));
}
