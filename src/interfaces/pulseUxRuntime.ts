/**
 * @fileoverview Renders deterministic Stage 6.86 pulse UX envelopes in live interface delivery paths.
 */

import { buildConversationStackFromTurnsV1 } from "../core/stage6_86ConversationStack";
import {
  PulseCandidateV1,
  PulseReasonCodeV1,
  STAGE_6_86_PULSE_REASON_CODES
} from "../core/types";
import { ConversationSession } from "./sessionStore";
import { buildThreadContextStripV1, renderPulseSummaryV1 } from "./stage6_86UxRendering";

const FALLBACK_PULSE_PREVIEW = "Continuity check-in generated for this session.";

/**
 * Evaluates stage 6.86 pulse reason code and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the stage 6.86 reason-code validation policy explicit and testable before UX rendering.
 *
 * **What it talks to:**
 * - Uses Stage 6.86 reason-code constants from `../core/types`.
 *
 * @param value - Candidate reason-code value parsed from runtime input.
 * @returns `true` when the reason code is a supported Stage 6.86 code.
 */
function isPulseReasonCodeV1(value: string): value is PulseReasonCodeV1 {
  return STAGE_6_86_PULSE_REASON_CODES.includes(value as PulseReasonCodeV1);
}

/**
 * Resolves stage 6.86 reason code from a raw pulse reason fragment.
 *
 * **Why it exists:**
 * Pulse prompts may provide lower-case or mixed-case reason tags; this helper canonicalizes
 * to the Stage 6.86 enum for deterministic UX rendering.
 *
 * **What it talks to:**
 * - Calls `isPulseReasonCodeV1` for enum membership checks.
 *
 * @param rawReason - Raw reason token captured from pulse prompt text.
 * @returns Canonical Stage 6.86 reason code, or `null` when unsupported.
 */
function normalizePulseReasonCode(rawReason: string): PulseReasonCodeV1 | null {
  const normalized = rawReason.trim().replace(/[\s-]+/g, "_").toUpperCase();
  if (!normalized) {
    return null;
  }
  if (!isPulseReasonCodeV1(normalized)) {
    return null;
  }
  return normalized;
}

/**
 * Extracts a Stage 6.86 reason code from system pulse input text.
 *
 * **Why it exists:**
 * Stage 6.86.H output rendering should activate only for continuity pulse prompts that carry
 * an explicit Stage 6.86 reason code.
 *
 * **What it talks to:**
 * - Uses local regex extraction for `Signal type:` and `Reason code:` prompt lines.
 * - Calls `normalizePulseReasonCode` to canonicalize candidates.
 *
 * @param systemInput - Raw system prompt text queued for pulse execution.
 * @returns Extracted Stage 6.86 reason code, or `null` when absent/unsupported.
 */
function extractPulseReasonCode(systemInput: string): PulseReasonCodeV1 | null {
  const signalMatch = systemInput.match(/^\s*Signal type:\s*([A-Za-z0-9_-]+)/im);
  if (signalMatch) {
    const signalReason = normalizePulseReasonCode(signalMatch[1]);
    if (signalReason) {
      return signalReason;
    }
  }

  const reasonMatch = systemInput.match(/^\s*Reason code:\s*([A-Za-z0-9_-]+)/im);
  if (!reasonMatch) {
    return null;
  }
  return normalizePulseReasonCode(reasonMatch[1]);
}

/**
 * Normalizes a base pulse summary into one bounded preview line source.
 *
 * **Why it exists:**
 * Stage 6.86.H requires bounded preview text; this helper ensures multiline model output is
 * normalized before `renderPulseSummaryV1(...)` applies deterministic truncation.
 *
 * **What it talks to:**
 * - Uses local whitespace normalization only.
 *
 * @param baseSummary - User-facing summary returned from governed task execution.
 * @returns One-line preview text used by Stage 6.86 pulse summary rendering.
 */
function buildPulsePreview(baseSummary: string): string {
  const normalized = baseSummary.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return FALLBACK_PULSE_PREVIEW;
  }
  return normalized;
}

/**
 * Builds a lightweight Stage 6.86 pulse candidate object for UX rendering.
 *
 * **Why it exists:**
 * `renderPulseSummaryV1(...)` expects a typed `PulseCandidateV1`; live delivery only needs
 * reason-code identity and stable metadata for deterministic rendering.
 *
 * **What it talks to:**
 * - Uses `PulseCandidateV1` and supporting types from `../core/types`.
 *
 * @param reasonCode - Canonical Stage 6.86 reason code for this pulse emission.
 * @param session - Conversation session associated with this pulse job.
 * @param observedAt - Timestamp for deterministic candidate metadata fields.
 * @returns Synthetic but typed pulse candidate for UX summary rendering.
 */
function buildRenderCandidate(
  reasonCode: PulseReasonCodeV1,
  session: ConversationSession,
  observedAt: string
): PulseCandidateV1 {
  const stableIdSeed = `${session.conversationId}:${reasonCode}:${observedAt}`;
  return {
    candidateId: `ux_candidate_${Buffer.from(stableIdSeed).toString("base64url").slice(0, 24)}`,
    reasonCode,
    score: 0,
    scoreBreakdown: {
      recency: 0,
      frequency: 0,
      unresolvedImportance: 0,
      sensitivityPenalty: 0,
      cooldownPenalty: 0
    },
    lastTouchedAt: observedAt,
    threadKey: session.conversationStack?.activeThreadKey ?? null,
    entityRefs: [],
    evidenceRefs: [],
    stableHash: "stage6_86_runtime_ux_render"
  };
}

/**
 * Builds deterministic Stage 6.86.H pulse UX text for live user delivery.
 *
 * **Why it exists:**
 * Stage 6.86.H requires reason-code rendering + bounded preview + thread-context strip in
 * production output paths. This helper composes those artifacts around the existing summary.
 *
 * **What it talks to:**
 * - Uses `buildConversationStackFromTurnsV1` when persisted stack is unavailable.
 * - Uses `renderPulseSummaryV1` and `buildThreadContextStripV1` for Stage 6.86.H formatting.
 *
 * @param session - Session context tied to the pulse job.
 * @param systemInput - Internal pulse prompt text used to detect Stage 6.86 reason code.
 * @param baseSummary - Existing user-facing summary from governed execution.
 * @param observedAt - Timestamp used for deterministic synthetic candidate metadata.
 * @returns Final user-visible summary text with Stage 6.86.H envelope when applicable.
 */
export function renderPulseUserFacingSummaryV1(
  session: ConversationSession,
  systemInput: string,
  baseSummary: string,
  observedAt: string
): string {
  const reasonCode = extractPulseReasonCode(systemInput);
  if (!reasonCode) {
    return baseSummary;
  }

  const stack = session.conversationStack ??
    buildConversationStackFromTurnsV1(session.conversationTurns, session.updatedAt);
  const candidate = buildRenderCandidate(reasonCode, session, observedAt);
  const pulseSummary = renderPulseSummaryV1({
    candidate,
    updatePreview: buildPulsePreview(baseSummary)
  });
  const threadStrip = buildThreadContextStripV1(stack);
  const normalizedSummary = baseSummary.trim();

  if (!normalizedSummary) {
    return `${pulseSummary}\n${threadStrip.summaryText}`;
  }

  return `${pulseSummary}\n${threadStrip.summaryText}\n\n${normalizedSummary}`;
}
