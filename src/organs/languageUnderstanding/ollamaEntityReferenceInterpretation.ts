/**
 * @fileoverview Provides the bounded Ollama-backed entity-reference-interpretation task for the shared local conversational runtime.
 */

import type {
  EntityReferenceInterpretationKind,
  EntityReferenceInterpretationResolver,
  EntityReferenceInterpretationSignal,
  LocalIntentModelConfidence,
  LocalIntentModelSessionHints
} from "./localIntentModelContracts";

interface OllamaEntityReferenceInterpretationConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface OllamaEntityReferenceInterpretationDependencies {
  fetchImpl?: typeof fetch;
}

interface OllamaGenerateResponse {
  response?: string;
}

interface ParsedEntityReferenceInterpretationPayload {
  kind?: string;
  selectedEntityKeys?: unknown;
  aliasCandidate?: unknown;
  confidence?: string;
  explanation?: string;
}

const SUPPORTED_CONFIDENCE = new Set<LocalIntentModelConfidence>([
  "low",
  "medium",
  "high"
]);

const SUPPORTED_ENTITY_REFERENCE_KINDS = new Set<EntityReferenceInterpretationKind>([
  "entity_scoped_reference",
  "entity_alias_candidate",
  "non_entity_reference",
  "uncertain"
]);

const MAX_SELECTED_ENTITY_KEYS = 3;
const MAX_ALIAS_CHARS = 60;
const MAX_ALIAS_TOKENS = 5;

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
 * Builds the bounded entity-reference prompt sent to the local Phi model.
 *
 * @param userInput - Raw user request being interpreted.
 * @param routingHint - Optional deterministic routing hint supplied by the front door.
 * @param sessionHints - Optional bounded session hints for the same turn.
 * @param recentTurns - Optional bounded nearby turn context.
 * @param candidateEntities - Optional bounded entity candidates already selected locally.
 * @param deterministicHints - Optional deterministic entity/topic hints already extracted locally.
 * @returns Prompt text constrained to the entity-reference contract.
 */
function buildEntityReferenceInterpretationPrompt(
  userInput: string,
  routingHint: object | null,
  sessionHints: LocalIntentModelSessionHints | null,
  recentTurns: readonly { role: "user" | "assistant"; text: string }[] | undefined,
  candidateEntities:
    | readonly {
        entityKey: string;
        canonicalName: string;
        aliases: readonly string[];
        entityType: string;
        domainHint: string | null;
      }[]
    | undefined,
  deterministicHints: readonly string[] | undefined
): string {
  return [
    "Interpret the user's conversational turn for AgentBigBrain.",
    "Return JSON only.",
    "Task: entity_reference_interpretation.",
    "Allowed kind values: entity_scoped_reference, entity_alias_candidate, non_entity_reference, uncertain.",
    "Allowed confidence values: low, medium, high.",
    "You may only choose selectedEntityKeys that already appear in candidateEntities.",
    "Use entity_scoped_reference when the user is clearly referring to one or more provided entity candidates in a conversational or recall-style way.",
    "Use entity_alias_candidate when the user appears to be clarifying, correcting, or supplying an alternate name for exactly one provided entity candidate.",
    "Use non_entity_reference when the turn is ordinary chat, workflow execution, or otherwise not meaningfully about one of the provided entity candidates.",
    "Use uncertain when entity reference might be involved but you cannot choose safely.",
    "aliasCandidate must be a short human-readable name or label, not a sentence, path, URL, or command.",
    "Do not invent entity keys, names, paths, or external facts.",
    "Examples:",
    '- "how is sarah doing lately?" with Sarah in candidateEntities => {"kind":"entity_scoped_reference","selectedEntityKeys":["entity_sarah"],"aliasCandidate":null,"confidence":"high"}',
    '- "i mean sarah connor, not sarah lee" with Sarah Connor in candidateEntities => {"kind":"entity_alias_candidate","selectedEntityKeys":["entity_sarah_connor"],"aliasCandidate":"Sarah Connor","confidence":"medium"}',
    '- "close the browser and ship the css fix" => {"kind":"non_entity_reference","selectedEntityKeys":[],"aliasCandidate":null,"confidence":"high"}',
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
    "Candidate entities:",
    JSON.stringify(candidateEntities ?? []),
    "",
    "Deterministic hints already extracted:",
    JSON.stringify(deterministicHints ?? []),
    "",
    "Reply as one JSON object with keys: kind, selectedEntityKeys, aliasCandidate, confidence, explanation."
  ].join("\n");
}

/**
 * Caps and normalizes the explanation returned by the entity-reference interpreter.
 *
 * @param value - Raw explanation from the model.
 * @param kind - Canonical resolved interpretation kind used as fallback.
 * @returns Short explanation string.
 */
function normalizeEntityReferenceExplanation(
  value: string | undefined,
  kind: EntityReferenceInterpretationKind
): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return `The local intent model classified this request as ${kind}.`;
  }
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

/**
 * Extracts one JSON object from the raw model response text for entity-reference interpretation.
 *
 * @param raw - Raw model response text.
 * @returns Parsed payload when JSON could be recovered, otherwise `null`.
 */
