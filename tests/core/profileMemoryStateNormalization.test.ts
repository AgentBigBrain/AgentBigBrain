/**
 * @fileoverview Tests canonical profile-memory state normalization helpers behind the runtime subsystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { sha256HexFromCanonicalJson } from "../../src/core/normalizers/canonicalizationRules";
import { createSchemaEnvelopeV1 } from "../../src/core/schemaEnvelope";
import {
  createEmptyProfileMemoryState,
  PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME
} from "../../src/core/profileMemory";
import {
  PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME
} from "../../src/core/profileMemory";
import {
  PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME
} from "../../src/core/profileMemory";
import {
  buildProfileMemoryIngestReceiptKey,
  findProfileMemoryIngestReceipt,
  MAX_PROFILE_MEMORY_INGEST_RECEIPTS
} from "../../src/core/profileMemoryRuntime/profileMemoryIngestIdempotency";
import { reconcileProfileMemoryCurrentClaims } from "../../src/core/profileMemoryRuntime/profileMemoryGraphClaimSupport";
import { redactProfileMemoryGraphFacts } from "../../src/core/profileMemoryRuntime/profileMemoryGraphFactRedactionSupport";
import { backfillProfileMemoryGraphFromLegacyFacts } from "../../src/core/profileMemoryRuntime/profileMemoryGraphLegacyFactBackfillSupport";
import {
  normalizeProfileMemoryState,
  safeIsoOrNow
} from "../../src/core/profileMemoryRuntime/profileMemoryStateNormalization";
import {
  compactProfileMemoryMutationJournalState,
  appendProfileMemoryMutationJournalEntry,
  normalizeProfileMemoryMutationJournalState
} from "../../src/core/profileMemoryRuntime/profileMemoryMutationJournal";
import { upsertProfileMemoryGraphObservations } from "../../src/core/profileMemoryRuntime/profileMemoryGraphObservationSupport";
import {
  redactProfileMemoryGraphEvents,
  upsertProfileMemoryGraphEvents
} from "../../src/core/profileMemoryRuntime/profileMemoryGraphEventSupport";
import type {
  ProfileMemoryGraphClaimPayloadV1,
  ProfileMemoryGraphClaimRecord,
  ProfileMemoryGraphEventPayloadV1,
  ProfileMemoryGraphEventRecord,
  ProfileMemoryGraphObservationPayloadV1,
  ProfileMemoryGraphObservationRecord
} from "../../src/core/profileMemoryRuntime/profileMemoryGraphContracts";

function createPersistedGraphEnvelope<TPayload>(
  schemaName: string,
  payload: TPayload,
  createdAt: string
) {
  return {
    schemaName,
    schemaVersion: "v1" as const,
    createdAt,
    hash: sha256HexFromCanonicalJson(payload),
    payload
  };
}

function lastItem<TItem>(items: readonly TItem[]): TItem | undefined {
  return items[items.length - 1];
}

function createGraphObservationEnvelope(
  payload: ProfileMemoryGraphObservationPayloadV1,
  createdAt?: string
): ProfileMemoryGraphObservationRecord {
  return createSchemaEnvelopeV1(
    PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
    payload,
    createdAt
  ) as ProfileMemoryGraphObservationRecord;
}

function createGraphClaimEnvelope(
  payload: ProfileMemoryGraphClaimPayloadV1,
  createdAt?: string
): ProfileMemoryGraphClaimRecord {
  return createSchemaEnvelopeV1(
    PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
    payload,
    createdAt
  ) as ProfileMemoryGraphClaimRecord;
}

function createGraphEventEnvelope(
  payload: ProfileMemoryGraphEventPayloadV1,
  createdAt?: string
): ProfileMemoryGraphEventRecord {
  return createSchemaEnvelopeV1(
    PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
    payload,
    createdAt
  ) as ProfileMemoryGraphEventRecord;
}

test("safeIsoOrNow falls back to a valid ISO timestamp for invalid input", () => {
  const normalized = safeIsoOrNow("not-a-date");
  assert.equal(Number.isFinite(Date.parse(normalized)), true);
});

test("normalizeProfileMemoryState drops malformed facts and preserves valid mutation audit metadata", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-03-07T00:00:00.000Z",
    episodes: [
      {
        id: "episode_valid",
        title: "Owen fall situation",
        summary: "Owen fell down and the outcome was not mentioned yet.",
        status: "unresolved",
        sourceTaskId: "task_episode_state_normalization",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        confidence: 0.85,
        observedAt: "2026-03-07T00:00:00.000Z",
        lastMentionedAt: "2026-03-07T00:05:00.000Z",
        lastUpdatedAt: "2026-03-07T00:05:00.000Z",
        resolvedAt: null,
        entityRefs: ["entity_owen"],
        openLoopRefs: ["loop_owen"],
        tags: ["followup"]
      },
      {
        id: 5,
        title: "bad episode"
      }
    ],
    facts: [
      {
        id: "fact_valid",
        key: "followup.tax.filing",
        value: "resolved",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_state_normalization",
        source: "user_input_pattern.followup_resolved",
        observedAt: "2026-03-07T00:00:00.000Z",
        confirmedAt: "2026-03-07T00:00:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-03-07T00:00:00.000Z",
        mutationAudit: {
          classifier: "commitment_signal",
          category: "TOPIC_RESOLUTION_CANDIDATE",
          confidenceTier: "HIGH",
          matchedRuleId: "rule_1",
          rulepackVersion: "CommitmentSignalRulepackV1",
          conflict: false
        }
      },
      {
        id: 5,
        key: "bad.fact"
      }
    ]
  });

  assert.equal(normalized.facts.length, 1);
  assert.equal(normalized.episodes.length, 1);
  assert.equal(normalized.episodes[0]?.title, "Owen fall situation");
  assert.equal(normalized.facts[0]?.key, "followup.tax.filing");
  assert.equal(
    normalized.facts[0]?.mutationAudit?.rulepackVersion,
    "CommitmentSignalRulepackV1"
  );
  assert.equal(normalized.graph.claims.length, 1);
});

test("normalizeProfileMemoryState rebuilds additive graph indexes and drops malformed graph payloads", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:00:00.000Z",
    graph: {
      updatedAt: "2026-04-03T20:00:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_1",
          stableRefId: "stable_owen",
          family: "contact.relationship",
          normalizedKey: "contact.owen.relationship",
          normalizedValue: "friend",
          sensitive: false,
          sourceTaskId: "task_profile_graph_normalization",
          sourceFingerprint: "fingerprint_owen_friend",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:00:00.000Z",
          observedAt: "2026-04-03T20:00:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_owen"]
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_1",
          stableRefId: "stable_owen",
          family: "contact.relationship",
          normalizedKey: "contact.owen.relationship",
          normalizedValue: "friend",
          sensitive: false,
          sourceTaskId: "task_profile_graph_normalization",
          sourceFingerprint: "fingerprint_owen_friend",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:00:00.000Z",
          validFrom: "2026-04-03T20:00:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_1"],
          projectionSourceIds: [],
          entityRefIds: ["entity_owen"],
          active: true
        }),
        {
          schemaName: PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
          schemaVersion: "v1",
          createdAt: "2026-04-03T20:00:00.000Z",
          hash: "bad_hash",
          payload: {
            claimId: "claim_profile_graph_bad"
          }
        }
      ],
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_1",
          stableRefId: null,
          family: "episode.candidate",
          title: "Owen fall situation",
          summary: "Owen fell down and the outcome stayed unresolved.",
          sensitive: false,
          sourceTaskId: "task_profile_graph_normalization",
          sourceFingerprint: "fingerprint_owen_friend",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:00:00.000Z",
          observedAt: "2026-04-03T20:00:00.000Z",
          validFrom: "2026-04-03T20:00:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["episode_graph_1"],
          entityRefIds: ["entity_owen"]
        }),
        {
          schemaName: PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
          schemaVersion: "v1",
          createdAt: "2026-04-03T20:00:00.000Z",
          hash: "bad_hash",
          payload: {
            eventId: "event_profile_graph_bad"
          }
        }
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 3,
        entries: [
          {
            journalEntryId: "journal_profile_graph_2",
            watermark: 2,
            recordedAt: "2026-04-03T20:05:00.000Z",
            sourceTaskId: "task_profile_graph_normalization",
            sourceFingerprint: "fingerprint_owen_friend",
            mutationEnvelopeHash: null,
            observationIds: [],
            claimIds: ["claim_profile_graph_1"],
            eventIds: ["event_profile_graph_1"],
            redactionState: "not_requested"
          }
        ]
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {
          rogue: ["bad"]
        },
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.observations.length, 1);
  assert.equal(normalized.graph.claims.length, 1);
  assert.equal(normalized.graph.events.length, 1);
  assert.deepEqual(normalized.graph.indexes.byEntityRefId, {
    entity_owen: ["claim_profile_graph_1", "event_profile_graph_1"]
  });
  assert.deepEqual(normalized.graph.indexes.byFamily, {
    "contact.relationship": ["claim_profile_graph_1"],
    "episode.candidate": ["event_profile_graph_1"]
  });
  assert.deepEqual(normalized.graph.readModel.currentClaimIdsByKey, {
    "contact.owen.relationship": "claim_profile_graph_1"
  });
  assert.equal(normalized.graph.readModel.watermark, 3);
});

test("normalizeProfileMemoryState keeps the existing graph claim inactive when conflicting flat facts remain retained", () => {
  const updatedAt = "2026-04-10T13:30:00.000Z";
  const normalized = normalizeProfileMemoryState({
    updatedAt,
    facts: [
      {
        id: "fact_authoritative_owen_work",
        key: "contact.owen.work_association",
        value: "Lantern Studio",
        sensitive: false,
        status: "confirmed",
        confidence: 0.92,
        sourceTaskId: "task_profile_graph_authoritative_work",
        source: "conversation.relationship_interpretation",
        observedAt: updatedAt,
        confirmedAt: updatedAt,
        supersededAt: null,
        lastUpdatedAt: updatedAt
      },
      {
        id: "fact_conflicting_owen_work",
        key: "contact.owen.work_association",
        value: "Beacon Labs",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_conflicting_work",
        source: "conversation.relationship_interpretation",
        observedAt: updatedAt,
        confirmedAt: updatedAt,
        supersededAt: null,
        lastUpdatedAt: updatedAt
      }
    ],
    graph: {
      updatedAt,
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_authoritative_owen_work",
          stableRefId: "stable_contact_owen",
          family: "contact.work_association",
          normalizedKey: "contact.owen.work_association",
          normalizedValue: "Lantern Studio",
          sensitive: false,
          sourceTaskId: "task_profile_graph_authoritative_work",
          sourceFingerprint: "fingerprint_authoritative_owen_work",
          sourceTier: "explicit_user_statement",
          assertedAt: updatedAt,
          observedAt: updatedAt,
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_contact_owen"]
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_authoritative_owen_work",
          stableRefId: "stable_contact_owen",
          family: "contact.work_association",
          normalizedKey: "contact.owen.work_association",
          normalizedValue: "Lantern Studio",
          sensitive: false,
          sourceTaskId: "task_profile_graph_authoritative_work",
          sourceFingerprint: "fingerprint_authoritative_owen_work",
          sourceTier: "explicit_user_statement",
          assertedAt: updatedAt,
          validFrom: updatedAt,
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_authoritative_owen_work"],
          projectionSourceIds: ["fact_authoritative_owen_work"],
          entityRefIds: ["entity_contact_owen"],
          active: true
        })
      ],
      events: []
    }
  });

  assert.equal(normalized.facts.length, 2);
  const retainedClaim =
    normalized.graph.claims.find(
      (claim) => claim.payload.claimId === "claim_authoritative_owen_work"
    ) ?? null;

  assert.notEqual(retainedClaim, null);
  assert.equal(retainedClaim?.payload.normalizedKey, "contact.owen.work_association");
  assert.equal(retainedClaim?.payload.normalizedValue, "Lantern Studio");
  assert.equal(retainedClaim?.payload.active, false);
});

test("normalizeProfileMemoryState keeps the freshest valid envelope for duplicate graph record ids", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:30:00.000Z",
    graph: {
      updatedAt: "2026-04-03T20:30:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_duplicate",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.1",
          normalizedValue: "Owen fell down",
          sensitive: false,
          sourceTaskId: "task_profile_graph_duplicate_observation_1",
          sourceFingerprint: "fingerprint_profile_graph_duplicate_observation_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:01:00.000Z",
          observedAt: "2026-04-03T20:01:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_owen"]
        }, "2026-04-03T20:01:00.000Z"),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_duplicate",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.1",
          normalizedValue: "Owen recovered later",
          sensitive: false,
          sourceTaskId: "task_profile_graph_duplicate_observation_2",
          sourceFingerprint: "fingerprint_profile_graph_duplicate_observation_2",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:05:00.000Z",
          observedAt: "2026-04-03T20:05:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_owen"]
        }, "2026-04-03T20:05:00.000Z")
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_duplicate",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          sensitive: false,
          sourceTaskId: "task_profile_graph_duplicate_claim_1",
          sourceFingerprint: "fingerprint_profile_graph_duplicate_claim_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:02:00.000Z",
          validFrom: "2026-04-03T20:02:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_duplicate_claim_1"],
          entityRefIds: [],
          active: true
        }, "2026-04-03T20:02:00.000Z"),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_duplicate",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          sensitive: false,
          sourceTaskId: "task_profile_graph_duplicate_claim_2",
          sourceFingerprint: "fingerprint_profile_graph_duplicate_claim_2",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:02:00.000Z",
          validFrom: "2026-04-03T20:02:00.000Z",
          validTo: "2026-04-03T20:06:00.000Z",
          endedAt: "2026-04-03T20:06:00.000Z",
          endedByClaimId: "claim_profile_graph_duplicate_successor",
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_duplicate_claim_2"],
          entityRefIds: [],
          active: false
        }, "2026-04-03T20:06:00.000Z")
      ],
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_duplicate",
          stableRefId: null,
          family: "episode.candidate",
          title: "Owen fall situation",
          summary: "Owen fell down and the outcome was unresolved.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_duplicate_event_1",
          sourceFingerprint: "fingerprint_profile_graph_duplicate_event_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:03:00.000Z",
          observedAt: "2026-04-03T20:03:00.000Z",
          validFrom: "2026-04-03T20:03:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["episode_profile_graph_duplicate_1"],
          entityRefIds: ["entity_owen"]
        }, "2026-04-03T20:03:00.000Z"),
        createGraphEventEnvelope({
          eventId: "event_profile_graph_duplicate",
          stableRefId: null,
          family: "episode.candidate",
          title: "[redacted episode]",
          summary: "[redacted episode details]",
          redactionState: "redacted",
          redactedAt: "2026-04-03T20:07:00.000Z",
          sensitive: true,
          sourceTaskId: "task_profile_graph_duplicate_event_2",
          sourceFingerprint: "fingerprint_profile_graph_duplicate_event_2",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:03:00.000Z",
          observedAt: "2026-04-03T20:03:00.000Z",
          validFrom: "2026-04-03T20:03:00.000Z",
          validTo: "2026-04-03T20:07:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["episode_profile_graph_duplicate_1"],
          entityRefIds: []
        }, "2026-04-03T20:07:00.000Z")
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.observations.length, 1);
  assert.equal(
    normalized.graph.observations[0]?.payload.normalizedValue,
    "Owen recovered later"
  );
  assert.equal(normalized.graph.claims.length, 1);
  assert.equal(normalized.graph.claims[0]?.payload.active, false);
  assert.equal(normalized.graph.events.length, 1);
  assert.equal(normalized.graph.events[0]?.payload.redactionState, "redacted");
  assert.deepEqual(normalized.graph.readModel.currentClaimIdsByKey, {});
});

test("normalizeProfileMemoryState repairs authoritative active claims with same-key different-value conflicts", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T14:00:00.000Z",
    graph: {
      updatedAt: "2026-04-04T14:00:00.000Z",
      observations: [],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_conflict_1",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_conflict_1",
          sourceFingerprint: "fingerprint_profile_graph_conflict_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T13:00:00.000Z",
          validFrom: "2026-04-04T13:00:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_conflict_1"],
          entityRefIds: [],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_conflict_2",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Ava",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_conflict_2",
          sourceFingerprint: "fingerprint_profile_graph_conflict_2",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T13:05:00.000Z",
          validFrom: "2026-04-04T13:05:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_conflict_2"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.claims.length, 2);
  const activeClaims = normalized.graph.claims.filter((claim) => claim.payload.active);
  const inactiveClaims = normalized.graph.claims.filter((claim) => !claim.payload.active);

  assert.equal(activeClaims.length, 1);
  assert.equal(inactiveClaims.length, 1);
  assert.equal(activeClaims[0]?.payload.claimId, "claim_profile_graph_conflict_2");
  assert.equal(inactiveClaims[0]?.payload.claimId, "claim_profile_graph_conflict_1");
  assert.equal(inactiveClaims[0]?.payload.endedByClaimId, "claim_profile_graph_conflict_2");
  assert.equal(inactiveClaims[0]?.payload.validTo, "2026-04-04T14:00:00.000Z");
  assert.equal(inactiveClaims[0]?.payload.endedAt, "2026-04-04T14:00:00.000Z");
  assert.deepEqual(normalized.graph.readModel.currentClaimIdsByKey, {
    "identity.preferred_name": "claim_profile_graph_conflict_2"
  });
  assert.deepEqual(normalized.graph.readModel.conflictingCurrentClaimIdsByKey, {});
  assert.deepEqual(
    normalized.graph.readModel.inventoryClaimIdsByFamily["identity.preferred_name"],
    ["claim_profile_graph_conflict_2"]
  );
  assert.deepEqual(normalized.graph.indexes.activeClaimIds, [
    "claim_profile_graph_conflict_2"
  ]);
});

test("normalizeProfileMemoryState repairs mixed-policy followup active claim conflicts behind the resolved winner", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T01:00:00.000Z",
    graph: {
      updatedAt: "2026-04-05T01:00:00.000Z",
      observations: [],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_followup_pending",
          stableRefId: null,
          family: "generic.profile_fact",
          normalizedKey: "followup.launch",
          normalizedValue: "pending",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_followup_pending",
          sourceFingerprint: "fingerprint_profile_graph_followup_pending",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-05T00:10:00.000Z",
          validFrom: "2026-04-05T00:10:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_followup_pending"],
          entityRefIds: [],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_followup_resolved",
          stableRefId: null,
          family: "followup.resolution",
          normalizedKey: "followup.launch",
          normalizedValue: "resolved",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_followup_resolved",
          sourceFingerprint: "fingerprint_profile_graph_followup_resolved",
          sourceTier: "assistant_inference",
          assertedAt: "2026-04-05T00:12:00.000Z",
          validFrom: "2026-04-05T00:12:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "inferred",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_followup_resolved"],
          entityRefIds: [],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_followup_waiting",
          stableRefId: null,
          family: "generic.profile_fact",
          normalizedKey: "followup.launch",
          normalizedValue: "waiting_on_vendor",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_followup_waiting",
          sourceFingerprint: "fingerprint_profile_graph_followup_waiting",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-05T00:15:00.000Z",
          validFrom: "2026-04-05T00:15:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_followup_waiting"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const activeClaims = normalized.graph.claims.filter((claim) => claim.payload.active);
  const inactiveClaims = normalized.graph.claims.filter((claim) => !claim.payload.active);

  assert.equal(normalized.graph.claims.length, 3);
  assert.equal(activeClaims.length, 1);
  assert.equal(inactiveClaims.length, 2);
  assert.equal(activeClaims[0]?.payload.claimId, "claim_profile_graph_followup_resolved");
  assert.deepEqual(
    inactiveClaims.map((claim) => claim.payload.claimId).sort((left, right) =>
      left.localeCompare(right)
    ),
    [
      "claim_profile_graph_followup_pending",
      "claim_profile_graph_followup_waiting"
    ]
  );
  assert.deepEqual(
    inactiveClaims.map((claim) => claim.payload.endedByClaimId).sort((left, right) =>
      (left ?? "").localeCompare(right ?? "")
    ),
    [
      null,
      null
    ]
  );
  assert.deepEqual(normalized.graph.readModel.currentClaimIdsByKey, {
    "followup.launch": "claim_profile_graph_followup_resolved"
  });
  assert.deepEqual(normalized.graph.readModel.conflictingCurrentClaimIdsByKey, {});
  assert.deepEqual(normalized.graph.readModel.inventoryClaimIdsByFamily["followup.resolution"], [
    "claim_profile_graph_followup_resolved"
  ]);
  assert.deepEqual(normalized.graph.indexes.activeClaimIds, [
    "claim_profile_graph_followup_resolved"
  ]);
});

test("normalizeProfileMemoryState ignores blank-family or blank-key claims in derived family and current-state surfaces", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:00:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:00:00.000Z",
      observations: [],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_blank_guard_valid",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_blank_guard_valid",
          sourceFingerprint: "fingerprint_profile_graph_blank_guard_valid",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T15:00:00.000Z",
          validFrom: "2026-04-04T15:00:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_blank_guard_valid"],
          entityRefIds: [],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_blank_guard_family",
          stableRefId: null,
          family: "   ",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Ava",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_blank_guard_family",
          sourceFingerprint: "fingerprint_profile_graph_blank_guard_family",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T15:05:00.000Z",
          validFrom: "2026-04-04T15:05:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_blank_guard_family"],
          entityRefIds: [],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_blank_guard_key",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "   ",
          normalizedValue: "Ari",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_blank_guard_key",
          sourceFingerprint: "fingerprint_profile_graph_blank_guard_key",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T15:10:00.000Z",
          validFrom: "2026-04-04T15:10:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_blank_guard_key"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_blank_guard_family",
          stableRefId: null,
          family: "   ",
          title: "Old note",
          summary: "Malformed family bucket should stay hidden.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_blank_event_family",
          sourceFingerprint: "fingerprint_profile_graph_blank_event_family",
          sourceTier: "assistant_inference",
          assertedAt: "2026-04-04T15:15:00.000Z",
          observedAt: "2026-04-04T15:15:00.000Z",
          validFrom: "2026-04-04T15:15:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "inferred",
          derivedFromObservationIds: [],
          projectionSourceIds: [],
          entityRefIds: []
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
    "claim_profile_graph_blank_guard_valid"
  );
  assert.deepEqual(normalized.graph.readModel.conflictingCurrentClaimIdsByKey, {});
  assert.deepEqual(
    normalized.graph.readModel.inventoryClaimIdsByFamily["identity.preferred_name"],
    ["claim_profile_graph_blank_guard_valid"]
  );
  assert.deepEqual(normalized.graph.indexes.byFamily, {
    "identity.preferred_name": ["claim_profile_graph_blank_guard_valid"]
  });
  assert.deepEqual(normalized.graph.indexes.activeClaimIds, [
    "claim_profile_graph_blank_guard_family",
    "claim_profile_graph_blank_guard_key",
    "claim_profile_graph_blank_guard_valid"
  ]);
});

test("normalizeProfileMemoryState does not backfill observations or replay markers for blank-family or blank-key active claims", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:05:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:05:00.000Z",
      observations: [],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_blank_replay_family",
          stableRefId: null,
          family: "   ",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_blank_replay_family",
          sourceFingerprint: "fingerprint_profile_graph_blank_replay_family",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T15:00:00.000Z",
          validFrom: "2026-04-04T15:00:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_blank_replay_family"],
          entityRefIds: [],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_blank_replay_key",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "   ",
          normalizedValue: "Ava",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_blank_replay_key",
          sourceFingerprint: "fingerprint_profile_graph_blank_replay_key",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T15:05:00.000Z",
          validFrom: "2026-04-04T15:05:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_blank_replay_key"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.observations.length, 0);
  assert.equal(normalized.graph.mutationJournal.entries.length, 0);
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 1);
  assert.deepEqual(normalized.graph.readModel.currentClaimIdsByKey, {});
});

test("normalizeProfileMemoryState does not backfill replay or current-state surfaces for null-or-blank-valued active claims", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:06:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:06:00.000Z",
      observations: [],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_null_value_replay_null",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: null,
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_null_value_replay_null",
          sourceFingerprint: "fingerprint_profile_graph_null_value_replay_null",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T15:00:00.000Z",
          validFrom: "2026-04-04T15:00:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_null_value_replay_null"],
          entityRefIds: [],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_null_value_replay_blank",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "   ",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_null_value_replay_blank",
          sourceFingerprint: "fingerprint_profile_graph_null_value_replay_blank",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T15:05:00.000Z",
          validFrom: "2026-04-04T15:05:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_null_value_replay_blank"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.observations.length, 0);
  assert.equal(normalized.graph.mutationJournal.entries.length, 0);
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 1);
  assert.deepEqual(normalized.graph.readModel.currentClaimIdsByKey, {});
  assert.deepEqual(normalized.graph.readModel.inventoryClaimIdsByFamily, {});
});

test("normalizeProfileMemoryState keeps preserve-prior graph claim ambiguity visible without backfilling replay or detached lineage", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-06T00:00:00.000Z",
    graph: {
      updatedAt: "2026-04-06T00:00:00.000Z",
      observations: [],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_preserve_conflict_1",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "Lantern",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_preserve_conflict_1",
          sourceFingerprint: "fingerprint_profile_graph_preserve_conflict_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-05T00:10:00.000Z",
          validFrom: "2026-04-05T00:10:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_preserve_conflict_1"],
          entityRefIds: [],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_preserve_conflict_2",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "Northstar",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_preserve_conflict_2",
          sourceFingerprint: "fingerprint_profile_graph_preserve_conflict_2",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-05T00:12:00.000Z",
          validFrom: "2026-04-05T00:12:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_preserve_conflict_2"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const activeClaims = normalized.graph.claims.filter((claim) => claim.payload.active);

  assert.equal(normalized.graph.observations.length, 0);
  assert.equal(normalized.graph.mutationJournal.entries.length, 0);
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 1);
  assert.equal(activeClaims.length, 2);
  assert.deepEqual(
    activeClaims.map((claim) => claim.payload.claimId),
    [
      "claim_profile_graph_preserve_conflict_1",
      "claim_profile_graph_preserve_conflict_2"
    ]
  );
  assert.deepEqual(
    activeClaims.map((claim) => claim.payload.derivedFromObservationIds),
    [[], []]
  );
  assert.deepEqual(normalized.graph.readModel.currentClaimIdsByKey, {});
  assert.deepEqual(normalized.graph.readModel.conflictingCurrentClaimIdsByKey, {
    "employment.current": [
      "claim_profile_graph_preserve_conflict_1",
      "claim_profile_graph_preserve_conflict_2"
    ]
  });
  assert.deepEqual(normalized.graph.readModel.inventoryClaimIdsByFamily, {
    "employment.current": [
      "claim_profile_graph_preserve_conflict_1",
      "claim_profile_graph_preserve_conflict_2"
    ]
  });
  assert.deepEqual(normalized.graph.indexes.activeClaimIds, [
    "claim_profile_graph_preserve_conflict_1",
    "claim_profile_graph_preserve_conflict_2"
  ]);
});

test("normalizeProfileMemoryState keeps support-only retained graph claims canonical-only while preserving end-state claim repair", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-06T00:30:00.000Z",
    graph: {
      updatedAt: "2026-04-06T00:30:00.000Z",
      observations: [],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_support_only_context_1",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.1",
          normalizedValue: "Owen mentioned Lantern",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_support_only_context_1",
          sourceFingerprint: "fingerprint_profile_graph_support_only_context_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-05T00:20:00.000Z",
          validFrom: "2026-04-05T00:20:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_support_only_context_1"],
          entityRefIds: ["entity_owen"],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_followup_resolution_1",
          stableRefId: null,
          family: "followup.resolution",
          normalizedKey: "followup.launch",
          normalizedValue: "resolved",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_followup_resolution_1",
          sourceFingerprint: "fingerprint_profile_graph_followup_resolution_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-05T00:25:00.000Z",
          validFrom: "2026-04-05T00:25:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_followup_resolution_1"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const supportOnlyClaim = normalized.graph.claims.find(
    (claim) => claim.payload.claimId === "claim_profile_graph_support_only_context_1"
  );
  const followupClaim = normalized.graph.claims.find(
    (claim) => claim.payload.claimId === "claim_profile_graph_followup_resolution_1"
  );
  const followupObservation = normalized.graph.observations[0];

  assert.equal(normalized.graph.observations.length, 1);
  assert.ok(supportOnlyClaim);
  assert.ok(followupClaim);
  assert.ok(followupObservation);
  assert.deepEqual(supportOnlyClaim.payload.derivedFromObservationIds, []);
  assert.deepEqual(followupClaim.payload.derivedFromObservationIds, [
    followupObservation.payload.observationId
  ]);
  assert.equal(normalized.graph.mutationJournal.entries.length, 2);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries.flatMap((entry) => entry.observationIds),
    [followupObservation.payload.observationId]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries.flatMap((entry) => entry.claimIds),
    ["claim_profile_graph_followup_resolution_1"]
  );
  assert.deepEqual(normalized.graph.readModel.currentClaimIdsByKey, {
    "followup.launch": "claim_profile_graph_followup_resolution_1"
  });
  assert.deepEqual(normalized.graph.readModel.conflictingCurrentClaimIdsByKey, {});
  assert.deepEqual(normalized.graph.readModel.inventoryClaimIdsByFamily, {
    "followup.resolution": ["claim_profile_graph_followup_resolution_1"]
  });
  assert.deepEqual(normalized.graph.indexes.byFamily, {
    "contact.context": ["claim_profile_graph_support_only_context_1"],
    "followup.resolution": ["claim_profile_graph_followup_resolution_1"]
  });
  assert.deepEqual(normalized.graph.indexes.activeClaimIds, [
    "claim_profile_graph_followup_resolution_1",
    "claim_profile_graph_support_only_context_1"
  ]);
});

test("normalizeProfileMemoryState keeps family-mismatched retained graph claims canonical-only while preserving aligned end-state repair", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-06T00:40:00.000Z",
    graph: {
      updatedAt: "2026-04-06T00:40:00.000Z",
      observations: [],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_family_mismatch_1",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_family_mismatch_1",
          sourceFingerprint: "fingerprint_profile_graph_family_mismatch_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-05T00:30:00.000Z",
          validFrom: "2026-04-05T00:30:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_family_mismatch_1"],
          entityRefIds: [],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_family_mismatch_followup_1",
          stableRefId: null,
          family: "followup.resolution",
          normalizedKey: "followup.launch",
          normalizedValue: "resolved",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_family_mismatch_followup_1",
          sourceFingerprint: "fingerprint_profile_graph_family_mismatch_followup_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-05T00:35:00.000Z",
          validFrom: "2026-04-05T00:35:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_family_mismatch_followup_1"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const mismatchedClaim = normalized.graph.claims.find(
    (claim) => claim.payload.claimId === "claim_profile_graph_family_mismatch_1"
  );
  const followupClaim = normalized.graph.claims.find(
    (claim) => claim.payload.claimId === "claim_profile_graph_family_mismatch_followup_1"
  );
  const followupObservation = normalized.graph.observations[0];

  assert.equal(normalized.graph.observations.length, 1);
  assert.ok(mismatchedClaim);
  assert.ok(followupClaim);
  assert.ok(followupObservation);
  assert.deepEqual(mismatchedClaim.payload.derivedFromObservationIds, []);
  assert.deepEqual(followupClaim.payload.derivedFromObservationIds, [
    followupObservation.payload.observationId
  ]);
  assert.equal(normalized.graph.mutationJournal.entries.length, 2);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries.flatMap((entry) => entry.claimIds),
    ["claim_profile_graph_family_mismatch_followup_1"]
  );
  assert.deepEqual(normalized.graph.readModel.currentClaimIdsByKey, {
    "followup.launch": "claim_profile_graph_family_mismatch_followup_1"
  });
  assert.deepEqual(normalized.graph.readModel.conflictingCurrentClaimIdsByKey, {});
  assert.deepEqual(normalized.graph.readModel.inventoryClaimIdsByFamily, {
    "followup.resolution": ["claim_profile_graph_family_mismatch_followup_1"]
  });
  assert.deepEqual(normalized.graph.indexes.byFamily, {
    "contact.context": ["claim_profile_graph_family_mismatch_1"],
    "followup.resolution": ["claim_profile_graph_family_mismatch_followup_1"]
  });
});

test("normalizeProfileMemoryState keeps family-mismatched retained graph claims out of conflict repair and ambiguity suppression", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-06T00:50:00.000Z",
    graph: {
      updatedAt: "2026-04-06T00:50:00.000Z",
      observations: [],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_mismatch_authoritative",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_mismatch_authoritative",
          sourceFingerprint: "fingerprint_profile_graph_mismatch_authoritative",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-05T00:45:00.000Z",
          validFrom: "2026-04-05T00:45:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_mismatch_authoritative"],
          entityRefIds: [],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_aligned_authoritative",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Ava",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_aligned_authoritative",
          sourceFingerprint: "fingerprint_profile_graph_aligned_authoritative",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-05T00:40:00.000Z",
          validFrom: "2026-04-05T00:40:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_aligned_authoritative"],
          entityRefIds: [],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_mismatch_preserve",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "employment.current",
          normalizedValue: "Lantern",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_mismatch_preserve",
          sourceFingerprint: "fingerprint_profile_graph_mismatch_preserve",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-05T00:47:00.000Z",
          validFrom: "2026-04-05T00:47:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_mismatch_preserve"],
          entityRefIds: [],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_aligned_preserve",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "Northstar",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_aligned_preserve",
          sourceFingerprint: "fingerprint_profile_graph_aligned_preserve",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-05T00:35:00.000Z",
          validFrom: "2026-04-05T00:35:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_aligned_preserve"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const mismatchedAuthoritative = normalized.graph.claims.find(
    (claim) => claim.payload.claimId === "claim_profile_graph_mismatch_authoritative"
  );
  const alignedAuthoritative = normalized.graph.claims.find(
    (claim) => claim.payload.claimId === "claim_profile_graph_aligned_authoritative"
  );
  const mismatchedPreserve = normalized.graph.claims.find(
    (claim) => claim.payload.claimId === "claim_profile_graph_mismatch_preserve"
  );
  const alignedPreserve = normalized.graph.claims.find(
    (claim) => claim.payload.claimId === "claim_profile_graph_aligned_preserve"
  );

  assert.ok(mismatchedAuthoritative);
  assert.ok(alignedAuthoritative);
  assert.ok(mismatchedPreserve);
  assert.ok(alignedPreserve);
  assert.equal(normalized.graph.claims.every((claim) => claim.payload.active), true);
  assert.equal(normalized.graph.observations.length, 2);
  assert.deepEqual(mismatchedAuthoritative.payload.derivedFromObservationIds, []);
  assert.deepEqual(mismatchedPreserve.payload.derivedFromObservationIds, []);
  assert.equal(alignedAuthoritative.payload.derivedFromObservationIds.length, 1);
  assert.equal(alignedPreserve.payload.derivedFromObservationIds.length, 1);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries.flatMap((entry) => entry.claimIds).sort((left, right) =>
      left.localeCompare(right)
    ),
    [
      "claim_profile_graph_aligned_authoritative",
      "claim_profile_graph_aligned_preserve"
    ]
  );
  assert.deepEqual(normalized.graph.readModel.currentClaimIdsByKey, {
    "employment.current": "claim_profile_graph_aligned_preserve",
    "identity.preferred_name": "claim_profile_graph_aligned_authoritative"
  });
  assert.deepEqual(normalized.graph.readModel.conflictingCurrentClaimIdsByKey, {});
  assert.deepEqual(normalized.graph.readModel.inventoryClaimIdsByFamily, {
    "employment.current": ["claim_profile_graph_aligned_preserve"],
    "identity.preferred_name": ["claim_profile_graph_aligned_authoritative"]
  });
});

test("normalizeProfileMemoryState keeps source-tier-invalid retained graph claims out of current surfaces, conflict repair, and ambiguity suppression", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-06T02:10:00.000Z",
    graph: {
      updatedAt: "2026-04-06T02:10:00.000Z",
      observations: [],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_invalid_source_authoritative",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_invalid_source_authoritative",
          sourceFingerprint: "fingerprint_profile_graph_invalid_source_authoritative",
          sourceTier: "assistant_inference",
          assertedAt: "2026-04-06T01:45:00.000Z",
          validFrom: "2026-04-06T01:45:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "inferred",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_invalid_source_authoritative"],
          entityRefIds: [],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_valid_source_authoritative",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Ava",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_valid_source_authoritative",
          sourceFingerprint: "fingerprint_profile_graph_valid_source_authoritative",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-06T01:40:00.000Z",
          validFrom: "2026-04-06T01:40:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_valid_source_authoritative"],
          entityRefIds: [],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_invalid_source_preserve",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "Lantern",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_invalid_source_preserve",
          sourceFingerprint: "fingerprint_profile_graph_invalid_source_preserve",
          sourceTier: "assistant_inference",
          assertedAt: "2026-04-06T01:47:00.000Z",
          validFrom: "2026-04-06T01:47:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "inferred",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_invalid_source_preserve"],
          entityRefIds: [],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_valid_source_preserve",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "Northstar",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_valid_source_preserve",
          sourceFingerprint: "fingerprint_profile_graph_valid_source_preserve",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-06T01:35:00.000Z",
          validFrom: "2026-04-06T01:35:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_valid_source_preserve"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const invalidAuthoritative = normalized.graph.claims.find(
    (claim) => claim.payload.claimId === "claim_profile_graph_invalid_source_authoritative"
  );
  const validAuthoritative = normalized.graph.claims.find(
    (claim) => claim.payload.claimId === "claim_profile_graph_valid_source_authoritative"
  );
  const invalidPreserve = normalized.graph.claims.find(
    (claim) => claim.payload.claimId === "claim_profile_graph_invalid_source_preserve"
  );
  const validPreserve = normalized.graph.claims.find(
    (claim) => claim.payload.claimId === "claim_profile_graph_valid_source_preserve"
  );

  assert.ok(invalidAuthoritative);
  assert.ok(validAuthoritative);
  assert.ok(invalidPreserve);
  assert.ok(validPreserve);
  assert.equal(normalized.graph.claims.every((claim) => claim.payload.active), true);
  assert.equal(normalized.graph.observations.length, 2);
  assert.deepEqual(invalidAuthoritative.payload.derivedFromObservationIds, []);
  assert.deepEqual(invalidPreserve.payload.derivedFromObservationIds, []);
  assert.equal(validAuthoritative.payload.derivedFromObservationIds.length, 1);
  assert.equal(validPreserve.payload.derivedFromObservationIds.length, 1);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries.flatMap((entry) => entry.claimIds).sort((left, right) =>
      left.localeCompare(right)
    ),
    [
      "claim_profile_graph_valid_source_authoritative",
      "claim_profile_graph_valid_source_preserve"
    ]
  );
  assert.deepEqual(normalized.graph.readModel.currentClaimIdsByKey, {
    "employment.current": "claim_profile_graph_valid_source_preserve",
    "identity.preferred_name": "claim_profile_graph_valid_source_authoritative"
  });
  assert.deepEqual(normalized.graph.readModel.conflictingCurrentClaimIdsByKey, {});
  assert.deepEqual(normalized.graph.readModel.inventoryClaimIdsByFamily, {
    "employment.current": ["claim_profile_graph_valid_source_preserve"],
    "identity.preferred_name": ["claim_profile_graph_valid_source_authoritative"]
  });
});

test("normalizeProfileMemoryState dedupes duplicate entity refs inside one retained graph record before index rebuild", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:00:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:00:00.000Z",
      observations: [],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_entity_ref_duplicate",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "Lantern",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_entity_ref_duplicate",
          sourceFingerprint: "fingerprint_profile_graph_entity_ref_duplicate",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T15:55:00.000Z",
          validFrom: "2026-04-04T15:55:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_entity_ref_duplicate"],
          entityRefIds: ["entity_lantern", "entity_lantern", "entity_lantern"],
          active: true
        })
      ],
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_entity_ref_duplicate",
          stableRefId: null,
          family: "episode.candidate",
          title: "Lantern sync",
          summary: "Lantern sync happened.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_entity_ref_duplicate_event",
          sourceFingerprint: "fingerprint_profile_graph_entity_ref_duplicate_event",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T15:56:00.000Z",
          observedAt: "2026-04-04T15:56:00.000Z",
          validFrom: "2026-04-04T15:56:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["episode_profile_graph_entity_ref_duplicate"],
          entityRefIds: ["entity_lantern", "entity_lantern"]
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        conflictingCurrentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.deepEqual(normalized.graph.indexes.byEntityRefId, {
    entity_lantern: [
      "claim_profile_graph_entity_ref_duplicate",
      "event_profile_graph_entity_ref_duplicate"
    ]
  });
});

test("normalizeProfileMemoryState prunes duplicate and dangling observation lineage refs from retained claims and events", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:10:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:10:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_lineage_valid",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.1",
          normalizedValue: "Owen mentioned Lantern.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_lineage_valid",
          sourceFingerprint: "fingerprint_profile_graph_lineage_valid",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:05:00.000Z",
          observedAt: "2026-04-04T16:05:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_owen"]
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_lineage_duplicate",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "Lantern",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_lineage_duplicate",
          sourceFingerprint: "fingerprint_profile_graph_lineage_duplicate",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:05:00.000Z",
          validFrom: "2026-04-04T16:05:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [
            "observation_profile_graph_lineage_valid",
            "observation_profile_graph_lineage_missing",
            "observation_profile_graph_lineage_valid"
          ],
          projectionSourceIds: ["fact_profile_graph_lineage_duplicate"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_lineage_duplicate",
          stableRefId: null,
          family: "episode.candidate",
          title: "Lantern mention",
          summary: "Owen mentioned Lantern.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_lineage_duplicate_event",
          sourceFingerprint: "fingerprint_profile_graph_lineage_duplicate_event",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:05:00.000Z",
          observedAt: "2026-04-04T16:05:00.000Z",
          validFrom: "2026-04-04T16:05:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [
            "observation_profile_graph_lineage_valid",
            "observation_profile_graph_lineage_missing",
            "observation_profile_graph_lineage_valid"
          ],
          projectionSourceIds: ["episode_profile_graph_lineage_duplicate"],
          entityRefIds: ["entity_owen"]
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        conflictingCurrentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.deepEqual(
    normalized.graph.claims[0]?.payload.derivedFromObservationIds,
    ["observation_profile_graph_lineage_valid"]
  );
  assert.deepEqual(
    normalized.graph.events[0]?.payload.derivedFromObservationIds,
    ["observation_profile_graph_lineage_valid"]
  );
});

test("normalizeProfileMemoryState prunes conflicting same-lane claim lineage refs while keeping unrelated supporting observations", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:12:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:12:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_lineage_supporting_context",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.1",
          normalizedValue: "Owen called the user Avery.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_lineage_supporting_context",
          sourceFingerprint: "fingerprint_profile_graph_lineage_supporting_context",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:05:00.000Z",
          observedAt: "2026-04-04T16:05:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_owen"]
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_lineage_conflicting_same_lane",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Ava",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_lineage_conflicting_same_lane",
          sourceFingerprint: "fingerprint_profile_graph_lineage_conflicting_same_lane",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:05:30.000Z",
          observedAt: "2026-04-04T16:05:30.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_lineage_supporting_context_only",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_lineage_supporting_context_only",
          sourceFingerprint: "fingerprint_profile_graph_lineage_supporting_context_only",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:06:00.000Z",
          validFrom: "2026-04-04T16:06:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [
            "observation_profile_graph_lineage_supporting_context",
            "observation_profile_graph_lineage_conflicting_same_lane"
          ],
          projectionSourceIds: ["fact_profile_graph_lineage_supporting_context_only"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        conflictingCurrentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 2048,
        maxClaimCount: 2048,
        maxEventCount: 1024,
        maxJournalEntries: 64
      }
    }
  });

  assert.equal(normalized.graph.observations.length, 2);
  assert.equal(normalized.graph.mutationJournal.entries.length, 2);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    normalized.graph.observations
      .map((observation) => observation.payload.observationId)
      .sort((left, right) => left.localeCompare(right))
  );
  assert.equal(
    normalized.graph.mutationJournal.entries[0]?.sourceFingerprint?.startsWith(
      "graph_observation_replay_backfill_"
    ),
    true
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[1]?.claimIds,
    ["claim_profile_graph_lineage_supporting_context_only"]
  );
  assert.equal(
    normalized.graph.mutationJournal.entries[1]?.sourceFingerprint?.startsWith(
      "graph_claim_replay_backfill_"
    ),
    true
  );
  assert.deepEqual(
    normalized.graph.claims[0]?.payload.derivedFromObservationIds,
    ["observation_profile_graph_lineage_supporting_context"]
  );
  assert.equal(
    normalized.graph.observations.some(
      (observation) =>
        observation.payload.observationId ===
        "observation_profile_graph_lineage_conflicting_same_lane"
    ),
    true
  );
});

test("normalizeProfileMemoryState prunes malformed claim successor refs", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:15:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:15:00.000Z",
      observations: [],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_successor_dangling",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "OldCo",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_successor_dangling",
          sourceFingerprint: "fingerprint_profile_graph_successor_dangling",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:05:00.000Z",
          validFrom: "2026-04-04T16:05:00.000Z",
          validTo: "2026-04-04T16:06:00.000Z",
          endedAt: "2026-04-04T16:06:00.000Z",
          endedByClaimId: "claim_profile_graph_successor_missing",
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_successor_dangling"],
          entityRefIds: [],
          active: false
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_successor_active_stray",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "Lantern",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_successor_active_stray",
          sourceFingerprint: "fingerprint_profile_graph_successor_active_stray",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:07:00.000Z",
          validFrom: "2026-04-04T16:07:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: "claim_profile_graph_successor_valid",
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_successor_active_stray"],
          entityRefIds: [],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_successor_closed_valid",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Ava",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_successor_closed_valid",
          sourceFingerprint: "fingerprint_profile_graph_successor_closed_valid",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:08:00.000Z",
          validFrom: "2026-04-04T16:08:00.000Z",
          validTo: "2026-04-04T16:09:00.000Z",
          endedAt: "2026-04-04T16:09:00.000Z",
          endedByClaimId: "claim_profile_graph_successor_valid",
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_successor_closed_valid"],
          entityRefIds: [],
          active: false
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_successor_valid",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "June",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_successor_valid",
          sourceFingerprint: "fingerprint_profile_graph_successor_valid",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:09:00.000Z",
          validFrom: "2026-04-04T16:09:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_successor_valid"],
          entityRefIds: [],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_successor_wrong_key",
          stableRefId: null,
          family: "contact.owen.relationship",
          normalizedKey: "contact.owen.relationship",
          normalizedValue: "friend",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_successor_wrong_key",
          sourceFingerprint: "fingerprint_profile_graph_successor_wrong_key",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:04:00.000Z",
          validFrom: "2026-04-04T16:04:00.000Z",
          validTo: "2026-04-04T16:05:00.000Z",
          endedAt: "2026-04-04T16:05:00.000Z",
          endedByClaimId: "claim_profile_graph_successor_valid",
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_successor_wrong_key"],
          entityRefIds: [],
          active: false
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        conflictingCurrentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const claimById = new Map(
    normalized.graph.claims.map((claim) => [claim.payload.claimId, claim] as const)
  );
  assert.equal(
    claimById.get("claim_profile_graph_successor_dangling")?.payload.endedByClaimId,
    null
  );
  assert.equal(
    claimById.get("claim_profile_graph_successor_active_stray")?.payload.endedByClaimId,
    null
  );
  assert.equal(
    claimById.get("claim_profile_graph_successor_closed_valid")?.payload.endedByClaimId,
    "claim_profile_graph_successor_valid"
  );
  assert.equal(
    claimById.get("claim_profile_graph_successor_wrong_key")?.payload.endedByClaimId,
    null
  );
});

test("normalizeProfileMemoryState repairs malformed claim lifecycle boundaries", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:16:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:16:00.000Z",
      observations: [],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_lifecycle_active_stray",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "Lantern",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_lifecycle_active_stray",
          sourceFingerprint: "fingerprint_profile_graph_lifecycle_active_stray",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:01:00.000Z",
          validFrom: "2026-04-04T16:01:00.000Z",
          validTo: "2026-04-04T16:02:00.000Z",
          endedAt: "2026-04-04T16:02:00.000Z",
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_lifecycle_active_stray"],
          entityRefIds: [],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_lifecycle_inactive_mismatch",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_lifecycle_inactive_mismatch",
          sourceFingerprint: "fingerprint_profile_graph_lifecycle_inactive_mismatch",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:03:00.000Z",
          validFrom: "2026-04-04T16:03:00.000Z",
          validTo: "2026-04-04T16:05:00.000Z",
          endedAt: "2026-04-04T16:04:00.000Z",
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_lifecycle_inactive_mismatch"],
          entityRefIds: [],
          active: false
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_lifecycle_redacted_active",
          stableRefId: "stable_owen",
          family: "contact.owen.relationship",
          normalizedKey: "contact.owen.relationship",
          normalizedValue: "friend",
          redactionState: "redacted",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_lifecycle_redacted_active",
          sourceFingerprint: "fingerprint_profile_graph_lifecycle_redacted_active",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:06:00.000Z",
          validFrom: "2026-04-04T16:06:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_lifecycle_redacted_active"],
          entityRefIds: ["entity_owen"],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        conflictingCurrentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const claimById = new Map(
    normalized.graph.claims.map((claim) => [claim.payload.claimId, claim] as const)
  );
  assert.equal(
    claimById.get("claim_profile_graph_lifecycle_active_stray")?.payload.validTo,
    null
  );
  assert.equal(
    claimById.get("claim_profile_graph_lifecycle_active_stray")?.payload.endedAt,
    null
  );
  assert.equal(
    claimById.get("claim_profile_graph_lifecycle_inactive_mismatch")?.payload.validTo,
    "2026-04-04T16:04:00.000Z"
  );
  assert.equal(
    claimById.get("claim_profile_graph_lifecycle_inactive_mismatch")?.payload.endedAt,
    "2026-04-04T16:04:00.000Z"
  );
  assert.equal(
    claimById.get("claim_profile_graph_lifecycle_redacted_active")?.payload.active,
    false
  );
  assert.equal(
    claimById.get("claim_profile_graph_lifecycle_redacted_active")?.payload.normalizedValue,
    null
  );
  assert.equal(
    claimById.get("claim_profile_graph_lifecycle_redacted_active")?.payload.validTo,
    "2026-04-04T16:16:00.000Z"
  );
  assert.equal(
    claimById.get("claim_profile_graph_lifecycle_redacted_active")?.payload.endedAt,
    "2026-04-04T16:16:00.000Z"
  );
  assert.equal(
    claimById.get("claim_profile_graph_lifecycle_redacted_active")?.payload.redactedAt,
    "2026-04-04T16:16:00.000Z"
  );
  assert.equal(
    claimById.get("claim_profile_graph_lifecycle_redacted_active")?.payload.sensitive,
    true
  );
  assert.equal(
    claimById.get("claim_profile_graph_lifecycle_redacted_active")?.payload.stableRefId,
    null
  );
  assert.deepEqual(
    claimById.get("claim_profile_graph_lifecycle_redacted_active")?.payload.entityRefIds,
    []
  );
});

test("normalizeProfileMemoryState repairs malformed graph timestamps before lifecycle normalization", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:17:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:17:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_time_redacted_invalid",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "redacted",
          redactedAt: "not-a-date",
          sensitive: false,
          sourceTaskId: "task_profile_graph_time_observation",
          sourceFingerprint: "fingerprint_profile_graph_time_observation",
          sourceTier: "explicit_user_statement",
          assertedAt: "bad-asserted-at",
          observedAt: "bad-observed-at",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_time_redacted_invalid",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "Lantern",
          redactionState: "redacted",
          redactedAt: "bad-redacted-at",
          sensitive: false,
          sourceTaskId: "task_profile_graph_time_claim",
          sourceFingerprint: "fingerprint_profile_graph_time_claim",
          sourceTier: "explicit_user_statement",
          assertedAt: "bad-asserted-at",
          validFrom: "bad-valid-from",
          validTo: "bad-valid-to",
          endedAt: "bad-ended-at",
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_time_claim"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_time_redacted_invalid",
          stableRefId: null,
          family: "episode.candidate",
          title: "Raw forgotten title",
          summary: "Raw forgotten summary.",
          redactionState: "redacted",
          redactedAt: "bad-redacted-at",
          sensitive: false,
          sourceTaskId: "task_profile_graph_time_event",
          sourceFingerprint: "fingerprint_profile_graph_time_event",
          sourceTier: "explicit_user_statement",
          assertedAt: "bad-asserted-at",
          observedAt: "bad-observed-at",
          validFrom: "bad-valid-from",
          validTo: "bad-valid-to",
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["episode_profile_graph_time_event"],
          entityRefIds: []
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      }
    }
  });

  const observation = normalized.graph.observations.find(
    (entry) => entry.payload.observationId === "observation_profile_graph_time_redacted_invalid"
  );
  const claim = normalized.graph.claims.find(
    (entry) => entry.payload.claimId === "claim_profile_graph_time_redacted_invalid"
  );
  const event = normalized.graph.events.find(
    (entry) => entry.payload.eventId === "event_profile_graph_time_redacted_invalid"
  );

  assert.equal(observation?.payload.assertedAt, "2026-04-04T16:17:00.000Z");
  assert.equal(observation?.payload.observedAt, "2026-04-04T16:17:00.000Z");
  assert.equal(observation?.payload.redactedAt, "2026-04-04T16:17:00.000Z");

  assert.equal(claim?.payload.assertedAt, "2026-04-04T16:17:00.000Z");
  assert.equal(claim?.payload.validFrom, null);
  assert.equal(claim?.payload.validTo, "2026-04-04T16:17:00.000Z");
  assert.equal(claim?.payload.endedAt, "2026-04-04T16:17:00.000Z");
  assert.equal(claim?.payload.redactedAt, "2026-04-04T16:17:00.000Z");
  assert.equal(claim?.payload.active, false);

  assert.equal(event?.payload.assertedAt, "2026-04-04T16:17:00.000Z");
  assert.equal(event?.payload.observedAt, "2026-04-04T16:17:00.000Z");
  assert.equal(event?.payload.validFrom, null);
  assert.equal(event?.payload.validTo, "2026-04-04T16:17:00.000Z");
  assert.equal(event?.payload.redactedAt, "2026-04-04T16:17:00.000Z");
  assert.equal(event?.payload.title, "[redacted episode]");
  assert.equal(event?.payload.summary, "[redacted episode details]");
});

test("normalizeProfileMemoryState trims padded graph payload timestamps before lifecycle normalization", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:20:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:20:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_time_trimmed",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "redacted",
          redactedAt: " 2026-04-04T11:13:00-05:00 ",
          sensitive: false,
          sourceTaskId: "task_profile_graph_time_trimmed_observation",
          sourceFingerprint: "fingerprint_profile_graph_time_trimmed_observation",
          sourceTier: "explicit_user_statement",
          assertedAt: " 2026-04-04T11:11:00-05:00 ",
          observedAt: " 2026-04-04T11:12:00-05:00 ",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_time_trimmed",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "Lantern",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_time_trimmed_claim",
          sourceFingerprint: "fingerprint_profile_graph_time_trimmed_claim",
          sourceTier: "explicit_user_statement",
          assertedAt: " 2026-04-04T11:14:00-05:00 ",
          validFrom: " 2026-04-04T11:15:00-05:00 ",
          validTo: " 2026-04-04T11:16:00-05:00 ",
          endedAt: " 2026-04-04T11:16:00-05:00 ",
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_time_trimmed_claim"],
          entityRefIds: [],
          active: false
        })
      ],
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_time_trimmed",
          stableRefId: null,
          family: "episode.candidate",
          title: "Owen fall situation",
          summary: "Owen fell and later recovered.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_time_trimmed_event",
          sourceFingerprint: "fingerprint_profile_graph_time_trimmed_event",
          sourceTier: "explicit_user_statement",
          assertedAt: " 2026-04-04T11:17:00-05:00 ",
          observedAt: " 2026-04-04T11:18:00-05:00 ",
          validFrom: " 2026-04-04T11:19:00-05:00 ",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["episode_profile_graph_time_trimmed_event"],
          entityRefIds: []
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      }
    }
  });

  const observation = normalized.graph.observations.find(
    (entry) => entry.payload.observationId === "observation_profile_graph_time_trimmed"
  );
  const claim = normalized.graph.claims.find(
    (entry) => entry.payload.claimId === "claim_profile_graph_time_trimmed"
  );
  const event = normalized.graph.events.find(
    (entry) => entry.payload.eventId === "event_profile_graph_time_trimmed"
  );

  assert.equal(observation?.payload.assertedAt, "2026-04-04T16:11:00.000Z");
  assert.equal(observation?.payload.observedAt, "2026-04-04T16:12:00.000Z");
  assert.equal(observation?.payload.redactedAt, "2026-04-04T16:13:00.000Z");

  assert.equal(claim?.payload.assertedAt, "2026-04-04T16:14:00.000Z");
  assert.equal(claim?.payload.validFrom, "2026-04-04T16:15:00.000Z");
  assert.equal(claim?.payload.validTo, "2026-04-04T16:16:00.000Z");
  assert.equal(claim?.payload.endedAt, "2026-04-04T16:16:00.000Z");
  assert.equal(claim?.payload.active, false);

  assert.equal(event?.payload.assertedAt, "2026-04-04T16:17:00.000Z");
  assert.equal(event?.payload.observedAt, "2026-04-04T16:18:00.000Z");
  assert.equal(event?.payload.validFrom, "2026-04-04T16:19:00.000Z");
  assert.equal(event?.payload.validTo, null);
});

test("normalizeProfileMemoryState trims padded graph semantic identity, clears blank optional graph metadata, and recovers blank journal ids", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:17:30.000Z",
    graph: {
      updatedAt: "2026-04-04T16:17:30.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_metadata_blank",
          stableRefId: "   ",
          family: " identity.preferred_name ",
          normalizedKey: " identity.preferred_name ",
          normalizedValue: " Avery ",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "   ",
          sourceFingerprint: "   ",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:16:00.000Z",
          observedAt: "2026-04-04T16:16:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_metadata_blank",
          stableRefId: " stable_avery ",
          family: " identity.preferred_name ",
          normalizedKey: " identity.preferred_name ",
          normalizedValue: " Avery ",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "   ",
          sourceFingerprint: " fingerprint_profile_graph_metadata_blank ",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:16:00.000Z",
          validFrom: "2026-04-04T16:16:00.000Z",
          validTo: "2026-04-04T16:16:30.000Z",
          endedAt: "2026-04-04T16:16:30.000Z",
          endedByClaimId: "claim_profile_graph_metadata_blank_successor",
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_metadata_blank"],
          projectionSourceIds: ["fact_profile_graph_metadata_blank"],
          entityRefIds: [],
          active: false
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_metadata_blank_successor",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_metadata_blank_successor",
          sourceFingerprint: "fingerprint_profile_graph_metadata_blank_successor",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:16:30.000Z",
          validFrom: "2026-04-04T16:16:30.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_metadata_blank_successor"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_metadata_blank",
          stableRefId: "   ",
          family: " episode.candidate ",
          title: "Avery follow-up",
          summary: "Avery followed up later.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: " task_profile_graph_metadata_event ",
          sourceFingerprint: "   ",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:16:00.000Z",
          observedAt: "2026-04-04T16:16:00.000Z",
          validFrom: "2026-04-04T16:16:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_metadata_blank"],
          projectionSourceIds: ["episode_profile_graph_metadata_blank"],
          entityRefIds: []
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 3,
        entries: [
          {
            journalEntryId: "   ",
            watermark: 1,
            recordedAt: "2026-04-04T16:16:00.000Z",
            sourceTaskId: "   ",
            sourceFingerprint: "   ",
            mutationEnvelopeHash: "   ",
            observationIds: ["observation_profile_graph_metadata_blank"],
            claimIds: ["claim_profile_graph_metadata_blank"],
            eventIds: ["event_profile_graph_metadata_blank"],
            redactionState: "not_requested"
          },
          {
            journalEntryId: " journal_profile_graph_metadata_keep ",
            watermark: 2,
            recordedAt: "2026-04-04T16:16:30.000Z",
            sourceTaskId: "   ",
            sourceFingerprint: "   ",
            mutationEnvelopeHash: "   ",
            observationIds: ["observation_profile_graph_metadata_blank"],
            claimIds: ["claim_profile_graph_metadata_blank"],
            eventIds: ["event_profile_graph_metadata_blank"],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  const observation = normalized.graph.observations.find(
    (entry) => entry.payload.observationId === "observation_profile_graph_metadata_blank"
  );
  const claim = normalized.graph.claims.find(
    (entry) => entry.payload.claimId === "claim_profile_graph_metadata_blank"
  );
  const event = normalized.graph.events.find(
    (entry) => entry.payload.eventId === "event_profile_graph_metadata_blank"
  );

  assert.equal(observation?.payload.stableRefId, "stable_self_profile_owner");
  assert.equal(observation?.payload.family, "identity.preferred_name");
  assert.equal(observation?.payload.normalizedKey, "identity.preferred_name");
  assert.equal(observation?.payload.normalizedValue, "Avery");
  assert.equal(observation?.payload.sourceTaskId, null);
  assert.equal(
    observation?.payload.sourceFingerprint,
    `graph_observation_source_${sha256HexFromCanonicalJson({
      observationId: "observation_profile_graph_metadata_blank"
    }).slice(0, 24)}`
  );
  assert.equal(claim?.payload.stableRefId, "stable_avery");
  assert.equal(claim?.payload.family, "identity.preferred_name");
  assert.equal(claim?.payload.normalizedKey, "identity.preferred_name");
  assert.equal(claim?.payload.normalizedValue, "Avery");
  assert.equal(claim?.payload.sourceTaskId, null);
  assert.equal(claim?.payload.sourceFingerprint, "fingerprint_profile_graph_metadata_blank");
  assert.equal(
    claim?.payload.endedByClaimId,
    "claim_profile_graph_metadata_blank_successor"
  );
  assert.equal(event?.payload.stableRefId, "stable_self_profile_owner");
  assert.equal(event?.payload.family, "episode.candidate");
  assert.equal(event?.payload.sourceTaskId, "task_profile_graph_metadata_event");
  assert.equal(
    event?.payload.sourceFingerprint,
    `graph_event_source_${sha256HexFromCanonicalJson({
      eventId: "event_profile_graph_metadata_blank"
    }).slice(0, 24)}`
  );
  const recoveredJournalEntryId =
    `journal_${sha256HexFromCanonicalJson({
      recordedAt: "2026-04-04T16:16:00.000Z",
      sourceTaskId: null,
      sourceFingerprint: null,
      mutationEnvelopeHash: null,
      observationIds: ["observation_profile_graph_metadata_blank"],
      claimIds: ["claim_profile_graph_metadata_blank"],
      eventIds: ["event_profile_graph_metadata_blank"],
      redactionState: "not_requested"
    }).slice(0, 24)}`;
  const recoveredJournalEntry = normalized.graph.mutationJournal.entries.find(
    (entry) => entry.journalEntryId === recoveredJournalEntryId
  );
  const keptJournalEntry = normalized.graph.mutationJournal.entries.find(
    (entry) => entry.journalEntryId === "journal_profile_graph_metadata_keep"
  );
  assert.equal(normalized.graph.mutationJournal.entries.length, 4);
  assert.ok(recoveredJournalEntry);
  assert.equal(recoveredJournalEntry?.sourceTaskId, null);
  assert.equal(recoveredJournalEntry?.sourceFingerprint, null);
  assert.equal(recoveredJournalEntry?.mutationEnvelopeHash, null);
  assert.ok(keptJournalEntry);
  assert.equal(keptJournalEntry?.sourceTaskId, null);
  assert.equal(keptJournalEntry?.sourceFingerprint, null);
  assert.equal(keptJournalEntry?.mutationEnvelopeHash, null);
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
    "claim_profile_graph_metadata_blank_successor"
  );
});

test("normalizeProfileMemoryState preserves stable refs across legacy fact backfill repair", () => {
  const recordedAt = "2026-04-09T15:00:00.000Z";
  const normalized = normalizeProfileMemoryState({
    updatedAt: recordedAt,
    facts: [
      {
        id: "profile_fact_stable_ref_backfill",
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_stable_ref_backfill",
        source: "user_input_pattern.name_phrase",
        observedAt: recordedAt,
        confirmedAt: recordedAt,
        supersededAt: null,
        lastUpdatedAt: recordedAt
      }
    ],
    graph: {
      updatedAt: recordedAt,
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_stable_ref_backfill",
            stableRefId: "stable_self_profile_owner",
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_stable_ref_backfill",
            sourceFingerprint: "fingerprint_profile_graph_stable_ref_backfill_observation",
            sourceTier: "explicit_user_statement",
            assertedAt: recordedAt,
            observedAt: recordedAt,
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          recordedAt
        )
      ],
      claims: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
          {
            claimId: "claim_profile_graph_stable_ref_backfill",
            stableRefId: "stable_self_profile_owner",
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_stable_ref_backfill",
            sourceFingerprint: "fingerprint_profile_graph_stable_ref_backfill_claim",
            sourceTier: "explicit_user_statement",
            assertedAt: recordedAt,
            validFrom: recordedAt,
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_stable_ref_backfill"],
            projectionSourceIds: ["profile_fact_stable_ref_backfill"],
            entityRefIds: [],
            active: true
          },
          recordedAt
        )
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 2,
        entries: [
          {
            journalEntryId: "journal_profile_graph_stable_ref_backfill",
            watermark: 1,
            recordedAt,
            sourceTaskId: "task_profile_graph_stable_ref_backfill",
            sourceFingerprint: "fingerprint_profile_graph_stable_ref_backfill_observation",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_stable_ref_backfill"],
            claimIds: ["claim_profile_graph_stable_ref_backfill"],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  const claim = normalized.graph.claims.find(
    (entry) => entry.payload.claimId === "claim_profile_graph_stable_ref_backfill"
  );
  assert.equal(claim?.payload.stableRefId, "stable_self_profile_owner");
});

test("normalizeProfileMemoryState preserves durable graph decision records for stable-ref rekey history", () => {
  const recordedAt = "2026-04-09T16:35:00.000Z";
  const normalized = normalizeProfileMemoryState({
    updatedAt: recordedAt,
    graph: {
      updatedAt: recordedAt,
      observations: [],
      claims: [],
      events: [],
      decisionRecords: [
        {
          action: "rekey",
          recordedAt: ` ${recordedAt} `,
          fromStableRefId: " stable_contact_owen ",
          toStableRefId: " stable_contact_owen_primary ",
          sourceTaskId: " task_profile_graph_stable_ref_rekey ",
          sourceFingerprint: " fingerprint_profile_graph_stable_ref_rekey ",
          mutationEnvelopeHash: " mutation_envelope_profile_graph_stable_ref_rekey ",
          observationIds: [
            " observation_profile_graph_stable_ref_rekey ",
            " observation_profile_graph_stable_ref_rekey "
          ],
          claimIds: [" claim_profile_graph_stable_ref_rekey "],
          eventIds: [" event_profile_graph_stable_ref_rekey "]
        }
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      }
    }
  });

  const decisionPayload = {
    action: "rekey",
    recordedAt,
    fromStableRefId: "stable_contact_owen",
    toStableRefId: "stable_contact_owen_primary",
    sourceTaskId: "task_profile_graph_stable_ref_rekey",
    sourceFingerprint: "fingerprint_profile_graph_stable_ref_rekey",
    mutationEnvelopeHash: "mutation_envelope_profile_graph_stable_ref_rekey",
    observationIds: ["observation_profile_graph_stable_ref_rekey"],
    claimIds: ["claim_profile_graph_stable_ref_rekey"],
    eventIds: ["event_profile_graph_stable_ref_rekey"]
  };
  const decisionRecord = normalized.graph.decisionRecords?.[0];

  assert.equal(normalized.graph.decisionRecords?.length, 1);
  assert.equal(
    decisionRecord?.decisionId,
    `profile_memory_graph_decision_${sha256HexFromCanonicalJson(decisionPayload).slice(0, 24)}`
  );
  assert.equal(decisionRecord?.action, "rekey");
  assert.equal(decisionRecord?.fromStableRefId, "stable_contact_owen");
  assert.equal(decisionRecord?.toStableRefId, "stable_contact_owen_primary");
  assert.equal(
    decisionRecord?.sourceTaskId,
    "task_profile_graph_stable_ref_rekey"
  );
  assert.equal(
    decisionRecord?.mutationEnvelopeHash,
    "mutation_envelope_profile_graph_stable_ref_rekey"
  );
  assert.deepEqual(decisionRecord?.observationIds, ["observation_profile_graph_stable_ref_rekey"]);
  assert.deepEqual(decisionRecord?.claimIds, ["claim_profile_graph_stable_ref_rekey"]);
  assert.deepEqual(decisionRecord?.eventIds, ["event_profile_graph_stable_ref_rekey"]);
});

test("normalizeProfileMemoryState recovers retained journal entries when journalEntryId is malformed", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:17:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:17:00.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_id_malformed",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.id.malformed",
            normalizedValue: "Owen still needs journal id recovery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_id_malformed",
            sourceFingerprint: "fingerprint_profile_graph_journal_id_malformed",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:16:00.000Z",
            observedAt: "2026-04-04T16:16:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:16:00.000Z"
        )
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 2,
        entries: [
          {
            journalEntryId: 7 as unknown as string,
            watermark: 1,
            recordedAt: " 2026-04-04T16:16:30.000Z ",
            sourceTaskId: " task_profile_graph_journal_id_malformed ",
            sourceFingerprint: " fingerprint_profile_graph_journal_id_malformed ",
            mutationEnvelopeHash:
              " mutation_envelope_profile_graph_journal_id_malformed ",
            observationIds: [" observation_profile_graph_journal_id_malformed "],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  const recoveredJournalEntryId =
    `journal_${sha256HexFromCanonicalJson({
      recordedAt: "2026-04-04T16:16:30.000Z",
      sourceTaskId: "task_profile_graph_journal_id_malformed",
      sourceFingerprint: "fingerprint_profile_graph_journal_id_malformed",
      mutationEnvelopeHash: "mutation_envelope_profile_graph_journal_id_malformed",
      observationIds: ["observation_profile_graph_journal_id_malformed"],
      claimIds: [],
      eventIds: [],
      redactionState: "not_requested"
    }).slice(0, 24)}`;
  const entry = normalized.graph.mutationJournal.entries[0];
  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  assert.ok(entry);
  assert.equal(entry?.journalEntryId, recoveredJournalEntryId);
  assert.equal(entry?.watermark, 1);
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 2);
  assert.equal(normalized.graph.readModel.watermark, 1);
});

test("normalizeProfileMemoryState keeps retained journal entries when optional metadata fields are omitted", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:18:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:18:00.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_optional_missing",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.help",
            normalizedValue: "Owen still needs help",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_optional_missing",
            sourceFingerprint: "fingerprint_profile_graph_journal_optional_missing",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:17:00.000Z",
            observedAt: "2026-04-04T16:17:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:17:00.000Z"
        )
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 2,
        entries: [
          {
            journalEntryId: "journal_profile_graph_journal_optional_missing",
            watermark: 1,
            recordedAt: "2026-04-04T16:17:00.000Z",
            observationIds: ["observation_profile_graph_journal_optional_missing"],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 2048,
        maxClaimCount: 2048,
        maxEventCount: 1024,
        maxJournalEntries: 4096
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        conflictingCurrentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  assert.equal(
    normalized.graph.mutationJournal.entries[0]?.journalEntryId,
    "journal_profile_graph_journal_optional_missing"
  );
  assert.equal(normalized.graph.mutationJournal.entries[0]?.sourceTaskId, null);
  assert.equal(normalized.graph.mutationJournal.entries[0]?.sourceFingerprint, null);
  assert.equal(normalized.graph.mutationJournal.entries[0]?.mutationEnvelopeHash, null);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    ["observation_profile_graph_journal_optional_missing"]
  );
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 2);
  assert.equal(normalized.graph.readModel.watermark, 1);
});

test("normalizeProfileMemoryState keeps retained journal entries when optional metadata fields are malformed", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:18:15.000Z",
    graph: {
      updatedAt: "2026-04-04T16:18:15.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_optional_malformed",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.optional.malformed",
            normalizedValue: "Owen still needs the venue details",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_optional_malformed",
            sourceFingerprint: "fingerprint_profile_graph_journal_optional_malformed",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:17:00.000Z",
            observedAt: "2026-04-04T16:17:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:17:00.000Z"
        )
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 2,
        entries: [
          {
            journalEntryId: " journal_profile_graph_journal_optional_malformed ",
            watermark: 1,
            recordedAt: " 2026-04-04T16:17:30.000Z ",
            sourceTaskId: 7 as unknown as string,
            sourceFingerprint: false as unknown as string,
            mutationEnvelopeHash: { invalid: true } as unknown as string,
            observationIds: [" observation_profile_graph_journal_optional_malformed "],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  const entry = normalized.graph.mutationJournal.entries[0];
  assert.ok(entry);
  assert.equal(entry?.journalEntryId, "journal_profile_graph_journal_optional_malformed");
  assert.equal(entry?.sourceTaskId, null);
  assert.equal(entry?.sourceFingerprint, null);
  assert.equal(entry?.mutationEnvelopeHash, null);
  assert.deepEqual(entry?.observationIds, [
    "observation_profile_graph_journal_optional_malformed"
  ]);
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 2);
  assert.equal(normalized.graph.readModel.watermark, 1);
});

test("normalizeProfileMemoryState keeps retained journal entries when redactionState is omitted", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:19:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:19:00.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_redaction_omitted",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.topic",
            normalizedValue: "Owen needs travel details",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_redaction_omitted",
            sourceFingerprint: "fingerprint_profile_graph_journal_redaction_omitted",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:18:00.000Z",
            observedAt: "2026-04-04T16:18:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:18:00.000Z"
        )
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 2,
        entries: [
          {
            journalEntryId: " journal_entry_profile_graph_journal_redaction_omitted ",
            watermark: 1,
            recordedAt: " 2026-04-04T16:18:30.000Z ",
            sourceTaskId: " task_profile_graph_journal_redaction_omitted ",
            sourceFingerprint: " fingerprint_profile_graph_journal_redaction_omitted ",
            mutationEnvelopeHash: " mutation_envelope_profile_graph_journal_redaction_omitted ",
            observationIds: [" observation_profile_graph_journal_redaction_omitted "],
            claimIds: [],
            eventIds: []
          }
        ]
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  const entry = normalized.graph.mutationJournal.entries[0];
  assert.ok(entry);
  assert.equal(entry?.journalEntryId, "journal_entry_profile_graph_journal_redaction_omitted");
  assert.equal(entry?.redactionState, "not_requested");
  assert.equal(entry?.sourceTaskId, "task_profile_graph_journal_redaction_omitted");
  assert.equal(
    entry?.sourceFingerprint,
    "fingerprint_profile_graph_journal_redaction_omitted"
  );
  assert.equal(
    entry?.mutationEnvelopeHash,
    "mutation_envelope_profile_graph_journal_redaction_omitted"
  );
  assert.equal(entry?.recordedAt, "2026-04-04T16:18:30.000Z");
  assert.deepEqual(entry?.observationIds, ["observation_profile_graph_journal_redaction_omitted"]);
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 2);
  assert.equal(normalized.graph.readModel.watermark, 1);
});

test("normalizeProfileMemoryMutationJournalState drops retained journal entries when redactionState is malformed", () => {
  const normalized = normalizeProfileMemoryMutationJournalState(
    {
      schemaVersion: "v1",
      entries: [
        {
          journalEntryId: " journal_entry_profile_graph_journal_redaction_malformed ",
          watermark: 1,
          recordedAt: " 2026-04-04T16:18:30.000Z ",
          sourceTaskId: " task_profile_graph_journal_redaction_malformed ",
          sourceFingerprint: " fingerprint_profile_graph_journal_redaction_malformed ",
          mutationEnvelopeHash: " mutation_envelope_profile_graph_journal_redaction_malformed ",
          observationIds: [" observation_profile_graph_journal_redaction_malformed "],
          claimIds: [],
          eventIds: [],
          redactionState: "invalid_redaction_state" as unknown as "not_requested"
        }
      ]
    },
    "2026-04-04T16:18:00.000Z"
  );

  assert.deepEqual(normalized.entries, []);
  assert.equal(normalized.nextWatermark, 1);
});

test("normalizeProfileMemoryState keeps retained journal entries when empty ref arrays are omitted", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:20:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:20:00.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_refs_omitted",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.next_step",
            normalizedValue: "Owen asked for the itinerary",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_refs_omitted",
            sourceFingerprint: "fingerprint_profile_graph_journal_refs_omitted",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:19:00.000Z",
            observedAt: "2026-04-04T16:19:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:19:00.000Z"
        )
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 2,
        entries: [
          {
            journalEntryId: " journal_entry_profile_graph_journal_refs_omitted ",
            watermark: 1,
            recordedAt: " 2026-04-04T16:19:30.000Z ",
            sourceTaskId: " task_profile_graph_journal_refs_omitted ",
            sourceFingerprint: " fingerprint_profile_graph_journal_refs_omitted ",
            mutationEnvelopeHash: " mutation_envelope_profile_graph_journal_refs_omitted ",
            observationIds: [" observation_profile_graph_journal_refs_omitted "],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  const entry = normalized.graph.mutationJournal.entries[0];
  assert.ok(entry);
  assert.equal(entry?.journalEntryId, "journal_entry_profile_graph_journal_refs_omitted");
  assert.equal(entry?.redactionState, "not_requested");
  assert.equal(entry?.sourceTaskId, "task_profile_graph_journal_refs_omitted");
  assert.equal(entry?.sourceFingerprint, "fingerprint_profile_graph_journal_refs_omitted");
  assert.equal(
    entry?.mutationEnvelopeHash,
    "mutation_envelope_profile_graph_journal_refs_omitted"
  );
  assert.deepEqual(entry?.observationIds, ["observation_profile_graph_journal_refs_omitted"]);
  assert.deepEqual(entry?.claimIds, []);
  assert.deepEqual(entry?.eventIds, []);
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 2);
  assert.equal(normalized.graph.readModel.watermark, 1);
});

test("normalizeProfileMemoryState keeps retained journal entries when ref arrays contain malformed members", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:20:30.000Z",
    graph: {
      updatedAt: "2026-04-04T16:20:30.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_refs_malformed_a",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.refs.a",
            normalizedValue: "Owen shared the first retained ref",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_refs_malformed_a",
            sourceFingerprint: "fingerprint_profile_graph_journal_refs_malformed_a",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:19:00.000Z",
            observedAt: "2026-04-04T16:19:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:19:00.000Z"
        ),
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_refs_malformed_b",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.refs.b",
            normalizedValue: "Owen shared the second retained ref",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_refs_malformed_b",
            sourceFingerprint: "fingerprint_profile_graph_journal_refs_malformed_b",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:19:30.000Z",
            observedAt: "2026-04-04T16:19:30.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:19:30.000Z"
        )
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 2,
        entries: [
          {
            journalEntryId: " journal_entry_profile_graph_journal_refs_malformed ",
            watermark: 1,
            recordedAt: " 2026-04-04T16:20:00.000Z ",
            sourceTaskId: " task_profile_graph_journal_refs_malformed ",
            sourceFingerprint: " fingerprint_profile_graph_journal_refs_malformed ",
            mutationEnvelopeHash: " mutation_envelope_profile_graph_journal_refs_malformed ",
            observationIds: [
              " observation_profile_graph_journal_refs_malformed_b ",
              7 as unknown as string,
              " observation_profile_graph_journal_refs_malformed_a "
            ],
            claimIds: [17 as unknown as string],
            eventIds: [false as unknown as string],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  const entry = normalized.graph.mutationJournal.entries[0];
  assert.ok(entry);
  assert.equal(entry?.journalEntryId, "journal_entry_profile_graph_journal_refs_malformed");
  assert.deepEqual(entry?.observationIds, [
    "observation_profile_graph_journal_refs_malformed_a",
    "observation_profile_graph_journal_refs_malformed_b"
  ]);
  assert.deepEqual(entry?.claimIds, []);
  assert.deepEqual(entry?.eventIds, []);
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 2);
  assert.equal(normalized.graph.readModel.watermark, 1);
});

test("normalizeProfileMemoryState keeps retained journal entries when ref array containers are malformed", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:20:15.000Z",
    graph: {
      updatedAt: "2026-04-04T16:20:15.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_ref_container_malformed",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.ref.container",
            normalizedValue: "Owen still needs the venue details",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_ref_container_malformed",
            sourceFingerprint: "fingerprint_profile_graph_journal_ref_container_malformed",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:19:30.000Z",
            observedAt: "2026-04-04T16:19:30.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:19:30.000Z"
        )
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 2,
        entries: [
          {
            journalEntryId: " journal_entry_profile_graph_journal_ref_container_malformed ",
            watermark: 1,
            recordedAt: " 2026-04-04T16:20:00.000Z ",
            sourceTaskId: " task_profile_graph_journal_ref_container_malformed ",
            sourceFingerprint: " fingerprint_profile_graph_journal_ref_container_malformed ",
            mutationEnvelopeHash:
              " mutation_envelope_profile_graph_journal_ref_container_malformed ",
            observationIds: [" observation_profile_graph_journal_ref_container_malformed "],
            claimIds: " claim_profile_graph_journal_ref_container_malformed " as unknown as string[],
            eventIds: { invalid: true } as unknown as string[],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  const entry = normalized.graph.mutationJournal.entries[0];
  assert.ok(entry);
  assert.equal(
    entry?.journalEntryId,
    "journal_entry_profile_graph_journal_ref_container_malformed"
  );
  assert.deepEqual(entry?.observationIds, [
    "observation_profile_graph_journal_ref_container_malformed"
  ]);
  assert.deepEqual(entry?.claimIds, []);
  assert.deepEqual(entry?.eventIds, []);
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 2);
  assert.equal(normalized.graph.readModel.watermark, 1);
});

test("normalizeProfileMemoryState keeps retained journal entries when watermark is malformed", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:20:45.000Z",
    graph: {
      updatedAt: "2026-04-04T16:20:45.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_watermark_malformed",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.watermark.malformed",
            normalizedValue: "Owen confirmed the malformed watermark replay entry",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_watermark_malformed",
            sourceFingerprint: "fingerprint_profile_graph_journal_watermark_malformed",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:20:00.000Z",
            observedAt: "2026-04-04T16:20:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:20:00.000Z"
        )
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 2,
        entries: [
          {
            journalEntryId: " journal_entry_profile_graph_journal_watermark_malformed ",
            watermark: " 7 " as unknown as number,
            recordedAt: " 2026-04-04T16:20:30.000Z ",
            sourceTaskId: " task_profile_graph_journal_watermark_malformed ",
            sourceFingerprint: " fingerprint_profile_graph_journal_watermark_malformed ",
            mutationEnvelopeHash:
              " mutation_envelope_profile_graph_journal_watermark_malformed ",
            observationIds: [" observation_profile_graph_journal_watermark_malformed "],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  const entry = normalized.graph.mutationJournal.entries[0];
  assert.ok(entry);
  assert.equal(entry?.journalEntryId, "journal_entry_profile_graph_journal_watermark_malformed");
  assert.equal(entry?.watermark, 1);
  assert.equal(entry?.sourceTaskId, "task_profile_graph_journal_watermark_malformed");
  assert.equal(
    entry?.sourceFingerprint,
    "fingerprint_profile_graph_journal_watermark_malformed"
  );
  assert.equal(
    entry?.mutationEnvelopeHash,
    "mutation_envelope_profile_graph_journal_watermark_malformed"
  );
  assert.deepEqual(entry?.observationIds, [
    "observation_profile_graph_journal_watermark_malformed"
  ]);
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 2);
  assert.equal(normalized.graph.readModel.watermark, 1);
});

test("normalizeProfileMemoryState keeps retained journal entries when watermark is omitted", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:21:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:21:00.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_watermark_omitted",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.confirmation",
            normalizedValue: "Owen confirmed the date",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_watermark_omitted",
            sourceFingerprint: "fingerprint_profile_graph_journal_watermark_omitted",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:20:00.000Z",
            observedAt: "2026-04-04T16:20:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:20:00.000Z"
        )
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 2,
        entries: [
          {
            journalEntryId: " journal_entry_profile_graph_journal_watermark_omitted ",
            recordedAt: " 2026-04-04T16:20:30.000Z ",
            sourceTaskId: " task_profile_graph_journal_watermark_omitted ",
            sourceFingerprint: " fingerprint_profile_graph_journal_watermark_omitted ",
            mutationEnvelopeHash: " mutation_envelope_profile_graph_journal_watermark_omitted ",
            observationIds: [" observation_profile_graph_journal_watermark_omitted "],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  const entry = normalized.graph.mutationJournal.entries[0];
  assert.ok(entry);
  assert.equal(entry?.journalEntryId, "journal_entry_profile_graph_journal_watermark_omitted");
  assert.equal(entry?.watermark, 1);
  assert.equal(entry?.redactionState, "not_requested");
  assert.equal(entry?.sourceTaskId, "task_profile_graph_journal_watermark_omitted");
  assert.equal(
    entry?.sourceFingerprint,
    "fingerprint_profile_graph_journal_watermark_omitted"
  );
  assert.equal(
    entry?.mutationEnvelopeHash,
    "mutation_envelope_profile_graph_journal_watermark_omitted"
  );
  assert.deepEqual(entry?.observationIds, ["observation_profile_graph_journal_watermark_omitted"]);
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 2);
  assert.equal(normalized.graph.readModel.watermark, 1);
});

test("normalizeProfileMemoryState recovers omitted journal watermarks without collapsing below explicit retained floors", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:22:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:22:00.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_watermark_floor_explicit",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.watermark.floor.explicit",
            normalizedValue: "Owen sent the anchored replay update",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_watermark_floor_explicit",
            sourceFingerprint: "fingerprint_profile_graph_journal_watermark_floor_explicit",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:20:00.000Z",
            observedAt: "2026-04-04T16:20:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:20:00.000Z"
        ),
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_watermark_floor_recovered",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.watermark.floor.recovered",
            normalizedValue: "Owen sent the recovered replay update",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_watermark_floor_recovered",
            sourceFingerprint: "fingerprint_profile_graph_journal_watermark_floor_recovered",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:21:00.000Z",
            observedAt: "2026-04-04T16:21:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:21:00.000Z"
        )
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 6,
        entries: [
          {
            journalEntryId: " journal_entry_profile_graph_journal_watermark_floor_explicit ",
            watermark: 5,
            recordedAt: " 2026-04-04T16:20:30.000Z ",
            sourceTaskId: " task_profile_graph_journal_watermark_floor_explicit ",
            sourceFingerprint: " fingerprint_profile_graph_journal_watermark_floor_explicit ",
            mutationEnvelopeHash:
              " mutation_envelope_profile_graph_journal_watermark_floor_explicit ",
            observationIds: [
              " observation_profile_graph_journal_watermark_floor_explicit "
            ],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: " journal_entry_profile_graph_journal_watermark_floor_recovered ",
            recordedAt: " 2026-04-04T16:21:30.000Z ",
            sourceTaskId: " task_profile_graph_journal_watermark_floor_recovered ",
            sourceFingerprint: " fingerprint_profile_graph_journal_watermark_floor_recovered ",
            mutationEnvelopeHash:
              " mutation_envelope_profile_graph_journal_watermark_floor_recovered ",
            observationIds: [
              " observation_profile_graph_journal_watermark_floor_recovered "
            ],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.journalEntryId),
    [
      "journal_entry_profile_graph_journal_watermark_floor_explicit",
      "journal_entry_profile_graph_journal_watermark_floor_recovered"
    ]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [5, 6]
  );
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 7);
  assert.equal(normalized.graph.readModel.watermark, 6);
});

test("normalizeProfileMemoryState recovers same-timestamp omitted journal watermarks above explicit retained floors", () => {
  const explicitObservationId = "observation_profile_graph_journal_watermark_same_timestamp_explicit";
  const recoveredObservationId = "observation_profile_graph_journal_watermark_same_timestamp_recovered";
  const recordedAt = "2026-04-04T16:20:30.000Z";
  const sourceTaskId = "task_profile_graph_journal_watermark_same_timestamp";
  const fingerprintCandidates = [
    "fingerprint_profile_graph_journal_watermark_same_timestamp_a",
    "fingerprint_profile_graph_journal_watermark_same_timestamp_b",
    "fingerprint_profile_graph_journal_watermark_same_timestamp_c",
    "fingerprint_profile_graph_journal_watermark_same_timestamp_d"
  ];
  let selectedFingerprints:
    | { explicitSourceFingerprint: string; recoveredSourceFingerprint: string }
    | null = null;
  for (const explicitSourceFingerprint of fingerprintCandidates) {
    for (const recoveredSourceFingerprint of fingerprintCandidates) {
      if (explicitSourceFingerprint === recoveredSourceFingerprint) {
        continue;
      }
      const explicitCanonicalJournalEntryId =
        `journal_${sha256HexFromCanonicalJson({
          recordedAt,
          sourceTaskId,
          sourceFingerprint: explicitSourceFingerprint,
          mutationEnvelopeHash: null,
          observationIds: [explicitObservationId],
          claimIds: [],
          eventIds: [],
          redactionState: "not_requested"
        }).slice(0, 24)}`;
      const recoveredCanonicalJournalEntryId =
        `journal_${sha256HexFromCanonicalJson({
          recordedAt,
          sourceTaskId,
          sourceFingerprint: recoveredSourceFingerprint,
          mutationEnvelopeHash: null,
          observationIds: [recoveredObservationId],
          claimIds: [],
          eventIds: [],
          redactionState: "not_requested"
        }).slice(0, 24)}`;
      if (recoveredCanonicalJournalEntryId.localeCompare(explicitCanonicalJournalEntryId) < 0) {
        selectedFingerprints = {
          explicitSourceFingerprint,
          recoveredSourceFingerprint
        };
        break;
      }
    }
    if (selectedFingerprints) {
      break;
    }
  }

  assert.ok(selectedFingerprints);
  const { explicitSourceFingerprint, recoveredSourceFingerprint } = selectedFingerprints;
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:22:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:22:00.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: explicitObservationId,
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.watermark.same_timestamp.explicit",
            normalizedValue: "Owen sent the anchored same-timestamp replay update",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId,
            sourceFingerprint: explicitSourceFingerprint,
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:20:00.000Z",
            observedAt: "2026-04-04T16:20:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:20:00.000Z"
        ),
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: recoveredObservationId,
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.watermark.same_timestamp.recovered",
            normalizedValue: "Owen sent the recovered same-timestamp replay update",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId,
            sourceFingerprint: recoveredSourceFingerprint,
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:21:00.000Z",
            observedAt: "2026-04-04T16:21:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:21:00.000Z"
        )
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 6,
        entries: [
          {
            journalEntryId: " journal_entry_profile_graph_journal_watermark_same_timestamp_explicit ",
            watermark: 5,
            recordedAt: ` ${recordedAt} `,
            sourceTaskId: ` ${sourceTaskId} `,
            sourceFingerprint: ` ${explicitSourceFingerprint} `,
            mutationEnvelopeHash:
              " mutation_envelope_profile_graph_journal_watermark_same_timestamp_explicit ",
            observationIds: [` ${explicitObservationId} `],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: " journal_entry_profile_graph_journal_watermark_same_timestamp_recovered ",
            recordedAt: ` ${recordedAt} `,
            sourceTaskId: ` ${sourceTaskId} `,
            sourceFingerprint: ` ${recoveredSourceFingerprint} `,
            mutationEnvelopeHash:
              " mutation_envelope_profile_graph_journal_watermark_same_timestamp_recovered ",
            observationIds: [` ${recoveredObservationId} `],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 2);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.sourceFingerprint),
    [explicitSourceFingerprint, recoveredSourceFingerprint]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [5, 6]
  );
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 7);
  assert.equal(normalized.graph.readModel.watermark, 6);
});

test("normalizeProfileMemoryState treats zero journal watermarks like recovered replay order above explicit retained floors", () => {
  const explicitObservationId = "observation_profile_graph_journal_watermark_zero_explicit";
  const recoveredObservationId = "observation_profile_graph_journal_watermark_zero_recovered";
  const recordedAt = "2026-04-04T16:24:30.000Z";
  const sourceTaskId = "task_profile_graph_journal_watermark_zero_same_timestamp";
  const fingerprintCandidates = [
    "fingerprint_profile_graph_journal_watermark_zero_a",
    "fingerprint_profile_graph_journal_watermark_zero_b",
    "fingerprint_profile_graph_journal_watermark_zero_c",
    "fingerprint_profile_graph_journal_watermark_zero_d"
  ];
  let selectedFingerprints:
    | { explicitSourceFingerprint: string; recoveredSourceFingerprint: string }
    | null = null;
  for (const explicitSourceFingerprint of fingerprintCandidates) {
    for (const recoveredSourceFingerprint of fingerprintCandidates) {
      if (explicitSourceFingerprint === recoveredSourceFingerprint) {
        continue;
      }
      const explicitCanonicalJournalEntryId =
        `journal_${sha256HexFromCanonicalJson({
          recordedAt,
          sourceTaskId,
          sourceFingerprint: explicitSourceFingerprint,
          mutationEnvelopeHash: null,
          observationIds: [explicitObservationId],
          claimIds: [],
          eventIds: [],
          redactionState: "not_requested"
        }).slice(0, 24)}`;
      const recoveredCanonicalJournalEntryId =
        `journal_${sha256HexFromCanonicalJson({
          recordedAt,
          sourceTaskId,
          sourceFingerprint: recoveredSourceFingerprint,
          mutationEnvelopeHash: null,
          observationIds: [recoveredObservationId],
          claimIds: [],
          eventIds: [],
          redactionState: "not_requested"
        }).slice(0, 24)}`;
      if (recoveredCanonicalJournalEntryId.localeCompare(explicitCanonicalJournalEntryId) < 0) {
        selectedFingerprints = {
          explicitSourceFingerprint,
          recoveredSourceFingerprint
        };
        break;
      }
    }
    if (selectedFingerprints) {
      break;
    }
  }

  assert.ok(selectedFingerprints);
  const { explicitSourceFingerprint, recoveredSourceFingerprint } = selectedFingerprints;
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:26:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:26:00.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: explicitObservationId,
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.watermark.zero.explicit",
            normalizedValue: "Owen sent the explicit watermark replay update",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId,
            sourceFingerprint: explicitSourceFingerprint,
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:24:00.000Z",
            observedAt: "2026-04-04T16:24:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:24:00.000Z"
        ),
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: recoveredObservationId,
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.watermark.zero.recovered",
            normalizedValue: "Owen sent the malformed zero watermark replay update",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId,
            sourceFingerprint: recoveredSourceFingerprint,
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:25:00.000Z",
            observedAt: "2026-04-04T16:25:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:25:00.000Z"
        )
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 6,
        entries: [
          {
            journalEntryId: " journal_entry_profile_graph_journal_watermark_zero_explicit ",
            watermark: 5,
            recordedAt: ` ${recordedAt} `,
            sourceTaskId: ` ${sourceTaskId} `,
            sourceFingerprint: ` ${explicitSourceFingerprint} `,
            mutationEnvelopeHash:
              " mutation_envelope_profile_graph_journal_watermark_zero_explicit ",
            observationIds: [` ${explicitObservationId} `],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: " journal_entry_profile_graph_journal_watermark_zero_recovered ",
            watermark: 0,
            recordedAt: ` ${recordedAt} `,
            sourceTaskId: ` ${sourceTaskId} `,
            sourceFingerprint: ` ${recoveredSourceFingerprint} `,
            mutationEnvelopeHash:
              " mutation_envelope_profile_graph_journal_watermark_zero_recovered ",
            observationIds: [` ${recoveredObservationId} `],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 2);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.sourceFingerprint),
    [explicitSourceFingerprint, recoveredSourceFingerprint]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [5, 6]
  );
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 7);
  assert.equal(normalized.graph.readModel.watermark, 6);
});

test("normalizeProfileMemoryState treats negative journal watermarks like recovered replay order above explicit retained floors", () => {
  const explicitObservationId = "observation_profile_graph_journal_watermark_negative_explicit";
  const recoveredObservationId = "observation_profile_graph_journal_watermark_negative_recovered";
  const recordedAt = "2026-04-08T14:26:30.000Z";
  const sourceTaskId = "task_profile_graph_journal_watermark_negative_same_timestamp";
  const fingerprintCandidates = [
    "fingerprint_profile_graph_journal_watermark_negative_a",
    "fingerprint_profile_graph_journal_watermark_negative_b",
    "fingerprint_profile_graph_journal_watermark_negative_c",
    "fingerprint_profile_graph_journal_watermark_negative_d"
  ];
  let selectedFingerprints:
    | { explicitSourceFingerprint: string; recoveredSourceFingerprint: string }
    | null = null;
  for (const explicitSourceFingerprint of fingerprintCandidates) {
    for (const recoveredSourceFingerprint of fingerprintCandidates) {
      if (explicitSourceFingerprint === recoveredSourceFingerprint) {
        continue;
      }
      const explicitCanonicalJournalEntryId =
        `journal_${sha256HexFromCanonicalJson({
          recordedAt,
          sourceTaskId,
          sourceFingerprint: explicitSourceFingerprint,
          mutationEnvelopeHash: null,
          observationIds: [explicitObservationId],
          claimIds: [],
          eventIds: [],
          redactionState: "not_requested"
        }).slice(0, 24)}`;
      const recoveredCanonicalJournalEntryId =
        `journal_${sha256HexFromCanonicalJson({
          recordedAt,
          sourceTaskId,
          sourceFingerprint: recoveredSourceFingerprint,
          mutationEnvelopeHash: null,
          observationIds: [recoveredObservationId],
          claimIds: [],
          eventIds: [],
          redactionState: "not_requested"
        }).slice(0, 24)}`;
      if (recoveredCanonicalJournalEntryId.localeCompare(explicitCanonicalJournalEntryId) < 0) {
        selectedFingerprints = {
          explicitSourceFingerprint,
          recoveredSourceFingerprint
        };
        break;
      }
    }
    if (selectedFingerprints) {
      break;
    }
  }

  assert.ok(selectedFingerprints);
  const { explicitSourceFingerprint, recoveredSourceFingerprint } = selectedFingerprints;
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-08T14:28:00.000Z",
    graph: {
      updatedAt: "2026-04-08T14:28:00.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: explicitObservationId,
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.watermark.negative.explicit",
            normalizedValue: "Owen sent the explicit negative-floor replay update",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId,
            sourceFingerprint: explicitSourceFingerprint,
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-08T14:24:00.000Z",
            observedAt: "2026-04-08T14:24:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-08T14:24:00.000Z"
        ),
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: recoveredObservationId,
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.watermark.negative.recovered",
            normalizedValue: "Owen sent the malformed negative watermark replay update",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId,
            sourceFingerprint: recoveredSourceFingerprint,
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-08T14:25:00.000Z",
            observedAt: "2026-04-08T14:25:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-08T14:25:00.000Z"
        )
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 6,
        entries: [
          {
            journalEntryId: " journal_entry_profile_graph_journal_watermark_negative_explicit ",
            watermark: 5,
            recordedAt: ` ${recordedAt} `,
            sourceTaskId: ` ${sourceTaskId} `,
            sourceFingerprint: ` ${explicitSourceFingerprint} `,
            mutationEnvelopeHash:
              " mutation_envelope_profile_graph_journal_watermark_negative_explicit ",
            observationIds: [` ${explicitObservationId} `],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: " journal_entry_profile_graph_journal_watermark_negative_recovered ",
            watermark: -7,
            recordedAt: ` ${recordedAt} `,
            sourceTaskId: ` ${sourceTaskId} `,
            sourceFingerprint: ` ${recoveredSourceFingerprint} `,
            mutationEnvelopeHash:
              " mutation_envelope_profile_graph_journal_watermark_negative_recovered ",
            observationIds: [` ${recoveredObservationId} `],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 2);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.sourceFingerprint),
    [explicitSourceFingerprint, recoveredSourceFingerprint]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [5, 6]
  );
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 7);
  assert.equal(normalized.graph.readModel.watermark, 6);
});

test("normalizeProfileMemoryState keeps retained journal nextWatermark canonical when it is omitted", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:22:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:22:00.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_next_watermark_omitted",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.confirmation",
            normalizedValue: "Owen confirmed the venue",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_next_watermark_omitted",
            sourceFingerprint: "fingerprint_profile_graph_journal_next_watermark_omitted",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:21:00.000Z",
            observedAt: "2026-04-04T16:21:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:21:00.000Z"
        )
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        entries: [
          {
            journalEntryId: " journal_entry_profile_graph_journal_next_watermark_omitted ",
            watermark: 1,
            recordedAt: " 2026-04-04T16:21:30.000Z ",
            sourceTaskId: " task_profile_graph_journal_next_watermark_omitted ",
            sourceFingerprint: " fingerprint_profile_graph_journal_next_watermark_omitted ",
            mutationEnvelopeHash:
              " mutation_envelope_profile_graph_journal_next_watermark_omitted ",
            observationIds: [" observation_profile_graph_journal_next_watermark_omitted "],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  const entry = normalized.graph.mutationJournal.entries[0];
  assert.ok(entry);
  assert.equal(
    entry?.journalEntryId,
    "journal_entry_profile_graph_journal_next_watermark_omitted"
  );
  assert.equal(entry?.watermark, 1);
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 2);
  assert.equal(normalized.graph.readModel.watermark, 1);
});

test("normalizeProfileMemoryState keeps retained journal nextWatermark canonical when it is malformed", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:22:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:22:00.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_next_watermark_malformed",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.next.watermark.malformed",
            normalizedValue: "Owen confirmed the malformed outer watermark lane",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_next_watermark_malformed",
            sourceFingerprint: "fingerprint_profile_graph_journal_next_watermark_malformed",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:21:00.000Z",
            observedAt: "2026-04-04T16:21:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:21:00.000Z"
        )
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: " 9 " as unknown as number,
        entries: [
          {
            journalEntryId: " journal_entry_profile_graph_journal_next_watermark_malformed ",
            watermark: 1,
            recordedAt: " 2026-04-04T16:21:30.000Z ",
            sourceTaskId: " task_profile_graph_journal_next_watermark_malformed ",
            sourceFingerprint: " fingerprint_profile_graph_journal_next_watermark_malformed ",
            mutationEnvelopeHash:
              " mutation_envelope_profile_graph_journal_next_watermark_malformed ",
            observationIds: [" observation_profile_graph_journal_next_watermark_malformed "],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  const entry = normalized.graph.mutationJournal.entries[0];
  assert.ok(entry);
  assert.equal(
    entry?.journalEntryId,
    "journal_entry_profile_graph_journal_next_watermark_malformed"
  );
  assert.equal(entry?.watermark, 1);
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 2);
  assert.equal(normalized.graph.readModel.watermark, 1);
});

test("normalizeProfileMemoryState keeps retained journal nextWatermark canonical when it is stale", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:24:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:24:00.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_next_watermark_stale_a",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.next.watermark.stale.a",
            normalizedValue: "Owen confirmed the first stale outer watermark lane",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_next_watermark_stale_a",
            sourceFingerprint: "fingerprint_profile_graph_journal_next_watermark_stale_a",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:21:00.000Z",
            observedAt: "2026-04-04T16:21:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:21:00.000Z"
        ),
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_next_watermark_stale_b",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.next.watermark.stale.b",
            normalizedValue: "Owen confirmed the second stale outer watermark lane",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_next_watermark_stale_b",
            sourceFingerprint: "fingerprint_profile_graph_journal_next_watermark_stale_b",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:22:00.000Z",
            observedAt: "2026-04-04T16:22:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:22:00.000Z"
        )
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: [
          {
            journalEntryId: " journal_entry_profile_graph_journal_next_watermark_stale_a ",
            watermark: 1,
            recordedAt: " 2026-04-04T16:21:30.000Z ",
            sourceTaskId: " task_profile_graph_journal_next_watermark_stale_a ",
            sourceFingerprint: " fingerprint_profile_graph_journal_next_watermark_stale_a ",
            mutationEnvelopeHash:
              " mutation_envelope_profile_graph_journal_next_watermark_stale_a ",
            observationIds: [" observation_profile_graph_journal_next_watermark_stale_a "],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: " journal_entry_profile_graph_journal_next_watermark_stale_b ",
            watermark: 2,
            recordedAt: " 2026-04-04T16:22:30.000Z ",
            sourceTaskId: " task_profile_graph_journal_next_watermark_stale_b ",
            sourceFingerprint: " fingerprint_profile_graph_journal_next_watermark_stale_b ",
            mutationEnvelopeHash:
              " mutation_envelope_profile_graph_journal_next_watermark_stale_b ",
            observationIds: [" observation_profile_graph_journal_next_watermark_stale_b "],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 2);
  assert.equal(normalized.graph.mutationJournal.entries[0]?.watermark, 1);
  assert.equal(normalized.graph.mutationJournal.entries[1]?.watermark, 2);
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 3);
  assert.equal(normalized.graph.readModel.watermark, 2);
});

test("normalizeProfileMemoryState recovers omitted journal watermarks by replay order instead of raw array order", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:23:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:23:00.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_watermark_order_early",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.early",
            normalizedValue: "Owen sent the first update",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_watermark_order_early",
            sourceFingerprint: "fingerprint_profile_graph_journal_watermark_order_early",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:21:00.000Z",
            observedAt: "2026-04-04T16:21:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:21:00.000Z"
        ),
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_watermark_order_late",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.late",
            normalizedValue: "Owen sent the second update",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_watermark_order_late",
            sourceFingerprint: "fingerprint_profile_graph_journal_watermark_order_late",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:22:00.000Z",
            observedAt: "2026-04-04T16:22:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:22:00.000Z"
        )
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        entries: [
          {
            journalEntryId: " journal_entry_profile_graph_journal_watermark_order_late ",
            recordedAt: " 2026-04-04T16:22:30.000Z ",
            sourceTaskId: " task_profile_graph_journal_watermark_order_late ",
            sourceFingerprint: " fingerprint_profile_graph_journal_watermark_order_late ",
            mutationEnvelopeHash: " mutation_envelope_profile_graph_journal_watermark_order_late ",
            observationIds: [" observation_profile_graph_journal_watermark_order_late "],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: " journal_entry_profile_graph_journal_watermark_order_early ",
            recordedAt: " 2026-04-04T16:21:30.000Z ",
            sourceTaskId: " task_profile_graph_journal_watermark_order_early ",
            sourceFingerprint: " fingerprint_profile_graph_journal_watermark_order_early ",
            mutationEnvelopeHash: " mutation_envelope_profile_graph_journal_watermark_order_early ",
            observationIds: [" observation_profile_graph_journal_watermark_order_early "],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.journalEntryId),
    [
      "journal_entry_profile_graph_journal_watermark_order_early",
      "journal_entry_profile_graph_journal_watermark_order_late"
    ]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [1, 2]
  );
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 3);
  assert.equal(normalized.graph.readModel.watermark, 2);
});

test("normalizeProfileMemoryState recovers same-timestamp omitted journal watermarks by canonical payload instead of legacy ids", () => {
  const taskACanonicalJournalEntryId = `journal_${sha256HexFromCanonicalJson({
    recordedAt: "2026-04-04T16:24:30.000Z",
    sourceTaskId: "task_profile_graph_journal_watermark_tie_a",
    sourceFingerprint: "fingerprint_profile_graph_journal_watermark_tie_a",
    mutationEnvelopeHash: "mutation_envelope_profile_graph_journal_watermark_tie_a",
    observationIds: ["observation_profile_graph_journal_watermark_tie_a"],
    claimIds: [],
    eventIds: [],
    redactionState: "not_requested"
  }).slice(0, 24)}`;
  const taskBCanonicalJournalEntryId = `journal_${sha256HexFromCanonicalJson({
    recordedAt: "2026-04-04T16:24:30.000Z",
    sourceTaskId: "task_profile_graph_journal_watermark_tie_b",
    sourceFingerprint: "fingerprint_profile_graph_journal_watermark_tie_b",
    mutationEnvelopeHash: "mutation_envelope_profile_graph_journal_watermark_tie_b",
    observationIds: ["observation_profile_graph_journal_watermark_tie_b"],
    claimIds: [],
    eventIds: [],
    redactionState: "not_requested"
  }).slice(0, 24)}`;
  const expectedSourceTaskIdOrder =
    taskACanonicalJournalEntryId.localeCompare(taskBCanonicalJournalEntryId) <= 0
      ? [
        "task_profile_graph_journal_watermark_tie_a",
        "task_profile_graph_journal_watermark_tie_b"
      ]
      : [
        "task_profile_graph_journal_watermark_tie_b",
        "task_profile_graph_journal_watermark_tie_a"
      ];
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:25:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:25:00.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_watermark_tie_a",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.tie.a",
            normalizedValue: "Owen sent tie update A",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_watermark_tie_a",
            sourceFingerprint: "fingerprint_profile_graph_journal_watermark_tie_a",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:24:00.000Z",
            observedAt: "2026-04-04T16:24:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:24:00.000Z"
        ),
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_watermark_tie_b",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.tie.b",
            normalizedValue: "Owen sent tie update B",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_watermark_tie_b",
            sourceFingerprint: "fingerprint_profile_graph_journal_watermark_tie_b",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:24:00.000Z",
            observedAt: "2026-04-04T16:24:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:24:00.000Z"
        )
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        entries: [
          {
            journalEntryId: " aaa_legacy_profile_graph_journal_watermark_tie_b ",
            recordedAt: " 2026-04-04T16:24:30.000Z ",
            sourceTaskId: " task_profile_graph_journal_watermark_tie_b ",
            sourceFingerprint: " fingerprint_profile_graph_journal_watermark_tie_b ",
            mutationEnvelopeHash: " mutation_envelope_profile_graph_journal_watermark_tie_b ",
            observationIds: [" observation_profile_graph_journal_watermark_tie_b "],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: " zzz_legacy_profile_graph_journal_watermark_tie_a ",
            recordedAt: " 2026-04-04T16:24:30.000Z ",
            sourceTaskId: " task_profile_graph_journal_watermark_tie_a ",
            sourceFingerprint: " fingerprint_profile_graph_journal_watermark_tie_a ",
            mutationEnvelopeHash: " mutation_envelope_profile_graph_journal_watermark_tie_a ",
            observationIds: [" observation_profile_graph_journal_watermark_tie_a "],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.sourceTaskId),
    expectedSourceTaskIdOrder
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [1, 2]
  );
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 3);
  assert.equal(normalized.graph.readModel.watermark, 2);
});

test("normalizeProfileMemoryState breaks same-timestamp explicit journal watermark ties by canonical payload instead of legacy ids", () => {
  const taskACanonicalJournalEntryId = `journal_${sha256HexFromCanonicalJson({
    recordedAt: "2026-04-04T16:26:30.000Z",
    sourceTaskId: "task_profile_graph_journal_explicit_watermark_tie_a",
    sourceFingerprint: "fingerprint_profile_graph_journal_explicit_watermark_tie_a",
    mutationEnvelopeHash: "mutation_envelope_profile_graph_journal_explicit_watermark_tie_a",
    observationIds: ["observation_profile_graph_journal_explicit_watermark_tie_a"],
    claimIds: [],
    eventIds: [],
    redactionState: "not_requested"
  }).slice(0, 24)}`;
  const taskBCanonicalJournalEntryId = `journal_${sha256HexFromCanonicalJson({
    recordedAt: "2026-04-04T16:26:30.000Z",
    sourceTaskId: "task_profile_graph_journal_explicit_watermark_tie_b",
    sourceFingerprint: "fingerprint_profile_graph_journal_explicit_watermark_tie_b",
    mutationEnvelopeHash: "mutation_envelope_profile_graph_journal_explicit_watermark_tie_b",
    observationIds: ["observation_profile_graph_journal_explicit_watermark_tie_b"],
    claimIds: [],
    eventIds: [],
    redactionState: "not_requested"
  }).slice(0, 24)}`;
  const expectedSourceTaskIdOrder =
    taskACanonicalJournalEntryId.localeCompare(taskBCanonicalJournalEntryId) <= 0
      ? [
        "task_profile_graph_journal_explicit_watermark_tie_a",
        "task_profile_graph_journal_explicit_watermark_tie_b"
      ]
      : [
        "task_profile_graph_journal_explicit_watermark_tie_b",
        "task_profile_graph_journal_explicit_watermark_tie_a"
      ];
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:27:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:27:00.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_explicit_watermark_tie_a",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.explicit.tie.a",
            normalizedValue: "Owen sent explicit tie update A",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_explicit_watermark_tie_a",
            sourceFingerprint: "fingerprint_profile_graph_journal_explicit_watermark_tie_a",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:26:00.000Z",
            observedAt: "2026-04-04T16:26:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:26:00.000Z"
        ),
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_journal_explicit_watermark_tie_b",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.explicit.tie.b",
            normalizedValue: "Owen sent explicit tie update B",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_journal_explicit_watermark_tie_b",
            sourceFingerprint: "fingerprint_profile_graph_journal_explicit_watermark_tie_b",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:26:00.000Z",
            observedAt: "2026-04-04T16:26:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          },
          "2026-04-04T16:26:00.000Z"
        )
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        entries: [
          {
            journalEntryId: " aaa_legacy_profile_graph_journal_explicit_watermark_tie_b ",
            watermark: 4,
            recordedAt: " 2026-04-04T16:26:30.000Z ",
            sourceTaskId: " task_profile_graph_journal_explicit_watermark_tie_b ",
            sourceFingerprint:
              " fingerprint_profile_graph_journal_explicit_watermark_tie_b ",
            mutationEnvelopeHash:
              " mutation_envelope_profile_graph_journal_explicit_watermark_tie_b ",
            observationIds: [
              " observation_profile_graph_journal_explicit_watermark_tie_b "
            ],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: " zzz_legacy_profile_graph_journal_explicit_watermark_tie_a ",
            watermark: 4,
            recordedAt: " 2026-04-04T16:26:30.000Z ",
            sourceTaskId: " task_profile_graph_journal_explicit_watermark_tie_a ",
            sourceFingerprint:
              " fingerprint_profile_graph_journal_explicit_watermark_tie_a ",
            mutationEnvelopeHash:
              " mutation_envelope_profile_graph_journal_explicit_watermark_tie_a ",
            observationIds: [
              " observation_profile_graph_journal_explicit_watermark_tie_a "
            ],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.sourceTaskId),
    expectedSourceTaskIdOrder
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [4, 5]
  );
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 6);
  assert.equal(normalized.graph.readModel.watermark, 5);
});

test("normalizeProfileMemoryState trims padded graph record ids and retained graph refs", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:21:30.000Z",
    graph: {
      updatedAt: "2026-04-04T16:21:30.000Z",
      observations: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: " observation_profile_graph_identity_trim ",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_identity_trim_old",
            sourceFingerprint: "fingerprint_profile_graph_identity_trim_old",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:19:00.000Z",
            observedAt: "2026-04-04T16:19:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: [" entity_owen ", "entity_owen"]
          },
          "2026-04-04T16:19:00.000Z"
        ),
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
          {
            observationId: "observation_profile_graph_identity_trim",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_identity_trim_new",
            sourceFingerprint: "fingerprint_profile_graph_identity_trim_new",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:19:30.000Z",
            observedAt: "2026-04-04T16:19:30.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: ["entity_owen"]
          },
          "2026-04-04T16:19:30.000Z"
        )
      ],
      claims: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
          {
            claimId: " claim_profile_graph_identity_trim ",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_identity_trim_claim_old",
            sourceFingerprint: "fingerprint_profile_graph_identity_trim_claim_old",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:19:00.000Z",
            validFrom: "2026-04-04T16:19:00.000Z",
            validTo: "2026-04-04T16:19:30.000Z",
            endedAt: "2026-04-04T16:19:30.000Z",
            endedByClaimId: " claim_profile_graph_identity_trim_successor ",
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [
              " observation_profile_graph_identity_trim ",
              "observation_profile_graph_identity_trim"
            ],
            projectionSourceIds: [
              " fact_profile_graph_identity_trim ",
              "fact_profile_graph_identity_trim"
            ],
            entityRefIds: [" entity_owen ", "entity_owen"],
            active: false
          },
          "2026-04-04T16:19:00.000Z"
        ),
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
          {
            claimId: " claim_profile_graph_identity_trim_successor ",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_identity_trim_claim_new",
            sourceFingerprint: "fingerprint_profile_graph_identity_trim_claim_new",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:19:30.000Z",
            validFrom: "2026-04-04T16:19:30.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [
              " observation_profile_graph_identity_trim ",
              "observation_profile_graph_identity_trim"
            ],
            projectionSourceIds: [
              " fact_profile_graph_identity_trim_successor ",
              "fact_profile_graph_identity_trim_successor"
            ],
            entityRefIds: [" entity_owen ", "entity_owen"],
            active: true
          },
          "2026-04-04T16:19:30.000Z"
        )
      ],
      events: [
        createSchemaEnvelopeV1(
          PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
          {
            eventId: " event_profile_graph_identity_trim ",
            stableRefId: null,
            family: "episode.candidate",
            title: "Lantern update",
            summary: "Lantern changed plans.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_identity_trim_event",
            sourceFingerprint: "fingerprint_profile_graph_identity_trim_event",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:19:30.000Z",
            observedAt: "2026-04-04T16:19:30.000Z",
            validFrom: "2026-04-04T16:19:30.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [
              " observation_profile_graph_identity_trim ",
              "observation_profile_graph_identity_trim"
            ],
            projectionSourceIds: [
              " episode_profile_graph_identity_trim ",
              "episode_profile_graph_identity_trim"
            ],
            entityRefIds: [" entity_owen ", "entity_owen"]
          },
          "2026-04-04T16:19:30.000Z"
        )
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 2,
        entries: [{
          journalEntryId: "journal_profile_graph_identity_trim_keep",
          watermark: 1,
          recordedAt: "2026-04-04T16:19:30.000Z",
          sourceTaskId: "task_profile_graph_identity_trim",
          sourceFingerprint: "fingerprint_profile_graph_identity_trim",
          mutationEnvelopeHash: null,
          observationIds: [
            " observation_profile_graph_identity_trim ",
            "observation_profile_graph_identity_trim"
          ],
          claimIds: [
            " claim_profile_graph_identity_trim ",
            " claim_profile_graph_identity_trim_successor "
          ],
          eventIds: [" event_profile_graph_identity_trim ", "event_profile_graph_identity_trim"],
          redactionState: "not_requested"
        }]
      }
    }
  });

  const observations = normalized.graph.observations.filter(
    (entry) => entry.payload.observationId === "observation_profile_graph_identity_trim"
  );
  assert.equal(observations.length, 1);
  assert.equal(
    observations[0]?.payload.sourceFingerprint,
    "fingerprint_profile_graph_identity_trim_new"
  );
  assert.deepEqual(observations[0]?.payload.entityRefIds, ["entity_owen"]);

  const claim = normalized.graph.claims.find(
    (entry) => entry.payload.claimId === "claim_profile_graph_identity_trim"
  );
  const successorClaim = normalized.graph.claims.find(
    (entry) => entry.payload.claimId === "claim_profile_graph_identity_trim_successor"
  );
  const event = normalized.graph.events.find(
    (entry) => entry.payload.eventId === "event_profile_graph_identity_trim"
  );

  assert.ok(claim);
  assert.equal(claim?.payload.endedByClaimId, "claim_profile_graph_identity_trim_successor");
  assert.deepEqual(claim?.payload.derivedFromObservationIds, [
    "observation_profile_graph_identity_trim"
  ]);
  assert.deepEqual(claim?.payload.entityRefIds, ["entity_owen"]);

  assert.ok(successorClaim);
  assert.deepEqual(successorClaim?.payload.derivedFromObservationIds, [
    "observation_profile_graph_identity_trim"
  ]);
  assert.deepEqual(successorClaim?.payload.entityRefIds, ["entity_owen"]);

  assert.ok(event);
  assert.deepEqual(event?.payload.derivedFromObservationIds, [
    "observation_profile_graph_identity_trim"
  ]);
  assert.deepEqual(event?.payload.entityRefIds, ["entity_owen"]);

  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    ["observation_profile_graph_identity_trim"]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.claimIds,
    [
      "claim_profile_graph_identity_trim",
      "claim_profile_graph_identity_trim_successor"
    ]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.eventIds,
    ["event_profile_graph_identity_trim"]
  );
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["employment.current"],
    "claim_profile_graph_identity_trim_successor"
  );
});

test("normalizeProfileMemoryState trims padded non-redacted event text and repairs blank event text", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:22:30.000Z",
    graph: {
      updatedAt: "2026-04-04T16:22:30.000Z",
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_event_text_trimmed",
          stableRefId: null,
          family: "episode.candidate",
          title: "  Avery follow-up  ",
          summary: "  Avery followed up later.  ",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_text_trimmed",
          sourceFingerprint: "fingerprint_profile_graph_event_text_trimmed",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:22:00.000Z",
          observedAt: "2026-04-04T16:22:00.000Z",
          validFrom: "2026-04-04T16:22:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: [],
          entityRefIds: []
        }),
        createGraphEventEnvelope({
          eventId: "event_profile_graph_event_text_blank",
          stableRefId: null,
          family: "episode.candidate",
          title: "   ",
          summary: "   ",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_text_blank",
          sourceFingerprint: "fingerprint_profile_graph_event_text_blank",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:22:30.000Z",
          observedAt: "2026-04-04T16:22:30.000Z",
          validFrom: "2026-04-04T16:22:30.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: [],
          entityRefIds: []
        })
      ]
    }
  });

  const trimmedEvent = normalized.graph.events.find(
    (entry) => entry.payload.eventId === "event_profile_graph_event_text_trimmed"
  );
  const blankEvent = normalized.graph.events.find(
    (entry) => entry.payload.eventId === "event_profile_graph_event_text_blank"
  );

  assert.equal(trimmedEvent?.payload.title, "Avery follow-up");
  assert.equal(trimmedEvent?.payload.summary, "Avery followed up later.");
  assert.equal(blankEvent?.payload.title, "[untitled episode]");
  assert.equal(blankEvent?.payload.summary, "[missing episode summary]");
});

test("normalizeProfileMemoryState trims padded enum-like graph metadata before payload salvage", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:24:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:24:00.000Z",
      observations: [
        createPersistedGraphEnvelope(PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME, {
          observationId: "observation_profile_graph_enum_trimmed",
          stableRefId: null,
          family: "contact.relationship",
          normalizedKey: "contact.avery.relationship",
          normalizedValue: "friend",
          redactionState: "  not_requested  ",
          sensitive: false,
          sourceTaskId: "task_profile_graph_enum_trimmed_observation",
          sourceFingerprint: "fingerprint_profile_graph_enum_trimmed_observation",
          sourceTier: "  explicit_user_statement  ",
          assertedAt: "2026-04-04T16:23:00.000Z",
          observedAt: "2026-04-04T16:23:00.000Z",
          timePrecision: "  instant  ",
          timeSource: "  user_stated  ",
          entityRefIds: []
        }, "2026-04-04T16:23:00.000Z")
      ],
      claims: [
        createPersistedGraphEnvelope(PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME, {
          claimId: "claim_profile_graph_enum_trimmed",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "   ",
          sensitive: false,
          sourceTaskId: "task_profile_graph_enum_trimmed_claim",
          sourceFingerprint: "fingerprint_profile_graph_enum_trimmed_claim",
          sourceTier: "  explicit_user_statement  ",
          assertedAt: "2026-04-04T16:23:10.000Z",
          validFrom: "2026-04-04T16:23:10.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "  instant  ",
          timeSource: "  user_stated  ",
          derivedFromObservationIds: [],
          projectionSourceIds: [],
          entityRefIds: [],
          active: true
        }, "2026-04-04T16:23:10.000Z")
      ],
      events: [
        createPersistedGraphEnvelope(PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME, {
          eventId: "event_profile_graph_enum_trimmed",
          stableRefId: null,
          family: "episode.candidate",
          title: "Avery follow-up",
          summary: "Avery followed up later.",
          redactionState: "  redacted  ",
          sensitive: false,
          sourceTaskId: "task_profile_graph_enum_trimmed_event",
          sourceFingerprint: "fingerprint_profile_graph_enum_trimmed_event",
          sourceTier: "  explicit_user_statement  ",
          assertedAt: "2026-04-04T16:23:20.000Z",
          observedAt: "2026-04-04T16:23:20.000Z",
          validFrom: "2026-04-04T16:23:20.000Z",
          validTo: null,
          redactedAt: null,
          timePrecision: "  instant  ",
          timeSource: "  user_stated  ",
          derivedFromObservationIds: [],
          projectionSourceIds: [],
          entityRefIds: []
        }, "2026-04-04T16:23:20.000Z")
      ]
    }
  });

  const observation = normalized.graph.observations.find(
    (entry) => entry.payload.observationId === "observation_profile_graph_enum_trimmed"
  );
  const claim = normalized.graph.claims.find(
    (entry) => entry.payload.claimId === "claim_profile_graph_enum_trimmed"
  );
  const event = normalized.graph.events.find(
    (entry) => entry.payload.eventId === "event_profile_graph_enum_trimmed"
  );

  assert.equal(observation?.payload.sourceTier, "explicit_user_statement");
  assert.equal(observation?.payload.timePrecision, "instant");
  assert.equal(observation?.payload.timeSource, "user_stated");
  assert.equal(observation?.payload.redactionState, "not_requested");

  assert.equal(claim?.payload.sourceTier, "explicit_user_statement");
  assert.equal(claim?.payload.timePrecision, "instant");
  assert.equal(claim?.payload.timeSource, "user_stated");
  assert.equal(claim?.payload.redactionState, undefined);

  assert.equal(event?.payload.sourceTier, "explicit_user_statement");
  assert.equal(event?.payload.timePrecision, "instant");
  assert.equal(event?.payload.timeSource, "user_stated");
  assert.equal(event?.payload.redactionState, "redacted");
  assert.equal(event?.payload.title, "[redacted episode]");
  assert.equal(event?.payload.summary, "[redacted episode details]");
  assert.equal(event?.payload.sensitive, true);
});

test("normalizeProfileMemoryState trims padded mutation-journal redaction state", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:26:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:26:00.000Z",
      events: [
        createPersistedGraphEnvelope(PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME, {
          eventId: "event_profile_graph_journal_redaction_trimmed",
          stableRefId: null,
          family: "episode.candidate",
          title: "Avery follow-up",
          summary: "Avery followed up later.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_journal_redaction_trimmed",
          sourceFingerprint: "fingerprint_profile_graph_journal_redaction_trimmed",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:25:00.000Z",
          observedAt: "2026-04-04T16:25:00.000Z",
          validFrom: "2026-04-04T16:25:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: [],
          entityRefIds: []
        }, "2026-04-04T16:25:00.000Z")
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 2,
        entries: [
          {
            journalEntryId: "journal_profile_graph_journal_redaction_trimmed",
            watermark: 1,
            recordedAt: "2026-04-04T16:25:30.000Z",
            sourceTaskId: "task_profile_graph_journal_redaction_trimmed",
            sourceFingerprint: "fingerprint_profile_graph_journal_redaction_trimmed",
            mutationEnvelopeHash: null,
            observationIds: [],
            claimIds: [],
            eventIds: ["event_profile_graph_journal_redaction_trimmed"],
            redactionState: "  requested  "
          }
        ]
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  assert.equal(
    normalized.graph.mutationJournal.entries[0]?.redactionState,
    "requested"
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.eventIds,
    ["event_profile_graph_journal_redaction_trimmed"]
  );
});

test("normalizeProfileMemoryState normalizes retained mutation-journal recordedAt", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:26:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:26:00.000Z",
      events: [
        createPersistedGraphEnvelope(PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME, {
          eventId: "event_profile_graph_journal_recorded_at_trimmed",
          stableRefId: null,
          family: "episode.candidate",
          title: "Avery follow-up",
          summary: "Avery followed up later.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_journal_recorded_at_trimmed",
          sourceFingerprint: "fingerprint_profile_graph_journal_recorded_at_trimmed",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:25:00.000Z",
          observedAt: "2026-04-04T16:25:00.000Z",
          validFrom: "2026-04-04T16:25:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: [],
          entityRefIds: []
        }, "2026-04-04T16:25:00.000Z")
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 3,
        entries: [
          {
            journalEntryId: "journal_profile_graph_journal_recorded_at_offset",
            watermark: 1,
            recordedAt: " 2026-04-04T11:25:30-05:00 ",
            sourceTaskId: "task_profile_graph_journal_recorded_at_offset",
            sourceFingerprint: "fingerprint_profile_graph_journal_recorded_at_offset",
            mutationEnvelopeHash: null,
            observationIds: [],
            claimIds: [],
            eventIds: ["event_profile_graph_journal_recorded_at_trimmed"],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_journal_recorded_at_fallback",
            watermark: 2,
            recordedAt: "not-a-date",
            sourceTaskId: "task_profile_graph_journal_recorded_at_fallback",
            sourceFingerprint: "fingerprint_profile_graph_journal_recorded_at_fallback",
            mutationEnvelopeHash: null,
            observationIds: [],
            claimIds: [],
            eventIds: ["event_profile_graph_journal_recorded_at_trimmed"],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.recordedAt),
    [
      "2026-04-04T16:25:30.000Z",
      "2026-04-04T16:26:00.000Z"
    ]
  );
});

test("normalizeProfileMemoryState repairs omitted and non-string retained mutation-journal recordedAt", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:27:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:27:00.000Z",
      events: [
        createPersistedGraphEnvelope(PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME, {
          eventId: "event_profile_graph_journal_recorded_at_missing_or_malformed",
          stableRefId: null,
          family: "episode.candidate",
          title: "Avery follow-up fallback",
          summary: "Avery followed up without retained journal timestamps.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_journal_recorded_at_missing_or_malformed",
          sourceFingerprint:
            "fingerprint_profile_graph_journal_recorded_at_missing_or_malformed",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:26:00.000Z",
          observedAt: "2026-04-04T16:26:00.000Z",
          validFrom: "2026-04-04T16:26:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: [],
          entityRefIds: []
        }, "2026-04-04T16:26:00.000Z")
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 3,
        entries: [
          {
            journalEntryId: "journal_profile_graph_journal_recorded_at_omitted",
            watermark: 1,
            sourceTaskId: "task_profile_graph_journal_recorded_at_omitted",
            sourceFingerprint: "fingerprint_profile_graph_journal_recorded_at_omitted",
            mutationEnvelopeHash: null,
            observationIds: [],
            claimIds: [],
            eventIds: ["event_profile_graph_journal_recorded_at_missing_or_malformed"],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_journal_recorded_at_non_string",
            watermark: 2,
            recordedAt: 7 as unknown as string,
            sourceTaskId: "task_profile_graph_journal_recorded_at_non_string",
            sourceFingerprint: "fingerprint_profile_graph_journal_recorded_at_non_string",
            mutationEnvelopeHash: null,
            observationIds: [],
            claimIds: [],
            eventIds: ["event_profile_graph_journal_recorded_at_missing_or_malformed"],
            redactionState: "not_requested"
          }
        ]
      }
    }
  });

  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.recordedAt),
    [
      "2026-04-04T16:27:00.000Z",
      "2026-04-04T16:27:00.000Z"
    ]
  );
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 3);
  assert.equal(normalized.graph.readModel.watermark, 2);
});

test("normalizeProfileMemoryState normalizes graph compaction lastCompactedAt", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:26:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:26:00.000Z",
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 7,
        lastCompactedAt: " 2026-04-04T11:25:30-05:00 ",
        maxObservationCount: 128,
        maxClaimCount: 256,
        maxEventCount: 64,
        maxJournalEntries: 32
      }
    }
  });
  const invalid = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:26:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:26:00.000Z",
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 7,
        lastCompactedAt: "not-a-date",
        maxObservationCount: 128,
        maxClaimCount: 256,
        maxEventCount: 64,
        maxJournalEntries: 32
      }
    }
  });

  assert.equal(
    normalized.graph.compaction.lastCompactedAt,
    "2026-04-04T16:25:30.000Z"
  );
  assert.equal(invalid.graph.compaction.lastCompactedAt, null);
});

test("normalizeProfileMemoryState normalizes retained graph updatedAt", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:26:00.000Z",
    graph: {
      updatedAt: " 2026-04-04T11:25:30-05:00 "
    }
  });
  const invalid = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:26:00.000Z",
    graph: {
      updatedAt: "not-a-date"
    }
  });

  assert.equal(normalized.graph.updatedAt, "2026-04-04T16:25:30.000Z");
  assert.equal(normalized.graph.readModel.rebuiltAt, "2026-04-04T16:25:30.000Z");
  assert.equal(invalid.graph.updatedAt, "2026-04-04T16:26:00.000Z");
  assert.equal(invalid.graph.readModel.rebuiltAt, "2026-04-04T16:26:00.000Z");
});

test("normalizeProfileMemoryState normalizes retained graph envelope createdAt", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:26:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:26:00.000Z",
      observations: [
        createPersistedGraphEnvelope(PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME, {
          observationId: "observation_profile_graph_created_at_trimmed",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.avery.context.1",
          normalizedValue: "Avery followed up later.",
          sensitive: false,
          sourceTaskId: "task_profile_graph_created_at_trimmed",
          sourceFingerprint: "fingerprint_profile_graph_created_at_trimmed",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:25:00.000Z",
          observedAt: "2026-04-04T16:25:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        }, " 2026-04-04T11:25:30-05:00 "),
        createPersistedGraphEnvelope(PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME, {
          observationId: "observation_profile_graph_created_at_fallback",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.avery.context.2",
          normalizedValue: "Avery replied the next day.",
          sensitive: false,
          sourceTaskId: "task_profile_graph_created_at_fallback",
          sourceFingerprint: "fingerprint_profile_graph_created_at_fallback",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:25:00.000Z",
          observedAt: "2026-04-04T16:25:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        }, "not-a-date")
      ]
    }
  });

  assert.deepEqual(
    Object.fromEntries(
      normalized.graph.observations.map((observation) => [
        observation.payload.observationId,
        observation.createdAt
      ])
    ),
    {
      observation_profile_graph_created_at_trimmed: "2026-04-04T16:25:30.000Z",
      observation_profile_graph_created_at_fallback: "2026-04-04T16:26:00.000Z"
    }
  );
});

test("normalizeProfileMemoryState repairs malformed observation redaction boundaries", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:18:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:18:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_lifecycle_active_stray",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "Lantern",
          redactionState: "not_requested",
          redactedAt: "2026-04-04T16:02:00.000Z",
          sensitive: false,
          sourceTaskId: "task_profile_graph_observation_lifecycle_active_stray",
          sourceFingerprint: "fingerprint_profile_graph_observation_lifecycle_active_stray",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:01:00.000Z",
          observedAt: "2026-04-04T16:01:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_lifecycle_redacted_raw",
          stableRefId: "stable_avery",
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "redacted",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_observation_lifecycle_redacted_raw",
          sourceFingerprint: "fingerprint_profile_graph_observation_lifecycle_redacted_raw",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:05:00.000Z",
          observedAt: "2026-04-04T16:05:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_avery"]
        })
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        conflictingCurrentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const observationById = new Map(
    normalized.graph.observations.map((observation) => [observation.payload.observationId, observation] as const)
  );
  assert.equal(
    observationById.get("observation_profile_graph_lifecycle_active_stray")?.payload.redactedAt,
    null
  );
  assert.equal(
    observationById.get("observation_profile_graph_lifecycle_active_stray")?.payload.normalizedValue,
    "Lantern"
  );
  assert.equal(
    observationById.get("observation_profile_graph_lifecycle_redacted_raw")?.payload.redactedAt,
    "2026-04-04T16:18:00.000Z"
  );
  assert.equal(
    observationById.get("observation_profile_graph_lifecycle_redacted_raw")?.payload.normalizedValue,
    null
  );
  assert.equal(
    observationById.get("observation_profile_graph_lifecycle_redacted_raw")?.payload.sensitive,
    true
  );
  assert.equal(
    observationById.get("observation_profile_graph_lifecycle_redacted_raw")?.payload.stableRefId,
    null
  );
  assert.deepEqual(
    observationById.get("observation_profile_graph_lifecycle_redacted_raw")?.payload.entityRefIds,
    []
  );
});

test("normalizeProfileMemoryState repairs malformed event lifecycle boundaries", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:20:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:20:00.000Z",
      observations: [],
      claims: [],
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_lifecycle_active_stray",
          stableRefId: null,
          family: "episode.candidate",
          title: "Owen still needs help",
          summary: "Owen still needs help.",
          redactionState: "not_requested",
          redactedAt: "2026-04-04T16:02:00.000Z",
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_lifecycle_active_stray",
          sourceFingerprint: "fingerprint_profile_graph_event_lifecycle_active_stray",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:01:00.000Z",
          observedAt: "2026-04-04T16:01:00.000Z",
          validFrom: "2026-04-04T16:01:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["episode_profile_graph_event_lifecycle_active_stray"],
          entityRefIds: ["entity_owen"]
        }),
        createGraphEventEnvelope({
          eventId: "event_profile_graph_lifecycle_redacted_active",
          stableRefId: "stable_episode_owen",
          family: "episode.candidate",
          title: "Raw forgotten title",
          summary: "Raw forgotten summary.",
          redactionState: "redacted",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_lifecycle_redacted_active",
          sourceFingerprint: "fingerprint_profile_graph_event_lifecycle_redacted_active",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:05:00.000Z",
          observedAt: "2026-04-04T16:05:00.000Z",
          validFrom: "2026-04-04T16:05:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_event_lifecycle_redacted_active"],
          projectionSourceIds: ["episode_profile_graph_event_lifecycle_redacted_active"],
          entityRefIds: ["entity_owen"]
        }),
        createGraphEventEnvelope({
          eventId: "event_profile_graph_lifecycle_redacted_resolved",
          stableRefId: null,
          family: "episode.candidate",
          title: "[redacted episode]",
          summary: "[redacted episode details]",
          redactionState: "redacted",
          redactedAt: "2026-04-04T16:14:00.000Z",
          sensitive: true,
          sourceTaskId: "task_profile_graph_event_lifecycle_redacted_resolved",
          sourceFingerprint: "fingerprint_profile_graph_event_lifecycle_redacted_resolved",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:10:00.000Z",
          observedAt: "2026-04-04T16:10:00.000Z",
          validFrom: "2026-04-04T16:10:00.000Z",
          validTo: "2026-04-04T16:13:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["episode_profile_graph_event_lifecycle_redacted_resolved"],
          entityRefIds: []
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        conflictingCurrentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const eventById = new Map(
    normalized.graph.events.map((event) => [event.payload.eventId, event] as const)
  );
  assert.equal(
    eventById.get("event_profile_graph_lifecycle_active_stray")?.payload.redactedAt,
    null
  );
  assert.equal(
    eventById.get("event_profile_graph_lifecycle_redacted_active")?.payload.validTo,
    "2026-04-04T16:20:00.000Z"
  );
  assert.equal(
    eventById.get("event_profile_graph_lifecycle_redacted_active")?.payload.redactedAt,
    "2026-04-04T16:20:00.000Z"
  );
  assert.equal(
    eventById.get("event_profile_graph_lifecycle_redacted_active")?.payload.title,
    "[redacted episode]"
  );
  assert.equal(
    eventById.get("event_profile_graph_lifecycle_redacted_active")?.payload.summary,
    "[redacted episode details]"
  );
  assert.equal(
    eventById.get("event_profile_graph_lifecycle_redacted_active")?.payload.sensitive,
    true
  );
  assert.equal(
    eventById.get("event_profile_graph_lifecycle_redacted_active")?.payload.stableRefId,
    null
  );
  assert.deepEqual(
    eventById.get("event_profile_graph_lifecycle_redacted_active")?.payload.derivedFromObservationIds,
    []
  );
  assert.deepEqual(
    eventById.get("event_profile_graph_lifecycle_redacted_active")?.payload.entityRefIds,
    []
  );
  assert.equal(
    eventById.get("event_profile_graph_lifecycle_redacted_resolved")?.payload.validTo,
    "2026-04-04T16:13:00.000Z"
  );
  assert.equal(
    eventById.get("event_profile_graph_lifecycle_redacted_resolved")?.payload.redactedAt,
    "2026-04-04T16:14:00.000Z"
  );
});

test("normalizeProfileMemoryState compacts observations against repaired redacted event lineage", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:21:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:21:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_redacted_event_lineage_old",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.1",
          normalizedValue: "Owen mentioned the issue.",
          sensitive: false,
          sourceTaskId: "task_profile_graph_redacted_event_lineage_old",
          sourceFingerprint: "fingerprint_profile_graph_redacted_event_lineage_old",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:01:00.000Z",
          observedAt: "2026-04-04T16:01:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_owen"]
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_redacted_event_lineage_new",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.milo.context.1",
          normalizedValue: "Milo followed up later.",
          sensitive: false,
          sourceTaskId: "task_profile_graph_redacted_event_lineage_new",
          sourceFingerprint: "fingerprint_profile_graph_redacted_event_lineage_new",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:02:00.000Z",
          observedAt: "2026-04-04T16:02:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_milo"]
        })
      ],
      claims: [],
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_redacted_event_lineage",
          stableRefId: null,
          family: "episode.candidate",
          title: "Raw forgotten event",
          summary: "Raw forgotten event summary.",
          redactionState: "redacted",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_redacted_event_lineage",
          sourceFingerprint: "fingerprint_profile_graph_redacted_event_lineage",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:01:30.000Z",
          observedAt: "2026-04-04T16:01:30.000Z",
          validFrom: "2026-04-04T16:01:30.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_redacted_event_lineage_old"],
          projectionSourceIds: ["episode_profile_graph_redacted_event_lineage"],
          entityRefIds: ["entity_owen"]
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        conflictingCurrentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 1,
        maxClaimCount: 2048,
        maxEventCount: 1024,
        maxJournalEntries: 4096
      }
    }
  });

  assert.deepEqual(
    normalized.graph.observations.map((observation) => observation.payload.observationId),
    ["observation_profile_graph_redacted_event_lineage_new"]
  );
  assert.deepEqual(
    normalized.graph.events[0]?.payload.derivedFromObservationIds,
    []
  );
});

test("normalizeProfileMemoryState prunes duplicate and dangling projection-source refs when retained source ids are padded", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:17:00.000Z",
    facts: [
      {
        id: " fact_profile_graph_projection_valid ",
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_projection_valid",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-04T16:16:00.000Z",
        confirmedAt: "2026-04-04T16:16:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-04T16:16:00.000Z"
      }
    ],
    episodes: [
      {
        id: " episode_profile_graph_projection_valid ",
        title: "Lantern sync",
        summary: "Lantern sync happened.",
        status: "unresolved",
        sourceTaskId: "task_profile_graph_projection_episode_valid",
        source: "user_input_pattern.episode_candidate",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        confidence: 0.8,
        observedAt: "2026-04-04T16:16:30.000Z",
        lastMentionedAt: "2026-04-04T16:16:30.000Z",
        lastUpdatedAt: "2026-04-04T16:16:30.000Z",
        resolvedAt: null,
        entityRefs: [],
        openLoopRefs: [],
        tags: []
      }
    ],
    graph: {
      updatedAt: "2026-04-04T16:17:00.000Z",
      observations: [],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_projection_duplicate",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_projection_duplicate",
          sourceFingerprint: "fingerprint_profile_graph_projection_duplicate",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:16:00.000Z",
          validFrom: "2026-04-04T16:16:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: [
            "fact_profile_graph_projection_valid",
            "fact_profile_graph_projection_missing",
            "fact_profile_graph_projection_valid",
            "episode_profile_graph_projection_valid"
          ],
          entityRefIds: [],
          active: true
        })
      ],
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_projection_duplicate",
          stableRefId: null,
          family: "episode.candidate",
          title: "Lantern sync",
          summary: "Lantern sync happened.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_projection_event_duplicate",
          sourceFingerprint: "fingerprint_profile_graph_projection_event_duplicate",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:16:30.000Z",
          observedAt: "2026-04-04T16:16:30.000Z",
          validFrom: "2026-04-04T16:16:30.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: [
            "episode_profile_graph_projection_valid",
            "episode_profile_graph_projection_missing",
            "episode_profile_graph_projection_valid",
            "fact_profile_graph_projection_valid"
          ],
          entityRefIds: []
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        conflictingCurrentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.deepEqual(
    normalized.graph.claims[0]?.payload.projectionSourceIds,
    ["fact_profile_graph_projection_valid"]
  );
  assert.deepEqual(
    normalized.graph.events[0]?.payload.projectionSourceIds,
    ["episode_profile_graph_projection_valid"]
  );
});

test("normalizeProfileMemoryState prunes duplicate entity refs from retained graph payloads", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T16:20:00.000Z",
    graph: {
      updatedAt: "2026-04-04T16:20:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_entity_ref_payload_duplicate",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.1",
          normalizedValue: "Owen mentioned Lantern.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_entity_ref_payload_duplicate_observation",
          sourceFingerprint: "fingerprint_profile_graph_entity_ref_payload_duplicate_observation",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:15:00.000Z",
          observedAt: "2026-04-04T16:15:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_owen", "entity_owen", "entity_owen"]
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_entity_ref_payload_duplicate",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "Lantern",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_entity_ref_payload_duplicate_claim",
          sourceFingerprint: "fingerprint_profile_graph_entity_ref_payload_duplicate_claim",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:15:00.000Z",
          validFrom: "2026-04-04T16:15:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_entity_ref_payload_duplicate"],
          entityRefIds: ["entity_lantern", "entity_lantern", "entity_lantern"],
          active: true
        })
      ],
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_entity_ref_payload_duplicate",
          stableRefId: null,
          family: "episode.candidate",
          title: "Lantern sync",
          summary: "Lantern sync happened.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_entity_ref_payload_duplicate_event",
          sourceFingerprint: "fingerprint_profile_graph_entity_ref_payload_duplicate_event",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T16:15:00.000Z",
          observedAt: "2026-04-04T16:15:00.000Z",
          validFrom: "2026-04-04T16:15:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["episode_profile_graph_entity_ref_payload_duplicate"],
          entityRefIds: ["entity_lantern", "entity_lantern"]
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        conflictingCurrentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const seededObservation = normalized.graph.observations.find(
    (observation) =>
      observation.payload.observationId ===
      "observation_profile_graph_entity_ref_payload_duplicate"
  );
  assert.deepEqual(
    seededObservation?.payload.entityRefIds,
    ["entity_owen"]
  );
  assert.deepEqual(
    normalized.graph.claims[0]?.payload.entityRefIds,
    ["entity_lantern"]
  );
  assert.deepEqual(
    normalized.graph.events[0]?.payload.entityRefIds,
    ["entity_lantern"]
  );
});

test("normalizeProfileMemoryState prunes dangling journal refs to missing graph records", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T15:00:00.000Z",
    graph: {
      updatedAt: "2026-04-04T15:00:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_journal_ref_valid",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_journal_ref_valid",
          sourceFingerprint: "fingerprint_profile_graph_journal_ref_valid",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T14:55:00.000Z",
          observedAt: "2026-04-04T14:55:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_journal_ref_valid",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_journal_ref_valid",
          sourceFingerprint: "fingerprint_profile_graph_journal_ref_valid",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T14:55:00.000Z",
          validFrom: "2026-04-04T14:55:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_journal_ref_valid"],
          projectionSourceIds: ["fact_profile_graph_journal_ref_valid"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 1,
        lastCompactedAt: "2026-04-03T20:00:00.000Z",
        maxObservationCount: 2048,
        maxClaimCount: 2048,
        maxEventCount: 1024,
        maxJournalEntries: 4096
      },
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 3,
        entries: [
          {
            journalEntryId: "journal_profile_graph_journal_ref_keep",
            watermark: 1,
            recordedAt: "2026-04-04T14:55:00.000Z",
            sourceTaskId: "task_profile_graph_journal_ref_keep",
            sourceFingerprint: "fingerprint_profile_graph_journal_ref_keep",
            mutationEnvelopeHash: null,
            observationIds: [
              "observation_profile_graph_journal_ref_valid",
              "observation_profile_graph_missing"
            ],
            claimIds: [
              "claim_profile_graph_journal_ref_missing",
              "claim_profile_graph_journal_ref_valid"
            ],
            eventIds: ["event_profile_graph_missing"],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_journal_ref_drop",
            watermark: 2,
            recordedAt: "2026-04-04T14:56:00.000Z",
            sourceTaskId: "task_profile_graph_journal_ref_drop",
            sourceFingerprint: "fingerprint_profile_graph_journal_ref_drop",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_missing_only"],
            claimIds: ["claim_profile_graph_journal_ref_missing_only"],
            eventIds: ["event_profile_graph_missing_only"],
            redactionState: "not_requested"
          }
        ]
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        conflictingCurrentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const canonicalJournalEntryId =
    `journal_${sha256HexFromCanonicalJson({
      recordedAt: "2026-04-04T14:55:00.000Z",
      sourceTaskId: "task_profile_graph_journal_ref_keep",
      sourceFingerprint: "fingerprint_profile_graph_journal_ref_keep",
      mutationEnvelopeHash: null,
      observationIds: ["observation_profile_graph_journal_ref_valid"],
      claimIds: ["claim_profile_graph_journal_ref_valid"],
      eventIds: [],
      redactionState: "not_requested"
    }).slice(0, 24)}`;
  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.journalEntryId),
    [canonicalJournalEntryId]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.claimIds,
    ["claim_profile_graph_journal_ref_valid"]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    ["observation_profile_graph_journal_ref_valid"]
  );
  assert.deepEqual(normalized.graph.mutationJournal.entries[0]?.eventIds, []);
});

test("normalizeProfileMemoryState collapses pruned journal entries that converge on one canonical replay payload", () => {
  const canonicalJournalEntryId =
    `journal_${sha256HexFromCanonicalJson({
      recordedAt: "2026-04-04T15:05:00.000Z",
      sourceTaskId: "task_profile_graph_journal_ref_collapse",
      sourceFingerprint: "fingerprint_profile_graph_journal_ref_collapse",
      mutationEnvelopeHash: null,
      observationIds: ["observation_profile_graph_journal_ref_collapse_valid"],
      claimIds: ["claim_profile_graph_journal_ref_collapse_valid"],
      eventIds: [],
      redactionState: "not_requested"
    }).slice(0, 24)}`;
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T15:10:00.000Z",
    graph: {
      updatedAt: "2026-04-04T15:10:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_journal_ref_collapse_valid",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.help",
          normalizedValue: "Owen still needs help",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_journal_ref_collapse",
          sourceFingerprint: "fingerprint_profile_graph_journal_ref_collapse",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T15:05:00.000Z",
          observedAt: "2026-04-04T15:05:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_journal_ref_collapse_valid",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.help",
          normalizedValue: "Owen still needs help",          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_journal_ref_collapse",
          sourceFingerprint: "fingerprint_profile_graph_journal_ref_collapse",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T15:05:00.000Z",
          validFrom: "2026-04-04T15:05:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_journal_ref_collapse_valid"],
          projectionSourceIds: [],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 1,
        lastCompactedAt: "2026-04-04T15:00:00.000Z",
        maxObservationCount: 2048,
        maxClaimCount: 2048,
        maxEventCount: 1024,
        maxJournalEntries: 4096
      },
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 3,
        entries: [
          {
            journalEntryId: "journal_profile_graph_journal_ref_collapse_a",
            watermark: 1,
            recordedAt: "2026-04-04T15:05:00.000Z",
            sourceTaskId: "task_profile_graph_journal_ref_collapse",
            sourceFingerprint: "fingerprint_profile_graph_journal_ref_collapse",
            mutationEnvelopeHash: null,
            observationIds: [
              "observation_profile_graph_journal_ref_collapse_valid",
              "observation_profile_graph_journal_ref_collapse_missing"
            ],
            claimIds: ["claim_profile_graph_journal_ref_collapse_valid"],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_journal_ref_collapse_b",
            watermark: 2,
            recordedAt: "2026-04-04T15:05:00.000Z",
            sourceTaskId: "task_profile_graph_journal_ref_collapse",
            sourceFingerprint: "fingerprint_profile_graph_journal_ref_collapse",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_journal_ref_collapse_valid"],
            claimIds: ["claim_profile_graph_journal_ref_collapse_valid"],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        conflictingCurrentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  assert.equal(normalized.graph.mutationJournal.entries[0]?.journalEntryId, canonicalJournalEntryId);
  assert.equal(normalized.graph.mutationJournal.entries[0]?.watermark, 2);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    ["observation_profile_graph_journal_ref_collapse_valid"]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.claimIds,
    ["claim_profile_graph_journal_ref_collapse_valid"]
  );
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 3);
  assert.equal(normalized.graph.readModel.watermark, 2);
});

test("normalizeProfileMemoryState collapses semantic-duplicate active claims to one canonical winner", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T14:10:00.000Z",
    facts: [
      {
        id: "fact_profile_graph_duplicate_active_1",
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: true,
        status: "confirmed",
        confidence: 0.92,
        sourceTaskId: "task_profile_graph_duplicate_active_1",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-04T13:00:00.000Z",
        confirmedAt: "2026-04-04T13:00:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-04T13:00:00.000Z"
      },
      {
        id: "fact_profile_graph_duplicate_active_2",
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: false,
        status: "uncertain",
        confidence: 0.71,
        sourceTaskId: "task_profile_graph_duplicate_active_2",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-04T13:05:00.000Z",
        confirmedAt: null,
        supersededAt: null,
        lastUpdatedAt: "2026-04-04T13:05:00.000Z"
      }
    ],
    graph: {
      updatedAt: "2026-04-04T14:10:00.000Z",
      observations: [],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_duplicate_active_1",
          stableRefId: "stable_avery",
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: true,
          sourceTaskId: "task_profile_graph_duplicate_active_1",
          sourceFingerprint: "fingerprint_profile_graph_duplicate_active_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T13:00:00.000Z",
          validFrom: "2026-04-04T13:00:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_duplicate_active_1"],
          projectionSourceIds: ["fact_profile_graph_duplicate_active_1"],
          entityRefIds: ["entity_avery"],
          active: true
        }, "2026-04-04T13:00:00.000Z"),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_duplicate_active_2",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: null,
          sourceFingerprint: "fingerprint_profile_graph_duplicate_active_2",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-04T13:05:00.000Z",
          validFrom: "2026-04-04T13:05:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_duplicate_active_2"],
          projectionSourceIds: ["fact_profile_graph_duplicate_active_2"],
          entityRefIds: [],
          active: true
        }, "2026-04-04T13:05:00.000Z")
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 3,
        entries: [
          {
            journalEntryId: "journal_profile_graph_duplicate_active_1",
            watermark: 1,
            recordedAt: "2026-04-04T13:00:00.000Z",
            sourceTaskId: "task_profile_graph_duplicate_active_1",
            sourceFingerprint: "fingerprint_profile_graph_duplicate_active_1",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_duplicate_active_1"],
            claimIds: ["claim_profile_graph_duplicate_active_1"],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_duplicate_active_2",
            watermark: 2,
            recordedAt: "2026-04-04T13:05:00.000Z",
            sourceTaskId: "task_profile_graph_duplicate_active_2",
            sourceFingerprint: "fingerprint_profile_graph_duplicate_active_2",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_duplicate_active_2"],
            claimIds: ["claim_profile_graph_duplicate_active_2"],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 2048,
        maxClaimCount: 2048,
        maxEventCount: 1024,
        maxJournalEntries: 1024
      }
    }
  });

  assert.equal(normalized.graph.claims.length, 3);
  assert.equal(normalized.graph.observations.length, 1);
  const activeClaims = normalized.graph.claims.filter((claim) => claim.payload.active);
  const inactiveClaims = normalized.graph.claims.filter((claim) => !claim.payload.active);
  assert.equal(activeClaims.length, 1);
  assert.equal(inactiveClaims.length, 2);
  assert.notEqual(activeClaims[0]?.payload.claimId, "claim_profile_graph_duplicate_active_1");
  assert.notEqual(activeClaims[0]?.payload.claimId, "claim_profile_graph_duplicate_active_2");
  assert.equal(activeClaims[0]?.payload.stableRefId, "stable_self_profile_owner");
  assert.equal(activeClaims[0]?.payload.sensitive, true);
  assert.deepEqual(
    [...(activeClaims[0]?.payload.derivedFromObservationIds ?? [])].sort((left, right) =>
      left.localeCompare(right)
    ),
    normalized.graph.observations
      .map((observation) => observation.payload.observationId)
      .sort((left, right) => left.localeCompare(right))
  );
  assert.deepEqual(activeClaims[0]?.payload.projectionSourceIds, [
    "fact_profile_graph_duplicate_active_1"
  ]);
  assert.deepEqual(activeClaims[0]?.payload.entityRefIds, []);
  assert.deepEqual(
    inactiveClaims.map((claim) => claim.payload.endedByClaimId),
    [activeClaims[0]?.payload.claimId, activeClaims[0]?.payload.claimId]
  );
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
    activeClaims[0]?.payload.claimId
  );
  assert.deepEqual(
    normalized.graph.readModel.inventoryClaimIdsByFamily["identity.preferred_name"],
    [activeClaims[0]?.payload.claimId]
  );
  assert.deepEqual(normalized.graph.readModel.conflictingCurrentClaimIdsByKey, {});
  assert.deepEqual(normalized.graph.indexes.activeClaimIds, [
    activeClaims[0]?.payload.claimId
  ]);
});

test("normalizeProfileMemoryState keeps semantic-duplicate retained current claims from inheriting stale loser lineage or provenance metadata", () => {
  const emptyState = createEmptyProfileMemoryState();
  const normalized = normalizeProfileMemoryState({
    ...emptyState,
    updatedAt: "2026-04-06T16:10:00.000Z",
    facts: [
      {
        id: "fact_profile_graph_duplicate_loser_lineage_old",
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: false,
        status: "superseded",
        confidence: 0.6,
        sourceTaskId: "task_profile_graph_duplicate_loser_lineage_old",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-06T13:00:00.000Z",
        confirmedAt: "2026-04-06T13:00:00.000Z",
        supersededAt: "2026-04-06T15:30:00.000Z",
        lastUpdatedAt: "2026-04-06T15:30:00.000Z"
      },
      {
        id: "fact_profile_graph_duplicate_loser_lineage_current",
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: false,
        status: "superseded",
        confidence: 0.7,
        sourceTaskId: "task_profile_graph_duplicate_loser_lineage_current",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-06T13:05:00.000Z",
        confirmedAt: "2026-04-06T13:05:00.000Z",
        supersededAt: "2026-04-06T15:35:00.000Z",
        lastUpdatedAt: "2026-04-06T15:35:00.000Z"
      }
    ],
    graph: {
      ...emptyState.graph,
      updatedAt: "2026-04-06T16:10:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_duplicate_loser_lineage_old",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_duplicate_loser_lineage_old",
          sourceFingerprint: "fingerprint_profile_graph_duplicate_loser_lineage_old",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-06T13:00:00.000Z",
          observedAt: "2026-04-06T13:00:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        }, "2026-04-06T13:00:00.000Z"),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_duplicate_loser_lineage_current",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_duplicate_loser_lineage_current",
          sourceFingerprint: "fingerprint_profile_graph_duplicate_loser_lineage_current",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-06T13:05:00.000Z",
          observedAt: "2026-04-06T13:05:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        }, "2026-04-06T13:05:00.000Z")
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_duplicate_loser_lineage_old",
          stableRefId: "stable_avery_old",
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_duplicate_loser_lineage_old",
          sourceFingerprint: "fingerprint_profile_graph_duplicate_loser_lineage_old",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-06T13:00:00.000Z",
          validFrom: "2026-04-06T13:00:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_duplicate_loser_lineage_old"],
          projectionSourceIds: ["fact_profile_graph_duplicate_loser_lineage_old"],
          entityRefIds: ["entity_avery_stray"],
          active: true
        }, "2026-04-06T13:00:00.000Z"),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_duplicate_loser_lineage_current",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: null,
          sourceFingerprint: "fingerprint_profile_graph_duplicate_loser_lineage_current",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-06T13:05:00.000Z",
          validFrom: "2026-04-06T13:05:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_duplicate_loser_lineage_current"],
          projectionSourceIds: ["fact_profile_graph_duplicate_loser_lineage_current"],
          entityRefIds: [],
          active: true
        }, "2026-04-06T13:05:00.000Z")
      ]
    }
  });

  assert.equal(normalized.graph.claims.length, 2);
  assert.equal(normalized.graph.observations.length, 2);
  const activeClaims = normalized.graph.claims.filter((claim) => claim.payload.active);
  const inactiveClaims = normalized.graph.claims.filter((claim) => !claim.payload.active);
  assert.equal(activeClaims.length, 1);
  assert.equal(inactiveClaims.length, 1);
  assert.equal(
    activeClaims[0]?.payload.claimId,
    "claim_profile_graph_duplicate_loser_lineage_current"
  );
  assert.equal(activeClaims[0]?.payload.stableRefId, "stable_self_profile_owner");
  assert.equal(activeClaims[0]?.payload.sourceTaskId, null);
  assert.deepEqual(
    [...(activeClaims[0]?.payload.derivedFromObservationIds ?? [])].sort((left, right) =>
      left.localeCompare(right)
    ),
    [
      "observation_profile_graph_duplicate_loser_lineage_current",
      "observation_profile_graph_duplicate_loser_lineage_old"
    ]
  );
  assert.deepEqual(activeClaims[0]?.payload.projectionSourceIds, [
    "fact_profile_graph_duplicate_loser_lineage_current"
  ]);
  assert.deepEqual(activeClaims[0]?.payload.entityRefIds, []);
  assert.equal(
    inactiveClaims[0]?.payload.endedByClaimId,
    "claim_profile_graph_duplicate_loser_lineage_current"
  );
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
    "claim_profile_graph_duplicate_loser_lineage_current"
  );
  assert.deepEqual(
    normalized.graph.readModel.inventoryClaimIdsByFamily["identity.preferred_name"],
    ["claim_profile_graph_duplicate_loser_lineage_current"]
  );
  assert.deepEqual(normalized.graph.readModel.conflictingCurrentClaimIdsByKey, {});
  assert.deepEqual(normalized.graph.indexes.activeClaimIds, [
    "claim_profile_graph_duplicate_loser_lineage_current"
  ]);
});

test("normalizeProfileMemoryState keeps current-surface-ineligible semantic duplicates from closing valid explicit claims", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-06T03:10:00.000Z",
    graph: {
      updatedAt: "2026-04-06T03:10:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_duplicate_invalid_explicit",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_duplicate_invalid_explicit",
          sourceFingerprint: "fingerprint_profile_graph_duplicate_invalid_explicit",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-06T02:00:00.000Z",
          observedAt: "2026-04-06T02:00:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_duplicate_invalid_assistant",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_duplicate_invalid_assistant",
          sourceFingerprint: "fingerprint_profile_graph_duplicate_invalid_assistant",
          sourceTier: "assistant_inference",
          assertedAt: "2026-04-06T02:05:00.000Z",
          observedAt: "2026-04-06T02:05:00.000Z",
          timePrecision: "instant",
          timeSource: "inferred",
          entityRefIds: []
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_duplicate_invalid_explicit",
          stableRefId: "stable_avery_explicit",
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_duplicate_invalid_explicit",
          sourceFingerprint: "fingerprint_profile_graph_duplicate_invalid_explicit",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-06T02:00:00.000Z",
          validFrom: "2026-04-06T02:00:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_duplicate_invalid_explicit"],
          projectionSourceIds: ["fact_profile_graph_duplicate_invalid_explicit"],
          entityRefIds: ["entity_avery"],
          active: true
        }, "2026-04-06T02:00:00.000Z"),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_duplicate_invalid_assistant",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_duplicate_invalid_assistant",
          sourceFingerprint: "fingerprint_profile_graph_duplicate_invalid_assistant",
          sourceTier: "assistant_inference",
          assertedAt: "2026-04-06T02:05:00.000Z",
          validFrom: "2026-04-06T02:05:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "inferred",
          derivedFromObservationIds: ["observation_profile_graph_duplicate_invalid_assistant"],
          projectionSourceIds: ["fact_profile_graph_duplicate_invalid_assistant"],
          entityRefIds: [],
          active: true
        }, "2026-04-06T02:05:00.000Z")
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 3,
        entries: [
          {
            journalEntryId: "journal_profile_graph_duplicate_invalid_explicit",
            watermark: 1,
            recordedAt: "2026-04-06T02:00:00.000Z",
            sourceTaskId: "task_profile_graph_duplicate_invalid_explicit",
            sourceFingerprint: "fingerprint_profile_graph_duplicate_invalid_explicit",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_duplicate_invalid_explicit"],
            claimIds: ["claim_profile_graph_duplicate_invalid_explicit"],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_duplicate_invalid_assistant",
            watermark: 2,
            recordedAt: "2026-04-06T02:05:00.000Z",
            sourceTaskId: "task_profile_graph_duplicate_invalid_assistant",
            sourceFingerprint: "fingerprint_profile_graph_duplicate_invalid_assistant",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_duplicate_invalid_assistant"],
            claimIds: ["claim_profile_graph_duplicate_invalid_assistant"],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        conflictingCurrentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 2048,
        maxClaimCount: 2048,
        maxEventCount: 1024,
        maxJournalEntries: 1024
      }
    }
  });

  assert.equal(normalized.graph.claims.length, 2);
  assert.equal(normalized.graph.observations.length, 2);
  const activeClaims = normalized.graph.claims.filter((claim) => claim.payload.active);
  assert.equal(activeClaims.length, 2);
  assert.deepEqual(
    activeClaims.map((claim) => claim.payload.claimId).sort((left, right) => left.localeCompare(right)),
    [
      "claim_profile_graph_duplicate_invalid_assistant",
      "claim_profile_graph_duplicate_invalid_explicit"
    ]
  );
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
    "claim_profile_graph_duplicate_invalid_explicit"
  );
  assert.deepEqual(
    normalized.graph.readModel.inventoryClaimIdsByFamily["identity.preferred_name"],
    ["claim_profile_graph_duplicate_invalid_explicit"]
  );
  assert.deepEqual(normalized.graph.readModel.conflictingCurrentClaimIdsByKey, {});
  assert.deepEqual(
    normalized.graph.indexes.activeClaimIds.sort((left, right) => left.localeCompare(right)),
    [
      "claim_profile_graph_duplicate_invalid_assistant",
      "claim_profile_graph_duplicate_invalid_explicit"
    ]
  );
});

test("normalizeProfileMemoryState dedupes malformed duplicate journal entries and repairs replay watermarks", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:40:00.000Z",
    graph: {
      updatedAt: "2026-04-03T20:40:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_1",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.1",
          normalizedValue: "Owen still needs help",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_duplicate_observation",
          sourceFingerprint: "fingerprint_profile_graph_duplicate_observation",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:01:00.000Z",
          observedAt: "2026-04-03T20:01:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_1",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_duplicate_claim",
          sourceFingerprint: "fingerprint_profile_graph_duplicate_claim",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:02:00.000Z",
          validFrom: "2026-04-03T20:02:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_duplicate_claim_1"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 3,
        entries: [
          {
            journalEntryId: "journal_profile_graph_duplicate_a",
            watermark: 1,
            recordedAt: "2026-04-03T20:01:00.000Z",
            sourceTaskId: "task_profile_graph_duplicate_a",
            sourceFingerprint: "fingerprint_profile_graph_duplicate_a",
            mutationEnvelopeHash: null,
            observationIds: ["observation_1", "observation_1"],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_duplicate_a",
            watermark: 2,
            recordedAt: "2026-04-03T20:01:00.000Z",
            sourceTaskId: "task_profile_graph_duplicate_a",
            sourceFingerprint: "fingerprint_profile_graph_duplicate_a",
            mutationEnvelopeHash: null,
            observationIds: ["observation_1"],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_duplicate_b",
            watermark: 2,
            recordedAt: "2026-04-03T20:02:00.000Z",
            sourceTaskId: "task_profile_graph_duplicate_b",
            sourceFingerprint: "fingerprint_profile_graph_duplicate_b",
            mutationEnvelopeHash: null,
            observationIds: [],
            claimIds: ["claim_1", "claim_1"],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 1,
        lastCompactedAt: "2026-04-03T20:00:00.000Z",
        maxObservationCount: 2048,
        maxClaimCount: 2048,
        maxEventCount: 1024,
        maxJournalEntries: 4096
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 2);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.journalEntryId),
    [
      "journal_profile_graph_duplicate_a",
      "journal_profile_graph_duplicate_b"
    ]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [2, 3]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    ["observation_1"]
  );
  assert.deepEqual(normalized.graph.mutationJournal.entries[1]?.claimIds, ["claim_1"]);
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 4);
  assert.equal(normalized.graph.readModel.watermark, 3);
});

test("normalizeProfileMemoryState breaks same-id same-watermark journal freshness ties by canonical replay payload", () => {
  const sharedJournalEntryId = "journal_profile_graph_duplicate_payload_tie";
  const sharedObservationId = "observation_payload_tie_shared";
  const leftPayloadSourceFingerprint = "fingerprint_profile_graph_duplicate_payload_tie_left";
  const rightPayloadSourceFingerprint = "fingerprint_profile_graph_duplicate_payload_tie_right";
  const leftCanonicalJournalEntryId =
    `journal_${sha256HexFromCanonicalJson({
      recordedAt: "2026-04-03T20:03:00.000Z",
      sourceTaskId: "task_profile_graph_duplicate_payload_tie",
      sourceFingerprint: leftPayloadSourceFingerprint,
      mutationEnvelopeHash: null,
      observationIds: [sharedObservationId],
      claimIds: [],
      eventIds: [],
      redactionState: "not_requested"
    }).slice(0, 24)}`;
  const rightCanonicalJournalEntryId =
    `journal_${sha256HexFromCanonicalJson({
      recordedAt: "2026-04-03T20:03:00.000Z",
      sourceTaskId: "task_profile_graph_duplicate_payload_tie",
      sourceFingerprint: rightPayloadSourceFingerprint,
      mutationEnvelopeHash: null,
      observationIds: [sharedObservationId],
      claimIds: [],
      eventIds: [],
      redactionState: "not_requested"
    }).slice(0, 24)}`;
  const expectedSourceFingerprint =
    leftCanonicalJournalEntryId.localeCompare(rightCanonicalJournalEntryId) >= 0
      ? leftPayloadSourceFingerprint
      : rightPayloadSourceFingerprint;
  const losingSourceFingerprint =
    expectedSourceFingerprint === leftPayloadSourceFingerprint
      ? rightPayloadSourceFingerprint
      : leftPayloadSourceFingerprint;
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:05:00.000Z",
    graph: {
      updatedAt: "2026-04-03T20:05:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: sharedObservationId,
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.payload.tie.shared",
          normalizedValue: "Owen still needs shared help",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_duplicate_payload_tie",
          sourceFingerprint: "fingerprint_profile_graph_duplicate_payload_tie_seed",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:03:00.000Z",
          observedAt: "2026-04-03T20:03:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 2,
        entries: [
          {
            journalEntryId: sharedJournalEntryId,
            watermark: 1,
            recordedAt: "2026-04-03T20:03:00.000Z",
            sourceTaskId: "task_profile_graph_duplicate_payload_tie",
            sourceFingerprint: losingSourceFingerprint,
            mutationEnvelopeHash: null,
            observationIds: [sharedObservationId],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: sharedJournalEntryId,
            watermark: 1,
            recordedAt: "2026-04-03T20:03:00.000Z",
            sourceTaskId: "task_profile_graph_duplicate_payload_tie",
            sourceFingerprint: expectedSourceFingerprint,
            mutationEnvelopeHash: null,
            observationIds: [sharedObservationId],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 2048,
        maxClaimCount: 2048,
        maxEventCount: 1024,
        maxJournalEntries: 4096
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  assert.equal(
    normalized.graph.mutationJournal.entries[0]?.journalEntryId,
    sharedJournalEntryId
  );
  assert.equal(
    normalized.graph.mutationJournal.entries[0]?.sourceFingerprint,
    expectedSourceFingerprint
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    [sharedObservationId]
  );
  assert.equal(normalized.graph.mutationJournal.entries[0]?.watermark, 1);
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 2);
  assert.equal(normalized.graph.readModel.watermark, 1);
});

test("normalizeProfileMemoryState dedupes retained journal entries that share one canonical replay payload but carry different stored ids", () => {
  const canonicalJournalEntryId =
    `journal_${sha256HexFromCanonicalJson({
      recordedAt: "2026-04-03T20:01:00.000Z",
      sourceTaskId: "task_profile_graph_duplicate_payload",
      sourceFingerprint: "fingerprint_profile_graph_duplicate_payload",
      mutationEnvelopeHash: null,
      observationIds: ["observation_payload_1"],
      claimIds: [],
      eventIds: [],
      redactionState: "not_requested"
    }).slice(0, 24)}`;
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:05:00.000Z",
    graph: {
      updatedAt: "2026-04-03T20:05:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_payload_1",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.payload",
          normalizedValue: "Owen still needs help",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_duplicate_payload",
          sourceFingerprint: "fingerprint_profile_graph_duplicate_payload",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:01:00.000Z",
          observedAt: "2026-04-03T20:01:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 3,
        entries: [
          {
            journalEntryId: "   ",
            watermark: 1,
            recordedAt: "2026-04-03T20:01:00.000Z",
            sourceTaskId: "task_profile_graph_duplicate_payload",
            sourceFingerprint: "fingerprint_profile_graph_duplicate_payload",
            mutationEnvelopeHash: null,
            observationIds: ["observation_payload_1"],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_duplicate_payload_legacy",
            watermark: 2,
            recordedAt: "2026-04-03T20:01:00.000Z",
            sourceTaskId: "task_profile_graph_duplicate_payload",
            sourceFingerprint: "fingerprint_profile_graph_duplicate_payload",
            mutationEnvelopeHash: null,
            observationIds: ["observation_payload_1"],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 2048,
        maxClaimCount: 2048,
        maxEventCount: 1024,
        maxJournalEntries: 4096
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  assert.equal(
    normalized.graph.mutationJournal.entries[0]?.journalEntryId,
    canonicalJournalEntryId
  );
  assert.equal(normalized.graph.mutationJournal.entries[0]?.watermark, 2);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    ["observation_payload_1"]
  );
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 3);
  assert.equal(normalized.graph.readModel.watermark, 2);
});

test("appendProfileMemoryMutationJournalEntry treats retained legacy ids with matching canonical replay payload as already appended", () => {
  const payload = {
    recordedAt: "2026-04-03T20:01:00.000Z",
    sourceTaskId: "task_profile_graph_duplicate_payload",
    sourceFingerprint: "fingerprint_profile_graph_duplicate_payload",
    mutationEnvelopeHash: null,
    observationIds: ["observation_payload_1"],
    claimIds: [],
    eventIds: [],
    redactionState: "not_requested" as const
  };
  const canonicalJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(payload).slice(0, 24)}`;
  const existingEntry = {
    journalEntryId: "journal_profile_graph_duplicate_payload_legacy",
    watermark: 1,
    ...payload
  };
  const state = {
    schemaVersion: "v1" as const,
    nextWatermark: 2,
    entries: [existingEntry]
  };

  const result = appendProfileMemoryMutationJournalEntry(state, payload);

  assert.notEqual(existingEntry.journalEntryId, canonicalJournalEntryId);
  assert.equal(result.appended, false);
  assert.equal(result.entry?.journalEntryId, existingEntry.journalEntryId);
  assert.equal(result.nextState, state);
});

test("appendProfileMemoryMutationJournalEntry treats trimmed duplicate refs and blank optional metadata as already appended", () => {
  const canonicalPayload = {
    recordedAt: "2026-04-08T15:25:00.000Z",
    sourceTaskId: null,
    sourceFingerprint: null,
    mutationEnvelopeHash: null,
    observationIds: [
      "observation_append_payload_1",
      "observation_append_payload_2"
    ],
    claimIds: ["claim_append_payload_1"],
    eventIds: ["event_append_payload_1"],
    redactionState: "not_requested" as const
  };
  const existingEntry = {
    journalEntryId: "journal_profile_graph_append_trimmed_duplicate_payload_legacy",
    watermark: 3,
    ...canonicalPayload
  };
  const state = {
    schemaVersion: "v1" as const,
    nextWatermark: 4,
    entries: [existingEntry]
  };

  const result = appendProfileMemoryMutationJournalEntry(state, {
    recordedAt: canonicalPayload.recordedAt,
    sourceTaskId: "   ",
    sourceFingerprint: "\t",
    mutationEnvelopeHash: "  ",
    observationIds: [
      " observation_append_payload_2 ",
      "observation_append_payload_1",
      "observation_append_payload_2",
      "   "
    ],
    claimIds: [
      " claim_append_payload_1 ",
      "",
      "claim_append_payload_1"
    ],
    eventIds: [
      " event_append_payload_1 ",
      "event_append_payload_1"
    ],
    redactionState: "not_requested"
  });

  assert.equal(result.appended, false);
  assert.equal(result.entry?.journalEntryId, existingEntry.journalEntryId);
  assert.equal(result.nextState, state);
});

test("appendProfileMemoryMutationJournalEntry canonicalizes trimmed refs and blank optional metadata when appending a new replay entry", () => {
  const canonicalPayload = {
    recordedAt: "2026-04-08T15:35:00.000Z",
    sourceTaskId: null,
    sourceFingerprint: null,
    mutationEnvelopeHash: null,
    observationIds: [
      "observation_append_new_payload_1",
      "observation_append_new_payload_2"
    ],
    claimIds: ["claim_append_new_payload_1"],
    eventIds: ["event_append_new_payload_1"],
    redactionState: "not_requested" as const
  };
  const expectedEntry = {
    journalEntryId:
      `journal_${sha256HexFromCanonicalJson(canonicalPayload).slice(0, 24)}`,
    watermark: 7,
    ...canonicalPayload
  };
  const state = {
    schemaVersion: "v1" as const,
    nextWatermark: 7,
    entries: []
  };

  const result = appendProfileMemoryMutationJournalEntry(state, {
    recordedAt: canonicalPayload.recordedAt,
    sourceTaskId: "   ",
    sourceFingerprint: "\t",
    mutationEnvelopeHash: "  ",
    observationIds: [
      " observation_append_new_payload_2 ",
      "observation_append_new_payload_1",
      "observation_append_new_payload_2",
      "  "
    ],
    claimIds: [
      " claim_append_new_payload_1 ",
      "claim_append_new_payload_1",
      ""
    ],
    eventIds: [
      " event_append_new_payload_1 ",
      "event_append_new_payload_1",
      " "
    ]
  });

  assert.equal(result.appended, true);
  assert.deepEqual(result.entry, expectedEntry);
  assert.equal(result.nextState.nextWatermark, 8);
  assert.deepEqual(result.nextState.entries, [expectedEntry]);
});

test("compactProfileMemoryMutationJournalState clamps snapshotWatermark without restamping lastCompactedAt when no overflow occurs", () => {
  const state = {
    schemaVersion: "v1" as const,
    nextWatermark: 5,
    entries: [
      {
        journalEntryId: "journal_compaction_snapshot_clamp_3",
        watermark: 3,
        recordedAt: "2026-04-08T16:00:00.000Z",
        sourceTaskId: "task_compaction_snapshot_clamp_3",
        sourceFingerprint: "fingerprint_compaction_snapshot_clamp_3",
        mutationEnvelopeHash: null,
        observationIds: ["observation_compaction_snapshot_clamp_3"],
        claimIds: [],
        eventIds: [],
        redactionState: "not_requested" as const
      },
      {
        journalEntryId: "journal_compaction_snapshot_clamp_4",
        watermark: 4,
        recordedAt: "2026-04-08T16:01:00.000Z",
        sourceTaskId: "task_compaction_snapshot_clamp_4",
        sourceFingerprint: "fingerprint_compaction_snapshot_clamp_4",
        mutationEnvelopeHash: null,
        observationIds: [],
        claimIds: ["claim_compaction_snapshot_clamp_4"],
        eventIds: [],
        redactionState: "not_requested" as const
      }
    ]
  };
  const compaction = {
    schemaVersion: "v1" as const,
    snapshotWatermark: 99,
    lastCompactedAt: "2026-04-08T15:30:00.000Z",
    maxObservationCount: 2048,
    maxClaimCount: 2048,
    maxEventCount: 1024,
    maxJournalEntries: 4
  };

  const result = compactProfileMemoryMutationJournalState({
    state,
    compaction,
    recordedAt: "2026-04-08T16:05:00.000Z"
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState, state);
  assert.notEqual(result.nextCompaction, compaction);
  assert.equal(result.nextCompaction.snapshotWatermark, 2);
  assert.equal(result.nextCompaction.lastCompactedAt, "2026-04-08T15:30:00.000Z");
});

test("compactProfileMemoryMutationJournalState clamps snapshotWatermark from nextWatermark when no retained journal entries remain", () => {
  const state = {
    schemaVersion: "v1" as const,
    nextWatermark: 6,
    entries: []
  };
  const compaction = {
    schemaVersion: "v1" as const,
    snapshotWatermark: 99,
    lastCompactedAt: "2026-04-08T15:45:00.000Z",
    maxObservationCount: 2048,
    maxClaimCount: 2048,
    maxEventCount: 1024,
    maxJournalEntries: 4
  };

  const result = compactProfileMemoryMutationJournalState({
    state,
    compaction,
    recordedAt: "2026-04-08T16:10:00.000Z"
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState, state);
  assert.notEqual(result.nextCompaction, compaction);
  assert.equal(result.nextCompaction.snapshotWatermark, 5);
  assert.equal(result.nextCompaction.lastCompactedAt, "2026-04-08T15:45:00.000Z");
});

test("compactProfileMemoryMutationJournalState stays a true no-op when journal and compaction are already replay-safe", () => {
  const state = {
    schemaVersion: "v1" as const,
    nextWatermark: 5,
    entries: [
      {
        journalEntryId: "journal_compaction_no_op_3",
        watermark: 3,
        recordedAt: "2026-04-08T16:20:00.000Z",
        sourceTaskId: "task_compaction_no_op_3",
        sourceFingerprint: "fingerprint_compaction_no_op_3",
        mutationEnvelopeHash: null,
        observationIds: ["observation_compaction_no_op_3"],
        claimIds: [],
        eventIds: [],
        redactionState: "not_requested" as const
      },
      {
        journalEntryId: "journal_compaction_no_op_4",
        watermark: 4,
        recordedAt: "2026-04-08T16:21:00.000Z",
        sourceTaskId: "task_compaction_no_op_4",
        sourceFingerprint: "fingerprint_compaction_no_op_4",
        mutationEnvelopeHash: null,
        observationIds: [],
        claimIds: ["claim_compaction_no_op_4"],
        eventIds: [],
        redactionState: "not_requested" as const
      }
    ]
  };
  const compaction = {
    schemaVersion: "v1" as const,
    snapshotWatermark: 2,
    lastCompactedAt: "2026-04-08T16:00:00.000Z",
    maxObservationCount: 2048,
    maxClaimCount: 2048,
    maxEventCount: 1024,
    maxJournalEntries: 4
  };

  const result = compactProfileMemoryMutationJournalState({
    state,
    compaction,
    recordedAt: "2026-04-08T16:25:00.000Z"
  });

  assert.equal(result.changed, false);
  assert.equal(result.nextState, state);
  assert.equal(result.nextCompaction, compaction);
});

test("compactProfileMemoryMutationJournalState trims overflow entries and stamps compaction metadata", () => {
  const state = {
    schemaVersion: "v1" as const,
    nextWatermark: 5,
    entries: [
      {
        journalEntryId: "journal_compaction_overflow_1",
        watermark: 1,
        recordedAt: "2026-04-08T16:30:00.000Z",
        sourceTaskId: "task_compaction_overflow_1",
        sourceFingerprint: "fingerprint_compaction_overflow_1",
        mutationEnvelopeHash: null,
        observationIds: ["observation_compaction_overflow_1"],
        claimIds: [],
        eventIds: [],
        redactionState: "not_requested" as const
      },
      {
        journalEntryId: "journal_compaction_overflow_2",
        watermark: 2,
        recordedAt: "2026-04-08T16:31:00.000Z",
        sourceTaskId: "task_compaction_overflow_2",
        sourceFingerprint: "fingerprint_compaction_overflow_2",
        mutationEnvelopeHash: null,
        observationIds: [],
        claimIds: ["claim_compaction_overflow_2"],
        eventIds: [],
        redactionState: "not_requested" as const
      },
      {
        journalEntryId: "journal_compaction_overflow_3",
        watermark: 3,
        recordedAt: "2026-04-08T16:32:00.000Z",
        sourceTaskId: "task_compaction_overflow_3",
        sourceFingerprint: "fingerprint_compaction_overflow_3",
        mutationEnvelopeHash: null,
        observationIds: [],
        claimIds: [],
        eventIds: ["event_compaction_overflow_3"],
        redactionState: "not_requested" as const
      },
      {
        journalEntryId: "journal_compaction_overflow_4",
        watermark: 4,
        recordedAt: "2026-04-08T16:33:00.000Z",
        sourceTaskId: "task_compaction_overflow_4",
        sourceFingerprint: "fingerprint_compaction_overflow_4",
        mutationEnvelopeHash: null,
        observationIds: ["observation_compaction_overflow_4"],
        claimIds: [],
        eventIds: [],
        redactionState: "not_requested" as const
      }
    ]
  };
  const compaction = {
    schemaVersion: "v1" as const,
    snapshotWatermark: 0,
    lastCompactedAt: null,
    maxObservationCount: 2048,
    maxClaimCount: 2048,
    maxEventCount: 1024,
    maxJournalEntries: 2
  };

  const result = compactProfileMemoryMutationJournalState({
    state,
    compaction,
    recordedAt: "2026-04-08T16:40:00.000Z"
  });

  assert.equal(result.changed, true);
  assert.notEqual(result.nextState, state);
  assert.deepEqual(
    result.nextState.entries.map((entry) => entry.journalEntryId),
    ["journal_compaction_overflow_3", "journal_compaction_overflow_4"]
  );
  assert.equal(result.nextState.nextWatermark, 5);
  assert.notEqual(result.nextCompaction, compaction);
  assert.equal(result.nextCompaction.snapshotWatermark, 2);
  assert.equal(result.nextCompaction.lastCompactedAt, "2026-04-08T16:40:00.000Z");
});

test("appendProfileMemoryMutationJournalEntry does not treat spoofed stored ids with different canonical replay payloads as already appended", () => {
  const payload = {
    recordedAt: "2026-04-03T20:03:00.000Z",
    sourceTaskId: "task_profile_graph_duplicate_payload_spoof",
    sourceFingerprint: "fingerprint_profile_graph_duplicate_payload_spoof_real",
    mutationEnvelopeHash: null,
    observationIds: ["observation_payload_spoof_1"],
    claimIds: [],
    eventIds: [],
    redactionState: "not_requested" as const
  };
  const canonicalJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(payload).slice(0, 24)}`;
  const existingEntry = {
    journalEntryId: canonicalJournalEntryId,
    watermark: 1,
    recordedAt: payload.recordedAt,
    sourceTaskId: payload.sourceTaskId,
    sourceFingerprint: "fingerprint_profile_graph_duplicate_payload_spoof_legacy",
    mutationEnvelopeHash: payload.mutationEnvelopeHash,
    observationIds: payload.observationIds,
    claimIds: payload.claimIds,
    eventIds: payload.eventIds,
    redactionState: payload.redactionState
  };
  const state = {
    schemaVersion: "v1" as const,
    nextWatermark: 2,
    entries: [existingEntry]
  };

  const result = appendProfileMemoryMutationJournalEntry(state, payload);

  assert.equal(result.appended, true);
  assert.equal(result.nextState.entries.length, 2);
  assert.equal(result.entry?.journalEntryId, canonicalJournalEntryId);
  assert.equal(result.entry?.watermark, 2);
  assert.equal(result.entry?.sourceFingerprint, payload.sourceFingerprint);
  assert.equal(result.nextState.nextWatermark, 3);
  assert.deepEqual(
    result.nextState.entries.map((entry) => entry.sourceFingerprint),
    [
      "fingerprint_profile_graph_duplicate_payload_spoof_legacy",
      payload.sourceFingerprint
    ]
  );
});

test("appendProfileMemoryMutationJournalEntry stays no-op when touched refs collapse blank after canonical trimming", () => {
  const state = {
    schemaVersion: "v1" as const,
    nextWatermark: 4,
    entries: []
  };

  const result = appendProfileMemoryMutationJournalEntry(state, {
    recordedAt: "2026-04-08T15:10:00.000Z",
    sourceTaskId: "   ",
    sourceFingerprint: "\t",
    mutationEnvelopeHash: "  ",
    observationIds: ["   ", "\t"],
    claimIds: [""],
    eventIds: ["  "],
    redactionState: "not_requested"
  });

  assert.equal(result.appended, false);
  assert.equal(result.entry, null);
  assert.equal(result.nextState, state);
  assert.equal(result.nextState.entries.length, 0);
  assert.equal(result.nextState.nextWatermark, 4);
});

test("normalizeProfileMemoryState backfills missing graph events and a replay marker from legacy episodes", () => {
  const expectedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: "episode_profile_graph_backfill_1" }).slice(0, 24)}`;
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:45:00.000Z",
    episodes: [
      {
        id: " episode_profile_graph_backfill_1 ",
        title: "Owen tax follow-up",
        summary: "Owen still needs to send the tax form.",
        status: "unresolved",
        sourceTaskId: "task_profile_graph_backfill_1",
        source: "test.seed",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        confidence: 0.88,
        observedAt: "2026-04-03T20:10:00.000Z",
        lastMentionedAt: "2026-04-03T20:10:00.000Z",
        lastUpdatedAt: "2026-04-03T20:10:00.000Z",
        resolvedAt: null,
        entityRefs: ["entity_owen"],
        openLoopRefs: ["open_loop_owen_tax"],
        tags: ["followup"]
      }
    ],
    graph: {
      updatedAt: "2026-04-03T20:45:00.000Z",
      observations: [],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.events.length, 1);
  assert.equal(normalized.graph.events[0]?.payload.eventId, expectedEventId);
  assert.equal(
    normalized.graph.events[0]?.payload.projectionSourceIds[0],
    "episode_profile_graph_backfill_1"
  );
  assert.equal(normalized.graph.events[0]?.payload.summary, "Owen still needs to send the tax form.");
  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.eventIds,
    [expectedEventId]
  );
  assert.equal(normalized.graph.mutationJournal.entries[0]?.sourceTaskId, null);
  assert.equal(
    normalized.graph.mutationJournal.entries[0]?.sourceFingerprint?.startsWith("graph_event_replay_backfill_"),
    true
  );
  assert.equal(normalized.graph.readModel.watermark, 1);
  assert.deepEqual(normalized.graph.indexes.byFamily, {
    "episode.candidate": [expectedEventId]
  });
});

test("normalizeProfileMemoryState repairs current-surface-ineligible retained unresolved events from surviving episodes", () => {
  const canonicalEpisodeId = "episode_profile_graph_event_repair_1";
  const expectedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-07T15:00:00.000Z",
    episodes: [
      {
        id: ` ${canonicalEpisodeId} `,
        title: "Owen tax follow-up",
        summary: "Owen still needs to send the tax form.",
        status: "unresolved",
        sourceTaskId: "task_profile_graph_event_repair_1",
        source: "user_input_pattern.episode_candidate",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        confidence: 0.88,
        observedAt: "2026-04-07T14:30:00.000Z",
        lastMentionedAt: "2026-04-07T14:30:00.000Z",
        lastUpdatedAt: "2026-04-07T14:30:00.000Z",
        resolvedAt: null,
        entityRefs: ["entity_owen"],
        openLoopRefs: ["open_loop_owen_tax"],
        tags: ["followup"]
      }
    ],
    graph: {
      updatedAt: "2026-04-07T15:00:00.000Z",
      observations: [],
      claims: [],
      events: [
        createGraphEventEnvelope({
          eventId: expectedEventId,
          stableRefId: null,
          family: "episode.candidate",
          title: "Malformed retained event",
          summary: "This stale retained event should be rebuilt from the surviving episode.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_repair_stale",
          sourceFingerprint: "fingerprint_profile_graph_event_repair_stale",
          sourceTier: "validated_structured_candidate",
          assertedAt: "2026-04-07T14:10:00.000Z",
          observedAt: "2026-04-07T14:10:00.000Z",
          validFrom: "2026-04-07T14:10:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["episode_profile_graph_event_repair_wrong"],
          entityRefIds: ["entity_owen"]
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.events.length, 1);
  assert.equal(normalized.graph.events[0]?.payload.eventId, expectedEventId);
  assert.equal(normalized.graph.events[0]?.payload.title, "Owen tax follow-up");
  assert.equal(
    normalized.graph.events[0]?.payload.summary,
    "Owen still needs to send the tax form."
  );
  assert.equal(normalized.graph.events[0]?.payload.sourceTier, "explicit_user_statement");
  assert.deepEqual(
    normalized.graph.events[0]?.payload.projectionSourceIds,
    [canonicalEpisodeId]
  );
  assert.equal(
    normalized.graph.events[0]?.payload.sourceFingerprint?.startsWith("graph_event_backfill_"),
    true
  );
  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.eventIds,
    [expectedEventId]
  );
  assert.deepEqual(normalized.graph.indexes.byFamily, {
    "episode.candidate": [expectedEventId]
  });
});

test("normalizeProfileMemoryState repairs retained unresolved events missing the surviving canonical episode projection source", () => {
  const canonicalEpisodeId = "episode_profile_graph_event_projection_repair_1";
  const expectedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-07T15:10:00.000Z",
    episodes: [
      {
        id: ` ${canonicalEpisodeId} `,
        title: "Owen tax follow-up",
        summary: "Owen still needs to send the tax form.",
        status: "unresolved",
        sourceTaskId: "task_profile_graph_event_projection_repair_1",
        source: "user_input_pattern.episode_candidate",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        confidence: 0.88,
        observedAt: "2026-04-07T14:35:00.000Z",
        lastMentionedAt: "2026-04-07T14:35:00.000Z",
        lastUpdatedAt: "2026-04-07T14:35:00.000Z",
        resolvedAt: null,
        entityRefs: ["entity_owen"],
        openLoopRefs: ["open_loop_owen_tax"],
        tags: ["followup"]
      }
    ],
    graph: {
      updatedAt: "2026-04-07T15:10:00.000Z",
      observations: [],
      claims: [],
      events: [
        createGraphEventEnvelope({
          eventId: expectedEventId,
          stableRefId: null,
          family: "episode.candidate",
          title: "Retained event without canonical projection source",
          summary: "This retained event should be rebuilt from the surviving episode.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_projection_repair_stale",
          sourceFingerprint: "fingerprint_profile_graph_event_projection_repair_stale",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-07T14:15:00.000Z",
          observedAt: "2026-04-07T14:15:00.000Z",
          validFrom: "2026-04-07T14:15:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: [],
          entityRefIds: ["entity_owen"]
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.events.length, 1);
  assert.equal(normalized.graph.events[0]?.payload.eventId, expectedEventId);
  assert.equal(normalized.graph.events[0]?.payload.title, "Owen tax follow-up");
  assert.equal(
    normalized.graph.events[0]?.payload.summary,
    "Owen still needs to send the tax form."
  );
  assert.deepEqual(
    normalized.graph.events[0]?.payload.projectionSourceIds,
    [canonicalEpisodeId]
  );
  assert.equal(
    normalized.graph.events[0]?.payload.sourceFingerprint?.startsWith("graph_event_backfill_"),
    true
  );
  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.eventIds,
    [expectedEventId]
  );
});

test("normalizeProfileMemoryState repairs retained unresolved events whose same-id payload no longer matches the surviving episode", () => {
  const canonicalEpisodeId = "episode_profile_graph_event_payload_repair_1";
  const expectedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
  const retainedCreatedAt = "2026-04-07T14:12:00.000Z";
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-07T15:20:00.000Z",
    episodes: [
      {
        id: canonicalEpisodeId,
        title: "Owen tax follow-up",
        summary: "Owen still needs to send the tax form.",
        status: "unresolved",
        sourceTaskId: "task_profile_graph_event_payload_repair_1",
        source: "user_input_pattern.episode_candidate",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        confidence: 0.88,
        observedAt: "2026-04-07T14:45:00.000Z",
        lastMentionedAt: "2026-04-07T14:45:00.000Z",
        lastUpdatedAt: "2026-04-07T14:45:00.000Z",
        resolvedAt: null,
        entityRefs: ["entity_owen", "entity_tax_form"],
        openLoopRefs: ["open_loop_owen_tax"],
        tags: ["followup"]
      }
    ],
    graph: {
      updatedAt: "2026-04-07T15:20:00.000Z",
      observations: [],
      claims: [],
      events: [
        createGraphEventEnvelope({
          eventId: expectedEventId,
          stableRefId: null,
          family: "episode.candidate",
          title: "Stale retained unresolved event",
          summary: "This retained event kept the right id and projection source but stale payload.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: true,
          sourceTaskId: "task_profile_graph_event_payload_repair_stale",
          sourceFingerprint: "fingerprint_profile_graph_event_payload_repair_stale",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-07T14:10:00.000Z",
          observedAt: "2026-04-07T14:10:00.000Z",
          validFrom: "2026-04-07T14:10:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "system_generated",
          derivedFromObservationIds: [],
          projectionSourceIds: [canonicalEpisodeId],
          entityRefIds: ["entity_owen"]
        }, retainedCreatedAt)
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.events.length, 1);
  assert.equal(normalized.graph.events[0]?.payload.eventId, expectedEventId);
  assert.equal(normalized.graph.events[0]?.createdAt, retainedCreatedAt);
  assert.equal(normalized.graph.events[0]?.payload.title, "Owen tax follow-up");
  assert.equal(
    normalized.graph.events[0]?.payload.summary,
    "Owen still needs to send the tax form."
  );
  assert.equal(normalized.graph.events[0]?.payload.sensitive, false);
  assert.equal(
    normalized.graph.events[0]?.payload.sourceTaskId,
    "task_profile_graph_event_payload_repair_1"
  );
  assert.equal(normalized.graph.events[0]?.payload.observedAt, "2026-04-07T14:45:00.000Z");
  assert.equal(normalized.graph.events[0]?.payload.timeSource, "user_stated");
  assert.deepEqual(
    normalized.graph.events[0]?.payload.projectionSourceIds,
    [canonicalEpisodeId]
  );
  assert.deepEqual(
    normalized.graph.events[0]?.payload.entityRefIds,
    ["entity_owen", "entity_tax_form"]
  );
  assert.equal(
    normalized.graph.events[0]?.payload.sourceFingerprint?.startsWith("graph_event_backfill_"),
    true
  );
  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.eventIds,
    [expectedEventId]
  );
});

test("upsertProfileMemoryGraphEvents keeps same-id retained events as a no-op when only provisional createdAt differs", () => {
  const canonicalEpisodeId = "episode_profile_graph_event_same_id_noop";
  const sourceFingerprint = "fingerprint_profile_graph_event_same_id_noop";
  const recordedAt = "2026-04-07T15:20:00.000Z";
  const retainedCreatedAt = "2026-04-07T14:12:00.000Z";
  const expectedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
  const touchedEpisode = {
    id: canonicalEpisodeId,
    title: "Owen tax follow-up",
    summary: "Owen still needs to send the tax form.",
    status: "unresolved" as const,
    sourceTaskId: "task_profile_graph_event_same_id_noop",
    source: "user_input_pattern.episode_candidate",
    sourceKind: "explicit_user_statement" as const,
    sensitive: false,
    confidence: 0.88,
    observedAt: "2026-04-07T14:45:00.000Z",
    lastMentionedAt: "2026-04-07T14:45:00.000Z",
    lastUpdatedAt: "2026-04-07T14:45:00.000Z",
    resolvedAt: null,
    entityRefs: ["entity_owen", "entity_tax_form"],
    openLoopRefs: ["open_loop_owen_tax"],
    tags: ["followup"]
  };
  const existingEvent = createGraphEventEnvelope({
    eventId: expectedEventId,
    stableRefId: null,
    family: "episode.candidate",
    title: touchedEpisode.title,
    summary: touchedEpisode.summary,
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: touchedEpisode.sourceTaskId,
    sourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-07T14:45:00.000Z",
    observedAt: "2026-04-07T14:45:00.000Z",
    validFrom: "2026-04-07T14:45:00.000Z",
    validTo: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: [canonicalEpisodeId],
    entityRefIds: ["entity_owen", "entity_tax_form"]
  }, retainedCreatedAt);

  const result = upsertProfileMemoryGraphEvents({
    existingEvents: [existingEvent],
    touchedEpisodes: [touchedEpisode],
    sourceFingerprint,
    recordedAt
  });

  assert.equal(result.changed, false);
  assert.deepEqual(result.touchedEventIds, []);
  assert.equal(result.nextEvents.length, 1);
  assert.deepEqual(result.nextEvents[0], existingEvent);
});

test("upsertProfileMemoryGraphObservations keeps same-id retained observations as a no-op when only provisional createdAt differs", () => {
  const sourceFingerprint = "fingerprint_profile_graph_observation_same_id_noop";
  const retainedCreatedAt = "2026-04-07T14:12:00.000Z";
  const observedAt = "2026-04-07T14:45:00.000Z";
  const candidate = {
    key: "contact.context.owen.tax_form",
    value: "pending",
    sensitive: false,
    sourceTaskId: "task_profile_graph_observation_same_id_noop",
    source: " User_Input_Pattern.Followup_Context ",
    observedAt,
    confidence: 0.88
  };
  const decision = {
    evidenceClass: "user_hint_or_context" as const,
    family: "contact.context" as const,
    action: "allow_episode_support" as const,
    reason: "contact_context_is_support_only" as const
  };
  const observationId = `observation_${sha256HexFromCanonicalJson({
    family: decision.family,
    normalizedKey: "contact.context.owen.tax_form",
    normalizedValue: "pending",
    source: "user_input_pattern.followup_context",
    observedAt,
    sourceFingerprint
  }).slice(0, 24)}`;
  const existingObservation = createGraphObservationEnvelope({
    observationId,
    stableRefId: null,
    family: decision.family,
    normalizedKey: "contact.context.owen.tax_form",
    normalizedValue: "pending",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_observation_same_id_noop",
    sourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    observedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: []
  }, retainedCreatedAt);

  const result = upsertProfileMemoryGraphObservations({
    existingObservations: [existingObservation],
    factDecisions: [{ candidate, decision }],
    sourceFingerprint,
    recordedAt: "2026-04-07T15:20:00.000Z"
  });

  assert.equal(result.changed, false);
  assert.deepEqual(result.touchedObservationIds, []);
  assert.equal(result.nextObservations.length, 1);
  assert.deepEqual(result.nextObservations[0], existingObservation);
});

test("reconcileProfileMemoryCurrentClaims keeps same-id retained current claims as a no-op when canonical winner state already matches", () => {
  const sourceFingerprint = "fingerprint_profile_graph_claim_same_id_noop";
  const retainedCreatedAt = "2026-04-07T14:12:00.000Z";
  const observedAt = "2026-04-07T14:45:00.000Z";
  const factId = "fact_profile_graph_claim_same_id_noop";
  const factDecision = {
    candidate: {
      key: "identity.preferred_name",
      value: "Avery",
      sensitive: true,
      sourceTaskId: "task_profile_graph_claim_same_id_noop",
      source: " User_Input_Pattern.Name_Phrase ",
      observedAt,
      confidence: 0.95
    },
    decision: {
      evidenceClass: "user_explicit_fact" as const,
      family: "identity.preferred_name" as const,
      action: "allow_current_state" as const,
      reason: "explicit_user_fact" as const
    }
  };
  const observationId = `observation_${sha256HexFromCanonicalJson({
    family: factDecision.decision.family,
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    source: "user_input_pattern.name_phrase",
    observedAt,
    sourceFingerprint
  }).slice(0, 24)}`;
  const claimIdentity = {
    family: factDecision.decision.family,
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery"
  };
  const claimId = `claim_${sha256HexFromCanonicalJson(claimIdentity).slice(0, 24)}`;
  const claimSourceFingerprint = sha256HexFromCanonicalJson(claimIdentity).slice(0, 32);
  const existingObservation = createGraphObservationEnvelope({
    observationId,
    stableRefId: null,
    family: factDecision.decision.family,
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: true,
    sourceTaskId: "task_profile_graph_claim_same_id_noop",
    sourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    observedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: []
  }, retainedCreatedAt);
  const existingClaim = createGraphClaimEnvelope({
    claimId,
    stableRefId: null,
    family: factDecision.decision.family,
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: true,
    sourceTaskId: "task_profile_graph_claim_same_id_noop",
    sourceFingerprint: claimSourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    validFrom: observedAt,
    validTo: null,
    endedAt: null,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [observationId],
    projectionSourceIds: [factId],
    entityRefIds: [],
    active: true
  }, retainedCreatedAt);
  const fact = {
    id: factId,
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: true,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_claim_same_id_noop",
    source: "user_input_pattern.name_phrase",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };

  const result = reconcileProfileMemoryCurrentClaims({
    existingClaims: [existingClaim],
    observations: [existingObservation],
    facts: [fact],
    factDecisions: [factDecision],
    recordedAt: "2026-04-07T15:20:00.000Z"
  });

  assert.equal(result.changed, false);
  assert.deepEqual(result.touchedClaimIds, []);
  assert.equal(result.nextClaims.length, 1);
  assert.deepEqual(result.nextClaims[0], existingClaim);
});

test("backfillProfileMemoryGraphFromLegacyFacts keeps already-canonical retained current-claim lanes as a no-op", () => {
  const sourceFingerprint = "fingerprint_profile_graph_legacy_claim_same_id_noop";
  const retainedCreatedAt = "2026-04-07T14:12:00.000Z";
  const observedAt = "2026-04-07T14:45:00.000Z";
  const factId = "fact_profile_graph_legacy_claim_same_id_noop";
  const observationId = `observation_${sha256HexFromCanonicalJson({
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    source: "user_input_pattern.name_phrase",
    observedAt,
    sourceFingerprint
  }).slice(0, 24)}`;
  const claimIdentity = {
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery"
  };
  const claimId = `claim_${sha256HexFromCanonicalJson(claimIdentity).slice(0, 24)}`;
  const claimSourceFingerprint = sha256HexFromCanonicalJson(claimIdentity).slice(0, 32);
  const existingObservation = createGraphObservationEnvelope({
    observationId,
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: true,
    sourceTaskId: "task_profile_graph_legacy_claim_same_id_noop",
    sourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    observedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: []
  }, retainedCreatedAt);
  const existingClaim = createGraphClaimEnvelope({
    claimId,
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: true,
    sourceTaskId: "task_profile_graph_legacy_claim_same_id_noop",
    sourceFingerprint: claimSourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    validFrom: observedAt,
    validTo: null,
    endedAt: null,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [observationId],
    projectionSourceIds: [factId],
    entityRefIds: [],
    active: true
  }, retainedCreatedAt);
  const fact = {
    id: factId,
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: true,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_legacy_claim_same_id_noop",
    source: "user_input_pattern.name_phrase",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };

  const result = backfillProfileMemoryGraphFromLegacyFacts({
    existingObservations: [existingObservation],
    existingClaims: [existingClaim],
    facts: [fact],
    recordedAt: "2026-04-07T15:20:00.000Z"
  });

  assert.equal(result.changed, false);
  assert.equal(result.nextObservations.length, 1);
  assert.equal(result.nextClaims.length, 1);
  assert.deepEqual(result.nextObservations[0], existingObservation);
  assert.deepEqual(result.nextClaims[0], existingClaim);
});

test("redactProfileMemoryGraphEvents keeps same-id retained redacted events as a no-op when only provisional createdAt differs", () => {
  const canonicalEpisodeId = "episode_profile_graph_redacted_event_same_id_noop";
  const sourceTaskId = "task_profile_graph_redacted_event_same_id_noop";
  const sourceFingerprint = "fingerprint_profile_graph_redacted_event_same_id_noop";
  const recordedAt = "2026-04-07T15:20:00.000Z";
  const retainedCreatedAt = "2026-04-07T14:12:00.000Z";
  const expectedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
  const redactedEpisode = {
    id: canonicalEpisodeId,
    title: "Owen tax follow-up",
    summary: "Owen still needs to send the tax form.",
    status: "unresolved" as const,
    sourceTaskId,
    source: "user_input_pattern.episode_candidate",
    sourceKind: "explicit_user_statement" as const,
    sensitive: false,
    confidence: 0.88,
    observedAt: "2026-04-07T14:45:00.000Z",
    lastMentionedAt: "2026-04-07T14:45:00.000Z",
    lastUpdatedAt: "2026-04-07T14:45:00.000Z",
    resolvedAt: null,
    entityRefs: ["entity_owen", "entity_tax_form"],
    openLoopRefs: ["open_loop_owen_tax"],
    tags: ["followup"]
  };
  const existingEvent = createGraphEventEnvelope({
    eventId: expectedEventId,
    stableRefId: null,
    family: "episode.candidate",
    title: "[redacted episode]",
    summary: "[redacted episode details]",
    redactionState: "redacted",
    redactedAt: recordedAt,
    sensitive: true,
    sourceTaskId,
    sourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-07T14:45:00.000Z",
    observedAt: "2026-04-07T14:45:00.000Z",
    validFrom: "2026-04-07T14:45:00.000Z",
    validTo: recordedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: [canonicalEpisodeId],
    entityRefIds: []
  }, retainedCreatedAt);

  const result = redactProfileMemoryGraphEvents({
    existingEvents: [existingEvent],
    redactedEpisodes: [redactedEpisode],
    sourceTaskId,
    sourceFingerprint,
    recordedAt
  });

  assert.equal(result.changed, false);
  assert.deepEqual(result.touchedEventIds, []);
  assert.equal(result.nextEvents.length, 1);
  assert.deepEqual(result.nextEvents[0], existingEvent);
});

test("redactProfileMemoryGraphFacts preserves same-id retained observation and claim envelope createdAt during fact forget repair", () => {
  const recordedAt = "2026-04-07T15:20:00.000Z";
  const observedAt = "2026-04-07T14:45:00.000Z";
  const sourceTaskId = "task_profile_graph_fact_redaction_created_at";
  const sourceFingerprint = "fingerprint_profile_graph_fact_redaction_created_at";
  const existingObservation = createGraphObservationEnvelope({
    observationId: "observation_profile_graph_fact_redaction_created_at",
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_fact_redaction_seed",
    sourceFingerprint: "fingerprint_profile_graph_fact_redaction_seed",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    observedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:12:00.000Z");
  const existingClaim = createGraphClaimEnvelope({
    claimId: "claim_profile_graph_fact_redaction_created_at",
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_fact_redaction_seed",
    sourceFingerprint: "fingerprint_profile_graph_fact_redaction_seed",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,    validFrom: observedAt,
    validTo: null,
    endedAt: null,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    active: true,
    derivedFromObservationIds: [existingObservation.payload.observationId],
    projectionSourceIds: ["fact_profile_graph_fact_redaction_created_at"],
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:13:00.000Z");
  const redactedFact = {
    id: "fact_profile_graph_fact_redaction_created_at",
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: false,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_fact_redaction_seed",
    source: "user_input_pattern.name_preference",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };

  const result = redactProfileMemoryGraphFacts({
    existingObservations: [existingObservation],
    existingClaims: [existingClaim],
    redactedFacts: [redactedFact],
    sourceTaskId,
    sourceFingerprint,
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.touchedObservationIds, [existingObservation.payload.observationId]);
  assert.deepEqual(result.touchedClaimIds, [existingClaim.payload.claimId]);
  assert.equal(result.nextObservations.length, 1);
  assert.equal(result.nextClaims.length, 1);
  assert.equal(result.nextObservations[0]?.createdAt, existingObservation.createdAt);
  assert.equal(result.nextClaims[0]?.createdAt, existingClaim.createdAt);
  assert.equal(result.nextObservations[0]?.payload.normalizedValue, null);
  assert.equal(result.nextObservations[0]?.payload.redactionState, "redacted");
  assert.equal(result.nextObservations[0]?.payload.redactedAt, recordedAt);
  assert.equal(result.nextObservations[0]?.payload.sourceTaskId, sourceTaskId);
  assert.equal(result.nextObservations[0]?.payload.sourceFingerprint, sourceFingerprint);
  assert.equal(result.nextClaims[0]?.payload.normalizedValue, null);
  assert.equal(result.nextClaims[0]?.payload.redactionState, "redacted");
  assert.equal(result.nextClaims[0]?.payload.redactedAt, recordedAt);
  assert.equal(result.nextClaims[0]?.payload.sourceTaskId, sourceTaskId);
  assert.equal(result.nextClaims[0]?.payload.sourceFingerprint, sourceFingerprint);
  assert.equal(result.nextClaims[0]?.payload.active, false);
  assert.equal(result.nextClaims[0]?.payload.validTo, recordedAt);
  assert.equal(result.nextClaims[0]?.payload.endedAt, recordedAt);
});

test("redactProfileMemoryGraphFacts repairs already-redacted observation and claim metadata via retained claim lineage while preserving createdAt", () => {
  const recordedAt = "2026-04-07T15:20:00.000Z";
  const observedAt = "2026-04-07T14:45:00.000Z";
  const priorRedactedAt = "2026-04-07T15:00:00.000Z";
  const sourceTaskId = "task_profile_graph_fact_redaction_repeat";
  const sourceFingerprint = "fingerprint_profile_graph_fact_redaction_repeat";
  const redactedFactId = "fact_profile_graph_fact_redaction_repeat";
  const existingObservation = createGraphObservationEnvelope({
    observationId: "observation_profile_graph_fact_redaction_repeat",
    stableRefId: "stable_ref_profile_graph_fact_redaction_repeat_observation",
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: priorRedactedAt,
    sensitive: false,
    sourceTaskId: "task_profile_graph_fact_redaction_old",
    sourceFingerprint: "fingerprint_profile_graph_fact_redaction_old",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    observedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:12:00.000Z");
  const existingClaim = createGraphClaimEnvelope({
    claimId: "claim_profile_graph_fact_redaction_repeat",
    stableRefId: "stable_ref_profile_graph_fact_redaction_repeat_claim",
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: priorRedactedAt,
    sensitive: false,
    sourceTaskId: "task_profile_graph_fact_redaction_old",
    sourceFingerprint: "fingerprint_profile_graph_fact_redaction_old",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,    validFrom: observedAt,
    validTo: priorRedactedAt,
    endedAt: priorRedactedAt,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    active: true,
    derivedFromObservationIds: [existingObservation.payload.observationId],
    projectionSourceIds: [redactedFactId, "fact_profile_graph_fact_redaction_repeat_stray"],
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:13:00.000Z");
  const redactedFact = {
    id: redactedFactId,
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: false,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_fact_redaction_seed",
    source: "user_input_pattern.name_preference",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };

  const result = redactProfileMemoryGraphFacts({
    existingObservations: [existingObservation],
    existingClaims: [existingClaim],
    redactedFacts: [redactedFact],
    sourceTaskId,
    sourceFingerprint,
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.deepEqual(result.touchedObservationIds, [existingObservation.payload.observationId]);
  assert.deepEqual(result.touchedClaimIds, [existingClaim.payload.claimId]);
  assert.equal(result.nextObservations[0]?.createdAt, existingObservation.createdAt);
  assert.equal(result.nextClaims[0]?.createdAt, existingClaim.createdAt);
  assert.equal(result.nextObservations[0]?.payload.stableRefId, null);
  assert.equal(result.nextObservations[0]?.payload.redactedAt, recordedAt);
  assert.equal(result.nextObservations[0]?.payload.sourceTaskId, sourceTaskId);
  assert.equal(result.nextObservations[0]?.payload.sourceFingerprint, sourceFingerprint);
  assert.equal(result.nextObservations[0]?.payload.sensitive, true);
  assert.deepEqual(result.nextObservations[0]?.payload.entityRefIds, []);
  assert.equal(result.nextClaims[0]?.payload.stableRefId, null);
  assert.equal(result.nextClaims[0]?.payload.redactedAt, recordedAt);
  assert.equal(result.nextClaims[0]?.payload.sourceTaskId, sourceTaskId);
  assert.equal(result.nextClaims[0]?.payload.sourceFingerprint, sourceFingerprint);
  assert.equal(result.nextClaims[0]?.payload.sensitive, true);
  assert.equal(result.nextClaims[0]?.payload.active, false);
  assert.equal(result.nextClaims[0]?.payload.validTo, priorRedactedAt);
  assert.equal(result.nextClaims[0]?.payload.endedAt, priorRedactedAt);
  assert.deepEqual(result.nextClaims[0]?.payload.projectionSourceIds, [redactedFactId]);
  assert.deepEqual(result.nextClaims[0]?.payload.entityRefIds, []);
});

test("redactProfileMemoryGraphFacts fail-closes stale unrelated retained claim lineage during repeat fact forget", () => {
  const recordedAt = "2026-04-07T15:40:00.000Z";
  const observedAt = "2026-04-07T14:45:00.000Z";
  const priorRedactedAt = "2026-04-07T15:00:00.000Z";
  const sourceTaskId = "task_profile_graph_fact_redaction_repeat_stale_lineage";
  const sourceFingerprint = "fingerprint_profile_graph_fact_redaction_repeat_stale_lineage";
  const redactedFactId = "fact_profile_graph_fact_redaction_repeat_stale_lineage";
  const targetedObservation = createGraphObservationEnvelope({
    observationId: "observation_profile_graph_fact_redaction_repeat_stale_lineage_target",
    stableRefId: "stable_ref_profile_graph_fact_redaction_repeat_stale_lineage_target",
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: priorRedactedAt,
    sensitive: false,
    sourceTaskId: "task_profile_graph_fact_redaction_repeat_old",
    sourceFingerprint: "fingerprint_profile_graph_fact_redaction_repeat_old",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    observedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:12:00.000Z");
  const unrelatedObservation = createGraphObservationEnvelope({
    observationId: "observation_profile_graph_fact_redaction_repeat_stale_lineage_unrelated",
    stableRefId: "stable_ref_profile_graph_fact_redaction_repeat_stale_lineage_unrelated",
    family: "contact.context",
    normalizedKey: "contact.avery.context.1",
    normalizedValue: "Avery likes hiking",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_fact_redaction_repeat_stale_lineage_unrelated",
    sourceFingerprint: "fingerprint_profile_graph_fact_redaction_repeat_stale_lineage_unrelated",
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-07T14:46:00.000Z",
    observedAt: "2026-04-07T14:46:00.000Z",
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:14:00.000Z");
  const existingClaim = createGraphClaimEnvelope({
    claimId: "claim_profile_graph_fact_redaction_repeat_stale_lineage",
    stableRefId: "stable_ref_profile_graph_fact_redaction_repeat_stale_lineage_claim",
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: priorRedactedAt,
    sensitive: false,
    sourceTaskId: "task_profile_graph_fact_redaction_repeat_old",
    sourceFingerprint: "fingerprint_profile_graph_fact_redaction_repeat_old",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,    validFrom: observedAt,
    validTo: priorRedactedAt,
    endedAt: priorRedactedAt,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    active: false,
    derivedFromObservationIds: [
      unrelatedObservation.payload.observationId,
      targetedObservation.payload.observationId
    ],
    projectionSourceIds: [redactedFactId],
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:13:00.000Z");
  const redactedFact = {
    id: redactedFactId,
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: false,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_fact_redaction_repeat_seed",
    source: "user_input_pattern.name_preference",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };

  const result = redactProfileMemoryGraphFacts({
    existingObservations: [targetedObservation, unrelatedObservation],
    existingClaims: [existingClaim],
    redactedFacts: [redactedFact],
    sourceTaskId,
    sourceFingerprint,
    recordedAt
  });

  const repairedTargetedObservation = result.nextObservations.find(
    (observation) => observation.payload.observationId === targetedObservation.payload.observationId
  );
  const survivingUnrelatedObservation = result.nextObservations.find(
    (observation) => observation.payload.observationId === unrelatedObservation.payload.observationId
  );

  assert.equal(result.changed, true);
  assert.deepEqual(result.touchedObservationIds, [targetedObservation.payload.observationId]);
  assert.deepEqual(result.touchedClaimIds, [existingClaim.payload.claimId]);
  assert.equal(repairedTargetedObservation?.payload.redactedAt, recordedAt);
  assert.equal(repairedTargetedObservation?.payload.sourceTaskId, sourceTaskId);
  assert.equal(survivingUnrelatedObservation?.payload.redactionState, "not_requested");
  assert.equal(survivingUnrelatedObservation?.payload.normalizedValue, "Avery likes hiking");
  assert.equal(
    survivingUnrelatedObservation?.payload.sourceTaskId,
    unrelatedObservation.payload.sourceTaskId
  );
  assert.deepEqual(result.nextClaims[0]?.payload.derivedFromObservationIds, [
    targetedObservation.payload.observationId
  ]);
});

test("redactProfileMemoryGraphFacts stays no-op when retained redacted observation and claim already match canonical repeat-forget state", () => {
  const recordedAt = "2026-04-07T15:40:00.000Z";
  const redactedFactId = "fact_profile_graph_fact_redaction_repeat_noop";
  const existingObservation = createGraphObservationEnvelope({
    observationId: "observation_profile_graph_fact_redaction_repeat_noop",
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: recordedAt,
    sensitive: true,
    sourceTaskId: "task_profile_graph_fact_redaction_repeat_noop",
    sourceFingerprint: "fingerprint_profile_graph_fact_redaction_repeat_noop",
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-07T14:45:00.000Z",
    observedAt: "2026-04-07T14:45:00.000Z",
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: []
  }, "2026-04-07T14:12:00.000Z");
  const existingClaim = createGraphClaimEnvelope({
    claimId: "claim_profile_graph_fact_redaction_repeat_noop",
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: recordedAt,
    sensitive: true,
    sourceTaskId: "task_profile_graph_fact_redaction_repeat_noop",
    sourceFingerprint: "fingerprint_profile_graph_fact_redaction_repeat_noop",
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-07T14:45:00.000Z",    validFrom: "2026-04-07T14:45:00.000Z",
    validTo: recordedAt,
    endedAt: recordedAt,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    active: false,
    derivedFromObservationIds: [existingObservation.payload.observationId],
    projectionSourceIds: [redactedFactId],
    entityRefIds: []
  }, "2026-04-07T14:13:00.000Z");
  const redactedFact = {
    id: redactedFactId,
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: false,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_fact_redaction_seed",
    source: "user_input_pattern.name_preference",
    observedAt: "2026-04-07T14:45:00.000Z",
    confirmedAt: "2026-04-07T14:45:00.000Z",
    supersededAt: null,
    lastUpdatedAt: "2026-04-07T14:45:00.000Z"
  };

  const result = redactProfileMemoryGraphFacts({
    existingObservations: [existingObservation],
    existingClaims: [existingClaim],
    redactedFacts: [redactedFact],
    sourceTaskId: existingObservation.payload.sourceTaskId,
    sourceFingerprint: existingObservation.payload.sourceFingerprint,
    recordedAt
  });

  assert.equal(result.changed, false);
  assert.deepEqual(result.touchedObservationIds, []);
  assert.deepEqual(result.touchedClaimIds, []);
  assert.equal(result.nextObservations[0], existingObservation);
  assert.equal(result.nextClaims[0], existingClaim);
});

test("normalizeProfileMemoryState preserves deleted fact projection lineage on redacted claims after projection-source pruning", () => {
  const redactedFactId = "fact_profile_graph_redacted_claim_projection_lineage";
  const survivingFactId = "fact_profile_graph_redacted_claim_projection_lineage_surviving";
  const existingObservation = createGraphObservationEnvelope({
    observationId: "observation_profile_graph_redacted_claim_projection_lineage",
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: "2026-04-07T15:00:00.000Z",
    sensitive: true,
    sourceTaskId: "task_profile_graph_redacted_claim_projection_lineage",
    sourceFingerprint: "fingerprint_profile_graph_redacted_claim_projection_lineage",
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-07T14:45:00.000Z",
    observedAt: "2026-04-07T14:45:00.000Z",
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: []
  });
  const unrelatedLiveObservation = createGraphObservationEnvelope({
    observationId: "observation_profile_graph_redacted_claim_projection_lineage_live_unrelated",
    stableRefId: null,
    family: "contact.context",
    normalizedKey: "contact.avery.context.1",
    normalizedValue: "Avery likes hiking",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_redacted_claim_projection_lineage_live_unrelated",
    sourceFingerprint: "fingerprint_profile_graph_redacted_claim_projection_lineage_live_unrelated",
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-07T14:46:00.000Z",
    observedAt: "2026-04-07T14:46:00.000Z",
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: []
  });
  const existingClaim = createGraphClaimEnvelope({
    claimId: "claim_profile_graph_redacted_claim_projection_lineage",
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: "2026-04-07T15:20:00.000Z",
    sensitive: true,
    sourceTaskId: "task_profile_graph_redacted_claim_projection_lineage",
    sourceFingerprint: "fingerprint_profile_graph_redacted_claim_projection_lineage",
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-07T14:45:00.000Z",    validFrom: "2026-04-07T14:45:00.000Z",
    validTo: "2026-04-07T15:20:00.000Z",
    endedAt: "2026-04-07T15:20:00.000Z",
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [
      unrelatedLiveObservation.payload.observationId,
      existingObservation.payload.observationId
    ],
    projectionSourceIds: [redactedFactId, survivingFactId, redactedFactId],
    entityRefIds: [],
    active: false
  });

  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-07T15:30:00.000Z",
    facts: [
      {
        id: survivingFactId,
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_redacted_claim_projection_lineage_surviving",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-07T14:45:00.000Z",
        confirmedAt: "2026-04-07T14:45:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-07T14:45:00.000Z"
      }
    ],
    graph: {
      updatedAt: "2026-04-07T15:30:00.000Z",
      observations: [existingObservation, unrelatedLiveObservation],
      claims: [existingClaim],
      events: []
    }
  });

  const redactedClaim = normalized.graph.claims.find(
    (claim) => claim.payload.claimId === existingClaim.payload.claimId
  );
  assert.ok(redactedClaim);
  assert.deepEqual(redactedClaim.payload.derivedFromObservationIds, [
    existingObservation.payload.observationId
  ]);
  assert.deepEqual(redactedClaim.payload.projectionSourceIds, [redactedFactId]);
});

test("normalizeProfileMemoryState preserves deleted episode projection lineage on redacted events after projection-source pruning", () => {
  const redactedEpisodeId = "episode_profile_graph_redacted_event_projection_lineage";
  const survivingEpisodeId = "episode_profile_graph_redacted_event_projection_lineage_surviving";
  const unrelatedDeletedEpisodeId = "episode_profile_graph_redacted_event_projection_lineage_other";
  const existingEvent = createGraphEventEnvelope({
    eventId: `event_${sha256HexFromCanonicalJson({ episodeId: redactedEpisodeId }).slice(0, 24)}`,
    stableRefId: null,
    family: "episode.candidate",
    title: "[redacted episode]",
    summary: "[redacted episode details]",
    redactionState: "redacted",
    redactedAt: "2026-04-07T15:20:00.000Z",
    sensitive: true,
    sourceTaskId: "memory_forget_profile_graph_redacted_event_projection_lineage",
    sourceFingerprint: "fingerprint_profile_graph_redacted_event_projection_lineage",
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-07T14:45:00.000Z",
    observedAt: "2026-04-07T14:45:00.000Z",
    validFrom: "2026-04-07T14:45:00.000Z",
    validTo: "2026-04-07T15:20:00.000Z",
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: [
      redactedEpisodeId,
      survivingEpisodeId,
      unrelatedDeletedEpisodeId,
      redactedEpisodeId
    ],
    entityRefIds: []
  });

  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-07T15:30:00.000Z",
    episodes: [
      {
        id: survivingEpisodeId,
        title: "Owen follow-up still active",
        summary: "Owen still needs a follow-up.",
        status: "unresolved",
        sourceTaskId: "task_profile_graph_redacted_event_projection_lineage_surviving",
        source: "user_input_pattern.episode_candidate",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        confidence: 0.8,
        observedAt: "2026-04-07T14:40:00.000Z",
        lastMentionedAt: "2026-04-07T14:50:00.000Z",
        lastUpdatedAt: "2026-04-07T14:50:00.000Z",
        resolvedAt: null,
        entityRefs: ["entity_owen"],
        openLoopRefs: ["open_loop_owen_projection_lineage_surviving"],
        tags: ["followup"]
      }
    ],
    graph: {
      updatedAt: "2026-04-07T15:30:00.000Z",
      observations: [],
      claims: [],
      events: [existingEvent]
    }
  });

  const redactedEvent = normalized.graph.events.find(
    (event) => event.payload.eventId === existingEvent.payload.eventId
  );
  assert.ok(redactedEvent);
  assert.deepEqual(redactedEvent.payload.projectionSourceIds, [redactedEpisodeId]);
});

test("normalizeProfileMemoryState repairs retained resolved events whose same-id payload no longer matches the surviving episode", () => {
  const canonicalEpisodeId = "episode_profile_graph_event_resolved_payload_repair_1";
  const expectedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
  const retainedCreatedAt = "2026-04-07T14:14:00.000Z";
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-07T15:30:00.000Z",
    episodes: [
      {
        id: canonicalEpisodeId,
        title: "Owen tax follow-up resolved",
        summary: "Owen sent the tax form.",
        status: "resolved",
        sourceTaskId: "task_profile_graph_event_resolved_payload_repair_1",
        source: "user_input_pattern.episode_candidate",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        confidence: 0.91,
        observedAt: "2026-04-07T14:50:00.000Z",
        lastMentionedAt: "2026-04-07T15:05:00.000Z",
        lastUpdatedAt: "2026-04-07T15:05:00.000Z",
        resolvedAt: "2026-04-07T15:05:00.000Z",
        entityRefs: ["entity_owen", "entity_tax_form"],
        openLoopRefs: ["open_loop_owen_tax"],
        tags: ["followup"]
      }
    ],
    graph: {
      updatedAt: "2026-04-07T15:30:00.000Z",
      observations: [],
      claims: [],
      events: [
        createGraphEventEnvelope({
          eventId: expectedEventId,
          stableRefId: null,
          family: "episode.candidate",
          title: "Stale retained resolved event",
          summary: "This retained event kept the right id and projection source but stale payload.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: true,
          sourceTaskId: "task_profile_graph_event_resolved_payload_repair_stale",
          sourceFingerprint: "fingerprint_profile_graph_event_resolved_payload_repair_stale",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-07T14:10:00.000Z",
          observedAt: "2026-04-07T14:10:00.000Z",
          validFrom: "2026-04-07T14:10:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "system_generated",
          derivedFromObservationIds: [],
          projectionSourceIds: [canonicalEpisodeId],
          entityRefIds: ["entity_owen"]
        }, retainedCreatedAt)
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.events.length, 1);
  assert.equal(normalized.graph.events[0]?.payload.eventId, expectedEventId);
  assert.equal(normalized.graph.events[0]?.createdAt, retainedCreatedAt);
  assert.equal(normalized.graph.events[0]?.payload.title, "Owen tax follow-up resolved");
  assert.equal(normalized.graph.events[0]?.payload.summary, "Owen sent the tax form.");
  assert.equal(normalized.graph.events[0]?.payload.sensitive, false);
  assert.equal(
    normalized.graph.events[0]?.payload.sourceTaskId,
    "task_profile_graph_event_resolved_payload_repair_1"
  );
  assert.equal(normalized.graph.events[0]?.payload.observedAt, "2026-04-07T14:50:00.000Z");
  assert.equal(normalized.graph.events[0]?.payload.validTo, "2026-04-07T15:05:00.000Z");
  assert.equal(normalized.graph.events[0]?.payload.timeSource, "user_stated");
  assert.deepEqual(
    normalized.graph.events[0]?.payload.projectionSourceIds,
    [canonicalEpisodeId]
  );
  assert.deepEqual(
    normalized.graph.events[0]?.payload.entityRefIds,
    ["entity_owen", "entity_tax_form"]
  );
  assert.equal(
    normalized.graph.events[0]?.payload.sourceFingerprint?.startsWith("graph_event_backfill_"),
    true
  );
  assert.equal(normalized.graph.mutationJournal.entries.length, 0);
  assert.equal(normalized.graph.readModel.watermark, 0);
});

test("normalizeProfileMemoryState reuses canonical graph event ids when retained episode ids are padded", () => {
  const canonicalEpisodeId = "episode_profile_graph_event_id_canonical";
  const canonicalEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:45:30.000Z",
    episodes: [
      {
        id: ` ${canonicalEpisodeId} `,
        title: "Owen tax follow-up",
        summary: "Owen still needs to send the tax form.",
        status: "unresolved",
        sourceTaskId: "task_profile_graph_event_id_canonical",
        source: "test.seed",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        confidence: 0.88,
        observedAt: "2026-04-03T20:10:30.000Z",
        lastMentionedAt: "2026-04-03T20:10:30.000Z",
        lastUpdatedAt: "2026-04-03T20:10:30.000Z",
        resolvedAt: null,
        entityRefs: ["entity_owen"],
        openLoopRefs: ["open_loop_owen_tax"],
        tags: ["followup"]
      }
    ],
    graph: {
      updatedAt: "2026-04-03T20:45:30.000Z",
      observations: [],
      claims: [],
      events: [
        createGraphEventEnvelope({
          eventId: canonicalEventId,
          stableRefId: null,
          family: "episode.candidate",
          title: "Owen tax follow-up",
          summary: "Owen still needs to send the tax form.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_id_canonical",
          sourceFingerprint: "fingerprint_profile_graph_event_id_canonical",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:10:30.000Z",
          observedAt: "2026-04-03T20:10:30.000Z",
          validFrom: "2026-04-03T20:10:30.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: [canonicalEpisodeId],
          entityRefIds: ["entity_owen"]
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        conflictingCurrentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.events.length, 1);
  assert.equal(normalized.graph.events[0]?.payload.eventId, canonicalEventId);
  assert.deepEqual(
    normalized.graph.events[0]?.payload.projectionSourceIds,
    [canonicalEpisodeId]
  );
});

test("normalizeProfileMemoryState adds a replay marker for active legacy graph events missing journal coverage", () => {
  const activeEvent = createGraphEventEnvelope({
    eventId: "event_profile_graph_replay_backfill_1",
    stableRefId: null,
    family: "episode.candidate",
    title: "Owen tax follow-up",
    summary: "Owen still needs to send the tax form.",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_replay_backfill_1",
    sourceFingerprint: "fingerprint_profile_graph_replay_backfill_1",
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-03T20:12:00.000Z",
    observedAt: "2026-04-03T20:12:00.000Z",
    validFrom: "2026-04-03T20:12:00.000Z",
    validTo: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: ["episode_profile_graph_replay_backfill_1"],
    entityRefIds: ["entity_owen"]
  });
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:46:00.000Z",
    graph: {
      updatedAt: "2026-04-03T20:46:00.000Z",
      observations: [],
      claims: [],
      events: [activeEvent],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.events.length, 1);
  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.eventIds,
    ["event_profile_graph_replay_backfill_1"]
  );
  assert.equal(normalized.graph.mutationJournal.entries[0]?.sourceTaskId, null);
  assert.equal(
    normalized.graph.mutationJournal.entries[0]?.sourceFingerprint?.startsWith(
      "graph_event_replay_backfill_"
    ),
    true
  );
  assert.equal(normalized.graph.readModel.watermark, 1);
});

test("normalizeProfileMemoryState adds replay markers for active legacy graph claims alongside legacy events", () => {
  const activeClaim = createGraphClaimEnvelope({
    claimId: "claim_profile_graph_replay_backfill_1",
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_claim_replay_backfill_1",
    sourceFingerprint: "fingerprint_profile_graph_claim_replay_backfill_1",
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-03T20:11:00.000Z",
    validFrom: "2026-04-03T20:11:00.000Z",
    validTo: null,
    endedAt: null,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: ["fact_profile_graph_claim_replay_backfill_1"],
    entityRefIds: [],
    active: true
  });
  const activeEvent = createGraphEventEnvelope({
    eventId: "event_profile_graph_claim_replay_backfill_1",
    stableRefId: null,
    family: "episode.candidate",
    title: "Owen tax follow-up",
    summary: "Owen still needs to send the tax form.",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_claim_replay_backfill_1",
    sourceFingerprint: "fingerprint_profile_graph_claim_replay_backfill_1",
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-03T20:12:00.000Z",
    observedAt: "2026-04-03T20:12:00.000Z",
    validFrom: "2026-04-03T20:12:00.000Z",
    validTo: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: ["episode_profile_graph_claim_replay_backfill_1"],
    entityRefIds: ["entity_owen"]
  });
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:47:00.000Z",
    graph: {
      updatedAt: "2026-04-03T20:47:00.000Z",
      observations: [],
      claims: [activeClaim],
      events: [activeEvent],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.observations.length, 1);
  assert.equal(normalized.graph.claims.length, 1);
  assert.equal(normalized.graph.events.length, 1);
  assert.deepEqual(
    normalized.graph.claims[0]?.payload.derivedFromObservationIds,
    [normalized.graph.observations[0]!.payload.observationId]
  );
  assert.equal(normalized.graph.mutationJournal.entries.length, 3);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.eventIds,
    ["event_profile_graph_claim_replay_backfill_1"]
  );
  assert.equal(
    normalized.graph.mutationJournal.entries[0]?.sourceFingerprint?.startsWith(
      "graph_event_replay_backfill_"
    ),
    true
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[1]?.observationIds,
    [normalized.graph.observations[0]!.payload.observationId]
  );
  assert.equal(
    normalized.graph.mutationJournal.entries[1]?.sourceFingerprint?.startsWith(
      "graph_observation_replay_backfill_"
    ),
    true
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[2]?.claimIds,
    ["claim_profile_graph_replay_backfill_1"]
  );
  assert.equal(
    normalized.graph.mutationJournal.entries[2]?.sourceFingerprint?.startsWith(
      "graph_claim_replay_backfill_"
    ),
    true
  );
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
    "claim_profile_graph_replay_backfill_1"
  );
  assert.equal(normalized.graph.readModel.watermark, 3);
});

test("normalizeProfileMemoryState adds a replay marker for legacy graph observations missing journal coverage", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:47:00.000Z",
    graph: {
      updatedAt: "2026-04-03T20:47:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_replay_backfill_1",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.1",
          normalizedValue: "Owen fell down",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_observation_replay_backfill_1",
          sourceFingerprint: "fingerprint_profile_graph_observation_replay_backfill_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:04:00.000Z",
          observedAt: "2026-04-03T20:04:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_owen"]
        })
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.observations.length, 1);
  assert.equal(normalized.graph.claims.length, 0);
  assert.equal(normalized.graph.events.length, 0);
  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    ["observation_profile_graph_replay_backfill_1"]
  );
  assert.equal(
    normalized.graph.mutationJournal.entries[0]?.sourceFingerprint?.startsWith(
      "graph_observation_replay_backfill_"
    ),
    true
  );
  assert.equal(normalized.graph.readModel.watermark, 1);
});

test("normalizeProfileMemoryState clamps malformed retained snapshot watermarks before observation replay repair", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:47:05.000Z",
    graph: {
      updatedAt: "2026-04-03T20:47:05.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_replay_backfill_snapshot_clamp_1",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.snapshot",
          normalizedValue: "Owen slipped on the ice",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_replay_backfill_snapshot_clamp_1",
          sourceFingerprint: "fingerprint_profile_graph_replay_backfill_snapshot_clamp_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:04:05.000Z",
          observedAt: "2026-04-03T20:04:05.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_owen"]
        })
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 99,
        lastCompactedAt: "2026-04-03T20:40:00.000Z",
        maxObservationCount: 2048,
        maxClaimCount: 2048,
        maxEventCount: 1024,
        maxJournalEntries: 4096
      }
    }
  });

  assert.equal(normalized.graph.compaction.snapshotWatermark, 0);
  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    ["observation_profile_graph_replay_backfill_snapshot_clamp_1"]
  );
  assert.equal(normalized.graph.readModel.watermark, 1);
});

test("normalizeProfileMemoryState clamps malformed retained nextWatermark before observation replay repair", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:47:06.000Z",
    graph: {
      updatedAt: "2026-04-03T20:47:06.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_replay_backfill_next_watermark_clamp_1",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.next_watermark",
          normalizedValue: "Owen still needs a winter coat",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_replay_backfill_next_watermark_clamp_1",
          sourceFingerprint: "fingerprint_profile_graph_replay_backfill_next_watermark_clamp_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:04:06.000Z",
          observedAt: "2026-04-03T20:04:06.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_owen"]
        })
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 99,
        entries: []
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 2048,
        maxClaimCount: 2048,
        maxEventCount: 1024,
        maxJournalEntries: 4096
      }
    }
  });

  assert.equal(normalized.graph.compaction.snapshotWatermark, 0);
  assert.equal(normalized.graph.mutationJournal.entries.length, 1);
  assert.equal(normalized.graph.mutationJournal.entries[0]?.watermark, 1);
  assert.equal(normalized.graph.mutationJournal.nextWatermark, 2);
  assert.equal(normalized.graph.readModel.watermark, 1);
});

test("normalizeProfileMemoryState repairs missing replay coverage for uncompacted partial journal state", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:47:30.000Z",
    graph: {
      updatedAt: "2026-04-03T20:47:30.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_partial_replay_existing",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.existing",
          normalizedValue: "Owen already mentioned this before",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_partial_replay_existing",
          sourceFingerprint: "fingerprint_profile_graph_partial_replay_existing",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:03:30.000Z",
          observedAt: "2026-04-03T20:03:30.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_owen"]
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_partial_replay_1",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.1",
          normalizedValue: "Owen still needs help",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_partial_replay_1",
          sourceFingerprint: "fingerprint_profile_graph_partial_replay_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:04:30.000Z",
          observedAt: "2026-04-03T20:04:30.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_owen"]
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_partial_replay_1",
          stableRefId: null,
          family: "contact.relationship",
          normalizedKey: "contact.owen.relationship",
          normalizedValue: "friend",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_partial_replay_1",
          sourceFingerprint: "fingerprint_profile_graph_partial_replay_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:05:30.000Z",
          validFrom: "2026-04-03T20:05:30.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_partial_replay_1"],
          projectionSourceIds: ["fact_profile_graph_partial_replay_1"],
          entityRefIds: ["entity_owen"],
          active: true
        })
      ],
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_partial_replay_1",
          stableRefId: null,
          family: "episode.candidate",
          title: "Owen follow-up",
          summary: "Owen still needs help.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_partial_replay_1",
          sourceFingerprint: "fingerprint_profile_graph_partial_replay_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:06:30.000Z",
          observedAt: "2026-04-03T20:06:30.000Z",
          validFrom: "2026-04-03T20:06:30.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["episode_profile_graph_partial_replay_1"],
          entityRefIds: ["entity_owen"]
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 2,
        entries: [
          {
            journalEntryId: "journal_profile_graph_partial_replay_existing",
            watermark: 1,
            recordedAt: "2026-04-03T20:03:30.000Z",
            sourceTaskId: "task_profile_graph_partial_replay_existing",
            sourceFingerprint: "fingerprint_profile_graph_partial_replay_existing",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_partial_replay_existing"],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 2048,
        maxClaimCount: 2048,
        maxEventCount: 1024,
        maxJournalEntries: 4096
      }
    }
  });

  assert.equal(normalized.graph.mutationJournal.entries.length, 4);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [1, 2, 3, 4]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[1]?.eventIds,
    ["event_profile_graph_partial_replay_1"]
  );
  assert.equal(
    normalized.graph.mutationJournal.entries[1]?.sourceFingerprint?.startsWith(
      "graph_event_replay_backfill_"
    ),
    true
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[2]?.observationIds,
    ["observation_profile_graph_partial_replay_1"]
  );
  assert.equal(
    normalized.graph.mutationJournal.entries[2]?.sourceFingerprint?.startsWith(
      "graph_observation_replay_backfill_"
    ),
    true
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[3]?.claimIds,
    ["claim_profile_graph_partial_replay_1"]
  );
  assert.equal(
    normalized.graph.mutationJournal.entries[3]?.sourceFingerprint?.startsWith(
      "graph_claim_replay_backfill_"
    ),
    true
  );
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["contact.owen.relationship"],
    "claim_profile_graph_partial_replay_1"
  );
  assert.equal(normalized.graph.readModel.watermark, 4);
});

test("normalizeProfileMemoryState reuses matching observations when repairing detached claim lineage", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:47:45.000Z",
    graph: {
      updatedAt: "2026-04-03T20:47:45.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_claim_lineage_existing",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_claim_lineage_existing",
          sourceFingerprint: "fingerprint_profile_graph_claim_lineage_existing",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:04:45.000Z",
          observedAt: "2026-04-03T20:04:45.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_claim_lineage_existing",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_claim_lineage_existing",
          sourceFingerprint: "fingerprint_profile_graph_claim_lineage_existing",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:04:45.000Z",
          validFrom: "2026-04-03T20:04:45.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_claim_lineage_existing"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 2048,
        maxClaimCount: 2048,
        maxEventCount: 1024,
        maxJournalEntries: 4096
      }
    }
  });

  assert.equal(normalized.graph.observations.length, 1);
  assert.deepEqual(
    normalized.graph.claims[0]?.payload.derivedFromObservationIds,
    ["observation_profile_graph_claim_lineage_existing"]
  );
  assert.equal(normalized.graph.mutationJournal.entries.length, 2);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    ["observation_profile_graph_claim_lineage_existing"]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[1]?.claimIds,
    ["claim_profile_graph_claim_lineage_existing"]
  );
});

test("normalizeProfileMemoryState repairs stale claim lineage ids by reusing matching surviving observations", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:47:46.000Z",
    graph: {
      updatedAt: "2026-04-03T20:47:46.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_claim_lineage_stale_existing",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_claim_lineage_stale_existing",
          sourceFingerprint: "fingerprint_profile_graph_claim_lineage_stale_existing",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:04:46.000Z",
          observedAt: "2026-04-03T20:04:46.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_claim_lineage_stale_unrelated",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.1",
          normalizedValue: "Needs docs review",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_claim_lineage_stale_unrelated",
          sourceFingerprint: "fingerprint_profile_graph_claim_lineage_stale_unrelated",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:05:46.000Z",
          observedAt: "2026-04-03T20:05:46.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_owen"]
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_claim_lineage_stale_existing",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_claim_lineage_stale_existing",
          sourceFingerprint: "fingerprint_profile_graph_claim_lineage_stale_existing",
          sourceTier: "explicit_user_statement",
          assertedAt: " 2026-04-03T20:04:46.000Z ",
          validFrom: " 2026-04-03T20:04:46.000Z ",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_claim_lineage_stale_missing"],
          projectionSourceIds: ["fact_profile_graph_claim_lineage_stale_existing"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 2048,
        maxClaimCount: 2048,
        maxEventCount: 1024,
        maxJournalEntries: 4096
      }
    }
  });

  assert.equal(normalized.graph.observations.length, 2);
  assert.deepEqual(
    normalized.graph.claims[0]?.payload.derivedFromObservationIds,
    ["observation_profile_graph_claim_lineage_stale_existing"]
  );
  assert.equal(normalized.graph.mutationJournal.entries.length, 2);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    [
      "observation_profile_graph_claim_lineage_stale_existing",
      "observation_profile_graph_claim_lineage_stale_unrelated"
    ]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[1]?.claimIds,
    ["claim_profile_graph_claim_lineage_stale_existing"]
  );
});

test("normalizeProfileMemoryState repairs surviving but semantically mismatched claim lineage observations", () => {
  const expectedObservationId =
    `observation_${sha256HexFromCanonicalJson({
      claimId: "claim_profile_graph_claim_lineage_mismatch_existing",
      family: "identity.preferred_name",
      normalizedKey: "identity.preferred_name",
      normalizedValue: "Avery",
      sourceFingerprint: "fingerprint_profile_graph_claim_lineage_mismatch_existing",
      assertedAt: "2026-04-03T20:04:47.000Z"
    }).slice(0, 24)}`;
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:47:47.000Z",
    graph: {
      updatedAt: "2026-04-03T20:47:47.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_claim_lineage_mismatch_wrong",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Ava",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_claim_lineage_mismatch_wrong",
          sourceFingerprint: "fingerprint_profile_graph_claim_lineage_mismatch_wrong",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:04:47.000Z",
          observedAt: "2026-04-03T20:04:47.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_claim_lineage_mismatch_existing",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_claim_lineage_mismatch_existing",
          sourceFingerprint: "fingerprint_profile_graph_claim_lineage_mismatch_existing",
          sourceTier: "explicit_user_statement",
          assertedAt: " 2026-04-03T20:04:47.000Z ",
          validFrom: " 2026-04-03T20:04:47.000Z ",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_claim_lineage_mismatch_wrong"],
          projectionSourceIds: ["fact_profile_graph_claim_lineage_mismatch_existing"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 2048,
        maxClaimCount: 2048,
        maxEventCount: 1024,
        maxJournalEntries: 4096
      }
    }
  });

  assert.equal(normalized.graph.observations.length, 2);
  assert.equal(
    normalized.graph.observations.some(
      (observation) => observation.payload.observationId === expectedObservationId
    ),
    true
  );
  assert.deepEqual(
    normalized.graph.claims[0]?.payload.derivedFromObservationIds,
    [expectedObservationId]
  );
  assert.equal(normalized.graph.mutationJournal.entries.length, 2);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    [
      "observation_profile_graph_claim_lineage_mismatch_wrong",
      expectedObservationId
    ].sort((left, right) => left.localeCompare(right))
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[1]?.claimIds,
    ["claim_profile_graph_claim_lineage_mismatch_existing"]
  );
});

test("normalizeProfileMemoryState backfills graph observations and current claims from legacy active facts", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:48:00.000Z",
    facts: [
      {
        id: " fact_profile_graph_legacy_backfill_1 ",
        key: "employment.current",
        value: "Lantern",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_legacy_backfill_1",
        source: "user_input_pattern.work_at",
        observedAt: "2026-04-03T20:05:00.000Z",
        confirmedAt: "2026-04-03T20:05:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-03T20:05:00.000Z"
      },
      {
        id: "fact_profile_graph_legacy_backfill_2",
        key: "employment.current",
        value: "Northstar",
        sensitive: false,
        status: "uncertain",
        confidence: 0.6,
        sourceTaskId: "task_profile_graph_legacy_backfill_2",
        source: "user_input_pattern.job_is",
        observedAt: "2026-04-03T20:06:00.000Z",
        confirmedAt: null,
        supersededAt: null,
        lastUpdatedAt: "2026-04-03T20:06:00.000Z"
      }
    ],
    graph: {
      updatedAt: "2026-04-03T20:48:00.000Z",
      observations: [],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.observations.length, 2);
  assert.equal(
    normalized.graph.observations.every((observation) =>
      observation.payload.sourceFingerprint?.startsWith("graph_fact_backfill_")
    ),
    true
  );
  assert.equal(normalized.graph.claims.length, 1);
  assert.equal(normalized.graph.claims[0]?.payload.normalizedValue, "Lantern");
  assert.deepEqual(
    normalized.graph.claims[0]?.payload.projectionSourceIds,
    ["fact_profile_graph_legacy_backfill_1"]
  );
  assert.deepEqual(
    normalized.graph.claims[0]?.payload.derivedFromObservationIds,
    [normalized.graph.observations[0]!.payload.observationId]
  );
  assert.equal(normalized.graph.mutationJournal.entries.length, 2);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    normalized.graph.observations
      .map((observation) => observation.payload.observationId)
      .sort((left, right) => left.localeCompare(right))
  );
  assert.equal(
    normalized.graph.mutationJournal.entries[0]?.sourceFingerprint?.startsWith(
      "graph_observation_replay_backfill_"
    ),
    true
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[1]?.claimIds,
    [normalized.graph.claims[0]!.payload.claimId]
  );
  assert.equal(
    normalized.graph.mutationJournal.entries[1]?.sourceFingerprint?.startsWith(
      "graph_claim_replay_backfill_"
    ),
    true
  );
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["employment.current"],
    normalized.graph.claims[0]!.payload.claimId
  );
  assert.equal(normalized.graph.readModel.watermark, 2);
});

test("normalizeProfileMemoryState backfills current claims from legacy active facts when matching observations already exist", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:48:10.000Z",
    facts: [
      {
        id: "fact_profile_graph_legacy_partial_backfill_1",
        key: " employment.current ",
        value: "Lantern",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_legacy_partial_backfill_1",
        source: "user_input_pattern.work_at",
        observedAt: " 2026-04-03T15:05:10-05:00 ",
        confirmedAt: "2026-04-03T20:05:10.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-03T20:05:10.000Z"
      },
      {
        id: "fact_profile_graph_legacy_partial_backfill_2",
        key: " employment.current ",
        value: "Northstar",
        sensitive: false,
        status: "uncertain",
        confidence: 0.6,
        sourceTaskId: "task_profile_graph_legacy_partial_backfill_2",
        source: "user_input_pattern.job_is",
        observedAt: " 2026-04-03T15:06:10-05:00 ",
        confirmedAt: null,
        supersededAt: null,
        lastUpdatedAt: "2026-04-03T20:06:10.000Z"
      }
    ],
    graph: {
      updatedAt: "2026-04-03T20:48:10.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_legacy_partial_backfill_existing",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "Lantern",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_legacy_partial_backfill_1",
          sourceFingerprint: "fingerprint_profile_graph_legacy_partial_backfill_existing",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:05:10.000Z",
          observedAt: "2026-04-03T20:05:10.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_legacy_partial_backfill_unrelated",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.1",
          normalizedValue: "Owen still needs help",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_legacy_partial_backfill_unrelated",
          sourceFingerprint: "fingerprint_profile_graph_legacy_partial_backfill_unrelated",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:01:10.000Z",
          observedAt: "2026-04-03T20:01:10.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_owen"]
        })
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const lanternObservations = normalized.graph.observations.filter(
    (observation) =>
      observation.payload.normalizedKey === "employment.current" &&
      observation.payload.normalizedValue === "Lantern"
  );

  assert.equal(normalized.graph.observations.length, 3);
  assert.equal(lanternObservations.length, 1);
  assert.equal(
    lanternObservations[0]?.payload.observationId,
    "observation_profile_graph_legacy_partial_backfill_existing"
  );
  assert.equal(normalized.graph.claims[0]?.payload.family, "employment.current");
  assert.equal(
    normalized.graph.observations.find(
      (observation) =>
        observation.payload.normalizedKey === "employment.current" &&
        observation.payload.normalizedValue === "Northstar"
    )?.payload.observedAt,
    "2026-04-03T20:06:10.000Z"
  );
  assert.equal(normalized.graph.claims.length, 1);
  assert.equal(normalized.graph.claims[0]?.payload.normalizedValue, "Lantern");
  assert.equal(normalized.graph.claims[0]?.payload.assertedAt, "2026-04-03T20:05:10.000Z");
  assert.deepEqual(
    normalized.graph.claims[0]?.payload.derivedFromObservationIds,
    ["observation_profile_graph_legacy_partial_backfill_existing"]
  );
  assert.equal(normalized.graph.mutationJournal.entries.length, 2);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    normalized.graph.observations
      .map((observation) => observation.payload.observationId)
      .sort((left, right) => left.localeCompare(right))
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[1]?.claimIds,
    [normalized.graph.claims[0]!.payload.claimId]
  );
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["employment.current"],
    normalized.graph.claims[0]!.payload.claimId
  );
  assert.equal(normalized.graph.readModel.watermark, 2);
});

test("normalizeProfileMemoryState reuses existing graph observations when retained fact sourceTaskIds are padded", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:48:05.000Z",
    facts: [
      {
        id: "fact_profile_graph_legacy_source_task_padding_1",
        key: "employment.current",
        value: "Lantern",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: " task_profile_graph_legacy_source_task_padding_1 ",
        source: "user_input_pattern.work_at",
        observedAt: " 2026-04-03T15:05:05-05:00 ",
        confirmedAt: "2026-04-03T20:05:05.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-03T20:05:05.000Z"
      }
    ],
    graph: {
      updatedAt: "2026-04-03T20:48:05.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_legacy_source_task_padding_existing",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "Lantern",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_legacy_source_task_padding_1",
          sourceFingerprint: "fingerprint_profile_graph_legacy_source_task_padding_existing",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:05:05.000Z",
          observedAt: "2026-04-03T20:05:05.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const matchingObservations = normalized.graph.observations.filter(
    (observation) =>
      observation.payload.normalizedKey === "employment.current" &&
      observation.payload.normalizedValue === "Lantern"
  );

  assert.equal(matchingObservations.length, 1);
  assert.equal(
    matchingObservations[0]?.payload.observationId,
    "observation_profile_graph_legacy_source_task_padding_existing"
  );
  assert.equal(
    matchingObservations[0]?.payload.sourceTaskId,
    "task_profile_graph_legacy_source_task_padding_1"
  );
  assert.equal(normalized.graph.claims.length, 1);
  assert.deepEqual(
    normalized.graph.claims[0]?.payload.derivedFromObservationIds,
    ["observation_profile_graph_legacy_source_task_padding_existing"]
  );
});

test("normalizeProfileMemoryState canonicalizes retained fact sources before legacy observation backfill", () => {
  const baseInput = {
    updatedAt: "2026-04-03T20:48:05.500Z",
    facts: [
      {
        id: "fact_profile_graph_legacy_source_padding_1",
        key: "employment.current",
        value: "Lantern",
        sensitive: false,
        status: "confirmed" as const,
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_legacy_source_padding_1",
        observedAt: "2026-04-03T15:05:05-05:00",
        confirmedAt: "2026-04-03T20:05:05.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-03T20:05:05.000Z"
      }
    ],
    graph: {
      updatedAt: "2026-04-03T20:48:05.500Z",
      observations: [],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1" as const,
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1" as const,
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  };
  const canonical = normalizeProfileMemoryState({
    ...baseInput,
    facts: [
      {
        ...baseInput.facts[0]!,
        source: "user_input_pattern.work_at"
      }
    ]
  });
  const padded = normalizeProfileMemoryState({
    ...baseInput,
    facts: [
      {
        ...baseInput.facts[0]!,
        source: " User_Input_Pattern.Work_At "
      }
    ]
  });

  assert.equal(padded.graph.observations.length, 1);
  assert.equal(padded.graph.claims.length, 1);
  assert.equal(
    padded.graph.observations[0]?.payload.observationId,
    canonical.graph.observations[0]?.payload.observationId
  );
  assert.equal(
    padded.graph.observations[0]?.payload.sourceFingerprint,
    canonical.graph.observations[0]?.payload.sourceFingerprint
  );
  assert.deepEqual(
    padded.graph.claims[0]?.payload.derivedFromObservationIds,
    [canonical.graph.observations[0]!.payload.observationId]
  );
});

test("normalizeProfileMemoryState canonicalizes retained fact keys and values before legacy backfill fingerprints", () => {
  const baseInput = {
    updatedAt: "2026-04-03T20:48:05.650Z",
    facts: [
      {
        id: "fact_profile_graph_legacy_key_value_padding_1",
        sensitive: false,
        status: "confirmed" as const,
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_legacy_key_value_padding_1",
        source: "user_input_pattern.work_at",
        observedAt: "2026-04-03T15:05:05-05:00",
        confirmedAt: "2026-04-03T20:05:05.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-03T20:05:05.000Z"
      }
    ],
    graph: {
      updatedAt: "2026-04-03T20:48:05.650Z",
      observations: [],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1" as const,
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1" as const,
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  };
  const canonical = normalizeProfileMemoryState({
    ...baseInput,
    facts: [
      {
        ...baseInput.facts[0]!,
        key: "employment.current",
        value: "Lantern"
      }
    ]
  });
  const padded = normalizeProfileMemoryState({
    ...baseInput,
    facts: [
      {
        ...baseInput.facts[0]!,
        key: " employment.current ",
        value: " Lantern "
      }
    ]
  });

  assert.equal(padded.graph.observations.length, 1);
  assert.equal(padded.graph.claims.length, 1);
  assert.equal(
    padded.graph.observations[0]?.payload.observationId,
    canonical.graph.observations[0]?.payload.observationId
  );
  assert.equal(
    padded.graph.observations[0]?.payload.sourceFingerprint,
    canonical.graph.observations[0]?.payload.sourceFingerprint
  );
  assert.deepEqual(
    padded.graph.claims[0]?.payload.derivedFromObservationIds,
    [canonical.graph.observations[0]!.payload.observationId]
  );
});

test("normalizeProfileMemoryState canonicalizes retained fact observedAt before legacy backfill fingerprints", () => {
  const baseInput = {
    updatedAt: "2026-04-03T20:48:05.700Z",
    facts: [
      {
        id: "fact_profile_graph_legacy_observed_at_padding_1",
        key: "employment.current",
        value: "Lantern",
        sensitive: false,
        status: "confirmed" as const,
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_legacy_observed_at_padding_1",
        source: "user_input_pattern.work_at",
        confirmedAt: "2026-04-03T20:05:05.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-03T20:05:05.000Z"
      }
    ],
    graph: {
      updatedAt: "2026-04-03T20:48:05.700Z",
      observations: [],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1" as const,
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1" as const,
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  };
  const canonical = normalizeProfileMemoryState({
    ...baseInput,
    facts: [
      {
        ...baseInput.facts[0]!,
        observedAt: "2026-04-03T20:05:05.000Z"
      }
    ]
  });
  const padded = normalizeProfileMemoryState({
    ...baseInput,
    facts: [
      {
        ...baseInput.facts[0]!,
        observedAt: " 2026-04-03T15:05:05-05:00 "
      }
    ]
  });

  assert.equal(padded.graph.observations.length, 1);
  assert.equal(padded.graph.claims.length, 1);
  assert.equal(
    padded.graph.observations[0]?.payload.observationId,
    canonical.graph.observations[0]?.payload.observationId
  );
  assert.equal(
    padded.graph.observations[0]?.payload.sourceFingerprint,
    canonical.graph.observations[0]?.payload.sourceFingerprint
  );
  assert.equal(
    padded.graph.observations[0]?.payload.observedAt,
    canonical.graph.observations[0]?.payload.observedAt
  );
  assert.deepEqual(
    padded.graph.claims[0]?.payload.derivedFromObservationIds,
    [canonical.graph.observations[0]!.payload.observationId]
  );
});

test("normalizeProfileMemoryState canonicalizes retained fact ids before legacy winner tie-break repair", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:48:05.750Z",
    facts: [
      {
        id: "fact_profile_graph_legacy_id_padding_1",
        key: "employment.current",
        value: "Lantern",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_legacy_id_padding_1",
        source: "user_input_pattern.work_at",
        observedAt: "2026-04-03T20:05:05.750Z",
        confirmedAt: "2026-04-03T20:05:05.750Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-03T20:05:05.750Z"
      },
      {
        id: " fact_profile_graph_legacy_id_padding_2 ",
        key: "employment.current",
        value: "Northstar",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_legacy_id_padding_2",
        source: "user_input_pattern.job_is",
        observedAt: "2026-04-03T20:05:05.750Z",
        confirmedAt: "2026-04-03T20:05:05.750Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-03T20:05:05.750Z"
      }
    ],
    graph: {
      updatedAt: "2026-04-03T20:48:05.750Z",
      observations: [],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const activeClaims = normalized.graph.claims.filter((claim) => claim.payload.active);

  assert.equal(normalized.graph.observations.length, 2);
  assert.equal(activeClaims.length, 1);
  assert.equal(activeClaims[0]?.payload.normalizedValue, "Lantern");
  assert.deepEqual(
    activeClaims[0]?.payload.projectionSourceIds,
    ["fact_profile_graph_legacy_id_padding_1"]
  );
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["employment.current"],
    activeClaims[0]!.payload.claimId
  );
});

test("normalizeProfileMemoryState treats whitespace-only retained fact supersededAt as active during legacy backfill", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:48:06.000Z",
    facts: [
      {
        id: "fact_profile_graph_legacy_blank_superseded_at_1",
        key: "employment.current",
        value: "Lantern",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_legacy_blank_superseded_at_1",
        source: "user_input_pattern.work_at",
        observedAt: "2026-04-03T20:05:06.000Z",
        confirmedAt: "2026-04-03T20:05:06.000Z",
        supersededAt: "   ",
        lastUpdatedAt: "2026-04-03T20:05:06.000Z"
      }
    ],
    graph: {
      updatedAt: "2026-04-03T20:48:06.000Z",
      observations: [],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.observations.length, 1);
  assert.equal(normalized.graph.claims.length, 1);
  assert.equal(normalized.graph.claims[0]?.payload.normalizedValue, "Lantern");
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["employment.current"],
    normalized.graph.claims[0]!.payload.claimId
  );
});

test("normalizeProfileMemoryState backfills current claims when only inactive legacy claims remain", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:48:20.000Z",
    facts: [
      {
        id: "fact_profile_graph_legacy_inactive_backfill_1",
        key: "employment.current",
        value: "Lantern",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_legacy_inactive_backfill_1",
        source: "user_input_pattern.work_at",
        observedAt: "2026-04-03T20:05:20.000Z",
        confirmedAt: "2026-04-03T20:05:20.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-03T20:05:20.000Z"
      },
      {
        id: "fact_profile_graph_legacy_inactive_backfill_2",
        key: "employment.current",
        value: "Northstar",
        sensitive: false,
        status: "uncertain",
        confidence: 0.6,
        sourceTaskId: "task_profile_graph_legacy_inactive_backfill_2",
        source: "user_input_pattern.job_is",
        observedAt: "2026-04-03T20:06:20.000Z",
        confirmedAt: null,
        supersededAt: null,
        lastUpdatedAt: "2026-04-03T20:06:20.000Z"
      }
    ],
    graph: {
      updatedAt: "2026-04-03T20:48:20.000Z",
      observations: [],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_legacy_inactive_backfill_closed",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "OldCo",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_legacy_inactive_backfill_closed",
          sourceFingerprint: "fingerprint_profile_graph_legacy_inactive_backfill_closed",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T19:05:20.000Z",
          validFrom: "2026-04-03T19:05:20.000Z",
          validTo: "2026-04-03T19:45:20.000Z",
          endedAt: "2026-04-03T19:45:20.000Z",
          endedByClaimId: "claim_profile_graph_legacy_inactive_backfill_successor",
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_legacy_inactive_backfill_closed"],
          entityRefIds: [],
          active: false
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const activeClaims = normalized.graph.claims.filter((claim) => claim.payload.active);

  assert.equal(normalized.graph.observations.length, 2);
  assert.equal(normalized.graph.claims.length, 2);
  assert.equal(activeClaims.length, 1);
  assert.equal(activeClaims[0]?.payload.normalizedValue, "Lantern");
  assert.deepEqual(
    activeClaims[0]?.payload.derivedFromObservationIds,
    [normalized.graph.observations[0]!.payload.observationId]
  );
  assert.equal(
    normalized.graph.claims.some(
      (claim) => claim.payload.claimId === "claim_profile_graph_legacy_inactive_backfill_closed"
    ),
    true
  );
  assert.equal(normalized.graph.mutationJournal.entries.length, 2);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[1]?.claimIds,
    [activeClaims[0]!.payload.claimId]
  );
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["employment.current"],
    activeClaims[0]!.payload.claimId
  );
  assert.equal(normalized.graph.readModel.watermark, 2);
});

test("normalizeProfileMemoryState repairs stale active legacy claims when canonical current winner differs", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:48:30.000Z",
    facts: [
      {
        id: "fact_profile_graph_legacy_stale_active_backfill_1",
        key: "employment.current",
        value: "Lantern",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_legacy_stale_active_backfill_1",
        source: "user_input_pattern.work_at",
        observedAt: "2026-04-03T20:45:30.000Z",
        confirmedAt: "2026-04-03T20:45:30.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-03T20:45:30.000Z"
      },
      {
        id: "fact_profile_graph_legacy_stale_active_backfill_2",
        key: "employment.current",
        value: "Northstar",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_legacy_stale_active_backfill_2",
        source: "user_input_pattern.job_is",
        observedAt: "2026-04-03T21:15:30+01:00",
        confirmedAt: "2026-04-03T20:15:30.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-03T21:15:30+01:00"
      }
    ],
    graph: {
      updatedAt: "2026-04-03T20:48:30.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_legacy_stale_active_backfill_existing",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "Lantern",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_legacy_stale_active_backfill_1",
          sourceFingerprint: "fingerprint_profile_graph_legacy_stale_active_backfill_existing",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:45:30.000Z",
          observedAt: "2026-04-03T20:45:30.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_legacy_stale_active_backfill_oldco",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "OldCo",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_legacy_stale_active_backfill_oldco",
          sourceFingerprint: "fingerprint_profile_graph_legacy_stale_active_backfill_oldco",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T19:05:30.000Z",
          validFrom: "2026-04-03T19:05:30.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_legacy_stale_active_backfill_oldco"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const activeClaims = normalized.graph.claims.filter((claim) => claim.payload.active);
  const closedOldClaim = normalized.graph.claims.find(
    (claim) => claim.payload.claimId === "claim_profile_graph_legacy_stale_active_backfill_oldco"
  );
  const northstarObservation = normalized.graph.observations.find(
    (observation) =>
      observation.payload.normalizedKey === "employment.current" &&
      observation.payload.normalizedValue === "Northstar"
  );

  assert.equal(normalized.graph.observations.length, 2);
  assert.equal(activeClaims.length, 1);
  assert.equal(activeClaims[0]?.payload.normalizedValue, "Northstar");
  assert.equal(northstarObservation?.payload.observedAt, "2026-04-03T20:15:30.000Z");
  assert.deepEqual(
    activeClaims[0]?.payload.derivedFromObservationIds,
    [northstarObservation!.payload.observationId]
  );
  assert.equal(closedOldClaim?.payload.active, false);
  assert.equal(closedOldClaim?.payload.endedByClaimId, activeClaims[0]?.payload.claimId ?? null);
  assert.equal(normalized.graph.mutationJournal.entries.length, 2);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    normalized.graph.observations
      .map((observation) => observation.payload.observationId)
      .sort((left, right) => left.localeCompare(right))
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[1]?.claimIds.sort((left, right) => left.localeCompare(right)),
    [activeClaims[0]!.payload.claimId]
  );
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["employment.current"],
    activeClaims[0]!.payload.claimId
  );
  assert.equal(normalized.graph.readModel.watermark, 2);
});

test("normalizeProfileMemoryState repairs legacy current claims when matching observations exist but active claim source tier is invalid", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-06T03:40:00.000Z",
    facts: [
      {
        id: "fact_profile_graph_legacy_invalid_source_claim_1",
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: true,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_legacy_invalid_source_claim_1",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-06T03:10:00.000Z",
        confirmedAt: "2026-04-06T03:10:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-06T03:10:00.000Z"
      }
    ],
    graph: {
      updatedAt: "2026-04-06T03:40:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_legacy_invalid_source_claim_existing",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: true,
          sourceTaskId: "task_profile_graph_legacy_invalid_source_claim_1",
          sourceFingerprint: "fingerprint_profile_graph_legacy_invalid_source_claim_existing",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-06T03:10:00.000Z",
          observedAt: "2026-04-06T03:10:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_legacy_invalid_source_claim_old",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: true,
          sourceTaskId: "task_profile_graph_legacy_invalid_source_claim_1",
          sourceFingerprint: "fingerprint_profile_graph_legacy_invalid_source_claim_old",
          sourceTier: "assistant_inference",
          assertedAt: "2026-04-06T03:10:00.000Z",
          validFrom: "2026-04-06T03:10:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "inferred",
          derivedFromObservationIds: [
            "observation_profile_graph_legacy_invalid_source_claim_existing"
          ],
          projectionSourceIds: ["fact_profile_graph_legacy_invalid_source_claim_1"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        conflictingCurrentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const activeClaims = normalized.graph.claims.filter((claim) => claim.payload.active);
  const closedOldClaim = normalized.graph.claims.find(
    (claim) => claim.payload.claimId === "claim_profile_graph_legacy_invalid_source_claim_old"
  );

  assert.equal(normalized.graph.observations.length, 1);
  assert.equal(activeClaims.length, 1);
  assert.notEqual(
    activeClaims[0]?.payload.claimId,
    "claim_profile_graph_legacy_invalid_source_claim_old"
  );
  assert.equal(activeClaims[0]?.payload.sourceTier, "explicit_user_statement");
  assert.deepEqual(
    activeClaims[0]?.payload.derivedFromObservationIds,
    ["observation_profile_graph_legacy_invalid_source_claim_existing"]
  );
  assert.equal(closedOldClaim?.payload.active, false);
  assert.equal(closedOldClaim?.payload.endedByClaimId, activeClaims[0]?.payload.claimId ?? null);
  assert.equal(normalized.graph.mutationJournal.entries.length, 2);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    ["observation_profile_graph_legacy_invalid_source_claim_existing"]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[1]?.claimIds,
    [activeClaims[0]!.payload.claimId]
  );
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
    activeClaims[0]!.payload.claimId
  );
  assert.equal(normalized.graph.readModel.watermark, 2);
});

test("normalizeProfileMemoryState repairs semantically aligned legacy current claims with stale metadata, stale projection lineage, stray entity refs, and empty lineage", () => {
  const expectedClaimId =
    `claim_${sha256HexFromCanonicalJson({
      family: "identity.preferred_name",
      normalizedKey: "identity.preferred_name",
      normalizedValue: "Avery"
    }).slice(0, 24)}`;
  const expectedSourceFingerprint = sha256HexFromCanonicalJson({
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery"
  }).slice(0, 32);
  const retainedCreatedAt = "2026-04-06T02:15:00.000Z";
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-06T03:50:00.000Z",
    facts: [
      {
        id: "fact_profile_graph_legacy_stale_same_id_claim_old",
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: true,
        status: "superseded",
        confidence: 0.82,
        sourceTaskId: "task_profile_graph_legacy_stale_same_id_claim_old",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-06T02:10:00.000Z",
        confirmedAt: "2026-04-06T02:10:00.000Z",
        supersededAt: "2026-04-06T03:10:00.000Z",
        lastUpdatedAt: "2026-04-06T03:10:00.000Z"
      },
      {
        id: "fact_profile_graph_legacy_stale_same_id_claim_1",
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: true,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_legacy_stale_same_id_claim_1",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-06T03:10:00.000Z",
        confirmedAt: "2026-04-06T03:10:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-06T03:10:00.000Z"
      }
    ],
    graph: {
      updatedAt: "2026-04-06T03:50:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_legacy_stale_same_id_claim_existing",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: true,
          sourceTaskId: "task_profile_graph_legacy_stale_same_id_claim_1",
          sourceFingerprint: "fingerprint_profile_graph_legacy_stale_same_id_claim_existing",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-06T03:10:00.000Z",
          observedAt: "2026-04-06T03:10:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: expectedClaimId,
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: true,
          sourceTaskId: "task_profile_graph_legacy_stale_same_id_claim_stale",
          sourceFingerprint: "fingerprint_profile_graph_legacy_stale_same_id_claim_stale",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-06T02:10:00.000Z",
          validFrom: "2026-04-06T02:10:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "system_generated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_legacy_stale_same_id_claim_old"],
          entityRefIds: ["entity_profile_graph_legacy_stale_same_id_claim_stray"],
          active: true
        }, retainedCreatedAt)
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        conflictingCurrentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  assert.equal(normalized.graph.observations.length, 1);
  assert.equal(normalized.graph.claims.length, 1);
  assert.equal(normalized.graph.claims[0]?.payload.claimId, expectedClaimId);
  assert.equal(normalized.graph.claims[0]?.createdAt, retainedCreatedAt);
  assert.equal(normalized.graph.claims[0]?.payload.active, true);
  assert.equal(
    normalized.graph.claims[0]?.payload.sourceTaskId,
    "task_profile_graph_legacy_stale_same_id_claim_1"
  );
  assert.equal(
    normalized.graph.claims[0]?.payload.sourceFingerprint,
    expectedSourceFingerprint
  );
  assert.equal(normalized.graph.claims[0]?.payload.assertedAt, "2026-04-06T03:10:00.000Z");
  assert.equal(normalized.graph.claims[0]?.payload.validFrom, "2026-04-06T03:10:00.000Z");
  assert.equal(normalized.graph.claims[0]?.payload.timeSource, "user_stated");
  assert.deepEqual(normalized.graph.claims[0]?.payload.projectionSourceIds, [
    "fact_profile_graph_legacy_stale_same_id_claim_1"
  ]);
  assert.deepEqual(normalized.graph.claims[0]?.payload.entityRefIds, []);
  assert.deepEqual(
    normalized.graph.claims[0]?.payload.derivedFromObservationIds,
    ["observation_profile_graph_legacy_stale_same_id_claim_existing"]
  );
  assert.equal(
    normalized.graph.indexes.byEntityRefId["entity_profile_graph_legacy_stale_same_id_claim_stray"],
    undefined
  );
  assert.equal(normalized.graph.mutationJournal.entries.length, 2);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    ["observation_profile_graph_legacy_stale_same_id_claim_existing"]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[1]?.claimIds,
    [expectedClaimId]
  );
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
    expectedClaimId
  );
  assert.equal(normalized.graph.readModel.watermark, 2);
});

test("normalizeProfileMemoryState repairs stale active legacy claims when effective sensitivity differs from stored claim", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:48:30.500Z",
    facts: [
      {
        id: "fact_profile_graph_legacy_sensitive_floor_claim_1",
        key: "residence.current",
        value: "Detroit",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_legacy_sensitive_floor_claim_1",
        source: "user_input_pattern.residence",
        observedAt: "2026-04-03T20:45:31.000Z",
        confirmedAt: "2026-04-03T20:45:31.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-03T20:45:31.000Z"
      }
    ],
    graph: {
      updatedAt: "2026-04-03T20:48:30.500Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_legacy_sensitive_floor_claim_existing",
          stableRefId: null,
          family: "residence.current",
          normalizedKey: "residence.current",
          normalizedValue: "Detroit",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: true,
          sourceTaskId: "task_profile_graph_legacy_sensitive_floor_claim_1",
          sourceFingerprint: "fingerprint_profile_graph_legacy_sensitive_floor_claim_existing",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:45:31.000Z",
          observedAt: "2026-04-03T20:45:31.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_legacy_sensitive_floor_claim_existing",
          stableRefId: null,
          family: "residence.current",
          normalizedKey: "residence.current",
          normalizedValue: "Detroit",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_legacy_sensitive_floor_claim_1",
          sourceFingerprint: "fingerprint_profile_graph_legacy_sensitive_floor_claim_existing",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:45:31.000Z",
          validFrom: "2026-04-03T20:45:31.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [
            "observation_profile_graph_legacy_sensitive_floor_claim_existing"
          ],
          projectionSourceIds: ["fact_profile_graph_legacy_sensitive_floor_claim_1"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const activeClaims = normalized.graph.claims.filter((claim) => claim.payload.active);

  assert.equal(normalized.graph.observations.length, 1);
  assert.equal(activeClaims.length, 1);
  assert.equal(activeClaims[0]?.payload.normalizedKey, "residence.current");
  assert.equal(activeClaims[0]?.payload.normalizedValue, "Detroit");
  assert.equal(activeClaims[0]?.payload.sensitive, true);
  assert.deepEqual(
    activeClaims[0]?.payload.derivedFromObservationIds,
    ["observation_profile_graph_legacy_sensitive_floor_claim_existing"]
  );
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["residence.current"],
    activeClaims[0]!.payload.claimId
  );
});

test("normalizeProfileMemoryState repairs stale supporting observations when aligned legacy claims already match", () => {
  const sourceFingerprint =
    `graph_fact_backfill_${sha256HexFromCanonicalJson([
      {
        family: "residence.current",
        key: "residence.current",
        value: "Detroit",
        source: "user_input_pattern.residence",
        sourceTaskId: "task_profile_graph_legacy_sensitive_floor_observation_1",
        observedAt: "2026-04-03T20:45:31.500Z"
      }
    ]).slice(0, 24)}`;
  const observationId =
    `observation_${sha256HexFromCanonicalJson({
      family: "residence.current",
      normalizedKey: "residence.current",
      normalizedValue: "Detroit",
      source: "user_input_pattern.residence",
      observedAt: "2026-04-03T20:45:31.500Z",
      sourceFingerprint
    }).slice(0, 24)}`;
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:48:30.750Z",
    facts: [
      {
        id: "fact_profile_graph_legacy_sensitive_floor_observation_1",
        key: "residence.current",
        value: "Detroit",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_legacy_sensitive_floor_observation_1",
        source: "user_input_pattern.residence",
        observedAt: "2026-04-03T20:45:31.500Z",
        confirmedAt: "2026-04-03T20:45:31.500Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-03T20:45:31.500Z"
      }
    ],
    graph: {
      updatedAt: "2026-04-03T20:48:30.750Z",
      observations: [
        createGraphObservationEnvelope({
          observationId,
          stableRefId: null,
          family: "residence.current",
          normalizedKey: "residence.current",
          normalizedValue: "Detroit",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_legacy_sensitive_floor_observation_1",
          sourceFingerprint,
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:45:31.500Z",
          observedAt: "2026-04-03T20:45:31.500Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_legacy_sensitive_floor_observation_existing",
          stableRefId: null,
          family: "residence.current",
          normalizedKey: "residence.current",
          normalizedValue: "Detroit",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: true,
          sourceTaskId: "task_profile_graph_legacy_sensitive_floor_observation_1",
          sourceFingerprint: "fingerprint_profile_graph_legacy_sensitive_floor_observation_existing",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:45:31.500Z",
          validFrom: "2026-04-03T20:45:31.500Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [observationId],
          projectionSourceIds: ["fact_profile_graph_legacy_sensitive_floor_observation_1"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const activeClaims = normalized.graph.claims.filter((claim) => claim.payload.active);

  assert.equal(normalized.graph.observations.length, 1);
  assert.equal(normalized.graph.observations[0]?.payload.observationId, observationId);
  assert.equal(normalized.graph.observations[0]?.payload.sensitive, true);
  assert.equal(activeClaims.length, 1);
  assert.equal(activeClaims[0]?.payload.sensitive, true);
  assert.deepEqual(activeClaims[0]?.payload.derivedFromObservationIds, [observationId]);
});

test("normalizeProfileMemoryState fail-closes malformed retained fact confidence during stale active claim repair", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T20:49:30.000Z",
    facts: [
      {
        id: "fact_profile_graph_legacy_invalid_confidence_backfill_1",
        key: "employment.current",
        value: "Northstar",
        sensitive: false,
        status: "confirmed",
        confidence: 99,
        sourceTaskId: "task_profile_graph_legacy_invalid_confidence_backfill_1",
        source: "user_input_pattern.job_is",
        observedAt: "2026-04-03T20:45:30.000Z",
        confirmedAt: "2026-04-03T20:45:30.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-03T20:45:30.000Z"
      },
      {
        id: "fact_profile_graph_legacy_invalid_confidence_backfill_2",
        key: "employment.current",
        value: "Lantern",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_legacy_invalid_confidence_backfill_2",
        source: "user_input_pattern.work_at",
        observedAt: "2026-04-03T20:45:30.000Z",
        confirmedAt: "2026-04-03T20:45:30.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-03T20:45:30.000Z"
      }
    ],
    graph: {
      updatedAt: "2026-04-03T20:49:30.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_legacy_invalid_confidence_backfill_existing",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "Lantern",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_legacy_invalid_confidence_backfill_2",
          sourceFingerprint:
            "fingerprint_profile_graph_legacy_invalid_confidence_backfill_existing",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:45:30.000Z",
          observedAt: "2026-04-03T20:45:30.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_legacy_invalid_confidence_backfill_oldco",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "OldCo",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_legacy_invalid_confidence_backfill_oldco",
          sourceFingerprint: "fingerprint_profile_graph_legacy_invalid_confidence_backfill_oldco",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T19:05:30.000Z",
          validFrom: "2026-04-03T19:05:30.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_legacy_invalid_confidence_backfill_oldco"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const activeClaims = normalized.graph.claims.filter((claim) => claim.payload.active);
  const closedOldClaim = normalized.graph.claims.find(
    (claim) =>
      claim.payload.claimId ===
      "claim_profile_graph_legacy_invalid_confidence_backfill_oldco"
  );

  assert.equal(normalized.graph.observations.length, 2);
  assert.equal(activeClaims.length, 1);
  assert.equal(activeClaims[0]?.payload.normalizedValue, "Lantern");
  assert.deepEqual(
    activeClaims[0]?.payload.derivedFromObservationIds,
    ["observation_profile_graph_legacy_invalid_confidence_backfill_existing"]
  );
  assert.equal(closedOldClaim?.payload.active, false);
  assert.equal(closedOldClaim?.payload.endedByClaimId, activeClaims[0]?.payload.claimId ?? null);
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    normalized.graph.observations
      .map((observation) => observation.payload.observationId)
      .sort((left, right) => left.localeCompare(right))
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[1]?.claimIds.sort((left, right) =>
      left.localeCompare(right)
    ),
    [activeClaims[0]!.payload.claimId]
  );
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["employment.current"],
    activeClaims[0]?.payload.claimId
  );
  assert.equal(normalized.graph.readModel.watermark, 2);
});

test("normalizeProfileMemoryState compacts oversized graph mutation journals and clamps snapshot watermark", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T21:00:00.000Z",
    graph: {
      updatedAt: "2026-04-03T21:00:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_compaction_1",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.1",
          normalizedValue: "Owen still needs help",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_compaction_1",
          sourceFingerprint: "fingerprint_profile_graph_compaction_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:01:00.000Z",
          observedAt: "2026-04-03T20:01:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_compaction_2",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.2",
          normalizedValue: "Owen needs a reply",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_compaction_2",
          sourceFingerprint: "fingerprint_profile_graph_compaction_2",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:02:00.000Z",
          observedAt: "2026-04-03T20:02:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_compaction_3",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.3",
          normalizedValue: "Owen asked again later",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_compaction_3",
          sourceFingerprint: "fingerprint_profile_graph_compaction_3",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T20:03:00.000Z",
          observedAt: "2026-04-03T20:03:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 4,
        entries: [
          {
            journalEntryId: "journal_profile_graph_compaction_1",
            watermark: 1,
            recordedAt: "2026-04-03T20:01:00.000Z",
            sourceTaskId: "task_profile_graph_compaction_1",
            sourceFingerprint: "fingerprint_profile_graph_compaction_1",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_compaction_1"],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_compaction_2",
            watermark: 2,
            recordedAt: "2026-04-03T20:02:00.000Z",
            sourceTaskId: "task_profile_graph_compaction_2",
            sourceFingerprint: "fingerprint_profile_graph_compaction_2",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_compaction_2"],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_compaction_3",
            watermark: 3,
            recordedAt: "2026-04-03T20:03:00.000Z",
            sourceTaskId: "task_profile_graph_compaction_3",
            sourceFingerprint: "fingerprint_profile_graph_compaction_3",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_compaction_3"],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 99,
        lastCompactedAt: "2026-04-03T19:00:00.000Z",
        maxObservationCount: 2048,
        maxClaimCount: 2048,
        maxEventCount: 1024,
        maxJournalEntries: 2
      }
    }
  });

  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [2, 3]
  );
  assert.equal(normalized.graph.compaction.snapshotWatermark, 1);
  assert.equal(normalized.graph.compaction.lastCompactedAt, "2026-04-03T21:00:00.000Z");
  assert.equal(normalized.graph.readModel.watermark, 3);
});

test("normalizeProfileMemoryState compacts unreferenced observations after journal retention trims the replay window", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T22:00:00.000Z",
    graph: {
      updatedAt: "2026-04-03T22:00:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_compaction_1",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.sarah.context.1",
          normalizedValue: "I know Sarah",
          sensitive: false,
          sourceTaskId: "task_profile_graph_observation_compaction_1",
          sourceFingerprint: "fingerprint_profile_graph_observation_compaction_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T21:01:00.000Z",
          observedAt: "2026-04-03T21:01:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_compaction_2",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.jordan.context.1",
          normalizedValue: "I know Jordan",
          sensitive: false,
          sourceTaskId: "task_profile_graph_observation_compaction_2",
          sourceFingerprint: "fingerprint_profile_graph_observation_compaction_2",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T21:02:00.000Z",
          observedAt: "2026-04-03T21:02:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_compaction_3",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.milo.context.1",
          normalizedValue: "I know Milo",
          sensitive: false,
          sourceTaskId: "task_profile_graph_observation_compaction_3",
          sourceFingerprint: "fingerprint_profile_graph_observation_compaction_3",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T21:03:00.000Z",
          observedAt: "2026-04-03T21:03:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 4,
        entries: [
          {
            journalEntryId: "journal_profile_graph_observation_compaction_1",
            watermark: 1,
            recordedAt: "2026-04-03T21:01:00.000Z",
            sourceTaskId: "task_profile_graph_observation_compaction_1",
            sourceFingerprint: "fingerprint_profile_graph_observation_compaction_1",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_compaction_1"],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_observation_compaction_2",
            watermark: 2,
            recordedAt: "2026-04-03T21:02:00.000Z",
            sourceTaskId: "task_profile_graph_observation_compaction_2",
            sourceFingerprint: "fingerprint_profile_graph_observation_compaction_2",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_compaction_2"],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_observation_compaction_3",
            watermark: 3,
            recordedAt: "2026-04-03T21:03:00.000Z",
            sourceTaskId: "task_profile_graph_observation_compaction_3",
            sourceFingerprint: "fingerprint_profile_graph_observation_compaction_3",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_compaction_3"],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 1,
        maxClaimCount: 2048,
        maxEventCount: 1024,
        maxJournalEntries: 1
      }
    }
  });

  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [3]
  );
  assert.deepEqual(
    normalized.graph.observations.map((observation) => observation.payload.observationId),
    ["observation_profile_graph_compaction_3"]
  );
  assert.equal(normalized.graph.compaction.snapshotWatermark, 2);
  assert.equal(normalized.graph.compaction.lastCompactedAt, "2026-04-03T22:00:00.000Z");
});

test("normalizeProfileMemoryState compacts redacted observations after journal retention trims their last replay protection", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-08T04:05:00.000Z",
    graph: {
      updatedAt: "2026-04-08T04:05:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_redacted_observation_compaction_drop",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: null,
          redactionState: "redacted",
          redactedAt: "2026-04-08T04:01:00.000Z",
          sensitive: true,
          sourceTaskId: "task_profile_graph_redacted_observation_compaction_drop",
          sourceFingerprint: "fingerprint_profile_graph_redacted_observation_compaction_drop",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-08T04:00:00.000Z",
          observedAt: "2026-04-08T04:00:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_redacted_observation_compaction_keep",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.rowan.context.1",
          normalizedValue: "I know Rowan",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_redacted_observation_compaction_keep",
          sourceFingerprint: "fingerprint_profile_graph_redacted_observation_compaction_keep",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-08T04:02:00.000Z",
          observedAt: "2026-04-08T04:02:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 3,
        entries: [
          {
            journalEntryId: "journal_profile_graph_redacted_observation_compaction_drop",
            watermark: 1,
            recordedAt: "2026-04-08T04:00:00.000Z",
            sourceTaskId: "task_profile_graph_redacted_observation_compaction_drop",
            sourceFingerprint: "fingerprint_profile_graph_redacted_observation_compaction_drop",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_redacted_observation_compaction_drop"],
            claimIds: [],
            eventIds: [],
            redactionState: "redacted"
          },
          {
            journalEntryId: "journal_profile_graph_redacted_observation_compaction_keep",
            watermark: 2,
            recordedAt: "2026-04-08T04:02:00.000Z",
            sourceTaskId: "task_profile_graph_redacted_observation_compaction_keep",
            sourceFingerprint: "fingerprint_profile_graph_redacted_observation_compaction_keep",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_redacted_observation_compaction_keep"],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 1,
        maxClaimCount: 4,
        maxEventCount: 4,
        maxJournalEntries: 1
      }
    }
  });

  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [2]
  );
  assert.deepEqual(
    normalized.graph.observations.map((observation) => observation.payload.observationId),
    ["observation_profile_graph_redacted_observation_compaction_keep"]
  );
  assert.equal(normalized.graph.compaction.snapshotWatermark, 1);
  assert.equal(normalized.graph.compaction.lastCompactedAt, "2026-04-08T04:05:00.000Z");
});

test("normalizeProfileMemoryState does not let live claims or events pin redacted observations after lineage pruning", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-08T04:30:00.000Z",
    graph: {
      updatedAt: "2026-04-08T04:30:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_redacted_lineage_claim_drop",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: null,
          redactionState: "redacted",
          redactedAt: "2026-04-08T04:21:00.000Z",
          sensitive: true,
          sourceTaskId: "task_profile_graph_redacted_lineage_claim_drop",
          sourceFingerprint: "fingerprint_profile_graph_redacted_lineage_claim_drop",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-08T04:20:00.000Z",
          observedAt: "2026-04-08T04:20:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_redacted_lineage_claim_keep",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_redacted_lineage_claim_keep",
          sourceFingerprint: "fingerprint_profile_graph_redacted_lineage_claim_keep",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-08T04:22:00.000Z",
          observedAt: "2026-04-08T04:22:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_redacted_lineage_event_drop",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.rowan.context.1",
          normalizedValue: null,
          redactionState: "redacted",
          redactedAt: "2026-04-08T04:23:00.000Z",
          sensitive: true,
          sourceTaskId: "task_profile_graph_redacted_lineage_event_drop",
          sourceFingerprint: "fingerprint_profile_graph_redacted_lineage_event_drop",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-08T04:23:00.000Z",
          observedAt: "2026-04-08T04:23:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_redacted_lineage_event_keep",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.rowan.context.2",
          normalizedValue: "Rowan asked for help",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_redacted_lineage_event_keep",
          sourceFingerprint: "fingerprint_profile_graph_redacted_lineage_event_keep",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-08T04:24:00.000Z",
          observedAt: "2026-04-08T04:24:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_redacted_lineage_keep",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_redacted_lineage_claim_keep",
          sourceFingerprint: "fingerprint_profile_graph_redacted_lineage_claim_keep",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-08T04:22:00.000Z",
          validFrom: "2026-04-08T04:22:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [
            "observation_profile_graph_redacted_lineage_claim_drop",
            "observation_profile_graph_redacted_lineage_claim_keep"
          ],
          projectionSourceIds: ["fact_profile_graph_redacted_lineage_claim_keep"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_redacted_lineage_keep",
          stableRefId: null,
          family: "episode.candidate",
          title: "Rowan asked for help",
          summary: "Rowan asked for help and the outcome stayed unresolved.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_redacted_lineage_event_keep",
          sourceFingerprint: "fingerprint_profile_graph_redacted_lineage_event_keep",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-08T04:24:00.000Z",
          observedAt: "2026-04-08T04:24:00.000Z",
          validFrom: "2026-04-08T04:24:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [
            "observation_profile_graph_redacted_lineage_event_drop",
            "observation_profile_graph_redacted_lineage_event_keep"
          ],
          projectionSourceIds: ["episode_profile_graph_redacted_lineage_event_keep"],
          entityRefIds: ["entity_rowan"]
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 5,
        entries: [
          {
            journalEntryId: "journal_profile_graph_redacted_lineage_claim_drop",
            watermark: 1,
            recordedAt: "2026-04-08T04:20:00.000Z",
            sourceTaskId: "task_profile_graph_redacted_lineage_claim_drop",
            sourceFingerprint: "fingerprint_profile_graph_redacted_lineage_claim_drop",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_redacted_lineage_claim_drop"],
            claimIds: [],
            eventIds: [],
            redactionState: "redacted"
          },
          {
            journalEntryId: "journal_profile_graph_redacted_lineage_event_drop",
            watermark: 2,
            recordedAt: "2026-04-08T04:23:00.000Z",
            sourceTaskId: "task_profile_graph_redacted_lineage_event_drop",
            sourceFingerprint: "fingerprint_profile_graph_redacted_lineage_event_drop",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_redacted_lineage_event_drop"],
            claimIds: [],
            eventIds: [],
            redactionState: "redacted"
          },
          {
            journalEntryId: "journal_profile_graph_redacted_lineage_claim_keep",
            watermark: 3,
            recordedAt: "2026-04-08T04:22:00.000Z",
            sourceTaskId: "task_profile_graph_redacted_lineage_claim_keep",
            sourceFingerprint: "fingerprint_profile_graph_redacted_lineage_claim_keep",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_redacted_lineage_claim_keep"],
            claimIds: ["claim_profile_graph_redacted_lineage_keep"],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_redacted_lineage_event_keep",
            watermark: 4,
            recordedAt: "2026-04-08T04:24:00.000Z",
            sourceTaskId: "task_profile_graph_redacted_lineage_event_keep",
            sourceFingerprint: "fingerprint_profile_graph_redacted_lineage_event_keep",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_redacted_lineage_event_keep"],
            claimIds: [],
            eventIds: ["event_profile_graph_redacted_lineage_keep"],
            redactionState: "not_requested"
          }
        ]
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 2,
        maxClaimCount: 4,
        maxEventCount: 4,
        maxJournalEntries: 2
      }
    }
  });

  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [3, 4]
  );
  assert.deepEqual(
    normalized.graph.observations.map((observation) => observation.payload.observationId),
    [
      "observation_profile_graph_redacted_lineage_claim_keep",
      "observation_profile_graph_redacted_lineage_event_keep"
    ]
  );
  assert.deepEqual(
    normalized.graph.claims[0]?.payload.derivedFromObservationIds,
    ["observation_profile_graph_redacted_lineage_claim_keep"]
  );
  assert.deepEqual(
    normalized.graph.events[0]?.payload.derivedFromObservationIds,
    ["observation_profile_graph_redacted_lineage_event_keep"]
  );
  assert.equal(normalized.graph.compaction.snapshotWatermark, 2);
  assert.equal(normalized.graph.compaction.lastCompactedAt, "2026-04-08T04:30:00.000Z");
});

test("normalizeProfileMemoryState does not let redacted claims pin stale observations after journal trimming", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T22:05:00.000Z",
    graph: {
      updatedAt: "2026-04-03T22:05:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_redacted_claim_retention_old",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: null,
          redactionState: "redacted",
          redactedAt: "2026-04-03T21:01:00.000Z",
          sensitive: true,
          sourceTaskId: "task_profile_graph_redacted_claim_retention_old",
          sourceFingerprint: "fingerprint_profile_graph_redacted_claim_retention_old",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T21:00:00.000Z",
          observedAt: "2026-04-03T21:00:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_redacted_claim_retention_new",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.sarah.context.1",
          normalizedValue: "I know Sarah",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_redacted_claim_retention_new",
          sourceFingerprint: "fingerprint_profile_graph_redacted_claim_retention_new",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T21:02:00.000Z",
          observedAt: "2026-04-03T21:02:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_redacted_claim_retention_old",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: null,
          redactionState: "redacted",
          redactedAt: "2026-04-03T21:01:00.000Z",
          sensitive: true,
          sourceTaskId: "task_profile_graph_redacted_claim_retention_old",
          sourceFingerprint: "fingerprint_profile_graph_redacted_claim_retention_old",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T21:00:00.000Z",
          validFrom: "2026-04-03T21:00:00.000Z",
          validTo: "2026-04-03T21:01:00.000Z",
          endedAt: "2026-04-03T21:01:00.000Z",
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_redacted_claim_retention_old"],
          projectionSourceIds: ["fact_profile_graph_redacted_claim_retention_old"],
          entityRefIds: [],
          active: false
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 3,
        entries: [
          {
            journalEntryId: "journal_profile_graph_redacted_claim_retention_old",
            watermark: 1,
            recordedAt: "2026-04-03T21:00:00.000Z",
            sourceTaskId: "task_profile_graph_redacted_claim_retention_old",
            sourceFingerprint: "fingerprint_profile_graph_redacted_claim_retention_old",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_redacted_claim_retention_old"],
            claimIds: ["claim_profile_graph_redacted_claim_retention_old"],
            eventIds: [],
            redactionState: "redacted"
          },
          {
            journalEntryId: "journal_profile_graph_redacted_claim_retention_new",
            watermark: 2,
            recordedAt: "2026-04-03T21:02:00.000Z",
            sourceTaskId: "task_profile_graph_redacted_claim_retention_new",
            sourceFingerprint: "fingerprint_profile_graph_redacted_claim_retention_new",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_redacted_claim_retention_new"],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 1,
        maxClaimCount: 4,
        maxEventCount: 4,
        maxJournalEntries: 1
      }
    }
  });

  assert.deepEqual(
    normalized.graph.observations.map((observation) => observation.payload.observationId),
    ["observation_profile_graph_redacted_claim_retention_new"]
  );
  assert.deepEqual(
    normalized.graph.claims[0]?.payload.derivedFromObservationIds,
    []
  );
});

test("normalizeProfileMemoryState preserves event-derived observations during observation compaction", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T22:10:00.000Z",
    graph: {
      updatedAt: "2026-04-03T22:10:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_event_lineage_1",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.1",
          normalizedValue: "Owen fell down yesterday",
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_lineage_1",
          sourceFingerprint: "fingerprint_profile_graph_event_lineage_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T21:41:00.000Z",
          observedAt: "2026-04-03T21:41:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_owen"]
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_event_lineage_2",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.jordan.context.1",
          normalizedValue: "Jordan was there too",
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_lineage_2",
          sourceFingerprint: "fingerprint_profile_graph_event_lineage_2",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T21:42:00.000Z",
          observedAt: "2026-04-03T21:42:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_jordan"]
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_event_lineage_3",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.milo.context.1",
          normalizedValue: "Milo asked about it later",
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_lineage_3",
          sourceFingerprint: "fingerprint_profile_graph_event_lineage_3",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T21:43:00.000Z",
          observedAt: "2026-04-03T21:43:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_milo"]
        })
      ],
      claims: [],
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_event_lineage_1",
          stableRefId: null,
          family: "episode.candidate",
          title: "Owen fall situation",
          summary: "Owen fell down and the outcome stayed unresolved.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_lineage_event",
          sourceFingerprint: "fingerprint_profile_graph_event_lineage_event",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T21:41:00.000Z",
          observedAt: "2026-04-03T21:41:00.000Z",
          validFrom: "2026-04-03T21:41:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_event_lineage_2"],
          projectionSourceIds: ["episode_profile_graph_event_lineage_1"],
          entityRefIds: ["entity_owen"]
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 4,
        entries: [
          {
            journalEntryId: "journal_profile_graph_event_lineage_1",
            watermark: 1,
            recordedAt: "2026-04-03T21:41:00.000Z",
            sourceTaskId: "task_profile_graph_event_lineage_1",
            sourceFingerprint: "fingerprint_profile_graph_event_lineage_1",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_event_lineage_1"],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_event_lineage_2",
            watermark: 2,
            recordedAt: "2026-04-03T21:42:00.000Z",
            sourceTaskId: "task_profile_graph_event_lineage_2",
            sourceFingerprint: "fingerprint_profile_graph_event_lineage_2",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_event_lineage_2"],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_event_lineage_3",
            watermark: 3,
            recordedAt: "2026-04-03T21:43:00.000Z",
            sourceTaskId: "task_profile_graph_event_lineage_3",
            sourceFingerprint: "fingerprint_profile_graph_event_lineage_3",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_event_lineage_3"],
            claimIds: [],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 1,
        maxClaimCount: 2048,
        maxEventCount: 1024,
        maxJournalEntries: 1
      }
    }
  });

  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [4]
  );
  assert.deepEqual(
    normalized.graph.observations.map((observation) => observation.payload.observationId),
    ["observation_profile_graph_event_lineage_2"]
  );
  assert.deepEqual(
    normalized.graph.events[0]?.payload.derivedFromObservationIds,
    ["observation_profile_graph_event_lineage_2"]
  );
  assert.equal(normalized.graph.compaction.snapshotWatermark, 3);
  assert.equal(normalized.graph.compaction.lastCompactedAt, "2026-04-03T22:10:00.000Z");
});

test("normalizeProfileMemoryState compacts inactive claims after journal retention trims the replay window", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T22:15:00.000Z",
    graph: {
      updatedAt: "2026-04-03T22:15:00.000Z",
      observations: [],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_claim_compaction_1",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          sensitive: false,
          sourceTaskId: "task_profile_graph_claim_compaction_1",
          sourceFingerprint: "fingerprint_profile_graph_claim_compaction_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T21:31:00.000Z",
          validFrom: "2026-04-03T21:31:00.000Z",
          validTo: "2026-04-03T21:32:00.000Z",
          endedAt: "2026-04-03T21:32:00.000Z",
          endedByClaimId: "claim_profile_graph_claim_compaction_2",
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_claim_compaction_1"],
          entityRefIds: [],
          active: false
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_claim_compaction_2",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Ava",
          sensitive: false,
          sourceTaskId: "task_profile_graph_claim_compaction_2",
          sourceFingerprint: "fingerprint_profile_graph_claim_compaction_2",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T21:32:00.000Z",
          validFrom: "2026-04-03T21:32:00.000Z",
          validTo: "2026-04-03T21:33:00.000Z",
          endedAt: "2026-04-03T21:33:00.000Z",
          endedByClaimId: "claim_profile_graph_claim_compaction_3",
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_claim_compaction_2"],
          entityRefIds: [],
          active: false
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_claim_compaction_3",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "June",
          sensitive: false,
          sourceTaskId: "task_profile_graph_claim_compaction_3",
          sourceFingerprint: "fingerprint_profile_graph_claim_compaction_3",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T21:33:00.000Z",
          validFrom: "2026-04-03T21:33:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_claim_compaction_3"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 4,
        entries: [
          {
            journalEntryId: "journal_profile_graph_claim_compaction_1",
            watermark: 1,
            recordedAt: "2026-04-03T21:31:00.000Z",
            sourceTaskId: "task_profile_graph_claim_compaction_1",
            sourceFingerprint: "fingerprint_profile_graph_claim_compaction_1",
            mutationEnvelopeHash: null,
            observationIds: [],
            claimIds: ["claim_profile_graph_claim_compaction_1"],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_claim_compaction_2",
            watermark: 2,
            recordedAt: "2026-04-03T21:32:00.000Z",
            sourceTaskId: "task_profile_graph_claim_compaction_2",
            sourceFingerprint: "fingerprint_profile_graph_claim_compaction_2",
            mutationEnvelopeHash: null,
            observationIds: [],
            claimIds: ["claim_profile_graph_claim_compaction_2"],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_claim_compaction_3",
            watermark: 3,
            recordedAt: "2026-04-03T21:33:00.000Z",
            sourceTaskId: "task_profile_graph_claim_compaction_3",
            sourceFingerprint: "fingerprint_profile_graph_claim_compaction_3",
            mutationEnvelopeHash: null,
            observationIds: [],
            claimIds: [
              "claim_profile_graph_claim_compaction_2",
              "claim_profile_graph_claim_compaction_3"
            ],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 2048,
        maxClaimCount: 1,
        maxEventCount: 1024,
        maxJournalEntries: 1
      }
    }
  });

  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [4]
  );
  assert.deepEqual(
    normalized.graph.claims.map((claim) => claim.payload.claimId).sort((left, right) =>
      left.localeCompare(right)
    ),
    ["claim_profile_graph_claim_compaction_3"]
  );
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
    "claim_profile_graph_claim_compaction_3"
  );
  assert.equal(normalized.graph.compaction.snapshotWatermark, 3);
  assert.equal(normalized.graph.compaction.lastCompactedAt, "2026-04-03T22:15:00.000Z");
});

test("normalizeProfileMemoryState compacts redacted claims after journal retention trims their last replay protection", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-08T03:15:00.000Z",
    graph: {
      updatedAt: "2026-04-08T03:15:00.000Z",
      observations: [],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_redacted_claim_compaction_drop",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: null,
          redactionState: "redacted",
          redactedAt: "2026-04-08T03:02:00.000Z",
          sensitive: true,
          sourceTaskId: "task_profile_graph_redacted_claim_compaction_drop",
          sourceFingerprint: "fingerprint_profile_graph_redacted_claim_compaction_drop",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-08T03:00:00.000Z",
          validFrom: "2026-04-08T03:00:00.000Z",
          validTo: "2026-04-08T03:02:00.000Z",
          endedAt: "2026-04-08T03:02:00.000Z",
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_redacted_claim_compaction_drop"],
          entityRefIds: [],
          active: false
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_redacted_claim_compaction_keep",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Ava",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_redacted_claim_compaction_keep",
          sourceFingerprint: "fingerprint_profile_graph_redacted_claim_compaction_keep",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-08T03:05:00.000Z",
          validFrom: "2026-04-08T03:05:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_graph_redacted_claim_compaction_keep"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 3,
        entries: [
          {
            journalEntryId: "journal_profile_graph_redacted_claim_compaction_drop",
            watermark: 1,
            recordedAt: "2026-04-08T03:02:00.000Z",
            sourceTaskId: "task_profile_graph_redacted_claim_compaction_drop",
            sourceFingerprint: "fingerprint_profile_graph_redacted_claim_compaction_drop",
            mutationEnvelopeHash: null,
            observationIds: [],
            claimIds: ["claim_profile_graph_redacted_claim_compaction_drop"],
            eventIds: [],
            redactionState: "redacted"
          },
          {
            journalEntryId: "journal_profile_graph_redacted_claim_compaction_keep",
            watermark: 2,
            recordedAt: "2026-04-08T03:05:00.000Z",
            sourceTaskId: "task_profile_graph_redacted_claim_compaction_keep",
            sourceFingerprint: "fingerprint_profile_graph_redacted_claim_compaction_keep",
            mutationEnvelopeHash: null,
            observationIds: [],
            claimIds: ["claim_profile_graph_redacted_claim_compaction_keep"],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 2048,
        maxClaimCount: 1,
        maxEventCount: 1024,
        maxJournalEntries: 1
      }
    }
  });

  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [3]
  );
  assert.deepEqual(
    normalized.graph.claims.map((claim) => claim.payload.claimId),
    ["claim_profile_graph_redacted_claim_compaction_keep"]
  );
  assert.equal(normalized.graph.compaction.snapshotWatermark, 2);
  assert.equal(normalized.graph.compaction.lastCompactedAt, "2026-04-08T03:15:00.000Z");
});

test("normalizeProfileMemoryState does not let source-tier-invalid retained claims pin observations or claim retention after journal compaction", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-06T02:20:00.000Z",
    graph: {
      updatedAt: "2026-04-06T02:20:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_invalid_source_retention_old",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_invalid_source_retention_old",
          sourceFingerprint: "fingerprint_profile_graph_invalid_source_retention_old",
          sourceTier: "assistant_inference",
          assertedAt: "2026-04-06T01:00:00.000Z",
          observedAt: "2026-04-06T01:00:00.000Z",
          timePrecision: "instant",
          timeSource: "inferred",
          entityRefIds: []
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_invalid_source_retention_new",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Ava",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_invalid_source_retention_new",
          sourceFingerprint: "fingerprint_profile_graph_invalid_source_retention_new",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-06T01:05:00.000Z",
          observedAt: "2026-04-06T01:05:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: []
        })
      ],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_invalid_source_retention_old",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Avery",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_invalid_source_retention_old",
          sourceFingerprint: "fingerprint_profile_graph_invalid_source_retention_old",
          sourceTier: "assistant_inference",
          assertedAt: "2026-04-06T01:00:00.000Z",
          validFrom: "2026-04-06T01:00:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "inferred",
          derivedFromObservationIds: ["observation_profile_graph_invalid_source_retention_old"],
          projectionSourceIds: ["fact_profile_graph_invalid_source_retention_old"],
          entityRefIds: [],
          active: true
        }),
        createGraphClaimEnvelope({
          claimId: "claim_profile_graph_invalid_source_retention_new",
          stableRefId: null,
          family: "identity.preferred_name",
          normalizedKey: "identity.preferred_name",
          normalizedValue: "Ava",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_invalid_source_retention_new",
          sourceFingerprint: "fingerprint_profile_graph_invalid_source_retention_new",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-06T01:05:00.000Z",
          validFrom: "2026-04-06T01:05:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_invalid_source_retention_new"],
          projectionSourceIds: ["fact_profile_graph_invalid_source_retention_new"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 3,
        entries: [
          {
            journalEntryId: "journal_profile_graph_invalid_source_retention_1",
            watermark: 1,
            recordedAt: "2026-04-06T01:00:00.000Z",
            sourceTaskId: "task_profile_graph_invalid_source_retention_old",
            sourceFingerprint: "fingerprint_profile_graph_invalid_source_retention_old",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_invalid_source_retention_old"],
            claimIds: ["claim_profile_graph_invalid_source_retention_old"],
            eventIds: [],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_invalid_source_retention_2",
            watermark: 2,
            recordedAt: "2026-04-06T01:05:00.000Z",
            sourceTaskId: "task_profile_graph_invalid_source_retention_new",
            sourceFingerprint: "fingerprint_profile_graph_invalid_source_retention_new",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_graph_invalid_source_retention_new"],
            claimIds: ["claim_profile_graph_invalid_source_retention_new"],
            eventIds: [],
            redactionState: "not_requested"
          }
        ]
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 1,
        maxClaimCount: 1,
        maxEventCount: 1024,
        maxJournalEntries: 1
      }
    }
  });

  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [2]
  );
  assert.deepEqual(
    normalized.graph.claims.map((claim) => claim.payload.claimId),
    ["claim_profile_graph_invalid_source_retention_new"]
  );
  assert.deepEqual(
    normalized.graph.observations.map((observation) => observation.payload.observationId),
    ["observation_profile_graph_invalid_source_retention_new"]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.claimIds,
    ["claim_profile_graph_invalid_source_retention_new"]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.observationIds,
    ["observation_profile_graph_invalid_source_retention_new"]
  );
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
    "claim_profile_graph_invalid_source_retention_new"
  );
  assert.equal(normalized.graph.compaction.snapshotWatermark, 1);
  assert.equal(normalized.graph.compaction.lastCompactedAt, "2026-04-06T02:20:00.000Z");
});

test("normalizeProfileMemoryState compacts terminal events after journal retention trims the replay window", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-03T22:30:00.000Z",
    graph: {
      updatedAt: "2026-04-03T22:30:00.000Z",
      observations: [],
      claims: [],
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_compaction_1",
          stableRefId: null,
          family: "episode.candidate",
          title: "Owen fell down",
          summary: "Owen fell down and later recovered.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_compaction_1",
          sourceFingerprint: "fingerprint_profile_graph_event_compaction_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T21:21:00.000Z",
          observedAt: "2026-04-03T21:21:00.000Z",
          validFrom: "2026-04-03T21:21:00.000Z",
          validTo: "2026-04-03T21:25:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["episode_profile_graph_compaction_1"],
          entityRefIds: ["entity_owen"]
        }),
        createGraphEventEnvelope({
          eventId: "event_profile_graph_compaction_2",
          stableRefId: null,
          family: "episode.candidate",
          title: "Jordan lost keys",
          summary: "Jordan lost keys and later found them.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_compaction_2",
          sourceFingerprint: "fingerprint_profile_graph_event_compaction_2",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T21:22:00.000Z",
          observedAt: "2026-04-03T21:22:00.000Z",
          validFrom: "2026-04-03T21:22:00.000Z",
          validTo: "2026-04-03T21:26:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["episode_profile_graph_compaction_2"],
          entityRefIds: ["entity_jordan"]
        }),
        createGraphEventEnvelope({
          eventId: "event_profile_graph_compaction_3",
          stableRefId: null,
          family: "episode.candidate",
          title: "Milo missed the train",
          summary: "Milo missed the train and later made it home.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_compaction_3",
          sourceFingerprint: "fingerprint_profile_graph_event_compaction_3",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-03T21:23:00.000Z",
          observedAt: "2026-04-03T21:23:00.000Z",
          validFrom: "2026-04-03T21:23:00.000Z",
          validTo: "2026-04-03T21:27:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["episode_profile_graph_compaction_3"],
          entityRefIds: ["entity_milo"]
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 4,
        entries: [
          {
            journalEntryId: "journal_profile_graph_event_compaction_1",
            watermark: 1,
            recordedAt: "2026-04-03T21:21:00.000Z",
            sourceTaskId: "task_profile_graph_event_compaction_1",
            sourceFingerprint: "fingerprint_profile_graph_event_compaction_1",
            mutationEnvelopeHash: null,
            observationIds: [],
            claimIds: [],
            eventIds: ["event_profile_graph_compaction_1"],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_event_compaction_2",
            watermark: 2,
            recordedAt: "2026-04-03T21:22:00.000Z",
            sourceTaskId: "task_profile_graph_event_compaction_2",
            sourceFingerprint: "fingerprint_profile_graph_event_compaction_2",
            mutationEnvelopeHash: null,
            observationIds: [],
            claimIds: [],
            eventIds: ["event_profile_graph_compaction_2"],
            redactionState: "not_requested"
          },
          {
            journalEntryId: "journal_profile_graph_event_compaction_3",
            watermark: 3,
            recordedAt: "2026-04-03T21:23:00.000Z",
            sourceTaskId: "task_profile_graph_event_compaction_3",
            sourceFingerprint: "fingerprint_profile_graph_event_compaction_3",
            mutationEnvelopeHash: null,
            observationIds: [],
            claimIds: [],
            eventIds: ["event_profile_graph_compaction_3"],
            redactionState: "not_requested"
          }
        ]
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 2048,
        maxClaimCount: 2048,
        maxEventCount: 1,
        maxJournalEntries: 1
      }
    }
  });

  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [3]
  );
  assert.deepEqual(
    normalized.graph.events.map((event) => event.payload.eventId),
    ["event_profile_graph_compaction_3"]
  );
  assert.equal(normalized.graph.compaction.snapshotWatermark, 2);
  assert.equal(normalized.graph.compaction.lastCompactedAt, "2026-04-03T22:30:00.000Z");
});

test("normalizeProfileMemoryState compacts redacted events after journal retention trims their last replay protection", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-08T02:30:00.000Z",
    graph: {
      updatedAt: "2026-04-08T02:30:00.000Z",
      observations: [],
      claims: [],
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_redacted_event_compaction_drop",
          stableRefId: null,
          family: "episode.candidate",
          title: "[redacted episode]",
          summary: "[redacted episode details]",
          redactionState: "redacted",
          redactedAt: "2026-04-08T02:10:00.000Z",
          sensitive: true,
          sourceTaskId: "task_profile_graph_redacted_event_compaction_drop",
          sourceFingerprint: "fingerprint_profile_graph_redacted_event_compaction_drop",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-08T02:00:00.000Z",
          observedAt: "2026-04-08T02:00:00.000Z",
          validFrom: "2026-04-08T02:00:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["episode_profile_graph_redacted_event_compaction_drop"],
          entityRefIds: []
        }),
        createGraphEventEnvelope({
          eventId: "event_profile_graph_redacted_event_compaction_keep",
          stableRefId: null,
          family: "episode.candidate",
          title: "Resolved follow-up",
          summary: "The retained journal still covers this terminal event.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_redacted_event_compaction_keep",
          sourceFingerprint: "fingerprint_profile_graph_redacted_event_compaction_keep",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-08T02:05:00.000Z",
          observedAt: "2026-04-08T02:05:00.000Z",
          validFrom: "2026-04-08T02:05:00.000Z",
          validTo: "2026-04-08T02:12:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["episode_profile_graph_redacted_event_compaction_keep"],
          entityRefIds: []
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 3,
        entries: [
          {
            journalEntryId: "journal_profile_graph_redacted_event_compaction_drop",
            watermark: 1,
            recordedAt: "2026-04-08T02:10:00.000Z",
            sourceTaskId: "task_profile_graph_redacted_event_compaction_drop",
            sourceFingerprint: "fingerprint_profile_graph_redacted_event_compaction_drop",
            mutationEnvelopeHash: null,
            observationIds: [],
            claimIds: [],
            eventIds: ["event_profile_graph_redacted_event_compaction_drop"],
            redactionState: "redacted"
          },
          {
            journalEntryId: "journal_profile_graph_redacted_event_compaction_keep",
            watermark: 2,
            recordedAt: "2026-04-08T02:12:00.000Z",
            sourceTaskId: "task_profile_graph_redacted_event_compaction_keep",
            sourceFingerprint: "fingerprint_profile_graph_redacted_event_compaction_keep",
            mutationEnvelopeHash: null,
            observationIds: [],
            claimIds: [],
            eventIds: ["event_profile_graph_redacted_event_compaction_keep"],
            redactionState: "not_requested"
          }
        ]
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 2048,
        maxClaimCount: 2048,
        maxEventCount: 1,
        maxJournalEntries: 1
      }
    }
  });

  assert.deepEqual(
    normalized.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [2]
  );
  assert.deepEqual(
    normalized.graph.events.map((event) => event.payload.eventId),
    ["event_profile_graph_redacted_event_compaction_keep"]
  );
  assert.equal(normalized.graph.compaction.snapshotWatermark, 1);
  assert.equal(normalized.graph.compaction.lastCompactedAt, "2026-04-08T02:30:00.000Z");
});

test("normalizeProfileMemoryState does not let orphaned retained active events mint replay markers or pin retention", () => {
  const validEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: "episode_profile_graph_event_surface_valid" }).slice(0, 24)}`;
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-07T02:20:00.000Z",
    episodes: [
      {
        id: "episode_profile_graph_event_surface_valid",
        title: "Owen fall situation",
        summary: "Owen fell down and the outcome stayed unresolved.",
        status: "unresolved",
        sourceTaskId: "task_profile_graph_event_surface_valid_episode",
        source: "user_input_pattern.episode_candidate",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        confidence: 0.9,
        observedAt: "2026-04-07T02:11:00.000Z",
        lastMentionedAt: "2026-04-07T02:11:00.000Z",
        lastUpdatedAt: "2026-04-07T02:11:00.000Z",
        resolvedAt: null,
        entityRefs: ["entity_owen"],
        openLoopRefs: [],
        tags: []
      }
    ],
    graph: {
      updatedAt: "2026-04-07T02:20:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_event_surface_orphaned",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.orphaned",
          normalizedValue: "Owen mentioned an older unresolved thread.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_surface_orphaned_observation",
          sourceFingerprint: "fingerprint_profile_graph_event_surface_orphaned_observation",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-07T02:09:00.000Z",
          observedAt: "2026-04-07T02:09:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_owen"]
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_event_surface_valid",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.valid",
          normalizedValue: "Owen still needs a follow-up.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_surface_valid_observation",
          sourceFingerprint: "fingerprint_profile_graph_event_surface_valid_observation",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-07T02:11:00.000Z",
          observedAt: "2026-04-07T02:11:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_owen"]
        })
      ],
      claims: [],
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_event_surface_orphaned",
          stableRefId: null,
          family: "episode.candidate",
          title: "Orphaned episode",
          summary: "An old unresolved episode lost its canonical source.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_surface_orphaned",
          sourceFingerprint: "fingerprint_profile_graph_event_surface_orphaned",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-07T02:09:00.000Z",
          observedAt: "2026-04-07T02:09:00.000Z",
          validFrom: "2026-04-07T02:09:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_event_surface_orphaned"],
          projectionSourceIds: ["episode_profile_graph_event_surface_missing"],
          entityRefIds: ["entity_owen"]
          }),
          createGraphEventEnvelope({
            eventId: validEventId,
            stableRefId: null,
          family: "episode.candidate",
          title: "Valid episode",
          summary: "A surviving unresolved episode still exists.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_surface_valid",
          sourceFingerprint: "fingerprint_profile_graph_event_surface_valid",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-07T02:11:00.000Z",
          observedAt: "2026-04-07T02:11:00.000Z",
          validFrom: "2026-04-07T02:11:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_event_surface_valid"],
          projectionSourceIds: ["episode_profile_graph_event_surface_valid"],
          entityRefIds: ["entity_owen"]
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 1,
        maxClaimCount: 2048,
        maxEventCount: 1,
        maxJournalEntries: 2
      }
    }
  });

  assert.deepEqual(
    normalized.graph.events.map((event) => event.payload.eventId),
    [validEventId]
  );
  assert.deepEqual(
    normalized.graph.observations.map((observation) => observation.payload.observationId),
    ["observation_profile_graph_event_surface_valid"]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.eventIds,
    [validEventId]
  );
  assert.equal(
    normalized.graph.mutationJournal.entries[0]?.sourceFingerprint?.startsWith(
      "graph_event_replay_backfill_"
    ),
    true
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[1]?.observationIds,
    ["observation_profile_graph_event_surface_valid"]
  );
  assert.equal(
    normalized.graph.mutationJournal.entries[1]?.sourceFingerprint?.startsWith(
      "graph_observation_replay_backfill_"
    ),
    true
  );
  assert.equal(
    normalized.graph.mutationJournal.entries.some((entry) =>
      entry.eventIds.includes("event_profile_graph_event_surface_orphaned")
    ),
    false
  );
  assert.equal(
    normalized.graph.mutationJournal.entries.some((entry) =>
      entry.observationIds.includes("observation_profile_graph_event_surface_orphaned")
    ),
    false
  );
  assert.equal(normalized.graph.compaction.snapshotWatermark, 0);
  assert.equal(normalized.graph.compaction.lastCompactedAt, "2026-04-07T02:20:00.000Z");
});

test("normalizeProfileMemoryState does not let source-tier-invalid retained active events mint replay markers or pin retention", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-07T03:20:00.000Z",
    graph: {
      updatedAt: "2026-04-07T03:20:00.000Z",
      observations: [
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_event_source_tier_invalid",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.invalid_event_source",
          normalizedValue: "Owen mentioned an untrusted structured episode candidate.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_source_tier_invalid_observation",
          sourceFingerprint: "fingerprint_profile_graph_event_source_tier_invalid_observation",
          sourceTier: "validated_structured_candidate",
          assertedAt: "2026-04-07T03:09:00.000Z",
          observedAt: "2026-04-07T03:09:00.000Z",
          timePrecision: "instant",
          timeSource: "asserted_at",
          entityRefIds: ["entity_owen"]
        }),
        createGraphObservationEnvelope({
          observationId: "observation_profile_graph_event_source_tier_valid",
          stableRefId: null,
          family: "contact.context",
          normalizedKey: "contact.owen.context.valid_event_source",
          normalizedValue: "Owen still needs a real follow-up.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_source_tier_valid_observation",
          sourceFingerprint: "fingerprint_profile_graph_event_source_tier_valid_observation",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-07T03:11:00.000Z",
          observedAt: "2026-04-07T03:11:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_owen"]
        })
      ],
      claims: [],
      events: [
        createGraphEventEnvelope({
          eventId: "event_profile_graph_event_source_tier_invalid",
          stableRefId: null,
          family: "episode.candidate",
          title: "Structured candidate that should stay quarantined",
          summary: "A retained structured episode candidate should remain audit-only.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_source_tier_invalid",
          sourceFingerprint: "fingerprint_profile_graph_event_source_tier_invalid",
          sourceTier: "validated_structured_candidate",
          assertedAt: "2026-04-07T03:09:00.000Z",
          observedAt: "2026-04-07T03:09:00.000Z",
          validFrom: "2026-04-07T03:09:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "asserted_at",
          derivedFromObservationIds: ["observation_profile_graph_event_source_tier_invalid"],
          projectionSourceIds: [],
          entityRefIds: ["entity_owen"]
        }),
        createGraphEventEnvelope({
          eventId: "event_profile_graph_event_source_tier_valid",
          stableRefId: null,
          family: "episode.candidate",
          title: "Valid explicit candidate",
          summary: "A retained explicit episode candidate should stay active.",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_graph_event_source_tier_valid",
          sourceFingerprint: "fingerprint_profile_graph_event_source_tier_valid",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-07T03:11:00.000Z",
          observedAt: "2026-04-07T03:11:00.000Z",
          validFrom: "2026-04-07T03:11:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_graph_event_source_tier_valid"],
          projectionSourceIds: [],
          entityRefIds: ["entity_owen"]
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      compaction: {
        schemaVersion: "v1",
        snapshotWatermark: 0,
        lastCompactedAt: null,
        maxObservationCount: 1,
        maxClaimCount: 2048,
        maxEventCount: 1,
        maxJournalEntries: 2
      }
    }
  });

  assert.deepEqual(
    normalized.graph.events.map((event) => event.payload.eventId),
    ["event_profile_graph_event_source_tier_valid"]
  );
  assert.deepEqual(
    normalized.graph.observations.map((observation) => observation.payload.observationId),
    ["observation_profile_graph_event_source_tier_valid"]
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[0]?.eventIds,
    ["event_profile_graph_event_source_tier_valid"]
  );
  assert.equal(
    normalized.graph.mutationJournal.entries[0]?.sourceFingerprint?.startsWith(
      "graph_event_replay_backfill_"
    ),
    true
  );
  assert.deepEqual(
    normalized.graph.mutationJournal.entries[1]?.observationIds,
    ["observation_profile_graph_event_source_tier_valid"]
  );
  assert.equal(
    normalized.graph.mutationJournal.entries[1]?.sourceFingerprint?.startsWith(
      "graph_observation_replay_backfill_"
    ),
    true
  );
  assert.equal(
    normalized.graph.mutationJournal.entries.some((entry) =>
      entry.eventIds.includes("event_profile_graph_event_source_tier_invalid")
    ),
    false
  );
  assert.equal(
    normalized.graph.mutationJournal.entries.some((entry) =>
      entry.observationIds.includes("observation_profile_graph_event_source_tier_invalid")
    ),
    false
  );
  assert.equal(normalized.graph.compaction.snapshotWatermark, 0);
  assert.equal(normalized.graph.compaction.lastCompactedAt, "2026-04-07T03:20:00.000Z");
});

test("normalizeProfileMemoryState canonicalizes retained flat-fact timestamps and repairs malformed fact lifecycle boundaries", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T23:30:00.000Z",
    facts: [
      {
        id: "fact_profile_state_timestamp_normalization_active",
        key: "employment.current",
        value: "Lantern",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_state_timestamp_normalization_active",
        source: "user_input_pattern.work_at",
        observedAt: " 2026-04-04T18:00:00-05:00 ",
        confirmedAt: "   ",
        supersededAt: " 2026-04-04T23:59:00.000Z ",
        lastUpdatedAt: " 2026-04-04T23:10:00+00:00 "
      },
      {
        id: "fact_profile_state_timestamp_normalization_superseded",
        key: "employment.current",
        value: "Northstar",
        sensitive: false,
        status: "superseded",
        confidence: 0.7,
        sourceTaskId: "task_profile_state_timestamp_normalization_superseded",
        source: "user_input_pattern.job_is",
        observedAt: " 2026-04-04T17:30:00-05:00 ",
        confirmedAt: " 2026-04-04T22:00:00+00:00 ",
        supersededAt: "   ",
        lastUpdatedAt: " 2026-04-04T23:20:00+00:00 "
      }
    ]
  });

  const activeFact = normalized.facts.find(
    (fact) => fact.id === "fact_profile_state_timestamp_normalization_active"
  );
  const supersededFact = normalized.facts.find(
    (fact) => fact.id === "fact_profile_state_timestamp_normalization_superseded"
  );

  assert.equal(activeFact?.observedAt, "2026-04-04T23:00:00.000Z");
  assert.equal(activeFact?.lastUpdatedAt, "2026-04-04T23:10:00.000Z");
  assert.equal(activeFact?.confirmedAt, "2026-04-04T23:10:00.000Z");
  assert.equal(activeFact?.supersededAt, null);
  assert.equal(supersededFact?.observedAt, "2026-04-04T22:30:00.000Z");
  assert.equal(supersededFact?.lastUpdatedAt, "2026-04-04T23:20:00.000Z");
  assert.equal(supersededFact?.confirmedAt, "2026-04-04T22:00:00.000Z");
  assert.equal(supersededFact?.supersededAt, "2026-04-04T23:20:00.000Z");
});

test("normalizeProfileMemoryState canonicalizes retained flat-fact semantic and provenance strings", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T23:45:00.000Z",
    facts: [
      {
        id: " fact_profile_state_string_normalization ",
        key: " Preferred.Name ",
        value: "  Avery   Quinn  ",
        sensitive: false,
        status: "confirmed",
        confidence: 0.9,
        sourceTaskId: " task_profile_state_string_normalization ",
        source: " User_Input_Pattern.Name_Phrase ",
        observedAt: "2026-04-04T23:40:00.000Z",
        confirmedAt: "2026-04-04T23:41:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-04T23:42:00.000Z"
      }
    ]
  });

  assert.equal(normalized.facts[0]?.id, "fact_profile_state_string_normalization");
  assert.equal(normalized.facts[0]?.key, "identity.preferred_name");
  assert.equal(normalized.facts[0]?.value, "Avery Quinn");
  assert.equal(
    normalized.facts[0]?.sourceTaskId,
    "task_profile_state_string_normalization"
  );
  assert.equal(normalized.facts[0]?.source, "user_input_pattern.name_phrase");
});

test("normalizeProfileMemoryState canonicalizes retained flat-fact ids and drops blank ids", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T23:47:30.000Z",
    facts: [
      {
        id: " fact_profile_state_id_normalization ",
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: false,
        status: "confirmed",
        confidence: 0.9,
        sourceTaskId: "task_profile_state_id_normalization",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-04T23:40:00.000Z",
        confirmedAt: "2026-04-04T23:41:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-04T23:42:00.000Z"
      },
      {
        id: "   ",
        key: "identity.preferred_name",
        value: "DropMe",
        sensitive: false,
        status: "confirmed",
        confidence: 0.5,
        sourceTaskId: "task_profile_state_blank_id",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-04T23:39:00.000Z",
        confirmedAt: "2026-04-04T23:39:30.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-04T23:39:45.000Z"
      }
    ]
  });

  assert.equal(normalized.facts.length, 1);
  assert.equal(normalized.facts[0]?.id, "fact_profile_state_id_normalization");
});

test("normalizeProfileMemoryState dedupes retained flat facts by canonical fact id", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T00:03:00.000Z",
    facts: [
      {
        id: " fact_profile_state_duplicate_id ",
        key: " identity.preferred_name ",
        value: " Avery ",
        sensitive: false,
        status: "uncertain",
        confidence: 0.6,
        sourceTaskId: " task_profile_state_duplicate_id_old ",
        source: " User_Input_Pattern.Name_Phrase ",
        observedAt: "2026-04-05T00:00:00.000Z",
        confirmedAt: null,
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:01:00.000Z"
      },
      {
        id: "fact_profile_state_duplicate_id",
        key: "identity.preferred_name",
        value: "Avery Quinn",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_state_duplicate_id_new",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-05T00:01:30.000Z",
        confirmedAt: "2026-04-05T00:02:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:02:30.000Z"
      }
    ]
  });

  assert.equal(normalized.facts.length, 1);
  assert.equal(normalized.facts[0]?.id, "fact_profile_state_duplicate_id");
  assert.equal(normalized.facts[0]?.value, "Avery Quinn");
  assert.equal(
    normalized.facts[0]?.sourceTaskId,
    "task_profile_state_duplicate_id_new"
  );
  assert.equal(normalized.facts[0]?.status, "confirmed");
  assert.equal(normalized.facts[0]?.confidence, 0.95);
});

test("normalizeProfileMemoryState repairs semantic-duplicate retained active facts with different ids", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T00:14:00.000Z",
    facts: [
      {
        id: "fact_profile_state_semantic_duplicate_confirmed",
        key: " employment.current ",
        value: " Lantern ",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_state_semantic_duplicate_confirmed",
        source: " user_input_pattern.work_at ",
        observedAt: "2026-04-05T00:10:00.000Z",
        confirmedAt: "2026-04-05T00:11:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:12:00.000Z",
        mutationAudit: {
          classifier: "commitment_signal",
          category: "GENERIC_RESOLUTION",
          confidenceTier: "HIGH",
          matchedRuleId: "commitment_signal_v1_semantic_duplicate_state",
          rulepackVersion: "CommitmentSignalRulepackV1",
          conflict: false
        }
      },
      {
        id: "fact_profile_state_semantic_duplicate_uncertain",
        key: "employment.current",
        value: "Lantern",
        sensitive: true,
        status: "uncertain",
        confidence: 0.6,
        sourceTaskId: "task_profile_state_semantic_duplicate_uncertain",
        source: "user_input_pattern.work_at",
        observedAt: "2026-04-05T00:08:00.000Z",
        confirmedAt: null,
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:13:00.000Z"
      }
    ]
  });

  const activeFacts = normalized.facts.filter(
    (fact) => fact.status !== "superseded" && fact.supersededAt === null
  );
  const supersededFact = normalized.facts.find(
    (fact) => fact.id === "fact_profile_state_semantic_duplicate_uncertain"
  );

  assert.equal(normalized.facts.length, 2);
  assert.equal(activeFacts.length, 1);
  assert.equal(activeFacts[0]?.id, "fact_profile_state_semantic_duplicate_confirmed");
  assert.equal(activeFacts[0]?.status, "confirmed");
  assert.equal(activeFacts[0]?.sensitive, true);
  assert.equal(activeFacts[0]?.observedAt, "2026-04-05T00:08:00.000Z");
  assert.equal(activeFacts[0]?.lastUpdatedAt, "2026-04-05T00:13:00.000Z");
  assert.equal(
    activeFacts[0]?.mutationAudit?.matchedRuleId,
    "commitment_signal_v1_semantic_duplicate_state"
  );
  assert.equal(supersededFact?.status, "superseded");
  assert.equal(supersededFact?.supersededAt, "2026-04-05T00:13:00.000Z");
});

test("normalizeProfileMemoryState repairs replace-family retained active fact conflicts with different values", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T00:20:00.000Z",
    facts: [
      {
        id: "fact_profile_state_replace_conflict_old",
        key: " identity.preferred_name ",
        value: " Avery ",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_state_replace_conflict_old",
        source: " user_input_pattern.name_phrase ",
        observedAt: "2026-04-05T00:10:00.000Z",
        confirmedAt: "2026-04-05T00:11:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:12:00.000Z"
      },
      {
        id: "fact_profile_state_replace_conflict_new",
        key: "identity.preferred_name",
        value: "Ava",
        sensitive: false,
        status: "uncertain",
        confidence: 0.6,
        sourceTaskId: "task_profile_state_replace_conflict_new",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-05T00:13:00.000Z",
        confirmedAt: null,
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:14:00.000Z"
      }
    ]
  });

  const activeFacts = normalized.facts.filter(
    (fact) => fact.status !== "superseded" && fact.supersededAt === null
  );
  const supersededFact = normalized.facts.find(
    (fact) => fact.id === "fact_profile_state_replace_conflict_old"
  );

  assert.equal(normalized.facts.length, 2);
  assert.equal(activeFacts.length, 1);
  assert.equal(activeFacts[0]?.id, "fact_profile_state_replace_conflict_new");
  assert.equal(activeFacts[0]?.key, "identity.preferred_name");
  assert.equal(activeFacts[0]?.value, "Ava");
  assert.equal(activeFacts[0]?.status, "uncertain");
  assert.equal(supersededFact?.status, "superseded");
  assert.equal(supersededFact?.supersededAt, "2026-04-05T00:14:00.000Z");
});

test("normalizeProfileMemoryState repairs preserve-prior retained active fact conflicts with multiple confirmed winners", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T00:30:00.000Z",
    facts: [
      {
        id: "fact_profile_state_preserve_conflict_old",
        key: " employment.current ",
        value: " Pro-Green ",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_state_preserve_conflict_old",
        source: " user_input_pattern.work_at ",
        observedAt: "2026-04-05T00:10:00.000Z",
        confirmedAt: "2026-04-05T00:11:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:12:00.000Z"
      },
      {
        id: "fact_profile_state_preserve_conflict_new",
        key: "employment.current",
        value: "Lantern",
        sensitive: false,
        status: "confirmed",
        confidence: 0.99,
        sourceTaskId: "task_profile_state_preserve_conflict_new",
        source: "user_input_pattern.work_at",
        observedAt: "2026-04-05T00:13:00.000Z",
        confirmedAt: "2026-04-05T00:14:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:15:00.000Z"
      }
    ]
  });

  const activeFacts = normalized.facts.filter(
    (fact) => fact.status !== "superseded" && fact.supersededAt === null
  );
  const confirmedFacts = activeFacts.filter((fact) => fact.status === "confirmed");
  const uncertainFacts = activeFacts.filter((fact) => fact.status === "uncertain");
  const downgradedFact = normalized.facts.find(
    (fact) => fact.id === "fact_profile_state_preserve_conflict_new"
  );

  assert.equal(normalized.facts.length, 2);
  assert.equal(activeFacts.length, 2);
  assert.equal(confirmedFacts.length, 1);
  assert.equal(uncertainFacts.length, 1);
  assert.equal(confirmedFacts[0]?.id, "fact_profile_state_preserve_conflict_old");
  assert.equal(confirmedFacts[0]?.key, "employment.current");
  assert.equal(confirmedFacts[0]?.value, "Pro-Green");
  assert.equal(downgradedFact?.status, "uncertain");
  assert.equal(downgradedFact?.confirmedAt, null);
  assert.equal(downgradedFact?.supersededAt, null);
  assert.equal(downgradedFact?.lastUpdatedAt, "2026-04-05T00:15:00.000Z");
});

test("normalizeProfileMemoryState repairs mixed-policy retained active fact conflicts into a live-upsert-valid shape", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T00:40:00.000Z",
    facts: [
      {
        id: "fact_profile_state_mixed_policy_pending",
        key: " followup.tax.filing ",
        value: " pending ",
        sensitive: false,
        status: "confirmed",
        confidence: 0.95,
        sourceTaskId: "task_profile_state_mixed_policy_pending",
        source: " user_input_pattern.my_is ",
        observedAt: "2026-04-05T00:10:00.000Z",
        confirmedAt: "2026-04-05T00:11:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:11:00.000Z"
      },
      {
        id: "fact_profile_state_mixed_policy_resolved",
        key: "followup.tax.filing",
        value: "resolved",
        sensitive: false,
        status: "confirmed",
        confidence: 0.99,
        sourceTaskId: "task_profile_state_mixed_policy_resolved",
        source: "user_input_pattern.followup_resolved",
        observedAt: "2026-04-05T00:12:00.000Z",
        confirmedAt: "2026-04-05T00:13:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:13:00.000Z"
      },
      {
        id: "fact_profile_state_mixed_policy_challenger",
        key: "followup.tax.filing",
        value: "waiting_on_refund",
        sensitive: false,
        status: "confirmed",
        confidence: 0.7,
        sourceTaskId: "task_profile_state_mixed_policy_challenger",
        source: "user_input_pattern.my_is",
        observedAt: "2026-04-05T00:14:00.000Z",
        confirmedAt: "2026-04-05T00:15:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:15:00.000Z"
      }
    ]
  });

  const activeFacts = normalized.facts.filter(
    (fact) => fact.status !== "superseded" && fact.supersededAt === null
  );
  const resolvedFact = normalized.facts.find(
    (fact) => fact.id === "fact_profile_state_mixed_policy_resolved"
  );
  const challengerFact = normalized.facts.find(
    (fact) => fact.id === "fact_profile_state_mixed_policy_challenger"
  );
  const supersededPendingFact = normalized.facts.find(
    (fact) => fact.id === "fact_profile_state_mixed_policy_pending"
  );

  assert.equal(normalized.facts.length, 3);
  assert.equal(activeFacts.length, 2);
  assert.equal(resolvedFact?.status, "confirmed");
  assert.equal(resolvedFact?.confirmedAt, "2026-04-05T00:13:00.000Z");
  assert.equal(challengerFact?.status, "uncertain");
  assert.equal(challengerFact?.confirmedAt, null);
  assert.equal(challengerFact?.supersededAt, null);
  assert.equal(supersededPendingFact?.status, "superseded");
  assert.equal(supersededPendingFact?.supersededAt, "2026-04-05T00:13:00.000Z");
});

test("normalizeProfileMemoryState suppresses preserve-prior graph current claims when only uncertain conflicting facts remain", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T00:40:00.000Z",
    facts: [
      {
        id: "fact_profile_state_preserve_no_winner_1",
        key: "employment.current",
        value: "Lantern",
        sensitive: false,
        status: "uncertain",
        confidence: 0.6,
        sourceTaskId: "task_profile_state_preserve_no_winner_1",
        source: "user_input_pattern.work_at",
        observedAt: "2026-04-05T00:10:00.000Z",
        confirmedAt: null,
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:11:00.000Z"
      },
      {
        id: "fact_profile_state_preserve_no_winner_2",
        key: "employment.current",
        value: "Northstar",
        sensitive: false,
        status: "uncertain",
        confidence: 0.7,
        sourceTaskId: "task_profile_state_preserve_no_winner_2",
        source: "user_input_pattern.job_is",
        observedAt: "2026-04-05T00:12:00.000Z",
        confirmedAt: null,
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:13:00.000Z"
      }
    ],
    graph: {
      updatedAt: "2026-04-05T00:39:00.000Z",
      observations: [],
      claims: [
        createGraphClaimEnvelope({
          claimId: "claim_profile_state_preserve_no_winner_stale",
          stableRefId: null,
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "OldCo",
          redactionState: "not_requested",
          redactedAt: null,
          sensitive: false,
          sourceTaskId: "task_profile_state_preserve_no_winner_stale",
          sourceFingerprint: "fingerprint_profile_state_preserve_no_winner_stale",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-04-05T00:00:00.000Z",
          validFrom: "2026-04-05T00:00:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: ["fact_profile_state_preserve_no_winner_stale"],
          entityRefIds: [],
          active: true
        })
      ],
      events: [],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 1,
        entries: []
      },
      indexes: {
        schemaVersion: "v1",
        byEntityRefId: {},
        byFamily: {},
        validityWindow: [],
        bySourceTier: {
          explicit_user_statement: [],
          validated_structured_candidate: [],
          reconciliation_or_projection: [],
          assistant_inference: []
        },
        activeClaimIds: []
      },
      readModel: {
        schemaVersion: "v1",
        watermark: 0,
        rebuiltAt: null,
        currentClaimIdsByKey: {},
        inventoryClaimIdsByFamily: {}
      }
    }
  });

  const activeClaims = normalized.graph.claims.filter((claim) => claim.payload.active);
  const closedClaim = normalized.graph.claims.find(
    (claim) => claim.payload.claimId === "claim_profile_state_preserve_no_winner_stale"
  );

  assert.equal(normalized.graph.observations.length, 2);
  assert.equal(activeClaims.length, 0);
  assert.equal(closedClaim?.payload.active, false);
  assert.equal(closedClaim?.payload.endedByClaimId, null);
  assert.equal(
    normalized.graph.readModel.currentClaimIdsByKey["employment.current"],
    undefined
  );
});

test("normalizeProfileMemoryState drops retained flat facts whose normalized key or value is blank", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T00:05:00.000Z",
    facts: [
      {
        id: "fact_profile_state_blank_semantics_keep",
        key: " identity.preferred_name ",
        value: " Avery ",
        sensitive: false,
        status: "confirmed",
        confidence: 0.9,
        sourceTaskId: "task_profile_state_blank_semantics_keep",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-05T00:00:00.000Z",
        confirmedAt: "2026-04-05T00:01:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:02:00.000Z"
      },
      {
        id: "fact_profile_state_blank_semantics_key_drop",
        key: " !!! ",
        value: "KeepMe",
        sensitive: false,
        status: "confirmed",
        confidence: 0.8,
        sourceTaskId: "task_profile_state_blank_semantics_key_drop",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-05T00:00:30.000Z",
        confirmedAt: "2026-04-05T00:01:30.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:02:30.000Z"
      },
      {
        id: "fact_profile_state_blank_semantics_value_drop",
        key: "identity.preferred_name",
        value: "   ",
        sensitive: false,
        status: "confirmed",
        confidence: 0.7,
        sourceTaskId: "task_profile_state_blank_semantics_value_drop",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-05T00:00:45.000Z",
        confirmedAt: "2026-04-05T00:01:45.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:02:45.000Z"
      }
    ]
  });

  assert.equal(normalized.facts.length, 1);
  assert.equal(normalized.facts[0]?.id, "fact_profile_state_blank_semantics_keep");
  assert.equal(normalized.facts[0]?.key, "identity.preferred_name");
  assert.equal(normalized.facts[0]?.value, "Avery");
});

test("normalizeProfileMemoryState drops retained flat facts whose required provenance normalizes blank", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T00:12:00.000Z",
    facts: [
      {
        id: "fact_profile_state_blank_provenance_keep",
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: false,
        status: "confirmed",
        confidence: 0.9,
        sourceTaskId: " task_profile_state_blank_provenance_keep ",
        source: " User_Input_Pattern.Name_Phrase ",
        observedAt: "2026-04-05T00:07:00.000Z",
        confirmedAt: "2026-04-05T00:08:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:09:00.000Z"
      },
      {
        id: "fact_profile_state_blank_provenance_task_drop",
        key: "identity.preferred_name",
        value: "DropTask",
        sensitive: false,
        status: "confirmed",
        confidence: 0.8,
        sourceTaskId: "   ",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-05T00:07:30.000Z",
        confirmedAt: "2026-04-05T00:08:30.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:09:30.000Z"
      },
      {
        id: "fact_profile_state_blank_provenance_source_drop",
        key: "identity.preferred_name",
        value: "DropSource",
        sensitive: false,
        status: "confirmed",
        confidence: 0.7,
        sourceTaskId: "task_profile_state_blank_provenance_source_drop",
        source: "   ",
        observedAt: "2026-04-05T00:07:45.000Z",
        confirmedAt: "2026-04-05T00:08:45.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:09:45.000Z"
      }
    ]
  });

  assert.equal(normalized.facts.length, 1);
  assert.equal(normalized.facts[0]?.id, "fact_profile_state_blank_provenance_keep");
  assert.equal(
    normalized.facts[0]?.sourceTaskId,
    "task_profile_state_blank_provenance_keep"
  );
  assert.equal(normalized.facts[0]?.source, "user_input_pattern.name_phrase");
});

test("normalizeProfileMemoryState drops retained flat facts whose source authority is quarantined", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T00:13:00.000Z",
    facts: [
      {
        id: "fact_profile_state_supported_current_source",
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: false,
        status: "confirmed",
        confidence: 0.9,
        sourceTaskId: "task_profile_state_supported_current_source",
        source: " user_input_pattern.name_phrase ",
        observedAt: "2026-04-05T00:08:00.000Z",
        confirmedAt: "2026-04-05T00:09:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:10:00.000Z"
      },
      {
        id: "fact_profile_state_supported_support_source",
        key: "employment.current",
        value: "Northstar",
        sensitive: false,
        status: "superseded",
        confidence: 0.5,
        sourceTaskId: "task_profile_state_supported_support_source",
        source: " user_input_pattern.work_at_historical ",
        observedAt: "2026-04-05T00:07:30.000Z",
        confirmedAt: "2026-04-05T00:08:30.000Z",
        supersededAt: "2026-04-05T00:09:30.000Z",
        lastUpdatedAt: "2026-04-05T00:10:30.000Z"
      },
      {
        id: "fact_profile_state_quarantined_source",
        key: "identity.preferred_name",
        value: "DropMe",
        sensitive: false,
        status: "confirmed",
        confidence: 0.7,
        sourceTaskId: "task_profile_state_quarantined_source",
        source: " user_input_pattern.preference_statement ",
        observedAt: "2026-04-05T00:08:45.000Z",
        confirmedAt: "2026-04-05T00:09:45.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:10:45.000Z"
      }
    ]
  });

  assert.equal(
    normalized.facts.some((fact) => fact.id === "fact_profile_state_supported_current_source"),
    true
  );
  assert.equal(
    normalized.facts.some((fact) => fact.id === "fact_profile_state_supported_support_source"),
    true
  );
  assert.equal(
    normalized.facts.some((fact) => fact.id === "fact_profile_state_quarantined_source"),
    false
  );
});

test("normalizeProfileMemoryState applies family sensitivity floors to retained flat facts", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T00:14:00.000Z",
    facts: [
      {
        id: "fact_profile_state_sensitive_floor_residence",
        key: " residence.current ",
        value: " Seattle ",
        sensitive: false,
        status: "confirmed",
        confidence: 0.9,
        sourceTaskId: "task_profile_state_sensitive_floor_residence",
        source: "user_input_pattern.residence",
        observedAt: "2026-04-05T00:10:00.000Z",
        confirmedAt: "2026-04-05T00:11:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:12:00.000Z"
      },
      {
        id: "fact_profile_state_sensitive_floor_identity",
        key: " identity.preferred_name ",
        value: " Avery ",
        sensitive: false,
        status: "confirmed",
        confidence: 0.8,
        sourceTaskId: "task_profile_state_sensitive_floor_identity",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-05T00:10:30.000Z",
        confirmedAt: "2026-04-05T00:11:30.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:12:30.000Z"
      }
    ]
  });

  const residenceFact = normalized.facts.find(
    (fact) => fact.id === "fact_profile_state_sensitive_floor_residence"
  );
  const identityFact = normalized.facts.find(
    (fact) => fact.id === "fact_profile_state_sensitive_floor_identity"
  );

  assert.equal(residenceFact?.key, "residence.current");
  assert.equal(residenceFact?.sensitive, true);
  assert.equal(identityFact?.key, "identity.preferred_name");
  assert.equal(identityFact?.sensitive, false);
});

test("normalizeProfileMemoryState clears retained mutation audit metadata when rule ids normalize blank", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T00:18:00.000Z",
    facts: [
      {
        id: "fact_profile_state_mutation_audit_keep",
        key: "followup.launch",
        value: "resolved",
        sensitive: false,
        status: "confirmed",
        confidence: 0.9,
        sourceTaskId: "task_profile_state_mutation_audit_keep",
        source: "user_input_pattern.followup_resolved",
        observedAt: "2026-04-05T00:15:00.000Z",
        confirmedAt: "2026-04-05T00:16:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:17:00.000Z",
        mutationAudit: {
          classifier: "commitment_signal",
          category: "GENERIC_RESOLUTION",
          confidenceTier: "HIGH",
          matchedRuleId: " commitment_signal_v1_user_input_generic_resolution ",
          rulepackVersion: " CommitmentSignalRulepackV1 ",
          conflict: false
        }
      },
      {
        id: "fact_profile_state_mutation_audit_drop",
        key: "followup.launch",
        value: "resolved",
        sensitive: false,
        status: "confirmed",
        confidence: 0.7,
        sourceTaskId: "task_profile_state_mutation_audit_drop",
        source: "user_input_pattern.followup_resolved",
        observedAt: "2026-04-05T00:14:00.000Z",
        confirmedAt: "2026-04-05T00:15:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:16:00.000Z",
        mutationAudit: {
          classifier: "commitment_signal",
          category: "GENERIC_RESOLUTION",
          confidenceTier: "MED",
          matchedRuleId: "   ",
          rulepackVersion: " CommitmentSignalRulepackV1 ",
          conflict: false
        }
      }
    ]
  });

  const keptFact = normalized.facts.find(
    (fact) => fact.id === "fact_profile_state_mutation_audit_keep"
  );
  const droppedFact = normalized.facts.find(
    (fact) => fact.id === "fact_profile_state_mutation_audit_drop"
  );

  assert.equal(
    keptFact?.mutationAudit?.matchedRuleId,
    "commitment_signal_v1_user_input_generic_resolution"
  );
  assert.equal(
    keptFact?.mutationAudit?.rulepackVersion,
    "CommitmentSignalRulepackV1"
  );
  assert.equal(droppedFact?.mutationAudit, undefined);
});

test("normalizeProfileMemoryState canonicalizes retained mutation audit enums before keeping audit metadata", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T00:21:00.000Z",
    facts: [
      {
        id: "fact_profile_state_mutation_audit_enum_normalization",
        key: "followup.launch",
        value: "resolved",
        sensitive: false,
        status: "confirmed",
        confidence: 0.9,
        sourceTaskId: "task_profile_state_mutation_audit_enum_normalization",
        source: "user_input_pattern.followup_resolved",
        observedAt: "2026-04-05T00:18:00.000Z",
        confirmedAt: "2026-04-05T00:19:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-05T00:20:00.000Z",
        mutationAudit: {
          classifier: " Commitment_Signal ",
          category: " generic_resolution ",
          confidenceTier: " high ",
          matchedRuleId: "commitment_signal_v1_user_input_generic_resolution",
          rulepackVersion: "CommitmentSignalRulepackV1",
          conflict: false
        }
      }
    ]
  });

  const fact = normalized.facts[0];
  assert.equal(fact?.mutationAudit?.classifier, "commitment_signal");
  assert.equal(fact?.mutationAudit?.category, "GENERIC_RESOLUTION");
  assert.equal(fact?.mutationAudit?.confidenceTier, "HIGH");
});

test("normalizeProfileMemoryState canonicalizes retained flat-fact status strings and drops unknown statuses", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T23:50:00.000Z",
    facts: [
      {
        id: "fact_profile_state_status_normalization_confirmed",
        key: "employment.current",
        value: "Lantern",
        sensitive: false,
        status: " Confirmed ",
        confidence: 0.95,
        sourceTaskId: "task_profile_state_status_normalization_confirmed",
        source: "user_input_pattern.work_at",
        observedAt: "2026-04-04T23:40:00.000Z",
        confirmedAt: "   ",
        supersededAt: null,
        lastUpdatedAt: "2026-04-04T23:41:00.000Z"
      },
      {
        id: "fact_profile_state_status_normalization_superseded",
        key: "employment.current",
        value: "Northstar",
        sensitive: false,
        status: " SUPERSEDED ",
        confidence: 0.7,
        sourceTaskId: "task_profile_state_status_normalization_superseded",
        source: "user_input_pattern.job_is",
        observedAt: "2026-04-04T23:39:00.000Z",
        confirmedAt: null,
        supersededAt: "   ",
        lastUpdatedAt: "2026-04-04T23:42:00.000Z"
      },
      {
        id: "fact_profile_state_status_normalization_invalid",
        key: "employment.current",
        value: "BadStatus",
        sensitive: false,
        status: " pending ",
        confidence: 0.5,
        sourceTaskId: "task_profile_state_status_normalization_invalid",
        source: "user_input_pattern.job_is",
        observedAt: "2026-04-04T23:38:00.000Z",
        confirmedAt: null,
        supersededAt: null,
        lastUpdatedAt: "2026-04-04T23:43:00.000Z"
      }
    ]
  });

  const confirmedFact = normalized.facts.find(
    (fact) => fact.id === "fact_profile_state_status_normalization_confirmed"
  );
  const supersededFact = normalized.facts.find(
    (fact) => fact.id === "fact_profile_state_status_normalization_superseded"
  );

  assert.equal(normalized.facts.length, 2);
  assert.equal(confirmedFact?.status, "confirmed");
  assert.equal(confirmedFact?.confirmedAt, "2026-04-04T23:41:00.000Z");
  assert.equal(supersededFact?.status, "superseded");
  assert.equal(supersededFact?.supersededAt, "2026-04-04T23:42:00.000Z");
  assert.equal(
    normalized.facts.some((fact) => fact.id === "fact_profile_state_status_normalization_invalid"),
    false
  );
});

test("normalizeProfileMemoryState fail-closes malformed retained flat-fact confidence on the compatibility lane", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-04T23:55:00.000Z",
    facts: [
      {
        id: "fact_profile_state_confidence_normalization",
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: false,
        status: "confirmed",
        confidence: 99,
        sourceTaskId: "task_profile_state_confidence_normalization",
        source: "user_input_pattern.name_phrase",
        observedAt: "2026-04-04T23:50:00.000Z",
        confirmedAt: "2026-04-04T23:51:00.000Z",
        supersededAt: null,
        lastUpdatedAt: "2026-04-04T23:52:00.000Z"
      }
    ]
  });

  assert.equal(normalized.facts[0]?.confidence, 0);
});

test("normalizeProfileMemoryState canonicalizes retained ingest receipts for reload-safe idempotency", () => {
  const expectedReceiptKey = buildProfileMemoryIngestReceiptKey({
    sourceSurface: "conversation_profile_input",
    turnId: "turn_profile_state_receipt_normalization",
    sourceFingerprint: "fingerprint_profile_state_receipt_normalization"
  });
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T00:15:00.000Z",
    ingestReceipts: [
      {
        receiptKey: " receipt_profile_state_receipt_raw ",
        turnId: " turn_profile_state_receipt_normalization ",
        sourceFingerprint: " fingerprint_profile_state_receipt_normalization ",
        sourceTaskId: " task_profile_state_receipt_normalization ",
        recordedAt: " 2026-04-05T00:05:00+00:00 "
      }
    ]
  });

  assert.equal(normalized.ingestReceipts[0]?.receiptKey, expectedReceiptKey);
  assert.equal(normalized.ingestReceipts[0]?.turnId, "turn_profile_state_receipt_normalization");
  assert.equal(
    normalized.ingestReceipts[0]?.sourceFingerprint,
    "fingerprint_profile_state_receipt_normalization"
  );
  assert.equal(
    normalized.ingestReceipts[0]?.sourceTaskId,
    "task_profile_state_receipt_normalization"
  );
  assert.equal(normalized.ingestReceipts[0]?.recordedAt, "2026-04-05T00:05:00.000Z");
  assert.ok(findProfileMemoryIngestReceipt(normalized, {
    sourceSurface: "conversation_profile_input",
    turnId: "turn_profile_state_receipt_normalization",
    sourceFingerprint: "fingerprint_profile_state_receipt_normalization"
  }));
});

test("normalizeProfileMemoryState dedupes and caps retained ingest receipts after canonicalization", () => {
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T00:30:00.000Z",
    ingestReceipts: [
      ...Array.from({ length: MAX_PROFILE_MEMORY_INGEST_RECEIPTS + 1 }, (_, index) => ({
        receiptKey: ` receipt_profile_state_receipt_cap_${index} `,
        turnId: ` turn_profile_state_receipt_cap_${index} `,
        sourceFingerprint: ` fingerprint_profile_state_receipt_cap_${index} `,
        sourceTaskId: ` task_profile_state_receipt_cap_${index} `,
        recordedAt:
          `2026-04-05T${String(Math.floor(index / 60)).padStart(2, "0")}:` +
          `${String(index % 60).padStart(2, "0")}:00.000Z`
      })),
      {
        receiptKey: " receipt_profile_state_receipt_cap_duplicate ",
        turnId: " turn_profile_state_receipt_cap_1 ",
        sourceFingerprint: " fingerprint_profile_state_receipt_cap_1 ",
        sourceTaskId: " task_profile_state_receipt_cap_duplicate_latest ",
        recordedAt: "2026-04-05T23:59:00.000Z"
      }
    ]
  });

  const duplicateReceiptKey = buildProfileMemoryIngestReceiptKey({
    sourceSurface: "conversation_profile_input",
    turnId: "turn_profile_state_receipt_cap_1",
    sourceFingerprint: "fingerprint_profile_state_receipt_cap_1"
  });

  assert.equal(normalized.ingestReceipts.length, MAX_PROFILE_MEMORY_INGEST_RECEIPTS);
  assert.equal(
    normalized.ingestReceipts.some((receipt) => receipt.turnId === "turn_profile_state_receipt_cap_0"),
    false
  );
  assert.equal(lastItem(normalized.ingestReceipts)?.receiptKey, duplicateReceiptKey);
  assert.equal(
    lastItem(normalized.ingestReceipts)?.sourceTaskId,
    "task_profile_state_receipt_cap_duplicate_latest"
  );
  assert.equal(
    normalized.ingestReceipts.filter((receipt) => receipt.receiptKey === duplicateReceiptKey).length,
    1
  );
});

test("normalizeProfileMemoryState recovers retained ingest receipts when only stored receiptKey is malformed", () => {
  const expectedReceiptKey = buildProfileMemoryIngestReceiptKey({
    sourceSurface: "conversation_profile_input",
    turnId: "turn_profile_state_receipt_recovery",
    sourceFingerprint: "fingerprint_profile_state_receipt_recovery"
  });
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T00:45:00.000Z",
    ingestReceipts: [
      {
        turnId: " turn_profile_state_receipt_recovery ",
        sourceFingerprint: " fingerprint_profile_state_receipt_recovery ",
        sourceTaskId: " task_profile_state_receipt_recovery ",
        recordedAt: " 2026-04-05T00:35:00+00:00 "
      }
    ]
  });

  assert.equal(normalized.ingestReceipts.length, 1);
  assert.equal(normalized.ingestReceipts[0]?.receiptKey, expectedReceiptKey);
  assert.equal(normalized.ingestReceipts[0]?.turnId, "turn_profile_state_receipt_recovery");
  assert.equal(
    normalized.ingestReceipts[0]?.sourceFingerprint,
    "fingerprint_profile_state_receipt_recovery"
  );
  assert.equal(
    normalized.ingestReceipts[0]?.sourceTaskId,
    "task_profile_state_receipt_recovery"
  );
});

test("normalizeProfileMemoryState recovers retained ingest receipts when only stored recordedAt is malformed", () => {
  const expectedReceiptKey = buildProfileMemoryIngestReceiptKey({
    sourceSurface: "conversation_profile_input",
    turnId: "turn_profile_state_receipt_recorded_at_recovery",
    sourceFingerprint: "fingerprint_profile_state_receipt_recorded_at_recovery"
  });
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T01:00:00.000Z",
    ingestReceipts: [
      {
        receiptKey: " receipt_profile_state_receipt_recorded_at_recovery ",
        turnId: " turn_profile_state_receipt_recorded_at_recovery ",
        sourceFingerprint: " fingerprint_profile_state_receipt_recorded_at_recovery ",
        sourceTaskId: " task_profile_state_receipt_recorded_at_recovery "
      }
    ]
  });

  assert.equal(normalized.ingestReceipts.length, 1);
  assert.equal(normalized.ingestReceipts[0]?.receiptKey, expectedReceiptKey);
  assert.equal(
    normalized.ingestReceipts[0]?.turnId,
    "turn_profile_state_receipt_recorded_at_recovery"
  );
  assert.equal(
    normalized.ingestReceipts[0]?.sourceFingerprint,
    "fingerprint_profile_state_receipt_recorded_at_recovery"
  );
  assert.equal(
    normalized.ingestReceipts[0]?.sourceTaskId,
    "task_profile_state_receipt_recorded_at_recovery"
  );
  assert.equal(normalized.ingestReceipts[0]?.recordedAt, "2026-04-05T01:00:00.000Z");
});

test("normalizeProfileMemoryState keeps the newest retained duplicate receipt by canonical recordedAt", () => {
  const expectedReceiptKey = buildProfileMemoryIngestReceiptKey({
    sourceSurface: "conversation_profile_input",
    turnId: "turn_profile_state_receipt_duplicate_recency",
    sourceFingerprint: "fingerprint_profile_state_receipt_duplicate_recency"
  });
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T01:10:00.000Z",
    ingestReceipts: [
      {
        receiptKey: " receipt_profile_state_receipt_duplicate_recency_newer ",
        turnId: " turn_profile_state_receipt_duplicate_recency ",
        sourceFingerprint: " fingerprint_profile_state_receipt_duplicate_recency ",
        sourceTaskId: " task_profile_state_receipt_duplicate_recency_newer ",
        recordedAt: " 2026-04-05T01:09:00+00:00 "
      },
      {
        receiptKey: " receipt_profile_state_receipt_duplicate_recency_older ",
        turnId: " turn_profile_state_receipt_duplicate_recency ",
        sourceFingerprint: " fingerprint_profile_state_receipt_duplicate_recency ",
        sourceTaskId: " task_profile_state_receipt_duplicate_recency_older ",
        recordedAt: " 2026-04-05T00:09:00+00:00 "
      }
    ]
  });

  assert.equal(normalized.ingestReceipts.length, 1);
  assert.equal(normalized.ingestReceipts[0]?.receiptKey, expectedReceiptKey);
  assert.equal(
    normalized.ingestReceipts[0]?.sourceTaskId,
    "task_profile_state_receipt_duplicate_recency_newer"
  );
  assert.equal(normalized.ingestReceipts[0]?.recordedAt, "2026-04-05T01:09:00.000Z");
});

test("normalizeProfileMemoryState recovers retained ingest receipts when only stored sourceTaskId is malformed", () => {
  const expectedReceiptKey = buildProfileMemoryIngestReceiptKey({
    sourceSurface: "conversation_profile_input",
    turnId: "turn_profile_state_receipt_source_task_recovery",
    sourceFingerprint: "fingerprint_profile_state_receipt_source_task_recovery"
  });
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T01:20:00.000Z",
    ingestReceipts: [
      {
        receiptKey: " receipt_profile_state_receipt_source_task_recovery ",
        turnId: " turn_profile_state_receipt_source_task_recovery ",
        sourceFingerprint: " fingerprint_profile_state_receipt_source_task_recovery ",
        sourceTaskId: "   ",
        recordedAt: " 2026-04-05T01:19:00+00:00 "
      }
    ]
  });

  assert.equal(normalized.ingestReceipts.length, 1);
  assert.equal(normalized.ingestReceipts[0]?.receiptKey, expectedReceiptKey);
  assert.equal(
    normalized.ingestReceipts[0]?.sourceTaskId,
    `profile_ingest_receipt_recovered_${expectedReceiptKey!.slice(-24)}`
  );
  assert.equal(normalized.ingestReceipts[0]?.recordedAt, "2026-04-05T01:19:00.000Z");
});

test("normalizeProfileMemoryState recovers retained ingest receipts when only stored turnId and sourceFingerprint are malformed", () => {
  const expectedReceiptKey = buildProfileMemoryIngestReceiptKey({
    sourceSurface: "conversation_profile_input",
    turnId: "turn_profile_state_receipt_provenance_recovery",
    sourceFingerprint: "fingerprint_profile_state_receipt_provenance_recovery"
  });
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T01:25:00.000Z",
    ingestReceipts: [
      {
        receiptKey: ` ${expectedReceiptKey} `,
        turnId: "   ",
        sourceFingerprint: "   ",
        sourceTaskId: " task_profile_state_receipt_provenance_recovery ",
        recordedAt: " 2026-04-05T01:24:00+00:00 "
      }
    ]
  });
  const renormalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T01:26:00.000Z",
    ingestReceipts: normalized.ingestReceipts
  });

  assert.equal(normalized.ingestReceipts.length, 1);
  assert.equal(normalized.ingestReceipts[0]?.receiptKey, expectedReceiptKey);
  assert.equal(
    normalized.ingestReceipts[0]?.turnId,
    `profile_ingest_receipt_turn_recovered_${expectedReceiptKey!.slice(-24)}`
  );
  assert.equal(
    normalized.ingestReceipts[0]?.sourceFingerprint,
    `profile_ingest_receipt_fingerprint_recovered_${expectedReceiptKey!.slice(-24)}`
  );
  assert.equal(
    normalized.ingestReceipts[0]?.sourceTaskId,
    "task_profile_state_receipt_provenance_recovery"
  );
  assert.equal(normalized.ingestReceipts[0]?.recordedAt, "2026-04-05T01:24:00.000Z");
  assert.deepEqual(renormalized.ingestReceipts, normalized.ingestReceipts);
});

test("normalizeProfileMemoryState prefers explicit retained turn and fingerprint provenance when canonical recordedAt ties", () => {
  const explicitTurnId = "alpha_turn_profile_state_receipt_metadata_strength";
  const explicitSourceFingerprint =
    "alpha_fingerprint_profile_state_receipt_metadata_strength";
  const expectedReceiptKey = buildProfileMemoryIngestReceiptKey({
    sourceSurface: "conversation_profile_input",
    turnId: explicitTurnId,
    sourceFingerprint: explicitSourceFingerprint
  });
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T01:40:00.000Z",
    ingestReceipts: [
      {
        receiptKey: ` ${expectedReceiptKey} `,
        turnId: "   ",
        sourceFingerprint: "   ",
        sourceTaskId: " task_profile_state_receipt_metadata_strength ",
        recordedAt: " 2026-04-05T01:39:00+00:00 "
      },
      {
        receiptKey: " receipt_profile_state_receipt_metadata_strength_explicit ",
        turnId: ` ${explicitTurnId} `,
        sourceFingerprint: ` ${explicitSourceFingerprint} `,
        sourceTaskId: " task_profile_state_receipt_metadata_strength ",
        recordedAt: " 2026-04-04T20:39:00-05:00 "
      }
    ]
  });

  assert.equal(normalized.ingestReceipts.length, 1);
  assert.equal(normalized.ingestReceipts[0]?.receiptKey, expectedReceiptKey);
  assert.equal(normalized.ingestReceipts[0]?.turnId, explicitTurnId);
  assert.equal(
    normalized.ingestReceipts[0]?.sourceFingerprint,
    explicitSourceFingerprint
  );
  assert.equal(
    normalized.ingestReceipts[0]?.sourceTaskId,
    "task_profile_state_receipt_metadata_strength"
  );
  assert.equal(normalized.ingestReceipts[0]?.recordedAt, "2026-04-05T01:39:00.000Z");
});

test("normalizeProfileMemoryState prefers stronger retained duplicate receipt provenance when canonical recordedAt ties", () => {
  const expectedReceiptKey = buildProfileMemoryIngestReceiptKey({
    sourceSurface: "conversation_profile_input",
    turnId: "turn_profile_state_receipt_duplicate_provenance",
    sourceFingerprint: "fingerprint_profile_state_receipt_duplicate_provenance"
  });
  const normalized = normalizeProfileMemoryState({
    updatedAt: "2026-04-05T01:30:00.000Z",
    ingestReceipts: [
      {
        receiptKey: " receipt_profile_state_receipt_duplicate_provenance_explicit ",
        turnId: " turn_profile_state_receipt_duplicate_provenance ",
        sourceFingerprint: " fingerprint_profile_state_receipt_duplicate_provenance ",
        sourceTaskId: " task_profile_state_receipt_duplicate_provenance_explicit ",
        recordedAt: " 2026-04-05T01:29:00+00:00 "
      },
      {
        receiptKey: " receipt_profile_state_receipt_duplicate_provenance_recovered ",
        turnId: " turn_profile_state_receipt_duplicate_provenance ",
        sourceFingerprint: " fingerprint_profile_state_receipt_duplicate_provenance ",
        sourceTaskId: "   ",
        recordedAt: " 2026-04-04T20:29:00-05:00 "
      }
    ]
  });

  assert.equal(normalized.ingestReceipts.length, 1);
  assert.equal(normalized.ingestReceipts[0]?.receiptKey, expectedReceiptKey);
  assert.equal(
    normalized.ingestReceipts[0]?.sourceTaskId,
    "task_profile_state_receipt_duplicate_provenance_explicit"
  );
  assert.equal(normalized.ingestReceipts[0]?.recordedAt, "2026-04-05T01:29:00.000Z");
});
