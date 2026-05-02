/**
 * @fileoverview Canonical intent-mode contracts for the human-centric execution front door.
 */

import type {
  ClarificationRenderingIntent,
  ClarificationOptionId,
  ConversationIntentMode
} from "../sessionStore";
import type { SourceAuthority } from "../../core/sourceAuthority";

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
export type ConversationBuildFormatId =
  | "static_html"
  | "framework_app"
  | "nextjs"
  | "react"
  | "vite";
export type ConversationBuildFormatSource =
  | "explicit_user_request"
  | "clarification"
  | "semantic_route";
export type ConversationSemanticRouteSource =
  | "model"
  | "clarification"
  | "exact_command"
  | "deterministic_safety"
  | "deterministic_signal"
  | "compatibility";
export type ConversationRouteSourceAuthority = SourceAuthority;
export type ConversationRouteExecutionMode =
  | "chat"
  | "plan"
  | "build"
  | "autonomous"
  | "status_or_recall"
  | "review"
  | "capability_discovery"
  | "unclear";
export type ConversationRouteContinuationKind =
  | "none"
  | "answer_thread"
  | "workflow_resume"
  | "return_handoff"
  | "contextual_followup"
  | "relationship_memory";
export type ConversationRouteMemoryIntent =
  | "none"
  | "relationship_recall"
  | "profile_update"
  | "contextual_recall"
  | "document_derived_recall";
export type ConversationRuntimeControlIntent =
  | "none"
  | "open_browser"
  | "close_browser"
  | "verify_browser"
  | "inspect_runtime"
  | "stop_runtime";

export interface ConversationBuildFormatMetadata {
  format: ConversationBuildFormatId;
  source: ConversationBuildFormatSource;
  confidence: IntentModeConfidence;
}

export interface ConversationExplicitRouteConstraints {
  disallowBrowserOpen: boolean;
  disallowServerStart: boolean;
  requiresUserOwnedLocation: boolean;
}

export interface ConversationSemanticRouteMetadata {
  routeId: ConversationSemanticRouteId;
  confidence: IntentModeConfidence;
  source: ConversationSemanticRouteSource;
  sourceAuthority: ConversationRouteSourceAuthority;
  buildFormat: ConversationBuildFormatMetadata | null;
  executionMode: ConversationRouteExecutionMode;
  continuationKind: ConversationRouteContinuationKind;
  memoryIntent: ConversationRouteMemoryIntent;
  runtimeControlIntent: ConversationRuntimeControlIntent;
  explicitConstraints: ConversationExplicitRouteConstraints;
}

export interface ConversationSemanticRouteMetadataOverrides {
  routeId?: ConversationSemanticRouteId | null;
  confidence?: IntentModeConfidence;
  source?: ConversationSemanticRouteSource;
  sourceAuthority?: ConversationRouteSourceAuthority;
  buildFormat?: ConversationBuildFormatMetadata | null;
  executionMode?: ConversationRouteExecutionMode;
  continuationKind?: ConversationRouteContinuationKind;
  memoryIntent?: ConversationRouteMemoryIntent;
  runtimeControlIntent?: ConversationRuntimeControlIntent;
  explicitConstraints?: Partial<ConversationExplicitRouteConstraints>;
}

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
  buildFormat?: ConversationBuildFormatMetadata | null;
  semanticRoute?: ConversationSemanticRouteMetadata | null;
}

const DEFAULT_EXPLICIT_ROUTE_CONSTRAINTS: ConversationExplicitRouteConstraints = {
  disallowBrowserOpen: false,
  disallowServerStart: false,
  requiresUserOwnedLocation: false
};

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
 * Infers route execution mode from the legacy intent mode.
 *
 * **Why it exists:**
 * Keeps the richer route metadata compatible with existing callers while downstream planner policy
 * moves away from scraping rendered prompt text.
 *
 * **What it talks to:**
 * - Uses `ConversationIntentMode` (import `ConversationIntentMode`) from `../sessionStore`.
 *
 * @param mode - Legacy conversation intent mode selected for the turn.
 * @returns Typed route execution mode for planner and context gates.
 */
function inferExecutionModeFromIntentMode(
  mode: ConversationIntentMode
): ConversationRouteExecutionMode {
  switch (mode) {
    case "plan":
      return "plan";
    case "build":
    case "static_html_build":
    case "framework_app_build":
      return "build";
    case "autonomous":
      return "autonomous";
    case "status_or_recall":
      return "status_or_recall";
    case "review":
      return "review";
    case "discover_available_capabilities":
      return "capability_discovery";
    case "unclear":
    case "clarify_build_format":
      return "unclear";
    case "chat":
    case "explain":
    default:
      return "chat";
  }
}

/**
 * Infers memory intent from the semantic route and compatibility hint.
 *
 * **Why it exists:**
 * Memory context needs an explicit route-approved gate instead of broad relationship or recall cue
 * words spread across downstream helpers.
 *
 * **What it talks to:**
 * - Uses local route metadata types within this module.
 *
 * @param routeId - Canonical semantic route selected for the turn.
 * @returns Typed memory intent associated with the route.
 */
function inferMemoryIntentFromRouteId(
  routeId: ConversationSemanticRouteId
): ConversationRouteMemoryIntent {
  switch (routeId) {
    case "relationship_recall":
      return "relationship_recall";
    default:
      return "none";
  }
}

