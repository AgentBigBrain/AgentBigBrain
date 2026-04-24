/**
 * @fileoverview Deterministic execution-preference extraction for the conversation front door.
 */

import {
  resolvePresentationPreferences,
  type PresentationPreferences
} from "./presentationPreferenceResolution";
import { tokenizeExecutionPreferenceInput } from "./executionPreferenceCommon";
import {
  hasDirectExecutionShape,
  hasBrowserControlExecutionShape,
  resolveAutonomousExecutionSignalStrengthFromTokens
} from "./executionPreferenceExecutionSignals";
import {
  hasNaturalCapabilityDiscoveryShape,
  hasPlanOnlyShape,
  hasStatusOrRecallShape,
  hasReusePriorApproachShape
} from "./executionPreferenceIntentSignals";
import type {
  AutonomousExecutionSignalStrength,
  ExtractedExecutionPreferences
} from "./executionPreferenceTypes";

export type { AutonomousExecutionSignalStrength, ExtractedExecutionPreferences };
export type { PresentationPreferences };

/**
 * Returns `true` when a text looks like an explicit natural-language request for skill inventory.
 *
 * **Why it exists:**
 * Capability discovery should stay on a deterministic front-door fast path when the wording is
 * explicit, while leaving broader semantic interpretation to the intent layer.
 *
 * **What it talks to:**
 * - Uses `tokenizeExecutionPreferenceInput` from `./executionPreferenceCommon`.
 * - Uses `hasNaturalCapabilityDiscoveryShape` from `./executionPreferenceIntentSignals`.
 *
 * @param value - Raw inbound user text before queue routing.
 * @returns `true` when the text looks like an explicit skill/tool inventory request.
 */
export function isNaturalSkillDiscoveryRequest(value: string): boolean {
  const { normalized, tokens } = tokenizeExecutionPreferenceInput(value);
  if (!normalized) {
    return false;
  }
  return hasNaturalCapabilityDiscoveryShape(tokens);
}

/**
 * Returns `true` when a text explicitly asks the assistant to own the work end to end.
 *
 * **Why it exists:**
 * Higher-level routing still needs one deterministic ownership signal for strong wording before it
 * falls back to the bounded autonomy intent interpreter.
 *
 * **What it talks to:**
 * - Uses `resolveAutonomousExecutionSignalStrength` from this module.
 *
 * @param value - Raw inbound user text before queue routing.
 * @returns `true` when the text clearly requests autonomous end-to-end handling.
 */
export function isNaturalAutonomousExecutionRequest(value: string): boolean {
  return resolveAutonomousExecutionSignalStrength(value) !== "none";
}

/**
 * Returns how strongly a text asks the assistant to own the work end to end.
 *
 * **Why it exists:**
 * Strong versus ambiguous autonomous wording needs to stay deterministic so the intent boundary
 * layer can decide when to invoke the bounded shared interpreter.
 *
 * **What it talks to:**
 * - Uses `tokenizeExecutionPreferenceInput` from `./executionPreferenceCommon`.
 * - Uses `resolveAutonomousExecutionSignalStrengthFromTokens` from `./executionPreferenceExecutionSignals`.
 *
 * @param value - Raw inbound user text before queue routing.
 * @returns `strong`, `ambiguous`, or `none` for deterministic higher-level disambiguation.
 */
export function resolveAutonomousExecutionSignalStrength(
  value: string
): AutonomousExecutionSignalStrength {
  const { normalized, tokens } = tokenizeExecutionPreferenceInput(value);
  if (!normalized) {
    return "none";
  }
  return resolveAutonomousExecutionSignalStrengthFromTokens(tokens);
}

/**
 * Extracts deterministic execution preferences from one user utterance.
 *
 * **Why it exists:**
 * The front door still needs a small deterministic shell for explicit constraints and high-precision
 * routing cues, but that shell should be token-based and bounded instead of regex-heavy.
 *
 * **What it talks to:**
 * - Uses `tokenizeExecutionPreferenceInput` from `./executionPreferenceCommon`.
 * - Uses bounded signal helpers from `./executionPreferenceExecutionSignals` and
 *   `./executionPreferenceIntentSignals`.
 * - Uses `resolvePresentationPreferences` from `./presentationPreferenceResolution`.
 *
 * @param value - Raw inbound user text before queue routing.
 * @returns Canonical execution-preference flags for higher-level intent resolution.
 */
export function extractExecutionPreferences(value: string): ExtractedExecutionPreferences {
  const { normalized, tokens } = tokenizeExecutionPreferenceInput(value);
  const autonomousExecutionStrength = normalized
    ? resolveAutonomousExecutionSignalStrengthFromTokens(tokens)
    : "none";
  return {
    planOnly: normalized ? hasPlanOnlyShape(tokens) : false,
    executeNow:
      normalized
        ? hasDirectExecutionShape(tokens) || hasBrowserControlExecutionShape(tokens)
        : false,
    autonomousExecution: autonomousExecutionStrength !== "none",
    autonomousExecutionStrength,
    naturalSkillDiscovery: normalized ? hasNaturalCapabilityDiscoveryShape(tokens) : false,
    statusOrRecall: normalized ? hasStatusOrRecallShape(tokens) : false,
    reusePriorApproach: normalized ? hasReusePriorApproachShape(tokens) : false,
    presentation: resolvePresentationPreferences(normalized)
  };
}
