/**
 * @fileoverview Canonical combination logic between deterministic front-door intent routing and the optional local intent-model path.
 */

import { routeLocalIntentModel } from "./localIntentModelRouter";
import type {
  LocalIntentModelSessionHints,
  LocalIntentModelResolver
} from "./localIntentModelContracts";
import type { RoutingMapClassificationV1 } from "../../interfaces/routingMap";
import type { ResolvedConversationIntentMode } from "../../interfaces/conversationRuntime/intentModeContracts";

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
  sessionHints: LocalIntentModelSessionHints | null = null
): Promise<ResolvedConversationIntentMode> {
  if (confidenceRank(deterministicResolution.confidence) >= 3) {
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
