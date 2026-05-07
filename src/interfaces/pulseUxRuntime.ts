/**
 * @fileoverview Renders final user-facing pulse text for live interface delivery paths.
 */

import {
  PulseReasonCodeV1,
  STAGE_6_86_PULSE_REASON_CODES
} from "../core/types";
import type {
  PulseDeliveryEnvelopeV1,
  PulseEmissionRecordV1
} from "../core/stage6_86PulseCandidates";
import { ConversationSession } from "./sessionStore";

const FALLBACK_PULSE_MESSAGE = "Checking in.";
const BLOCKED_PULSE_SUMMARY_PATTERNS = [
  /^I couldn't execute that request in this run\./i,
  /\bWhat happened:\s*governance blocked the requested action\b/i,
  /\bWhat happened:\s*one or more governed actions were blocked before execution\b/i,
  /(?:^|\n)\s*-\s*State:\s*blocked\b/i,
  /\bTechnical reason code:\s*COMMUNICATION_NO_SIDE_EFFECT_EXECUTED\b/i
] as const;

export type PulseUxMetadataSourceV1 = "typed_delivery_metadata" | "legacy_prompt_text";

export interface ResolvedPulseUxMetadataV1 {
  reasonCode: PulseReasonCodeV1;
  source: PulseUxMetadataSourceV1;
  pulseId?: string;
  candidateId?: string;
  deliveryDecisionId?: string;
}

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
 * Normalizes a final pulse summary into one user-facing message body.
 *
 * **Why it exists:**
 * Live pulse delivery should show only the final message body to the user, not internal
 * continuity envelopes or thread diagnostics.
 *
 * **What it talks to:**
 * - Uses local whitespace normalization only.
 *
 * @param baseSummary - User-facing summary returned from governed task execution.
 * @returns Final single-message user-facing pulse text.
 */
function buildPulseMessage(baseSummary: string): string {
  const normalized = baseSummary.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return FALLBACK_PULSE_MESSAGE;
  }
  return normalized;
}

/**
 * Returns whether a typed pulse envelope is valid for user-facing rendering decisions.
 *
 * **Why it exists:**
 * Typed delivery metadata must still prove deterministic permission before UX rendering treats it
 * as the pulse source.
 *
 * **What it talks to:**
 * - Uses Stage 6.86 reason-code validation from this module.
 *
 * @param value - Candidate delivery envelope from recent pulse history.
 * @returns `true` when the envelope is allowed, user-visible, and reason-code valid.
 */
function isUsablePulseDeliveryEnvelope(
  value: PulseDeliveryEnvelopeV1 | undefined
): value is PulseDeliveryEnvelopeV1 {
  return Boolean(
    value &&
      value.allowedByPolicy === true &&
      value.userVisibleDeliveryAllowed === true &&
      isPulseReasonCodeV1(value.reasonCode)
  );
}

/**
 * Finds the newest usable typed pulse envelope available at one observation time.
 *
 * **Why it exists:**
 * Rendering should prefer structured session metadata while avoiding records emitted after the
 * current delivery observation.
 *
 * **What it talks to:**
 * - Reads bounded `session.agentPulse.recentEmissions` metadata.
 * - Calls `isEmissionAtOrBefore` and `isUsablePulseDeliveryEnvelope` for deterministic filtering.
 *
 * @param session - Session that owns recent pulse emission history.
 * @param observedAt - Timestamp for the current delivery event.
 * @returns Latest usable typed delivery envelope, or `null`.
 */
function getTypedPulseDeliveryEnvelope(
  session: ConversationSession,
  observedAt: string
): PulseDeliveryEnvelopeV1 | null {
  const observedMs = Date.parse(observedAt);
  const emissions = session.agentPulse.recentEmissions ?? [];
  for (const emission of [...emissions].reverse()) {
    if (!isEmissionAtOrBefore(emission, observedMs)) {
      continue;
    }
    if (isUsablePulseDeliveryEnvelope(emission.deliveryEnvelope)) {
      return emission.deliveryEnvelope;
    }
  }
  return null;
}

/**
 * Returns whether an emission is eligible for one delivery observation timestamp.
 *
 * **Why it exists:**
 * Session history can contain several pulse records; UX rendering should not consume future
 * envelopes when replaying older job output.
 *
 * **What it talks to:**
 * - Uses only deterministic timestamp parsing.
 *
 * @param emission - Recent pulse emission candidate.
 * @param observedMs - Millisecond timestamp for the current delivery observation.
 * @returns `true` when the emission can be considered for the observation.
 */
