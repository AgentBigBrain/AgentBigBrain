/**
 * @fileoverview Provides the bounded Ollama-backed autonomy-boundary interpretation task for the shared local conversational runtime.
 */

import type {
  AutonomyBoundaryInterpretationKind,
  AutonomyBoundaryInterpretationResolver,
  AutonomyBoundaryInterpretationSignal,
  LocalIntentModelConfidence,
  LocalIntentModelSessionHints
} from "./localIntentModelContracts";

interface OllamaAutonomyBoundaryInterpretationConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface OllamaAutonomyBoundaryInterpretationDependencies {
  fetchImpl?: typeof fetch;
}

interface OllamaGenerateResponse {
  response?: string;
}

interface ParsedAutonomyBoundaryPayload {
  kind?: string;
  confidence?: string;
  explanation?: string;
}

const SUPPORTED_CONFIDENCE = new Set<LocalIntentModelConfidence>([
  "low",
  "medium",
  "high"
]);

const SUPPORTED_AUTONOMY_BOUNDARY_KINDS = new Set<AutonomyBoundaryInterpretationKind>([
  "promote_to_autonomous",
  "keep_as_build",
  "keep_as_chat",
  "uncertain"
]);

/** Normalizes an Ollama base URL by trimming trailing slashes. */
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Builds the bounded autonomy-boundary prompt sent to the local Phi model.
 *
 * @param userInput - Raw user request being interpreted.
 * @param routingHint - Optional deterministic routing hint supplied by the front door.
 * @param sessionHints - Optional bounded session hints for the same turn.
 * @param recentTurns - Optional bounded nearby turn context.
 * @param deterministicSignalStrength - Optional bounded deterministic autonomy strength.
 * @returns Prompt text constrained to the autonomy-boundary contract.
 */
function buildAutonomyBoundaryInterpretationPrompt(
  userInput: string,
  routingHint: object | null,
  sessionHints: LocalIntentModelSessionHints | null,
  recentTurns: readonly { role: "user" | "assistant"; text: string }[] | undefined,
  deterministicSignalStrength: string | null | undefined
): string {
  return [
    "Interpret the user's conversational turn for AgentBigBrain.",
    "Return JSON only.",
    "Task: autonomy_boundary_interpretation.",
    "Allowed kind values: promote_to_autonomous, keep_as_build, keep_as_chat, uncertain.",
    "Allowed confidence values: low, medium, high.",
    "You are deciding what to do with ambiguous end-to-end ownership wording after deterministic routing has already identified an autonomy-related candidate.",
    "Use promote_to_autonomous only when the user is clearly asking the assistant to own the work to completion.",
    "Use keep_as_build when the user clearly wants execution or implementation, but the wording does not justify a long autonomous loop.",
    "Use keep_as_chat when the turn is conversational, profile-oriented, or otherwise not a workflow ownership request.",
    "Use uncertain only when the boundary is genuinely unclear after considering the bounded context.",
    "Workflow continuity, active work context, and direct execution artifacts can support promote_to_autonomous.",
    "Profile or relationship context without workflow continuity should push ambiguous end-to-end wording away from autonomous promotion.",
    "Do not invent files, browser actions, or missing workflow context.",
    "Do not decide governance, approval, or worker ownership policy. Those remain deterministic elsewhere.",
    "Examples:",
    '- Input: "Take care of it end to end and leave the preview open." with workflow continuity => {"kind":"promote_to_autonomous","confidence":"medium"}',
    '- Input: "Handle this all the way through." with no workflow context => {"kind":"keep_as_chat","confidence":"medium"}',
    '- Input: "Finish the landing page and ship it now." => {"kind":"keep_as_build","confidence":"medium"}',
    '- Input: "Keep going until it is done." => {"kind":"promote_to_autonomous","confidence":"high"}',
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
    "Deterministic autonomy signal strength:",
    JSON.stringify(deterministicSignalStrength ?? null),
    "",
    "Reply as one JSON object with keys: kind, confidence, explanation."
  ].join("\n");
}

/** Caps and normalizes the explanation returned by the autonomy-boundary interpreter. */
function normalizeExplanation(
  value: string | undefined,
  kind: AutonomyBoundaryInterpretationKind
): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return `The local intent model classified this autonomy-boundary request as ${kind}.`;
  }
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

/** Extracts one JSON object from the raw model response text for autonomy-boundary interpretation. */
function extractJsonObject(raw: string): ParsedAutonomyBoundaryPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as ParsedAutonomyBoundaryPayload;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as ParsedAutonomyBoundaryPayload;
    } catch {
      return null;
    }
  }
}

/** Converts a parsed autonomy-boundary payload into the stable task contract. */
function coerceAutonomyBoundaryPayload(
  payload: ParsedAutonomyBoundaryPayload
): AutonomyBoundaryInterpretationSignal | null {
  const kind = (payload.kind ?? "").trim().toLowerCase() as AutonomyBoundaryInterpretationKind;
  if (!SUPPORTED_AUTONOMY_BOUNDARY_KINDS.has(kind)) {
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
 * Creates the optional Ollama-backed autonomy-boundary interpreter.
 *
 * @param config - Ollama connection settings.
 * @param deps - Optional dependency overrides for tests.
 * @returns Resolver that fails closed on transport, parsing, or coercion errors.
 */
export function createOllamaAutonomyBoundaryInterpretationResolver(
  config: OllamaAutonomyBoundaryInterpretationConfig,
  deps: OllamaAutonomyBoundaryInterpretationDependencies = {}
): AutonomyBoundaryInterpretationResolver {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const normalizedBaseUrl = normalizeBaseUrl(config.baseUrl);

  return async (request) => {
    const prompt = buildAutonomyBoundaryInterpretationPrompt(
      request.userInput,
      request.routingClassification,
      request.sessionHints ?? null,
      request.recentTurns,
      request.deterministicSignalStrength
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
      return coerceAutonomyBoundaryPayload(parsed);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };
}
