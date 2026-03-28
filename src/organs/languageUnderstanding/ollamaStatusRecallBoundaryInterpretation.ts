/**
 * @fileoverview Provides the bounded Ollama-backed status/recall-vs-execute-now interpretation
 * task for the shared local conversational runtime.
 */

import type {
  LocalIntentModelConfidence,
  LocalIntentModelSessionHints,
  StatusRecallBoundaryFocus,
  StatusRecallBoundaryInterpretationKind,
  StatusRecallBoundaryInterpretationResolver,
  StatusRecallBoundaryInterpretationSignal
} from "./localIntentModelContracts";

interface OllamaStatusRecallBoundaryInterpretationConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface OllamaStatusRecallBoundaryInterpretationDependencies {
  fetchImpl?: typeof fetch;
}

interface OllamaGenerateResponse {
  response?: string;
}

interface ParsedStatusRecallBoundaryPayload {
  kind?: string;
  focus?: string | null;
  confidence?: string;
  explanation?: string;
}

const SUPPORTED_CONFIDENCE = new Set<LocalIntentModelConfidence>([
  "low",
  "medium",
  "high"
]);

const SUPPORTED_KINDS = new Set<StatusRecallBoundaryInterpretationKind>([
  "status_or_recall",
  "execute_now",
  "non_status_boundary",
  "uncertain"
]);

const SUPPORTED_FOCUS = new Set<Exclude<StatusRecallBoundaryFocus, null>>([
  "change_summary",
  "return_handoff",
  "location",
  "browser",
  "progress",
  "waiting"
]);

/** Normalizes an Ollama base URL by trimming trailing slashes. */
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Builds the bounded status-recall-boundary prompt sent to the local Phi model.
 *
 * @param userInput - Raw user request being interpreted.
 * @param routingHint - Optional deterministic routing hint supplied by the front door.
 * @param sessionHints - Optional bounded session hints for the same turn.
 * @param recentTurns - Optional bounded nearby turn context.
 * @param deterministicPreference - Optional bounded deterministic boundary candidate.
 * @returns Prompt text constrained to the status-recall-boundary contract.
 */
function buildStatusRecallBoundaryPrompt(
  userInput: string,
  routingHint: object | null,
  sessionHints: LocalIntentModelSessionHints | null,
  recentTurns:
    | readonly {
        role: "user" | "assistant";
        text: string;
      }[]
    | undefined,
  deterministicPreference: "status_or_recall" | "execute_now" | null | undefined
): string {
  return [
    "Interpret the user's conversational turn for AgentBigBrain.",
    "Return JSON only.",
    "Task: status_recall_boundary_interpretation.",
    "Allowed kind values: status_or_recall, execute_now, non_status_boundary, uncertain.",
    "Allowed focus values: change_summary, return_handoff, location, browser, progress, waiting, null.",
    "Allowed confidence values: low, medium, high.",
    "You are deciding whether an ambiguous turn belongs on the status/recall path or the execute-now path.",
    "Use status_or_recall when the user is asking what changed, what is ready, what happened, where something is, what is open, what the current status is, or what the assistant is waiting on.",
    "Use execute_now when the user is asking the assistant to do or change something now.",
    "Use non_status_boundary when the turn is neither side of this boundary, such as plain chat, identity, or unrelated guidance.",
    "Use uncertain only when the boundary is genuinely unclear after considering the bounded context.",
    "Set focus only when kind is status_or_recall and the request clearly leans toward one recall/status slice.",
    "Do not invent files, paths, browser sessions, or workflow steps that are not present in the request or bounded context.",
    "Do not decide worker, governor, or approval policy. Those remain deterministic elsewhere.",
    "Examples:",
    '- Input: "What did you change on that page?" => {"kind":"status_or_recall","focus":"change_summary","confidence":"high"}',
    '- Input: "Where did you put it?" => {"kind":"status_or_recall","focus":"location","confidence":"high"}',
    '- Input: "What is still open?" => {"kind":"status_or_recall","focus":"browser","confidence":"medium"}',
    '- Input: "What are you waiting on from me?" => {"kind":"status_or_recall","focus":"waiting","confidence":"high"}',
    '- Input: "Change that section now." => {"kind":"execute_now","focus":null,"confidence":"high"}',
    '- Input: "Show me what is ready and then keep going." => {"kind":"uncertain","focus":null,"confidence":"low"}',
    '- Input: "Hi, what is your name?" => {"kind":"non_status_boundary","focus":null,"confidence":"high"}',
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
    "Deterministic boundary preference:",
    JSON.stringify(deterministicPreference ?? null),
    "",
    "Reply as one JSON object with keys: kind, focus, confidence, explanation."
  ].join("\n");
}

/** Caps and normalizes the explanation returned by the status-recall-boundary interpreter. */
function normalizeExplanation(
  value: string | undefined,
  kind: StatusRecallBoundaryInterpretationKind
): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return `The local intent model classified this status-recall boundary request as ${kind}.`;
  }
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

/** Extracts one JSON object from the raw model response text for status-recall-boundary interpretation. */
function extractJsonObject(raw: string): ParsedStatusRecallBoundaryPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as ParsedStatusRecallBoundaryPayload;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as ParsedStatusRecallBoundaryPayload;
    } catch {
      return null;
    }
  }
}

/** Normalizes the optional focus returned by the status-recall-boundary interpreter. */
function normalizeFocus(
  value: string | null | undefined
): StatusRecallBoundaryFocus {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized || normalized === "null") {
    return null;
  }
  return SUPPORTED_FOCUS.has(normalized as Exclude<StatusRecallBoundaryFocus, null>)
    ? (normalized as Exclude<StatusRecallBoundaryFocus, null>)
    : null;
}

/** Converts a parsed status-recall-boundary payload into the stable task contract. */
function coerceStatusRecallBoundaryPayload(
  payload: ParsedStatusRecallBoundaryPayload
): StatusRecallBoundaryInterpretationSignal | null {
  const kind = (payload.kind ?? "").trim().toLowerCase() as StatusRecallBoundaryInterpretationKind;
  if (!SUPPORTED_KINDS.has(kind)) {
    return null;
  }
  const confidence = (payload.confidence ?? "").trim().toLowerCase() as LocalIntentModelConfidence;
  if (!SUPPORTED_CONFIDENCE.has(confidence)) {
    return null;
  }
  const focus = normalizeFocus(payload.focus);
  return {
    source: "local_intent_model",
    kind,
    focus: kind === "status_or_recall" ? focus : null,
    confidence,
    explanation: normalizeExplanation(payload.explanation, kind)
  };
}

/**
 * Creates the optional Ollama-backed status-recall-boundary interpreter.
 *
 * @param config - Ollama connection settings.
 * @param deps - Optional dependency overrides for tests.
 * @returns Resolver that fails closed on transport, parsing, or coercion errors.
 */
export function createOllamaStatusRecallBoundaryInterpretationResolver(
  config: OllamaStatusRecallBoundaryInterpretationConfig,
  deps: OllamaStatusRecallBoundaryInterpretationDependencies = {}
): StatusRecallBoundaryInterpretationResolver {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const normalizedBaseUrl = normalizeBaseUrl(config.baseUrl);

  return async (request) => {
    const prompt = buildStatusRecallBoundaryPrompt(
      request.userInput,
      request.routingClassification,
      request.sessionHints ?? null,
      request.recentTurns,
      request.deterministicPreference
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
      return coerceStatusRecallBoundaryPayload(parsed);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };
}
