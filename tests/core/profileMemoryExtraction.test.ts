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
import { hasConversationalProfileUpdateSignal } from "../../src/core/profileMemoryRuntime/profileMemoryConversationalSignals";
import { governProfileMemoryCandidates } from "../../src/core/profileMemoryRuntime/profileMemoryTruthGovernance";

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

test("canonical extraction helper emits resolved follow-up markers from conversational completion phrasing", () => {
  const candidates = extractProfileFactCandidatesFromUserInput(
    "I'm all set with the dentist reminder anymore.",
    "task_profile_extract_followup_conversational",
    "2026-03-07T12:00:00.000Z"
  );

  assert.equal(
    candidates.some(
      (candidate) =>
        candidate.key === "followup.dentist.reminder" && candidate.value === "resolved"
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

test("conversational profile update signal recognizes bounded relationship, event, and self facts", () => {
  assert.equal(
    hasConversationalProfileUpdateSignal(
      "I work with a guy named Milo at Northstar Creative."
    ),
    true
  );
  assert.equal(
    hasConversationalProfileUpdateSignal("I live in Detroit now."),
    true
  );
  assert.equal(
    hasConversationalProfileUpdateSignal(
      "Milo sold Jordan the gray Accord in late 2024."
    ),
    true
  );
  assert.equal(
    hasConversationalProfileUpdateSignal(
      "Yeah, so Billy is someone I worked previously. He now works somewhere else."
    ),
    true
  );
});

test("conversational profile update signal ignores workflow callback phrasing and non-phase-one preferences", () => {
  assert.equal(
    hasConversationalProfileUpdateSignal(
      "Call me when the deployment is done and run the workspace build."
    ),
    false
  );
  assert.equal(
    hasConversationalProfileUpdateSignal(
      "Deploy the workspace repo and my favorite editor is Helix."
    ),
    false
  );
  assert.equal(hasConversationalProfileUpdateSignal("Who is Billy?"), false);
});

test("conversational profile update signal unwraps reminder-style named-contact clauses", () => {
  assert.equal(
    hasConversationalProfileUpdateSignal(
      "After that, remind me that Priya is my coworker at Northstar."
    ),
    true
  );
});

test("named-contact extraction unwraps reminder-style coworker clauses into canonical contact facts", () => {
  const candidates = extractProfileFactCandidatesFromUserInput(
    "After that, remind me that Priya is my coworker at Northstar.",
    "task_profile_extract_wrapped_coworker_clause",
    "2026-04-09T18:00:00.000Z"
  );

  assert.equal(
    candidates.some(
      (candidate) =>
        candidate.key === "contact.priya.name" && candidate.value === "Priya"
    ),
    true
  );
  assert.equal(
    candidates.some(
      (candidate) =>
        candidate.key === "contact.priya.relationship" && candidate.value === "work_peer"
    ),
    true
  );
  assert.equal(
    candidates.some(
      (candidate) =>
        candidate.key === "contact.priya.work_association" && candidate.value === "Northstar"
    ),
    true
  );
});

test("named-contact extraction keeps second same-name contacts separate by qualifier", () => {
  const candidates = extractProfileFactCandidatesFromUserInput(
    "I also know another Jordan at Ember. That's a different Jordan from Northstar.",
    "task_profile_extract_same_name_qualifier",
    "2026-04-09T18:10:00.000Z"
  );

  assert.equal(
    candidates.some(
      (candidate) =>
        candidate.key === "contact.jordan_ember.name" &&
        candidate.value === "Jordan"
    ),
    true
  );
  assert.equal(
    candidates.some(
      (candidate) =>
        candidate.key.startsWith("contact.jordan_ember.context.") &&
        /Jordan at Ember|different Jordan from Northstar/i.test(candidate.value)
    ),
    true
  );
});

test("named-contact extraction keeps alias-bearing same-name context attached to the original contact lane", () => {
  const candidates = extractProfileFactCandidatesFromUserInput(
    "The Jordan from Northstar sometimes goes by J.R.",
    "task_profile_extract_same_name_alias",
    "2026-04-09T18:11:00.000Z"
  );

  assert.equal(
    candidates.some(
      (candidate) =>
        candidate.key === "contact.jordan.name" &&
        candidate.value === "Jordan"
    ),
    true
  );
  assert.equal(
    candidates.some(
      (candidate) =>
        candidate.key.startsWith("contact.jordan.context.") &&
        /J\.R\./i.test(candidate.value)
    ),
    true
  );
});

test("named-contact extraction keeps conflicting dotted-initial aliases on a separate qualified lane", () => {
  const candidates = extractProfileFactCandidatesFromUserInput(
    "I met a different J.R. from Harbor last month.",
    "task_profile_extract_alias_collision",
    "2026-04-09T18:12:00.000Z"
  );

  assert.equal(
    candidates.some(
      (candidate) =>
        candidate.key === "contact.jr_harbor.name" &&
        candidate.value === "J.R."
    ),
    true
  );
  assert.equal(
    candidates.some(
      (candidate) =>
        candidate.key.startsWith("contact.jr_harbor.context.") &&
        /Harbor/i.test(candidate.value)
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

test("truth governance demotes lexical relationship facts before semantic confirmation", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "I work with Owen at Lantern Studio. Owen said the launch slipped.",
    "task_profile_governed_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "work_peer"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.work_association" &&
        candidate.value === "Lantern Studio"
    ),
    false
  );
  assert.equal(
    governanceResult.quarantinedFactCandidates.some(
      (entry) =>
        entry.candidate.key === "contact.owen.relationship" &&
        entry.candidate.value === "work_peer"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some((candidate) =>
      candidate.key.startsWith("contact.owen.context.")
    ),
    true
  );
});

test("direct contact relationship extraction emits candidates without current-state authority", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Milo is my boss at Northstar Creative.",
    "task_profile_governed_boss_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.milo.name" &&
        candidate.value === "Milo"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.milo.relationship" &&
        candidate.value === "manager" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.milo.work_association" &&
        candidate.value === "Northstar Creative"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.milo.relationship" &&
        candidate.value === "manager"
    ),
    false
  );
  assert.equal(
    governanceResult.quarantinedFactCandidates.some(
      (entry) =>
        entry.candidate.key === "contact.milo.relationship" &&
        entry.candidate.value === "manager"
    ),
    true
  );
});

test("named-contact extraction normalizes boss phrasing into manager current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My boss is Dana.",
    "task_profile_governed_named_boss_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.dana.name" &&
        candidate.value === "Dana" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.dana.relationship" &&
        candidate.value === "manager" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.dana.relationship" &&
        candidate.value === "manager"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "boss" &&
        candidate.value === "Dana"
    ),
    false
  );
});

