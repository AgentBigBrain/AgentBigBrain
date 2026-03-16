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
  const blockedSuffix = primaryCode
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
