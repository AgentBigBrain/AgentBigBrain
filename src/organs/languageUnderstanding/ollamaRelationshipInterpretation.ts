/**
 * @fileoverview Provides the bounded Ollama-backed relationship-memory interpretation task.
 */

import type {
  LocalIntentModelConfidence,
  RelationshipInterpretationEpisodeCandidate,
  RelationshipInterpretationKind,
  RelationshipInterpretationResolver,
  RelationshipInterpretationSignal
} from "./localIntentModelContracts";
import type {
  ProfileSemanticRelationshipAmbiguity,
  ProfileSemanticRelationshipCandidateInput,
  ProfileSemanticRelationshipLifecycle
} from "../../core/profileMemoryRuntime/contracts";

interface OllamaRelationshipInterpretationConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface OllamaRelationshipInterpretationDependencies {
  fetchImpl?: typeof fetch;
}

interface OllamaGenerateResponse {
  response?: string;
}

interface ParsedRelationshipInterpretationPayload {
  kind?: unknown;
  candidates?: unknown;
  episodeCandidates?: unknown;
  confidence?: unknown;
  explanation?: unknown;
}

const SUPPORTED_CONFIDENCE = new Set<LocalIntentModelConfidence>([
  "low",
  "medium",
  "high"
]);
const SUPPORTED_RELATIONSHIP_KINDS = new Set<RelationshipInterpretationKind>([
  "relationship_candidates",
  "non_relationship_memory",
  "uncertain"
]);
const SUPPORTED_LIFECYCLES = new Set<ProfileSemanticRelationshipLifecycle>([
  "current",
  "historical",
  "severed",
  "uncertain"
]);
const SUPPORTED_AMBIGUITY = new Set<ProfileSemanticRelationshipAmbiguity>([
  "none",
  "ambiguous_subject",
  "ambiguous_object",
  "ambiguous_relation",
  "ambiguous_lifecycle"
]);
const MAX_RELATIONSHIP_CANDIDATES = 5;

/**
 * Removes trailing slashes from the configured Ollama base URL.
 *
 * @param value - Raw base URL.
 * @returns Normalized base URL.
 */
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Normalizes bounded text from an unknown model payload field.
 *
 * @param value - Unknown model payload value.
 * @param maxLength - Maximum accepted normalized length.
 * @returns Trimmed text, or `null` when unusable.
 */
function normalizeBoundedText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > maxLength) {
    return null;
  }
  return normalized;
}

/**
 * Clamps an optional model confidence score into the supported range.
 *
 * @param value - Unknown model payload value.
 * @returns Bounded confidence score, or `undefined` when absent.
 */
function normalizeConfidenceScore(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(0, Math.min(1, value));
}

/**
 * Builds the relationship-memory interpretation prompt for the local model backend.
 *
 * @param userInput - Current user turn.
 * @param routingHint - Deterministic routing metadata already available to the runtime.
 * @param sessionHints - Bounded session hints for interpretation.
 * @param recentTurns - Recent conversation turns for local context.
 * @returns Prompt text sent to the local model.
 */
function buildRelationshipInterpretationPrompt(
  userInput: string,
  routingHint: object | null,
  sessionHints: object | null,
  recentTurns: readonly { role: "user" | "assistant"; text: string }[] | undefined
): string {
  return [
    "Interpret the user's conversational turn for AgentBigBrain.",
    "Return JSON only.",
    "Task: relationship_memory_interpretation.",
    "Allowed kind values: relationship_candidates, non_relationship_memory, uncertain.",
    "Allowed confidence values: low, medium, high.",
    "Only emit relationship_candidates when the user is making an explicit statement about their own relationship to another person.",
    "You may also emit episodeCandidates for explicit user-stated events involving people, objects, or transfers.",
    "Do not infer relationships from file names, project names, workflow labels, browser tabs, docs, or assistant prose.",
    "Each candidate must use subject current_user.",
    "Use objectQualifier only when the user clearly distinguishes two people with the same visible name.",
    "Allowed lifecycle values: current, historical, severed, uncertain.",
    "Allowed sourceFamily value: semantic_model.",
    "Allowed ambiguity values: none, ambiguous_subject, ambiguous_object, ambiguous_relation, ambiguous_lifecycle.",
    "Use relationLabel values like employee, work_peer, friend, family, partner, spouse, contractor, client, colleague.",
    "Use workAssociation only when the user's statement explicitly names an organization or workplace.",
    "evidenceSpan.text must quote the exact relevant user wording, not a paraphrase.",
    "Examples:",
    '- "I work with Milo at Northstar." => {"kind":"relationship_candidates","confidence":"high","candidates":[{"subject":"current_user","objectDisplayName":"Milo","relationLabel":"work_peer","lifecycle":"current","workAssociation":"Northstar","sourceFamily":"semantic_model","ambiguity":"none","evidenceSpan":{"text":"I work with Milo at Northstar"},"confidence":0.93}]}',
    '- "I used to work with Milo at Lumen Studio." => {"kind":"relationship_candidates","confidence":"high","candidates":[{"subject":"current_user","objectDisplayName":"Milo","relationLabel":"work_peer","lifecycle":"historical","workAssociation":"Lumen Studio","sourceFamily":"semantic_model","ambiguity":"none","evidenceSpan":{"text":"I used to work with Milo at Lumen Studio"},"confidence":0.91}]}',
    '- "Open Jordan-Northstar-hero-v2.html" => {"kind":"non_relationship_memory","confidence":"high","candidates":[]}',
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
    "Reply as one JSON object with keys: kind, candidates, episodeCandidates, confidence, explanation."
  ].join("\n");
}