test("named-contact extraction normalizes supervisor phrasing into manager current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My supervisor is Dana.",
    "task_profile_governed_supervisor_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.dana.name" &&
        candidate.value === "Dana" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.dana.relationship" &&
        candidate.value === "manager" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.dana.relationship" &&
        candidate.value === "manager"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "supervisor" &&
        candidate.value === "Dana"
    ),
    false
  );
});

test("named-contact extraction normalizes boss phrasing into manager current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My boss is Dana.",
    "task_profile_governed_named_boss_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.dana.name" &&
        candidate.value === "Dana" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.dana.relationship" &&
        candidate.value === "manager" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.dana.relationship" &&
        candidate.value === "manager"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "boss" &&
        candidate.value === "Dana"
    ),
    false
  );
});

test("named-contact extraction normalizes team lead phrasing into manager current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My team lead is Reese.",
    "task_profile_governed_team_lead_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.reese.name" &&
        candidate.value === "Reese" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.reese.relationship" &&
        candidate.value === "manager" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.reese.relationship" &&
        candidate.value === "manager"
    ),
    true
  );
});

test("named-contact extraction normalizes lead phrasing into manager current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My lead is Avery.",
    "task_profile_governed_lead_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.avery.name" &&
        candidate.value === "Avery" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.avery.relationship" &&
        candidate.value === "manager" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.avery.relationship" &&
        candidate.value === "manager"
    ),
    true
  );
});

test("named-contact extraction normalizes neighbour phrasing into neighbor current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My neighbour is Priya.",
    "task_profile_governed_neighbour_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.priya.name" &&
        candidate.value === "Priya" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.priya.relationship" &&
        candidate.value === "neighbor" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.priya.relationship" &&
        candidate.value === "neighbor"
    ),
    true
  );
});

test("named-contact extraction normalizes peer phrasing into work-peer current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My peer is Nolan.",
    "task_profile_governed_peer_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.nolan.name" &&
        candidate.value === "Nolan" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.nolan.relationship" &&
        candidate.value === "work_peer" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.nolan.relationship" &&
        candidate.value === "work_peer"
    ),
    true
  );
});

test("named-contact extraction normalizes work-peer phrasing into work-peer current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My work peer is Nolan.",
    "task_profile_governed_work_peer_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.nolan.name" &&
        candidate.value === "Nolan" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.nolan.relationship" &&
        candidate.value === "work_peer" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.nolan.relationship" &&
        candidate.value === "work_peer"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "work.peer" &&
        candidate.value === "Nolan"
    ),
    false
  );
});

test("named-contact extraction normalizes colleague phrasing into work-peer current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My colleague is Evan.",
    "task_profile_governed_colleague_extract",
    "2026-04-03T12:00:30.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.evan.name" &&
        candidate.value === "Evan" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.evan.relationship" &&
        candidate.value === "work_peer" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.evan.relationship" &&
        candidate.value === "work_peer"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.evan.relationship" &&
        candidate.value === "colleague"
    ),
    false
  );
});

