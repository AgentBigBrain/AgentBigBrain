/**
 * @fileoverview Tests bounded Stage 6.86 entity-key alignment for profile-memory stable refs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createSchemaEnvelopeV1 } from "../../src/core/schemaEnvelope";
import { buildEntityKey, createEmptyEntityGraphV1 } from "../../src/core/stage6_86EntityGraph";
import {
  PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME
} from "../../src/core/profileMemory";
import { createEmptyProfileMemoryGraphState } from "../../src/core/profileMemoryRuntime/profileMemoryGraphState";
import { queryProfileMemoryGraphAlignedStableRefGroups } from "../../src/core/profileMemoryRuntime/profileMemoryGraphAlignmentSupport";

test("queryProfileMemoryGraphAlignedStableRefGroups attaches one exact Stage 6.86 entity key onto a provisional stable ref", () => {
  const observedAt = "2026-04-09T18:00:00.000Z";
  const graph = {
    ...createEmptyProfileMemoryGraphState(observedAt),
    claims: [
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME, {
        claimId: "claim_contact_owen",
        stableRefId: "stable_contact_owen",
        family: "contact.relationship.current",
        normalizedKey: "contact.owen.relationship",
        normalizedValue: "friend",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "task_contact_owen",
        sourceFingerprint: "fingerprint_contact_owen",
        sourceTier: "explicit_user_statement",
        assertedAt: observedAt,
        validFrom: observedAt,
        validTo: null,
        endedAt: null,
        endedByClaimId: null,
        timePrecision: "instant",
        timeSource: "user_stated",
        derivedFromObservationIds: [],
        projectionSourceIds: ["fact_contact_owen"],
        entityRefIds: ["contact.owen"],
        active: true
      })
    ]
  };
  const entityGraph = {
    ...createEmptyEntityGraphV1(observedAt),
    entities: [
      {
        entityKey: buildEntityKey("William Bena", "person", null),
        canonicalName: "William Bena",
        entityType: "person",
        disambiguator: null,
        aliases: ["Owen"],
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        salience: 1,
        evidenceRefs: ["trace:owen"]
      }
    ]
  };

  const groups = queryProfileMemoryGraphAlignedStableRefGroups({
    graph,
    entityGraph
  });
  const alignedGroup = groups.find((group) => group.stableRefId === "stable_contact_owen");

  assert.equal(alignedGroup?.resolution, "provisional");
  assert.equal(alignedGroup?.primaryEntityKey, buildEntityKey("William Bena", "person", null));
  assert.equal(alignedGroup?.observedEntityKey, buildEntityKey("William Bena", "person", null));
});

test("queryProfileMemoryGraphAlignedStableRefGroups fails closed to quarantine when multiple entity identities remain plausible", () => {
  const observedAt = "2026-04-09T18:05:00.000Z";
  const graph = {
    ...createEmptyProfileMemoryGraphState(observedAt),
    claims: [
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME, {
        claimId: "claim_contact_owen_ambiguous",
        stableRefId: "stable_contact_owen",
        family: "contact.relationship.current",
        normalizedKey: "contact.owen.relationship",
        normalizedValue: "friend",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "task_contact_owen_ambiguous",
        sourceFingerprint: "fingerprint_contact_owen_ambiguous",
        sourceTier: "explicit_user_statement",
        assertedAt: observedAt,
        validFrom: observedAt,
        validTo: null,
        endedAt: null,
        endedByClaimId: null,
        timePrecision: "instant",
        timeSource: "user_stated",
        derivedFromObservationIds: [],
        projectionSourceIds: ["fact_contact_owen_ambiguous"],
        entityRefIds: ["contact.owen"],
        active: true
      })
    ]
  };
  const entityGraph = {
    ...createEmptyEntityGraphV1(observedAt),
    entities: [
      {
        entityKey: buildEntityKey("William Bena", "person", null),
        canonicalName: "William Bena",
        entityType: "person",
        disambiguator: null,
        aliases: ["Owen"],
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        salience: 1,
        evidenceRefs: ["trace:owen_a"]
      },
      {
        entityKey: buildEntityKey("Owen Lee", "person", null),
        canonicalName: "Owen Lee",
        entityType: "person",
        disambiguator: null,
        aliases: ["Owen"],
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        salience: 1,
        evidenceRefs: ["trace:owen_b"]
      }
    ]
  };

  const groups = queryProfileMemoryGraphAlignedStableRefGroups({
    graph,
    entityGraph
  });
  const alignedGroup = groups.find((group) => group.stableRefId === "stable_contact_owen");

  assert.equal(alignedGroup?.resolution, "quarantined");
  assert.equal(alignedGroup?.primaryEntityKey, null);
  assert.equal(alignedGroup?.observedEntityKey, null);
});

test("queryProfileMemoryGraphAlignedStableRefGroups preserves observed-only alignment for explicit quarantine refs", () => {
  const observedAt = "2026-04-09T18:10:00.000Z";
  const graph = {
    ...createEmptyProfileMemoryGraphState(observedAt),
    events: [
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME, {
        eventId: "event_contact_quarantine",
        stableRefId: "stable_quarantine_contact_owen",
        family: "episode.candidate",
        title: "Owen ambiguity",
        summary: "Owen stays quarantined until an operator resolves the identity.",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "task_contact_quarantine",
        sourceFingerprint: "fingerprint_contact_quarantine",
        sourceTier: "explicit_user_statement",
        assertedAt: observedAt,
        observedAt,
        validFrom: observedAt,
        validTo: null,
        timePrecision: "instant",
        timeSource: "user_stated",
        derivedFromObservationIds: [],
        projectionSourceIds: ["episode_contact_quarantine"],
        entityRefIds: ["contact.owen"]
      })
    ]
  };
  const entityGraph = {
    ...createEmptyEntityGraphV1(observedAt),
    entities: [
      {
        entityKey: buildEntityKey("William Bena", "person", null),
        canonicalName: "William Bena",
        entityType: "person",
        disambiguator: null,
        aliases: ["Owen"],
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        salience: 1,
        evidenceRefs: ["trace:owen"]
      }
    ]
  };

  const groups = queryProfileMemoryGraphAlignedStableRefGroups({
    graph,
    entityGraph
  });
  const alignedGroup = groups.find(
    (group) => group.stableRefId === "stable_quarantine_contact_owen"
  );

  assert.equal(alignedGroup?.resolution, "quarantined");
  assert.equal(alignedGroup?.primaryEntityKey, null);
  assert.equal(alignedGroup?.observedEntityKey, buildEntityKey("William Bena", "person", null));
});
