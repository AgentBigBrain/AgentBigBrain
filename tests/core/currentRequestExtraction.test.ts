/**
 * @fileoverview Regression tests for shared active-request extraction helpers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  containsAgentPulseRequestMarker,
  extractActiveRequestSegment
} from "../../src/core/currentRequestExtraction";

test("extractActiveRequestSegment prefers the current user request marker", () => {
  const input = [
    "User question: old question",
    "Current user request: Please run diagnostics now."
  ].join("\n");

  assert.equal(extractActiveRequestSegment(input), "Please run diagnostics now.");
});

test("extractActiveRequestSegment falls back to follow-up answer marker", () => {
  const input = "User follow-up answer: Yes, use the safer option.";
  assert.equal(extractActiveRequestSegment(input), "Yes, use the safer option.");
});

test("extractActiveRequestSegment bounds pulse requests before historical context", () => {
  const input = [
    "Agent Pulse request: Check if I still need to follow up with Alex.",
    "Recent conversation context (oldest to newest):",
    "User: unrelated old text"
  ].join("\n");

  assert.equal(
    extractActiveRequestSegment(input),
    "Check if I still need to follow up with Alex."
  );
});

test("extractActiveRequestSegment returns trimmed raw input when no markers are present", () => {
  assert.equal(
    extractActiveRequestSegment("   just a direct request   "),
    "just a direct request"
  );
});

test("containsAgentPulseRequestMarker detects pulse marker presence", () => {
  assert.equal(
    containsAgentPulseRequestMarker("Agent Pulse request: quick check-in"),
    true
  );
  assert.equal(
    containsAgentPulseRequestMarker("No pulse marker here"),
    false
  );
});
