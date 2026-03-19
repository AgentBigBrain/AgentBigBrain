/**
 * @fileoverview Resolves canonical intent modes and clarification candidates for the human-centric execution front door.
 */

import type { RoutingMapClassificationV1 } from "../routingMap";
import type {
  LocalIntentModelResolver,
  LocalIntentModelSessionHints
} from "../../organs/languageUnderstanding/localIntentModelContracts";
import { resolveClarificationOptions } from "../../organs/languageUnderstanding/clarificationIntentRanking";
import { resolveExecutionIntentUnderstanding } from "../../organs/languageUnderstanding/executionIntentUnderstanding";
import { resolveExecutionIntentClarification } from "./executionIntentClarification";
import { extractExecutionPreferences } from "./executionPreferenceExtraction";
import { isDirectConversationOnlyRequest } from "./directConversationIntent";
import type { ResolvedConversationIntentMode } from "./intentModeContracts";

const REVIEW_PATTERNS: readonly RegExp[] = [
  /\byou did (?:this|that) wrong\b/i,
  /\bthis is wrong\b/i,
  /\bfix what you did\b/i,
  /\bcorrect (?:this|that)\b/i,
  /\blook at (?:this|the) screenshot\b/i
] as const;

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
  sessionHints: LocalIntentModelSessionHints | null = null
): Promise<ResolvedConversationIntentMode> {
  const normalized = userInput.trim();
  if (!normalized) {
    return {
      mode: "chat",
      confidence: "low",
      matchedRuleId: "intent_mode_empty_input",
      explanation: "Empty input falls back to neutral chat mode.",
      clarification: null
    };
  }

  if (isDirectConversationOnlyRequest(normalized)) {
    return {
      mode: "chat",
      confidence: "high",
      matchedRuleId: "intent_mode_direct_conversation_only",
      explanation:
        "The user explicitly asked for a conversational interlude before any further changes or workflow actions.",
      clarification: null
    };
  }

  const preferences = extractExecutionPreferences(normalized);
  if (preferences.naturalSkillDiscovery) {
    return resolveExecutionIntentUnderstanding(
      normalized,
      routingClassification,
      {
        mode: "discover_available_capabilities",
        confidence: "high",
        matchedRuleId: "intent_mode_capability_discovery",
        explanation:
          "Natural-language request asks what the assistant can do here, including capabilities or reusable skills.",
        clarification: null
      },
      localIntentModelResolver,
      sessionHints
    );
  }

  if (preferences.statusOrRecall) {
    return resolveExecutionIntentUnderstanding(
      normalized,
      routingClassification,
      {
        mode: "status_or_recall",
        confidence: "high",
        matchedRuleId: "intent_mode_status_or_recall",
        explanation: "User asked what was created, where it was placed, what is happening now, or what was left open.",
        clarification: null
      },
      localIntentModelResolver,
      sessionHints
    );
  }

  if (preferences.planOnly) {
    return resolveExecutionIntentUnderstanding(
      normalized,
      routingClassification,
      {
        mode: "plan",
        confidence: "high",
        matchedRuleId: "intent_mode_plan_only",
        explanation: "User explicitly asked for planning or explanation without execution.",
        clarification: null
      },
      localIntentModelResolver,
      sessionHints
    );
  }

  if (preferences.autonomousExecution) {
    return resolveExecutionIntentUnderstanding(
      normalized,
      routingClassification,
      {
        mode: "autonomous",
        confidence: "high",
        matchedRuleId: "intent_mode_autonomous_execution",
        explanation:
          "User explicitly asked the assistant to own the task end to end until it is finished.",
        clarification: null
      },
      localIntentModelResolver,
      sessionHints
    );
  }

  if (preferences.executeNow) {
    return resolveExecutionIntentUnderstanding(
      normalized,
      routingClassification,
      {
        mode: "build",
        confidence: "high",
        matchedRuleId: "intent_mode_execute_now",
        explanation: "User explicitly asked to build or execute immediately.",
        clarification: null
      },
      localIntentModelResolver,
      sessionHints
    );
  }

  if (REVIEW_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return resolveExecutionIntentUnderstanding(
      normalized,
      routingClassification,
      {
        mode: "review",
        confidence: "medium",
        matchedRuleId: "intent_mode_review_feedback",
        explanation: "User appears to be correcting or reviewing prior work.",
        clarification: null
      },
      localIntentModelResolver,
      sessionHints
    );
  }

  const clarification = resolveExecutionIntentClarification(normalized, routingClassification);
  if (clarification.question && clarification.matchedRuleId && clarification.mode) {
    return resolveExecutionIntentUnderstanding(
      normalized,
      routingClassification,
      {
        mode: "unclear",
        confidence: "medium",
        matchedRuleId: clarification.matchedRuleId,
        explanation: "Execution-related request is ambiguous enough to require clarification.",
        clarification: {
          kind: "execution_mode",
          matchedRuleId: clarification.matchedRuleId,
          question: clarification.question,
          options: resolveClarificationOptions(clarification.mode)
        }
      },
      localIntentModelResolver,
      sessionHints
    );
  }

  return resolveExecutionIntentUnderstanding(
    normalized,
    routingClassification,
    {
      mode: "chat",
      confidence: "low",
      matchedRuleId: "intent_mode_default_chat",
      explanation: "No stronger execution or capability intent was detected.",
      clarification: null
    },
    localIntentModelResolver,
    sessionHints
  );
}
