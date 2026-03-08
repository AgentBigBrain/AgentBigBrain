/**
 * @fileoverview Stable intent-interpretation entrypoint backed by `src/organs/intentRuntime/`.
 */

import { ModelClient } from "../models/types";
import type {
  IntentInterpreterContext,
  InterpretedConversationIntent
} from "./intentRuntime/contracts";
import {
  buildNoneIntent,
  buildPulseIntent,
  confidenceFromTier,
  interpretModelAssistedIntent,
  normalizeIntentText
} from "./intentRuntime/intentModelFallback";
import { classifyPulseLexicalCommand, createPulseLexicalRuleContext } from "./intentRuntime/pulseLexicalRules";

export type {
  IntentInterpreterContext,
  IntentInterpreterTurn,
  InterpretedConversationIntent,
  PulseControlMode
} from "./intentRuntime/contracts";
export { buildNoneIntent } from "./intentRuntime/intentModelFallback";

const DEFAULT_PULSE_LEXICAL_RULE_CONTEXT = createPulseLexicalRuleContext(null);

export class IntentInterpreterOrgan {
  /**
   * Initializes `IntentInterpreterOrgan` with deterministic runtime dependencies.
   *
   * **Why it exists:**
   * Captures required dependencies at initialization time so runtime behavior remains explicit.
   *
   * **What it talks to:**
   * - Uses `ModelClient` (import `ModelClient`) from `../models/types`.
   *
   * @param modelClient - Value for model client.
   */
  constructor(private readonly modelClient: ModelClient) {}

  /**
   * Interprets conversation intent into a typed decision signal.
   *
   * **Why it exists:**
   * Provides one interpretation path for conversation intent so policy consumers receive stable typed signals.
   *
   * **What it talks to:**
   * - Uses `classifyPulseLexicalCommand` from `./intentRuntime/pulseLexicalRules`.
   * - Uses `interpretModelAssistedIntent` from `./intentRuntime/intentModelFallback`.
   *
   * @param text - Message/text content processed by this function.
   * @param model - Value for model.
   * @param context - Message/text content processed by this function.
   * @returns Promise resolving to `InterpretedConversationIntent`.
   */
  async interpretConversationIntent(
    text: string,
    model: string,
    context: IntentInterpreterContext = {}
  ): Promise<InterpretedConversationIntent> {
    const normalizedText = normalizeIntentText(text);
    if (!normalizedText) {
      return buildNoneIntent("Empty text cannot carry an actionable intent.");
    }

    const pulseRuleContext = context.pulseRuleContext ?? DEFAULT_PULSE_LEXICAL_RULE_CONTEXT;
    const lexicalClassification = classifyPulseLexicalCommand(normalizedText, pulseRuleContext);
    if (lexicalClassification.conflict || lexicalClassification.category === "UNCLEAR") {
      return buildNoneIntent(
        "Deterministic pulse lexical classifier produced an ambiguous command conflict.",
        "deterministic",
        lexicalClassification
      );
    }

    if (lexicalClassification.category === "COMMAND" && lexicalClassification.commandIntent) {
      return buildPulseIntent(
        lexicalClassification.commandIntent,
        confidenceFromTier(lexicalClassification.confidenceTier),
        "Deterministic pulse lexical classifier matched input text.",
        "deterministic",
        lexicalClassification
      );
    }

    return interpretModelAssistedIntent(
      this.modelClient,
      normalizedText,
      model,
      context,
      lexicalClassification
    );
  }
}
