/**
 * @fileoverview Provides the bounded Ollama-backed identity-interpretation task for the shared local conversational runtime.
 */

import type {
  IdentityInterpretationKind,
  IdentityInterpretationResolver,
  IdentityInterpretationSignal,
  LocalIntentModelConfidence,
  LocalIntentModelSessionHints
} from "./localIntentModelContracts";

interface OllamaIdentityInterpretationConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface OllamaIdentityInterpretationDependencies {
  fetchImpl?: typeof fetch;
}

interface OllamaGenerateResponse {
  response?: string;
}

interface ParsedIdentityInterpretationPayload {
  kind?: string;
  candidateValue?: string;
  confidence?: string;
  shouldPersist?: boolean;
  explanation?: string;
}

const SUPPORTED_CONFIDENCE = new Set<LocalIntentModelConfidence>([
  "low",
  "medium",
  "high"
]);

const SUPPORTED_IDENTITY_KINDS = new Set<IdentityInterpretationKind>([
  "self_identity_declaration",
  "self_identity_query",
  "assistant_identity_query",
  "non_identity_chat",
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
 * Builds the bounded identity-interpretation prompt sent to the local Phi model.
 *
 * @param userInput - Raw user request being interpreted.
 * @param routingHint - Optional deterministic routing hint supplied by the front door.
 * @param sessionHints - Optional bounded session hints for the same turn.
 * @param recentAssistantTurn - Optional recent assistant turn that may explain the user's reply.
 * @returns Prompt text constrained to the identity-interpretation contract.
 */
function buildIdentityInterpretationPrompt(
  userInput: string,
  routingHint: object | null,
  sessionHints: LocalIntentModelSessionHints | null,
  recentAssistantTurn: string | null
): string {
  return [
    "Interpret the user's conversational turn for AgentBigBrain.",
    "Return JSON only.",
    "Task: identity_interpretation.",
    "Allowed kind values: self_identity_declaration, self_identity_query, assistant_identity_query, non_identity_chat, uncertain.",
    "Allowed confidence values: low, medium, high.",
    "Only use self_identity_declaration when the user is explicitly stating or confirming their own name or identity.",
    "Only set shouldPersist to true when the user is explicitly stating or confirming their own identity.",
    "candidateValue must contain only the identity value itself, not surrounding explanation.",
    "Do not include discourse tails like 'yes', 'again', 'several times', or similar emphasis in candidateValue.",
    "Use self_identity_query when the user asks who they are or what their name is.",
    "Use assistant_identity_query when the user asks who you are.",
    "Use non_identity_chat when the turn is ordinary chat, workflow, or non-identity conversation.",
    "Use uncertain when identity might be involved but you cannot extract a safe candidateValue.",
    "Do not interpret workflow phrases like 'call me when the deploy is done' as identity declarations.",
    "Examples:",
    '- "My name is Avery." => {"kind":"self_identity_declaration","candidateValue":"Avery","confidence":"high","shouldPersist":true}',
    '- "I already told you my name is Avery several times." => {"kind":"self_identity_declaration","candidateValue":"Avery","confidence":"medium","shouldPersist":true}',
    '- "Who am I?" => {"kind":"self_identity_query","candidateValue":null,"confidence":"high","shouldPersist":false}',
    '- "Who are you?" => {"kind":"assistant_identity_query","candidateValue":null,"confidence":"high","shouldPersist":false}',
    '- "call me when the deploy is done" => {"kind":"non_identity_chat","candidateValue":null,"confidence":"high","shouldPersist":false}',
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
    "Recent assistant turn:",
    recentAssistantTurn ?? "null",
    "",
    'Reply as one JSON object with keys: kind, candidateValue, confidence, shouldPersist, explanation.'
  ].join("\n");
}

/**
 * Caps and normalizes the explanation returned by the identity interpreter.
 *
 * @param value - Raw explanation from the model.
 * @param kind - Canonical resolved interpretation kind used as fallback.
 * @returns Short explanation string.
 */
function normalizeIdentityExplanation(
  value: string | undefined,
  kind: IdentityInterpretationKind
): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return `The local intent model classified this request as ${kind}.`;
  }
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

/**
 * Extracts one JSON object from the raw model response text for identity interpretation.
 *
 * @param raw - Raw model response text.
 * @returns Parsed payload when JSON could be recovered, otherwise `null`.
 */
function extractIdentityJsonObject(raw: string): ParsedIdentityInterpretationPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as ParsedIdentityInterpretationPayload;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as ParsedIdentityInterpretationPayload;
    } catch {
      return null;
    }
  }
}

/**
 * Normalizes a model-proposed identity candidate into a bounded string.
 *
 * @param value - Raw candidate value returned by the model.
 * @returns Trimmed candidate string when bounded, otherwise `null`.
 */
function normalizeIdentityCandidateValue(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed.length > 80) {
    return null;
  }
  return trimmed;
}

/**
 * Converts a parsed identity payload into the stable identity-interpretation contract.
 *
 * @param payload - Parsed JSON payload from the model.
 * @returns Stable identity interpretation when the payload matches supported values, otherwise `null`.
 */
function coerceIdentityInterpretationSignal(
  payload: ParsedIdentityInterpretationPayload
): IdentityInterpretationSignal | null {
  const kind = (payload.kind ?? "").trim() as IdentityInterpretationKind;
  const confidence = (payload.confidence ?? "").trim().toLowerCase() as LocalIntentModelConfidence;
  if (!SUPPORTED_IDENTITY_KINDS.has(kind) || !SUPPORTED_CONFIDENCE.has(confidence)) {
    return null;
  }
  const candidateValue = normalizeIdentityCandidateValue(payload.candidateValue);
  const shouldPersist = payload.shouldPersist === true;
  if (kind === "self_identity_declaration") {
    if (shouldPersist !== true || candidateValue === null) {
      return null;
    }
  }
  return {
    source: "local_intent_model",
    kind,
    candidateValue: kind === "self_identity_declaration" ? candidateValue : null,
    confidence,
    shouldPersist: kind === "self_identity_declaration" ? shouldPersist : false,
    explanation: normalizeIdentityExplanation(payload.explanation, kind)
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
 * Creates the bounded Ollama-backed identity-interpretation resolver.
 *
 * @param config - Ollama runtime config.
 * @param deps - Optional dependency overrides for tests.
 * @returns Fail-closed identity-interpretation resolver.
 */
export function createOllamaIdentityInterpretationResolver(
  config: OllamaIdentityInterpretationConfig,
  deps: OllamaIdentityInterpretationDependencies = {}
): IdentityInterpretationResolver {
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
            prompt: buildIdentityInterpretationPrompt(
              request.userInput,
              routingHint,
              request.sessionHints ?? null,
              request.recentAssistantTurn ?? null
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
      return coerceIdentityInterpretationSignal(extractIdentityJsonObject(payload.response) ?? {});
    } catch {
      return null;
    }
  };
}
