/**
 * @fileoverview Provides the shared Ollama-backed local intent-model provider surface for execution intent and bounded conversational interpretation tasks.
 */

import type { LocalIntentModelResolver, LocalIntentModelSignal } from "./localIntentModelContracts";
import {
  buildConversationSemanticRouteMetadata,
  type ConversationBuildFormatId,
  type ConversationBuildFormatMetadata,
  type ConversationRouteContinuationKind,
  type ConversationRouteExecutionMode,
  type ConversationRouteMemoryIntent,
  type ConversationIntentSemanticHint,
  type ConversationRuntimeControlIntent,
  type ConversationSemanticRouteId,
  semanticRouteIdToIntentMode
} from "../../interfaces/conversationRuntime/intentModeContracts";
import {
  buildLocalIntentPrompt,
  SUPPORTED_ROUTE_IDS,
  type SupportedLocalIntentMode,
  SUPPORTED_CONFIDENCE,
  SUPPORTED_MODES,
  SUPPORTED_SEMANTIC_HINTS
} from "./ollamaLocalIntentPrompt";

export { createOllamaIdentityInterpretationResolver } from "./ollamaIdentityInterpretation";
export { createOllamaRelationshipInterpretationResolver } from "./ollamaRelationshipInterpretation";
export { createOllamaProposalReplyInterpretationResolver } from "./ollamaProposalReplyInterpretation";
export { createOllamaContinuationInterpretationResolver } from "./ollamaContinuationInterpretation";
export { createOllamaAutonomyBoundaryInterpretationResolver } from "./ollamaAutonomyBoundaryInterpretation";
export { createOllamaBridgeQuestionTimingInterpretationResolver } from "./ollamaBridgeQuestionTimingInterpretation";
export { createOllamaContextualFollowupInterpretationResolver } from "./ollamaContextualFollowupInterpretation";
export { createOllamaContextualReferenceInterpretationResolver } from "./ollamaContextualReferenceInterpretation";
export { createOllamaStatusRecallBoundaryInterpretationResolver } from "./ollamaStatusRecallBoundaryInterpretation";
export { createOllamaTopicKeyInterpretationResolver } from "./ollamaTopicKeyInterpretation";
export { createOllamaEntityDomainHintInterpretationResolver } from "./ollamaEntityDomainHintInterpretation";
export { createOllamaEntityReferenceInterpretationResolver } from "./ollamaEntityReferenceInterpretation";
export { createOllamaEntityTypeInterpretationResolver } from "./ollamaEntityTypeInterpretation";
export { createOllamaHandoffControlInterpretationResolver } from "./ollamaHandoffControlInterpretation";

export interface OllamaLocalIntentModelConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export interface OllamaLocalIntentModelProbeResult {
  reachable: boolean;
  modelPresent: boolean;
  availableModels: readonly string[];
}

interface OllamaGenerateResponse {
  response?: string;
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
  }>;
}

interface OllamaLocalIntentModelDependencies {
  fetchImpl?: typeof fetch;
}

interface ParsedLocalIntentModelPayload {
  routeId?: string;
  mode?: string;
  confidence?: string;
  matchedRuleId?: string;
  explanation?: string;
  semanticHint?: string;
  buildFormat?: string | {
    format?: string;
    confidence?: string;
  } | null;
  executionMode?: string;
  continuationKind?: string;
  memoryIntent?: string;
  runtimeControlIntent?: string;
  explicitConstraints?: {
    disallowBrowserOpen?: unknown;
    disallowServerStart?: unknown;
    requiresUserOwnedLocation?: unknown;
  } | null;
}
/**
 * Normalizes base url.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Normalizes an Ollama model name for stable equality checks.
 *
 * @param value - Raw model name.
 * @returns Lowercase normalized model name.
 */
function normalizeModelName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Returns `true` when one discovered Ollama tag matches the configured model name.
 *
 * @param configuredModel - Model name requested by env/runtime config.
 * @param discoveredModel - Model name returned by Ollama.
 * @returns `true` when both names refer to the same Ollama model tag.
 */
function matchesConfiguredModel(configuredModel: string, discoveredModel: string): boolean {
  const configured = normalizeModelName(configuredModel);
  const discovered = normalizeModelName(discoveredModel);
  if (configured === discovered) {
    return true;
  }
  if (configured.endsWith(":latest")) {
    return configured.slice(0, -":latest".length) === discovered;
  }
  return `${configured}:latest` === discovered;
}