/**
 * Extracts a JSON object from one model response.
 *
 * @param raw - Raw model text.
 * @returns Parsed relationship interpretation payload, or `null`.
 */
function extractRelationshipJsonObject(raw: string): ParsedRelationshipInterpretationPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as ParsedRelationshipInterpretationPayload;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null;
    }
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)) as ParsedRelationshipInterpretationPayload;
    } catch {
      return null;
    }
  }
}

/**
 * Normalizes one typed relationship candidate from model JSON.
 *
 * @param value - Unknown candidate payload.
 * @returns Structured relationship candidate, or `null` when invalid.
 */
function normalizeRelationshipCandidate(value: unknown): ProfileSemanticRelationshipCandidateInput | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const subject = raw.subject === "current_user" ? "current_user" : null;
  const objectDisplayName = normalizeBoundedText(raw.objectDisplayName, 80);
  const objectQualifier = normalizeBoundedText(raw.objectQualifier, 80);
  const relationLabel = normalizeBoundedText(raw.relationLabel, 40);
  const lifecycle = typeof raw.lifecycle === "string"
    ? raw.lifecycle.trim().toLowerCase() as ProfileSemanticRelationshipLifecycle
    : null;
  if (
    subject !== "current_user" ||
    !objectDisplayName ||
    !relationLabel ||
    !lifecycle ||
    !SUPPORTED_LIFECYCLES.has(lifecycle)
  ) {
    return null;
  }
  const evidenceSpan = typeof raw.evidenceSpan === "object" && raw.evidenceSpan !== null
    ? raw.evidenceSpan as Record<string, unknown>
    : {};
  const evidenceText = normalizeBoundedText(evidenceSpan.text, 240);
  if (!evidenceText) {
    return null;
  }
  const ambiguity = typeof raw.ambiguity === "string" &&
    SUPPORTED_AMBIGUITY.has(raw.ambiguity.trim().toLowerCase() as ProfileSemanticRelationshipAmbiguity)
    ? raw.ambiguity.trim().toLowerCase() as ProfileSemanticRelationshipAmbiguity
    : "none";
  const workAssociation = normalizeBoundedText(raw.workAssociation, 120);
  return {
    subject,
    objectDisplayName,
    ...(objectQualifier ? { objectQualifier } : {}),
    relationLabel,
    lifecycle,
    ...(workAssociation ? { workAssociation } : {}),
    sourceFamily: "semantic_model",
    ambiguity,
    evidenceSpan: {
      text: evidenceText
    },
    confidence: normalizeConfidenceScore(raw.confidence),
    sensitive: raw.sensitive === true
  };
}

/**
 * Normalizes one typed relationship-adjacent episode candidate from model JSON.
 *
 * @param value - Unknown candidate payload.
 * @returns Structured episode candidate, or `null` when invalid.
 */
