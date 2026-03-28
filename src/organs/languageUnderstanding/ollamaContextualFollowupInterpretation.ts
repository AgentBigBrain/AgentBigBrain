/**
 * @fileoverview Provides the bounded Ollama-backed contextual-followup-interpretation task for the shared local conversational runtime.
 */

import type {
  ContextualFollowupInterpretationKind,
  ContextualFollowupInterpretationResolver,
  ContextualFollowupInterpretationSignal,
  LocalIntentModelConfidence,
  LocalIntentModelSessionHints
} from "./localIntentModelContracts";

interface OllamaContextualFollowupInterpretationConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface OllamaContextualFollowupInterpretationDependencies {
  fetchImpl?: typeof fetch;
}

interface OllamaGenerateResponse {
  response?: string;
}

interface ParsedContextualFollowupInterpretationPayload {
  kind?: string;
  candidateTokens?: unknown;
  confidence?: string;
  explanation?: string;
}

const SUPPORTED_CONFIDENCE = new Set<LocalIntentModelConfidence>([
  "low",
  "medium",
  "high"
]);

const SUPPORTED_CONTEXTUAL_FOLLOWUP_KINDS = new Set<ContextualFollowupInterpretationKind>([
  "status_followup",
  "reminder_followup",
  "non_contextual_followup",
  "uncertain"
]);

const MAX_CANDIDATE_TOKENS = 6;
const MAX_CANDIDATE_TOKEN_LENGTH = 32;

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
 * Builds the bounded contextual-followup prompt sent to the local Phi model.
 *
 * @param userInput - Raw user request being interpreted.
 * @param routingHint - Optional deterministic routing hint supplied by the front door.
 * @param sessionHints - Optional bounded session hints for the same turn.
 * @param recentTurns - Optional bounded nearby turn context.
 * @param deterministicCandidateTokens - Optional lexical candidate tokens already extracted.
 * @returns Prompt text constrained to the contextual-followup contract.
 */
function buildContextualFollowupInterpretationPrompt(
  userInput: string,
  routingHint: object | null,
  sessionHints: LocalIntentModelSessionHints | null,
  recentTurns: readonly { role: "user" | "assistant"; text: string }[] | undefined,
  deterministicCandidateTokens: readonly string[] | undefined
): string {
  return [
    "Interpret the user's conversational turn for AgentBigBrain.",
    "Return JSON only.",
    "Task: contextual_followup_interpretation.",
    "Allowed kind values: status_followup, reminder_followup, non_contextual_followup, uncertain.",
    "Allowed confidence values: low, medium, high.",
    "Use status_followup when the user is asking for a later update, check-in, status, or follow-up about an existing topic or thread.",
    "Use reminder_followup when the user is explicitly asking to be reminded later about an existing topic.",
    "Use non_contextual_followup for direct execution, browser control, identity, ordinary chat, or turns that are not asking for a future update or reminder.",
    "Use uncertain only when contextual follow-up might be involved but you cannot choose safely.",
    "candidateTokens must be a short lowercase topic anchor list taken from the user request only.",
    "Do not invent entities, files, paths, or topics that are not present in the request.",
    "Keep candidateTokens empty when no safe topic anchor exists.",
    "Examples:",
    '- "check in on the Sarah situation later" => {"kind":"status_followup","candidateTokens":["sarah","situation"],"confidence":"medium"}',
    '- "remind me later about the drone draft" => {"kind":"reminder_followup","candidateTokens":["drone","draft"],"confidence":"medium"}',
    '- "close the browser and update the hero" => {"kind":"non_contextual_followup","candidateTokens":[],"confidence":"high"}',
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
    "Deterministic candidate tokens:",
    JSON.stringify(deterministicCandidateTokens ?? []),
    "",
    "Reply as one JSON object with keys: kind, candidateTokens, confidence, explanation."
  ].join("\n");
}

/**
 * Caps and normalizes the explanation returned by the contextual-followup interpreter.
 *
 * @param value - Raw explanation from the model.
 * @param kind - Canonical resolved interpretation kind used as fallback.
 * @returns Short explanation string.
 */
function normalizeContextualFollowupExplanation(
  value: string | undefined,
  kind: ContextualFollowupInterpretationKind
): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return `The local intent model classified this request as ${kind}.`;
  }
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

/**
 * Extracts one JSON object from the raw model response text for contextual-followup interpretation.
 *
 * @param raw - Raw model response text.
 * @returns Parsed payload when JSON could be recovered, otherwise `null`.
 */
function extractContextualFollowupJsonObject(
  raw: string
): ParsedContextualFollowupInterpretationPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as ParsedContextualFollowupInterpretationPayload;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null;
    }
    try {
      return JSON.parse(
        trimmed.slice(firstBrace, lastBrace + 1)
      ) as ParsedContextualFollowupInterpretationPayload;
    } catch {
      return null;
    }
  }
}

/**
 * Normalizes candidate tokens returned by the model into the bounded task contract.
 *
 * @param value - Raw candidate token list from the model.
 * @returns Normalized candidate token list, or `null` when unsupported.
 */
function normalizeCandidateTokens(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      return null;
    }
    const normalized = entry.trim().toLowerCase();
    if (
      !normalized ||
      normalized.length > MAX_CANDIDATE_TOKEN_LENGTH ||
      /[^a-z0-9_-]/.test(normalized)
    ) {
      return null;
    }
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    ordered.push(normalized);
    if (ordered.length > MAX_CANDIDATE_TOKENS) {
      return null;
    }
  }
  return ordered;
}

/**
 * Converts a parsed contextual-followup payload into the stable task contract.
 *
 * @param payload - Parsed JSON payload from the model.
 * @returns Stable contextual-followup signal, or `null` when the payload is unsupported.
 */
function coerceContextualFollowupInterpretationPayload(
  payload: ParsedContextualFollowupInterpretationPayload
): ContextualFollowupInterpretationSignal | null {
  const kind = (payload.kind ?? "").trim().toLowerCase() as ContextualFollowupInterpretationKind;
  if (!SUPPORTED_CONTEXTUAL_FOLLOWUP_KINDS.has(kind)) {
    return null;
  }
  const confidence = (payload.confidence ?? "").trim().toLowerCase() as LocalIntentModelConfidence;
  if (!SUPPORTED_CONFIDENCE.has(confidence)) {
    return null;
  }
  const candidateTokens = normalizeCandidateTokens(payload.candidateTokens ?? []);
  if (!candidateTokens) {
    return null;
  }
  return {
    source: "local_intent_model",
    kind,
    candidateTokens,
    confidence,
    explanation: normalizeContextualFollowupExplanation(payload.explanation, kind)
  };
}

/**
 * Creates the optional Ollama-backed contextual-followup interpreter.
 *
 * @param config - Ollama connection settings.
 * @param deps - Optional dependency overrides for tests.
 * @returns Resolver that fails closed on transport, parsing, or coercion errors.
 */
export function createOllamaContextualFollowupInterpretationResolver(
  config: OllamaContextualFollowupInterpretationConfig,
  deps: OllamaContextualFollowupInterpretationDependencies = {}
): ContextualFollowupInterpretationResolver {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const normalizedBaseUrl = normalizeBaseUrl(config.baseUrl);

  return async (request) => {
    const prompt = buildContextualFollowupInterpretationPrompt(
      request.userInput,
      request.routingClassification,
      request.sessionHints ?? null,
      request.recentTurns,
      request.deterministicCandidateTokens
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
      const parsed = extractContextualFollowupJsonObject(payload.response);
      if (!parsed) {
        return null;
      }
      return coerceContextualFollowupInterpretationPayload(parsed);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };
}