/**
 * Normalizes the model-provided rule id into the repo's stable local-intent prefix.
 *
 * @param value - Raw matched rule id returned by the model.
 * @param mode - Canonical resolved mode used as fallback.
 * @returns Stable matched rule id with the `local_intent_model_` prefix.
 */
function normalizeMatchedRuleId(
  value: string | undefined,
  mode: LocalIntentModelSignal["mode"]
): string {
  const raw = (value ?? `${mode}_fallback`).trim().toLowerCase();
  const normalized = raw
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) {
    return `local_intent_model_${mode}`;
  }
  return normalized.startsWith("local_intent_model_")
    ? normalized
    : `local_intent_model_${normalized}`;
}

/**
 * Caps and normalizes the human-readable explanation returned by the model.
 *
 * @param value - Raw explanation from the model.
 * @param mode - Canonical resolved mode used as fallback.
 * @returns Short explanation string.
 */
function normalizeExplanation(
  value: string | undefined,
  mode: LocalIntentModelSignal["mode"]
): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return `The local intent model classified this request as ${mode}.`;
  }
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

/**
 * Normalizes the optional semantic handoff hint returned by the model.
 *
 * @param value - Raw semantic hint from the model.
 * @returns Supported semantic hint, or `null` when missing or unsupported.
 */
function normalizeSemanticHint(
  value: string | undefined
): ConversationIntentSemanticHint | null {
  const normalized = (value ?? "").trim().toLowerCase() as ConversationIntentSemanticHint;
  return SUPPORTED_SEMANTIC_HINTS.has(normalized) ? normalized : null;
}

/**
 * Normalizes semantic route id.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ConversationSemanticRouteId` (import `ConversationSemanticRouteId`) from `../../interfaces/conversationRuntime/intentModeContracts`.
 * - Uses `SUPPORTED_ROUTE_IDS` (import `SUPPORTED_ROUTE_IDS`) from `./ollamaLocalIntentPrompt`.
 * @param value - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function normalizeSemanticRouteId(
  value: string | undefined
): ConversationSemanticRouteId | null {
  const normalized = (value ?? "").trim() as ConversationSemanticRouteId;
  return SUPPORTED_ROUTE_IDS.has(normalized) ? normalized : null;
}

const SUPPORTED_BUILD_FORMATS = new Set<ConversationBuildFormatId>([
  "static_html",
  "framework_app",
  "nextjs",
  "react",
  "vite"
]);
const SUPPORTED_EXECUTION_MODES = new Set<ConversationRouteExecutionMode>([
  "chat",
  "plan",
  "build",
  "autonomous",
  "status_or_recall",
  "review",
  "capability_discovery",
  "unclear"
]);
const SUPPORTED_CONTINUATION_KINDS = new Set<ConversationRouteContinuationKind>([
  "none",
  "answer_thread",
  "workflow_resume",
  "return_handoff",
  "contextual_followup",
  "relationship_memory"
]);
const SUPPORTED_MEMORY_INTENTS = new Set<ConversationRouteMemoryIntent>([
  "none",
  "relationship_recall",
  "profile_update",
  "contextual_recall",
  "document_derived_recall"
]);
const SUPPORTED_RUNTIME_CONTROL_INTENTS = new Set<ConversationRuntimeControlIntent>([
  "none",
  "open_browser",
  "close_browser",
  "verify_browser",
  "inspect_runtime",
  "stop_runtime"
]);

/**
 * Normalizes optional model-emitted build-format metadata.
 *
 * **Why it exists:**
 * Lets the local intent model preserve static/framework output shape without making downstream
 * planner policy re-infer it from natural wording.
 *
 * **What it talks to:**
 * - Uses `ConversationBuildFormatMetadata` from `../../interfaces/conversationRuntime/intentModeContracts`.
 * @param value - Parsed JSON build-format field from the model payload.
 * @returns Typed build-format metadata, or `null` when the model payload is unsupported.
 */
function normalizeBuildFormatMetadata(
  value: ParsedLocalIntentModelPayload["buildFormat"]
): ConversationBuildFormatMetadata | null {
  const rawFormat =
    typeof value === "string"
      ? value
      : typeof value?.format === "string"
        ? value.format
        : "";
  const format = rawFormat.trim().toLowerCase() as ConversationBuildFormatId;
  if (!SUPPORTED_BUILD_FORMATS.has(format)) {
    return null;
  }
  const rawConfidence =
    typeof value === "object" && value !== null && typeof value.confidence === "string"
      ? value.confidence.trim().toLowerCase()
      : "medium";
  const confidence = SUPPORTED_CONFIDENCE.has(rawConfidence as LocalIntentModelSignal["confidence"])
    ? rawConfidence as LocalIntentModelSignal["confidence"]
    : "medium";
  return {
    format,
    source: "semantic_route",
    confidence
  };
}

