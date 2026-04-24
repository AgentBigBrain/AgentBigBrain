/**
 * @fileoverview Canonical intent-mode contracts for the human-centric execution front door.
 */

import type {
  ClarificationRenderingIntent,
  ClarificationOptionId,
  ConversationIntentMode
} from "../sessionStore";

export type IntentModeConfidence = "high" | "medium" | "low";
export type ConversationSemanticRouteId =
  | "chat_answer"
  | "relationship_recall"
  | "status_recall"
  | "plan_request"
  | "build_request"
  | "static_html_build"
  | "framework_app_build"
  | "clarify_build_format"
  | "clarify_execution_mode"
  | "autonomous_execution"
  | "review_feedback"
  | "capability_discovery";
export type ConversationIntentSemanticHint =
  | "review_ready"
  | "guided_review"
  | "next_review_step"
  | "while_away_review"
  | "wrap_up_summary"
  | "explain_handoff"
  | "resume_handoff"
  | "status_change_summary"
  | "status_return_handoff"
  | "status_location"
  | "status_browser"
  | "status_progress"
  | "status_waiting";

export interface IntentClarificationCandidate {
  kind: "execution_mode" | "build_format";
  matchedRuleId: string;
  renderingIntent: ClarificationRenderingIntent;
  question: string;
  options: readonly {
    id: ClarificationOptionId;
    label: string;
  }[];
}

export interface ResolvedConversationIntentMode {
  mode: ConversationIntentMode;
  confidence: IntentModeConfidence;
  matchedRuleId: string;
  explanation: string;
  clarification: IntentClarificationCandidate | null;
  semanticRouteId?: ConversationSemanticRouteId | null;
  semanticHint?: ConversationIntentSemanticHint | null;
}

/**
 * Semantics route id to intent mode.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ConversationIntentMode` (import `ConversationIntentMode`) from `../sessionStore`.
 * @param semanticRouteId - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function semanticRouteIdToIntentMode(
  semanticRouteId: ConversationSemanticRouteId
): ConversationIntentMode {
  switch (semanticRouteId) {
    case "chat_answer":
    case "relationship_recall":
      return "chat";
    case "status_recall":
      return "status_or_recall";
    case "plan_request":
      return "plan";
    case "build_request":
      return "build";
    case "static_html_build":
      return "static_html_build";
    case "framework_app_build":
      return "framework_app_build";
    case "clarify_build_format":
      return "clarify_build_format";
    case "clarify_execution_mode":
      return "unclear";
    case "autonomous_execution":
      return "autonomous";
    case "review_feedback":
      return "review";
    case "capability_discovery":
      return "discover_available_capabilities";
  }
}

/**
 * Infers semantic route id from intent mode.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ConversationIntentMode` (import `ConversationIntentMode`) from `../sessionStore`.
 * @param mode - Input consumed by this helper.
 * @param semanticHint - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function inferSemanticRouteIdFromIntentMode(
  mode: ConversationIntentMode,
  semanticHint: ConversationIntentSemanticHint | null = null
): ConversationSemanticRouteId {
  switch (mode) {
    case "chat":
      return "chat_answer";
    case "status_or_recall":
      return "status_recall";
    case "plan":
      return "plan_request";
    case "build":
      return semanticHint === "resume_handoff" ? "build_request" : "build_request";
    case "static_html_build":
      return "static_html_build";
    case "framework_app_build":
      return "framework_app_build";
    case "clarify_build_format":
      return "clarify_build_format";
    case "autonomous":
      return "autonomous_execution";
    case "review":
      return "review_feedback";
    case "discover_available_capabilities":
      return "capability_discovery";
    case "unclear":
    case "explain":
    default:
      return "clarify_execution_mode";
  }
}

/**
 * Returns semantic route id.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param resolution - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
export function withSemanticRouteId(
  resolution: ResolvedConversationIntentMode
): ResolvedConversationIntentMode {
  if (resolution.semanticRouteId) {
    return resolution;
  }
  return {
    ...resolution,
    semanticRouteId: inferSemanticRouteIdFromIntentMode(
      resolution.mode,
      resolution.semanticHint ?? null
    )
  };
}
