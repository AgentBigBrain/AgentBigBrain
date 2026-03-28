/**
 * @fileoverview Provides the bounded Ollama-backed entity-type-interpretation task for the shared
 * local conversational runtime.
 */

import type {
  EntityTypeInterpretationKind,
  EntityTypeInterpretationResolver,
  EntityTypeInterpretationSelection,
  EntityTypeInterpretationSignal,
  LocalIntentModelConfidence,
  LocalIntentModelSessionHints
} from "./localIntentModelContracts";

interface OllamaEntityTypeInterpretationConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface OllamaEntityTypeInterpretationDependencies {
  fetchImpl?: typeof fetch;
}

interface OllamaGenerateResponse {
  response?: string;
}

interface ParsedEntityTypeInterpretationSelection {
  candidateName?: unknown;
  entityType?: unknown;
}

interface ParsedEntityTypeInterpretationPayload {
  kind?: string;
  typedCandidates?: unknown;
  confidence?: string;
  explanation?: string;
}

const SUPPORTED_CONFIDENCE = new Set<LocalIntentModelConfidence>([
  "low",
  "medium",
  "high"
]);

const SUPPORTED_ENTITY_TYPE_INTERPRETATION_KINDS = new Set<EntityTypeInterpretationKind>([
  "typed_candidates",
  "non_entity_type_boundary",
  "uncertain"
]);

const SUPPORTED_ENTITY_TYPES = new Set<
  EntityTypeInterpretationSelection["entityType"]
>(["person", "place", "org", "event", "thing", "concept"]);

const MAX_TYPED_CANDIDATES = 4;
const MAX_CANDIDATE_NAME_CHARS = 80;

/** Normalizes an Ollama base URL by trimming trailing slashes. */
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Builds the bounded entity-type prompt sent to the local Phi model.
 *
 * @param userInput - Raw user request being interpreted.
 * @param routingHint - Optional deterministic routing hint supplied by the front door.
 * @param sessionHints - Optional bounded session hints for the same turn.
 * @param recentTurns - Optional bounded nearby turn context.
 * @param candidateEntities - Optional deterministic entity candidates already extracted locally.
 * @param deterministicHints - Optional bounded deterministic hints already extracted locally.
 * @returns Prompt text constrained to the entity-type contract.
 */
function buildEntityTypeInterpretationPrompt(
  userInput: string,
  routingHint: object | null,
  sessionHints: LocalIntentModelSessionHints | null,
  recentTurns: readonly { role: "user" | "assistant"; text: string }[] | undefined,
  candidateEntities:
    | readonly {
        candidateName: string;
        deterministicEntityType: string;
        domainHint: string | null;
      }[]
    | undefined,
  deterministicHints: readonly string[] | undefined
): string {
  return [
    "Interpret the user's conversational turn for AgentBigBrain.",
    "Return JSON only.",
    "Task: entity_type_interpretation.",
    "Allowed kind values: typed_candidates, non_entity_type_boundary, uncertain.",
    "Allowed entityType values: person, place, org, event, thing, concept.",
    "Allowed confidence values: low, medium, high.",
    "You may only type candidateName values that already appear in candidateEntities.",
    "Use typed_candidates when conversational context clarifies the entity type of one or more provided candidate entities.",
    "Use non_entity_type_boundary when the turn is not meaningfully helping with entity typing, such as plain chat, workflow execution, or status requests.",
    "Use uncertain when typing might be relevant but you cannot choose safely from the bounded context.",
    "Do not invent candidate names, external facts, files, paths, or URLs.",
    "Do not emit explanations inside candidateName.",
    "Examples:",
    '- "my friend Sarah is joining us later" with Sarah in candidateEntities => {"kind":"typed_candidates","typedCandidates":[{"candidateName":"Sarah","entityType":"person"}],"confidence":"high"}',
    '- "the meeting with Google is tomorrow" with Google and meeting in candidateEntities => {"kind":"typed_candidates","typedCandidates":[{"candidateName":"Google","entityType":"org"},{"candidateName":"Meeting","entityType":"event"}],"confidence":"medium"}',
    '- "close the browser and ship the css fix" => {"kind":"non_entity_type_boundary","typedCandidates":[],"confidence":"high"}',
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
    "Reply as one JSON object with keys: kind, typedCandidates, confidence, explanation."
  ].join("\n");
}

/** Caps and normalizes the explanation returned by the entity-type interpreter. */
function normalizeEntityTypeExplanation(
  value: string | undefined,
  kind: EntityTypeInterpretationKind
): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return `The local intent model classified this request as ${kind}.`;
  }
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

