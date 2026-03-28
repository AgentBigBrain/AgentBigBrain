/**
 * @fileoverview Bounded bridge-question timing interpretation helpers that keep Stage 6.86 bridge policy deterministic-first.
 */

import type { RoutingMapClassificationV1 } from "../../interfaces/routingMap";
import { routeBridgeQuestionTimingInterpretationModel } from "../../organs/languageUnderstanding/localIntentModelRouter";
import type {
  BridgeQuestionTimingInterpretationResolver,
  BridgeQuestionTimingInterpretationSignal
} from "../../organs/languageUnderstanding/localIntentModelContracts";

export interface BridgeQuestionTimingEvaluationInputV1 {
  userInput: string | null | undefined;
  questionPrompt: string;
  entityLabels: readonly string[];
  routingClassification?: RoutingMapClassificationV1 | null;
  bridgeQuestionTimingInterpretationResolver?: BridgeQuestionTimingInterpretationResolver;
}

/**
 * Normalizes bridge timing explanation text into a bounded trace-safe string.
 *
 * @param value - Raw explanation text.
 * @returns Trimmed bounded explanation, or `null`.
 */
function normalizeExplanation(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

/**
 * Resolves one optional bridge-question timing interpretation and fails open to deterministic
 * bridge behavior when no bounded semantic signal is available.
 *
 * @param input - Bridge-question timing context for the current turn.
 * @returns Medium/high-confidence defer signal, or `null` when the bridge should proceed
 *   deterministically.
 */
export async function resolveOptionalBridgeQuestionTimingDeferSignalV1(
  input: BridgeQuestionTimingEvaluationInputV1
): Promise<BridgeQuestionTimingInterpretationSignal | null> {
  const resolver = input.bridgeQuestionTimingInterpretationResolver;
  const userInput = (input.userInput ?? "").trim();
  if (!resolver || !userInput) {
    return null;
  }
  const signal = await routeBridgeQuestionTimingInterpretationModel(
    {
      userInput,
      routingClassification: input.routingClassification ?? null,
      questionPrompt: input.questionPrompt,
      entityLabels: input.entityLabels
    },
    resolver
  );
  if (!signal) {
    return null;
  }
  if (signal.confidence === "low") {
    return null;
  }
  if (signal.kind !== "defer_for_context" && signal.kind !== "non_bridge_context") {
    return null;
  }
  return {
    ...signal,
    explanation: normalizeExplanation(signal.explanation) ?? `Bridge timing classified as ${signal.kind}.`
  };
}