/**
 * Infers continuation kind from semantic route hints.
 *
 * **Why it exists:**
 * Continuation policy should be inspectable as typed route metadata before mode-continuity and
 * return-handoff helpers add execution context.
 *
 * **What it talks to:**
 * - Uses local route metadata types within this module.
 *
 * @param routeId - Canonical semantic route selected for the turn.
 * @param semanticHint - Optional compatibility semantic hint carried by existing routes.
 * @returns Typed continuation kind for the turn.
 */
function inferContinuationKindFromRoute(
  routeId: ConversationSemanticRouteId,
  semanticHint: ConversationIntentSemanticHint | null
): ConversationRouteContinuationKind {
  if (semanticHint === "resume_handoff") {
    return "return_handoff";
  }
  if (routeId === "relationship_recall") {
    return "relationship_memory";
  }
  return "none";
}

/**
 * Infers route source from the current compatibility resolution.
 *
 * **Why it exists:**
 * The migration keeps legacy `matchedRuleId` fields while adding a clearer route source for review
 * and planner diagnostics.
 *
 * **What it talks to:**
 * - Uses local route metadata types within this module.
 *
 * @param resolution - Existing resolved intent-mode payload.
 * @returns Best available typed source for the semantic route.
 */
function inferRouteSourceFromResolution(
  resolution: ResolvedConversationIntentMode
): ConversationSemanticRouteSource {
  if (resolution.clarification) {
    return "clarification";
  }
  if (resolution.matchedRuleId.startsWith("local_intent_model_")) {
    return "model";
  }
  if (resolution.matchedRuleId.includes("direct") || resolution.matchedRuleId.includes("explicit")) {
    return "exact_command";
  }
  if (resolution.matchedRuleId.includes("safety")) {
    return "deterministic_safety";
  }
  return "deterministic_signal";
}

/**
 * Maps route-source labels into the shared authority vocabulary.
 *
 * @param source - Route metadata source.
 * @returns Canonical source authority for downstream gates.
 */
function routeSourceToAuthority(
  source: ConversationSemanticRouteSource
): ConversationRouteSourceAuthority {
  switch (source) {
    case "model":
      return "semantic_model";
    case "clarification":
      return "explicit_user_statement";
    case "exact_command":
    case "deterministic_safety":
    case "deterministic_signal":
      return "exact_command";
    case "compatibility":
      return "legacy_compatibility";
  }
}

/**
 * Builds one canonical semantic route metadata payload.
 *
 * **Why it exists:**
 * Downstream planner, continuity, and memory code need a single route contract that carries meaning
 * and constraints without re-classifying the raw user request.
 *
 * **What it talks to:**
 * - Uses local route inference helpers within this module.
 *
 * @param resolution - Existing resolved intent-mode payload.
 * @param overrides - Optional typed metadata supplied by a more specific resolver.
 * @returns Canonical route metadata for the turn.
 */
export function buildConversationSemanticRouteMetadata(
  resolution: ResolvedConversationIntentMode,
  overrides: ConversationSemanticRouteMetadataOverrides = {}
): ConversationSemanticRouteMetadata {
  const routeId =
    overrides.routeId ??
    resolution.semanticRouteId ??
    resolution.semanticRoute?.routeId ??
    inferSemanticRouteIdFromIntentMode(
      resolution.mode,
      resolution.semanticHint ?? null
    );
  const buildFormat =
    overrides.buildFormat ??
    resolution.buildFormat ??
    resolution.semanticRoute?.buildFormat ??
    null;
  const source =
    overrides.source ??
    resolution.semanticRoute?.source ??
    inferRouteSourceFromResolution(resolution);
  return {
    routeId,
    confidence:
      overrides.confidence ??
      resolution.semanticRoute?.confidence ??
      resolution.confidence,
    source,
    sourceAuthority:
      overrides.sourceAuthority ??
      resolution.semanticRoute?.sourceAuthority ??
      routeSourceToAuthority(source),
    buildFormat,
    executionMode:
      overrides.executionMode ??
      resolution.semanticRoute?.executionMode ??
      inferExecutionModeFromIntentMode(resolution.mode),
    continuationKind:
      overrides.continuationKind ??
      resolution.semanticRoute?.continuationKind ??
      inferContinuationKindFromRoute(routeId, resolution.semanticHint ?? null),
    memoryIntent:
      overrides.memoryIntent ??
      resolution.semanticRoute?.memoryIntent ??
      inferMemoryIntentFromRouteId(routeId),
    runtimeControlIntent:
      overrides.runtimeControlIntent ??
      resolution.semanticRoute?.runtimeControlIntent ??
      "none",
    explicitConstraints: {
      ...DEFAULT_EXPLICIT_ROUTE_CONSTRAINTS,
      ...(resolution.semanticRoute?.explicitConstraints ?? {}),
      ...(overrides.explicitConstraints ?? {})
    }
  };
}

/**
 * Returns semantic route metadata and compatibility route id.
 *
 * **Why it exists:**
 * Keeps older `semanticRouteId` consumers working while newer code migrates to the full
 * `semanticRoute` payload.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param resolution - Input consumed by this helper.
 * @param overrides - Optional typed metadata supplied by a more specific resolver.
 * @returns Result produced by this helper.
 */
export function withSemanticRouteId(
  resolution: ResolvedConversationIntentMode,
  overrides: ConversationSemanticRouteMetadataOverrides = {}
): ResolvedConversationIntentMode {
  const semanticRoute = buildConversationSemanticRouteMetadata(resolution, overrides);
  return {
    ...resolution,
    semanticRouteId: semanticRoute.routeId,
    buildFormat: semanticRoute.buildFormat,
    semanticRoute
  };
}
