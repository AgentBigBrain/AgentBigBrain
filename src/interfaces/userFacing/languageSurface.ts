/**
 * @fileoverview Canonical user-facing language normalization helpers.
 */

const LABEL_STYLE_OPENING_PATTERNS: readonly RegExp[] = [
  /^(?:ai\s+assistant|assistant)\s+(?:response|reply|answer|check[- ]?in|message)\s*:\s*/i,
  /^(?:absolutely|sure|okay|alright|got\s+it|certainly)\b[^:\n]{0,40}[-,\s\u2013\u2014]+(?:ai\s+assistant|assistant)\s+(?:summary|response|reply|answer|message)(?:\s+of[^:]{0,80})?\s*:\s*/i,
  /^(?:personal\s+ai\s+assistant)\s+(?:response|reply|answer|check[- ]?in|message)\s*:\s*/i,
  /^(?:ai\s+assistant|assistant)\s*:\s*/i,
  /^(?:personal\s+ai\s+assistant)\s*:\s*/i,
  /^(?:bigbrain)\s*:\s*/i,
  /^(?:ai\s+assistant|assistant)\s+here\s*[-:,\u2013\u2014]\s*/i,
  /^(?:bigbrain)\s+here\s*[-:,\u2013\u2014]\s*/i,
  /^(?:ai\s+assistant|assistant)\s+(?:is|was|will|can|should|would|could|has|have|had)\b[\s\-:\u2013\u2014]*(?:to\s+)?/i,
  /^(?:bigbrain)\s+(?:is|was|will|can|should|would|could|has|have|had)\b[\s\-:\u2013\u2014]*(?:to\s+)?/i,
  /^(?:i['’]?m|i\s+am)\s+(?:(?:your|an)\s+)?ai\s+assistant\b[,\s\-:\u2013\u2014]*(?:and\s+)?/i,
  /^(?:absolutely|sure|okay|alright|got\s+it|certainly)\b(?:\s*[-,\u2013\u2014]\s*|\s+)(?:i['’]?m|i\s+am)\s+(?:(?:your|an)\s+)?ai\s+assistant\b[,\s\-:\u2013\u2014]*(?:and\s+)?/i,
  /^(?:hey|hi|hello)\b[^.!?\n]{0,80}[-,\s\u2013\u2014]+(?:i['’]?m|i\s+am)\s+(?:(?:your|an)\s+)?ai\s+assistant\b[,\s\-:\u2013\u2014]*(?:and\s+)?/i
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
 * Rewrites awkward third-person assistant self-references into first-person phrasing.
 *
 * @param value - Summary text after leading-prefix stripping.
 * @returns Summary with mechanical assistant self-references normalized.
 */
function normalizeAssistantSelfReference(value: string): string {
  return value
    .replace(/\byou can tell bigbrain\b/gi, "You can tell me")
    .replace(/\btell\s+bigbrain\b/gi, "Tell me")
    .replace(/\btell\s+(?:this|the|your)?\s*ai\s+assistant\b/gi, "Tell me")
    .replace(/\btell\s+(?:this|the|your)?\s*assistant\b/gi, "Tell me")
    .replace(/\bbigbrain\s+has\b/gi, "I have")
    .replace(/\bbigbrain\s+had\b/gi, "I had")
    .replace(/\bbigbrain\s+is\b/gi, "I am")
    .replace(/\bbigbrain\s+was\b/gi, "I was")
    .replace(/\bbigbrain\s+will\b/gi, "I will")
    .replace(/\bbigbrain\s+can\b/gi, "I can")
    .replace(/\bbigbrain\s+should\b/gi, "I should")
    .replace(/\bbigbrain\s+would\b/gi, "I would")
    .replace(/\bbigbrain\s+could\b/gi, "I could")
    .replace(/\b(?:this|the|your)?\s*ai\s+assistant\s+has\b/gi, "I have")
    .replace(/\b(?:this|the|your)?\s*assistant\s+has\b/gi, "I have")
    .replace(/\b(?:this|the|your)?\s*ai\s+assistant\s+is\b/gi, "I am")
    .replace(/\b(?:this|the|your)?\s*assistant\s+is\b/gi, "I am")
    .replace(/\b(?:this|the|your)?\s*ai\s+assistant\s+will\b/gi, "I will")
    .replace(/\b(?:this|the|your)?\s*assistant\s+will\b/gi, "I will")
    .replace(/\b(?:this|the|your)?\s*ai\s+assistant\s+can\b/gi, "I can")
    .replace(/\b(?:this|the|your)?\s*assistant\s+can\b/gi, "I can");
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

  normalized = normalizeAssistantSelfReference(normalized);

  return normalized || summary;
}
