/**
 * @fileoverview Partial-success rendering helpers for user-facing summaries.
 */

/**
 * Builds a truthful partial-success summary when real work succeeded but later steps were blocked.
 */
export function buildPartialExecutionBlockedSummary(
  successSummary: string,
  blockedMessage: string,
  policyCodes: readonly string[]
): string {
  if (
    /\bThese still stayed outside it:\b/i.test(successSummary) ||
    /\banother local process is still using the remaining folders\b/i.test(successSummary)
  ) {
    return successSummary;
  }
  const primaryCode = policyCodes[0]?.trim();
  const runtimeFailureDetail = extractRuntimeFailureDetail(blockedMessage);
  const blockedSuffix = runtimeFailureDetail
    ? primaryCode
      ? `One later runtime step failed (${primaryCode}): ${runtimeFailureDetail}`
      : `One later runtime step failed: ${runtimeFailureDetail}`
    : primaryCode
      ? `One later step was blocked (${primaryCode}), so I stopped after the work that already succeeded.`
      : "One later step was blocked, so I stopped after the work that already succeeded.";
  const blockedNextStepMatch = blockedMessage.match(/What to do next:\s*(.+)$/i);
  const blockedNextStep = blockedNextStepMatch?.[1]?.trim();
  if (blockedNextStep) {
    return `${successSummary}\n${blockedSuffix}\nNext: ${blockedNextStep}`;
  }
  return `${successSummary}\n${blockedSuffix}`;
}

/**
 * Returns `true` when a direct execution summary only proves inspection, not a stronger user-
 * visible change.
 */
export function isInspectionOnlyDirectExecutionOutcome(summary: string): boolean {
  return /^(?:done[.!-]?\s+)?i\s+(?:checked|read)\b/i.test(summary.trim());
}

/**
 * Extracts a concrete runtime failure detail from blocked-message wording when available.
 *
 * @param blockedMessage - Blocked-message explanation text.
 * @returns Runtime failure detail text, or `null` when no structured detail exists.
 */
function extractRuntimeFailureDetail(blockedMessage: string): string | null {
  const match = blockedMessage.match(
    /What happened:\s*a runtime execution step failed:\s*([\s\S]+?)\s+Why it didn't execute:/i
  );
  const detail = match?.[1]?.trim();
  return detail && detail.length > 0 ? detail : null;
}
