/**
 * @fileoverview Provides the bounded Ollama-backed continuation-interpretation task for the shared local conversational runtime.
 */

import type {
  ContinuationFollowUpCategory,
  ContinuationInterpretationKind,
  ContinuationInterpretationResolver,
  ContinuationInterpretationSignal,
  ContinuationInterpretationTarget,
  LocalIntentModelConfidence,
  LocalIntentModelSessionHints
} from "./localIntentModelContracts";

interface OllamaContinuationInterpretationConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface OllamaContinuationInterpretationDependencies {
  fetchImpl?: typeof fetch;
}

interface OllamaGenerateResponse {
  response?: string;
}

interface ParsedContinuationInterpretationPayload {
  kind?: string;
  followUpCategory?: string | null;
  continuationTarget?: string | null;
  candidateValue?: string | null;
  confidence?: string;
  explanation?: string;
}

const SUPPORTED_CONFIDENCE = new Set<LocalIntentModelConfidence>([
  "low",
  "medium",
  "high"
]);

const SUPPORTED_CONTINUATION_KINDS = new Set<ContinuationInterpretationKind>([
  "short_follow_up",
  "mode_continuation",
  "return_handoff_resume",
  "non_continuation_chat",
  "uncertain"
]);

const SUPPORTED_CONTINUATION_TARGETS = new Set<ContinuationInterpretationTarget>([
  "prior_assistant_turn",
  "mode_continuity",
  "return_handoff",
  null
]);

const SUPPORTED_FOLLOWUP_CATEGORIES = new Set<ContinuationFollowUpCategory>([
  "ack",
  "approve",
  "deny",
  "adjust",
  "question",
  null
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
 * Builds the bounded continuation-interpretation prompt sent to the local Phi model.
 *
 * @param userInput - Raw user request being interpreted.
 * @param routingHint - Optional deterministic routing hint supplied by the front door.
 * @param sessionHints - Optional bounded session hints for the same turn.
 * @param recentAssistantTurn - Optional recent assistant turn that may explain the user's reply.
 * @returns Prompt text constrained to the continuation-interpretation contract.
 */
function buildContinuationInterpretationPrompt(
  userInput: string,
  routingHint: object | null,
  sessionHints: LocalIntentModelSessionHints | null,
  recentAssistantTurn: string | null
): string {
  return [
    "Interpret the user's conversational turn for AgentBigBrain.",
    "Return JSON only.",
    "Task: continuation_interpretation.",
    "Allowed kind values: short_follow_up, mode_continuation, return_handoff_resume, non_continuation_chat, uncertain.",
    "Allowed followUpCategory values: ack, approve, deny, adjust, question, null.",
    "Allowed continuationTarget values: prior_assistant_turn, mode_continuity, return_handoff, null.",
    "Allowed confidence values: low, medium, high.",
    "Use short_follow_up when the user is answering or reacting to the most recent assistant turn.",
    "Use mode_continuation when the user is clearly asking to keep going with the current work product, destination, or working mode.",
    "Use return_handoff_resume when the user is asking to resume saved work from a durable checkpoint or last stopping point.",
    "Use non_continuation_chat when the turn is ordinary chat or a new unrelated request.",
    "If session hints show recentAssistantTurnKind=\"informational_answer\" and recentAssistantAnswerThreadActive=true, short ambiguous follow-ups like 'okay, what else?' or 'tell me more' should stay non_continuation_chat unless the user explicitly re-anchors to saved work or a concrete artifact.",
    "Use uncertain when continuation might be involved but you cannot classify it safely.",
    "Set candidateValue only for bounded follow-up payload text, such as an adjustment instruction after a leading adjust phrase.",
    "Do not place long explanations, file paths, URLs, or shell text in candidateValue.",
    "Examples:",
    '- "No" after a recent assistant clarification question => {"kind":"short_follow_up","followUpCategory":"deny","continuationTarget":"prior_assistant_turn","candidateValue":null,"confidence":"high"}',
    '- "Same folder as before" while build continuity is active => {"kind":"mode_continuation","followUpCategory":null,"continuationTarget":"mode_continuity","candidateValue":null,"confidence":"medium"}',
    '- "Pick that back up from where you left off" with durable handoff hints => {"kind":"return_handoff_resume","followUpCategory":null,"continuationTarget":"return_handoff","candidateValue":null,"confidence":"high"}',
    '- "What is my name?" => {"kind":"non_continuation_chat","followUpCategory":null,"continuationTarget":null,"candidateValue":null,"confidence":"high"}',
    '- "adjust it to weekly" after a proposal question => {"kind":"short_follow_up","followUpCategory":"adjust","continuationTarget":"prior_assistant_turn","candidateValue":"to weekly","confidence":"high"}',
    '- With session hints showing recentAssistantTurnKind="informational_answer" and recentAssistantAnswerThreadActive=true: "Okay, what else?" => {"kind":"non_continuation_chat","followUpCategory":null,"continuationTarget":null,"candidateValue":null,"confidence":"medium"}',
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
    "Reply as one JSON object with keys: kind, followUpCategory, continuationTarget, candidateValue, confidence, explanation."
  ].join("\n");
}

/**
 * Caps and normalizes the explanation returned by the continuation interpreter.
 *
 * @param value - Raw explanation from the model.
 * @param kind - Canonical resolved interpretation kind used as fallback.
 * @returns Short explanation string.
 */
function normalizeContinuationExplanation(
  value: string | undefined,
  kind: ContinuationInterpretationKind
): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return `The local intent model classified this request as ${kind}.`;
  }
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

/**
 * Extracts one JSON object from the raw model response text for continuation interpretation.
 *
 * @param raw - Raw model response text.
 * @returns Parsed payload when JSON could be recovered, otherwise `null`.
 */
function extractContinuationJsonObject(raw: string): ParsedContinuationInterpretationPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as ParsedContinuationInterpretationPayload;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null;
    }
    try {
      return JSON.parse(
        trimmed.slice(firstBrace, lastBrace + 1)
      ) as ParsedContinuationInterpretationPayload;
    } catch {
      return null;
    }
  }
}

