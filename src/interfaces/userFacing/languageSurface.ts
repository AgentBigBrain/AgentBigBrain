/**
 * @fileoverview Canonical user-facing language normalization helpers.
 */

const LABEL_STYLE_OPENING_PATTERNS: readonly RegExp[] = [
  /^(?:ai\s+assistant|assistant)\s+(?:response|reply|check[- ]?in|message)\s*:\s*/i,
  /^(?:personal\s+ai\s+assistant)\s+(?:response|reply|check[- ]?in|message)\s*:\s*/i
];

/**
 * Removes robotic label-style openings from model-authored user-facing text.
 *
 * This keeps the final delivery natural even if the model ignores prompt instructions and prefixes
 * replies with headers such as `AI assistant response:`.
 *
 * @param summary - Final user-facing summary candidate.
 * @returns Summary with any leading label-style prefix removed.
 */
export function stripLabelStyleOpening(summary: string): string {
  let normalized = summary.trimStart();
  let changed = true;

  while (changed) {
    changed = false;
    for (const pattern of LABEL_STYLE_OPENING_PATTERNS) {
      const stripped = normalized.replace(pattern, "");
      if (stripped !== normalized) {
        normalized = stripped.trimStart();
        changed = true;
      }
    }
  }

  return normalized || summary;
}