function normalizeRelationshipEpisodeCandidate(
  value: unknown
): RelationshipInterpretationEpisodeCandidate | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const title = normalizeBoundedText(raw.title, 120);
  const summary = normalizeBoundedText(raw.summary, 320);
  const evidenceText = normalizeBoundedText(raw.evidenceText, 240);
  if (!title || !summary || !evidenceText) {
    return null;
  }
  return {
    title,
    summary,
    evidenceText,
    entityRefs: Array.isArray(raw.entityRefs)
      ? raw.entityRefs
        .map((entry) => normalizeBoundedText(entry, 80))
        .filter((entry): entry is string => Boolean(entry))
        .slice(0, 8)
      : [],
    tags: Array.isArray(raw.tags)
      ? raw.tags
        .map((entry) => normalizeBoundedText(entry, 40))
        .filter((entry): entry is string => Boolean(entry))
        .slice(0, 8)
      : [],
    sensitive: raw.sensitive === true,
    confidence: normalizeConfidenceScore(raw.confidence)
  };
}

/**
 * Builds a bounded explanation string for interpreter diagnostics.
 *
 * @param value - Unknown model explanation field.
 * @param kind - Normalized interpretation kind.
 * @returns Bounded explanation.
 */
function normalizeRelationshipExplanation(
  value: unknown,
  kind: RelationshipInterpretationKind
): string {
  const normalized = normalizeBoundedText(value, 240);
  return normalized ?? `The local intent model classified this request as ${kind}.`;
}

/**
 * Coerces parsed model JSON into the relationship interpretation contract.
 *
 * @param payload - Parsed model payload.
 * @returns Contract-safe signal, or `null` when invalid.
 */
function coerceRelationshipInterpretationSignal(
  payload: ParsedRelationshipInterpretationPayload
): RelationshipInterpretationSignal | null {
  const rawKind = typeof payload.kind === "string" ? payload.kind.trim() : "";
  const rawConfidence = typeof payload.confidence === "string"
    ? payload.confidence.trim().toLowerCase()
    : "";
  if (
    !SUPPORTED_RELATIONSHIP_KINDS.has(rawKind as RelationshipInterpretationKind) ||
    !SUPPORTED_CONFIDENCE.has(rawConfidence as LocalIntentModelConfidence)
  ) {
    return null;
  }
  const kind = rawKind as RelationshipInterpretationKind;
  const confidence = rawConfidence as LocalIntentModelConfidence;
  const candidates = Array.isArray(payload.candidates)
    ? payload.candidates
      .slice(0, MAX_RELATIONSHIP_CANDIDATES)
      .map(normalizeRelationshipCandidate)
      .filter((candidate): candidate is ProfileSemanticRelationshipCandidateInput => Boolean(candidate))
    : [];
  const episodeCandidates = Array.isArray(payload.episodeCandidates)
    ? payload.episodeCandidates
      .slice(0, MAX_RELATIONSHIP_CANDIDATES)
      .map(normalizeRelationshipEpisodeCandidate)
      .filter((candidate): candidate is RelationshipInterpretationEpisodeCandidate => Boolean(candidate))
    : [];
  if (kind === "relationship_candidates" && candidates.length === 0 && episodeCandidates.length === 0) {
    return null;
  }
  return {
    source: "local_intent_model",
    kind,
    candidates: kind === "relationship_candidates" ? candidates : [],
    episodeCandidates: kind === "relationship_candidates" ? episodeCandidates : [],
    confidence,
    explanation: normalizeRelationshipExplanation(payload.explanation, kind)
  };
}

/**
 * Performs one bounded fetch with timeout handling.
 *
 * @param url - Request URL.
 * @param init - Fetch options.
 * @param timeoutMs - Timeout budget.
 * @param fetchImpl - Fetch implementation.
 * @returns Fetch response.
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
 * Creates an Ollama-backed relationship interpretation resolver.
 *
 * @param config - Backend URL, model name, and timeout settings.
 * @param deps - Optional runtime dependencies.
 * @returns Relationship interpretation resolver.
 */
export function createOllamaRelationshipInterpretationResolver(
  config: OllamaRelationshipInterpretationConfig,
  deps: OllamaRelationshipInterpretationDependencies = {}
): RelationshipInterpretationResolver {
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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: config.model,
            prompt: buildRelationshipInterpretationPrompt(
              request.userInput,
              routingHint,
              request.sessionHints ?? null,
              request.recentTurns
            ),
            stream: false,
            format: "json"
          })
        },
        config.timeoutMs,
        fetchImpl
      );
      if (!response.ok) {
        return null;
      }
      const payload = await response.json() as OllamaGenerateResponse;
      return coerceRelationshipInterpretationSignal(
        extractRelationshipJsonObject(payload.response ?? "") ?? {}
      );
    } catch {
      return null;
    }
  };
}