/**
 * Normalizes one optional string against an allowed literal set.
 *
 * **Why it exists:**
 * Keeps model payload widening fail-closed when the provider returns unsupported route metadata.
 *
 * **What it talks to:**
 * - Uses caller-provided literal sets from this module.
 * @param value - Raw model-emitted string value.
 * @param supported - Supported literal values for the target route metadata field.
 * @returns The normalized supported value, or `null` when unsupported.
 */
function normalizeSupportedValue<T extends string>(
  value: string | undefined,
  supported: ReadonlySet<T>
): T | null {
  const normalized = (value ?? "").trim().toLowerCase() as T;
  return supported.has(normalized) ? normalized : null;
}

/**
 * Infers semantic route id from mode value.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `ConversationSemanticRouteId` (import `ConversationSemanticRouteId`) from `../../interfaces/conversationRuntime/intentModeContracts`.
 * - Uses `SupportedLocalIntentMode` (import `SupportedLocalIntentMode`) from `./ollamaLocalIntentPrompt`.
 * @param mode - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function inferSemanticRouteIdFromModeValue(
  mode: SupportedLocalIntentMode
): ConversationSemanticRouteId {
  switch (mode) {
    case "chat":
      return "chat_answer";
    case "plan":
      return "plan_request";
    case "build":
      return "build_request";
    case "static_html_build":
      return "static_html_build";
    case "framework_app_build":
      return "framework_app_build";
    case "clarify_build_format":
      return "clarify_build_format";
    case "autonomous":
      return "autonomous_execution";
    case "review":
      return "review_feedback";
    case "status_or_recall":
      return "status_recall";
    case "discover_available_capabilities":
      return "capability_discovery";
  }
}

/**
 * Extracts one JSON object from the raw model response text.
 *
 * @param raw - Raw model response text.
 * @returns Parsed payload when JSON could be recovered, otherwise `null`.
 */
function extractJsonObject(raw: string): ParsedLocalIntentModelPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as ParsedLocalIntentModelPayload;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as ParsedLocalIntentModelPayload;
    } catch {
      return null;
    }
  }
}

/**
 * Converts a parsed model payload into the stable local intent-model signal contract.
 *
 * @param payload - Parsed JSON payload from the model.
 * @returns Stable signal when the payload matches supported values, otherwise `null`.
 */
function coerceSignal(payload: ParsedLocalIntentModelPayload): LocalIntentModelSignal | null {
  const explicitRouteId = normalizeSemanticRouteId(payload.routeId);
  const legacyMode = (payload.mode ?? "").trim() as SupportedLocalIntentMode;
  const routeId =
    explicitRouteId
    ?? (
      SUPPORTED_MODES.has(legacyMode)
        ? inferSemanticRouteIdFromModeValue(legacyMode)
        : null
    );
  if (!routeId) {
    return null;
  }
  const mode = semanticRouteIdToIntentMode(routeId);
  const confidence = (payload.confidence ?? "").trim().toLowerCase() as LocalIntentModelSignal["confidence"];
  const supportedRouteMode =
    routeId === "clarify_execution_mode" ||
    SUPPORTED_MODES.has(mode as SupportedLocalIntentMode);
  if (!supportedRouteMode || !SUPPORTED_CONFIDENCE.has(confidence)) {
    return null;
  }
  const rawSemanticHint = normalizeSemanticHint(payload.semanticHint);
  const semanticHint =
    rawSemanticHint === "resume_handoff"
      ? (mode === "build" || mode === "autonomous" || mode === "review"
          ? rawSemanticHint
          : null)
      : (mode === "status_or_recall" ? rawSemanticHint : null);
  const signal: LocalIntentModelSignal = {
    source: "local_intent_model",
    semanticRouteId: routeId,
    mode,
    confidence,
    matchedRuleId: normalizeMatchedRuleId(payload.matchedRuleId, mode),
    explanation: normalizeExplanation(payload.explanation, mode),
    clarification: null,
    semanticHint
  };
  const hasTypedRouteMetadata =
    payload.buildFormat !== undefined ||
    payload.executionMode !== undefined ||
    payload.continuationKind !== undefined ||
    payload.memoryIntent !== undefined ||
    payload.runtimeControlIntent !== undefined ||
    payload.explicitConstraints !== undefined;
  if (!hasTypedRouteMetadata) {
    return signal;
  }
  return {
    ...signal,
    semanticRoute: buildConversationSemanticRouteMetadata(signal, {
      source: "model",
      buildFormat: normalizeBuildFormatMetadata(payload.buildFormat),
      executionMode:
        normalizeSupportedValue(payload.executionMode, SUPPORTED_EXECUTION_MODES) ?? undefined,
      continuationKind:
        normalizeSupportedValue(payload.continuationKind, SUPPORTED_CONTINUATION_KINDS) ??
        undefined,
      memoryIntent:
        normalizeSupportedValue(payload.memoryIntent, SUPPORTED_MEMORY_INTENTS) ?? undefined,
      runtimeControlIntent:
        normalizeSupportedValue(payload.runtimeControlIntent, SUPPORTED_RUNTIME_CONTROL_INTENTS) ??
        undefined,
      explicitConstraints: {
        disallowBrowserOpen: payload.explicitConstraints?.disallowBrowserOpen === true,
        disallowServerStart: payload.explicitConstraints?.disallowServerStart === true,
        requiresUserOwnedLocation: payload.explicitConstraints?.requiresUserOwnedLocation === true
      }
    })
  };
}

