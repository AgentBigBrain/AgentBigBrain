/**
 * @fileoverview Builds OpenAI Chat Completions request payloads for structured runtime calls.
 */

import { buildOpenAIJsonObjectContract, buildOpenAIResponseFormatContract } from "./schemaEnvelope";
import type { ResolvedOpenAIModel } from "./pricingPolicy";
import type { StructuredCompletionRequest } from "../types";
import type {
  OpenAIRequestBuildResult,
  OpenAIStructuredOutputMode
} from "./transportContracts";

interface BuildOpenAIChatCompletionRequestInput {
  apiKey: string;
  model: ResolvedOpenAIModel;
  request: StructuredCompletionRequest;
  abortSignal: AbortSignal;
  includeTemperature: boolean;
  structuredOutputMode: OpenAIStructuredOutputMode;
}

/**
 * Builds the canonical instruction block appended to system prompts for structured JSON output.
 *
 * **Why it exists:**
 * Both Chat Completions and Responses paths need the same deterministic instruction suffix so the
 * model receives consistent formatting guidance regardless of transport choice.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param schemaName - Schema id used for the structured runtime request.
 * @returns Instruction suffix appended to the system prompt.
 */
function buildStructuredOutputInstruction(schemaName: string): string {
  return `Return only valid JSON for schema ${schemaName}.`;
}

/**
 * Resolves the response-format contract for one Chat Completions request.
 *
 * **Why it exists:**
 * Compatibility fallback can intentionally degrade strict schema mode to JSON-object mode, so the
 * request builder must own the actual response-format contract emitted for each attempt.
 *
 * **What it talks to:**
 * - Uses `buildOpenAIJsonObjectContract` from `./schemaEnvelope`.
 * - Uses `buildOpenAIResponseFormatContract` from `./schemaEnvelope`.
 *
 * @param schemaName - Logical schema id requested by the caller.
 * @param structuredOutputMode - Requested output mode for this attempt.
 * @returns Provider response-format contract plus the actual mode emitted.
 */
function buildChatResponseFormatContract(
  schemaName: string,
  structuredOutputMode: OpenAIStructuredOutputMode
): {
  contract: ReturnType<typeof buildOpenAIResponseFormatContract>;
  modeUsed: OpenAIStructuredOutputMode;
} {
  if (structuredOutputMode === "json_object") {
    return {
      contract: buildOpenAIJsonObjectContract(),
      modeUsed: "json_object"
    };
  }

  const contract = buildOpenAIResponseFormatContract(schemaName);
  return {
    contract,
    modeUsed: contract.type === "json_schema" ? "json_schema" : "json_object"
  };
}

/**
 * Builds one Chat Completions request for a structured OpenAI model call.
 *
 * **Why it exists:**
 * Keeps Chat Completions request assembly isolated from transport selection and provider response
 * parsing so the model client can switch transports without duplicating payload logic.
 *
 * **What it talks to:**
 * - Uses `buildOpenAIJsonObjectContract` and `buildOpenAIResponseFormatContract` from
 *   `./schemaEnvelope`.
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured request plus transport-specific attempt options.
 * @returns Request path and `RequestInit` payload for the Chat Completions endpoint.
 */
export function buildOpenAIChatCompletionRequest(
  input: BuildOpenAIChatCompletionRequestInput
): OpenAIRequestBuildResult {
  const responseFormat = buildChatResponseFormatContract(
    input.request.schemaName,
    input.structuredOutputMode
  );
  const body: Record<string, unknown> = {
    model: input.model.providerModel,
    response_format: responseFormat.contract,
    messages: [
      {
        role: "system",
        content:
          `${input.request.systemPrompt}\n${buildStructuredOutputInstruction(input.request.schemaName)}`
      },
      {
        role: "user",
        content: input.request.userPrompt
      }
    ]
  };

  if (input.includeTemperature) {
    body.temperature = input.request.temperature ?? 0;
  }

  return {
    path: "/chat/completions",
    requestInit: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: input.abortSignal
    },
    includedTemperature: input.includeTemperature,
    structuredOutputModeUsed: responseFormat.modeUsed
  };
}
