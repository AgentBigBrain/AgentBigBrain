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
const ORDINARY_MEMORY_ANSWER_SECTION_PATTERN =
  /(?:^|[\s\r\n])(?:[-*]\s*)?(Current State|Historical Context|Contradiction Notes|Supporting Evidence)\s*:\s*/gi;
const EMPTY_MEMORY_ANSWER_SECTION_PATTERN =
  /^(?:none|none\.|n\/a|not available|unknown|no current state|no historical context|no contradiction notes?)$/i;
const CLAUSE_LEADING_LOWERCASE_PATTERN =
  /^(?:You|You've|You'd|You were|You are|The|This|That|There|It)\b/;

interface OrdinaryMemoryAnswerSections {
  intro: string | null;
  currentState: string | null;
  historicalContext: string | null;
  contradictionNotes: string | null;
  supportingEvidence: string | null;
}

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
 * Lowercases leading helper words when one clause is being prefixed into a larger sentence.
 *
 * @param value - Clause text being prefixed with conversational scaffolding.
 * @returns Clause with a lowercased leading helper word when that reads more naturally.
 */
function lowercaseLeadingClauseWord(value: string): string {
  if (!CLAUSE_LEADING_LOWERCASE_PATTERN.test(value)) {
    return value;
  }
  return value.replace(/^[A-Z]/, (letter) => letter.toLowerCase());
}

/**
 * Ensures one natural-language fragment ends with terminal punctuation before sentence joining.
 *
 * @param value - Fragment being emitted into the final ordinary-chat reply.
 * @returns Fragment with terminal punctuation when needed.
 */
function ensureTerminalPunctuation(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

/**
 * Rewrites internal diagnostic phrases into ordinary conversational wording.
 *
 * @param value - One final user-facing clause or sentence fragment.
 * @returns Fragment with internal memory diagnostics converted into natural phrasing.
 */
function normalizeMemoryDiagnosticPhrasing(value: string): string {
  return value
    .replace(/\bresolved_current\b/gi, "current")
    .replace(/\bfrom supporting evidence\b/gi, "from what you've told me")
    .replace(/\bSupporting evidence\s+(?:shows|suggests|says)\b/gi, "From what you've told me")
    .replace(/\bSupporting evidence\b\s*:?\s*/gi, "From what you've told me, ")
    .replace(
      /\bI have\s+(.+?)\s+tied most strongly to\s+(.+?)([.!?]|$)/gi,
      (_match, subject: string, relation: string, punctuation: string) =>
        `I mainly know ${subject.trim()} in connection with ${relation.trim()}${punctuation || "."}`
    );
}

/**
 * Canonicalizes one parsed memory-answer section so only meaningful content survives composition.
 *
 * @param value - Raw section text between two structured answer labels.
 * @returns Clean section content, or `null` when the section is effectively empty.
 */
function normalizeMemoryAnswerSectionValue(value: string): string | null {
  const normalized = normalizeMemoryDiagnosticPhrasing(
    value
      .replace(/(?:^|\n)\s*[-*]\s+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[\s:;,\-]+/, "")
      .trim()
  );
  return normalized.length === 0 || EMPTY_MEMORY_ANSWER_SECTION_PATTERN.test(normalized)
    ? null
    : normalized;
}

/**
 * Parses structured split-view memory answer labels out of one model-authored reply candidate.
 *
 * @param summary - Final user-facing summary candidate.
 * @returns Parsed ordinary-chat sections, or `null` when no structured memory labels are present.
 */
function parseOrdinaryMemoryAnswerSections(summary: string): OrdinaryMemoryAnswerSections | null {
  const matches = [...summary.matchAll(ORDINARY_MEMORY_ANSWER_SECTION_PATTERN)];
  if (matches.length === 0) {
    return null;
  }

  const sections: OrdinaryMemoryAnswerSections = {
    intro: normalizeMemoryAnswerSectionValue(summary.slice(0, matches[0]!.index ?? 0)),
    currentState: null,
    historicalContext: null,
    contradictionNotes: null,
    supportingEvidence: null
  };

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const label = match[1]!.toLowerCase();
    const valueStart = (match.index ?? 0) + match[0].length;
    const valueEnd = index + 1 < matches.length
      ? (matches[index + 1]!.index ?? summary.length)
      : summary.length;
    const normalizedValue = normalizeMemoryAnswerSectionValue(
      summary.slice(valueStart, valueEnd)
    );
    if (label === "current state") {
      sections.currentState = normalizedValue;
    } else if (label === "historical context") {
      sections.historicalContext = normalizedValue;
    } else if (label === "contradiction notes") {
      sections.contradictionNotes = normalizedValue;
    } else if (label === "supporting evidence") {
      sections.supportingEvidence = normalizedValue;
    }
  }

  return sections;
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

/**
 * Rewrites structured memory-panel answers into natural prose on ordinary conversational surfaces.
 *
 * Ordinary chat should not expose internal split-view labels such as `Current State:` or
 * `Historical Context:` even if a lower layer returns them verbatim.
 *
 * @param summary - Final user-facing summary candidate.
 * @returns Natural-language ordinary-chat answer surface.
 */
export function normalizeOrdinaryMemoryAnswerSurface(summary: string): string {
  const parsedSections = parseOrdinaryMemoryAnswerSections(summary);
  if (!parsedSections) {
    return normalizeMemoryDiagnosticPhrasing(summary);
  }

  const sentences: string[] = [];
  if (parsedSections.intro) {
    sentences.push(ensureTerminalPunctuation(parsedSections.intro));
  }
  if (parsedSections.currentState) {
    sentences.push(ensureTerminalPunctuation(parsedSections.currentState));
  }
  if (parsedSections.historicalContext) {
    const historicalClause = lowercaseLeadingClauseWord(parsedSections.historicalContext);
    sentences.push(
      ensureTerminalPunctuation(
        /^(?:Previously|Earlier|Before that|In the past)\b/i.test(parsedSections.historicalContext)
          ? parsedSections.historicalContext
          : `Previously, ${historicalClause}`
      )
    );
  }
  if (parsedSections.contradictionNotes) {
    const contradictionClause = lowercaseLeadingClauseWord(parsedSections.contradictionNotes);
    sentences.push(
      ensureTerminalPunctuation(
        /^(?:I(?:'|’)m not fully sure|I(?:'|’)m not certain|There(?:'|’)s some ambiguity here)\b/i.test(parsedSections.contradictionNotes)
          ? parsedSections.contradictionNotes
          : `There's some ambiguity here: ${contradictionClause}`
      )
    );
  }
  if (parsedSections.supportingEvidence) {
    const evidenceClause = lowercaseLeadingClauseWord(parsedSections.supportingEvidence);
    sentences.push(
      ensureTerminalPunctuation(
        /^(?:From what you(?:'|’)ve told me|Based on what you(?:'|’)ve told me)\b/i.test(parsedSections.supportingEvidence)
          ? parsedSections.supportingEvidence
          : `From what you've told me, ${evidenceClause}`
      )
    );
  }

  if (sentences.length === 0) {
    return "I don't have enough confirmed memory to answer that yet.";
  }

  return sentences.join(" ");
}
