/**
 * @fileoverview Deterministic mock response-synthesis builders.
 */

import type { ResponseSynthesisModelOutput } from "../types";
import { parseJsonObject, resolveActiveMockUserInput } from "./contracts";

/**
 * Builds response synthesis output for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps deterministic mock chat-synthesis behavior in a canonical subsystem instead of mixing it
 * into the stable `mockModelClient.ts` entrypoint.
 *
 * **What it talks to:**
 * - Uses `ResponseSynthesisModelOutput` (import `ResponseSynthesisModelOutput`) from `../types`.
 * - Uses shared prompt helpers from `./contracts`.
 *
 * @param userPrompt - Message/text content processed by this function.
 * @returns Computed `ResponseSynthesisModelOutput` result.
 */
export function buildResponseSynthesisOutput(userPrompt: string): ResponseSynthesisModelOutput {
  const input = parseJsonObject(userPrompt);
  const userInput = resolveActiveMockUserInput(input, userPrompt).trim();
  const normalizedInput = userInput.toLowerCase();

  if (!userInput) {
    return {
      message: "I am ready to help. Tell me what you want to work on."
    };
  }

  if (/^(hello|hi|hey)\b/.test(normalizedInput)) {
    return {
      message: "Hello! I am online and ready to help."
    };
  }

  const sayMatch = userInput.match(/^say\s+(.+)$/i);
  if (sayMatch) {
    return {
      message: sayMatch[1].trim()
    };
  }

  const sentenceMatch = userInput.match(
    /^(?:tell me|give me|write)(?:\s+(?:a|one))?\s+sentence about\s+(.+)$/i
  );
  if (sentenceMatch) {
    const topic = sentenceMatch[1].trim().replace(/[.!?]+$/, "");
    return {
      message: `${topic.charAt(0).toUpperCase()}${topic.slice(1)} is vast and full of discoveries that shape how we understand reality.`
    };
  }

  return {
    message: "I can help with that. Share a little more detail and I will answer precisely."
  };
}