test("named-contact extraction normalizes work-peer phrasing into work-peer current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My work peer is Nolan.",
    "task_profile_governed_work_peer_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.nolan.name" &&
        candidate.value === "Nolan" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.nolan.relationship" &&
        candidate.value === "work_peer" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.nolan.relationship" &&
        candidate.value === "work_peer"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "work.peer" &&
        candidate.value === "Nolan"
    ),
    false
  );
});

test("named-contact extraction normalizes guy phrasing into acquaintance current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "I know a guy named Milo.",
    "task_profile_governed_guy_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.milo.name" &&
        candidate.value === "Milo" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.milo.relationship" &&
        candidate.value === "acquaintance" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.milo.relationship" &&
        candidate.value === "acquaintance"
    ),
    true
  );
});

test("named-contact extraction keeps acquaintance phrasing on the governed current-state path", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My acquaintance is Riley.",
    "task_profile_governed_acquaintance_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.riley.name" &&
        candidate.value === "Riley" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.riley.relationship" &&
        candidate.value === "acquaintance" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.riley.relationship" &&
        candidate.value === "acquaintance"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "acquaintance" &&
        candidate.value === "Riley"
    ),
    false
  );
});

test("named-contact extraction trims wrapper and association continuation text out of work-with display names", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "I work with a guy named Milo at Northstar Creative.",
    "task_profile_governed_named_wrapper_work_with_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.milo.name" &&
        candidate.value === "Milo"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.milo.work_association" &&
        candidate.value === "Northstar Creative"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.milo.relationship" &&
        candidate.value === "work_peer"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some((candidate) =>
      candidate.key.includes("northstar") || candidate.key.includes("a.guy.named.milo")
    ),
    false
  );
});

test("named-contact extraction keeps plain works-with-me continuations on one bounded contact token", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "A person named Milo works with me.",
    "task_profile_governed_named_wrapper_plain_work_with_me_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.milo.name" &&
        candidate.value === "Milo"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.milo.relationship" &&
        candidate.value === "work_peer"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some((candidate) =>
      candidate.key.includes("works.with.me") || candidate.key.includes("person.named.milo")
    ),
    false
  );
});

test("named-contact extraction supports inline my-relationship name phrasing before work-with-me continuations", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My friend Riley works with me at Lantern Studio.",
    "task_profile_governed_inline_named_contact_work_with_me_extract",
    "2026-04-03T12:00:00.000Z"
  );

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.riley.name" &&
        candidate.value === "Riley"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.riley.work_association" &&
        candidate.value === "Lantern Studio"
    ),
    true
  );
});

test("named-contact extraction captures cousin phrasing as a governed current-state contact fact", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My cousin is Liam.",
    "task_profile_governed_cousin_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.liam.name" &&
        candidate.value === "Liam" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.liam.relationship" &&
        candidate.value === "cousin" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.liam.relationship" &&
        candidate.value === "cousin"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "cousin" &&
        candidate.value === "Liam"
    ),
    false
  );
});

test("named-contact extraction normalizes aunt phrasing into relative current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My aunt is Rosa.",
    "task_profile_governed_aunt_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.name" &&
        candidate.value === "Rosa" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "aunt" &&
        candidate.value === "Rosa"
    ),
    false
  );
});

test("named-contact extraction normalizes wife phrasing into partner current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My wife is Sam.",
    "task_profile_governed_wife_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.sam.name" &&
        candidate.value === "Sam" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.sam.relationship" &&
        candidate.value === "partner" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.sam.relationship" &&
        candidate.value === "partner"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "wife" &&
        candidate.value === "Sam"
    ),
    false
  );
});

test("named-contact extraction keeps roommate phrasing on governed current-state contact facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My roommate is Kai.",
    "task_profile_governed_roommate_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.kai.name" &&
        candidate.value === "Kai" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.kai.relationship" &&
        candidate.value === "roommate" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.kai.relationship" &&
        candidate.value === "roommate"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "roommate" &&
        candidate.value === "Kai"
    ),
    false
  );
});

test("named-contact extraction normalizes mom phrasing into relative current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My mom is Rosa.",
    "task_profile_governed_mom_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.name" &&
        candidate.value === "Rosa" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "mom" &&
        candidate.value === "Rosa"
    ),
    false
  );
});

test("named-contact extraction normalizes family-member phrasing into relative current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My family member is Rosa.",
    "task_profile_governed_family_member_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.name" &&
        candidate.value === "Rosa" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "family.member" &&
        candidate.value === "Rosa"
    ),
    false
  );
});

