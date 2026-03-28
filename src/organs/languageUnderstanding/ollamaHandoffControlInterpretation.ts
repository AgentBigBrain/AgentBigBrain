/**
 * @fileoverview Provides the bounded Ollama-backed handoff-control-interpretation task for the shared local conversational runtime.
 */

import type {
  HandoffControlInterpretationKind,
  HandoffControlInterpretationResolver,
  HandoffControlInterpretationSignal,
  LocalIntentModelConfidence,
  LocalIntentModelSessionHints
} from "./localIntentModelContracts";

interface OllamaHandoffControlInterpretationConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface OllamaHandoffControlInterpretationDependencies {
  fetchImpl?: typeof fetch;
}

interface OllamaGenerateResponse {
  response?: string;
}

interface ParsedHandoffControlInterpretationPayload {
  kind?: string;
  confidence?: string;
  explanation?: string;
}

const SUPPORTED_CONFIDENCE = new Set<LocalIntentModelConfidence>([
  "low",
  "medium",
  "high"
]);

const SUPPORTED_HANDOFF_CONTROL_KINDS = new Set<HandoffControlInterpretationKind>([
  "pause_request",
  "review_request",
  "guided_review_request",
  "while_away_review_request",
  "non_handoff_control",
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
 * Builds the bounded handoff-control prompt sent to the local Phi model.
 *
 * @param userInput - Raw user request being interpreted.
 * @param routingHint - Optional deterministic routing hint supplied by the front door.
 * @param sessionHints - Optional bounded session hints for the same turn.
 * @param recentTurns - Optional bounded nearby turn context.
 * @returns Prompt text constrained to the handoff-control contract.
 */
function buildHandoffControlInterpretationPrompt(
  userInput: string,
  routingHint: object | null,
  sessionHints: LocalIntentModelSessionHints | null,
  recentTurns: readonly { role: "user" | "assistant"; text: string }[] | undefined
): string {
  return [
    "Interpret the user's conversational turn for AgentBigBrain.",
    "Return JSON only.",
    "Task: handoff_control_interpretation.",
    "Allowed kind values: pause_request, review_request, guided_review_request, while_away_review_request, non_handoff_control, uncertain.",
    "Allowed confidence values: low, medium, high.",
    "Use pause_request when the user is clearly asking to stop here, leave the rest for later, or keep the checkpoint for later.",
    "Use review_request when the user wants to see what is ready, what draft exists, or what progress is ready for review.",
    "Use guided_review_request when the user asks what to review first, where to start, or what they should inspect next from saved work.",
    "Use while_away_review_request when the user asks what changed, what happened, or what was finished while they were away, gone, or out.",
    "Use non_handoff_control when the turn is ordinary chat, direct execution, identity, or unrelated recall.",
    "Use uncertain only when handoff control might be involved but you cannot choose safely.",
    "Do not invent project state, browser state, or workflow facts.",
    "Examples:",
    '- "leave the rest for later" => {"kind":"pause_request","confidence":"high"}',
    '- "show me what is ready from that draft" => {"kind":"review_request","confidence":"medium"}',
    '- "what should I look at first when I get back?" => {"kind":"guided_review_request","confidence":"medium"}',
    '- "what changed while I was away?" => {"kind":"while_away_review_request","confidence":"high"}',
    '- "close the browser and update the hero copy" => {"kind":"non_handoff_control","confidence":"high"}',
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
    "Reply as one JSON object with keys: kind, confidence, explanation."
  ].join("\n");
}

/**
 * Caps and normalizes the explanation returned by the handoff-control interpreter.
 *
 * @param value - Raw explanation from the model.
 * @param kind - Canonical resolved interpretation kind used as fallback.
 * @returns Short explanation string.
 */
function normalizeHandoffControlExplanation(
  value: string | undefined,
  kind: HandoffControlInterpretationKind
): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return `The local intent model classified this request as ${kind}.`;
  }
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

/**
 * Extracts one JSON object from the raw model response text for handoff-control interpretation.
 *
 * @param raw - Raw model response text.
 * @returns Parsed payload when JSON could be recovered, otherwise `null`.
 */
function extractHandoffControlJsonObject(
  raw: string
): ParsedHandoffControlInterpretationPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as ParsedHandoffControlInterpretationPayload;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null;
    }
    try {
      return JSON.parse(
        trimmed.slice(firstBrace, lastBrace + 1)
      ) as ParsedHandoffControlInterpretationPayload;
    } catch {
      return null;
    }
  }
}

/**
 * Converts a parsed handoff-control payload into the stable task contract.
 *
 * @param payload - Parsed JSON payload from the model.
 * @returns Stable handoff-control signal, or `null` when the payload is unsupported.
 */
function coerceHandoffControlInterpretationPayload(
  payload: ParsedHandoffControlInterpretationPayload
): HandoffControlInterpretationSignal | null {
  const kind = (payload.kind ?? "").trim().toLowerCase() as HandoffControlInterpretationKind;
  if (!SUPPORTED_HANDOFF_CONTROL_KINDS.has(kind)) {
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
    explanation: normalizeHandoffControlExplanation(payload.explanation, kind)
  };
}

/**
 * Creates the optional Ollama-backed handoff-control interpreter.
 *
 * @param config - Ollama connection settings.
 * @param deps - Optional dependency overrides for tests.
 * @returns Resolver that fails closed on transport, parsing, or coercion errors.
 */
export function createOllamaHandoffControlInterpretationResolver(
  config: OllamaHandoffControlInterpretationConfig,
  deps: OllamaHandoffControlInterpretationDependencies = {}
): HandoffControlInterpretationResolver {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const normalizedBaseUrl = normalizeBaseUrl(config.baseUrl);

  return async (request) => {
    const prompt = buildHandoffControlInterpretationPrompt(
      request.userInput,
      request.routingClassification,
      request.sessionHints ?? null,
      request.recentTurns
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
      const parsed = extractHandoffControlJsonObject(payload.response);
      if (!parsed) {
        return null;
      }
      return coerceHandoffControlInterpretationPayload(parsed);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };
}
