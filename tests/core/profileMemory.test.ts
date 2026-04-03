/**
 * @fileoverview Tests temporal profile-memory supersession, freshness, and deterministic user-input extraction behavior.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assessProfileFactFreshness,
  buildPlanningContextFromProfile,
  createEmptyProfileMemoryState,
  extractProfileFactCandidatesFromUserInput,
  markStaleFactsAsUncertain,
  upsertTemporalProfileFact
} from "../../src/core/profileMemory";

/**
 * Implements `isoDaysAgo` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

test("upsert supersedes older active fact for same key with new value", () => {
  const emptyState = createEmptyProfileMemoryState();
  assert.deepEqual(emptyState.episodes, []);
  const first = upsertTemporalProfileFact(emptyState, {
    key: "employment.current",
    value: "Pro-Green",
    sensitive: false,
    sourceTaskId: "task_1",
    source: "test",
    observedAt: "2026-02-20T00:00:00.000Z",
    confidence: 0.95
  });

  const second = upsertTemporalProfileFact(first.nextState, {
    key: "employment.current",
    value: "Lantern",
    sensitive: false,
    sourceTaskId: "task_2",
    source: "test",
    observedAt: "2026-02-21T00:00:00.000Z",
    confidence: 0.95
  });

  const supersededFacts = second.nextState.facts.filter((fact) => fact.status === "superseded");
  const activeFacts = second.nextState.facts.filter(
    (fact) => fact.status !== "superseded" && fact.supersededAt === null
  );

  assert.equal(supersededFacts.length, 1);
  assert.equal(activeFacts.length, 1);
  assert.equal(activeFacts[0].value, "Lantern");
  assert.equal(second.supersededFactIds.length, 1);
});

test("upsert refreshes same key/value without creating duplicate active fact", () => {
  const emptyState = createEmptyProfileMemoryState();
  const first = upsertTemporalProfileFact(emptyState, {
    key: "employment.current",
    value: "Lantern",
    sensitive: false,
    sourceTaskId: "task_1",
    source: "test",
    observedAt: "2026-02-21T00:00:00.000Z",
    confidence: 0.95
  });

  const second = upsertTemporalProfileFact(first.nextState, {
    key: "employment.current",
    value: "Lantern",
    sensitive: false,
    sourceTaskId: "task_2",
    source: "test",
    observedAt: "2026-02-22T00:00:00.000Z",
    confidence: 0.95
  });

  const activeFacts = second.nextState.facts.filter(
    (fact) => fact.status !== "superseded" && fact.supersededAt === null
  );
  assert.equal(activeFacts.length, 1);
  assert.equal(second.supersededFactIds.length, 0);
});

test("upsert persists commitment classifier mutation-audit metadata on profile facts", () => {
  const emptyState = createEmptyProfileMemoryState();
  const upserted = upsertTemporalProfileFact(emptyState, {
    key: "followup.tax.filing",
    value: "resolved",
    sensitive: false,
    sourceTaskId: "task_profile_audit_1",
    source: "user_input_pattern.followup_resolved_inferred",
    observedAt: "2026-02-28T00:00:00.000Z",
    confidence: 0.95,
    mutationAudit: {
      classifier: "commitment_signal",
      category: "TOPIC_RESOLUTION_CANDIDATE",
      confidenceTier: "HIGH",
      matchedRuleId: "commitment_signal_v1_user_input_topic_resolution_candidate",
      rulepackVersion: "CommitmentSignalRulepackV1",
      conflict: false
    }
  });

  const fact = upserted.nextState.facts.find((candidate) => candidate.key === "followup.tax.filing");
  assert.ok(fact?.mutationAudit);
  assert.equal(fact?.mutationAudit?.matchedRuleId, "commitment_signal_v1_user_input_topic_resolution_candidate");
  assert.equal(fact?.mutationAudit?.rulepackVersion, "CommitmentSignalRulepackV1");
});

test("markStaleFactsAsUncertain downgrades stale confirmed facts", () => {
  const emptyState = createEmptyProfileMemoryState();
  const upserted = upsertTemporalProfileFact(emptyState, {
    key: "employment.current",
    value: "Lantern",
    sensitive: false,
    sourceTaskId: "task_1",
    source: "test",
    observedAt: isoDaysAgo(120),
    confidence: 0.95
  });

  const staleMarked = markStaleFactsAsUncertain(
    upserted.nextState,
    90,
    new Date().toISOString()
  );
  const activeFact = staleMarked.nextState.facts.find((fact) => fact.key === "employment.current");

  assert.equal(staleMarked.updatedFactIds.length, 1);
  assert.equal(activeFact?.status, "uncertain");
});

test("assessProfileFactFreshness reports expected stale age", () => {
  const emptyState = createEmptyProfileMemoryState();
  const upserted = upsertTemporalProfileFact(emptyState, {
    key: "employment.current",
    value: "Lantern",
    sensitive: false,
    sourceTaskId: "task_1",
    source: "test",
    observedAt: "2026-01-01T00:00:00.000Z",
    confidence: 0.95
  });
  const fact = upserted.nextState.facts[0];
  const freshness = assessProfileFactFreshness(fact, 30, "2026-02-23T00:00:00.000Z");
  assert.equal(freshness.stale, true);
  assert.equal(freshness.ageDays > 30, true);
});

test("extracts deterministic profile candidates from conversational input", () => {
  const candidates = extractProfileFactCandidatesFromUserInput(
    "I work at Lantern and my address is 123 Main Street. My job is Lantern.",
    "task_profile_extract",
    "2026-02-23T00:00:00.000Z"
  );

  const employment = candidates.find((candidate) => candidate.key === "employment.current");
  const address = candidates.find((candidate) => candidate.key === "address");

  assert.ok(employment);
  assert.equal(employment?.value, "Lantern");
  assert.ok(address);
  assert.equal(address?.sensitive, true);
});

test("extracts commitment-like facts even with noisy punctuation in the key phrase", () => {
  const candidates = extractProfileFactCandidatesFromUserInput(
    "my followup.tax filing is pending. my followup'sda tax filing is pending.",
    "task_profile_noisy_followup",
    "2026-02-25T00:00:00.000Z"
  );

  const dottedFollowup = candidates.find(
    (candidate) => candidate.key === "followup.tax.filing"
  );
  const noisyFollowup = candidates.find(
    (candidate) => candidate.key === "followupsda.tax.filing"
  );

  assert.ok(dottedFollowup);
  assert.equal(dottedFollowup?.value, "pending");
  assert.ok(noisyFollowup);
  assert.equal(noisyFollowup?.value, "pending");
});

test("extracts resolved follow-up markers from natural reminder-suppression phrases", () => {
  const candidates = extractProfileFactCandidatesFromUserInput(
    "Turn off notifications for the vet. I no longer need help with then vet.",
    "task_profile_followup_resolved",
    "2026-02-25T00:00:00.000Z"
  );

  const resolvedFollowup = candidates.find(
    (candidate) => candidate.key === "followup.vet"
  );

  assert.ok(resolvedFollowup);
  assert.equal(resolvedFollowup?.value, "resolved");
});

test("extracts preferred name from direct and past-tense name phrases", () => {
  const candidates = extractProfileFactCandidatesFromUserInput(
    "My name was Avery, and now my name is Avery.",
    "task_profile_name_extract",
    "2026-02-23T00:00:00.000Z"
  );

  const preferredName = candidates.find(
    (candidate) => candidate.key === "identity.preferred_name"
  );
  assert.ok(preferredName);
  assert.equal(preferredName?.value, "Avery");
});

test("extracts preferred name from 'call me' and 'go by' phrases", () => {
  const callMeCandidates = extractProfileFactCandidatesFromUserInput(
    "You can call me Avery.",
    "task_profile_call_me",
    "2026-02-23T00:00:00.000Z"
  );
  const callMeName = callMeCandidates.find(
    (candidate) => candidate.key === "identity.preferred_name"
  );
  assert.ok(callMeName);
  assert.equal(callMeName?.value, "Avery");

  const goByCandidates = extractProfileFactCandidatesFromUserInput(
    "I go by Tony.",
    "task_profile_go_by",
    "2026-02-23T00:00:00.000Z"
  );
  const goByName = goByCandidates.find(
    (candidate) => candidate.key === "identity.preferred_name"
  );
  assert.ok(goByName);
  assert.equal(goByName?.value, "Tony");
});

test("extracts named-contact relationship and work/school associations from narrative phrasing", () => {
  const candidates = extractProfileFactCandidatesFromUserInput(
    "I went to school with a guy named Owen, he also used to work with me at Lantern Studio, a past workplace.",
    "task_profile_named_contact",
    "2026-02-24T00:00:00.000Z"
  );

  const contactName = candidates.find(
    (candidate) => candidate.key === "contact.owen.name"
  );
  const contactRelationship = candidates.find(
    (candidate) => candidate.key === "contact.owen.relationship"
  );
  const schoolAssociation = candidates.find(
    (candidate) => candidate.key === "contact.owen.school_association"
  );
  const workAssociation = candidates.find(
    (candidate) => candidate.key === "contact.owen.work_association"
  );

  assert.ok(contactName);
  assert.equal(contactName?.value, "Owen");
  assert.ok(contactRelationship);
  assert.equal(contactRelationship?.value, "acquaintance");
  assert.ok(schoolAssociation);
  assert.equal(schoolAssociation?.value, "went_to_school_together");
  assert.ok(workAssociation);
  assert.equal(workAssociation?.value, "Lantern Studio");
});

test("extracts work-peer named contact from direct work-with phrasing", () => {
  const candidates = extractProfileFactCandidatesFromUserInput(
    "I used to work with Owen at Lantern Studio.",
    "task_profile_work_with_contact",
    "2026-02-24T00:00:00.000Z"
  );

  const contactName = candidates.find(
    (candidate) => candidate.key === "contact.owen.name"
  );
  const contactRelationship = candidates.find(
    (candidate) => candidate.key === "contact.owen.relationship"
  );
  const workAssociation = candidates.find(
    (candidate) => candidate.key === "contact.owen.work_association"
  );

  assert.ok(contactName);
  assert.equal(contactName?.value, "Owen");
  assert.ok(contactRelationship);
  assert.equal(contactRelationship?.value, "work_peer");
  assert.ok(workAssociation);
  assert.equal(workAssociation?.value, "Lantern Studio");
});

test("extracts dynamic contact context assertions from natural mention phrasing", () => {
  const candidates = extractProfileFactCandidatesFromUserInput(
    "Owen and I went to the high school LCN. Owen likes pasta.",
    "task_profile_contact_context",
    "2026-02-24T00:00:00.000Z"
  );

  const contactName = candidates.find(
    (candidate) => candidate.key === "contact.owen.name"
  );
  const contextFacts = candidates.filter((candidate) =>
    candidate.key.startsWith("contact.owen.context.")
  );

  assert.ok(contactName);
  assert.ok(contextFacts.length >= 1);
  assert.equal(
    contextFacts.some((candidate) => candidate.value.toLowerCase().includes("high school lcn")),
    true
  );
});

test("planning context prioritizes preferred name facts under tight context limits", () => {
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "name",
    value: "Avery",
    sensitive: false,
    sourceTaskId: "task_name",
    source: "test",
    observedAt: "2026-02-20T00:00:00.000Z",
    confidence: 0.95
  }).nextState;

  for (let index = 0; index < 8; index += 1) {
    state = upsertTemporalProfileFact(state, {
      key: `preference.topic_${index}`,
      value: `topic_${index}`,
      sensitive: false,
      sourceTaskId: `task_pref_${index}`,
      source: "test",
      observedAt: `2026-02-2${index}T12:00:00.000Z`,
      confidence: 0.95
    }).nextState;
  }

  const context = buildPlanningContextFromProfile(state, 3);
  assert.match(context, /identity\.preferred_name: Avery/i);
});