test("named-contact extraction normalizes son phrasing into relative current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My son is Liam.",
    "task_profile_governed_son_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.liam.name" &&
        candidate.value === "Liam" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.liam.relationship" &&
        candidate.value === "relative" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.liam.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "son" &&
        candidate.value === "Liam"
    ),
    false
  );
});

test("direct contact relationship extraction normalizes aunt phrasing into relative current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Rosa is my aunt.",
    "task_profile_governed_direct_aunt_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.name" &&
        candidate.value === "Rosa" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
});

test("direct contact relationship extraction normalizes sister phrasing into relative current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Rosa is my sister.",
    "task_profile_governed_direct_sister_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.name" &&
        candidate.value === "Rosa" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
});

test("direct contact relationship extraction keeps roommate phrasing on governed current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Kai is my roommate.",
    "task_profile_governed_direct_roommate_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.kai.name" &&
        candidate.value === "Kai" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.kai.relationship" &&
        candidate.value === "roommate" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.kai.relationship" &&
        candidate.value === "roommate"
    ),
    true
  );
});

test("direct contact relationship extraction normalizes family phrasing into relative current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Rosa is family.",
    "task_profile_governed_direct_family_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.name" &&
        candidate.value === "Rosa" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
});

test("direct contact relationship extraction normalizes child phrasing into relative current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Eli is my child.",
    "task_profile_governed_direct_child_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.eli.name" &&
        candidate.value === "Eli" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.eli.relationship" &&
        candidate.value === "relative" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.eli.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
});

test("symmetric partner current relationship phrasing maps named contacts onto current-state governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Sam and I are partners.",
    "task_profile_governed_symmetric_partner_current_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.sam.relationship" &&
        candidate.value === "partner" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.sam.relationship" &&
        candidate.value === "partner"
    ),
    true
  );
});

test("symmetric married current relationship phrasing maps named contacts onto current-state governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Sam and I are married.",
    "task_profile_governed_symmetric_married_current_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.sam.relationship" &&
        candidate.value === "partner" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.sam.relationship" &&
        candidate.value === "partner"
    ),
    true
  );
});

test("symmetric roommate current relationship phrasing maps named contacts onto current-state governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Kai and I are roommates.",
    "task_profile_governed_symmetric_roommate_current_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.kai.relationship" &&
        candidate.value === "roommate" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.kai.relationship" &&
        candidate.value === "roommate"
    ),
    true
  );
});

test("symmetric family current relationship phrasing maps named contacts onto current-state governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Rosa and I are family.",
    "task_profile_governed_symmetric_family_current_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.name" &&
        candidate.value === "Rosa" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
});

test("symmetric sibling current relationship phrasing maps named contacts onto current-state governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Rosa and I are siblings.",
    "task_profile_governed_symmetric_sibling_current_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.name" &&
        candidate.value === "Rosa" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
});

test("named-contact extraction normalizes distant-relative phrasing into relative current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My distant relative is Rosa.",
    "task_profile_governed_distant_relative_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.name" &&
        candidate.value === "Rosa" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "distant.relative" &&
        candidate.value === "Rosa"
    ),
    false
  );
});

test("direct contact relationship extraction normalizes distant-relative phrasing into relative current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Rosa is my distant relative.",
    "task_profile_governed_direct_distant_relative_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
});

test("named-contact extraction normalizes distant-relative phrasing into relative current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My distant relative is Rosa.",
    "task_profile_governed_distant_relative_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.name" &&
        candidate.value === "Rosa" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "distant.relative" &&
        candidate.value === "Rosa"
    ),
    false
  );
});

test("direct contact relationship extraction normalizes distant-relative phrasing into relative current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Rosa is my distant relative.",
    "task_profile_governed_direct_distant_relative_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
});

test("symmetric non-work current relationship phrasing maps named contacts onto current-state governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "I'm friends with Owen.",
    "task_profile_governed_symmetric_friend_current_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.name" &&
        candidate.value === "Owen" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "friend" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "friend"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) => candidate.key === "contact.owen.relationship"
    ),
    false
  );
});

test("symmetric distant-relative current relationship phrasing maps named contacts onto current-state governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Rosa and I are distant relatives.",
    "task_profile_governed_symmetric_distant_relative_current_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
});

test("symmetric distant-relative current relationship phrasing maps named contacts onto current-state governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Rosa and I are distant relatives.",
    "task_profile_governed_symmetric_distant_relative_current_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
});

test("symmetric work current relationship phrasing maps named contacts onto current-state governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Owen and I are peers.",
    "task_profile_governed_symmetric_peer_current_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.name" &&
        candidate.value === "Owen" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "work_peer" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "work_peer"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) => candidate.key === "contact.owen.relationship"
    ),
    false
  );
});