function isEmissionAtOrBefore(
  emission: PulseEmissionRecordV1,
  observedMs: number
): boolean {
  if (!Number.isFinite(observedMs)) {
    return true;
  }
  const emittedMs = Date.parse(emission.emittedAt);
  return !Number.isFinite(emittedMs) || emittedMs <= observedMs;
}

/**
 * Resolves pulse UX metadata from typed delivery state first, with prompt text as legacy fallback.
 *
 * **Why it exists:**
 * Dynamic pulse delivery now has a structured envelope. User-facing rendering should not depend on
 * extracting authority-bearing details from system prompt text when typed metadata is available.
 *
 * **What it talks to:**
 * - Reads `session.agentPulse.recentEmissions` for typed delivery envelopes.
 * - Falls back to local legacy prompt-text parsing for older persisted pulse jobs.
 *
 * @param session - Session that may contain recent typed pulse delivery metadata.
 * @param systemInput - Internal system prompt used only as legacy compatibility fallback.
 * @param observedAt - Timestamp used to avoid consuming future emission records.
 * @returns Resolved pulse metadata, or `null` when the job is not a supported pulse.
 */
export function resolvePulseUxMetadataV1(
  session: ConversationSession,
  systemInput: string,
  observedAt: string
): ResolvedPulseUxMetadataV1 | null {
  const envelope = getTypedPulseDeliveryEnvelope(session, observedAt);
  if (envelope) {
    return {
      reasonCode: envelope.reasonCode,
      source: "typed_delivery_metadata",
      pulseId: envelope.pulseId,
      candidateId: envelope.candidateId,
      deliveryDecisionId: envelope.deliveryDecisionId
    };
  }

  const legacyReasonCode = extractPulseReasonCode(systemInput);
  return legacyReasonCode
    ? {
        reasonCode: legacyReasonCode,
        source: "legacy_prompt_text"
      }
    : null;
}

/**
 * Returns whether a pulse summary should be suppressed from user delivery.
 *
 * **Why it exists:**
 * Agent Pulse is proactive background work. If governance blocks the pulse itself, leaking that
 * internal failure into the chat looks like an unsolicited assistant reply rather than a
 * user-requested outcome.
 *
 * **What it talks to:**
 * - Uses local Stage 6.86 reason-code extraction helpers within this module.
 * - Uses local blocked-summary pattern constants within this module.
 *
 * @param systemInput - Internal system prompt text queued for pulse execution.
 * @param baseSummary - Candidate user-facing summary returned from governed execution.
 * @returns `true` when the pulse result should stay internal instead of being delivered to the user.
 */
export function shouldSuppressPulseUserFacingDeliveryV1(
  systemInput: string,
  baseSummary: string,
  session?: ConversationSession,
  observedAt = new Date().toISOString()
): boolean {
  const metadata = session
    ? resolvePulseUxMetadataV1(session, systemInput, observedAt)
    : extractPulseReasonCode(systemInput);
  if (!metadata) {
    return false;
  }
  const normalized = baseSummary.trim();
  if (!normalized) {
    return true;
  }
  return BLOCKED_PULSE_SUMMARY_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Builds deterministic final pulse text for live user delivery.
 *
 * **Why it exists:**
 * Production pulse delivery should show users only the final natural-language message body.
 * Internal Stage 6.86 reason-code envelopes remain diagnostic, not user-visible.
 *
 * **What it talks to:**
 * - Uses local reason-code extraction to confirm this is a Stage 6.86 pulse prompt.
 *
 * @param session - Session context tied to the pulse job. Retained as part of the stable
 * live-delivery signature even though user-facing rendering no longer uses session metadata.
 * @param systemInput - Internal pulse prompt text used to detect Stage 6.86 reason code.
 * @param baseSummary - Existing user-facing summary from governed execution.
 * @param observedAt - Timestamp retained as part of the stable live-delivery signature.
 * @returns Final user-visible pulse message with internal scaffolding removed.
 */
export function renderPulseUserFacingSummaryV1(
  session: ConversationSession,
  systemInput: string,
  baseSummary: string,
  observedAt: string
): string {
  const metadata = resolvePulseUxMetadataV1(session, systemInput, observedAt);
  if (!metadata) {
    return baseSummary;
  }
  return buildPulseMessage(baseSummary);
}
