/**
 * @fileoverview Covers canonical user-facing language normalization helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  normalizeOrdinaryMemoryAnswerSurface,
  stripLabelStyleOpening
} from "../../src/interfaces/userFacing/languageSurface";

test("stripLabelStyleOpening removes plain AI assistant prefixes", () => {
  assert.equal(
    stripLabelStyleOpening("AI assistant: Got it - I'm closing that landing page now."),
    "Got it - I'm closing that landing page now."
  );
});

test("stripLabelStyleOpening removes AI assistant summary prefixes even when prefaced by a filler phrase", () => {
  assert.equal(
    stripLabelStyleOpening(
      "Absolutely - AI assistant summary of what was changed: Updated index.html and styles.css."
    ),
    "Updated index.html and styles.css."
  );
});

test("stripLabelStyleOpening normalizes lingering third-person assistant self-reference", () => {
  assert.equal(
    stripLabelStyleOpening(
      "If you want, AI assistant can next give you a line-by-line breakdown."
    ),
    "If you want, I can next give you a line-by-line breakdown."
  );
});

test("stripLabelStyleOpening removes filler plus AI assistant identity openings", () => {
  assert.equal(
    stripLabelStyleOpening(
      "Got it - I'm an AI assistant, and I'm closing that landing page window now so we can move on."
    ),
    "I'm closing that landing page window now so we can move on."
  );
});

test("stripLabelStyleOpening removes direct AI assistant verb openings", () => {
  assert.equal(
    stripLabelStyleOpening(
      "AI assistant is closing the landing page window now so we can work on something else."
    ),
    "Closing the landing page window now so we can work on something else."
  );
});

test("stripLabelStyleOpening rewrites tell AI assistant follow-up phrasing", () => {
  assert.equal(
    stripLabelStyleOpening(
      "AI assistant is closing the landing page window now so we can work on something else. Tell AI assistant what you want to do next."
    ),
    "Closing the landing page window now so we can work on something else. Tell me what you want to do next."
  );
});

test("stripLabelStyleOpening rewrites filler plus third-person AI assistant completion phrasing", () => {
  assert.equal(
    stripLabelStyleOpening(
      "Done - this AI assistant has closed that landing page window. You can tell me what you want to work on next."
    ),
    "Done - I have closed that landing page window. You can tell me what you want to work on next."
  );
});

test("stripLabelStyleOpening rewrites third-person BigBrain self-reference into first person", () => {
  assert.equal(
    stripLabelStyleOpening(
      "If you want, BigBrain can turn that plan into a section-by-section outline next."
    ),
    "If you want, I can turn that plan into a section-by-section outline next."
  );
});

test("stripLabelStyleOpening rewrites tell-BigBrain follow-up phrasing", () => {
  assert.equal(
    stripLabelStyleOpening(
      "BigBrain is ready with the next draft. You can tell BigBrain what you want to refine next."
    ),
    "Ready with the next draft. You can tell me what you want to refine next."
  );
});

test("normalizeOrdinaryMemoryAnswerSurface rewrites split-view labels into natural prose", () => {
  assert.equal(
    normalizeOrdinaryMemoryAnswerSurface(
      "Current State: Milo is your coworker at Northstar Creative. Historical Context: You first mentioned him while talking about a client meeting. Contradiction Notes: none."
    ),
    "Milo is your coworker at Northstar Creative. Previously, you first mentioned him while talking about a client meeting."
  );
});

test("normalizeOrdinaryMemoryAnswerSurface turns contradiction notes into a brief clarifier", () => {
  assert.equal(
    normalizeOrdinaryMemoryAnswerSurface(
      "- Current State: none\n- Historical Context: none\n- Contradiction Notes: You've mentioned both Lantern Studio and Northstar Creative for Milo.\n- Supporting Evidence: you brought him up in two different work threads."
    ),
    "There's some ambiguity here: you've mentioned both Lantern Studio and Northstar Creative for Milo. From what you've told me, you brought him up in two different work threads."
  );
});

test("normalizeOrdinaryMemoryAnswerSurface rewrites internal diagnostic phrasing without labels", () => {
  assert.equal(
    normalizeOrdinaryMemoryAnswerSurface(
      "I have Milo tied most strongly to Northstar Creative from supporting evidence in this chat."
    ),
    "I mainly know Milo in connection with Northstar Creative from what you've told me in this chat."
  );
});