test("named-contact extraction normalizes direct report phrasing into employee current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "My direct report is Casey.",
    "task_profile_governed_direct_report_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.casey.name" &&
        candidate.value === "Casey" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.casey.relationship" &&
        candidate.value === "employee" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.casey.relationship" &&
        candidate.value === "employee"
    ),
    true
  );
});

test("employee-direction extraction normalizes works-for-me phrasing into employee current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Owen works for me at Lantern Studio.",
    "task_profile_governed_employee_link_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.name" &&
        candidate.value === "Owen" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "employee" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.work_association" &&
        candidate.value === "Lantern Studio" &&
        candidate.source === "user_input_pattern.direct_contact_relationship"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "employee"
    ),
    true
  );
});

test("work-peer direction extraction normalizes works-with-me phrasing into current-state facts", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Owen works with me at Lantern Studio.",
    "task_profile_governed_work_peer_link_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.name" &&
        candidate.value === "Owen" &&
        candidate.source === "user_input_pattern.work_with_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "work_peer" &&
        candidate.source === "user_input_pattern.work_with_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.work_association" &&
        candidate.value === "Lantern Studio" &&
        candidate.source === "user_input_pattern.work_with_contact"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "work_peer"
    ),
    true
  );
});

test("historical work-linkage extraction maps relationship history to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "I used to work with Owen at Lantern Studio.",
    "task_profile_governed_historical_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.source === "user_input_pattern.work_with_contact_historical"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.work_association" &&
        candidate.source === "user_input_pattern.work_with_contact_historical"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" ||
        candidate.key === "contact.owen.work_association"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "work_peer"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.work_association" &&
        candidate.value === "Lantern Studio"
    ),
    true
  );
});

test("historical works-with-me extraction maps relationship history to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Owen worked with me at Lantern Studio.",
    "task_profile_governed_historical_work_peer_link_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.source === "user_input_pattern.work_with_contact_historical"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.work_association" &&
        candidate.source === "user_input_pattern.work_with_contact_historical"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" ||
        candidate.key === "contact.owen.work_association"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "work_peer"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.work_association" &&
        candidate.value === "Lantern Studio"
    ),
    true
  );
});

test("named-contact narrative keeps used-to-work-with-me association historical", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "I went to school with a guy named Owen, and he also used to work with me at Lantern Studio.",
    "task_profile_governed_named_contact_historical_work_association",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "acquaintance" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    false
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "work_peer" &&
        candidate.source === "user_input_pattern.work_association_historical"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.work_association" &&
        candidate.value === "Lantern Studio" &&
        candidate.source === "user_input_pattern.work_association_historical"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.source === "user_input_pattern.work_association"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "work_peer"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.work_association" &&
        candidate.value === "Lantern Studio"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "work_peer"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.work_association" &&
        candidate.value === "Lantern Studio"
    ),
    true
  );
});

test("third-person contact continuity extraction keeps current organization, historical organization, and resolved vehicle context bounded", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Billy used to be at Beacon. He's at Northstar now. He drives a gray Accord.",
    "task_profile_governed_third_person_contact_continuity_extract",
    "2026-04-09T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.billy.name" &&
        candidate.value === "Billy" &&
        candidate.source === "user_input_pattern.named_contact"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.billy.work_association" &&
        candidate.value === "Beacon" &&
        candidate.source === "user_input_pattern.work_association_historical"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.billy.work_association" &&
        candidate.value === "Northstar" &&
        candidate.source === "user_input_pattern.work_association"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        /^contact\.billy\.context\.[a-f0-9]{8}$/.test(candidate.key) &&
        candidate.value === "Billy drives a gray Accord" &&
        candidate.source === "user_input_pattern.contact_context"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.billy.work_association" &&
        candidate.value === "Northstar"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.billy.work_association" &&
        candidate.value === "Beacon"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        /^contact\.billy\.context\.[a-f0-9]{8}$/.test(candidate.key) &&
        candidate.value === "Billy drives a gray Accord"
    ),
    true
  );
});

