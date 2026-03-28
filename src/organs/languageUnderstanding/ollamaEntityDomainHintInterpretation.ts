/**
 * @fileoverview Provides the bounded Ollama-backed entity-domain-hint-interpretation task for the
 * shared local conversational runtime.
 */

import type {
  EntityDomainHintInterpretationKind,
  EntityDomainHintInterpretationResolver,
  EntityDomainHintInterpretationSelection,
  EntityDomainHintInterpretationSignal,
  LocalIntentModelConfidence,
  LocalIntentModelSessionHints
} from "./localIntentModelContracts";

interface OllamaEntityDomainHintInterpretationConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface OllamaEntityDomainHintInterpretationDependencies {
  fetchImpl?: typeof fetch;
}

interface OllamaGenerateResponse {
  response?: string;
}

interface ParsedEntityDomainHintInterpretationSelection {
  candidateName?: unknown;
  domainHint?: unknown;
}

interface ParsedEntityDomainHintInterpretationPayload {
  kind?: string;
  domainHintedCandidates?: unknown;
  confidence?: string;
  explanation?: string;
}

const SUPPORTED_CONFIDENCE = new Set<LocalIntentModelConfidence>([
  "low",
  "medium",
  "high"
]);

const SUPPORTED_ENTITY_DOMAIN_HINT_INTERPRETATION_KINDS =
  new Set<EntityDomainHintInterpretationKind>([
    "domain_hinted_candidates",
    "non_entity_domain_boundary",
    "uncertain"
  ]);

const SUPPORTED_ENTITY_DOMAIN_HINTS = new Set<
  EntityDomainHintInterpretationSelection["domainHint"]
>(["profile", "relationship", "workflow"]);

const MAX_DOMAIN_HINTED_CANDIDATES = 4;
const MAX_CANDIDATE_NAME_CHARS = 80;

/** Normalizes an Ollama base URL by trimming trailing slashes. */
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Builds the bounded entity-domain-hint prompt sent to the local Phi model.
 *
 * @param userInput - Raw user request being interpreted.
 * @param routingHint - Optional deterministic routing hint supplied by the front door.
 * @param sessionHints - Optional bounded session hints for the same turn.
 * @param recentTurns - Optional bounded nearby turn context.
 * @param candidateEntities - Optional deterministic entity candidates already extracted locally.
 * @param deterministicHints - Optional bounded deterministic hints already extracted locally.
 * @returns Prompt text constrained to the entity-domain-hint contract.
 */
function buildEntityDomainHintInterpretationPrompt(
  userInput: string,
  routingHint: object | null,
  sessionHints: LocalIntentModelSessionHints | null,
  recentTurns: readonly { role: "user" | "assistant"; text: string }[] | undefined,
  candidateEntities:
    | readonly {
        candidateName: string;
        entityType: string;
        deterministicDomainHint: string | null;
      }[]
    | undefined,
  deterministicHints: readonly string[] | undefined
): string {
  return [
    "Interpret the user's conversational turn for AgentBigBrain.",
    "Return JSON only.",
    "Task: entity_domain_hint_interpretation.",
    "Allowed kind values: domain_hinted_candidates, non_entity_domain_boundary, uncertain.",
    "Allowed domainHint values: profile, relationship, workflow.",
    "Allowed confidence values: low, medium, high.",
    "You may only emit candidateName values that already appear in candidateEntities.",
    "Use domain_hinted_candidates when conversational context provides a better per-observation memory domain than the session-level lane alone.",
    "Use relationship for people or entities framed through social/personal relationships.",
    "Use profile for self-descriptive personal preference, identity, or lifestyle context.",
    "Use workflow for task, project, organizational, planning, or work-execution context.",
    "Use non_entity_domain_boundary when the turn does not safely help with per-entity domain hinting.",
    "Use uncertain when domain hinting might matter but you cannot choose safely from the bounded context.",
    "Do not invent candidate names, external facts, files, paths, or URLs.",
    "Examples:",
    '- "my friend Sarah is coming over tonight" with Sarah in candidateEntities => {"kind":"domain_hinted_candidates","domainHintedCandidates":[{"candidateName":"Sarah","domainHint":"relationship"}],"confidence":"high"}',
    '- "Google needs the revised launch deck by tomorrow" with Google in candidateEntities => {"kind":"domain_hinted_candidates","domainHintedCandidates":[{"candidateName":"Google","domainHint":"workflow"}],"confidence":"high"}',
    '- "I love this cafe called Roma" with Roma in candidateEntities => {"kind":"domain_hinted_candidates","domainHintedCandidates":[{"candidateName":"Roma","domainHint":"profile"}],"confidence":"medium"}',
    '- "close the browser and ship the fix" => {"kind":"non_entity_domain_boundary","domainHintedCandidates":[],"confidence":"high"}',
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
    "Reply as one JSON object with keys: kind, domainHintedCandidates, confidence, explanation."
  ].join("\n");
}

