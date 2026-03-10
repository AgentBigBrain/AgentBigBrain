/**
 * @fileoverview Provides deterministic Stage 6.85 prompt-surface routing classification for user-facing rendering and execution hints.
 */

export type RoutingMapCategoryV1 =
  | "NONE"
  | "DIAGNOSTICS_STATUS"
  | "DIAGNOSTICS_APPROVAL_DIFF"
  | "SCHEDULE_FOCUS_BLOCKS"
  | "BUILD_SCAFFOLD"
  | "CLONE_VARIANTS"
  | "CLONE_BLOCK_REASONS"
  | "WORKFLOW_REPLAY"
  | "RECOVERY_RESUME"
  | "LATENCY_BUDGETS"
  | "OBSERVABILITY_EXPORT";

export type RoutingMapRouteTypeV1 =
  | "none"
  | "diagnostics"
  | "execution_surface"
  | "policy_explanation";

export type RoutingMapConfidenceTierV1 = "HIGH" | "MED" | "LOW";

export interface RoutingMapClassificationV1 {
  category: RoutingMapCategoryV1;
  routeType: RoutingMapRouteTypeV1;
  actionFamily: string | null;
  fallbackReasonCode: string | null;
  requiresApprovalDiff: boolean;
  commandIntent: string | null;
  confidenceTier: RoutingMapConfidenceTierV1;
  matchedRuleId: string;
  rulepackVersion: "RoutingMapV1";
  conflict: boolean;
}

const ROUTING_RULEPACK_VERSION: RoutingMapClassificationV1["rulepackVersion"] = "RoutingMapV1";
const CURRENT_USER_REQUEST_MARKER = "Current user request:";

const DIAGNOSTIC_STATUS_PATTERNS: readonly RegExp[] = [
  /\bshow\b.*\bwhat\s+will\s+run\b/i,
  /\bshow\b.*\bwhat\s+ran\b/i,
  /\bwhy\b.*\bmission\b.*\b(?:blocked|waiting\s+for\s+approval)\b/i,
  /\bordered\s+mission\s+timeline\b/i
] as const;

const DIAGNOSTIC_APPROVAL_DIFF_PATTERNS: readonly RegExp[] = [
  /^\s*show\s+exact\s+approval\s+diff\b/i,
  /\bwait\s+for\s+step-level\s+approval\b/i
] as const;

const SCHEDULE_PATTERNS: readonly RegExp[] = [
  /\bschedule\b/i,
  /\bfocus\s+blocks?\b/i
] as const;

const BUILD_PATTERNS: readonly RegExp[] = [
  /\bbuild\b.*\btypescript\b.*\bcli\b/i,
  /\bdeterministic\s+typescript\s+cli\s+scaffold\b/i,
  /\bscaffold\b/i,
  /\brunbook\b/i
] as const;

const BUILD_EXECUTION_VERB_PATTERNS: readonly RegExp[] = [
  /\b(create|build|make|generate|scaffold|setup|set up|spin up)\b/i
] as const;

const BUILD_EXECUTION_ARTIFACT_PATTERNS: readonly RegExp[] = [
  /\b(app|application|project|dashboard|site|website|frontend|backend|api|cli|repo|repository)\b/i,
  /\b(react|next\.?js|vue|svelte|angular|vite)\b/i
] as const;

