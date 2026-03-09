/**
 * @fileoverview Resolves OpenAI model-family capability profiles and transport selection rules.
 */

import type {
  OpenAIModelProfile,
  OpenAITransport,
  OpenAITransportMode,
  OpenAITransportSelection
} from "./transportContracts";

export type OpenAIResponsesReasoningEffort = "none" | "minimal" | "low";

interface OpenAIProfileDefinition {
  id: string;
  match: RegExp;
  profile: OpenAIModelProfile;
}

const KNOWN_MODEL_PROFILES: readonly OpenAIProfileDefinition[] = [
  {
    id: "gpt-5-family",
    match: /^gpt-5(?:$|[-.])/i,
    profile: {
      id: "gpt-5-family",
      known: true,
      preferredTransport: "responses",
      supportedTransports: ["responses", "chat_completions"],
      supportsTemperature: false,
      supportsJsonSchemaStructuredOutput: true,
      supportsJsonObjectStructuredOutput: true,
      supportsReasoningEffort: true,
      responseTextExtractionMode: "responses_output_text"
    }
  },
  {
    id: "gpt-4.1-family",
    match: /^gpt-4\.1(?:$|[-.])/i,
    profile: {
      id: "gpt-4.1-family",
      known: true,
      preferredTransport: "chat_completions",
      supportedTransports: ["chat_completions", "responses"],
      supportsTemperature: true,
      supportsJsonSchemaStructuredOutput: true,
      supportsJsonObjectStructuredOutput: true,
      supportsReasoningEffort: false,
      responseTextExtractionMode: "chat_message_content"
    }
  },
  {
    id: "gpt-4o-family",
    match: /^gpt-4o(?:$|[-.])/i,
    profile: {
      id: "gpt-4o-family",
      known: true,
      preferredTransport: "chat_completions",
      supportedTransports: ["chat_completions", "responses"],
      supportsTemperature: true,
      supportsJsonSchemaStructuredOutput: true,
      supportsJsonObjectStructuredOutput: true,
      supportsReasoningEffort: false,
      responseTextExtractionMode: "chat_message_content"
    }
  },
  {
    id: "gpt-4-turbo-family",
    match: /^gpt-4-turbo(?:$|[-.])/i,
    profile: {
      id: "gpt-4-turbo-family",
      known: true,
      preferredTransport: "chat_completions",
      supportedTransports: ["chat_completions"],
      supportsTemperature: true,
      supportsJsonSchemaStructuredOutput: true,
      supportsJsonObjectStructuredOutput: true,
      supportsReasoningEffort: false,
      responseTextExtractionMode: "chat_message_content"
    }
  },
  {
    id: "gpt-3.5-turbo-family",
    match: /^gpt-3\.5-turbo(?:$|[-.])/i,
    profile: {
      id: "gpt-3.5-turbo-family",
      known: true,
      preferredTransport: "chat_completions",
      supportedTransports: ["chat_completions"],
      supportsTemperature: true,
      supportsJsonSchemaStructuredOutput: true,
      supportsJsonObjectStructuredOutput: true,
      supportsReasoningEffort: false,
      responseTextExtractionMode: "chat_message_content"
    }
  }
] as const;

/**
 * Parses one environment transport override into the supported OpenAI transport modes.
 *
 * **Why it exists:**
 * Keeps environment-to-runtime normalization in one place so callers do not duplicate string
 * handling or drift on accepted override values.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Raw env value used to override transport selection.
 * @returns Normalized transport mode.
 */
export function parseOpenAITransportMode(value: string | undefined): OpenAITransportMode {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized || normalized === "auto") {
    return "auto";
  }
  if (normalized === "chat_completions" || normalized === "chat") {
    return "chat_completions";
  }
  if (normalized === "responses" || normalized === "response") {
    return "responses";
  }
  throw new Error(
    "OPENAI_TRANSPORT_MODE must be set to 'auto', 'chat_completions', or 'responses'."
  );
}

/**
 * Resolves whether strict compatibility mode is enabled for transport selection.
 *
 * **Why it exists:**
 * Gives the runtime one deterministic place to decide whether unknown or unsupported combinations
 * should fail closed or fall back to a lowest-common-denominator compatibility path.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Raw env value controlling compatibility strictness.
 * @returns `true` when strict compatibility mode is enabled.
 */
