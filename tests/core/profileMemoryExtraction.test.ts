/**
 * @fileoverview Focused tests for canonical profile-memory extraction helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { extractProfileFactCandidatesFromUserInput } from "../../src/core/profileMemoryRuntime/profileMemoryExtraction";

test("canonical extraction helper captures preferred-name and employment facts", () => {
  const candidates = extractProfileFactCandidatesFromUserInput(
    "My name is Benny and I work at Flare.",
    "task_profile_extract_runtime",
    "2026-03-07T12:00:00.000Z"
  );

  assert.equal(
    candidates.some(
      (candidate) =>
        candidate.key === "identity.preferred_name" && candidate.value === "Benny"
    ),
    true
  );
  assert.equal(
    candidates.some(
      (candidate) =>
        candidate.key === "employment.current" && candidate.value === "Flare"
    ),
    true
  );
});

test("canonical extraction helper emits resolved follow-up markers from suppression phrasing", () => {
  const candidates = extractProfileFactCandidatesFromUserInput(
    "Turn off notifications for the vet.",
    "task_profile_extract_followup",
    "2026-03-07T12:00:00.000Z"
  );

  assert.equal(
    candidates.some(
      (candidate) =>
        candidate.key === "followup.vet" && candidate.value === "resolved"
    ),
    true
  );
});
