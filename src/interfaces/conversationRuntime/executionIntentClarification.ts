/**
 * @fileoverview Resolves one bounded clarification question for ambiguous build or execute intent.
 */

import type { RoutingMapClassificationV1 } from "../routingMap";
import {
  extractExecutionPreferences,
  isNaturalAutonomousExecutionRequest
} from "./executionPreferenceExtraction";
import {
  hasAnyToken,
  hasAnyTokenSequence,
  tokenizeExecutionPreferenceInput
} from "./executionPreferenceCommon";

export interface ExecutionIntentClarificationResolution {
  question: string | null;
  mode: "plan_or_build" | "explain_or_execute" | "build_format" | null;
  matchedRuleId: string | null;
}

const BUILD_VERB_TOKENS = new Set([
  "build",
  "create",
  "generate",
  "implement",
  "make",
  "scaffold",
  "setup"
]);
const BUILD_ARTIFACT_TOKENS = new Set([
  "app",
  "application",
  "api",
  "backend",
  "cli",
  "dashboard",
  "feature",
  "frontend",
  "page",
  "project",
  "repo",
  "repository",
  "site",
  "website"
]);
const EXECUTION_CONTEXT_TOKENS = new Set([
  "bug",
  "broken",
  "error",
  "failing",
  "failure",
  "issue",
  "problem",
  "regression",
  "screenshot",
  "test",
  "tests",
  "wrong"
]);
const EXECUTION_VERB_TOKENS = new Set([
  "change",
  "correct",
  "debug",
  "fix",
  "refactor",
  "repair",
  "resolve",
  "update"
]);
const EXECUTION_MEDIA_EVIDENCE_TOKENS = new Set([
  "audio",
  "clip",
  "image",
  "photo",
  "screenshot",
  "video"
]);

const BUILD_REQUEST_LEAD_SEQUENCES: readonly (readonly string[])[] = [
  ["please", "build"],
  ["please", "create"],
  ["please", "generate"],
  ["please", "implement"],
  ["please", "make"],
  ["please", "scaffold"],
  ["can", "you", "build"],
  ["can", "you", "create"],
  ["can", "you", "generate"],
  ["can", "you", "implement"],
  ["can", "you", "make"],
  ["could", "you", "build"],
  ["could", "you", "create"],
  ["would", "you", "build"],
  ["would", "you", "create"],
  ["will", "you", "build"],
  ["will", "you", "create"],
  ["i", "need", "you", "to", "build"],
  ["i", "need", "you", "to", "create"],
  ["help", "me", "build"],
  ["help", "me", "create"],
  ["let's", "build"],
  ["lets", "build"]
] as const;
const SET_UP_BUILD_SEQUENCES: readonly (readonly string[])[] = [
  ["set", "up"],
  ["spin", "up"]
] as const;
const EXECUTION_MEDIA_EVIDENCE_SEQUENCES: readonly (readonly string[])[] = [
  ["screen", "shot"],
  ["voice", "memo"],
  ["voice", "note"]
] as const;
const EXECUTION_VERB_SEQUENCES: readonly (readonly string[])[] = [
  ["clean", "up"]
] as const;

/**
 * Evaluates whether build request lead.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `hasAnyToken` (import `hasAnyToken`) from `./executionPreferenceCommon`.
 * - Uses `hasAnyTokenSequence` (import `hasAnyTokenSequence`) from `./executionPreferenceCommon`.
 * @param tokens - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function hasBuildRequestLead(tokens: readonly string[]): boolean {
  return (
    hasAnyTokenSequence(tokens, BUILD_REQUEST_LEAD_SEQUENCES)
    || (tokens.length > 0 && BUILD_VERB_TOKENS.has(tokens[0]!))
    || (hasAnyTokenSequence(tokens, SET_UP_BUILD_SEQUENCES)
      && hasAnyToken(tokens, BUILD_ARTIFACT_TOKENS))
  );
}

/**
 * Evaluates whether ambiguous build shape.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `hasAnyToken` (import `hasAnyToken`) from `./executionPreferenceCommon`.
 * - Uses `hasAnyTokenSequence` (import `hasAnyTokenSequence`) from `./executionPreferenceCommon`.
 * @param tokens - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function hasAmbiguousBuildShape(tokens: readonly string[]): boolean {
  const hasBuildVerb =
    hasAnyToken(tokens, BUILD_VERB_TOKENS) || hasAnyTokenSequence(tokens, SET_UP_BUILD_SEQUENCES);
  return hasBuildVerb && hasAnyToken(tokens, BUILD_ARTIFACT_TOKENS) && hasBuildRequestLead(tokens);
}

/**
 * Evaluates whether ambiguous execution shape.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `hasAnyToken` (import `hasAnyToken`) from `./executionPreferenceCommon`.
 * - Uses `hasAnyTokenSequence` (import `hasAnyTokenSequence`) from `./executionPreferenceCommon`.
 * @param tokens - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function hasAmbiguousExecutionShape(tokens: readonly string[]): boolean {
  const hasExecutionContext = hasAnyToken(tokens, EXECUTION_CONTEXT_TOKENS);
  const hasExecutionVerb =
    hasAnyToken(tokens, EXECUTION_VERB_TOKENS)
    || hasAnyTokenSequence(tokens, EXECUTION_VERB_SEQUENCES);
  const hasExecutionMediaEvidence =
    hasAnyToken(tokens, EXECUTION_MEDIA_EVIDENCE_TOKENS)
    || hasAnyTokenSequence(tokens, EXECUTION_MEDIA_EVIDENCE_SEQUENCES);
  return hasExecutionContext && (hasExecutionVerb || hasExecutionMediaEvidence);
}

/**
 * Resolves whether one ambiguous request should trigger a single clarification question.
 *
 * @param userInput - Raw current user request before execution-input wrapping.
 * @param routingClassification - Optional deterministic routing classification.
 * @returns Clarification question metadata, or `null` fields when no clarification is needed.
 */
export function resolveExecutionIntentClarification(
  userInput: string,
  routingClassification: RoutingMapClassificationV1 | null = null
): ExecutionIntentClarificationResolution {
  const { normalized, tokens } = tokenizeExecutionPreferenceInput(userInput);
  if (!normalized) {
    return {
      question: null,
      mode: null,
      matchedRuleId: null
    };
  }

  const preferences = extractExecutionPreferences(normalized);
  if (
    preferences.planOnly
    || preferences.executeNow
    || preferences.statusOrRecall
    || preferences.naturalSkillDiscovery
    || preferences.reusePriorApproach
    || preferences.presentation.keepVisible
    || preferences.presentation.leaveOpen
    || preferences.presentation.runLocally
    || isNaturalAutonomousExecutionRequest(normalized)
  ) {
    return {
      question: null,
      mode: null,
      matchedRuleId: null
    };
  }

  if (
    routingClassification?.category === "BUILD_SCAFFOLD"
    || hasAmbiguousBuildShape(tokens)
  ) {
    return {
      question: "Do you want me to plan it first or build it now?",
      mode: "plan_or_build",
      matchedRuleId: routingClassification?.category === "BUILD_SCAFFOLD"
        ? "execution_intent_build_scaffold"
        : "execution_intent_build_generic"
    };
  }

  if (hasAmbiguousExecutionShape(tokens)) {
    return {
      question: "Do you want me to explain the issue first or fix it now?",
      mode: "explain_or_execute",
      matchedRuleId: "execution_intent_fix_or_explain"
    };
  }

  return {
    question: null,
    mode: null,
    matchedRuleId: null
  };
}
