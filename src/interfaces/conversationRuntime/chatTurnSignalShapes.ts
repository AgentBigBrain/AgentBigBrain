/**
 * @fileoverview Shared bounded token-shape helpers for short-turn signal analysis.
 */

import { IDENTITY_RECALL_ASSERTION_TERMS } from "./chatTurnSignalLexicon";

/**
 * Returns whether any raw or meaningful token matches one of the provided cue terms.
 *
 * @param rawTokens - Surface token sequence.
 * @param meaningfulTerms - Stop-word filtered content terms.
 * @param cues - Candidate cue term set.
 * @returns `true` when any cue is present.
 */
function hasCue(
  rawTokens: readonly string[],
  meaningfulTerms: readonly string[],
  cues: ReadonlySet<string>
): boolean {
  return (
    rawTokens.some((token) => cues.has(token)) ||
    meaningfulTerms.some((term) => cues.has(term))
  );
}

/**
 * Returns whether one bounded token sequence appears contiguously inside the raw token list.
 *
 * @param rawTokens - Surface token sequence for the current turn.
 * @param sequence - Candidate normalized token sequence that must appear contiguously.
 * @returns `true` when the sequence appears contiguously.
 */
export function hasTokenSequence(
  rawTokens: readonly string[],
  sequence: readonly string[]
): boolean {
  if (sequence.length === 0 || sequence.length > rawTokens.length) {
    return false;
  }
  for (let index = 0; index <= rawTokens.length - sequence.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (rawTokens[index + offset] !== sequence[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return true;
    }
  }
  return false;
}

/**
 * Returns whether the turn has an explicit, low-ambiguity self-identity declaration shape.
 *
 * @param rawTokens - Surface token sequence for the current turn.
 * @returns `true` when the wording has a narrow explicit declaration shape.
 */
export function hasExplicitSelfIdentityDeclarationShape(
  rawTokens: readonly string[]
): boolean {
  return (
    hasTokenSequence(rawTokens, ["my", "name", "is"]) ||
    hasTokenSequence(rawTokens, ["call", "me"]) ||
    hasTokenSequence(rawTokens, ["i", "go", "by"]) ||
    rawTokens[0] === "i'm" ||
    hasTokenSequence(rawTokens, ["i", "am"])
  );
}

/**
 * Returns whether the turn looks like a direct self-identity recall assertion.
 *
 * @param rawTokens - Surface token sequence for the current turn.
 * @param meaningfulTerms - Stop-word filtered content terms.
 * @param referencesSelf - Whether the turn contains first-person self reference.
 * @param referencesAssistant - Whether the turn contains second-person assistant reference.
 * @param containsNameConcept - Whether the turn mentions naming/identity concepts.
 * @param referencesArtifact - Whether the turn mentions file/browser/path artifacts.
 * @param containsWorkflowCue - Whether the turn contains workflow/action cues.
 * @param containsStatusCue - Whether the turn contains status/recall cues.
 * @returns `true` when the wording is a bounded self-identity recall assertion.
 */
export function hasSelfIdentityRecallAssertionShape(
  rawTokens: readonly string[],
  meaningfulTerms: readonly string[],
  referencesSelf: boolean,
  referencesAssistant: boolean,
  containsNameConcept: boolean,
  referencesArtifact: boolean,
  containsWorkflowCue: boolean,
  containsStatusCue: boolean
): boolean {
  if (
    !referencesSelf ||
    !referencesAssistant ||
    !containsNameConcept ||
    referencesArtifact ||
    containsWorkflowCue ||
    containsStatusCue
  ) {
    return false;
  }
  return hasCue(rawTokens, meaningfulTerms, IDENTITY_RECALL_ASSERTION_TERMS);
}

/**
 * Returns whether the turn has a narrow direct self-identity question shape such as `Who am I?`
 * or `Do you know who I am?`.
 *
 * @param rawTokens - Surface token sequence for the current turn.
 * @param referencesSelf - Whether the turn contains first-person self reference.
 * @param referencesAssistant - Whether the turn contains second-person assistant reference.
 * @param containsNameConcept - Whether the turn mentions naming/identity concepts.
 * @param referencesArtifact - Whether the turn mentions file/browser/path artifacts.
 * @param containsWorkflowCue - Whether the turn contains workflow/action cues.
 * @param containsStatusCue - Whether the turn contains status/recall cues.
 * @returns `true` when the wording is a narrow self-identity recall question.
 */
export function hasDirectSelfIdentityQuestionShape(
  rawTokens: readonly string[],
  referencesSelf: boolean,
  referencesAssistant: boolean,
  containsNameConcept: boolean,
  referencesArtifact: boolean,
  containsWorkflowCue: boolean,
  containsStatusCue: boolean
): boolean {
  if (
    referencesArtifact ||
    containsWorkflowCue ||
    containsStatusCue ||
    !referencesSelf
  ) {
    return false;
  }
  return (
    hasTokenSequence(rawTokens, ["who", "am", "i"]) ||
    hasTokenSequence(rawTokens, ["who", "i", "am"]) ||
    hasTokenSequence(rawTokens, ["do", "you", "know", "who", "i", "am"]) ||
    (referencesAssistant &&
      containsNameConcept &&
      (
        hasTokenSequence(rawTokens, ["what", "is", "my", "name"]) ||
        hasTokenSequence(rawTokens, ["tell", "me", "my", "name"]) ||
        hasTokenSequence(rawTokens, ["do", "you", "know", "my", "name"])
      ))
  );
}

/**
 * Returns whether the turn is a conversational meta-question about prior assistant wording rather
 * than a direct request to recall the user's identity.
 *
 * @param rawTokens - Surface token sequence for the current turn.
 * @param referencesSelf - Whether the turn contains first-person self reference.
 * @param referencesAssistant - Whether the turn contains second-person assistant reference.
 * @param containsNameConcept - Whether the turn mentions naming/identity concepts.
 * @returns `true` when the wording is asking about prior assistant name-related wording.
 */
export function hasSelfIdentityMetaQuestionShape(
  rawTokens: readonly string[],
  referencesSelf: boolean,
  referencesAssistant: boolean,
  containsNameConcept: boolean
): boolean {
  if (!referencesSelf || !referencesAssistant || !containsNameConcept) {
    return false;
  }
  return (
    (rawTokens.includes("why") &&
      rawTokens.includes("say") &&
      (
        rawTokens.includes("said") ||
        rawTokens.includes("have") ||
        rawTokens.includes("didn't") ||
        rawTokens.includes("didnt")
      )) ||
    hasTokenSequence(rawTokens, ["why", "did", "you", "say"]) ||
    hasTokenSequence(rawTokens, ["why", "didn't", "you"]) ||
    hasTokenSequence(rawTokens, ["why", "didnt", "you"])
  );
}

/**
 * Returns whether the turn uses callback-style wording that should stay on the workflow path.
 *
 * @param rawTokens - Surface token sequence for the current turn.
 * @param containsWorkflowCue - Whether workflow/action cues were already detected.
 * @param containsStatusCue - Whether status/progress cues were already detected.
 * @param referencesArtifact - Whether explicit artifact/browser/path cues were already detected.
 * @returns `true` when the turn is a bounded workflow callback request.
 */
export function hasWorkflowCallbackRequestShape(
  rawTokens: readonly string[],
  containsWorkflowCue: boolean,
  containsStatusCue: boolean,
  referencesArtifact: boolean
): boolean {
  if (!hasTokenSequence(rawTokens, ["call", "me", "when"])) {
    return false;
  }
  return containsWorkflowCue || containsStatusCue || referencesArtifact;
}
