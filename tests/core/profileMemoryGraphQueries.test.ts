/**
 * @fileoverview Tests stable-ref attachment and grouping for graph-backed profile memory.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createSchemaEnvelopeV1 } from "../../src/core/schemaEnvelope";
import {
  PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME
} from "../../src/core/profileMemory";
import { createEmptyProfileMemoryGraphState } from "../../src/core/profileMemoryRuntime/profileMemoryGraphState";
import {
  attachProfileMemoryGraphStableRefs,
  buildProfileMemoryContactStableRefId,
  getProfileMemorySelfStableRefId,
  queryProfileMemoryGraphResolvedCurrentClaims,
  queryProfileMemoryGraphStableRefGroups
} from "../../src/core/profileMemoryRuntime/profileMemoryGraphQueries";

test("attachProfileMemoryGraphStableRefs derives self and contact stable refs on canonical graph records", () => {
  const observedAt = "2026-04-09T14:00:00.000Z";
  const recordedAt = "2026-04-09T14:05:00.000Z";
  const result = attachProfileMemoryGraphStableRefs({
    observations: [
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME, {
        observationId: "observation_self",
        stableRefId: null,
        family: "identity.preferred_name",
        normalizedKey: "identity.preferred_name",
        normalizedValue: "Avery",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "task_self",
        sourceFingerprint: "fingerprint_self",
        sourceTier: "explicit_user_statement",
        assertedAt: observedAt,
        observedAt,
        timePrecision: "instant",
        timeSource: "user_stated",
        entityRefIds: []
      })
    ],
    claims: [
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME, {
        claimId: "claim_contact",
        stableRefId: null,
        family: "contact.relationship.current",
        normalizedKey: "contact.owen.relationship",
        normalizedValue: "friend",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "task_contact",
        sourceFingerprint: "fingerprint_contact",
        sourceTier: "explicit_user_statement",
        assertedAt: observedAt,
        validFrom: observedAt,
        validTo: null,
        endedAt: null,
        endedByClaimId: null,
        timePrecision: "instant",
        timeSource: "user_stated",
        derivedFromObservationIds: [],
        projectionSourceIds: ["fact_contact"],
        entityRefIds: [],
        active: true
      })
    ],
    events: [
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME, {
        eventId: "event_contact",
        stableRefId: null,
        family: "episode.candidate",
        title: "Owen follow-up",
        summary: "Owen still owes the form.",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "task_event",
        sourceFingerprint: "fingerprint_event",
        sourceTier: "explicit_user_statement",
        assertedAt: observedAt,
        observedAt,
        validFrom: observedAt,
        validTo: null,
        timePrecision: "instant",
        timeSource: "user_stated",
        derivedFromObservationIds: [],
        projectionSourceIds: ["episode_contact"],
        entityRefIds: ["contact.owen"]
      })
    ],
    touchedObservationIds: ["observation_self"],
    touchedClaimIds: ["claim_contact"],
    touchedEventIds: ["event_contact"],
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(
    result.nextObservations[0]?.payload.stableRefId,
    getProfileMemorySelfStableRefId()
  );
  assert.equal(
    result.nextClaims[0]?.payload.stableRefId,
    buildProfileMemoryContactStableRefId("owen")
  );
  assert.equal(
    result.nextEvents[0]?.payload.stableRefId,
    buildProfileMemoryContactStableRefId("owen")
  );
});

test("queryProfileMemoryGraphStableRefGroups groups multi-participant events under each derived stable ref", () => {
  const graph = {
    ...createEmptyProfileMemoryGraphState("2026-04-09T14:10:00.000Z"),
    observations: [
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME, {
        observationId: "observation_self",
        stableRefId: getProfileMemorySelfStableRefId(),
        family: "identity.preferred_name",
        normalizedKey: "identity.preferred_name",
        normalizedValue: "Avery",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "task_self",
        sourceFingerprint: "fingerprint_self",
        sourceTier: "explicit_user_statement",
        assertedAt: "2026-04-09T14:10:00.000Z",
        observedAt: "2026-04-09T14:10:00.000Z",
        timePrecision: "instant",
        timeSource: "user_stated",
        entityRefIds: []
      })
    ],
    claims: [
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME, {
        claimId: "claim_contact_owen",
        stableRefId: buildProfileMemoryContactStableRefId("owen"),
        family: "contact.relationship.current",
        normalizedKey: "contact.owen.relationship",
        normalizedValue: "friend",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "task_contact",
        sourceFingerprint: "fingerprint_contact",
        sourceTier: "explicit_user_statement",
        assertedAt: "2026-04-09T14:10:00.000Z",
        validFrom: "2026-04-09T14:10:00.000Z",
        validTo: null,
        endedAt: null,
        endedByClaimId: null,
        timePrecision: "instant",
        timeSource: "user_stated",
        derivedFromObservationIds: [],
        projectionSourceIds: ["fact_contact_owen"],
        entityRefIds: [],
        active: true
      })
    ],
    events: [
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME, {
        eventId: "event_shared",
        stableRefId: null,
        family: "episode.candidate",
        title: "Owen and Maya lunch",
        summary: "Owen and Maya met for lunch.",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "task_event_shared",
        sourceFingerprint: "fingerprint_event_shared",
        sourceTier: "explicit_user_statement",
        assertedAt: "2026-04-09T14:10:00.000Z",
        observedAt: "2026-04-09T14:10:00.000Z",
        validFrom: "2026-04-09T14:10:00.000Z",
        validTo: null,
        timePrecision: "instant",
        timeSource: "user_stated",
        derivedFromObservationIds: [],
        projectionSourceIds: ["episode_shared"],
        entityRefIds: ["contact.owen", "contact.maya"]
      })
    ]
  };

  const groups = queryProfileMemoryGraphStableRefGroups(graph);
  const selfGroup = groups.find(
    (group) => group.stableRefId === getProfileMemorySelfStableRefId()
  );
  const owenGroup = groups.find(
    (group) => group.stableRefId === buildProfileMemoryContactStableRefId("owen")
  );
  const mayaGroup = groups.find(
    (group) => group.stableRefId === buildProfileMemoryContactStableRefId("maya")
  );

  assert.deepEqual(selfGroup?.observationIds, ["observation_self"]);
  assert.deepEqual(owenGroup?.claimIds, ["claim_contact_owen"]);
  assert.deepEqual(owenGroup?.eventIds, ["event_shared"]);
  assert.deepEqual(mayaGroup?.eventIds, ["event_shared"]);
});

test("queryProfileMemoryGraphStableRefGroups marks explicit quarantine refs as quarantined", () => {
  const graph = {
    ...createEmptyProfileMemoryGraphState("2026-04-09T14:15:00.000Z"),
    claims: [
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME, {
        claimId: "claim_contact_quarantine",
        stableRefId: "stable_quarantine_contact_owen",
        family: "contact.relationship.current",
        normalizedKey: "contact.owen.relationship",
        normalizedValue: "friend",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "task_contact_quarantine",
        sourceFingerprint: "fingerprint_contact_quarantine",
        sourceTier: "explicit_user_statement",
        assertedAt: "2026-04-09T14:15:00.000Z",
        validFrom: "2026-04-09T14:15:00.000Z",
        validTo: null,
        endedAt: null,
        endedByClaimId: null,
        timePrecision: "instant",
        timeSource: "user_stated",
        derivedFromObservationIds: [],
        projectionSourceIds: ["fact_contact_quarantine"],
        entityRefIds: [],
        active: true
      })
    ],
    events: [
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME, {
        eventId: "event_contact_quarantine",
        stableRefId: "stable_quarantine_contact_owen",
        family: "episode.candidate",
        title: "Owen ambiguity",
        summary: "Owen may be the same person but stays quarantined.",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "task_event_quarantine",
        sourceFingerprint: "fingerprint_event_quarantine",
        sourceTier: "explicit_user_statement",
        assertedAt: "2026-04-09T14:15:00.000Z",
        observedAt: "2026-04-09T14:15:00.000Z",
        validFrom: "2026-04-09T14:15:00.000Z",
        validTo: null,
        timePrecision: "instant",
        timeSource: "user_stated",
        derivedFromObservationIds: [],
        projectionSourceIds: ["episode_contact_quarantine"],
        entityRefIds: ["contact.owen"]
      })
    ]
  };

  const groups = queryProfileMemoryGraphStableRefGroups(graph);
  const quarantinedGroup = groups.find(
    (group) => group.stableRefId === "stable_quarantine_contact_owen"
  );

  assert.equal(quarantinedGroup?.resolution, "quarantined");
  assert.deepEqual(quarantinedGroup?.claimIds, ["claim_contact_quarantine"]);
  assert.deepEqual(quarantinedGroup?.eventIds, ["event_contact_quarantine"]);
});

test("queryProfileMemoryGraphResolvedCurrentClaims excludes provisional stable refs from resolved_current outputs", () => {
  const graph = {
    ...createEmptyProfileMemoryGraphState("2026-04-09T14:20:00.000Z"),
    claims: [
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME, {
        claimId: "claim_self",
        stableRefId: getProfileMemorySelfStableRefId(),
        family: "identity.preferred_name",
        normalizedKey: "identity.preferred_name",
        normalizedValue: "Avery",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "task_self",
        sourceFingerprint: "fingerprint_self",
        sourceTier: "explicit_user_statement",
        assertedAt: "2026-04-09T14:20:00.000Z",
        validFrom: "2026-04-09T14:20:00.000Z",
        validTo: null,
        endedAt: null,
        endedByClaimId: null,
        timePrecision: "instant",
        timeSource: "user_stated",
        derivedFromObservationIds: [],
        projectionSourceIds: ["fact_self"],
        entityRefIds: [],
        active: true
      }),
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME, {
        claimId: "claim_contact",
        stableRefId: buildProfileMemoryContactStableRefId("owen"),
        family: "contact.relationship.current",
        normalizedKey: "contact.owen.relationship",
        normalizedValue: "friend",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "task_contact",
        sourceFingerprint: "fingerprint_contact",
        sourceTier: "explicit_user_statement",
        assertedAt: "2026-04-09T14:20:00.000Z",
        validFrom: "2026-04-09T14:20:00.000Z",
        validTo: null,
        endedAt: null,
        endedByClaimId: null,
        timePrecision: "instant",
        timeSource: "user_stated",
        derivedFromObservationIds: [],
        projectionSourceIds: ["fact_contact"],
        entityRefIds: [],
        active: true
      }),
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME, {
        claimId: "claim_contact_quarantined",
        stableRefId: "stable_quarantine_contact_owen",
        family: "contact.relationship.current",
        normalizedKey: "contact.owen.relationship",
        normalizedValue: "friend",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "task_contact_quarantined",
        sourceFingerprint: "fingerprint_contact_quarantined",
        sourceTier: "explicit_user_statement",
        assertedAt: "2026-04-09T14:20:00.000Z",
        validFrom: "2026-04-09T14:20:00.000Z",
        validTo: null,
        endedAt: null,
        endedByClaimId: null,
        timePrecision: "instant",
        timeSource: "user_stated",
        derivedFromObservationIds: [],
        projectionSourceIds: ["fact_contact_quarantined"],
        entityRefIds: [],
        active: true
      })
    ]
  };

  const claims = queryProfileMemoryGraphResolvedCurrentClaims(graph);
  assert.deepEqual(claims.map((claim) => claim.payload.claimId), ["claim_self"]);
});
