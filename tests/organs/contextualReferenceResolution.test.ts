/**
 * @fileoverview Covers route-gated contextual reference hint expansion.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveContextualReferenceHints } from "../../src/organs/languageUnderstanding/contextualReferenceResolution";

const recentTurns = [
  {
    role: "user" as const,
    text: "Jordan mentioned the fictional Northstar Studio launch review.",
    at: "2026-04-26T12:00:00.000Z"
  }
];

test("resolveContextualReferenceHints keeps fallback context closed without route-approved memory intent", () => {
  const resolution = resolveContextualReferenceHints({
    userInput: "What happened with that?",
    recentTurns,
    threads: [],
    memoryIntent: "none"
  });

  assert.equal(resolution.hasRecallCue, false);
  assert.equal(resolution.usedFallbackContext, false);
  assert.deepEqual(resolution.evidence, ["direct_terms"]);
});

test("resolveContextualReferenceHints expands context after route-approved recall intent", () => {
  const resolution = resolveContextualReferenceHints({
    userInput: "What happened with that?",
    recentTurns,
    threads: [],
    memoryIntent: "contextual_recall"
  });

  assert.equal(resolution.hasRecallCue, true);
  assert.equal(resolution.usedFallbackContext, true);
  assert.ok(resolution.evidence.includes("recent_turn_context"));
});
