/**
 * @fileoverview Provides a bounded Ollama-backed local intent-model resolver for the human-centric execution front door.
 */

import type {
  LocalIntentModelResolver,
  LocalIntentModelSignal,
  LocalIntentModelSessionHints
} from "./localIntentModelContracts";
import type { ConversationIntentSemanticHint } from "../../interfaces/conversationRuntime/intentModeContracts";

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

type SupportedLocalIntentMode =
  | "chat"
  | "plan"
  | "build"
  | "autonomous"
  | "review"
  | "status_or_recall"
  | "discover_available_capabilities";

interface ParsedLocalIntentModelPayload {
  mode?: string;
  confidence?: string;
  matchedRuleId?: string;
  explanation?: string;
  semanticHint?: string;
}

const SUPPORTED_MODES = new Set<SupportedLocalIntentMode>([
  "chat",
  "plan",
  "build",
  "autonomous",
  "review",
  "status_or_recall",
  "discover_available_capabilities"
]);

const SUPPORTED_CONFIDENCE = new Set<LocalIntentModelSignal["confidence"]>([
  "low",
  "medium",
  "high"
]);

const SUPPORTED_SEMANTIC_HINTS = new Set<ConversationIntentSemanticHint>([
  "review_ready",
  "guided_review",
  "next_review_step",
  "while_away_review",
  "wrap_up_summary",
  "explain_handoff",
  "resume_handoff"
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
 * Builds the bounded classifier prompt sent to the local Phi model.
 *
 * @param userInput - Raw user request being classified.
 * @param routingHint - Optional deterministic routing hint supplied by the front door.
 * @returns Prompt text constrained to the local intent-model contract.
 */
function buildLocalIntentPrompt(
  userInput: string,
  routingHint: object | null,
  sessionHints: LocalIntentModelSessionHints | null
): string {
  return [
    "Classify the user's request for AgentBigBrain.",
    "Return JSON only.",
    "Allowed mode values: chat, plan, build, autonomous, review, status_or_recall, discover_available_capabilities.",
    "Allowed confidence values: low, medium, high.",
    "Optional semanticHint values: review_ready, guided_review, next_review_step, while_away_review, wrap_up_summary, explain_handoff, resume_handoff.",
    "Use semanticHint only when the session hints show durable return-handoff context.",
    "Use autonomous only when the user clearly wants the assistant to handle the task end to end.",
    "Promote to autonomous when the user says things like 'go until you finish', 'keep going until it's done', 'take this end to end', or 'handle the whole thing for me'.",
    "Use build when the user clearly wants execution or implementation now, but not necessarily a long autonomous loop.",
    "Use build for concrete browser control requests like opening, reopening, or closing a tracked local browser window.",
    "Use plan when the user wants explanation or a plan first and does not want execution yet.",
    "Use review when the user is correcting prior work or asking the assistant to inspect something it did wrong.",
    "Use status_or_recall when the user asks what was created, where something was put, what is happening now, or what was left open, but not when they are asking you to open or close something now.",
    "If session hints show a durable return handoff, treat natural review-return questions about the saved draft, rough draft, what else is ready, or what to look at or review next as status_or_recall even when the wording is indirect.",
    "Use semanticHint review_ready when the user wants to see what is ready, what draft exists, or whether there is anything else worth looking over from the saved work.",
    "Use semanticHint guided_review when the user asks what to inspect, review, or look at first.",
    "Use semanticHint next_review_step when the user asks what to review next, what to look at next, or what else they should inspect from the saved work.",
    "Use semanticHint while_away_review when the user asks what happened, what changed, or what was finished while they were away, gone, or out.",
    "Use semanticHint wrap_up_summary when the user asks what you wrapped up, finished up, or completed for them from the saved work without specifically framing it as being away.",
    "Use semanticHint explain_handoff when the user wants you to walk through, explain, or summarize what you changed or wrapped up in the saved work.",
    "Use semanticHint resume_handoff when the user wants to continue, keep refining, keep going, or pick back up from the saved checkpoint instead of starting over.",
    "Use discover_available_capabilities when the user asks what the assistant can do here, what tools or skills it knows, or why a capability is unavailable.",
    "When the request is weak or ambiguous, prefer chat with low confidence instead of guessing.",
    "Examples:",
    '- "Could you take care of this end to end and leave the browser open for me later tonight?" => {"mode":"autonomous","confidence":"high"}',
    '- "Build a landing page for my desktop folder, go until you finish, then run it in a browser and leave it open for me." => {"mode":"autonomous","confidence":"high"}',
    '- "Please talk me through the plan first and do not run anything yet." => {"mode":"plan","confidence":"high"}',
    '- "What did you put on my desktop and what are you doing right now?" => {"mode":"status_or_recall","confidence":"high"}',
    '- "Close the browser for our landing page." => {"mode":"build","confidence":"high"}',
    '- "Open the landing page browser again so I can see it." => {"mode":"build","confidence":"high"}',
    '- "Change the hero image to a slider on the landing page from earlier." => {"mode":"build","confidence":"high"}',
    '- "Update the homepage header we were working on and keep the same preview open." => {"mode":"build","confidence":"high"}',
    '- "What can you do here, and why can\'t you leave a browser open in this setup?" => {"mode":"discover_available_capabilities","confidence":"high"}',
    '- "You did this wrong. Look at the screenshot and fix it." => {"mode":"review","confidence":"high"}',
    '- With session hints showing a durable handoff: "When I get back later, what should I inspect first from the draft you left me?" => {"mode":"status_or_recall","confidence":"medium","semanticHint":"guided_review"}',
    '- With session hints showing a durable handoff: "What else is ready from that draft?" => {"mode":"status_or_recall","confidence":"medium","semanticHint":"review_ready"}',
    '- With session hints showing a durable handoff: "Is there anything else in that draft I should look over?" => {"mode":"status_or_recall","confidence":"medium","semanticHint":"review_ready"}',
    '- With session hints showing a durable handoff: "What should I review next from that draft?" => {"mode":"status_or_recall","confidence":"medium","semanticHint":"next_review_step"}',
    '- With session hints showing a durable handoff: "What should I look at after that?" => {"mode":"status_or_recall","confidence":"medium","semanticHint":"next_review_step"}',
    '- With session hints showing a durable handoff: "What did you finish while I was gone?" => {"mode":"status_or_recall","confidence":"high","semanticHint":"while_away_review"}',
    '- With session hints showing a durable handoff: "What did you wrap up for me on that draft?" => {"mode":"status_or_recall","confidence":"medium","semanticHint":"wrap_up_summary"}',
    '- With session hints showing a durable handoff: "Explain what you actually changed in that saved draft." => {"mode":"status_or_recall","confidence":"medium","semanticHint":"explain_handoff"}',
    '- With session hints showing a durable handoff: "When you get a chance, keep refining that draft from where you left off." => {"mode":"build","confidence":"medium","semanticHint":"resume_handoff"}',
    '- With session hints showing a durable handoff and autonomous continuity: "Tomorrow, keep going on that page until it is really done." => {"mode":"autonomous","confidence":"medium","semanticHint":"resume_handoff"}',
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
    'Reply as one JSON object with keys: mode, confidence, matchedRuleId, explanation, semanticHint.'
  ].join("\n");
}

/**
 * Normalizes the model-provided rule id into the repo's stable local-intent prefix.
 *
 * @param value - Raw matched rule id returned by the model.
 * @param mode - Canonical resolved mode used as fallback.
 * @returns Stable matched rule id with the `local_intent_model_` prefix.
 */
function normalizeMatchedRuleId(value: string | undefined, mode: SupportedLocalIntentMode): string {
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
function normalizeExplanation(value: string | undefined, mode: SupportedLocalIntentMode): string {
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
  const mode = (payload.mode ?? "").trim() as SupportedLocalIntentMode;
  const confidence = (payload.confidence ?? "").trim().toLowerCase() as LocalIntentModelSignal["confidence"];
  if (!SUPPORTED_MODES.has(mode) || !SUPPORTED_CONFIDENCE.has(confidence)) {
    return null;
  }
  const rawSemanticHint = normalizeSemanticHint(payload.semanticHint);
  const semanticHint =
    rawSemanticHint === "resume_handoff"
      ? (mode === "build" || mode === "autonomous" || mode === "review"
          ? rawSemanticHint
          : null)
      : (mode === "status_or_recall" ? rawSemanticHint : null);
  return {
    source: "local_intent_model",
    mode,
    confidence,
    matchedRuleId: normalizeMatchedRuleId(payload.matchedRuleId, mode),
    explanation: normalizeExplanation(payload.explanation, mode),
    clarification: null,
    semanticHint
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
