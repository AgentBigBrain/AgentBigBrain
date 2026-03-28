/**
 * @fileoverview Focused tests for canonical profile-memory extraction helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildValidatedProfileFactCandidates,
  extractPreferredNameValuesFromUserInput,
  extractProfileFactCandidatesFromUserInput,
  validatePreferredNameCandidateValue
} from "../../src/core/profileMemoryRuntime/profileMemoryExtraction";

test("canonical extraction helper captures preferred-name and employment facts", () => {
  const candidates = extractProfileFactCandidatesFromUserInput(
    "My name is Benny and I work at Lantern.",
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
        candidate.key === "employment.current" && candidate.value === "Lantern"
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

test("canonical extraction helper does not treat workflow call-me phrasing as a preferred name", () => {
  const candidates = extractProfileFactCandidatesFromUserInput(
    "Call me when the deployment is done and run the workspace build.",
    "task_profile_extract_workflow_call_me",
    "2026-03-07T12:00:00.000Z"
  );

  assert.equal(
    candidates.some((candidate) => candidate.key === "identity.preferred_name"),
    false
  );
});

test("canonical extraction helper does not treat deploy shorthand callback phrasing as a preferred name", () => {
  const candidates = extractProfileFactCandidatesFromUserInput(
    "Call me when the deploy is done.",
    "task_profile_extract_workflow_call_me_deploy",
    "2026-03-07T12:00:00.000Z"
  );

  assert.equal(
    candidates.some((candidate) => candidate.key === "identity.preferred_name"),
    false
  );
});

test("canonical extraction helper still captures short preferred-name call-me phrasing", () => {
  const candidates = extractProfileFactCandidatesFromUserInput(
    "You can call me Benny.",
    "task_profile_extract_call_me_name",
    "2026-03-07T12:00:00.000Z"
  );

  assert.equal(
    candidates.some(
      (candidate) =>
        candidate.key === "identity.preferred_name" && candidate.value === "Benny"
    ),
    true
  );
});

test("preferred-name extraction helper trims conversational confirmation tails", () => {
  assert.deepEqual(
    extractPreferredNameValuesFromUserInput("My name is Avery, yes."),
    ["Avery"]
  );
});

test("preferred-name extraction helper keeps discourse-heavy self-identity sentences off the explicit fast path", () => {
  assert.deepEqual(
    extractPreferredNameValuesFromUserInput("I already told you my name is Avery several times."),
    []
  );
});

test("preferred-name extraction helper keeps mixed identity-recall plus browser control off the explicit fast path", () => {
  assert.deepEqual(
    extractPreferredNameValuesFromUserInput("what is my name and close the browser"),
    []
  );
});

test("validatePreferredNameCandidateValue accepts bounded model-assisted preferred-name candidates", () => {
  assert.equal(validatePreferredNameCandidateValue("Avery"), "Avery");
});

test("validatePreferredNameCandidateValue rejects discourse-heavy or path-like candidates", () => {
  assert.equal(validatePreferredNameCandidateValue("Avery several times"), null);
  assert.equal(validatePreferredNameCandidateValue("C:\\Users\\Avery"), null);
});

test("buildValidatedProfileFactCandidates converts validated identity candidates into canonical upserts", () => {
  assert.deepEqual(
    buildValidatedProfileFactCandidates(
      [
        {
          key: "identity.preferred_name",
          candidateValue: "Avery",
          source: "conversation.identity_interpretation",
          confidence: 0.95
        }
      ],
      "task_profile_validated_candidate",
      "2026-03-21T12:00:00.000Z"
    ),
    [
      {
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: false,
        sourceTaskId: "task_profile_validated_candidate",
        source: "conversation.identity_interpretation",
        observedAt: "2026-03-21T12:00:00.000Z",
        confidence: 0.95
      }
    ]
  );
});
