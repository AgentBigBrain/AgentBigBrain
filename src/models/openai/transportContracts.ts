/**
 * @fileoverview Shared OpenAI transport, capability, and normalized provider-result contracts.
 */

export type OpenAITransport = "chat_completions" | "responses";
export type OpenAITransportMode = "auto" | OpenAITransport;
export type OpenAIStructuredOutputMode = "json_schema" | "json_object";

export interface OpenAIModelProfile {
  id: string;
  known: boolean;
  preferredTransport: OpenAITransport;
  supportedTransports: readonly OpenAITransport[];
  supportsTemperature: boolean;
  supportsJsonSchemaStructuredOutput: boolean;
  supportsJsonObjectStructuredOutput: boolean;
  supportsReasoningEffort: boolean;
  responseTextExtractionMode: "chat_message_content" | "responses_output_text";
}

export interface OpenAITransportSelection {
  transport: OpenAITransport;
  profile: OpenAIModelProfile;
}

export interface OpenAINormalizedUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface OpenAINormalizedCompletionPayload {
  jsonPayload: string;
  usage: OpenAINormalizedUsage;
}

export interface OpenAIRequestBuildResult {
  path: string;
  requestInit: RequestInit;
  includedTemperature: boolean;
  structuredOutputModeUsed: OpenAIStructuredOutputMode;
}
