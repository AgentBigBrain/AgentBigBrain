/**
 * @fileoverview Interprets nuanced conversational control intents into deterministic command semantics.
 */

import {
  IntentInterpretationModelOutput,
  ModelClient
} from "../models/types";
import {
  classifyPulseLexicalCommand,
  createPulseLexicalRuleContext,
  PulseControlMode,
  PulseLexicalClassification,
  PulseLexicalRuleContext
} from "./pulseLexicalClassifier";
export type { PulseControlMode };

const DEFAULT_PULSE_LEXICAL_RULE_CONTEXT = createPulseLexicalRuleContext(null);

export interface IntentInterpreterTurn {
  role: "user" | "assistant";
  text: string;
}

export interface IntentInterpreterContext {
  recentTurns?: IntentInterpreterTurn[];
  pulseRuleContext?: PulseLexicalRuleContext;
}

export interface InterpretedConversationIntent {
  intentType: "pulse_control" | "none";
  pulseMode: PulseControlMode | null;
  confidence: number;
  rationale: string;
  source: "deterministic" | "model" | "fallback";
  lexicalClassification?: PulseLexicalClassification | null;
}
const MAX_MODEL_INTERPRET_INPUT_CHARS = 320;

/**
 * Constrains and sanitizes confidence to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for confidence before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed numeric value.
 */
function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

/**
 * Builds none intent for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of none intent consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `PulseLexicalClassification` (import `PulseLexicalClassification`) from `./pulseLexicalClassifier`.
 *
 * @param rationale - Value for rationale.
 * @param source - Value for source.
 * @param lexicalClassification - Value for lexical classification.
 * @returns Computed `InterpretedConversationIntent` result.
 */
export function buildNoneIntent(
  rationale: string,
  source: InterpretedConversationIntent["source"] = "fallback",
  lexicalClassification: PulseLexicalClassification | null = null
): InterpretedConversationIntent {
  return {
    intentType: "none",
    pulseMode: null,
    confidence: 0,
    rationale,
    source,
    lexicalClassification
  };
}

/**
 * Builds pulse intent for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of pulse intent consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `PulseControlMode` (import `PulseControlMode`) from `./pulseLexicalClassifier`.
 * - Uses `PulseLexicalClassification` (import `PulseLexicalClassification`) from `./pulseLexicalClassifier`.
 *
 * @param pulseMode - Value for pulse mode.
 * @param confidence - Stable identifier used to reference an entity or record.
 * @param rationale - Value for rationale.
 * @param source - Value for source.
 * @param lexicalClassification - Value for lexical classification.
 * @returns Computed `InterpretedConversationIntent` result.
 */
function buildPulseIntent(
  pulseMode: PulseControlMode,
  confidence: number,
  rationale: string,
  source: InterpretedConversationIntent["source"],
  lexicalClassification: PulseLexicalClassification | null = null
): InterpretedConversationIntent {
  return {
    intentType: "pulse_control",
    pulseMode,
    confidence: clampConfidence(confidence),
    rationale,
    source,
    lexicalClassification
  };
}

/**
 * Normalizes intent text into a stable shape for `intentInterpreter` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for intent text so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeIntentText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Implements confidence from tier behavior used by `intentInterpreter`.
 *
 * **Why it exists:**
 * Keeps `confidence from tier` behavior centralized so collaborating call sites stay consistent.
 *
 * **What it talks to:**
 * - Uses `PulseLexicalClassification` (import `PulseLexicalClassification`) from `./pulseLexicalClassifier`.
 *
 * @param confidenceTier - Stable identifier used to reference an entity or record.
 * @returns Computed numeric value.
 */
function confidenceFromTier(
  confidenceTier: PulseLexicalClassification["confidenceTier"]
): number {
  if (confidenceTier === "HIGH") {
    return 0.98;
  }
  if (confidenceTier === "MED") {
    return 0.9;
  }
  return 0.7;
}