test("long-form third-person relationship updates keep realistic clause-heavy work history bounded", () => {
  const userInput = [
    "Billy used to work at Sample Web Studio as a front-end contractor, but by late February he had started interviewing elsewhere.",
    "Billy is no longer at Sample Web Studio.",
    "Billy has already started at Crimson Analytics, and Garrett still owns Harbor Signal Studio.",
    "Garrett prefers short direct updates.",
    "Billy is still in Ferndale for now, and Garrett is still splitting time between Detroit and Ann Arbor."
  ].join(" ");
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    userInput,
    "task_profile_governed_longform_contact_continuity_extract",
    "2026-04-12T18:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(hasConversationalProfileUpdateSignal(userInput), true);
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.billy.work_association" &&
        candidate.value === "Sample Web Studio" &&
        candidate.source === "user_input_pattern.work_association_historical"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.billy.work_association" &&
        candidate.value === "Crimson Analytics" &&
        candidate.source === "user_input_pattern.work_association"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.garrett.organization_association" &&
        candidate.value === "Harbor Signal Studio" &&
        candidate.source === "user_input_pattern.organization_association"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.billy.location_association" &&
        candidate.value === "Ferndale" &&
        candidate.source === "user_input_pattern.location_association"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.garrett.primary_location_association" &&
        candidate.value === "Detroit" &&
        candidate.source === "user_input_pattern.location_association"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.garrett.secondary_location_association" &&
        candidate.value === "Ann Arbor" &&
        candidate.source === "user_input_pattern.location_association"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        /^contact\.garrett\.context\.[a-f0-9]{8}$/.test(candidate.key) &&
        candidate.value === "Garrett still owns Harbor Signal Studio"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        /^contact\.garrett\.context\.[a-f0-9]{8}$/.test(candidate.key) &&
        candidate.value === "Garrett prefers short direct updates"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        /^contact\.billy\.context\.[a-f0-9]{8}$/.test(candidate.key) &&
        candidate.value === "Billy is still in Ferndale for now"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        /^contact\.garrett\.context\.[a-f0-9]{8}$/.test(candidate.key) &&
        candidate.value === "Garrett is still splitting time between Detroit and Ann Arbor"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.billy.work_association" &&
        candidate.value === "Crimson Analytics"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.garrett.organization_association" &&
        candidate.value === "Harbor Signal Studio"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.billy.location_association" &&
        candidate.value === "Ferndale"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.garrett.primary_location_association" &&
        candidate.value === "Detroit"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.garrett.secondary_location_association" &&
        candidate.value === "Ann Arbor"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.billy.work_association" &&
        candidate.value === "Sample Web Studio"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        /^contact\.billy\.context\.[a-f0-9]{8}$/.test(candidate.key) &&
        candidate.value === "Billy is still in Ferndale for now"
    ),
    true
  );
});

test("severed work-linkage extraction maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "I don't work with Owen at Lantern Studio anymore.",
    "task_profile_governed_severed_contact_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.name" &&
        candidate.source === "user_input_pattern.work_with_contact_severed" &&
        candidate.value === "Owen"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.source === "user_input_pattern.work_with_contact_severed" &&
        candidate.value === "work_peer"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.work_association" &&
        candidate.source === "user_input_pattern.work_with_contact_severed" &&
        candidate.value === "Lantern Studio"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" ||
        candidate.key === "contact.owen.work_association"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.name" &&
        candidate.value === "Owen"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "work_peer"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.work_association" &&
        candidate.value === "Lantern Studio"
    ),
    true
  );
});

test("severed work-together phrasing maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Owen and I don't work together anymore.",
    "task_profile_governed_severed_together_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.name" &&
        candidate.source === "user_input_pattern.work_with_contact_severed" &&
        candidate.value === "Owen"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.owen.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.source === "user_input_pattern.work_with_contact_severed"
    ),
    true
  );
});

test("severed works-with-me extraction maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Owen no longer works with me at Lantern Studio.",
    "task_profile_governed_severed_work_peer_link_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.name" &&
        candidate.source === "user_input_pattern.work_with_contact_severed" &&
        candidate.value === "Owen"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.source === "user_input_pattern.work_with_contact_severed" &&
        candidate.value === "work_peer"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.work_association" &&
        candidate.source === "user_input_pattern.work_with_contact_severed" &&
        candidate.value === "Lantern Studio"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" ||
        candidate.key === "contact.owen.work_association"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "work_peer"
    ),
    true
  );
});

test("historical direct contact relationship phrasing maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Owen is my former coworker at Lantern Studio.",
    "task_profile_governed_direct_historical_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.name" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "Owen"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "work_peer"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.work_association" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "Lantern Studio"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" ||
        candidate.key === "contact.owen.work_association"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.name" &&
        candidate.value === "Owen"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical"
    ),
    true
  );
});

test("historical direct partner relationship phrasing maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Sam is my former girlfriend.",
    "task_profile_governed_direct_partner_historical_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.sam.name" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "Sam"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.sam.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "partner"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.sam.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.sam.relationship" &&
        candidate.value === "partner"
    ),
    true
  );
});

test("historical married direct relationship phrasing maps named-contact history to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "I used to be married to Sam.",
    "task_profile_governed_direct_married_historical_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.sam.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "partner"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.sam.relationship" &&
        candidate.value === "partner"
    ),
    true
  );
});

test("severed married direct relationship phrasing maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "I'm not married to Sam anymore.",
    "task_profile_governed_direct_married_severed_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.sam.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed" &&
        candidate.value === "partner"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.sam.relationship" &&
        candidate.value === "partner"
    ),
    true
  );
});

