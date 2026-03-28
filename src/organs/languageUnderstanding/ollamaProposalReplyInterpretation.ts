/**
 * @fileoverview Provides the bounded Ollama-backed proposal-reply-interpretation task for the
 * shared local conversational runtime.
 */

import type {
  LocalIntentModelConfidence,
  LocalIntentModelSessionHints
} from "./localIntentModelContracts";
import type {
  ProposalReplyInterpretationKind,
  ProposalReplyInterpretationResolver,
  ProposalReplyInterpretationSignal
} from "./localIntentModelProposalReplyContracts";

interface OllamaProposalReplyInterpretationConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

interface OllamaProposalReplyInterpretationDependencies {
  fetchImpl?: typeof fetch;
}

interface OllamaGenerateResponse {
  response?: string;
}

interface ParsedProposalReplyInterpretationPayload {
  kind?: string;
  adjustmentText?: string | null;
  confidence?: string;
  explanation?: string;
}

const SUPPORTED_CONFIDENCE = new Set<LocalIntentModelConfidence>([
  "low",
  "medium",
  "high"
]);

const SUPPORTED_PROPOSAL_REPLY_KINDS = new Set<ProposalReplyInterpretationKind>([
  "approve",
  "cancel",
  "adjust",
  "question_or_unclear",
  "non_proposal_reply",
  "uncertain"
]);

const MAX_ADJUSTMENT_TEXT_CHARS = 180;

/** Normalizes an Ollama base URL by trimming trailing slashes. */
function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Builds the bounded proposal-reply prompt sent to the local Phi model.
 *
 * @param userInput - Raw user request being interpreted.
 * @param routingHint - Optional deterministic routing hint supplied by the front door.
 * @param sessionHints - Optional bounded session hints for the same turn.
 * @param activeProposalPreview - Optional current draft preview.
 * @param recentAssistantTurn - Optional recent assistant turn near the draft exchange.
 * @returns Prompt text constrained to the proposal-reply contract.
 */
function buildProposalReplyInterpretationPrompt(
  userInput: string,
  routingHint: object | null,
  sessionHints: LocalIntentModelSessionHints | null,
  activeProposalPreview: string | null | undefined,
  recentAssistantTurn: string | null | undefined
): string {
  return [
    "Interpret the user's conversational turn for AgentBigBrain.",
    "Return JSON only.",
    "Task: proposal_reply_interpretation.",
    "Allowed kind values: approve, cancel, adjust, question_or_unclear, non_proposal_reply, uncertain.",
    "Allowed confidence values: low, medium, high.",
    "Use approve when the user is clearly approving or greenlighting the active draft.",
    "Use cancel when the user is clearly rejecting or cancelling the active draft.",
    "Use adjust when the user is clearly asking to modify the active draft before approval.",
    "Use question_or_unclear when the user is asking a question about the draft or the meaning is still unresolved.",
    "Use non_proposal_reply when the turn is ordinary chat or unrelated to the active draft.",
    "Use uncertain only when draft-reply interpretation might matter but you cannot choose safely.",
    "For adjust, return a short adjustmentText that captures the requested change.",
    "Do not invent new project state, files, browser state, or workflow facts.",
    "Do not output adjustmentText for approve, cancel, question_or_unclear, non_proposal_reply, or uncertain.",
    "Examples:",
    '- "looks good, run it" => {"kind":"approve","adjustmentText":null,"confidence":"high"}',
    '- "never mind, cancel that draft" => {"kind":"cancel","adjustmentText":null,"confidence":"high"}',
    '- "make it weekly instead" => {"kind":"adjust","adjustmentText":"make it weekly instead","confidence":"high"}',
    '- "what would this change exactly?" => {"kind":"question_or_unclear","adjustmentText":null,"confidence":"medium"}',
    '- "hi there" => {"kind":"non_proposal_reply","adjustmentText":null,"confidence":"high"}',
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
    "Active proposal preview:",
    JSON.stringify(activeProposalPreview ?? null),
    "",
    "Recent assistant turn:",
    JSON.stringify(recentAssistantTurn ?? null),
    "",
    "Reply as one JSON object with keys: kind, adjustmentText, confidence, explanation."
  ].join("\n");
}

/** Caps and normalizes the explanation returned by the proposal-reply interpreter. */
function normalizeProposalReplyExplanation(
  value: string | undefined,
  kind: ProposalReplyInterpretationKind
): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    return `The local intent model classified this proposal reply as ${kind}.`;
  }
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}

/** Extracts one JSON object from the raw model response text for proposal-reply interpretation. */
function extractProposalReplyJsonObject(
  raw: string
): ParsedProposalReplyInterpretationPayload | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as ParsedProposalReplyInterpretationPayload;
  } catch {
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace < 0 || lastBrace <= firstBrace) {
      return null;
    }
    try {
      return JSON.parse(
        trimmed.slice(firstBrace, lastBrace + 1)
      ) as ParsedProposalReplyInterpretationPayload;
    } catch {
      return null;
    }
  }
}

/** Normalizes one model-proposed adjustment text into a bounded value. */
function normalizeAdjustmentText(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized && normalized.length <= MAX_ADJUSTMENT_TEXT_CHARS ? normalized : null;
}

/** Converts a parsed proposal-reply payload into the stable task contract. */
function coerceProposalReplyInterpretationPayload(
  payload: ParsedProposalReplyInterpretationPayload
): ProposalReplyInterpretationSignal | null {
  const kind = (payload.kind ?? "").trim().toLowerCase() as ProposalReplyInterpretationKind;
  if (!SUPPORTED_PROPOSAL_REPLY_KINDS.has(kind)) {
    return null;
  }
  const confidence = (payload.confidence ?? "").trim().toLowerCase() as LocalIntentModelConfidence;
  if (!SUPPORTED_CONFIDENCE.has(confidence)) {
    return null;
  }
  const adjustmentText = normalizeAdjustmentText(payload.adjustmentText);
  if (kind === "adjust" && !adjustmentText) {
    return null;
  }
  if (kind !== "adjust" && adjustmentText) {
    return null;
  }
  return {
    source: "local_intent_model",
    kind,
    adjustmentText: kind === "adjust" ? adjustmentText : null,
    confidence,
    explanation: normalizeProposalReplyExplanation(payload.explanation, kind)
  };
}

/**
 * Creates the optional Ollama-backed proposal-reply interpreter.
 *
 * @param config - Ollama connection settings.
 * @param deps - Optional dependency overrides for tests.
 * @returns Resolver that fails closed on transport, parsing, or coercion errors.
 */
export function createOllamaProposalReplyInterpretationResolver(
  config: OllamaProposalReplyInterpretationConfig,
  deps: OllamaProposalReplyInterpretationDependencies = {}
): ProposalReplyInterpretationResolver {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const normalizedBaseUrl = normalizeBaseUrl(config.baseUrl);

  return async (request) => {
    const prompt = buildProposalReplyInterpretationPrompt(
      request.userInput,
      request.routingClassification,
      request.sessionHints ?? null,
      request.activeProposalPreview,
      request.recentAssistantTurn
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
      const parsed = extractProposalReplyJsonObject(payload.response);
      if (!parsed) {
        return null;
      }
      return coerceProposalReplyInterpretationPayload(parsed);
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  };
}
