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
import type { EntityGraphV1 } from "../../src/core/types";
import type { ProfileMemoryGraphState } from "../../src/core/profileMemoryRuntime/profileMemoryGraphContracts";

test("queryProfileMemoryGraphAlignedStableRefGroups attaches one exact Stage 6.86 entity key onto a provisional stable ref", () => {
  const observedAt = "2026-04-09T18:00:00.000Z";
  const graph = {
    ...createEmptyProfileMemoryGraphState(observedAt),
    claims: [
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME, {
        claimId: "claim_contact_riley",
        stableRefId: "stable_contact_riley",
        family: "contact.relationship.current",
        normalizedKey: "contact.riley.relationship",
        normalizedValue: "friend",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "task_contact_riley",
        sourceFingerprint: "fingerprint_contact_riley",
        sourceTier: "explicit_user_statement",
        assertedAt: observedAt,
        validFrom: observedAt,
        validTo: null,
        endedAt: null,
        endedByClaimId: null,
        timePrecision: "instant",
        timeSource: "user_stated",
        derivedFromObservationIds: [],
        projectionSourceIds: ["fact_contact_riley"],
        entityRefIds: ["contact.riley"],
        active: true
      })
    ]
  };
  const entityGraph = {
    ...createEmptyEntityGraphV1(observedAt),
    entities: [
      {
        entityKey: buildEntityKey("Rowan Harper", "person", null),
        canonicalName: "Rowan Harper",
        entityType: "person",
        disambiguator: null,
        domainHint: null,
        aliases: ["Riley"],
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        salience: 1,
        evidenceRefs: ["trace:riley"]
      }
    ]
  };

  const groups = queryProfileMemoryGraphAlignedStableRefGroups({
    graph: graph as ProfileMemoryGraphState,
    entityGraph: entityGraph as EntityGraphV1
  });
  const alignedGroup = groups.find((group) => group.stableRefId === "stable_contact_riley");

  assert.equal(alignedGroup?.resolution, "provisional");
  assert.equal(alignedGroup?.primaryEntityKey, buildEntityKey("Rowan Harper", "person", null));
  assert.equal(alignedGroup?.observedEntityKey, buildEntityKey("Rowan Harper", "person", null));
  assert.equal(alignedGroup?.alignmentConfidence, "high");
});

test("queryProfileMemoryGraphAlignedStableRefGroups quarantines low-confidence exact alias alignments", () => {
  const observedAt = "2026-04-09T18:03:00.000Z";
  const graph = {
    ...createEmptyProfileMemoryGraphState(observedAt),
    claims: [
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME, {
        claimId: "claim_contact_riley_inferred",
        stableRefId: "stable_contact_riley",
        family: "contact.relationship.current",
        normalizedKey: "contact.riley.relationship",
        normalizedValue: "friend",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "task_contact_riley_inferred",
        sourceFingerprint: "fingerprint_contact_riley_inferred",
        sourceTier: "assistant_inference",
        assertedAt: observedAt,
        validFrom: observedAt,
        validTo: null,
        endedAt: null,
        endedByClaimId: null,
        timePrecision: "instant",
        timeSource: "inferred",
        derivedFromObservationIds: [],
        projectionSourceIds: ["fact_contact_riley_inferred"],
        entityRefIds: ["contact.riley"],
        active: true
      })
    ]
  };
  const entityGraph = {
    ...createEmptyEntityGraphV1(observedAt),
    entities: [
      {
        entityKey: buildEntityKey("Rowan Harper", "person", null),
        canonicalName: "Rowan Harper",
        entityType: "person",
        disambiguator: null,
        domainHint: null,
        aliases: ["Riley"],
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        salience: 1,
        evidenceRefs: ["trace:riley"]
      }
    ]
  };

  const groups = queryProfileMemoryGraphAlignedStableRefGroups({
    graph: graph as ProfileMemoryGraphState,
    entityGraph: entityGraph as EntityGraphV1
  });
  const alignedGroup = groups.find((group) => group.stableRefId === "stable_contact_riley");

  assert.equal(alignedGroup?.resolution, "quarantined");
  assert.equal(alignedGroup?.alignmentConfidence, "low");
  assert.deepEqual(alignedGroup?.alignmentSourceTiers, ["assistant_inference"]);
  assert.equal(alignedGroup?.primaryEntityKey, null);
  assert.equal(alignedGroup?.observedEntityKey, buildEntityKey("Rowan Harper", "person", null));
});

