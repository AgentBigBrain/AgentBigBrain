/**
 * @fileoverview Canonical user-facing language normalization helpers.
 */

const LABEL_STYLE_OPENING_PATTERNS: readonly RegExp[] = [
  /^(?:ai\s+assistant|assistant)\s+(?:response|reply|answer|check[- ]?in|message)\s*:\s*/i,
  /^(?:personal\s+ai\s+assistant)\s+(?:response|reply|answer|check[- ]?in|message)\s*:\s*/i,
  /^(?:ai\s+assistant|assistant)\s+here\s*[-:,\u2013\u2014]\s*/i,
  /^(?:i['’]?m|i\s+am)\s+(?:your\s+)?ai\s+assistant\b[,\s\-:\u2013\u2014]*(?:and\s+)?/i,
  /^(?:hey|hi|hello)\b[^.!?\n]{0,80}[-,\s\u2013\u2014]+(?:i['’]?m|i\s+am)\s+(?:your\s+)?ai\s+assistant\b[,\s\-:\u2013\u2014]*(?:and\s+)?/i
];

/**
 * Uppercases the first ASCII letter in a stripped opening so the remaining sentence still reads
 * naturally after removing robotic identity scaffolding.
 *
 * @param value - Summary text after opening-stripping.
 * @returns Summary with the first leading ASCII letter uppercased when applicable.
 */
function uppercaseLeadingLetter(value: string): string {
  return value.replace(/^[a-z]/, (letter) => letter.toUpperCase());
}

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
  let strippedAnyPrefix = false;

  while (changed) {
    changed = false;
    for (const pattern of LABEL_STYLE_OPENING_PATTERNS) {
      const stripped = normalized.replace(pattern, "");
      if (stripped !== normalized) {
        normalized = stripped.trimStart();
        strippedAnyPrefix = true;
        changed = true;
      }
    }
  }

  if (strippedAnyPrefix) {
    normalized = uppercaseLeadingLetter(normalized);
  }

  return normalized || summary;
}
