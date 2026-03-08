/**
 * @fileoverview Bounded model-fallback helpers for nuanced pulse intent interpretation.
 */

import { IntentInterpretationModelOutput, ModelClient } from "../../models/types";
import {
  IntentInterpreterContext,
  InterpretedConversationIntent,
  PulseControlMode,
  PulseLexicalClassification
} from "./contracts";

export const MAX_MODEL_INTERPRET_INPUT_CHARS = 320;

/**
 * Builds a typed `none` intent result.
 *
 * @param rationale - Human-readable explanation.
 * @param source - Decision source.
 * @param lexicalClassification - Optional lexical classification payload.
 * @returns `none` intent payload.
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
 * Clamps confidence to a stable numeric range.
 *
 * @param value - Candidate confidence value.
 * @returns Clamped confidence.
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
 * Builds a typed pulse-control intent result.
 *
 * @param pulseMode - Pulse mode selected by lexical or model logic.
 * @param confidence - Confidence score for the interpretation.
 * @param rationale - Human-readable explanation.
 * @param source - Decision source.
 * @param lexicalClassification - Optional lexical classification payload.
 * @returns Pulse-control intent payload.
 */
export function buildPulseIntent(
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
 * Normalizes conversational text before lexical or model interpretation.
 *
 * @param value - Raw text.
 * @returns Trimmed normalized text.
 */
export function normalizeIntentText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Maps lexical confidence tiers to deterministic confidence scores.
 *
 * @param confidenceTier - Lexical confidence tier.
 * @returns Stable confidence score.
 */
export function confidenceFromTier(
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
 * Builds the bounded context hint passed to the model fallback.
 *
 * @param recentTurns - Recent conversational turns.
 * @returns Joined context hint string.
 */
function buildContextHint(recentTurns: IntentInterpreterContext["recentTurns"] = []): string {
  const recentUserTurns = recentTurns
    .filter((turn) => turn.role === "user")
    .slice(-3)
    .map((turn) => normalizeIntentText(turn.text))
    .filter((text) => text.length > 0);
  return recentUserTurns.join(" | ");
}

/**
 * Normalizes the model-returned pulse mode.
 *
 * @param value - Raw mode from the structured model response.
 * @returns Valid pulse mode or `null`.
 */
function normalizeModelPulseMode(
  value: IntentInterpretationModelOutput["mode"]
): PulseControlMode | null {
  if (value === "on" || value === "off" || value === "private" || value === "public" || value === "status") {
    return value;
  }
  return null;
}

/**
 * Runs the bounded model fallback for nuanced pulse intent interpretation.
 *
 * @param modelClient - Structured model client.
 * @param normalizedText - Pre-normalized input text.
 * @param model - Model name.
 * @param context - Interpreter context.
 * @param lexicalClassification - Lexical classification already computed by deterministic rules.
 * @returns Interpreted conversation intent from model or fallback behavior.
 */
export async function interpretModelAssistedIntent(
  modelClient: ModelClient,
  normalizedText: string,
  model: string,
  context: IntentInterpreterContext,
  lexicalClassification: PulseLexicalClassification
): Promise<InterpretedConversationIntent> {
  if (normalizedText.length > MAX_MODEL_INTERPRET_INPUT_CHARS) {
    return buildNoneIntent(
      `Input exceeded bounded interpretation budget (${MAX_MODEL_INTERPRET_INPUT_CHARS} chars).`
    );
  }

  try {
    const output = await modelClient.completeJson<IntentInterpretationModelOutput>({
      model,
      schemaName: "intent_interpretation_v1",
      temperature: 0,
      systemPrompt:
        "You interpret user text for pulse/check-in control intent only. " +
        "Return JSON fields: intentType ('pulse_control' or 'none'), mode, confidence, rationale. " +
        "Do not infer unrelated actions.",
      userPrompt: JSON.stringify({
        text: normalizedText,
        contextHint: buildContextHint(context.recentTurns)
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
