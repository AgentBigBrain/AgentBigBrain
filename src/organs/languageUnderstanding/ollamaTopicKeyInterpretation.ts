/**
 * @fileoverview Provides the bounded Ollama-backed topic-key-interpretation task for the shared local conversational runtime.
 */

import type {
  LocalIntentModelConfidence,
  LocalIntentModelSessionHints,
  TopicKeyInterpretationKind,
  TopicKeyInterpretationResolver,
  TopicKeyInterpretationSignal
} from "./localIntentModelContracts";

interface OllamaTopicKeyInterpretationConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface OllamaTopicKeyInterpretationDependencies {
  fetchImpl?: typeof fetch;
}

interface OllamaGenerateResponse {
  response?: string;
}

interface ParsedTopicKeyInterpretationPayload {
  kind?: string;
  selectedTopicKey?: unknown;
  selectedThreadKey?: unknown;
  confidence?: string;
  explanation?: string;
}

const SUPPORTED_CONFIDENCE = new Set<LocalIntentModelConfidence>([
  "low",
  "medium",
  "high"
]);

const SUPPORTED_TOPIC_KEY_KINDS = new Set<TopicKeyInterpretationKind>([
  "retain_active_thread",
  "resume_paused_thread",
  "switch_topic_candidate",
  "non_topic_turn",
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
 * Builds the bounded topic-key prompt sent to the local Phi model.
 *
 * @param userInput - Raw user request being interpreted.
 * @param routingHint - Optional deterministic routing hint supplied by the front door.
 * @param sessionHints - Optional bounded session hints for the same turn.
 * @param recentTurns - Optional bounded nearby turn context.
 * @param activeThread - Optional active thread summary.
 * @param pausedThreads - Optional paused-thread summaries.
 * @param deterministicCandidates - Optional deterministic topic candidates already extracted.
 * @returns Prompt text constrained to the topic-key contract.
 */
function buildTopicKeyInterpretationPrompt(
  userInput: string,
  routingHint: object | null,
  sessionHints: LocalIntentModelSessionHints | null,
  recentTurns: readonly { role: "user" | "assistant"; text: string }[] | undefined,
  activeThread:
    | {
        threadKey: string;
        topicKey: string;
        topicLabel: string;
        resumeHint: string;
        state: "active" | "paused";
      }
    | null
    | undefined,
  pausedThreads:
    | readonly {
        threadKey: string;
        topicKey: string;
        topicLabel: string;
        resumeHint: string;
        state: "active" | "paused";
      }[]
    | undefined,
  deterministicCandidates:
    | readonly {
        topicKey: string;
        label: string;
        confidence: number;
      }[]
    | undefined
): string {
  return [
    "Interpret the user's conversational turn for AgentBigBrain.",
    "Return JSON only.",
    "Task: topic_key_interpretation.",
    "Allowed kind values: retain_active_thread, resume_paused_thread, switch_topic_candidate, non_topic_turn, uncertain.",
    "Allowed confidence values: low, medium, high.",
    "You may only choose selectedTopicKey values that already appear in deterministicCandidates.",
    "You may only choose selectedThreadKey values that already appear in activeThread or pausedThreads.",
    "Use retain_active_thread when the user is still talking about the active thread and no topic switch is warranted.",
    "Use resume_paused_thread when the user is trying to return to one paused thread from the provided thread list.",
    "Use switch_topic_candidate when one deterministic topic candidate should win but the wording is ambiguous.",
    "Use non_topic_turn when the turn is ordinary chat or not a Stage 6.86 topic/thread routing turn.",
    "Use uncertain when topic/thread routing might be involved but you cannot choose safely.",
    "Do not invent topic keys, thread keys, names, paths, or external facts.",
    "Examples:",
    '- "go back to that css thing" with one matching paused thread => {"kind":"resume_paused_thread","selectedThreadKey":"thread_css","selectedTopicKey":null,"confidence":"high"}',
    '- "let us switch back to landing page hero" with a matching deterministic candidate => {"kind":"switch_topic_candidate","selectedTopicKey":"landing_page_hero","selectedThreadKey":null,"confidence":"medium"}',
    '- "sounds good" => {"kind":"non_topic_turn","selectedTopicKey":null,"selectedThreadKey":null,"confidence":"high"}',
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
    "Active thread:",
    JSON.stringify(activeThread ?? null),
    "",
    "Paused threads:",
    JSON.stringify(pausedThreads ?? []),
    "",
    "Deterministic topic candidates:",
    JSON.stringify(deterministicCandidates ?? []),
    "",
    "Reply as one JSON object with keys: kind, selectedTopicKey, selectedThreadKey, confidence, explanation."
  ].join("\n");
}

/**
 * Caps and normalizes the explanation returned by the topic-key interpreter.
 *
 * @param value - Raw explanation from the model.
 * @param kind - Canonical resolved interpretation kind used as fallback.
 * @returns Short explanation string.
 */
function normalizeTopicKeyExplanation(
  value: string | undefined,
  kind: TopicKeyInterpretationKind
): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return `The local intent model classified this request as ${kind}.`;
  }
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

/**
 * Extracts one JSON object from the raw model response text for topic-key interpretation.
 *
 * @param raw - Raw model response text.
 * @returns Parsed payload when JSON could be recovered, otherwise `null`.
 */
function extractTopicKeyJsonObject(raw: string): ParsedTopicKeyInterpretationPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as ParsedTopicKeyInterpretationPayload;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as ParsedTopicKeyInterpretationPayload;
    } catch {
      return null;
    }
  }
}