test("queryProfileMemoryGraphAlignedStableRefGroups fails closed to quarantine when multiple entity identities remain plausible", () => {
  const observedAt = "2026-04-09T18:05:00.000Z";
  const graph = {
    ...createEmptyProfileMemoryGraphState(observedAt),
    claims: [
      createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME, {
        claimId: "claim_contact_riley_ambiguous",
        stableRefId: "stable_contact_riley",
        family: "contact.relationship.current",
        normalizedKey: "contact.riley.relationship",
        normalizedValue: "friend",
        redactionState: "not_requested",
        redactedAt: null,
        sensitive: false,
        sourceTaskId: "task_contact_riley_ambiguous",
        sourceFingerprint: "fingerprint_contact_riley_ambiguous",
        sourceTier: "explicit_user_statement",
        assertedAt: observedAt,
        validFrom: observedAt,
        validTo: null,
        endedAt: null,
        endedByClaimId: null,
        timePrecision: "instant",
        timeSource: "user_stated",
        derivedFromObservationIds: [],
        projectionSourceIds: ["fact_contact_riley_ambiguous"],
        entityRefIds: ["contact.riley"],
        active: true
      })
    ]
  };
  const entityGraph = {
    ...createEmptyEntityGraphV1(observedAt),
    entities: [
      {
        entityKey: buildEntityKey("Rowan Harper", "person", null),
        canonicalName: "Rowan Harper",
        entityType: "person",
        disambiguator: null,
        domainHint: null,
        aliases: ["Riley"],
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        salience: 1,
        evidenceRefs: ["trace:riley_a"]
      },
      {
        entityKey: buildEntityKey("Riley Lee", "person", null),
        canonicalName: "Riley Lee",
        entityType: "person",
        disambiguator: null,
        domainHint: null,
        aliases: ["Riley"],
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        salience: 1,
        evidenceRefs: ["trace:riley_b"]
      }
    ]
  };

  const groups = queryProfileMemoryGraphAlignedStableRefGroups({
    graph: graph as ProfileMemoryGraphState,
    entityGraph: entityGraph as EntityGraphV1
  });
  const alignedGroup = groups.find((group) => group.stableRefId === "stable_contact_riley");

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
        stableRefId: "stable_quarantine_contact_riley",
        family: "episode.candidate",
        title: "Riley ambiguity",
        summary: "Riley stays quarantined until an operator resolves the identity.",
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
        entityRefIds: ["contact.riley"]
      })
    ]
  };
  const entityGraph = {
    ...createEmptyEntityGraphV1(observedAt),
    entities: [
      {
        entityKey: buildEntityKey("Rowan Harper", "person", null),
        canonicalName: "Rowan Harper",
        entityType: "person",
        disambiguator: null,
        domainHint: null,
        aliases: ["Riley"],
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        salience: 1,
        evidenceRefs: ["trace:riley"]
      }
    ]
  };

  const groups = queryProfileMemoryGraphAlignedStableRefGroups({
    graph: graph as ProfileMemoryGraphState,
    entityGraph: entityGraph as EntityGraphV1
  });
  const alignedGroup = groups.find(
    (group) => group.stableRefId === "stable_quarantine_contact_riley"
  );

  assert.equal(alignedGroup?.resolution, "quarantined");
  assert.equal(alignedGroup?.primaryEntityKey, null);
  assert.equal(alignedGroup?.observedEntityKey, buildEntityKey("Rowan Harper", "person", null));
});
