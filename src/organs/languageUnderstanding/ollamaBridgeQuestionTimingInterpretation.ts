/**
 * @fileoverview Provides the bounded Ollama-backed bridge-question-timing interpretation task for the shared local conversational runtime.
 */

import type {
  BridgeQuestionTimingInterpretationKind,
  BridgeQuestionTimingInterpretationResolver,
  BridgeQuestionTimingInterpretationSignal,
  LocalIntentModelConfidence,
  LocalIntentModelSessionHints
} from "./localIntentModelContracts";

interface OllamaBridgeQuestionTimingInterpretationConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface OllamaBridgeQuestionTimingInterpretationDependencies {
  fetchImpl?: typeof fetch;
}

interface OllamaGenerateResponse {
  response?: string;
}

interface ParsedBridgeQuestionTimingPayload {
  kind?: string;
  confidence?: string;
  explanation?: string;
}

const SUPPORTED_CONFIDENCE = new Set<LocalIntentModelConfidence>([
  "low",
  "medium",
  "high"
]);

const SUPPORTED_BRIDGE_TIMING_KINDS = new Set<BridgeQuestionTimingInterpretationKind>([
  "ask_now",
  "defer_for_context",
  "non_bridge_context",
  "uncertain"
]);

/**
 * Normalizes an Ollama base URL by trimming trailing slashes.
 *
 * @param value - Raw base URL.
 * @returns Normalized base URL.
 */
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Builds the bounded bridge-question-timing prompt sent to the local Phi model.
 *
 * @param userInput - Raw user request being interpreted.
 * @param routingHint - Optional deterministic routing hint supplied by the front door.
 * @param sessionHints - Optional bounded session hints for the same turn.
 * @param recentTurns - Optional bounded nearby turn context.
 * @param questionPrompt - Optional candidate bridge prompt already approved deterministically.
 * @param entityLabels - Optional bounded entity labels for the same candidate bridge pair.
 * @returns Prompt text constrained to the bridge-question-timing contract.
 */
function buildBridgeQuestionTimingInterpretationPrompt(
  userInput: string,
  routingHint: object | null,
  sessionHints: LocalIntentModelSessionHints | null,
  recentTurns: readonly { role: "user" | "assistant"; text: string }[] | undefined,
  questionPrompt: string | null | undefined,
  entityLabels: readonly string[] | undefined
): string {
  return [
    "Interpret the user's conversational turn for AgentBigBrain.",
    "Return JSON only.",
    "Task: bridge_question_timing_interpretation.",
    "Allowed kind values: ask_now, defer_for_context, non_bridge_context, uncertain.",
    "Allowed confidence values: low, medium, high.",
    "You are deciding whether the current conversational moment feels natural for asking one pending relationship bridge question.",
    "Use ask_now when the current turn is conversationally aligned with the candidate entity pair or relationship context.",
    "Use defer_for_context when the candidate bridge question is reasonable in general but the current turn is workflow-heavy, unrelated, or awkward for interruption.",
    "Use non_bridge_context when the current turn is plainly about something else and there is no natural opening for the bridge question.",
    "Use uncertain only when timing might be appropriate but you cannot choose safely.",
    "Do not invent entities, relationships, or missing context.",
    "Do not decide privacy, cooldown, or mission-safety policy. Those remain deterministic elsewhere.",
    "Examples:",
    '- User turn: "How is Sarah doing?" candidate pair: ["Sarah","Mike"] => {"kind":"ask_now","confidence":"medium"}',
    '- User turn: "Please finish the CSS deployment fix first." candidate pair: ["Sarah","Mike"] => {"kind":"defer_for_context","confidence":"high"}',
    '- User turn: "Who are you?" candidate pair: ["Sarah","Mike"] => {"kind":"non_bridge_context","confidence":"high"}',
    "",
    "User request:",
    userInput,
    "",
    "Deterministic routing hint:",
    JSON.stringify(routingHint),
    "",
    "Session hints:",
    JSON.stringify(sessionHints),
    "",
    "Recent turns:",
    JSON.stringify(recentTurns ?? []),
    "",
    "Candidate bridge question prompt:",
    JSON.stringify(questionPrompt ?? null),
    "",
    "Candidate entity labels:",
    JSON.stringify(entityLabels ?? []),
    "",
    "Reply as one JSON object with keys: kind, confidence, explanation."
  ].join("\n");
}

/**
 * Caps and normalizes the explanation returned by the bridge-question-timing interpreter.
 *
 * @param value - Raw explanation from the model.
 * @param kind - Canonical resolved interpretation kind used as fallback.
 * @returns Short explanation string.
 */
function normalizeExplanation(
  value: string | undefined,
  kind: BridgeQuestionTimingInterpretationKind
): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return `The local intent model classified this bridge-question timing request as ${kind}.`;
  }
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

/**
 * Extracts one JSON object from the raw model response text for bridge-question timing.
 *
 * @param raw - Raw model response text.
 * @returns Parsed payload when JSON could be recovered, otherwise `null`.
 */
function extractJsonObject(raw: string): ParsedBridgeQuestionTimingPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as ParsedBridgeQuestionTimingPayload;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as ParsedBridgeQuestionTimingPayload;
    } catch {
      return null;
    }
  }
}

/**
 * Converts a parsed bridge-question-timing payload into the stable task contract.
 *
 * @param payload - Parsed JSON payload from the model.
 * @returns Stable bridge-question-timing signal, or `null` when the payload is unsupported.
 */
function coerceBridgeQuestionTimingPayload(
  payload: ParsedBridgeQuestionTimingPayload
): BridgeQuestionTimingInterpretationSignal | null {
  const kind = (payload.kind ?? "").trim().toLowerCase() as BridgeQuestionTimingInterpretationKind;
  if (!SUPPORTED_BRIDGE_TIMING_KINDS.has(kind)) {
    return null;
  }
  const confidence = (payload.confidence ?? "").trim().toLowerCase() as LocalIntentModelConfidence;
  if (!SUPPORTED_CONFIDENCE.has(confidence)) {
    return null;
  }
  return {
    source: "local_intent_model",
    kind,
    confidence,
    explanation: normalizeExplanation(payload.explanation, kind)
  };
}

/**
 * Creates the optional Ollama-backed bridge-question-timing interpreter.
 *
 * @param config - Ollama connection settings.
 * @param deps - Optional dependency overrides for tests.
 * @returns Resolver that fails closed on transport, parsing, or coercion errors.
 */
export function createOllamaBridgeQuestionTimingInterpretationResolver(
  config: OllamaBridgeQuestionTimingInterpretationConfig,
  deps: OllamaBridgeQuestionTimingInterpretationDependencies = {}
): BridgeQuestionTimingInterpretationResolver {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const normalizedBaseUrl = normalizeBaseUrl(config.baseUrl);

  return async (request) => {
    const prompt = buildBridgeQuestionTimingInterpretationPrompt(
      request.userInput,
      request.routingClassification,
      request.sessionHints ?? null,
      request.recentTurns,
      request.questionPrompt,
      request.entityLabels
    );
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetchImpl(`${normalizedBaseUrl}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: config.model,
          prompt,
          stream: false,
          options: {
            temperature: 0
          }
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as OllamaGenerateResponse;
      if (typeof payload.response !== "string") {
        return null;
      }
      const parsed = extractJsonObject(payload.response);
      if (!parsed) {
        return null;
      }
      return coerceBridgeQuestionTimingPayload(parsed);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };
}