/**
 * Normalizes one model-proposed topic/thread key into a bounded selectable value.
 *
 * @param value - Raw key candidate from the model.
 * @returns Trimmed normalized key when supported, otherwise `null`.
 */
function normalizeSelectableKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > 120) {
    return null;
  }
  if (!/^[a-z0-9_:-]+$/i.test(normalized)) {
    return null;
  }
  return normalized;
}

/**
 * Coerces one parsed topic-key payload into a validated runtime signal.
 *
 * @param payload - Parsed model payload.
 * @param allowedTopicKeys - Deterministic topic keys allowed for this request.
 * @param allowedThreadKeys - Deterministic thread keys allowed for this request.
 * @param activeThreadKey - Active thread key used for retain-active validation.
 * @returns Validated topic-key interpretation signal or `null`.
 */
function coerceTopicKeyInterpretationSignal(
  payload: ParsedTopicKeyInterpretationPayload,
  allowedTopicKeys: ReadonlySet<string>,
  allowedThreadKeys: ReadonlySet<string>,
  activeThreadKey: string | null
): TopicKeyInterpretationSignal | null {
  const kind = (payload.kind ?? "").trim() as TopicKeyInterpretationKind;
  if (!SUPPORTED_TOPIC_KEY_KINDS.has(kind)) {
    return null;
  }
  const confidence = (payload.confidence ?? "").trim() as LocalIntentModelConfidence;
  if (!SUPPORTED_CONFIDENCE.has(confidence)) {
    return null;
  }
  const selectedTopicKey = normalizeSelectableKey(payload.selectedTopicKey);
  const selectedThreadKey = normalizeSelectableKey(payload.selectedThreadKey);

  if (kind === "switch_topic_candidate") {
    if (!selectedTopicKey || !allowedTopicKeys.has(selectedTopicKey) || selectedThreadKey) {
      return null;
    }
  } else if (kind === "resume_paused_thread") {
    if (!selectedThreadKey || !allowedThreadKeys.has(selectedThreadKey) || selectedTopicKey) {
      return null;
    }
  } else if (kind === "retain_active_thread") {
    if (!activeThreadKey) {
      return null;
    }
    if (selectedTopicKey && !allowedTopicKeys.has(selectedTopicKey)) {
      return null;
    }
    if (selectedThreadKey && selectedThreadKey !== activeThreadKey) {
      return null;
    }
  } else if (selectedTopicKey || selectedThreadKey) {
    return null;
  }

  return {
    source: "local_intent_model",
    kind,
    selectedTopicKey: selectedTopicKey ?? null,
    selectedThreadKey: selectedThreadKey ?? null,
    confidence,
    explanation: normalizeTopicKeyExplanation(payload.explanation, kind)
  };
}

/**
 * Creates the bounded Ollama-backed topic-key interpreter.
 *
 * @param config - Runtime model config.
 * @param deps - Optional dependency overrides for tests.
 * @returns Topic-key interpretation resolver that fails closed on transport/model errors.
 */
export function createOllamaTopicKeyInterpretationResolver(
  config: OllamaTopicKeyInterpretationConfig,
  deps: OllamaTopicKeyInterpretationDependencies = {}
): TopicKeyInterpretationResolver {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(config.baseUrl);

  return async (request) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const allowedTopicKeys = new Set(
        (request.deterministicCandidates ?? []).map((candidate) => candidate.topicKey)
      );
      const pausedThreads = request.pausedThreads ?? [];
      const allowedThreadKeys = new Set(pausedThreads.map((thread) => thread.threadKey));
      const activeThread = request.activeThread ?? null;
      if (activeThread) {
        allowedThreadKeys.add(activeThread.threadKey);
      }

      const response = await fetchImpl(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: config.model,
          stream: false,
          format: "json",
          prompt: buildTopicKeyInterpretationPrompt(
            request.userInput,
            request.routingClassification,
            request.sessionHints ?? null,
            request.recentTurns,
            activeThread,
            pausedThreads,
            request.deterministicCandidates
          )
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        return null;
      }
      const payload = (await response.json()) as OllamaGenerateResponse;
      const parsed = extractTopicKeyJsonObject(payload.response ?? "");
      if (!parsed) {
        return null;
      }
      return coerceTopicKeyInterpretationSignal(
        parsed,
        allowedTopicKeys,
        allowedThreadKeys,
        activeThread?.threadKey ?? null
      );
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };
}
