/**
 * @fileoverview Builds OpenAI Responses API request payloads for structured runtime calls.
 */

import {
  buildOpenAITextFormatContract,
  buildOpenAITextJsonObjectContract
} from "./schemaEnvelope";
import { resolveOpenAIResponsesReasoningEffort } from "./modelProfiles";
import type { ResolvedOpenAIModel } from "./pricingPolicy";
import type { StructuredCompletionRequest } from "../types";
import type {
  OpenAIRequestBuildResult,
  OpenAIStructuredOutputMode
} from "./transportContracts";

interface BuildOpenAIResponsesRequestInput {
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
 * Chat Completions and Responses attempts should share one stable prompt suffix so transport
 * switching does not change the human-readable instruction contract unnecessarily.
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
 * Resolves the structured text-format contract for one Responses API request.
 *
 * **Why it exists:**
 * The Responses API moves structured outputs under `text.format`, and compatibility fallback may
 * intentionally degrade the format to `json_object` mode for one retry attempt.
 *
 * **What it talks to:**
 * - Uses `buildOpenAIJsonObjectContract` from `./schemaEnvelope`.
 * - Uses `buildOpenAITextFormatContract` from `./schemaEnvelope`.
 *
 * @param schemaName - Logical schema id requested by the caller.
 * @param structuredOutputMode - Requested output mode for this attempt.
 * @returns Provider text-format contract plus the actual mode emitted.
 */
function buildResponsesTextFormatContract(
  schemaName: string,
  structuredOutputMode: OpenAIStructuredOutputMode
): {
  contract: ReturnType<typeof buildOpenAITextFormatContract>;
  modeUsed: OpenAIStructuredOutputMode;
} {
  if (structuredOutputMode === "json_object") {
    return {
      contract: buildOpenAITextJsonObjectContract(),
      modeUsed: "json_object"
    };
  }

  const contract = buildOpenAITextFormatContract(schemaName);
  return {
    contract,
    modeUsed: contract.type === "json_schema" ? "json_schema" : "json_object"
  };
}

/**
 * Builds one Responses API request for a structured OpenAI model call.
 *
 * **Why it exists:**
 * Keeps Responses request assembly transport-specific so the model client can move between Chat
 * Completions and Responses without embedding transport details in the entrypoint.
 *
 * **What it talks to:**
 * - Uses `buildOpenAIJsonObjectContract` and `buildOpenAITextFormatContract` from
 *   `./schemaEnvelope`.
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured request plus transport-specific attempt options.
 * @returns Request path and `RequestInit` payload for the Responses endpoint.
 */
export function buildOpenAIResponsesRequest(
  input: BuildOpenAIResponsesRequestInput
): OpenAIRequestBuildResult {
  const textFormat = buildResponsesTextFormatContract(
    input.request.schemaName,
    input.structuredOutputMode
  );
  const body: Record<string, unknown> = {
    model: input.model.providerModel,
    input: [
      {
        role: "system",
        content: [
          {
            type: "input_text",
            text:
              `${input.request.systemPrompt}\n${buildStructuredOutputInstruction(input.request.schemaName)}`
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: input.request.userPrompt
          }
        ]
      }
    ],
    text: {
      format: textFormat.contract
    }
  };

  if (input.includeTemperature) {
    body.temperature = input.request.temperature ?? 0;
  }

  const reasoningEffort = resolveOpenAIResponsesReasoningEffort(input.model.providerModel);
  if (reasoningEffort !== null) {
    body.reasoning = {
      effort: reasoningEffort
    };
  }

  return {
    path: "/responses",
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
    structuredOutputModeUsed: textFormat.modeUsed
  };
}