export function parseOpenAICompatibilityStrict(value: string | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

/**
 * Resolves the canonical model-family profile for one provider model id.
 *
 * **Why it exists:**
 * Centralizes model-family capability ownership so transport selection, request builders, and
 * fallback logic all consult one registry instead of duplicating heuristics.
 *
 * **What it talks to:**
 * - Uses local profile definitions within this module.
 *
 * @param providerModel - Concrete provider model id chosen for the request.
 * @returns Capability profile for the resolved provider model.
 */
export function resolveOpenAIModelProfile(providerModel: string): OpenAIModelProfile {
  for (const definition of KNOWN_MODEL_PROFILES) {
    if (definition.match.test(providerModel)) {
      return { ...definition.profile, supportedTransports: [...definition.profile.supportedTransports] };
    }
  }

  return {
    id: "unknown-model-family",
    known: false,
    preferredTransport: "chat_completions",
    supportedTransports: ["chat_completions", "responses"],
    supportsTemperature: false,
    supportsJsonSchemaStructuredOutput: true,
    supportsJsonObjectStructuredOutput: true,
    supportsReasoningEffort: false,
    responseTextExtractionMode: "chat_message_content"
  };
}

/**
 * Chooses the OpenAI transport for one model after applying env overrides and strictness policy.
 *
 * **Why it exists:**
 * Keeps transport resolution deterministic and auditable so the public model client does not embed
 * implicit model-family policy in the request path itself.
 *
 * **What it talks to:**
 * - Uses `resolveOpenAIModelProfile` from this module.
 * - Uses local constants/helpers within this module.
 *
 * @param providerModel - Concrete provider model id chosen for the request.
 * @param transportMode - Env-normalized requested transport mode.
 * @param compatibilityStrict - Whether unsupported or unknown combinations must fail closed.
 * @returns Selected transport plus the resolved model profile.
 */
export function resolveOpenAITransportSelection(
  providerModel: string,
  transportMode: OpenAITransportMode,
  compatibilityStrict: boolean
): OpenAITransportSelection {
  const profile = resolveOpenAIModelProfile(providerModel);
  if (!profile.known && compatibilityStrict) {
    throw new Error(
      `OpenAI model "${providerModel}" is not in the compatibility registry. ` +
      "Set OPENAI_COMPATIBILITY_STRICT=false to allow lowest-common-denominator transport selection."
    );
  }

  if (transportMode === "auto") {
    return {
      transport: profile.preferredTransport,
      profile
    };
  }

  if (profile.supportedTransports.includes(transportMode)) {
    return {
      transport: transportMode,
      profile
    };
  }

  if (compatibilityStrict) {
    throw new Error(
      `OpenAI transport "${transportMode}" is not supported for model "${providerModel}" ` +
      `under profile "${profile.id}".`
    );
  }

  return {
    transport: transportMode,
    profile
  };
}

/**
 * Returns the alternate transport when one model profile supports both OpenAI transports.
 *
 * **Why it exists:**
 * Fallback logic needs a stable way to move between compatible transports without re-encoding the
 * transport list ordering in multiple call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param transport - Currently selected OpenAI transport.
 * @returns Alternate transport or `null` when none exists.
 */
export function getAlternateOpenAITransport(transport: OpenAITransport): OpenAITransport | null {
  return transport === "chat_completions" ? "responses" : "chat_completions";
}

/**
 * Chooses an explicit Responses API reasoning effort for latency-sensitive GPT-5 family requests.
 *
 * **Why it exists:**
 * GPT-5-family defaults are not uniform. The base `gpt-5` model defaults to a slower reasoning
 * mode than `gpt-5.1` / `gpt-5.2`, so autonomous live-smoke flows need one deterministic policy
 * that keeps the request within practical latency bounds.
 *
 * **What it talks to:**
 * - Uses local model-family matching rules within this module.
 *
 * @param providerModel - Concrete provider model id chosen for the request.
 * @returns Explicit reasoning effort for Responses API requests, or `null` when none is needed.
 */
export function resolveOpenAIResponsesReasoningEffort(
  providerModel: string
): OpenAIResponsesReasoningEffort | null {
  if (/^gpt-5(?:-[0-9]{4}-[0-9]{2}-[0-9]{2})?$/i.test(providerModel)) {
    return "minimal";
  }
  if (/^gpt-5\.(?:1|2)(?:$|[-.])/i.test(providerModel)) {
    return "none";
  }
  if (/^gpt-5\.3-codex(?:$|[-.])/i.test(providerModel)) {
    return "low";
  }
  if (/^gpt-5(?:$|[-.])/i.test(providerModel)) {
    return "low";
  }
  return null;
}
