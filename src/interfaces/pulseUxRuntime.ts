/**
 * @fileoverview Renders final user-facing pulse text for live interface delivery paths.
 */

import {
  PulseReasonCodeV1,
  STAGE_6_86_PULSE_REASON_CODES
} from "../core/types";
import { ConversationSession } from "./sessionStore";

const FALLBACK_PULSE_MESSAGE = "Checking in.";

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
  void session;
  void observedAt;

  const reasonCode = extractPulseReasonCode(systemInput);
  if (!reasonCode) {
    return baseSummary;
  }
  return buildPulseMessage(baseSummary);
}