/**
 * Normalizes a model-proposed continuation payload candidate into a bounded string.
 *
 * @param value - Raw candidate value returned by the model.
 * @returns Trimmed candidate string when bounded, otherwise `null`.
 */
function normalizeContinuationCandidateValue(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed.length > 80) {
    return null;
  }
  return trimmed;
}

/**
 * Normalizes a nullable continuation target from model output.
 *
 * @param value - Raw target returned by the model.
 * @returns Supported continuation target, or `null`.
 */
function normalizeContinuationTarget(
  value: string | null | undefined
): ContinuationInterpretationTarget {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : null;
  return SUPPORTED_CONTINUATION_TARGETS.has(normalized as ContinuationInterpretationTarget)
    ? (normalized as ContinuationInterpretationTarget)
    : null;
}

/**
 * Normalizes a nullable follow-up category from model output.
 *
 * @param value - Raw follow-up category returned by the model.
 * @returns Supported follow-up category, or `null`.
 */
function normalizeFollowUpCategory(
  value: string | null | undefined
): ContinuationFollowUpCategory {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : null;
  return SUPPORTED_FOLLOWUP_CATEGORIES.has(normalized as ContinuationFollowUpCategory)
    ? (normalized as ContinuationFollowUpCategory)
    : null;
}

/**
 * Converts a parsed continuation payload into the stable continuation-interpretation contract.
 *
 * @param payload - Parsed JSON payload from the model.
 * @returns Stable continuation interpretation when supported, otherwise `null`.
 */
function coerceContinuationInterpretationSignal(
  payload: ParsedContinuationInterpretationPayload
): ContinuationInterpretationSignal | null {
  const kind = (payload.kind ?? "").trim() as ContinuationInterpretationKind;
  const confidence = (payload.confidence ?? "").trim().toLowerCase() as LocalIntentModelConfidence;
  if (!SUPPORTED_CONTINUATION_KINDS.has(kind) || !SUPPORTED_CONFIDENCE.has(confidence)) {
    return null;
  }
  const followUpCategory = normalizeFollowUpCategory(payload.followUpCategory);
  const continuationTarget = normalizeContinuationTarget(payload.continuationTarget);
  const candidateValue = normalizeContinuationCandidateValue(payload.candidateValue);

  if (kind === "short_follow_up" && continuationTarget !== "prior_assistant_turn") {
    return null;
  }
  if (kind === "mode_continuation" && continuationTarget !== "mode_continuity") {
    return null;
  }
  if (kind === "return_handoff_resume" && continuationTarget !== "return_handoff") {
    return null;
  }
  if (
    kind === "non_continuation_chat" &&
    (followUpCategory !== null || continuationTarget !== null || candidateValue !== null)
  ) {
    return null;
  }

  return {
    source: "local_intent_model",
    kind,
    followUpCategory,
    continuationTarget,
    candidateValue,
    confidence,
    explanation: normalizeContinuationExplanation(payload.explanation, kind)
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
 * Creates the bounded Ollama-backed continuation-interpretation resolver.
 *
 * @param config - Ollama runtime config.
 * @param deps - Optional dependency overrides for tests.
 * @returns Fail-closed continuation-interpretation resolver.
 */
export function createOllamaContinuationInterpretationResolver(
  config: OllamaContinuationInterpretationConfig,
  deps: OllamaContinuationInterpretationDependencies = {}
): ContinuationInterpretationResolver {
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
            prompt: buildContinuationInterpretationPrompt(
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
      return coerceContinuationInterpretationSignal(
        extractContinuationJsonObject(payload.response) ?? {}
      );
    } catch {
      return null;
    }
  };
}
