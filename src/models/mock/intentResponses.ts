/**
 * @fileoverview Deterministic mock intent-interpretation builders.
 */

import type { IntentInterpretationModelOutput } from "../types";
import { asString, parseJsonObject } from "./contracts";

/**
 * Builds intent interpretation output for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps deterministic mock pulse-intent behavior in a canonical subsystem instead of mixing it
 * into the stable `mockModelClient.ts` entrypoint.
 *
 * **What it talks to:**
 * - Uses `IntentInterpretationModelOutput` (import `IntentInterpretationModelOutput`) from `../types`.
 * - Uses shared prompt helpers from `./contracts`.
 *
 * @param userPrompt - Message/text content processed by this function.
 * @returns Computed `IntentInterpretationModelOutput` result.
 */
export function buildIntentInterpretationOutput(
  userPrompt: string
): IntentInterpretationModelOutput {
  const input = parseJsonObject(userPrompt);
  const text = asString(input.text).trim().toLowerCase();
  const combinedContext = [text, asString(input.contextHint).trim().toLowerCase()]
    .filter((item) => item.length > 0)
    .join(" ");

  const hasPulseKeyword =
    /\bpulse\b/.test(combinedContext) ||
    /\bcheck[- ]?in\b/.test(combinedContext) ||
    /\bnotifications?\b/.test(combinedContext) ||
    /\breminders?\b/.test(combinedContext) ||
    /\bnudges?\b/.test(combinedContext);

  if (/\bstatus\b/.test(combinedContext) && hasPulseKeyword) {
    return {
      intentType: "pulse_control",
      mode: "status",
      confidence: 0.94,
      rationale: "Message asks for pulse/check-in status."
    };
  }

  if (/\bprivate\b/.test(combinedContext) && hasPulseKeyword) {
    return {
      intentType: "pulse_control",
      mode: "private",
      confidence: 0.93,
      rationale: "Message asks for private pulse/check-in mode."
    };
  }

  if (/\bpublic\b/.test(combinedContext) && hasPulseKeyword) {
    return {
      intentType: "pulse_control",
      mode: "public",
      confidence: 0.93,
      rationale: "Message asks for public pulse/check-in mode."
    };
  }

  if (/(?:\bturn\s+off\b|\bstop\b|\bdisable\b|\bpause\b)/.test(combinedContext) && hasPulseKeyword) {
    return {
      intentType: "pulse_control",
      mode: "off",
      confidence: 0.95,
      rationale: "Message asks to stop pulse/check-in notifications."
    };
  }

  if (/(?:\bturn\s+on\b|\benable\b|\bresume\b)/.test(combinedContext) && hasPulseKeyword) {
    return {
      intentType: "pulse_control",
      mode: "on",
      confidence: 0.95,
      rationale: "Message asks to enable pulse/check-in notifications."
    };
  }

  return {
    intentType: "none",
    mode: null,
    confidence: 0.2,
    rationale: "No pulse-control intent detected."
  };
}
