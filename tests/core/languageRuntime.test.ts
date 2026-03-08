/**
 * @fileoverview Focused tests for the shared deterministic language-runtime helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { countLanguageTermOverlap } from "../../src/core/languageRuntime/languageScoring";
import { resolveLanguageProfileId } from "../../src/core/languageRuntime/languageProfiles";
import {
  extractContextualRecallTerms,
  extractConversationTopicTerms,
  extractEpisodeLinkingTerms,
  extractEpisodePlanningQueryTerms,
  extractPlanningQueryTerms,
  extractSemanticConceptTerms
} from "../../src/core/languageRuntime/queryIntentTerms";

test("resolveLanguageProfileId falls back to the bounded default profile", () => {
  assert.equal(resolveLanguageProfileId(), "generic_en");
  assert.equal(resolveLanguageProfileId("generic_en"), "generic_en");
  assert.equal(resolveLanguageProfileId("generic_es"), "generic_es");
});

test("extractConversationTopicTerms removes generic chat scaffolding", () => {
  const terms = extractConversationTopicTerms(
    "BigBrain, let's go back to the release rollout topic tomorrow."
  );

  assert.deepEqual(terms, ["release", "rollout"]);
});

test("extractContextualRecallTerms preserves human situation anchors from natural phrasing", () => {
  const terms = extractContextualRecallTerms(
    "How did that whole thing with Billy at the hospital end up?"
  );

  assert.deepEqual(terms, ["whole", "billy", "hospital", "end"]);
});

test("planning and episode planning query terms stay bounded but domain-specific", () => {
  assert.deepEqual(
    extractPlanningQueryTerms("Who is Billy related to now?"),
    ["billy"]
  );
  assert.deepEqual(
    extractEpisodePlanningQueryTerms("How is Billy doing after the fall?"),
    ["billy", "doing", "after", "fall"]
  );
});

test("extractEpisodeLinkingTerms strips episode boilerplate while keeping meaningful links", () => {
  const terms = extractEpisodeLinkingTerms(
    "Billy fell down after the accident and that situation is still unresolved."
  );

  assert.deepEqual(terms, ["billy", "fell", "accident", "unresolved"]);
});

test("extractSemanticConceptTerms keeps longer reusable concepts and allows unicode words", () => {
  const terms = extractSemanticConceptTerms(
    "Always verify café deployment safeguards before release."
  );

  assert.deepEqual(terms, ["verify", "café", "deployment", "safeguards", "before", "release"]);
});

test("countLanguageTermOverlap counts exact deterministic overlap only", () => {
  assert.equal(
    countLanguageTermOverlap(["billy", "hospital", "resolved"], ["billy", "resolved", "later"]),
    2
  );
  assert.equal(countLanguageTermOverlap([], ["billy"]), 0);
});

test("spanish language profile keeps meaningful situation terms", () => {
  assert.deepEqual(
    extractContextualRecallTerms(
      "¿Cómo terminó todo eso con Billy en el hospital?",
      "generic_es"
    ),
    ["terminó", "todo", "billy", "hospital"]
  );
  assert.deepEqual(
    extractPlanningQueryTerms(
      "¿Quién está relacionado con Billy ahora?",
      "generic_es"
    ),
    ["está", "billy"]
  );
});