/** Extracts one JSON object from the raw model response text for entity-type interpretation. */
function extractEntityTypeJsonObject(
  raw: string
): ParsedEntityTypeInterpretationPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as ParsedEntityTypeInterpretationPayload;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null;
    }
    try {
      return JSON.parse(
        trimmed.slice(firstBrace, lastBrace + 1)
      ) as ParsedEntityTypeInterpretationPayload;
    } catch {
      return null;
    }
  }
}

/** Normalizes one model-proposed candidate name into a bounded selectable value. */
function normalizeCandidateName(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > MAX_CANDIDATE_NAME_CHARS) {
    return null;
  }
  if (!/^[\p{L}\p{N}][\p{L}\p{N}' .,&-]*$/u.test(normalized)) {
    return null;
  }
  return normalized;
}

/** Normalizes one model-proposed entity type into the bounded shared contract. */
function normalizeEntityType(
  value: unknown
): EntityTypeInterpretationSelection["entityType"] | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase() as EntityTypeInterpretationSelection["entityType"];
  return SUPPORTED_ENTITY_TYPES.has(normalized) ? normalized : null;
}

/**
 * Normalizes one model-proposed typed-candidate array into a stable bounded list.
 *
 * @param value - Raw typed-candidate array candidate from the model.
 * @param allowedCandidateNames - Deterministic candidate names allowed for this request.
 * @returns Stable bounded typed-candidate list.
 */
function normalizeTypedCandidates(
  value: unknown,
  allowedCandidateNames: ReadonlySet<string>
): readonly EntityTypeInterpretationSelection[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = new Map<string, EntityTypeInterpretationSelection>();
  for (const candidate of value) {
    if (typeof candidate !== "object" || !candidate) {
      continue;
    }
    const selection = candidate as ParsedEntityTypeInterpretationSelection;
    const candidateName = normalizeCandidateName(selection.candidateName);
    const entityType = normalizeEntityType(selection.entityType);
    if (!candidateName || !entityType || !allowedCandidateNames.has(candidateName)) {
      continue;
    }
    if (!normalized.has(candidateName)) {
      normalized.set(candidateName, {
        candidateName,
        entityType
      });
    }
    if (normalized.size >= MAX_TYPED_CANDIDATES) {
      break;
    }
  }
  return [...normalized.values()];
}

/**
 * Converts a parsed entity-type payload into the stable task contract.
 *
 * @param payload - Parsed JSON payload from the model.
 * @param allowedCandidateNames - Deterministic candidate names allowed for this request.
 * @returns Stable entity-type interpretation when supported, otherwise `null`.
 */
function coerceEntityTypeInterpretationSignal(
  payload: ParsedEntityTypeInterpretationPayload,
  allowedCandidateNames: ReadonlySet<string>
): EntityTypeInterpretationSignal | null {
  const kind = (payload.kind ?? "").trim() as EntityTypeInterpretationKind;
  const confidence = (payload.confidence ?? "").trim().toLowerCase() as LocalIntentModelConfidence;
  if (
    !SUPPORTED_ENTITY_TYPE_INTERPRETATION_KINDS.has(kind) ||
    !SUPPORTED_CONFIDENCE.has(confidence)
  ) {
    return null;
  }
  const typedCandidates = normalizeTypedCandidates(
    payload.typedCandidates,
    allowedCandidateNames
  );
  if (kind === "typed_candidates") {
    if (typedCandidates.length === 0) {
      return null;
    }
  } else if (typedCandidates.length > 0) {
    return null;
  }
  return {
    source: "local_intent_model",
    kind,
    typedCandidates,
    confidence,
    explanation: normalizeEntityTypeExplanation(payload.explanation, kind)
  };
}

/**
 * Creates the bounded Ollama-backed entity-type-interpretation resolver.
 *
 * @param config - Ollama runtime config.
 * @param deps - Optional dependency overrides for tests.
 * @returns Fail-closed entity-type-interpretation resolver.
 */
export function createOllamaEntityTypeInterpretationResolver(
  config: OllamaEntityTypeInterpretationConfig,
  deps: OllamaEntityTypeInterpretationDependencies = {}
): EntityTypeInterpretationResolver {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const baseUrl = normalizeBaseUrl(config.baseUrl);

  return async (request) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
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
      const allowedCandidateNames = new Set(
        candidateEntities.map((candidate) => candidate.candidateName)
      );
      const response = await fetchImpl(`${baseUrl}/api/generate`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: config.model,
          stream: false,
          format: "json",
          prompt: buildEntityTypeInterpretationPrompt(
            request.userInput,
            routingHint,
            request.sessionHints ?? null,
            request.recentTurns,
            candidateEntities,
            request.deterministicHints
          ),
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
      return coerceEntityTypeInterpretationSignal(
        extractEntityTypeJsonObject(payload.response) ?? {},
        allowedCandidateNames
      );
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };
}