/** Caps and normalizes the explanation returned by the entity-domain-hint interpreter. */
function normalizeEntityDomainHintExplanation(
  value: string | undefined,
  kind: EntityDomainHintInterpretationKind
): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return `The local intent model classified this request as ${kind}.`;
  }
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

/** Extracts one JSON object from the raw model response text for entity-domain-hint interpretation. */
function extractEntityDomainHintJsonObject(
  raw: string
): ParsedEntityDomainHintInterpretationPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as ParsedEntityDomainHintInterpretationPayload;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null;
    }
    try {
      return JSON.parse(
        trimmed.slice(firstBrace, lastBrace + 1)
      ) as ParsedEntityDomainHintInterpretationPayload;
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

/** Normalizes one model-proposed entity-domain hint into the bounded shared contract. */
function normalizeEntityDomainHint(
  value: unknown
): EntityDomainHintInterpretationSelection["domainHint"] | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized =
    value.trim().toLowerCase() as EntityDomainHintInterpretationSelection["domainHint"];
  return SUPPORTED_ENTITY_DOMAIN_HINTS.has(normalized) ? normalized : null;
}

/**
 * Normalizes one model-proposed domain-hinted-candidate array into a stable bounded list.
 *
 * @param value - Raw domain-hinted-candidate array candidate from the model.
 * @param allowedCandidateNames - Deterministic candidate names allowed for this request.
 * @returns Stable bounded domain-hinted-candidate list.
 */
function normalizeDomainHintedCandidates(
  value: unknown,
  allowedCandidateNames: ReadonlySet<string>
): readonly EntityDomainHintInterpretationSelection[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized = new Map<string, EntityDomainHintInterpretationSelection>();
  for (const candidate of value) {
    if (typeof candidate !== "object" || !candidate) {
      continue;
    }
    const selection = candidate as ParsedEntityDomainHintInterpretationSelection;
    const candidateName = normalizeCandidateName(selection.candidateName);
    const domainHint = normalizeEntityDomainHint(selection.domainHint);
    if (!candidateName || !domainHint || !allowedCandidateNames.has(candidateName)) {
      continue;
    }
    if (!normalized.has(candidateName)) {
      normalized.set(candidateName, {
        candidateName,
        domainHint
      });
    }
    if (normalized.size >= MAX_DOMAIN_HINTED_CANDIDATES) {
      break;
    }
  }
  return [...normalized.values()];
}

/**
 * Converts a parsed entity-domain-hint payload into the stable task contract.
 *
 * @param payload - Parsed JSON payload from the model.
 * @param allowedCandidateNames - Deterministic candidate names allowed for this request.
 * @returns Stable entity-domain-hint interpretation when supported, otherwise `null`.
 */
function coerceEntityDomainHintInterpretationSignal(
  payload: ParsedEntityDomainHintInterpretationPayload,
  allowedCandidateNames: ReadonlySet<string>
): EntityDomainHintInterpretationSignal | null {
  const kind = (payload.kind ?? "").trim() as EntityDomainHintInterpretationKind;
  const confidence = (payload.confidence ?? "").trim().toLowerCase() as LocalIntentModelConfidence;
  if (
    !SUPPORTED_ENTITY_DOMAIN_HINT_INTERPRETATION_KINDS.has(kind) ||
    !SUPPORTED_CONFIDENCE.has(confidence)
  ) {
    return null;
  }
  const domainHintedCandidates = normalizeDomainHintedCandidates(
    payload.domainHintedCandidates,
    allowedCandidateNames
  );
  if (kind === "domain_hinted_candidates") {
    if (domainHintedCandidates.length === 0) {
      return null;
    }
  } else if (domainHintedCandidates.length > 0) {
    return null;
  }
  return {
    source: "local_intent_model",
    kind,
    domainHintedCandidates,
    confidence,
    explanation: normalizeEntityDomainHintExplanation(payload.explanation, kind)
  };
}

/**
 * Creates the bounded Ollama-backed entity-domain-hint-interpretation resolver.
 *
 * @param config - Ollama runtime config.
 * @param deps - Optional dependency overrides for tests.
 * @returns Fail-closed entity-domain-hint-interpretation resolver.
 */
export function createOllamaEntityDomainHintInterpretationResolver(
  config: OllamaEntityDomainHintInterpretationConfig,
  deps: OllamaEntityDomainHintInterpretationDependencies = {}
): EntityDomainHintInterpretationResolver {
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
          prompt: buildEntityDomainHintInterpretationPrompt(
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
      return coerceEntityDomainHintInterpretationSignal(
        extractEntityDomainHintJsonObject(payload.response) ?? {},
        allowedCandidateNames
      );
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };
}
