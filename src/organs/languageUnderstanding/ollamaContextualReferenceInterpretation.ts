/**
 * @fileoverview Provides the bounded Ollama-backed contextual-reference-interpretation task for the shared local conversational runtime.
 */

import type {
  ContextualReferenceInterpretationKind,
  ContextualReferenceInterpretationResolver,
  ContextualReferenceInterpretationSignal,
  LocalIntentModelConfidence,
  LocalIntentModelSessionHints
} from "./localIntentModelContracts";

interface OllamaContextualReferenceInterpretationConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface OllamaContextualReferenceInterpretationDependencies {
  fetchImpl?: typeof fetch;
}

interface OllamaGenerateResponse {
  response?: string;
}

interface ParsedContextualReferenceInterpretationPayload {
  kind?: string;
  entityHints?: unknown;
  topicHints?: unknown;
  confidence?: string;
  explanation?: string;
}

const SUPPORTED_CONFIDENCE = new Set<LocalIntentModelConfidence>([
  "low",
  "medium",
  "high"
]);

const SUPPORTED_CONTEXTUAL_REFERENCE_KINDS = new Set<ContextualReferenceInterpretationKind>([
  "contextual_recall_reference",
  "open_loop_resume_reference",
  "non_contextual_reference",
  "uncertain"
]);

const MAX_HINTS_PER_GROUP = 4;
const MAX_HINT_CHARS = 40;
const MAX_HINT_TOKENS = 4;
const HINT_CONTENT_PATTERN = /^[a-z0-9][a-z0-9' -]*$/;

/**
 * Normalizes an Ollama base URL by trimming trailing slashes.
 *
 * **Why it exists:**
 * Shared Ollama task modules all need the same canonical base-URL handling so request routing
 * stays stable across tasks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Raw base URL.
 * @returns Normalized base URL.
 */
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Builds the bounded contextual-reference prompt sent to the local Phi model.
 *
 * **Why it exists:**
 * Contextual-reference interpretation needs a narrow schema and explicit behavioral guardrails so
 * the model can help only with ambiguous recall wording instead of drifting into freeform recall.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param userInput - Raw user request being interpreted.
 * @param routingHint - Optional deterministic routing hint supplied by the front door.
 * @param sessionHints - Optional bounded session hints for the same turn.
 * @param recentTurns - Optional bounded nearby turn context.
 * @param pausedThreads - Optional paused-thread summaries from Stage 6.86 context.
 * @param deterministicHints - Optional deterministic recall hints already extracted locally.
 * @returns Prompt text constrained to the contextual-reference contract.
 */
function buildContextualReferenceInterpretationPrompt(
  userInput: string,
  routingHint: object | null,
  sessionHints: LocalIntentModelSessionHints | null,
  recentTurns: readonly { role: "user" | "assistant"; text: string }[] | undefined,
  pausedThreads: readonly {
    topicLabel: string;
    resumeHint: string;
    openLoopCount: number;
    lastTouchedAt: string;
  }[] | undefined,
  deterministicHints: readonly string[] | undefined
): string {
  return [
    "Interpret the user's conversational turn for AgentBigBrain.",
    "Return JSON only.",
    "Task: contextual_reference_interpretation.",
    "Allowed kind values: contextual_recall_reference, open_loop_resume_reference, non_contextual_reference, uncertain.",
    "Allowed confidence values: low, medium, high.",
    "entityHints and topicHints must be short lowercased phrases, not full sentences.",
    "Use contextual_recall_reference when the user is clearly referring back to an older situation, topic, or person in natural language.",
    "Use open_loop_resume_reference when the user is clearly trying to return to a deferred or unresolved thread/open loop.",
    "Use non_contextual_reference when the turn is ordinary chat, workflow execution, or otherwise not a contextual recall turn.",
    "Use uncertain when contextual recall might be involved but you cannot classify it safely.",
    "Do not invent names, events, or details that are absent from the user turn or nearby context.",
    "Do not output file paths, URLs, shell commands, or long narrative text in entityHints or topicHints.",
    "Examples:",
    '- "how did that whole thing with owen end up?" => {"kind":"contextual_recall_reference","entityHints":["owen"],"topicHints":["whole thing","end up"],"confidence":"high"}',
    '- "can we go back to that mri situation?" => {"kind":"open_loop_resume_reference","entityHints":[],"topicHints":["mri","situation"],"confidence":"medium"}',
    '- "close the browser and change the hero image" => {"kind":"non_contextual_reference","entityHints":[],"topicHints":[],"confidence":"high"}',
    '- "hi there" => {"kind":"non_contextual_reference","entityHints":[],"topicHints":[],"confidence":"high"}',
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
    "Deterministic contextual hints already extracted:",
    JSON.stringify(deterministicHints ?? []),
    "",
    "Recent turns:",
    JSON.stringify(recentTurns ?? []),
    "",
    "Paused thread context:",
    JSON.stringify(pausedThreads ?? []),
    "",
    "Reply as one JSON object with keys: kind, entityHints, topicHints, confidence, explanation."
  ].join("\n");
}

/**
 * Caps and normalizes the explanation returned by the contextual-reference interpreter.
 *
 * **Why it exists:**
 * The runtime persists explanation text only for debugging and tests, so this helper keeps that
 * field bounded and predictable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Raw explanation from the model.
 * @param kind - Canonical resolved interpretation kind used as fallback.
 * @returns Short explanation string.
 */
function normalizeContextualReferenceExplanation(
  value: string | undefined,
  kind: ContextualReferenceInterpretationKind
): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return `The local intent model classified this request as ${kind}.`;
  }
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