test("historical direct roommate relationship phrasing maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Kai is my former roommate.",
    "task_profile_governed_direct_roommate_historical_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.kai.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "roommate"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.kai.relationship" &&
        candidate.value === "roommate"
    ),
    true
  );
});

test("severed direct roommate relationship phrasing maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Kai is no longer my roommate.",
    "task_profile_governed_direct_roommate_severed_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.kai.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed" &&
        candidate.value === "roommate"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.kai.relationship" &&
        candidate.value === "roommate"
    ),
    true
  );
});

test("symmetric non-work historical relationship phrasing maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Owen and I used to be friends.",
    "task_profile_governed_symmetric_friend_historical_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.name" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "Owen"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "friend"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.owen.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "friend"
    ),
    true
  );
});

test("symmetric cousin historical relationship phrasing maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Owen and I used to be cousins.",
    "task_profile_governed_symmetric_cousin_historical_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "cousin"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.owen.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "cousin"
    ),
    true
  );
});

test("symmetric distant-relative historical relationship phrasing maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Rosa and I used to be distant relatives.",
    "task_profile_governed_symmetric_distant_relative_historical_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "relative"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.rosa.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
});

test("symmetric family historical relationship phrasing maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Rosa and I used to be family.",
    "task_profile_governed_symmetric_family_historical_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "relative"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.rosa.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
});

test("symmetric sibling historical relationship phrasing maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Rosa and I used to be siblings.",
    "task_profile_governed_symmetric_sibling_historical_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "relative"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.rosa.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
});

test("symmetric work historical relationship phrasing maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Owen and I used to be peers.",
    "task_profile_governed_symmetric_peer_historical_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "work_peer"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.owen.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "work_peer"
    ),
    true
  );
});

test("historical direct report phrasing normalizes into employee support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Casey is my former direct report at Northstar Creative.",
    "task_profile_governed_direct_report_historical_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.casey.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "employee"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.casey.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.casey.relationship" &&
        candidate.value === "employee"
    ),
    true
  );
});

test("historical direct lead phrasing normalizes into manager support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Avery is my former lead at Northstar Creative.",
    "task_profile_governed_direct_lead_historical_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.avery.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "manager"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.avery.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.avery.relationship" &&
        candidate.value === "manager"
    ),
    true
  );
});

test("historical employee-direction phrasing normalizes into employee support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Owen used to work for me at Lantern Studio.",
    "task_profile_governed_employee_link_historical_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "employee"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.work_association" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "Lantern Studio"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" ||
        candidate.key === "contact.owen.work_association"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "employee"
    ),
    true
  );
});

test("severed direct contact relationship phrasing maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Jordan is no longer my boss.",
    "task_profile_governed_direct_severed_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.jordan.name" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed" &&
        candidate.value === "Jordan"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.jordan.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed" &&
        candidate.value === "manager"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.jordan.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.jordan.name" &&
        candidate.value === "Jordan"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.jordan.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed"
    ),
    true
  );
});

test("symmetric non-work severed relationship phrasing maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "I'm not friends with Owen anymore.",
    "task_profile_governed_symmetric_friend_severed_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.name" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed" &&
        candidate.value === "Owen"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed" &&
        candidate.value === "friend"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.owen.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "friend"
    ),
    true
  );
});

test("symmetric cousin severed relationship phrasing maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "I'm not cousins with Owen anymore.",
    "task_profile_governed_symmetric_cousin_severed_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed" &&
        candidate.value === "cousin"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.owen.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "cousin"
    ),
    true
  );
});

test("symmetric distant-relative severed relationship phrasing maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Rosa and I aren't distant relatives anymore.",
    "task_profile_governed_symmetric_distant_relative_severed_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed" &&
        candidate.value === "relative"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.rosa.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
});

test("symmetric family severed relationship phrasing maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Rosa and I aren't family anymore.",
    "task_profile_governed_symmetric_family_severed_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed" &&
        candidate.value === "relative"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.rosa.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
});

test("symmetric sibling severed relationship phrasing maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Rosa and I aren't siblings anymore.",
    "task_profile_governed_symmetric_sibling_severed_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed" &&
        candidate.value === "relative"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.rosa.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.rosa.relationship" &&
        candidate.value === "relative"
    ),
    true
  );
});

test("symmetric work severed relationship phrasing maps named-contact endings to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "I'm not peers with Owen anymore.",
    "task_profile_governed_symmetric_peer_severed_extract",
    "2026-04-03T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed" &&
        candidate.value === "work_peer"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.owen.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "work_peer"
    ),
    true
  );
});