/**
 * Builds context hint for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of context hint consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param recentTurns - Value for recent turns.
 * @returns Resulting string value.
 */
function buildContextHint(recentTurns: IntentInterpreterTurn[]): string {
  const recentUserTurns = recentTurns
    .filter((turn) => turn.role === "user")
    .slice(-3)
    .map((turn) => normalizeIntentText(turn.text))
    .filter((text) => text.length > 0);
  return recentUserTurns.join(" | ");
}

/**
 * Normalizes model pulse mode into a stable shape for `intentInterpreter` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for model pulse mode so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `IntentInterpretationModelOutput` (import `IntentInterpretationModelOutput`) from `../models/types`.
 * - Uses `PulseControlMode` (import `PulseControlMode`) from `./pulseLexicalClassifier`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `PulseControlMode | null` result.
 */
function normalizeModelPulseMode(
  value: IntentInterpretationModelOutput["mode"]
): PulseControlMode | null {
  if (
    value === "on" ||
    value === "off" ||
    value === "private" ||
    value === "public" ||
    value === "status"
  ) {
    return value;
  }
  return null;
}

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
  constructor(private readonly modelClient: ModelClient) { }

  /**
   * Interprets conversation intent into a typed decision signal.
   *
   * **Why it exists:**
   * Provides one interpretation path for conversation intent so policy consumers receive stable typed signals.
   *
   * **What it talks to:**
   * - Uses `IntentInterpretationModelOutput` (import `IntentInterpretationModelOutput`) from `../models/types`.
   * - Uses `classifyPulseLexicalCommand` (import `classifyPulseLexicalCommand`) from `./pulseLexicalClassifier`.
   *
   * @param text - Message/text content processed by this function.
   * @param model - Value for model.
   * @param context - Message/text content processed by this function.
   * @returns Promise resolving to InterpretedConversationIntent.
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

    if (
      lexicalClassification.category === "COMMAND" &&
      lexicalClassification.commandIntent
    ) {
      return buildPulseIntent(
        lexicalClassification.commandIntent,
        confidenceFromTier(lexicalClassification.confidenceTier),
        "Deterministic pulse lexical classifier matched input text.",
        "deterministic",
        lexicalClassification
      );
    }

    // Keep model-assisted interpretation bounded to short conversational control phrases.
    if (normalizedText.length > MAX_MODEL_INTERPRET_INPUT_CHARS) {
      return buildNoneIntent(
        `Input exceeded bounded interpretation budget (${MAX_MODEL_INTERPRET_INPUT_CHARS} chars).`
      );
    }

    try {
      const output = await this.modelClient.completeJson<IntentInterpretationModelOutput>({
        model,
        schemaName: "intent_interpretation_v1",
        temperature: 0,
        systemPrompt:
          "You interpret user text for pulse/check-in control intent only. " +
          "Return JSON fields: intentType ('pulse_control' or 'none'), mode, confidence, rationale. " +
          "Do not infer unrelated actions.",
        userPrompt: JSON.stringify({
          text: normalizedText,
          contextHint: buildContextHint(context.recentTurns ?? [])
        })
      });

      if (output.intentType !== "pulse_control") {
        return buildNoneIntent(
          output.rationale || "Model did not detect pulse-control intent.",
          "model",
          lexicalClassification
        );
      }

      const modelMode = normalizeModelPulseMode(output.mode);
      if (!modelMode) {
        return buildNoneIntent(
          "Model returned pulse-control intent without a valid mode.",
          "model",
          lexicalClassification
        );
      }

      return buildPulseIntent(
        modelMode,
        clampConfidence(output.confidence),
        output.rationale || "Model interpreted pulse-control intent.",
        "model",
        lexicalClassification
      );
    } catch (error) {
      return buildNoneIntent(
        `Intent interpretation fallback: ${(error as Error).message}`,
        "fallback",
        lexicalClassification
      );
    }
  }
}