/**
 * Extracts one JSON object from the raw model response text for contextual-reference
 * interpretation.
 *
 * **Why it exists:**
 * Ollama responses sometimes include wrapper text around the JSON payload, so this helper keeps
 * parsing fail-closed and task-local.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param raw - Raw model response text.
 * @returns Parsed payload when JSON could be recovered, otherwise `null`.
 */
function extractContextualReferenceJsonObject(
  raw: string
): ParsedContextualReferenceInterpretationPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as ParsedContextualReferenceInterpretationPayload;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null;
    }
    try {
      return JSON.parse(
        trimmed.slice(firstBrace, lastBrace + 1)
      ) as ParsedContextualReferenceInterpretationPayload;
    } catch {
      return null;
    }
  }
}

/**
 * Normalizes one model-proposed contextual hint into a bounded phrase.
 *
 * **Why it exists:**
 * Contextual-reference hints feed later deterministic matching, so they must be small, lexical,
 * and safe before entering that downstream logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Raw hint candidate from the model.
 * @returns Trimmed normalized hint string when supported, otherwise `null`.
 */
function normalizeContextualHint(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized || normalized.length > MAX_HINT_CHARS) {
    return null;
  }
  if (!HINT_CONTENT_PATTERN.test(normalized)) {
    return null;
  }
  if ((normalized.match(/\b[a-z0-9']+\b/g) ?? []).length > MAX_HINT_TOKENS) {
    return null;
  }
  if (
    normalized.includes("://") ||
    /[\\/]/.test(normalized) ||
    /\b(?:select-string|powershell|pwsh|cmd|bash)\b/i.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

/**
 * Normalizes one model-proposed contextual hint array into a stable bounded list.
 *
 * **Why it exists:**
 * The model may repeat or overproduce hints, so this helper keeps the downstream contract small
 * and deterministic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Raw hint array candidate from the model.
 * @returns Stable bounded hint list.
 */
function normalizeContextualHintList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = new Set<string>();
  for (const candidate of value) {
    const hint = normalizeContextualHint(candidate);
    if (!hint) {
      continue;
    }
    normalized.add(hint);
    if (normalized.size >= MAX_HINTS_PER_GROUP) {
      break;
    }
  }
  return [...normalized];
}

/**
 * Converts a parsed contextual-reference payload into the stable task contract.
 *
 * **Why it exists:**
 * Shared local-model tasks must all fail closed when the model leaves the schema boundary, and
 * this coercion step is that boundary for contextual-reference interpretation.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param payload - Parsed JSON payload from the model.
 * @returns Stable contextual-reference interpretation when supported, otherwise `null`.
 */
function coerceContextualReferenceInterpretationSignal(
  payload: ParsedContextualReferenceInterpretationPayload
): ContextualReferenceInterpretationSignal | null {
  const kind = (payload.kind ?? "").trim() as ContextualReferenceInterpretationKind;
  const confidence = (payload.confidence ?? "").trim().toLowerCase() as LocalIntentModelConfidence;
  if (!SUPPORTED_CONTEXTUAL_REFERENCE_KINDS.has(kind) || !SUPPORTED_CONFIDENCE.has(confidence)) {
    return null;
  }
  const entityHints = normalizeContextualHintList(payload.entityHints);
  const topicHints = normalizeContextualHintList(payload.topicHints);
  if (
    (kind === "contextual_recall_reference" || kind === "open_loop_resume_reference") &&
    entityHints.length === 0 &&
    topicHints.length === 0
  ) {
    return null;
  }
  if (
    kind === "non_contextual_reference" &&
    (entityHints.length > 0 || topicHints.length > 0)
  ) {
    return null;
  }
  return {
    source: "local_intent_model",
    kind,
    entityHints,
    topicHints,
    confidence,
    explanation: normalizeContextualReferenceExplanation(payload.explanation, kind)
  };
}

/**
 * Runs one JSON HTTP request with a bounded timeout.
 *
 * **Why it exists:**
 * Shared Ollama task modules use identical transport behavior, and this keeps the timeout logic
 * local and fail-closed for this task.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
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
 * Creates the bounded Ollama-backed contextual-reference-interpretation resolver.
 *
 * **Why it exists:**
 * The shared conversational runtime needs one fail-closed provider-backed task for ambiguous
 * contextual recall wording without adding a second provider stack.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param config - Ollama runtime config.
 * @param deps - Optional dependency overrides for tests.
 * @returns Fail-closed contextual-reference-interpretation resolver.
 */
export function createOllamaContextualReferenceInterpretationResolver(
  config: OllamaContextualReferenceInterpretationConfig,
  deps: OllamaContextualReferenceInterpretationDependencies = {}
): ContextualReferenceInterpretationResolver {
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
            prompt: buildContextualReferenceInterpretationPrompt(
              request.userInput,
              routingHint,
              request.sessionHints ?? null,
              request.recentTurns,
              request.pausedThreads,
              request.deterministicHints
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
      return coerceContextualReferenceInterpretationSignal(
        extractContextualReferenceJsonObject(payload.response) ?? {}
      );
    } catch {
      return null;
    }
  };
}