test("severed direct supervisor phrasing normalizes into manager support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Jordan is no longer my supervisor.",
    "task_profile_governed_direct_supervisor_severed_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.jordan.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed" &&
        candidate.value === "manager"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.jordan.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.jordan.relationship" &&
        candidate.value === "manager"
    ),
    true
  );
});

test("severed direct team lead phrasing normalizes into manager support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Jordan is no longer my team lead.",
    "task_profile_governed_direct_team_lead_severed_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.jordan.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed" &&
        candidate.value === "manager"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.jordan.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.jordan.relationship" &&
        candidate.value === "manager"
    ),
    true
  );
});

test("severed direct report phrasing normalizes into employee support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Taylor is no longer my direct report.",
    "task_profile_governed_direct_report_severed_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.taylor.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed" &&
        candidate.value === "employee"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.taylor.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.taylor.relationship" &&
        candidate.value === "employee"
    ),
    true
  );
});

test("severed direct lead phrasing normalizes into manager support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Avery is no longer my lead.",
    "task_profile_governed_direct_lead_severed_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.avery.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed" &&
        candidate.value === "manager"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.avery.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.avery.relationship" &&
        candidate.value === "manager"
    ),
    true
  );
});

test("historical direct neighbour phrasing normalizes into neighbor support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Priya is my former neighbour.",
    "task_profile_governed_direct_neighbour_historical_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.priya.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "neighbor"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.priya.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.priya.relationship" &&
        candidate.value === "neighbor"
    ),
    true
  );
});

test("historical direct peer phrasing normalizes into work-peer support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Nolan is my former peer at Northstar Creative.",
    "task_profile_governed_direct_peer_historical_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.nolan.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_historical" &&
        candidate.value === "work_peer"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.nolan.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.nolan.relationship" &&
        candidate.value === "work_peer"
    ),
    true
  );
});

test("severed direct neighbour phrasing normalizes into neighbor support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Priya is no longer my neighbour.",
    "task_profile_governed_direct_neighbour_severed_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.priya.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed" &&
        candidate.value === "neighbor"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.priya.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.priya.relationship" &&
        candidate.value === "neighbor"
    ),
    true
  );
});

test("severed direct peer phrasing normalizes into work-peer support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Nolan is no longer my peer.",
    "task_profile_governed_direct_peer_severed_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.nolan.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed" &&
        candidate.value === "work_peer"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.nolan.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.nolan.relationship" &&
        candidate.value === "work_peer"
    ),
    true
  );
});

test("severed employee-direction phrasing normalizes into employee support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "Owen no longer works for me at Lantern Studio.",
    "task_profile_governed_employee_link_severed_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed" &&
        candidate.value === "employee"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.work_association" &&
        candidate.source === "user_input_pattern.direct_contact_relationship_severed" &&
        candidate.value === "Lantern Studio"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) => candidate.key === "contact.owen.relationship"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "contact.owen.relationship" &&
        candidate.value === "employee"
    ),
    true
  );
});

test("historical self employment and residence extraction map to support-only governance", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "I used to work at Lantern. I used to live in Detroit.",
    "task_profile_governed_historical_self_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "employment.current" &&
        candidate.source === "user_input_pattern.work_at_historical" &&
        candidate.value === "Lantern"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "residence.current" &&
        candidate.source === "user_input_pattern.residence_historical" &&
        candidate.value === "Detroit"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "employment.current" ||
        candidate.key === "residence.current"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "employment.current" &&
        candidate.value === "Lantern"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "residence.current" &&
        candidate.value === "Detroit"
    ),
    true
  );
});

test("explicit self end-state phrasing maps into the historical support-only path", () => {
  const extractedCandidates = extractProfileFactCandidatesFromUserInput(
    "I quit my job at Lantern. I don't live in Detroit anymore.",
    "task_profile_governed_end_state_self_extract",
    "2026-04-02T12:00:00.000Z"
  );
  const governanceResult = governProfileMemoryCandidates({
    factCandidates: extractedCandidates,
    episodeCandidates: [],
    episodeResolutionCandidates: []
  });

  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "employment.current" &&
        candidate.source === "user_input_pattern.work_at_historical" &&
        candidate.value === "Lantern"
    ),
    true
  );
  assert.equal(
    extractedCandidates.some(
      (candidate) =>
        candidate.key === "residence.current" &&
        candidate.source === "user_input_pattern.residence_historical" &&
        candidate.value === "Detroit"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedCurrentStateFactCandidates.some(
      (candidate) =>
        candidate.key === "employment.current" ||
        candidate.key === "residence.current"
    ),
    false
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "employment.current" &&
        candidate.value === "Lantern"
    ),
    true
  );
  assert.equal(
    governanceResult.allowedSupportOnlyFactCandidates.some(
      (candidate) =>
        candidate.key === "residence.current" &&
        candidate.value === "Detroit"
    ),
    true
  );
});
