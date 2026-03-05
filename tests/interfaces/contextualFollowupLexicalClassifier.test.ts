/**
 * @fileoverview Tests deterministic contextual follow-up lexical cue detection, candidate-token extraction, and fail-closed conflict handling.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyContextualFollowupLexicalCue } from "../../src/interfaces/contextualFollowupLexicalClassifier";

test("classifyContextualFollowupLexicalCue returns no-cue metadata for unrelated text", () => {
  const result = classifyContextualFollowupLexicalCue("I prefer to keep this note for now.");

  assert.equal(result.cueDetected, false);
  assert.equal(result.conflict, false);
  assert.equal(result.matchedRuleId, "contextual_followup_lexical_v1_no_cue");
  assert.deepEqual(result.candidateTokens, []);
});

test("classifyContextualFollowupLexicalCue extracts bounded candidate tokens and confidence for positive cue text", () => {
  const result = classifyContextualFollowupLexicalCue(
    "remind me later about alpha beta gamma issue after lunch"
  );

  assert.equal(result.cueDetected, true);
  assert.equal(result.conflict, false);
  assert.equal(result.matchedRuleId, "contextual_followup_lexical_v1_cue_with_candidate_tokens");
  assert.equal(result.candidateTokens.includes("alpha"), true);
  assert.equal(result.candidateTokens.includes("beta"), true);
  assert.equal(result.candidateTokens.includes("gamma"), true);
  assert.equal(result.confidence > 0.55, true);
});

test("classifyContextualFollowupLexicalCue fails closed on conflicting positive and negative cues", () => {
  const result = classifyContextualFollowupLexicalCue(
    "follow up on tax filing but do not follow up with reminders"
  );

  assert.equal(result.cueDetected, false);
  assert.equal(result.conflict, true);
  assert.equal(
    result.matchedRuleId,
    "contextual_followup_lexical_v1_conflicting_positive_negative_cue"
  );
  assert.deepEqual(result.candidateTokens, []);
});

test("classifyContextualFollowupLexicalCue fails closed when cue has no candidate tokens", () => {
  const result = classifyContextualFollowupLexicalCue("follow up and check in later");

  assert.equal(result.cueDetected, true);
  assert.equal(result.conflict, true);
  assert.equal(result.matchedRuleId, "contextual_followup_lexical_v1_cue_without_candidate_tokens");
  assert.deepEqual(result.candidateTokens, []);
});