const BUILD_EXECUTION_DESTINATION_PATTERNS: readonly RegExp[] = [
  /\bon\s+my\s+(desktop|documents|downloads)\b/i,
  /\bin\s+['"]?[a-z]:\\/i,
  /\bin\s+['"]?\/(?:users|home|tmp|var|opt)\//i,
  /\b[a-z]:\\(?:users|temp|tmp|dev|work|projects|repos)\\/i
] as const;

const BUILD_EXPLANATION_ONLY_PATTERNS: readonly RegExp[] = [
  /^\s*(how\s+do\s+i|how\s+to|explain|show\s+me\s+how|tutorial|guide\s+me|what\s+is)\b/i,
  /\b(without\s+executing|do\s+not\s+execute|don't\s+execute|guidance\s+only|instructions?\s+only)\b/i
] as const;

const CLONE_VARIANT_PATTERNS: readonly RegExp[] = [
  /\bclone-assisted\b/i,
  /\bclone\s+plan\s+variants?\b/i,
  /\bmerge\s+only\s+safe\s+packets?\b/i
] as const;

const CLONE_BLOCK_REASON_PATTERNS: readonly RegExp[] = [
  /\bshow\s+why\b.*\bnon-mergeable\s+clone\s+packet\b/i,
  /\bnon-mergeable\s+clone\s+packet\s+kinds?\b/i
] as const;

const WORKFLOW_PATTERNS: readonly RegExp[] = [
  /\bcapture\b.*\bworkflow\b/i,
  /\bcompile\b.*\breplay\b/i,
  /\bselector\s+(?:drift|mismatch)\b/i
] as const;

const RECOVERY_PATTERNS: readonly RegExp[] = [
  /\bdurable\s+checkpoint\b/i,
  /\bretry\s+budget\b/i,
  /\bmission\s+stop\s+limit\b/i,
  /\bresume\b.*\binterruption\b/i,
  /\bcontinue\b.*\bmission\b/i
] as const;

const LATENCY_PATTERNS: readonly RegExp[] = [
  /\blatency\s+budgets?\b/i,
  /\bphase\s+exceeded\b/i,
  /\bcache\s+paths?\b/i
] as const;

const OBSERVABILITY_EXPORT_PATTERNS: readonly RegExp[] = [
  /\bexport\b.*\bredacted\s+evidence\s+bundle\b/i,
  /\bevidence\s+bundle\b/i
] as const;

/**
 * Derives current user request for routing from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for current user request for routing in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 * @returns Resulting string value.
 */
function extractCurrentUserRequestForRouting(input: string): string {
  const normalized = input.trim();
  if (!normalized) {
    return "";
  }
  const markerIndex = normalized
    .toLowerCase()
    .lastIndexOf(CURRENT_USER_REQUEST_MARKER.toLowerCase());
  if (markerIndex < 0) {
    return normalized;
  }
  const extracted = normalized
    .slice(markerIndex + CURRENT_USER_REQUEST_MARKER.length)
    .trim();
  return extracted || normalized;
}

/**
 * Evaluates all and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the all policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @param patterns - Value for patterns.
 * @returns `true` when this check passes.
 */
function matchesAll(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.every((pattern) => pattern.test(text));
}

/**
 * Evaluates any and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the any policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @param patterns - Value for patterns.
 * @returns `true` when this check passes.
 */
function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/**
 * Evaluates build execution intent and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps build execution-intent classification explicit so generic app/project creation prompts
 * route to governed execution surfaces while explanation-only prompts avoid over-classification.
 *
 * **What it talks to:**
 * - Uses local deterministic regex rulepacks in this module.
 *
 * @param text - Message/text content processed by this function.
 * @returns `true` when this check passes.
 */
function isGenericBuildExecutionIntent(text: string): boolean {
  if (matchesAny(text, BUILD_EXPLANATION_ONLY_PATTERNS)) {
    return false;
  }
  if (!matchesAny(text, BUILD_EXECUTION_VERB_PATTERNS)) {
    return false;
  }
  if (!matchesAny(text, BUILD_EXECUTION_ARTIFACT_PATTERNS)) {
    return false;
  }
  if (
    matchesAny(text, BUILD_EXECUTION_DESTINATION_PATTERNS) ||
    /\bexecute\s+now\b/i.test(text) ||
    /\b(?:build|create|make|generate|scaffold|set up|setup|spin up)\s+(?:this|it)?\s*now\b/i.test(text) ||
    /\brun\s+(?:it|commands?)\b/i.test(text)
  ) {
    return true;
  }
  return false;
}

/**
 * Builds classification for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of classification consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param values - Value for values.
 * @returns Computed `RoutingMapClassificationV1` result.
 */
function createClassification(
  values: Omit<RoutingMapClassificationV1, "rulepackVersion" | "conflict">
): RoutingMapClassificationV1 {
  return {
    ...values,
    rulepackVersion: ROUTING_RULEPACK_VERSION,
    conflict: false
  };
}

/**
 * Classifies user input into the deterministic routing map surface for Stage 6.85.
 */
export function classifyRoutingIntentV1(input: string): RoutingMapClassificationV1 {
  const currentRequest = extractCurrentUserRequestForRouting(input);
  const normalized = currentRequest.toLowerCase();

  if (matchesAny(normalized, CLONE_BLOCK_REASON_PATTERNS)) {
    return createClassification({
      category: "CLONE_BLOCK_REASONS",
      routeType: "policy_explanation",
      actionFamily: "clone_workflow",
      fallbackReasonCode: null,
      requiresApprovalDiff: false,
      commandIntent: "clone_block_reasons",
      confidenceTier: "HIGH",
      matchedRuleId: "routing_v1_clone_block_reasons"
    });
  }

  if (matchesAny(normalized, DIAGNOSTIC_STATUS_PATTERNS)) {
    return createClassification({
      category: "DIAGNOSTICS_STATUS",
      routeType: "diagnostics",
      actionFamily: null,
      fallbackReasonCode: null,
      requiresApprovalDiff: false,
      commandIntent: "status_summary",
      confidenceTier: "HIGH",
      matchedRuleId: "routing_v1_diagnostics_status"
    });
  }

  const looksLikeScheduleExecution = matchesAll(normalized, SCHEDULE_PATTERNS);
  if (!looksLikeScheduleExecution && matchesAny(normalized, DIAGNOSTIC_APPROVAL_DIFF_PATTERNS)) {
    return createClassification({
      category: "DIAGNOSTICS_APPROVAL_DIFF",
      routeType: "diagnostics",
      actionFamily: null,
      fallbackReasonCode: null,
      requiresApprovalDiff: true,
      commandIntent: "approval_diff_diagnostics",
      confidenceTier: "HIGH",
      matchedRuleId: "routing_v1_diagnostics_approval_diff"
    });
  }

  if (looksLikeScheduleExecution) {
    return createClassification({
      category: "SCHEDULE_FOCUS_BLOCKS",
      routeType: "execution_surface",
      actionFamily: "calendar",
      fallbackReasonCode: "CALENDAR_PROPOSE_NOT_AVAILABLE",
      requiresApprovalDiff: true,
      commandIntent: "schedule_focus_blocks",
      confidenceTier: "HIGH",
      matchedRuleId: "routing_v1_schedule_focus_blocks"
    });
  }

  if (matchesAny(normalized, BUILD_PATTERNS) || isGenericBuildExecutionIntent(normalized)) {
    return createClassification({
      category: "BUILD_SCAFFOLD",
      routeType: "execution_surface",
      actionFamily: "build",
      fallbackReasonCode: "BUILD_NO_SIDE_EFFECT_EXECUTED",
      requiresApprovalDiff: true,
      commandIntent: "build_scaffold",
      confidenceTier: "HIGH",
      matchedRuleId: matchesAny(normalized, BUILD_PATTERNS)
        ? "routing_v1_build_scaffold"
        : "routing_v1_build_scaffold_generic"
    });
  }

  if (matchesAny(normalized, CLONE_VARIANT_PATTERNS)) {
    return createClassification({
      category: "CLONE_VARIANTS",
      routeType: "execution_surface",
      actionFamily: "clone_workflow",
      fallbackReasonCode: "CLONE_WORKFLOW_NO_SIDE_EFFECT_EXECUTED",
      requiresApprovalDiff: false,
      commandIntent: "clone_variants",
      confidenceTier: "HIGH",
      matchedRuleId: "routing_v1_clone_variants"
    });
  }

  if (matchesAny(normalized, WORKFLOW_PATTERNS)) {
    return createClassification({
      category: "WORKFLOW_REPLAY",
      routeType: "execution_surface",
      actionFamily: "computer_use",
      fallbackReasonCode: "WORKFLOW_REPLAY_NO_SIDE_EFFECT_EXECUTED",
      requiresApprovalDiff: true,
      commandIntent: "workflow_replay",
      confidenceTier: "HIGH",
      matchedRuleId: "routing_v1_workflow_replay"
    });
  }

  if (matchesAny(normalized, RECOVERY_PATTERNS)) {
    return createClassification({
      category: "RECOVERY_RESUME",
      routeType: "execution_surface",
      actionFamily: "recovery",
      fallbackReasonCode: "RECOVERY_NO_SIDE_EFFECT_EXECUTED",
      requiresApprovalDiff: false,
      commandIntent: "recovery_resume",
      confidenceTier: "HIGH",
      matchedRuleId: "routing_v1_recovery_resume"
    });
  }

  if (matchesAny(normalized, LATENCY_PATTERNS)) {
    return createClassification({
      category: "LATENCY_BUDGETS",
      routeType: "execution_surface",
      actionFamily: "latency",
      fallbackReasonCode: "LATENCY_NO_SIDE_EFFECT_EXECUTED",
      requiresApprovalDiff: false,
      commandIntent: "latency_budget",
      confidenceTier: "HIGH",
      matchedRuleId: "routing_v1_latency_budgets"
    });
  }

  if (matchesAny(normalized, OBSERVABILITY_EXPORT_PATTERNS)) {
    return createClassification({
      category: "OBSERVABILITY_EXPORT",
      routeType: "execution_surface",
      actionFamily: "observability",
      fallbackReasonCode: "OBSERVABILITY_NO_SIDE_EFFECT_EXECUTED",
      requiresApprovalDiff: false,
      commandIntent: "observability_export",
      confidenceTier: "HIGH",
      matchedRuleId: "routing_v1_observability_export"
    });
  }

  return createClassification({
    category: "NONE",
    routeType: "none",
    actionFamily: null,
    fallbackReasonCode: null,
    requiresApprovalDiff: false,
    commandIntent: null,
    confidenceTier: "LOW",
    matchedRuleId: "routing_v1_none"
  });
}

/**
 * Returns true when a routing classification is an explicit diagnostics surface.
 */
export function isDiagnosticsRoutingClassification(
  classification: RoutingMapClassificationV1
): boolean {
  return classification.routeType === "diagnostics";
}

/**
 * Returns true when a routing classification maps to an execution surface.
 */
export function isExecutionSurfaceRoutingClassification(
  classification: RoutingMapClassificationV1
): boolean {
  return classification.routeType === "execution_surface";
}

/**
 * Builds a deterministic routing hint to steer conversation-aware planning input without changing planner schema.
 */
export function buildRoutingExecutionHintV1(
  classification: RoutingMapClassificationV1
): string | null {
  switch (classification.category) {
    case "SCHEDULE_FOCUS_BLOCKS":
      return [
        "Intent surface: schedule_focus_blocks.",
        "Preferred governed action family: calendar_propose with approval diff before write.",
        "If calendar actions are unavailable, fail closed with reasonCode CALENDAR_PROPOSE_NOT_AVAILABLE and include actionable next step."
      ].join(" ");
    case "BUILD_SCAFFOLD":
      return [
        "Intent surface: build_scaffold.",
        "Prefer governed finite proof steps first (for example scaffold, edit, install, build, finite verification) with explicit approval-diff rendering before write actions.",
        "Only use managed process plus probe actions when the user clearly asks to run or verify a live app/session.",
        "If no governed build action executes, return typed no-op reasonCode BUILD_NO_SIDE_EFFECT_EXECUTED."
      ].join(" ");
    case "CLONE_VARIANTS":
      return [
        "Intent surface: clone_variants.",
        "Preferred surface: clone-assisted variant generation and safe-packet merge policy.",
        "If no governed clone action executes, return typed no-op reasonCode CLONE_WORKFLOW_NO_SIDE_EFFECT_EXECUTED."
      ].join(" ");
    case "WORKFLOW_REPLAY":
      return [
        "Intent surface: workflow_replay.",
        "Preferred governed action family: computer_use capture/compile/replay with selector-drift blocks.",
        "If no governed workflow action executes, return typed no-op reasonCode WORKFLOW_REPLAY_NO_SIDE_EFFECT_EXECUTED."
      ].join(" ");
    case "RECOVERY_RESUME":
      return [
        "Intent surface: recovery_resume.",
        "Prefer deterministic retry/resume diagnostics with bounded retry-budget and mission-stop-limit visibility.",
        "If no governed retry/resume action executes, return typed no-op reasonCode RECOVERY_NO_SIDE_EFFECT_EXECUTED."
      ].join(" ");
    case "LATENCY_BUDGETS":
      return [
        "Intent surface: latency_budgets.",
        "Return observed phase-budget diagnostics only when execution evidence exists.",
        "Otherwise fail closed with typed no-op reasonCode LATENCY_NO_SIDE_EFFECT_EXECUTED."
      ].join(" ");
    case "OBSERVABILITY_EXPORT":
      return [
        "Intent surface: observability_export.",
        "Preferred governed action: evidence bundle export with deterministic artifact path.",
        "If no governed export action executes, return typed no-op reasonCode OBSERVABILITY_NO_SIDE_EFFECT_EXECUTED."
      ].join(" ");
    case "CLONE_BLOCK_REASONS":
      return [
        "Intent surface: clone_block_reasons.",
        "Return deterministic policy explanation of non-mergeable packet kinds and remediation.",
        "Do not fabricate clone execution evidence."
      ].join(" ");
    default:
      return null;
  }
}