/**
 * Runs one JSON HTTP request with a bounded timeout.
 *
 * @param url - Target URL.
 * @param init - Request init payload.
 * @param timeoutMs - Timeout budget for the request.
 * @param fetchImpl - Fetch implementation used for the request.
 * @returns HTTP response object.
 */
async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchImpl: typeof fetch
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Probes the configured Ollama runtime and model availability.
 *
 * @param config - Ollama runtime config.
 * @param deps - Optional dependency overrides for tests.
 * @returns Reachability and model-presence signal for the configured runtime.
 */
export async function probeOllamaLocalIntentModel(
  config: OllamaLocalIntentModelConfig,
  deps: OllamaLocalIntentModelDependencies = {}
): Promise<OllamaLocalIntentModelProbeResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  try {
    const response = await fetchJson(
      `${normalizeBaseUrl(config.baseUrl)}/api/tags`,
      {
        method: "GET"
      },
      config.timeoutMs,
      fetchImpl
    );
    if (!response.ok) {
      return {
        reachable: false,
        modelPresent: false,
        availableModels: []
      };
    }
    const payload = await response.json() as OllamaTagsResponse;
    const availableModels = (payload.models ?? [])
      .flatMap((entry) => [entry.name ?? "", entry.model ?? ""])
      .map((entry) => entry.trim())
      .filter((entry, index, values) => entry.length > 0 && values.indexOf(entry) === index);
    return {
      reachable: true,
      modelPresent: availableModels.some((entry) => matchesConfiguredModel(config.model, entry)),
      availableModels
    };
  } catch {
    return {
      reachable: false,
      modelPresent: false,
      availableModels: []
    };
  }
}

/**
 * Creates the bounded Ollama-backed local intent-model resolver.
 *
 * @param config - Ollama runtime config.
 * @param deps - Optional dependency overrides for tests.
 * @returns Fail-closed local intent-model resolver.
 */
export function createOllamaLocalIntentModelResolver(
  config: OllamaLocalIntentModelConfig,
  deps: OllamaLocalIntentModelDependencies = {}
): LocalIntentModelResolver {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return async (request) => {
    try {
      const routingHint = request.routingClassification
        ? {
          category: request.routingClassification.category,
          routeType: request.routingClassification.routeType,
          actionFamily: request.routingClassification.actionFamily,
          commandIntent: request.routingClassification.commandIntent,
          confidenceTier: request.routingClassification.confidenceTier,
          matchedRuleId: request.routingClassification.matchedRuleId
        }
        : null;
      const response = await fetchJson(
        `${normalizeBaseUrl(config.baseUrl)}/api/generate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: config.model,
            prompt: buildLocalIntentPrompt(
              request.userInput,
              routingHint,
              request.sessionHints ?? null
            ),
            stream: false,
            format: "json",
            options: {
              temperature: 0
            }
          })
        },
        config.timeoutMs,
        fetchImpl
      );
      if (!response.ok) {
        return null;
      }
      const payload = await response.json() as OllamaGenerateResponse;
      if (typeof payload.response !== "string") {
        return null;
      }
      return coerceSignal(extractJsonObject(payload.response) ?? {});
    } catch {
      return null;
    }
  };
}