function extractEntityReferenceJsonObject(
  raw: string
): ParsedEntityReferenceInterpretationPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as ParsedEntityReferenceInterpretationPayload;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null;
    }
    try {
      return JSON.parse(
        trimmed.slice(firstBrace, lastBrace + 1)
      ) as ParsedEntityReferenceInterpretationPayload;
    } catch {
      return null;
    }
  }
}

/**
 * Normalizes one model-proposed selected entity key into a bounded selectable value.
 *
 * @param value - Raw key candidate from the model.
 * @returns Trimmed normalized key when supported, otherwise `null`.
 */
function normalizeEntityKey(value: unknown): string | null {
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
 * Normalizes one model-proposed alias candidate into a bounded human-readable label.
 *
 * @param value - Raw alias candidate from the model.
 * @returns Trimmed alias candidate when supported, otherwise `null`.
 */
function normalizeAliasCandidate(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > MAX_ALIAS_CHARS) {
    return null;
  }
  if ((normalized.match(/\b[\p{L}\p{N}']+\b/gu) ?? []).length > MAX_ALIAS_TOKENS) {
    return null;
  }
  if (
    normalized.includes("://") ||
    /[\\/]/.test(normalized) ||
    /\b(?:select-string|powershell|pwsh|cmd|bash)\b/i.test(normalized)
  ) {
    return null;
  }
  if (!/^[\p{L}\p{N}][\p{L}\p{N}' .,&-]*$/u.test(normalized)) {
    return null;
  }
  return normalized;
}

/**
 * Normalizes one model-proposed entity-key array into a stable bounded list.
 *
 * @param value - Raw key array candidate from the model.
 * @param allowedEntityKeys - Deterministic entity keys allowed for this request.
 * @returns Stable bounded entity-key list.
 */
function normalizeSelectedEntityKeys(
  value: unknown,
  allowedEntityKeys: ReadonlySet<string>
): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = new Set<string>();
  for (const candidate of value) {
    const entityKey = normalizeEntityKey(candidate);
    if (!entityKey || !allowedEntityKeys.has(entityKey)) {
      continue;
    }
    normalized.add(entityKey);
    if (normalized.size >= MAX_SELECTED_ENTITY_KEYS) {
      break;
    }
  }
  return [...normalized];
}

/**
 * Converts a parsed entity-reference payload into the stable task contract.
 *
 * @param payload - Parsed JSON payload from the model.
 * @param allowedEntityKeys - Deterministic entity keys allowed for this request.
 * @returns Stable entity-reference interpretation when supported, otherwise `null`.
 */
function coerceEntityReferenceInterpretationSignal(
  payload: ParsedEntityReferenceInterpretationPayload,
  allowedEntityKeys: ReadonlySet<string>
): EntityReferenceInterpretationSignal | null {
  const kind = (payload.kind ?? "").trim() as EntityReferenceInterpretationKind;
  const confidence = (payload.confidence ?? "").trim().toLowerCase() as LocalIntentModelConfidence;
  if (!SUPPORTED_ENTITY_REFERENCE_KINDS.has(kind) || !SUPPORTED_CONFIDENCE.has(confidence)) {
    return null;
  }
  const selectedEntityKeys = normalizeSelectedEntityKeys(payload.selectedEntityKeys, allowedEntityKeys);
  const aliasCandidate = normalizeAliasCandidate(payload.aliasCandidate);
  if (kind === "entity_scoped_reference") {
    if (selectedEntityKeys.length === 0 || aliasCandidate) {
      return null;
    }
  } else if (kind === "entity_alias_candidate") {
    if (selectedEntityKeys.length !== 1 || !aliasCandidate) {
      return null;
    }
  } else if (selectedEntityKeys.length > 0 || aliasCandidate) {
    return null;
  }
  return {
    source: "local_intent_model",
    kind,
    selectedEntityKeys,
    aliasCandidate: aliasCandidate ?? null,
    confidence,
    explanation: normalizeEntityReferenceExplanation(payload.explanation, kind)
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
 * Creates the bounded Ollama-backed entity-reference-interpretation resolver.
 *
 * @param config - Ollama runtime config.
 * @param deps - Optional dependency overrides for tests.
 * @returns Fail-closed entity-reference-interpretation resolver.
 */
export function createOllamaEntityReferenceInterpretationResolver(
  config: OllamaEntityReferenceInterpretationConfig,
  deps: OllamaEntityReferenceInterpretationDependencies = {}
): EntityReferenceInterpretationResolver {
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
      const candidateEntities = request.candidateEntities ?? [];
      const allowedEntityKeys = new Set(candidateEntities.map((candidate) => candidate.entityKey));
      const response = await fetchJson(
        `${normalizeBaseUrl(config.baseUrl)}/api/generate`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: config.model,
            prompt: buildEntityReferenceInterpretationPrompt(
              request.userInput,
              routingHint,
              request.sessionHints ?? null,
              request.recentTurns,
              candidateEntities,
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
      return coerceEntityReferenceInterpretationSignal(
        extractEntityReferenceJsonObject(payload.response) ?? {},
        allowedEntityKeys
      );
    } catch {
      return null;
    }
  };
}
