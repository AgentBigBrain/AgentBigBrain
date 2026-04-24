/**
 * @fileoverview Tests encrypted profile-memory persistence, access controls, and env-based initialization behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { sha256HexFromCanonicalJson } from "../../src/core/normalizers/canonicalizationRules";
import { createSchemaEnvelopeV1 } from "../../src/core/schemaEnvelope";
import {
  createProfileEpisodeRecord,
  PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME,
  PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
  createEmptyProfileMemoryState,
  type ProfileMemoryState,
  upsertTemporalProfileFact
} from "../../src/core/profileMemory";
import {
  buildProfileMemoryIngestReceiptKey,
  findProfileMemoryIngestReceipt,
  MAX_PROFILE_MEMORY_INGEST_RECEIPTS
} from "../../src/core/profileMemoryRuntime/profileMemoryIngestIdempotency";
import { ProfileMemoryStore } from "../../src/core/profileMemoryStore";
import { buildProfileMemorySourceFingerprint } from "../../src/core/profileMemoryRuntime/profileMemoryIngestProvenance";
import {
  loadPersistedProfileMemoryState,
  saveProfileMemoryState
} from "../../src/core/profileMemoryRuntime/profileMemoryPersistence";
import { applyProfileMemoryGraphMutations } from "../../src/core/profileMemoryRuntime/profileMemoryGraphMutations";
import { normalizeProfileMemoryState } from "../../src/core/profileMemoryRuntime/profileMemoryStateNormalization";
import {
  buildConversationStackFromTurnsV1,
  createEmptyConversationStackV1
} from "../../src/core/stage6_86ConversationStack";
import {
  applyEntityExtractionToGraph,
  buildEntityKey,
  createEmptyEntityGraphV1,
  extractEntityCandidates
} from "../../src/core/stage6_86EntityGraph";
import {
  upsertOpenLoopOnConversationStackV1
} from "../../src/core/stage6_86OpenLoops";
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

/**
 * Implements `withProfileStore` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withProfileStore(
  callback: (store: ProfileMemoryStore, filePath: string) => Promise<void>,
  options: ConstructorParameters<typeof ProfileMemoryStore>[3] = {}
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-profile-"));
  const filePath = path.join(tempDir, "profile_memory.secure.json");
  const keyBase64 = Buffer.alloc(32, 7).toString("base64");
  const store = new ProfileMemoryStore(filePath, Buffer.from(keyBase64, "base64"), 90, options);

  try {
    await callback(store, filePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function saveSeededProfileMemoryState(
  filePath: string,
  encryptionKey: Buffer,
  seededState: unknown
): Promise<void> {
  await saveProfileMemoryState(filePath, encryptionKey, seededState as ProfileMemoryState);
}

function asProfileMemoryState(seededState: unknown): ProfileMemoryState {
  return seededState as ProfileMemoryState;
}

function lastItem<TItem>(items: readonly TItem[]): TItem | undefined {
  return items[items.length - 1];
}

test("profile memory persists encrypted content and omits plaintext values at rest", async () => {
  await withProfileStore(async (store, filePath) => {
    await store.ingestFromTaskInput(
      "task_profile_1",
      "my address is 123 Main Street and I work at Lantern",
      "2026-02-23T00:00:00.000Z"
    );

    const raw = await readFile(filePath, "utf8");
    assert.equal(raw.includes("123 Main Street"), false);
    assert.equal(raw.includes("employment.current"), false);
  });
});

test("profile memory load returns reconciled stale snapshots without rewriting encrypted storage", async () => {
  await withProfileStore(async (store, filePath) => {
    let seededState = createEmptyProfileMemoryState();
    seededState = upsertTemporalProfileFact(seededState, {
      key: "employment.current",
      value: "Lantern",
      sensitive: false,
      sourceTaskId: "task_profile_load_read_only",
      source: "user_input_pattern.work_at",
      observedAt: "2025-01-01T00:00:00.000Z",
      confidence: 0.95
    }).nextState;
    await saveSeededProfileMemoryState(filePath, Buffer.alloc(32, 7), seededState);

    const rawBefore = await readFile(filePath, "utf8");
    const loaded = await store.load();
    const rawAfter = await readFile(filePath, "utf8");

    assert.equal(loaded.facts[0]?.status, "uncertain");
    assert.equal(rawAfter, rawBefore);
  });
});

test("profile memory repairPersistedState persists deterministic read-time repairs explicitly", async () => {
  await withProfileStore(async (store, filePath) => {
    let seededState = createEmptyProfileMemoryState();
    seededState = upsertTemporalProfileFact(seededState, {
      key: "employment.current",
      value: "Lantern",
      sensitive: false,
      sourceTaskId: "task_profile_repair_persist",
      source: "user_input_pattern.work_at",
      observedAt: "2025-01-01T00:00:00.000Z",
      confidence: 0.95
    }).nextState;
    await saveSeededProfileMemoryState(filePath, Buffer.alloc(32, 7), seededState);

    const rawBefore = await readFile(filePath, "utf8");
    const repaired = await store.repairPersistedState();
    const rawAfter = await readFile(filePath, "utf8");
    const persisted = await loadPersistedProfileMemoryState(filePath, Buffer.alloc(32, 7));

    assert.equal(repaired.facts[0]?.status, "uncertain");
    assert.notEqual(rawAfter, rawBefore);
    assert.equal(persisted.facts[0]?.status, "uncertain");
  });
});

test("readFacts hides sensitive fields unless explicit approval is present", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_2",
      "my address is 123 Main Street and my job is Lantern",
      "2026-02-23T00:00:00.000Z"
    );

    const withoutApproval = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: false
    });
    assert.equal(withoutApproval.some((fact) => fact.key.includes("address")), false);

    const withApproval = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_123"
    });
    const addressFact = withApproval.find((fact) => fact.key.includes("address"));
    assert.ok(addressFact);
    assert.equal(addressFact?.value, "123 Main Street");
  });
});

test("planning context excludes sensitive facts and includes active non-sensitive facts", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_3",
      "my address is 123 Main Street and my job is Lantern",
      "2026-02-23T00:00:00.000Z"
    );

    const planningContext = await store.getPlanningContext(6);
    assert.equal(planningContext.includes("employment.current"), true);
    assert.equal(planningContext.includes("address"), false);
    assert.equal(planningContext.includes("123 Main Street"), false);
  });
});

test("profile memory load preserves additive graph state during stale-fact reconciliation", async () => {
  await withProfileStore(async (store, filePath) => {
    let seededState = createEmptyProfileMemoryState();
    seededState = upsertTemporalProfileFact(seededState, {
      key: "employment.current",
      value: "Lantern",
      sensitive: false,
      sourceTaskId: "task_profile_graph_store_load",
      source: "test.seed",
      observedAt: "2025-11-01T00:00:00.000Z",
      confidence: 0.95
    }).nextState;
    seededState = {
      ...seededState,
      graph: {
        ...seededState.graph,
        updatedAt: "2026-04-03T21:00:00.000Z",
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_load",
            stableRefId: "stable_lantern",
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_load",
            sourceFingerprint: "fingerprint_profile_graph_store_load",
            sourceTier: "explicit_user_statement",
            assertedAt: "2025-11-01T00:00:00.000Z",
            validFrom: "2025-11-01T00:00:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_store_load"],
            projectionSourceIds: [],
            entityRefIds: ["entity_lantern"],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 2,
          entries: [
            {
              journalEntryId: "journal_profile_graph_store_load",
              watermark: 1,
              recordedAt: "2026-04-03T21:00:00.000Z",
              sourceTaskId: "task_profile_graph_store_load",
              sourceFingerprint: "fingerprint_profile_graph_store_load",
              mutationEnvelopeHash: null,
              observationIds: [],
              claimIds: ["claim_profile_graph_store_load"],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, Buffer.alloc(32, 7), seededState);

    const loaded = await store.load();
    assert.equal(loaded.graph.claims.length, 1);
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["employment.current"],
      "claim_profile_graph_store_load"
    );
    assert.deepEqual(loaded.graph.indexes.byEntityRefId, {
      entity_lantern: ["claim_profile_graph_store_load"]
    });
  });
});

test("profile memory load dedupes duplicate graph claim envelopes before rebuilding read models", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:10:00.000Z",
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_duplicate",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_duplicate_1",
            sourceFingerprint: "fingerprint_profile_graph_store_duplicate_1",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:00:00.000Z",
            validFrom: "2026-04-03T21:00:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_duplicate_1"],
            entityRefIds: [],
            active: true
          }, "2026-04-03T21:00:00.000Z"),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_duplicate",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_duplicate_2",
            sourceFingerprint: "fingerprint_profile_graph_store_duplicate_2",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:00:00.000Z",
            validFrom: "2026-04-03T21:00:00.000Z",
            validTo: "2026-04-03T21:05:00.000Z",
            endedAt: "2026-04-03T21:05:00.000Z",
            endedByClaimId: "claim_profile_graph_store_duplicate_successor",
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_duplicate_2"],
            entityRefIds: [],
            active: false
          }, "2026-04-03T21:05:00.000Z")
        ]
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.claims.length, 1);
    assert.equal(loaded.graph.claims[0]?.payload.claimId, "claim_profile_graph_store_duplicate");
    assert.equal(loaded.graph.claims[0]?.payload.active, false);
    assert.deepEqual(loaded.graph.readModel.currentClaimIdsByKey, {});
  });
});

test("profile memory load repairs authoritative active claims with same-key different-value conflicts", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T14:00:00.000Z",
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_conflict_1",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_conflict_1",
            sourceFingerprint: "fingerprint_profile_graph_store_conflict_1",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T13:00:00.000Z",
            validFrom: "2026-04-04T13:00:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_conflict_1"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_conflict_2",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Ava",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_conflict_2",
            sourceFingerprint: "fingerprint_profile_graph_store_conflict_2",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T13:05:00.000Z",
            validFrom: "2026-04-04T13:05:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_conflict_2"],
            entityRefIds: [],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.equal(loaded.graph.claims.length, 2);
    const activeClaims = loaded.graph.claims.filter((claim) => claim.payload.active);
    const inactiveClaims = loaded.graph.claims.filter((claim) => !claim.payload.active);

    assert.equal(activeClaims.length, 1);
    assert.equal(inactiveClaims.length, 1);
    assert.equal(activeClaims[0]?.payload.claimId, "claim_profile_graph_store_conflict_2");
    assert.equal(inactiveClaims[0]?.payload.claimId, "claim_profile_graph_store_conflict_1");
    assert.equal(
      inactiveClaims[0]?.payload.endedByClaimId,
      "claim_profile_graph_store_conflict_2"
    );
    assert.equal(inactiveClaims[0]?.payload.validTo, "2026-04-04T14:00:00.000Z");
    assert.equal(inactiveClaims[0]?.payload.endedAt, "2026-04-04T14:00:00.000Z");
    assert.deepEqual(loaded.graph.readModel.currentClaimIdsByKey, {
      "identity.preferred_name": "claim_profile_graph_store_conflict_2"
    });
    assert.deepEqual(loaded.graph.readModel.conflictingCurrentClaimIdsByKey, {});
    assert.deepEqual(
      loaded.graph.readModel.inventoryClaimIdsByFamily["identity.preferred_name"],
      ["claim_profile_graph_store_conflict_2"]
    );
    assert.deepEqual(loaded.graph.indexes.activeClaimIds, [
      "claim_profile_graph_store_conflict_2"
    ]);
  });
});

test("profile memory load ignores blank-family or blank-key claims in derived family and current-state surfaces", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:00:00.000Z",
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_blank_guard_valid",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_blank_guard_valid",
            sourceFingerprint: "fingerprint_profile_graph_store_blank_guard_valid",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T15:00:00.000Z",
            validFrom: "2026-04-04T15:00:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_blank_guard_valid"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_blank_guard_family",
            stableRefId: null,
            family: "   ",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Ava",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_blank_guard_family",
            sourceFingerprint: "fingerprint_profile_graph_store_blank_guard_family",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T15:05:00.000Z",
            validFrom: "2026-04-04T15:05:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_blank_guard_family"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_blank_guard_key",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "   ",
            normalizedValue: "Ari",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_blank_guard_key",
            sourceFingerprint: "fingerprint_profile_graph_store_blank_guard_key",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T15:10:00.000Z",
            validFrom: "2026-04-04T15:10:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_blank_guard_key"],
            entityRefIds: [],
            active: true
          })
        ],
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_blank_guard_family",
            stableRefId: null,
            family: "   ",
            title: "Old note",
            summary: "Malformed family bucket should stay hidden.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_blank_event_family",
            sourceFingerprint: "fingerprint_profile_graph_store_blank_event_family",
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
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
      "claim_profile_graph_store_blank_guard_valid"
    );
    assert.deepEqual(loaded.graph.readModel.conflictingCurrentClaimIdsByKey, {});
    assert.deepEqual(
      loaded.graph.readModel.inventoryClaimIdsByFamily["identity.preferred_name"],
      ["claim_profile_graph_store_blank_guard_valid"]
    );
    assert.deepEqual(loaded.graph.indexes.byFamily, {
      "identity.preferred_name": ["claim_profile_graph_store_blank_guard_valid"]
    });
    assert.deepEqual(loaded.graph.indexes.activeClaimIds, [
      "claim_profile_graph_store_blank_guard_family",
      "claim_profile_graph_store_blank_guard_key",
      "claim_profile_graph_store_blank_guard_valid"
    ]);
  });
});

test("profile memory load does not backfill observations or replay markers for blank-family or blank-key active claims", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:05:00.000Z",
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_blank_replay_family",
            stableRefId: null,
            family: "   ",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_blank_replay_family",
            sourceFingerprint: "fingerprint_profile_graph_store_blank_replay_family",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T15:00:00.000Z",
            validFrom: "2026-04-04T15:00:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_blank_replay_family"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_blank_replay_key",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "   ",
            normalizedValue: "Ava",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_blank_replay_key",
            sourceFingerprint: "fingerprint_profile_graph_store_blank_replay_key",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T15:05:00.000Z",
            validFrom: "2026-04-04T15:05:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_blank_replay_key"],
            entityRefIds: [],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.observations.length, 0);
    assert.equal(loaded.graph.mutationJournal.entries.length, 0);
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 1);
    assert.deepEqual(loaded.graph.readModel.currentClaimIdsByKey, {});
  });
});

test("profile memory load does not backfill replay or current-state surfaces for null-or-blank-valued active claims", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:06:00.000Z",
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_null_value_replay_null",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: null,
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_null_value_replay_null",
            sourceFingerprint: "fingerprint_profile_graph_store_null_value_replay_null",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T15:00:00.000Z",
            validFrom: "2026-04-04T15:00:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_null_value_replay_null"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_null_value_replay_blank",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "   ",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_null_value_replay_blank",
            sourceFingerprint: "fingerprint_profile_graph_store_null_value_replay_blank",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T15:05:00.000Z",
            validFrom: "2026-04-04T15:05:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_null_value_replay_blank"],
            entityRefIds: [],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.observations.length, 0);
    assert.equal(loaded.graph.mutationJournal.entries.length, 0);
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 1);
    assert.deepEqual(loaded.graph.readModel.currentClaimIdsByKey, {});
    assert.deepEqual(loaded.graph.readModel.inventoryClaimIdsByFamily, {});
  });
});

test("profile memory load keeps preserve-prior graph claim ambiguity visible without backfilling replay or detached lineage", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-06T00:00:00.000Z",
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_preserve_conflict_1",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_preserve_conflict_1",
            sourceFingerprint: "fingerprint_profile_graph_store_preserve_conflict_1",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-05T00:10:00.000Z",
            validFrom: "2026-04-05T00:10:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_preserve_conflict_1"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_preserve_conflict_2",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Northstar",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_preserve_conflict_2",
            sourceFingerprint: "fingerprint_profile_graph_store_preserve_conflict_2",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-05T00:12:00.000Z",
            validFrom: "2026-04-05T00:12:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_preserve_conflict_2"],
            entityRefIds: [],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const activeClaims = loaded.graph.claims.filter((claim) => claim.payload.active);

    assert.equal(loaded.graph.observations.length, 0);
    assert.equal(loaded.graph.mutationJournal.entries.length, 0);
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 1);
    assert.equal(activeClaims.length, 2);
    assert.deepEqual(
      activeClaims.map((claim) => claim.payload.claimId),
      [
        "claim_profile_graph_store_preserve_conflict_1",
        "claim_profile_graph_store_preserve_conflict_2"
      ]
    );
    assert.deepEqual(
      activeClaims.map((claim) => claim.payload.derivedFromObservationIds),
      [[], []]
    );
    assert.deepEqual(loaded.graph.readModel.currentClaimIdsByKey, {});
    assert.deepEqual(loaded.graph.readModel.conflictingCurrentClaimIdsByKey, {
      "employment.current": [
        "claim_profile_graph_store_preserve_conflict_1",
        "claim_profile_graph_store_preserve_conflict_2"
      ]
    });
    assert.deepEqual(loaded.graph.readModel.inventoryClaimIdsByFamily, {
      "employment.current": [
        "claim_profile_graph_store_preserve_conflict_1",
        "claim_profile_graph_store_preserve_conflict_2"
      ]
    });
    assert.deepEqual(loaded.graph.indexes.activeClaimIds, [
      "claim_profile_graph_store_preserve_conflict_1",
      "claim_profile_graph_store_preserve_conflict_2"
    ]);
  });
});

test("profile memory load keeps support-only retained graph claims canonical-only while preserving end-state claim repair", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-06T00:30:00.000Z",
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_support_only_context_1",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.1",
            normalizedValue: "Owen mentioned Lantern",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_support_only_context_1",
            sourceFingerprint: "fingerprint_profile_graph_store_support_only_context_1",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-05T00:20:00.000Z",
            validFrom: "2026-04-05T00:20:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_support_only_context_1"],
            entityRefIds: ["entity_owen"],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_followup_resolution_1",
            stableRefId: null,
            family: "followup.resolution",
            normalizedKey: "followup.launch",
            normalizedValue: "resolved",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_followup_resolution_1",
            sourceFingerprint: "fingerprint_profile_graph_store_followup_resolution_1",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-05T00:25:00.000Z",
            validFrom: "2026-04-05T00:25:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_followup_resolution_1"],
            entityRefIds: [],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const supportOnlyClaim = loaded.graph.claims.find(
      (claim) => claim.payload.claimId === "claim_profile_graph_store_support_only_context_1"
    );
    const followupClaim = loaded.graph.claims.find(
      (claim) => claim.payload.claimId === "claim_profile_graph_store_followup_resolution_1"
    );
    const followupObservation = loaded.graph.observations[0];

    assert.equal(loaded.graph.observations.length, 1);
    assert.ok(supportOnlyClaim);
    assert.ok(followupClaim);
    assert.ok(followupObservation);
    assert.deepEqual(supportOnlyClaim.payload.derivedFromObservationIds, []);
    assert.deepEqual(followupClaim.payload.derivedFromObservationIds, [
      followupObservation.payload.observationId
    ]);
    assert.equal(loaded.graph.mutationJournal.entries.length, 2);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.flatMap((entry) => entry.observationIds),
      [followupObservation.payload.observationId]
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.flatMap((entry) => entry.claimIds),
      ["claim_profile_graph_store_followup_resolution_1"]
    );
    assert.deepEqual(loaded.graph.readModel.currentClaimIdsByKey, {
      "followup.launch": "claim_profile_graph_store_followup_resolution_1"
    });
    assert.deepEqual(loaded.graph.readModel.conflictingCurrentClaimIdsByKey, {});
    assert.deepEqual(loaded.graph.readModel.inventoryClaimIdsByFamily, {
      "followup.resolution": ["claim_profile_graph_store_followup_resolution_1"]
    });
    assert.deepEqual(loaded.graph.indexes.byFamily, {
      "contact.context": ["claim_profile_graph_store_support_only_context_1"],
      "followup.resolution": ["claim_profile_graph_store_followup_resolution_1"]
    });
    assert.deepEqual(loaded.graph.indexes.activeClaimIds, [
      "claim_profile_graph_store_followup_resolution_1",
      "claim_profile_graph_store_support_only_context_1"
    ]);
  });
});

test("profile memory load keeps family-mismatched retained graph claims canonical-only while preserving aligned end-state repair", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-06T00:40:00.000Z",
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_family_mismatch_1",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_family_mismatch_1",
            sourceFingerprint: "fingerprint_profile_graph_store_family_mismatch_1",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-05T00:30:00.000Z",
            validFrom: "2026-04-05T00:30:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_family_mismatch_1"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_family_mismatch_followup_1",
            stableRefId: null,
            family: "followup.resolution",
            normalizedKey: "followup.launch",
            normalizedValue: "resolved",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_family_mismatch_followup_1",
            sourceFingerprint: "fingerprint_profile_graph_store_family_mismatch_followup_1",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-05T00:35:00.000Z",
            validFrom: "2026-04-05T00:35:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_family_mismatch_followup_1"],
            entityRefIds: [],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const mismatchedClaim = loaded.graph.claims.find(
      (claim) => claim.payload.claimId === "claim_profile_graph_store_family_mismatch_1"
    );
    const followupClaim = loaded.graph.claims.find(
      (claim) => claim.payload.claimId === "claim_profile_graph_store_family_mismatch_followup_1"
    );
    const followupObservation = loaded.graph.observations[0];

    assert.equal(loaded.graph.observations.length, 1);
    assert.ok(mismatchedClaim);
    assert.ok(followupClaim);
    assert.ok(followupObservation);
    assert.deepEqual(mismatchedClaim.payload.derivedFromObservationIds, []);
    assert.deepEqual(followupClaim.payload.derivedFromObservationIds, [
      followupObservation.payload.observationId
    ]);
    assert.equal(loaded.graph.mutationJournal.entries.length, 2);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.flatMap((entry) => entry.claimIds),
      ["claim_profile_graph_store_family_mismatch_followup_1"]
    );
    assert.deepEqual(loaded.graph.readModel.currentClaimIdsByKey, {
      "followup.launch": "claim_profile_graph_store_family_mismatch_followup_1"
    });
    assert.deepEqual(loaded.graph.readModel.conflictingCurrentClaimIdsByKey, {});
    assert.deepEqual(loaded.graph.readModel.inventoryClaimIdsByFamily, {
      "followup.resolution": ["claim_profile_graph_store_family_mismatch_followup_1"]
    });
    assert.deepEqual(loaded.graph.indexes.byFamily, {
      "contact.context": ["claim_profile_graph_store_family_mismatch_1"],
      "followup.resolution": ["claim_profile_graph_store_family_mismatch_followup_1"]
    });
  });
});

test("profile memory load keeps family-mismatched retained graph claims out of conflict repair and ambiguity suppression", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-06T00:50:00.000Z",
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_mismatch_authoritative",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_mismatch_authoritative",
            sourceFingerprint: "fingerprint_profile_graph_store_mismatch_authoritative",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-05T00:45:00.000Z",
            validFrom: "2026-04-05T00:45:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_mismatch_authoritative"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_aligned_authoritative",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Ava",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_aligned_authoritative",
            sourceFingerprint: "fingerprint_profile_graph_store_aligned_authoritative",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-05T00:40:00.000Z",
            validFrom: "2026-04-05T00:40:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_aligned_authoritative"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_mismatch_preserve",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_mismatch_preserve",
            sourceFingerprint: "fingerprint_profile_graph_store_mismatch_preserve",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-05T00:47:00.000Z",
            validFrom: "2026-04-05T00:47:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_mismatch_preserve"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_aligned_preserve",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Northstar",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_aligned_preserve",
            sourceFingerprint: "fingerprint_profile_graph_store_aligned_preserve",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-05T00:35:00.000Z",
            validFrom: "2026-04-05T00:35:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_aligned_preserve"],
            entityRefIds: [],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const mismatchedAuthoritative = loaded.graph.claims.find(
      (claim) => claim.payload.claimId === "claim_profile_graph_store_mismatch_authoritative"
    );
    const alignedAuthoritative = loaded.graph.claims.find(
      (claim) => claim.payload.claimId === "claim_profile_graph_store_aligned_authoritative"
    );
    const mismatchedPreserve = loaded.graph.claims.find(
      (claim) => claim.payload.claimId === "claim_profile_graph_store_mismatch_preserve"
    );
    const alignedPreserve = loaded.graph.claims.find(
      (claim) => claim.payload.claimId === "claim_profile_graph_store_aligned_preserve"
    );

    assert.ok(mismatchedAuthoritative);
    assert.ok(alignedAuthoritative);
    assert.ok(mismatchedPreserve);
    assert.ok(alignedPreserve);
    assert.equal(loaded.graph.claims.every((claim) => claim.payload.active), true);
    assert.equal(loaded.graph.observations.length, 2);
    assert.deepEqual(mismatchedAuthoritative.payload.derivedFromObservationIds, []);
    assert.deepEqual(mismatchedPreserve.payload.derivedFromObservationIds, []);
    assert.equal(alignedAuthoritative.payload.derivedFromObservationIds.length, 1);
    assert.equal(alignedPreserve.payload.derivedFromObservationIds.length, 1);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.flatMap((entry) => entry.claimIds).sort((left, right) =>
        left.localeCompare(right)
      ),
      [
        "claim_profile_graph_store_aligned_authoritative",
        "claim_profile_graph_store_aligned_preserve"
      ]
    );
    assert.deepEqual(loaded.graph.readModel.currentClaimIdsByKey, {
      "employment.current": "claim_profile_graph_store_aligned_preserve",
      "identity.preferred_name": "claim_profile_graph_store_aligned_authoritative"
    });
    assert.deepEqual(loaded.graph.readModel.conflictingCurrentClaimIdsByKey, {});
    assert.deepEqual(loaded.graph.readModel.inventoryClaimIdsByFamily, {
      "employment.current": ["claim_profile_graph_store_aligned_preserve"],
      "identity.preferred_name": ["claim_profile_graph_store_aligned_authoritative"]
    });
  });
});

test("profile memory load keeps source-tier-invalid retained graph claims out of current surfaces, conflict repair, and ambiguity suppression", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-06T02:10:00.000Z",
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_invalid_source_authoritative",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_invalid_source_authoritative",
            sourceFingerprint: "fingerprint_profile_graph_store_invalid_source_authoritative",
            sourceTier: "assistant_inference",
            assertedAt: "2026-04-06T01:45:00.000Z",
            validFrom: "2026-04-06T01:45:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "inferred",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_invalid_source_authoritative"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_valid_source_authoritative",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Ava",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_valid_source_authoritative",
            sourceFingerprint: "fingerprint_profile_graph_store_valid_source_authoritative",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-06T01:40:00.000Z",
            validFrom: "2026-04-06T01:40:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_valid_source_authoritative"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_invalid_source_preserve",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_invalid_source_preserve",
            sourceFingerprint: "fingerprint_profile_graph_store_invalid_source_preserve",
            sourceTier: "assistant_inference",
            assertedAt: "2026-04-06T01:47:00.000Z",
            validFrom: "2026-04-06T01:47:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "inferred",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_invalid_source_preserve"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_valid_source_preserve",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Northstar",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_valid_source_preserve",
            sourceFingerprint: "fingerprint_profile_graph_store_valid_source_preserve",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-06T01:35:00.000Z",
            validFrom: "2026-04-06T01:35:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_valid_source_preserve"],
            entityRefIds: [],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const invalidAuthoritative = loaded.graph.claims.find(
      (claim) => claim.payload.claimId === "claim_profile_graph_store_invalid_source_authoritative"
    );
    const validAuthoritative = loaded.graph.claims.find(
      (claim) => claim.payload.claimId === "claim_profile_graph_store_valid_source_authoritative"
    );
    const invalidPreserve = loaded.graph.claims.find(
      (claim) => claim.payload.claimId === "claim_profile_graph_store_invalid_source_preserve"
    );
    const validPreserve = loaded.graph.claims.find(
      (claim) => claim.payload.claimId === "claim_profile_graph_store_valid_source_preserve"
    );

    assert.ok(invalidAuthoritative);
    assert.ok(validAuthoritative);
    assert.ok(invalidPreserve);
    assert.ok(validPreserve);
    assert.equal(loaded.graph.claims.every((claim) => claim.payload.active), true);
    assert.equal(loaded.graph.observations.length, 2);
    assert.deepEqual(invalidAuthoritative.payload.derivedFromObservationIds, []);
    assert.deepEqual(invalidPreserve.payload.derivedFromObservationIds, []);
    assert.equal(validAuthoritative.payload.derivedFromObservationIds.length, 1);
    assert.equal(validPreserve.payload.derivedFromObservationIds.length, 1);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.flatMap((entry) => entry.claimIds).sort((left, right) =>
        left.localeCompare(right)
      ),
      [
        "claim_profile_graph_store_valid_source_authoritative",
        "claim_profile_graph_store_valid_source_preserve"
      ]
    );
    assert.deepEqual(loaded.graph.readModel.currentClaimIdsByKey, {
      "employment.current": "claim_profile_graph_store_valid_source_preserve",
      "identity.preferred_name": "claim_profile_graph_store_valid_source_authoritative"
    });
    assert.deepEqual(loaded.graph.readModel.conflictingCurrentClaimIdsByKey, {});
    assert.deepEqual(loaded.graph.readModel.inventoryClaimIdsByFamily, {
      "employment.current": ["claim_profile_graph_store_valid_source_preserve"],
      "identity.preferred_name": ["claim_profile_graph_store_valid_source_authoritative"]
    });
  });
});

test("profile memory load dedupes duplicate entity refs inside one retained graph record before index rebuild", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:00:00.000Z",
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_entity_ref_duplicate",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_entity_ref_duplicate",
            sourceFingerprint: "fingerprint_profile_graph_store_entity_ref_duplicate",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T15:55:00.000Z",
            validFrom: "2026-04-04T15:55:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_entity_ref_duplicate"],
            entityRefIds: ["entity_lantern", "entity_lantern", "entity_lantern"],
            active: true
          })
        ],
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_entity_ref_duplicate",
            stableRefId: null,
            family: "episode.candidate",
            title: "Lantern sync",
            summary: "Lantern sync happened.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_entity_ref_duplicate_event",
            sourceFingerprint: "fingerprint_profile_graph_store_entity_ref_duplicate_event",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T15:56:00.000Z",
            observedAt: "2026-04-04T15:56:00.000Z",
            validFrom: "2026-04-04T15:56:00.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["episode_profile_graph_store_entity_ref_duplicate"],
            entityRefIds: ["entity_lantern", "entity_lantern"]
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.deepEqual(loaded.graph.indexes.byEntityRefId, {
      entity_lantern: [
        "claim_profile_graph_store_entity_ref_duplicate",
        "event_profile_graph_store_entity_ref_duplicate"
      ]
    });
  });
});

test("profile memory load prunes duplicate and dangling observation lineage refs from retained claims and events", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:10:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_lineage_valid",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.1",
            normalizedValue: "Owen mentioned Lantern.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_lineage_valid",
            sourceFingerprint: "fingerprint_profile_graph_store_lineage_valid",
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
            claimId: "claim_profile_graph_store_lineage_duplicate",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_lineage_duplicate",
            sourceFingerprint: "fingerprint_profile_graph_store_lineage_duplicate",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:05:00.000Z",
            validFrom: "2026-04-04T16:05:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [
              "observation_profile_graph_store_lineage_valid",
              "observation_profile_graph_store_lineage_missing",
              "observation_profile_graph_store_lineage_valid"
            ],
            projectionSourceIds: ["fact_profile_graph_store_lineage_duplicate"],
            entityRefIds: [],
            active: true
          })
        ],
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_lineage_duplicate",
            stableRefId: null,
            family: "episode.candidate",
            title: "Lantern mention",
            summary: "Owen mentioned Lantern.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_lineage_duplicate_event",
            sourceFingerprint: "fingerprint_profile_graph_store_lineage_duplicate_event",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:05:00.000Z",
            observedAt: "2026-04-04T16:05:00.000Z",
            validFrom: "2026-04-04T16:05:00.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [
              "observation_profile_graph_store_lineage_valid",
              "observation_profile_graph_store_lineage_missing",
              "observation_profile_graph_store_lineage_valid"
            ],
            projectionSourceIds: ["episode_profile_graph_store_lineage_duplicate"],
            entityRefIds: ["entity_owen"]
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.deepEqual(
      loaded.graph.claims[0]?.payload.derivedFromObservationIds,
      ["observation_profile_graph_store_lineage_valid"]
    );
    assert.deepEqual(
      loaded.graph.events[0]?.payload.derivedFromObservationIds,
      ["observation_profile_graph_store_lineage_valid"]
    );
  });
});

test("profile memory load prunes conflicting same-lane claim lineage refs while keeping unrelated supporting observations", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:12:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_lineage_supporting_context",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.1",
            normalizedValue: "Owen called the user Avery.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_lineage_supporting_context",
            sourceFingerprint: "fingerprint_profile_graph_store_lineage_supporting_context",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:05:00.000Z",
            observedAt: "2026-04-04T16:05:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: ["entity_owen"]
          }),
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_lineage_conflicting_same_lane",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Ava",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_lineage_conflicting_same_lane",
            sourceFingerprint: "fingerprint_profile_graph_store_lineage_conflicting_same_lane",
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
            claimId: "claim_profile_graph_store_lineage_supporting_context_only",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_lineage_supporting_context_only",
            sourceFingerprint: "fingerprint_profile_graph_store_lineage_supporting_context_only",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:06:00.000Z",
            validFrom: "2026-04-04T16:06:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [
              "observation_profile_graph_store_lineage_supporting_context",
              "observation_profile_graph_store_lineage_conflicting_same_lane"
            ],
            projectionSourceIds: ["fact_profile_graph_store_lineage_supporting_context_only"],
            entityRefIds: [],
            active: true
          })
        ],
        events: [],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.observations.length, 2);
    assert.equal(loaded.graph.mutationJournal.entries.length, 2);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.observationIds,
      loaded.graph.observations
        .map((observation) => observation.payload.observationId)
        .sort((left, right) => left.localeCompare(right))
    );
    assert.equal(
      loaded.graph.mutationJournal.entries[0]?.sourceFingerprint?.startsWith(
        "graph_observation_replay_backfill_"
      ),
      true
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[1]?.claimIds,
      ["claim_profile_graph_store_lineage_supporting_context_only"]
    );
    assert.equal(
      loaded.graph.mutationJournal.entries[1]?.sourceFingerprint?.startsWith(
        "graph_claim_replay_backfill_"
      ),
      true
    );
    assert.deepEqual(
      loaded.graph.claims[0]?.payload.derivedFromObservationIds,
      ["observation_profile_graph_store_lineage_supporting_context"]
    );
    assert.equal(
      loaded.graph.observations.some(
        (observation) =>
          observation.payload.observationId ===
          "observation_profile_graph_store_lineage_conflicting_same_lane"
      ),
      true
    );
  });
});

test("profile memory load prunes malformed claim successor refs", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:15:00.000Z",
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_successor_dangling",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "OldCo",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_successor_dangling",
            sourceFingerprint: "fingerprint_profile_graph_store_successor_dangling",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:05:00.000Z",
            validFrom: "2026-04-04T16:05:00.000Z",
            validTo: "2026-04-04T16:06:00.000Z",
            endedAt: "2026-04-04T16:06:00.000Z",
            endedByClaimId: "claim_profile_graph_store_successor_missing",
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_successor_dangling"],
            entityRefIds: [],
            active: false
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_successor_active_stray",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_successor_active_stray",
            sourceFingerprint: "fingerprint_profile_graph_store_successor_active_stray",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:07:00.000Z",
            validFrom: "2026-04-04T16:07:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: "claim_profile_graph_store_successor_valid",
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_successor_active_stray"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_successor_closed_valid",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Ava",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_successor_closed_valid",
            sourceFingerprint: "fingerprint_profile_graph_store_successor_closed_valid",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:08:00.000Z",
            validFrom: "2026-04-04T16:08:00.000Z",
            validTo: "2026-04-04T16:09:00.000Z",
            endedAt: "2026-04-04T16:09:00.000Z",
            endedByClaimId: "claim_profile_graph_store_successor_valid",
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_successor_closed_valid"],
            entityRefIds: [],
            active: false
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_successor_valid",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "June",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_successor_valid",
            sourceFingerprint: "fingerprint_profile_graph_store_successor_valid",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:09:00.000Z",
            validFrom: "2026-04-04T16:09:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_successor_valid"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_successor_wrong_key",
            stableRefId: null,
            family: "contact.owen.relationship",
            normalizedKey: "contact.owen.relationship",
            normalizedValue: "friend",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_successor_wrong_key",
            sourceFingerprint: "fingerprint_profile_graph_store_successor_wrong_key",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:04:00.000Z",
            validFrom: "2026-04-04T16:04:00.000Z",
            validTo: "2026-04-04T16:05:00.000Z",
            endedAt: "2026-04-04T16:05:00.000Z",
            endedByClaimId: "claim_profile_graph_store_successor_valid",
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_successor_wrong_key"],
            entityRefIds: [],
            active: false
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const claimById = new Map(
      loaded.graph.claims.map((claim) => [claim.payload.claimId, claim] as const)
    );
    assert.equal(
      claimById.get("claim_profile_graph_store_successor_dangling")?.payload.endedByClaimId,
      null
    );
    assert.equal(
      claimById.get("claim_profile_graph_store_successor_active_stray")?.payload.endedByClaimId,
      null
    );
    assert.equal(
      claimById.get("claim_profile_graph_store_successor_closed_valid")?.payload.endedByClaimId,
      "claim_profile_graph_store_successor_valid"
    );
    assert.equal(
      claimById.get("claim_profile_graph_store_successor_wrong_key")?.payload.endedByClaimId,
      null
    );
  });
});

test("profile memory load repairs malformed claim lifecycle boundaries", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:16:00.000Z",
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_lifecycle_active_stray",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_lifecycle_active_stray",
            sourceFingerprint: "fingerprint_profile_graph_store_lifecycle_active_stray",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:01:00.000Z",
            validFrom: "2026-04-04T16:01:00.000Z",
            validTo: "2026-04-04T16:02:00.000Z",
            endedAt: "2026-04-04T16:02:00.000Z",
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_lifecycle_active_stray"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_lifecycle_inactive_mismatch",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_lifecycle_inactive_mismatch",
            sourceFingerprint: "fingerprint_profile_graph_store_lifecycle_inactive_mismatch",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:03:00.000Z",
            validFrom: "2026-04-04T16:03:00.000Z",
            validTo: "2026-04-04T16:05:00.000Z",
            endedAt: "2026-04-04T16:04:00.000Z",
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_lifecycle_inactive_mismatch"],
            entityRefIds: [],
            active: false
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_lifecycle_redacted_active",
            stableRefId: "stable_owen",
            family: "contact.owen.relationship",
            normalizedKey: "contact.owen.relationship",
            normalizedValue: "friend",
            redactionState: "redacted",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_lifecycle_redacted_active",
            sourceFingerprint: "fingerprint_profile_graph_store_lifecycle_redacted_active",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:06:00.000Z",
            validFrom: "2026-04-04T16:06:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_lifecycle_redacted_active"],
            entityRefIds: ["entity_owen"],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const claimById = new Map(
      loaded.graph.claims.map((claim) => [claim.payload.claimId, claim] as const)
    );
    assert.equal(
      claimById.get("claim_profile_graph_store_lifecycle_active_stray")?.payload.validTo,
      null
    );
    assert.equal(
      claimById.get("claim_profile_graph_store_lifecycle_active_stray")?.payload.endedAt,
      null
    );
    assert.equal(
      claimById.get("claim_profile_graph_store_lifecycle_inactive_mismatch")?.payload.validTo,
      "2026-04-04T16:04:00.000Z"
    );
    assert.equal(
      claimById.get("claim_profile_graph_store_lifecycle_inactive_mismatch")?.payload.endedAt,
      "2026-04-04T16:04:00.000Z"
    );
    assert.equal(
      claimById.get("claim_profile_graph_store_lifecycle_redacted_active")?.payload.active,
      false
    );
    assert.equal(
      claimById.get("claim_profile_graph_store_lifecycle_redacted_active")?.payload.normalizedValue,
      null
    );
    assert.equal(
      claimById.get("claim_profile_graph_store_lifecycle_redacted_active")?.payload.validTo,
      "2026-04-04T16:16:00.000Z"
    );
    assert.equal(
      claimById.get("claim_profile_graph_store_lifecycle_redacted_active")?.payload.endedAt,
      "2026-04-04T16:16:00.000Z"
    );
    assert.equal(
      claimById.get("claim_profile_graph_store_lifecycle_redacted_active")?.payload.redactedAt,
      "2026-04-04T16:16:00.000Z"
    );
    assert.equal(
      claimById.get("claim_profile_graph_store_lifecycle_redacted_active")?.payload.sensitive,
      true
    );
    assert.equal(
      claimById.get("claim_profile_graph_store_lifecycle_redacted_active")?.payload.stableRefId,
      null
    );
    assert.deepEqual(
      claimById.get("claim_profile_graph_store_lifecycle_redacted_active")?.payload.entityRefIds,
      []
    );
  });
});

test("profile memory load repairs malformed graph timestamps before lifecycle normalization", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:17:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_time_redacted_invalid",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "redacted",
            redactedAt: "not-a-date",
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_time_observation",
            sourceFingerprint: "fingerprint_profile_graph_store_time_observation",
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
            claimId: "claim_profile_graph_store_time_redacted_invalid",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            redactionState: "redacted",
            redactedAt: "bad-redacted-at",
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_time_claim",
            sourceFingerprint: "fingerprint_profile_graph_store_time_claim",
            sourceTier: "explicit_user_statement",
            assertedAt: "bad-asserted-at",
            validFrom: "bad-valid-from",
            validTo: "bad-valid-to",
            endedAt: "bad-ended-at",
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_time_claim"],
            entityRefIds: [],
            active: true
          })
        ],
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_time_redacted_invalid",
            stableRefId: null,
            family: "episode.candidate",
            title: "Raw forgotten title",
            summary: "Raw forgotten summary.",
            redactionState: "redacted",
            redactedAt: "bad-redacted-at",
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_time_event",
            sourceFingerprint: "fingerprint_profile_graph_store_time_event",
            sourceTier: "explicit_user_statement",
            assertedAt: "bad-asserted-at",
            observedAt: "bad-observed-at",
            validFrom: "bad-valid-from",
            validTo: "bad-valid-to",
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["episode_profile_graph_store_time_event"],
            entityRefIds: []
          })
        ]
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const observation = loaded.graph.observations.find(
      (entry) => entry.payload.observationId === "observation_profile_graph_store_time_redacted_invalid"
    );
    const claim = loaded.graph.claims.find(
      (entry) => entry.payload.claimId === "claim_profile_graph_store_time_redacted_invalid"
    );
    const event = loaded.graph.events.find(
      (entry) => entry.payload.eventId === "event_profile_graph_store_time_redacted_invalid"
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
});

test("profile memory load repairs mixed-policy followup active claim conflicts behind the resolved winner", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-05T01:00:00.000Z",
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_followup_pending",
            stableRefId: null,
            family: "generic.profile_fact",
            normalizedKey: "followup.launch",
            normalizedValue: "pending",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_followup_pending",
            sourceFingerprint: "fingerprint_profile_graph_store_followup_pending",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-05T00:10:00.000Z",
            validFrom: "2026-04-05T00:10:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_followup_pending"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_followup_resolved",
            stableRefId: null,
            family: "followup.resolution",
            normalizedKey: "followup.launch",
            normalizedValue: "resolved",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_followup_resolved",
            sourceFingerprint: "fingerprint_profile_graph_store_followup_resolved",
            sourceTier: "assistant_inference",
            assertedAt: "2026-04-05T00:12:00.000Z",
            validFrom: "2026-04-05T00:12:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "inferred",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_followup_resolved"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_followup_waiting",
            stableRefId: null,
            family: "generic.profile_fact",
            normalizedKey: "followup.launch",
            normalizedValue: "waiting_on_vendor",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_followup_waiting",
            sourceFingerprint: "fingerprint_profile_graph_store_followup_waiting",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-05T00:15:00.000Z",
            validFrom: "2026-04-05T00:15:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_followup_waiting"],
            entityRefIds: [],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const activeClaims = loaded.graph.claims.filter((claim) => claim.payload.active);
    const inactiveClaims = loaded.graph.claims.filter((claim) => !claim.payload.active);

    assert.equal(loaded.graph.claims.length, 3);
    assert.equal(activeClaims.length, 1);
    assert.equal(inactiveClaims.length, 2);
    assert.equal(
      activeClaims[0]?.payload.claimId,
      "claim_profile_graph_store_followup_resolved"
    );
    assert.deepEqual(
      inactiveClaims.map((claim) => claim.payload.claimId).sort((left, right) =>
        left.localeCompare(right)
      ),
      [
        "claim_profile_graph_store_followup_pending",
        "claim_profile_graph_store_followup_waiting"
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
    assert.deepEqual(loaded.graph.readModel.currentClaimIdsByKey, {
      "followup.launch": "claim_profile_graph_store_followup_resolved"
    });
    assert.deepEqual(loaded.graph.readModel.conflictingCurrentClaimIdsByKey, {});
    assert.deepEqual(loaded.graph.readModel.inventoryClaimIdsByFamily["followup.resolution"], [
      "claim_profile_graph_store_followup_resolved"
    ]);
    assert.deepEqual(loaded.graph.indexes.activeClaimIds, [
      "claim_profile_graph_store_followup_resolved"
    ]);
  });
});

test("profile memory load trims padded graph payload timestamps before lifecycle normalization", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:20:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_time_trimmed",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "redacted",
            redactedAt: " 2026-04-04T11:13:00-05:00 ",
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_time_trimmed_observation",
            sourceFingerprint: "fingerprint_profile_graph_store_time_trimmed_observation",
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
            claimId: "claim_profile_graph_store_time_trimmed",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_time_trimmed_claim",
            sourceFingerprint: "fingerprint_profile_graph_store_time_trimmed_claim",
            sourceTier: "explicit_user_statement",
            assertedAt: " 2026-04-04T11:14:00-05:00 ",
            validFrom: " 2026-04-04T11:15:00-05:00 ",
            validTo: " 2026-04-04T11:16:00-05:00 ",
            endedAt: " 2026-04-04T11:16:00-05:00 ",
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_time_trimmed_claim"],
            entityRefIds: [],
            active: false
          })
        ],
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_time_trimmed",
            stableRefId: null,
            family: "episode.candidate",
            title: "Owen fall situation",
            summary: "Owen fell and later recovered.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_time_trimmed_event",
            sourceFingerprint: "fingerprint_profile_graph_store_time_trimmed_event",
            sourceTier: "explicit_user_statement",
            assertedAt: " 2026-04-04T11:17:00-05:00 ",
            observedAt: " 2026-04-04T11:18:00-05:00 ",
            validFrom: " 2026-04-04T11:19:00-05:00 ",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["episode_profile_graph_store_time_trimmed_event"],
            entityRefIds: []
          })
        ]
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const observation = loaded.graph.observations.find(
      (entry) => entry.payload.observationId === "observation_profile_graph_store_time_trimmed"
    );
    const claim = loaded.graph.claims.find(
      (entry) => entry.payload.claimId === "claim_profile_graph_store_time_trimmed"
    );
    const event = loaded.graph.events.find(
      (entry) => entry.payload.eventId === "event_profile_graph_store_time_trimmed"
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
});

test("profile memory load repairs malformed observation redaction boundaries", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:18:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_lifecycle_active_stray",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            redactionState: "not_requested",
            redactedAt: "2026-04-04T16:02:00.000Z",
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_observation_lifecycle_active_stray",
            sourceFingerprint:
              "fingerprint_profile_graph_store_observation_lifecycle_active_stray",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:01:00.000Z",
            observedAt: "2026-04-04T16:01:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          }),
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_lifecycle_redacted_raw",
            stableRefId: "stable_avery",
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "redacted",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_observation_lifecycle_redacted_raw",
            sourceFingerprint:
              "fingerprint_profile_graph_store_observation_lifecycle_redacted_raw",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:05:00.000Z",
            observedAt: "2026-04-04T16:05:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: ["entity_avery"]
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const observationById = new Map(
      loaded.graph.observations.map((observation) => [observation.payload.observationId, observation] as const)
    );
    assert.equal(
      observationById.get("observation_profile_graph_store_lifecycle_active_stray")?.payload.redactedAt,
      null
    );
    assert.equal(
      observationById.get("observation_profile_graph_store_lifecycle_active_stray")?.payload.normalizedValue,
      "Lantern"
    );
    assert.equal(
      observationById.get("observation_profile_graph_store_lifecycle_redacted_raw")?.payload.redactedAt,
      "2026-04-04T16:18:00.000Z"
    );
    assert.equal(
      observationById.get("observation_profile_graph_store_lifecycle_redacted_raw")?.payload.normalizedValue,
      null
    );
    assert.equal(
      observationById.get("observation_profile_graph_store_lifecycle_redacted_raw")?.payload.sensitive,
      true
    );
    assert.equal(
      observationById.get("observation_profile_graph_store_lifecycle_redacted_raw")?.payload.stableRefId,
      null
    );
    assert.deepEqual(
      observationById.get("observation_profile_graph_store_lifecycle_redacted_raw")?.payload.entityRefIds,
      []
    );
  });
});

test("profile memory load repairs malformed event lifecycle boundaries", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:20:00.000Z",
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_lifecycle_active_stray",
            stableRefId: null,
            family: "episode.candidate",
            title: "Owen still needs help",
            summary: "Owen still needs help.",
            redactionState: "not_requested",
            redactedAt: "2026-04-04T16:02:00.000Z",
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_event_lifecycle_active_stray",
            sourceFingerprint: "fingerprint_profile_graph_store_event_lifecycle_active_stray",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:01:00.000Z",
            observedAt: "2026-04-04T16:01:00.000Z",
            validFrom: "2026-04-04T16:01:00.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["episode_profile_graph_store_event_lifecycle_active_stray"],
            entityRefIds: ["entity_owen"]
          }),
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_lifecycle_redacted_active",
            stableRefId: "stable_episode_owen",
            family: "episode.candidate",
            title: "Raw forgotten title",
            summary: "Raw forgotten summary.",
            redactionState: "redacted",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_event_lifecycle_redacted_active",
            sourceFingerprint: "fingerprint_profile_graph_store_event_lifecycle_redacted_active",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:05:00.000Z",
            observedAt: "2026-04-04T16:05:00.000Z",
            validFrom: "2026-04-04T16:05:00.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_store_event_lifecycle_redacted_active"],
            projectionSourceIds: ["episode_profile_graph_store_event_lifecycle_redacted_active"],
            entityRefIds: ["entity_owen"]
          }),
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_lifecycle_redacted_resolved",
            stableRefId: null,
            family: "episode.candidate",
            title: "[redacted episode]",
            summary: "[redacted episode details]",
            redactionState: "redacted",
            redactedAt: "2026-04-04T16:14:00.000Z",
            sensitive: true,
            sourceTaskId: "task_profile_graph_store_event_lifecycle_redacted_resolved",
            sourceFingerprint: "fingerprint_profile_graph_store_event_lifecycle_redacted_resolved",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:10:00.000Z",
            observedAt: "2026-04-04T16:10:00.000Z",
            validFrom: "2026-04-04T16:10:00.000Z",
            validTo: "2026-04-04T16:13:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["episode_profile_graph_store_event_lifecycle_redacted_resolved"],
            entityRefIds: []
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const eventById = new Map(
      loaded.graph.events.map((event) => [event.payload.eventId, event] as const)
    );
    assert.equal(
      eventById.get("event_profile_graph_store_lifecycle_active_stray")?.payload.redactedAt,
      null
    );
    assert.equal(
      eventById.get("event_profile_graph_store_lifecycle_redacted_active")?.payload.validTo,
      "2026-04-04T16:20:00.000Z"
    );
    assert.equal(
      eventById.get("event_profile_graph_store_lifecycle_redacted_active")?.payload.redactedAt,
      "2026-04-04T16:20:00.000Z"
    );
    assert.equal(
      eventById.get("event_profile_graph_store_lifecycle_redacted_active")?.payload.title,
      "[redacted episode]"
    );
    assert.equal(
      eventById.get("event_profile_graph_store_lifecycle_redacted_active")?.payload.summary,
      "[redacted episode details]"
    );
    assert.equal(
      eventById.get("event_profile_graph_store_lifecycle_redacted_active")?.payload.sensitive,
      true
    );
    assert.equal(
      eventById.get("event_profile_graph_store_lifecycle_redacted_active")?.payload.stableRefId,
      null
    );
    assert.deepEqual(
      eventById.get("event_profile_graph_store_lifecycle_redacted_active")?.payload.derivedFromObservationIds,
      []
    );
    assert.deepEqual(
      eventById.get("event_profile_graph_store_lifecycle_redacted_active")?.payload.entityRefIds,
      []
    );
    assert.equal(
      eventById.get("event_profile_graph_store_lifecycle_redacted_resolved")?.payload.validTo,
      "2026-04-04T16:13:00.000Z"
    );
    assert.equal(
      eventById.get("event_profile_graph_store_lifecycle_redacted_resolved")?.payload.redactedAt,
      "2026-04-04T16:14:00.000Z"
    );
  });
});

test("profile memory load trims padded graph semantic identity, clears blank optional graph metadata, and recovers blank journal ids", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:20:30.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_metadata_blank",
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
            claimId: "claim_profile_graph_store_metadata_blank",
            stableRefId: " stable_avery ",
            family: " identity.preferred_name ",
            normalizedKey: " identity.preferred_name ",
            normalizedValue: " Avery ",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "   ",
            sourceFingerprint: " fingerprint_profile_graph_store_metadata_blank ",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:16:00.000Z",
            validFrom: "2026-04-04T16:16:00.000Z",
            validTo: "2026-04-04T16:16:30.000Z",
            endedAt: "2026-04-04T16:16:30.000Z",
            endedByClaimId: "claim_profile_graph_store_metadata_blank_successor",
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_store_metadata_blank"],
            projectionSourceIds: ["fact_profile_graph_store_metadata_blank"],
            entityRefIds: [],
            active: false
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_metadata_blank_successor",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_metadata_blank_successor",
            sourceFingerprint: "fingerprint_profile_graph_store_metadata_blank_successor",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:16:30.000Z",
            validFrom: "2026-04-04T16:16:30.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_metadata_blank_successor"],
            entityRefIds: [],
            active: true
          })
        ],
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_metadata_blank",
            stableRefId: "   ",
            family: " episode.candidate ",
            title: "Avery follow-up",
            summary: "Avery followed up later.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: " task_profile_graph_store_metadata_event ",
            sourceFingerprint: "   ",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:16:00.000Z",
            observedAt: "2026-04-04T16:16:00.000Z",
            validFrom: "2026-04-04T16:16:00.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_store_metadata_blank"],
            projectionSourceIds: ["episode_profile_graph_store_metadata_blank"],
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
              observationIds: ["observation_profile_graph_store_metadata_blank"],
              claimIds: ["claim_profile_graph_store_metadata_blank"],
              eventIds: ["event_profile_graph_store_metadata_blank"],
              redactionState: "not_requested"
            },
            {
              journalEntryId: " journal_profile_graph_store_metadata_keep ",
              watermark: 2,
              recordedAt: "2026-04-04T16:16:30.000Z",
              sourceTaskId: "   ",
              sourceFingerprint: "   ",
              mutationEnvelopeHash: "   ",
              observationIds: ["observation_profile_graph_store_metadata_blank"],
              claimIds: ["claim_profile_graph_store_metadata_blank"],
              eventIds: ["event_profile_graph_store_metadata_blank"],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const observation = loaded.graph.observations.find(
      (entry) => entry.payload.observationId === "observation_profile_graph_store_metadata_blank"
    );
    const claim = loaded.graph.claims.find(
      (entry) => entry.payload.claimId === "claim_profile_graph_store_metadata_blank"
    );
    const event = loaded.graph.events.find(
      (entry) => entry.payload.eventId === "event_profile_graph_store_metadata_blank"
    );

    assert.equal(observation?.payload.stableRefId, "stable_self_profile_owner");
    assert.equal(observation?.payload.family, "identity.preferred_name");
    assert.equal(observation?.payload.normalizedKey, "identity.preferred_name");
    assert.equal(observation?.payload.normalizedValue, "Avery");
    assert.equal(observation?.payload.sourceTaskId, null);
    assert.equal(
      observation?.payload.sourceFingerprint,
      `graph_observation_source_${sha256HexFromCanonicalJson({
        observationId: "observation_profile_graph_store_metadata_blank"
      }).slice(0, 24)}`
    );
    assert.equal(claim?.payload.stableRefId, "stable_avery");
    assert.equal(claim?.payload.family, "identity.preferred_name");
    assert.equal(claim?.payload.normalizedKey, "identity.preferred_name");
    assert.equal(claim?.payload.normalizedValue, "Avery");
    assert.equal(claim?.payload.sourceTaskId, null);
    assert.equal(claim?.payload.sourceFingerprint, "fingerprint_profile_graph_store_metadata_blank");
    assert.equal(
      claim?.payload.endedByClaimId,
      "claim_profile_graph_store_metadata_blank_successor"
    );
    assert.equal(event?.payload.stableRefId, "stable_self_profile_owner");
    assert.equal(event?.payload.family, "episode.candidate");
    assert.equal(event?.payload.sourceTaskId, "task_profile_graph_store_metadata_event");
    assert.equal(
      event?.payload.sourceFingerprint,
      `graph_event_source_${sha256HexFromCanonicalJson({
        eventId: "event_profile_graph_store_metadata_blank"
      }).slice(0, 24)}`
    );
    const recoveredJournalEntryId =
      `journal_${sha256HexFromCanonicalJson({
        recordedAt: "2026-04-04T16:16:00.000Z",
        sourceTaskId: null,
        sourceFingerprint: null,
        mutationEnvelopeHash: null,
        observationIds: ["observation_profile_graph_store_metadata_blank"],
        claimIds: ["claim_profile_graph_store_metadata_blank"],
        eventIds: ["event_profile_graph_store_metadata_blank"],
        redactionState: "not_requested"
      }).slice(0, 24)}`;
    const recoveredJournalEntry = loaded.graph.mutationJournal.entries.find(
      (entry) => entry.journalEntryId === recoveredJournalEntryId
    );
    const keptJournalEntry = loaded.graph.mutationJournal.entries.find(
      (entry) => entry.journalEntryId === "journal_profile_graph_store_metadata_keep"
    );
    assert.equal(loaded.graph.mutationJournal.entries.length, 4);
    assert.ok(recoveredJournalEntry);
    assert.equal(recoveredJournalEntry?.sourceTaskId, null);
    assert.equal(recoveredJournalEntry?.sourceFingerprint, null);
    assert.equal(recoveredJournalEntry?.mutationEnvelopeHash, null);
    assert.ok(keptJournalEntry);
    assert.equal(keptJournalEntry?.sourceTaskId, null);
    assert.equal(keptJournalEntry?.sourceFingerprint, null);
    assert.equal(keptJournalEntry?.mutationEnvelopeHash, null);
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
      "claim_profile_graph_store_metadata_blank_successor"
    );
  });
});

test("profile memory load recovers retained journal entries when journalEntryId is malformed", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:17:00.000Z",
        observations: [
          createSchemaEnvelopeV1(
            PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
            {
              observationId: "observation_profile_graph_store_journal_id_malformed",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.store.id.malformed",
              normalizedValue: "Owen still needs store journal id recovery",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_id_malformed",
              sourceFingerprint: "fingerprint_profile_graph_store_journal_id_malformed",
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
              sourceTaskId: " task_profile_graph_store_journal_id_malformed ",
              sourceFingerprint:
                " fingerprint_profile_graph_store_journal_id_malformed ",
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_id_malformed ",
              observationIds: [
                " observation_profile_graph_store_journal_id_malformed "
              ],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };

    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const recoveredJournalEntryId =
      `journal_${sha256HexFromCanonicalJson({
        recordedAt: "2026-04-04T16:16:30.000Z",
        sourceTaskId: "task_profile_graph_store_journal_id_malformed",
        sourceFingerprint: "fingerprint_profile_graph_store_journal_id_malformed",
        mutationEnvelopeHash:
          "mutation_envelope_profile_graph_store_journal_id_malformed",
        observationIds: ["observation_profile_graph_store_journal_id_malformed"],
        claimIds: [],
        eventIds: [],
        redactionState: "not_requested"
      }).slice(0, 24)}`;
    const entry = loaded.graph.mutationJournal.entries[0];
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    assert.ok(entry);
    assert.equal(entry?.journalEntryId, recoveredJournalEntryId);
    assert.equal(entry?.watermark, 1);
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 2);
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("profile memory load keeps retained journal entries when optional metadata fields are omitted", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:18:00.000Z",
        observations: [
          createSchemaEnvelopeV1(
            PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
            {
              observationId: "observation_profile_graph_store_journal_optional_missing",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.help",
              normalizedValue: "Owen still needs help",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_optional_missing",
              sourceFingerprint: "fingerprint_profile_graph_store_journal_optional_missing",
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
              journalEntryId: "journal_profile_graph_store_journal_optional_missing",
              watermark: 1,
              recordedAt: "2026-04-04T16:17:00.000Z",
              observationIds: ["observation_profile_graph_store_journal_optional_missing"],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    assert.equal(
      loaded.graph.mutationJournal.entries[0]?.journalEntryId,
      "journal_profile_graph_store_journal_optional_missing"
    );
    assert.equal(loaded.graph.mutationJournal.entries[0]?.sourceTaskId, null);
    assert.equal(loaded.graph.mutationJournal.entries[0]?.sourceFingerprint, null);
    assert.equal(loaded.graph.mutationJournal.entries[0]?.mutationEnvelopeHash, null);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.observationIds,
      ["observation_profile_graph_store_journal_optional_missing"]
    );
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 2);
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("profile memory load keeps retained journal entries when optional metadata fields are malformed", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:18:15.000Z",
        observations: [
          createSchemaEnvelopeV1(
            PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
            {
              observationId: "observation_profile_graph_store_journal_optional_malformed",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.optional.malformed",
              normalizedValue: "Owen still needs the venue details",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_optional_malformed",
              sourceFingerprint: "fingerprint_profile_graph_store_journal_optional_malformed",
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
              journalEntryId: " journal_profile_graph_store_journal_optional_malformed ",
              watermark: 1,
              recordedAt: " 2026-04-04T16:17:30.000Z ",
              sourceTaskId: 7 as unknown as string,
              sourceFingerprint: false as unknown as string,
              mutationEnvelopeHash: { invalid: true } as unknown as string,
              observationIds: [" observation_profile_graph_store_journal_optional_malformed "],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };

    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    const entry = loaded.graph.mutationJournal.entries[0];
    assert.ok(entry);
    assert.equal(
      entry?.journalEntryId,
      "journal_profile_graph_store_journal_optional_malformed"
    );
    assert.equal(entry?.sourceTaskId, null);
    assert.equal(entry?.sourceFingerprint, null);
    assert.equal(entry?.mutationEnvelopeHash, null);
    assert.deepEqual(entry?.observationIds, [
      "observation_profile_graph_store_journal_optional_malformed"
    ]);
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 2);
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("profile memory load keeps retained journal entries when redactionState is omitted", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:19:00.000Z",
        observations: [
          createSchemaEnvelopeV1(
            PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
            {
              observationId: "observation_profile_graph_store_journal_redaction_omitted",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.topic",
              normalizedValue: "Owen needs travel details",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_redaction_omitted",
              sourceFingerprint: "fingerprint_profile_graph_store_journal_redaction_omitted",
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
              journalEntryId: " journal_entry_profile_graph_store_journal_redaction_omitted ",
              watermark: 1,
              recordedAt: " 2026-04-04T16:18:30.000Z ",
              sourceTaskId: " task_profile_graph_store_journal_redaction_omitted ",
              sourceFingerprint: " fingerprint_profile_graph_store_journal_redaction_omitted ",
              mutationEnvelopeHash: " mutation_envelope_profile_graph_store_journal_redaction_omitted ",
              observationIds: [" observation_profile_graph_store_journal_redaction_omitted "],
              claimIds: [],
              eventIds: []
            }
          ]
        }
      }
    };

    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    const entry = loaded.graph.mutationJournal.entries[0];
    assert.ok(entry);
    assert.equal(entry?.journalEntryId, "journal_entry_profile_graph_store_journal_redaction_omitted");
    assert.equal(entry?.redactionState, "not_requested");
    assert.equal(entry?.sourceTaskId, "task_profile_graph_store_journal_redaction_omitted");
    assert.equal(
      entry?.sourceFingerprint,
      "fingerprint_profile_graph_store_journal_redaction_omitted"
    );
    assert.equal(
      entry?.mutationEnvelopeHash,
      "mutation_envelope_profile_graph_store_journal_redaction_omitted"
    );
    assert.equal(entry?.recordedAt, "2026-04-04T16:18:30.000Z");
    assert.deepEqual(entry?.observationIds, [
      "observation_profile_graph_store_journal_redaction_omitted"
    ]);
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 2);
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("profile memory load drops retained journal entries when redactionState is malformed", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:18:00.000Z",
        mutationJournal: {
          schemaVersion: "v1",
          entries: [
            {
              journalEntryId: " journal_entry_profile_graph_store_journal_redaction_malformed ",
              watermark: 1,
              recordedAt: " 2026-04-04T16:18:30.000Z ",
              sourceTaskId: " task_profile_graph_store_journal_redaction_malformed ",
              sourceFingerprint:
                " fingerprint_profile_graph_store_journal_redaction_malformed ",
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_redaction_malformed ",
              observationIds: [
                " observation_profile_graph_store_journal_redaction_malformed "
              ],
              claimIds: [],
              eventIds: [],
              redactionState: "invalid_redaction_state" as unknown as "not_requested"
            }
          ]
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.deepEqual(loaded.graph.mutationJournal.entries, []);
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 1);
    assert.equal(loaded.graph.readModel.watermark, 0);
  });
});

test("profile memory load keeps retained journal entries when empty ref arrays are omitted", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:20:00.000Z",
        observations: [
          createSchemaEnvelopeV1(
            PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
            {
              observationId: "observation_profile_graph_store_journal_refs_omitted",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.next_step",
              normalizedValue: "Owen asked for the itinerary",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_refs_omitted",
              sourceFingerprint: "fingerprint_profile_graph_store_journal_refs_omitted",
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
              journalEntryId: " journal_entry_profile_graph_store_journal_refs_omitted ",
              watermark: 1,
              recordedAt: " 2026-04-04T16:19:30.000Z ",
              sourceTaskId: " task_profile_graph_store_journal_refs_omitted ",
              sourceFingerprint: " fingerprint_profile_graph_store_journal_refs_omitted ",
              mutationEnvelopeHash: " mutation_envelope_profile_graph_store_journal_refs_omitted ",
              observationIds: [" observation_profile_graph_store_journal_refs_omitted "],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };

    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    const entry = loaded.graph.mutationJournal.entries[0];
    assert.ok(entry);
    assert.equal(entry?.journalEntryId, "journal_entry_profile_graph_store_journal_refs_omitted");
    assert.equal(entry?.redactionState, "not_requested");
    assert.equal(entry?.sourceTaskId, "task_profile_graph_store_journal_refs_omitted");
    assert.equal(
      entry?.sourceFingerprint,
      "fingerprint_profile_graph_store_journal_refs_omitted"
    );
    assert.equal(
      entry?.mutationEnvelopeHash,
      "mutation_envelope_profile_graph_store_journal_refs_omitted"
    );
    assert.deepEqual(entry?.observationIds, [
      "observation_profile_graph_store_journal_refs_omitted"
    ]);
    assert.deepEqual(entry?.claimIds, []);
    assert.deepEqual(entry?.eventIds, []);
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 2);
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("profile memory load keeps retained journal entries when ref arrays contain malformed members", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:20:30.000Z",
        observations: [
          createSchemaEnvelopeV1(
            PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
            {
              observationId: "observation_profile_graph_store_journal_refs_malformed_a",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.refs.a",
              normalizedValue: "Owen shared the first retained ref",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_refs_malformed_a",
              sourceFingerprint: "fingerprint_profile_graph_store_journal_refs_malformed_a",
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
              observationId: "observation_profile_graph_store_journal_refs_malformed_b",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.refs.b",
              normalizedValue: "Owen shared the second retained ref",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_refs_malformed_b",
              sourceFingerprint: "fingerprint_profile_graph_store_journal_refs_malformed_b",
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
              journalEntryId: " journal_entry_profile_graph_store_journal_refs_malformed ",
              watermark: 1,
              recordedAt: " 2026-04-04T16:20:00.000Z ",
              sourceTaskId: " task_profile_graph_store_journal_refs_malformed ",
              sourceFingerprint: " fingerprint_profile_graph_store_journal_refs_malformed ",
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_refs_malformed ",
              observationIds: [
                " observation_profile_graph_store_journal_refs_malformed_b ",
                7 as unknown as string,
                " observation_profile_graph_store_journal_refs_malformed_a "
              ],
              claimIds: [17 as unknown as string],
              eventIds: [false as unknown as string],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };

    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    const entry = loaded.graph.mutationJournal.entries[0];
    assert.ok(entry);
    assert.equal(entry?.journalEntryId, "journal_entry_profile_graph_store_journal_refs_malformed");
    assert.deepEqual(entry?.observationIds, [
      "observation_profile_graph_store_journal_refs_malformed_a",
      "observation_profile_graph_store_journal_refs_malformed_b"
    ]);
    assert.deepEqual(entry?.claimIds, []);
    assert.deepEqual(entry?.eventIds, []);
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 2);
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("profile memory load keeps retained journal entries when ref array containers are malformed", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:20:15.000Z",
        observations: [
          createSchemaEnvelopeV1(
            PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
            {
              observationId: "observation_profile_graph_store_journal_ref_container_malformed",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.ref.container",
              normalizedValue: "Owen still needs the venue details",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_ref_container_malformed",
              sourceFingerprint:
                "fingerprint_profile_graph_store_journal_ref_container_malformed",
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
              journalEntryId: " journal_entry_profile_graph_store_journal_ref_container_malformed ",
              watermark: 1,
              recordedAt: " 2026-04-04T16:20:00.000Z ",
              sourceTaskId: " task_profile_graph_store_journal_ref_container_malformed ",
              sourceFingerprint:
                " fingerprint_profile_graph_store_journal_ref_container_malformed ",
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_ref_container_malformed ",
              observationIds: [
                " observation_profile_graph_store_journal_ref_container_malformed "
              ],
              claimIds:
                " claim_profile_graph_store_journal_ref_container_malformed " as unknown as string[],
              eventIds: { invalid: true } as unknown as string[],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };

    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    const entry = loaded.graph.mutationJournal.entries[0];
    assert.ok(entry);
    assert.equal(
      entry?.journalEntryId,
      "journal_entry_profile_graph_store_journal_ref_container_malformed"
    );
    assert.deepEqual(entry?.observationIds, [
      "observation_profile_graph_store_journal_ref_container_malformed"
    ]);
    assert.deepEqual(entry?.claimIds, []);
    assert.deepEqual(entry?.eventIds, []);
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 2);
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("profile memory load keeps retained journal entries when watermark is malformed", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:20:45.000Z",
        observations: [
          createSchemaEnvelopeV1(
            PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
            {
              observationId: "observation_profile_graph_store_journal_watermark_malformed",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.watermark.malformed",
              normalizedValue: "Owen confirmed the malformed watermark replay entry",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_watermark_malformed",
              sourceFingerprint: "fingerprint_profile_graph_store_journal_watermark_malformed",
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
              journalEntryId: " journal_entry_profile_graph_store_journal_watermark_malformed ",
              watermark: " 7 " as unknown as number,
              recordedAt: " 2026-04-04T16:20:30.000Z ",
              sourceTaskId: " task_profile_graph_store_journal_watermark_malformed ",
              sourceFingerprint:
                " fingerprint_profile_graph_store_journal_watermark_malformed ",
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_watermark_malformed ",
              observationIds: [" observation_profile_graph_store_journal_watermark_malformed "],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };

    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    const entry = loaded.graph.mutationJournal.entries[0];
    assert.ok(entry);
    assert.equal(
      entry?.journalEntryId,
      "journal_entry_profile_graph_store_journal_watermark_malformed"
    );
    assert.equal(entry?.watermark, 1);
    assert.equal(
      entry?.sourceTaskId,
      "task_profile_graph_store_journal_watermark_malformed"
    );
    assert.equal(
      entry?.sourceFingerprint,
      "fingerprint_profile_graph_store_journal_watermark_malformed"
    );
    assert.equal(
      entry?.mutationEnvelopeHash,
      "mutation_envelope_profile_graph_store_journal_watermark_malformed"
    );
    assert.deepEqual(entry?.observationIds, [
      "observation_profile_graph_store_journal_watermark_malformed"
    ]);
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 2);
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("profile memory load keeps retained journal entries when watermark is omitted", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:21:00.000Z",
        observations: [
          createSchemaEnvelopeV1(
            PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
            {
              observationId: "observation_profile_graph_store_journal_watermark_omitted",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.confirmation",
              normalizedValue: "Owen confirmed the date",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_watermark_omitted",
              sourceFingerprint: "fingerprint_profile_graph_store_journal_watermark_omitted",
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
              journalEntryId: " journal_entry_profile_graph_store_journal_watermark_omitted ",
              recordedAt: " 2026-04-04T16:20:30.000Z ",
              sourceTaskId: " task_profile_graph_store_journal_watermark_omitted ",
              sourceFingerprint: " fingerprint_profile_graph_store_journal_watermark_omitted ",
              mutationEnvelopeHash: " mutation_envelope_profile_graph_store_journal_watermark_omitted ",
              observationIds: [" observation_profile_graph_store_journal_watermark_omitted "],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };

    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    const entry = loaded.graph.mutationJournal.entries[0];
    assert.ok(entry);
    assert.equal(entry?.journalEntryId, "journal_entry_profile_graph_store_journal_watermark_omitted");
    assert.equal(entry?.watermark, 1);
    assert.equal(entry?.redactionState, "not_requested");
    assert.equal(entry?.sourceTaskId, "task_profile_graph_store_journal_watermark_omitted");
    assert.equal(
      entry?.sourceFingerprint,
      "fingerprint_profile_graph_store_journal_watermark_omitted"
    );
    assert.equal(
      entry?.mutationEnvelopeHash,
      "mutation_envelope_profile_graph_store_journal_watermark_omitted"
    );
    assert.deepEqual(entry?.observationIds, [
      "observation_profile_graph_store_journal_watermark_omitted"
    ]);
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 2);
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("profile memory load recovers omitted journal watermarks without collapsing below explicit retained floors", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:22:00.000Z",
        observations: [
          createSchemaEnvelopeV1(
            PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
            {
              observationId: "observation_profile_graph_store_journal_watermark_floor_explicit",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.store.watermark.floor.explicit",
              normalizedValue: "Owen sent the anchored store replay update",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_watermark_floor_explicit",
              sourceFingerprint:
                "fingerprint_profile_graph_store_journal_watermark_floor_explicit",
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
              observationId: "observation_profile_graph_store_journal_watermark_floor_recovered",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.store.watermark.floor.recovered",
              normalizedValue: "Owen sent the recovered store replay update",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_watermark_floor_recovered",
              sourceFingerprint:
                "fingerprint_profile_graph_store_journal_watermark_floor_recovered",
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
              journalEntryId: " journal_entry_profile_graph_store_journal_watermark_floor_explicit ",
              watermark: 5,
              recordedAt: " 2026-04-04T16:20:30.000Z ",
              sourceTaskId: " task_profile_graph_store_journal_watermark_floor_explicit ",
              sourceFingerprint:
                " fingerprint_profile_graph_store_journal_watermark_floor_explicit ",
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_watermark_floor_explicit ",
              observationIds: [
                " observation_profile_graph_store_journal_watermark_floor_explicit "
              ],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            },
            {
              journalEntryId: " journal_entry_profile_graph_store_journal_watermark_floor_recovered ",
              recordedAt: " 2026-04-04T16:21:30.000Z ",
              sourceTaskId: " task_profile_graph_store_journal_watermark_floor_recovered ",
              sourceFingerprint:
                " fingerprint_profile_graph_store_journal_watermark_floor_recovered ",
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_watermark_floor_recovered ",
              observationIds: [
                " observation_profile_graph_store_journal_watermark_floor_recovered "
              ],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };

    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.journalEntryId),
      [
        "journal_entry_profile_graph_store_journal_watermark_floor_explicit",
        "journal_entry_profile_graph_store_journal_watermark_floor_recovered"
      ]
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [5, 6]
    );
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 7);
    assert.equal(loaded.graph.readModel.watermark, 6);
  });
});

test("profile memory load recovers same-timestamp omitted journal watermarks above explicit retained floors", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const explicitObservationId =
      "observation_profile_graph_store_journal_watermark_same_timestamp_explicit";
    const recoveredObservationId =
      "observation_profile_graph_store_journal_watermark_same_timestamp_recovered";
    const recordedAt = "2026-04-04T17:20:30.000Z";
    const sourceTaskId = "task_profile_graph_store_journal_watermark_same_timestamp";
    const fingerprintCandidates = [
      "fingerprint_profile_graph_store_journal_watermark_same_timestamp_a",
      "fingerprint_profile_graph_store_journal_watermark_same_timestamp_b",
      "fingerprint_profile_graph_store_journal_watermark_same_timestamp_c",
      "fingerprint_profile_graph_store_journal_watermark_same_timestamp_d"
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
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T17:22:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: explicitObservationId,
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.store.watermark.same_timestamp.explicit",
            normalizedValue: "Owen sent the anchored same-timestamp store replay update",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId,
            sourceFingerprint: explicitSourceFingerprint,
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T17:20:00.000Z",
            observedAt: "2026-04-04T17:20:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          }),
          createGraphObservationEnvelope({
            observationId: recoveredObservationId,
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.store.watermark.same_timestamp.recovered",
            normalizedValue: "Owen sent the recovered same-timestamp store replay update",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId,
            sourceFingerprint: recoveredSourceFingerprint,
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T17:21:00.000Z",
            observedAt: "2026-04-04T17:21:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 6,
          entries: [
            {
              journalEntryId:
                " journal_entry_profile_graph_store_journal_watermark_same_timestamp_explicit ",
              watermark: 5,
              recordedAt: ` ${recordedAt} `,
              sourceTaskId: ` ${sourceTaskId} `,
              sourceFingerprint: ` ${explicitSourceFingerprint} `,
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_watermark_same_timestamp_explicit ",
              observationIds: [` ${explicitObservationId} `],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            },
            {
              journalEntryId:
                " journal_entry_profile_graph_store_journal_watermark_same_timestamp_recovered ",
              recordedAt: ` ${recordedAt} `,
              sourceTaskId: ` ${sourceTaskId} `,
              sourceFingerprint: ` ${recoveredSourceFingerprint} `,
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_watermark_same_timestamp_recovered ",
              observationIds: [` ${recoveredObservationId} `],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.mutationJournal.entries.length, 2);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.sourceFingerprint),
      [explicitSourceFingerprint, recoveredSourceFingerprint]
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [5, 6]
    );
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 7);
    assert.equal(loaded.graph.readModel.watermark, 6);
  });
});

test("profile memory load treats zero journal watermarks like recovered replay order above explicit retained floors", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const explicitObservationId =
      "observation_profile_graph_store_journal_watermark_zero_explicit";
    const recoveredObservationId =
      "observation_profile_graph_store_journal_watermark_zero_recovered";
    const recordedAt = "2026-04-04T17:24:30.000Z";
    const sourceTaskId = "task_profile_graph_store_journal_watermark_zero_same_timestamp";
    const fingerprintCandidates = [
      "fingerprint_profile_graph_store_journal_watermark_zero_a",
      "fingerprint_profile_graph_store_journal_watermark_zero_b",
      "fingerprint_profile_graph_store_journal_watermark_zero_c",
      "fingerprint_profile_graph_store_journal_watermark_zero_d"
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
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T17:26:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: explicitObservationId,
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.store.watermark.zero.explicit",
            normalizedValue: "Owen sent the explicit zero-floor store replay update",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId,
            sourceFingerprint: explicitSourceFingerprint,
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T17:24:00.000Z",
            observedAt: "2026-04-04T17:24:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          }),
          createGraphObservationEnvelope({
            observationId: recoveredObservationId,
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.store.watermark.zero.recovered",
            normalizedValue: "Owen sent the malformed zero watermark store replay update",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId,
            sourceFingerprint: recoveredSourceFingerprint,
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T17:25:00.000Z",
            observedAt: "2026-04-04T17:25:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 6,
          entries: [
            {
              journalEntryId:
                " journal_entry_profile_graph_store_journal_watermark_zero_explicit ",
              watermark: 5,
              recordedAt: ` ${recordedAt} `,
              sourceTaskId: ` ${sourceTaskId} `,
              sourceFingerprint: ` ${explicitSourceFingerprint} `,
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_watermark_zero_explicit ",
              observationIds: [` ${explicitObservationId} `],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            },
            {
              journalEntryId:
                " journal_entry_profile_graph_store_journal_watermark_zero_recovered ",
              watermark: 0,
              recordedAt: ` ${recordedAt} `,
              sourceTaskId: ` ${sourceTaskId} `,
              sourceFingerprint: ` ${recoveredSourceFingerprint} `,
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_watermark_zero_recovered ",
              observationIds: [` ${recoveredObservationId} `],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.mutationJournal.entries.length, 2);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.sourceFingerprint),
      [explicitSourceFingerprint, recoveredSourceFingerprint]
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [5, 6]
    );
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 7);
    assert.equal(loaded.graph.readModel.watermark, 6);
  });
});

test("profile memory load treats negative journal watermarks like recovered replay order above explicit retained floors", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const explicitObservationId =
      "observation_profile_graph_store_journal_watermark_negative_explicit";
    const recoveredObservationId =
      "observation_profile_graph_store_journal_watermark_negative_recovered";
    const recordedAt = "2026-04-08T15:26:30.000Z";
    const sourceTaskId = "task_profile_graph_store_journal_watermark_negative_same_timestamp";
    const fingerprintCandidates = [
      "fingerprint_profile_graph_store_journal_watermark_negative_a",
      "fingerprint_profile_graph_store_journal_watermark_negative_b",
      "fingerprint_profile_graph_store_journal_watermark_negative_c",
      "fingerprint_profile_graph_store_journal_watermark_negative_d"
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
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-08T15:28:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: explicitObservationId,
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.store.watermark.negative.explicit",
            normalizedValue: "Owen sent the explicit negative-floor store replay update",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId,
            sourceFingerprint: explicitSourceFingerprint,
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-08T15:24:00.000Z",
            observedAt: "2026-04-08T15:24:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          }),
          createGraphObservationEnvelope({
            observationId: recoveredObservationId,
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.store.watermark.negative.recovered",
            normalizedValue: "Owen sent the malformed negative watermark store replay update",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId,
            sourceFingerprint: recoveredSourceFingerprint,
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-08T15:25:00.000Z",
            observedAt: "2026-04-08T15:25:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 6,
          entries: [
            {
              journalEntryId:
                " journal_entry_profile_graph_store_journal_watermark_negative_explicit ",
              watermark: 5,
              recordedAt: ` ${recordedAt} `,
              sourceTaskId: ` ${sourceTaskId} `,
              sourceFingerprint: ` ${explicitSourceFingerprint} `,
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_watermark_negative_explicit ",
              observationIds: [` ${explicitObservationId} `],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            },
            {
              journalEntryId:
                " journal_entry_profile_graph_store_journal_watermark_negative_recovered ",
              watermark: -7,
              recordedAt: ` ${recordedAt} `,
              sourceTaskId: ` ${sourceTaskId} `,
              sourceFingerprint: ` ${recoveredSourceFingerprint} `,
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_watermark_negative_recovered ",
              observationIds: [` ${recoveredObservationId} `],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.mutationJournal.entries.length, 2);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.sourceFingerprint),
      [explicitSourceFingerprint, recoveredSourceFingerprint]
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [5, 6]
    );
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 7);
    assert.equal(loaded.graph.readModel.watermark, 6);
  });
});

test("profile memory load keeps retained journal nextWatermark canonical when it is omitted", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:22:00.000Z",
        observations: [
          createSchemaEnvelopeV1(
            PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
            {
              observationId: "observation_profile_graph_store_journal_next_watermark_omitted",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.confirmation",
              normalizedValue: "Owen confirmed the venue",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_next_watermark_omitted",
              sourceFingerprint:
                "fingerprint_profile_graph_store_journal_next_watermark_omitted",
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
              journalEntryId: " journal_entry_profile_graph_store_journal_next_watermark_omitted ",
              watermark: 1,
              recordedAt: " 2026-04-04T16:21:30.000Z ",
              sourceTaskId: " task_profile_graph_store_journal_next_watermark_omitted ",
              sourceFingerprint:
                " fingerprint_profile_graph_store_journal_next_watermark_omitted ",
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_next_watermark_omitted ",
              observationIds: [
                " observation_profile_graph_store_journal_next_watermark_omitted "
              ],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };

    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    const entry = loaded.graph.mutationJournal.entries[0];
    assert.ok(entry);
    assert.equal(
      entry?.journalEntryId,
      "journal_entry_profile_graph_store_journal_next_watermark_omitted"
    );
    assert.equal(entry?.watermark, 1);
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 2);
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("profile memory load keeps retained journal nextWatermark canonical when it is malformed", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:22:00.000Z",
        observations: [
          createSchemaEnvelopeV1(
            PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
            {
              observationId: "observation_profile_graph_store_journal_next_watermark_malformed",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.store.next.watermark.malformed",
              normalizedValue: "Owen confirmed the malformed store outer watermark lane",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_next_watermark_malformed",
              sourceFingerprint:
                "fingerprint_profile_graph_store_journal_next_watermark_malformed",
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
              journalEntryId: " journal_entry_profile_graph_store_journal_next_watermark_malformed ",
              watermark: 1,
              recordedAt: " 2026-04-04T16:21:30.000Z ",
              sourceTaskId: " task_profile_graph_store_journal_next_watermark_malformed ",
              sourceFingerprint:
                " fingerprint_profile_graph_store_journal_next_watermark_malformed ",
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_next_watermark_malformed ",
              observationIds: [
                " observation_profile_graph_store_journal_next_watermark_malformed "
              ],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };

    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    const entry = loaded.graph.mutationJournal.entries[0];
    assert.ok(entry);
    assert.equal(
      entry?.journalEntryId,
      "journal_entry_profile_graph_store_journal_next_watermark_malformed"
    );
    assert.equal(entry?.watermark, 1);
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 2);
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("profile memory load keeps retained journal nextWatermark canonical when it is stale", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:24:00.000Z",
        observations: [
          createSchemaEnvelopeV1(
            PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
            {
              observationId: "observation_profile_graph_store_journal_next_watermark_stale_a",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.store.next.watermark.stale.a",
              normalizedValue: "Owen confirmed the first stale store outer watermark lane",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_next_watermark_stale_a",
              sourceFingerprint:
                "fingerprint_profile_graph_store_journal_next_watermark_stale_a",
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
              observationId: "observation_profile_graph_store_journal_next_watermark_stale_b",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.store.next.watermark.stale.b",
              normalizedValue: "Owen confirmed the second stale store outer watermark lane",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_next_watermark_stale_b",
              sourceFingerprint:
                "fingerprint_profile_graph_store_journal_next_watermark_stale_b",
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
              journalEntryId: " journal_entry_profile_graph_store_journal_next_watermark_stale_a ",
              watermark: 1,
              recordedAt: " 2026-04-04T16:21:30.000Z ",
              sourceTaskId: " task_profile_graph_store_journal_next_watermark_stale_a ",
              sourceFingerprint:
                " fingerprint_profile_graph_store_journal_next_watermark_stale_a ",
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_next_watermark_stale_a ",
              observationIds: [
                " observation_profile_graph_store_journal_next_watermark_stale_a "
              ],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            },
            {
              journalEntryId: " journal_entry_profile_graph_store_journal_next_watermark_stale_b ",
              watermark: 2,
              recordedAt: " 2026-04-04T16:22:30.000Z ",
              sourceTaskId: " task_profile_graph_store_journal_next_watermark_stale_b ",
              sourceFingerprint:
                " fingerprint_profile_graph_store_journal_next_watermark_stale_b ",
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_next_watermark_stale_b ",
              observationIds: [
                " observation_profile_graph_store_journal_next_watermark_stale_b "
              ],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };

    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.equal(loaded.graph.mutationJournal.entries.length, 2);
    assert.equal(loaded.graph.mutationJournal.entries[0]?.watermark, 1);
    assert.equal(loaded.graph.mutationJournal.entries[1]?.watermark, 2);
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 3);
    assert.equal(loaded.graph.readModel.watermark, 2);
  });
});

test("profile memory load recovers omitted journal watermarks by replay order instead of raw array order", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:23:00.000Z",
        observations: [
          createSchemaEnvelopeV1(
            PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
            {
              observationId: "observation_profile_graph_store_journal_watermark_order_early",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.early",
              normalizedValue: "Owen sent the first update",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_watermark_order_early",
              sourceFingerprint:
                "fingerprint_profile_graph_store_journal_watermark_order_early",
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
              observationId: "observation_profile_graph_store_journal_watermark_order_late",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.late",
              normalizedValue: "Owen sent the second update",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_watermark_order_late",
              sourceFingerprint:
                "fingerprint_profile_graph_store_journal_watermark_order_late",
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
              journalEntryId: " journal_entry_profile_graph_store_journal_watermark_order_late ",
              recordedAt: " 2026-04-04T16:22:30.000Z ",
              sourceTaskId: " task_profile_graph_store_journal_watermark_order_late ",
              sourceFingerprint:
                " fingerprint_profile_graph_store_journal_watermark_order_late ",
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_watermark_order_late ",
              observationIds: [
                " observation_profile_graph_store_journal_watermark_order_late "
              ],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            },
            {
              journalEntryId: " journal_entry_profile_graph_store_journal_watermark_order_early ",
              recordedAt: " 2026-04-04T16:21:30.000Z ",
              sourceTaskId: " task_profile_graph_store_journal_watermark_order_early ",
              sourceFingerprint:
                " fingerprint_profile_graph_store_journal_watermark_order_early ",
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_watermark_order_early ",
              observationIds: [
                " observation_profile_graph_store_journal_watermark_order_early "
              ],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };

    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.journalEntryId),
      [
        "journal_entry_profile_graph_store_journal_watermark_order_early",
        "journal_entry_profile_graph_store_journal_watermark_order_late"
      ]
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [1, 2]
    );
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 3);
    assert.equal(loaded.graph.readModel.watermark, 2);
  });
});

test("profile memory load recovers same-timestamp omitted journal watermarks by canonical payload instead of legacy ids", async () => {
  await withProfileStore(async (store, filePath) => {
    const taskACanonicalJournalEntryId = `journal_${sha256HexFromCanonicalJson({
      recordedAt: "2026-04-04T16:24:30.000Z",
      sourceTaskId: "task_profile_graph_store_journal_watermark_tie_a",
      sourceFingerprint: "fingerprint_profile_graph_store_journal_watermark_tie_a",
      mutationEnvelopeHash: "mutation_envelope_profile_graph_store_journal_watermark_tie_a",
      observationIds: ["observation_profile_graph_store_journal_watermark_tie_a"],
      claimIds: [],
      eventIds: [],
      redactionState: "not_requested"
    }).slice(0, 24)}`;
    const taskBCanonicalJournalEntryId = `journal_${sha256HexFromCanonicalJson({
      recordedAt: "2026-04-04T16:24:30.000Z",
      sourceTaskId: "task_profile_graph_store_journal_watermark_tie_b",
      sourceFingerprint: "fingerprint_profile_graph_store_journal_watermark_tie_b",
      mutationEnvelopeHash: "mutation_envelope_profile_graph_store_journal_watermark_tie_b",
      observationIds: ["observation_profile_graph_store_journal_watermark_tie_b"],
      claimIds: [],
      eventIds: [],
      redactionState: "not_requested"
    }).slice(0, 24)}`;
    const expectedSourceTaskIdOrder =
      taskACanonicalJournalEntryId.localeCompare(taskBCanonicalJournalEntryId) <= 0
        ? [
          "task_profile_graph_store_journal_watermark_tie_a",
          "task_profile_graph_store_journal_watermark_tie_b"
        ]
        : [
          "task_profile_graph_store_journal_watermark_tie_b",
          "task_profile_graph_store_journal_watermark_tie_a"
        ];
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:25:00.000Z",
        observations: [
          createSchemaEnvelopeV1(
            PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
            {
              observationId: "observation_profile_graph_store_journal_watermark_tie_a",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.tie.a",
              normalizedValue: "Owen sent tie update A",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_watermark_tie_a",
              sourceFingerprint: "fingerprint_profile_graph_store_journal_watermark_tie_a",
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
              observationId: "observation_profile_graph_store_journal_watermark_tie_b",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.tie.b",
              normalizedValue: "Owen sent tie update B",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_watermark_tie_b",
              sourceFingerprint: "fingerprint_profile_graph_store_journal_watermark_tie_b",
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
              journalEntryId: " aaa_legacy_profile_graph_store_journal_watermark_tie_b ",
              recordedAt: " 2026-04-04T16:24:30.000Z ",
              sourceTaskId: " task_profile_graph_store_journal_watermark_tie_b ",
              sourceFingerprint: " fingerprint_profile_graph_store_journal_watermark_tie_b ",
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_watermark_tie_b ",
              observationIds: [" observation_profile_graph_store_journal_watermark_tie_b "],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            },
            {
              journalEntryId: " zzz_legacy_profile_graph_store_journal_watermark_tie_a ",
              recordedAt: " 2026-04-04T16:24:30.000Z ",
              sourceTaskId: " task_profile_graph_store_journal_watermark_tie_a ",
              sourceFingerprint: " fingerprint_profile_graph_store_journal_watermark_tie_a ",
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_watermark_tie_a ",
              observationIds: [" observation_profile_graph_store_journal_watermark_tie_a "],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };

    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.sourceTaskId),
      expectedSourceTaskIdOrder
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [1, 2]
    );
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 3);
    assert.equal(loaded.graph.readModel.watermark, 2);
  });
});

test("profile memory load breaks same-timestamp explicit journal watermark ties by canonical payload instead of legacy ids", async () => {
  await withProfileStore(async (store, filePath) => {
    const taskACanonicalJournalEntryId = `journal_${sha256HexFromCanonicalJson({
      recordedAt: "2026-04-04T16:26:30.000Z",
      sourceTaskId: "task_profile_graph_store_journal_explicit_watermark_tie_a",
      sourceFingerprint: "fingerprint_profile_graph_store_journal_explicit_watermark_tie_a",
      mutationEnvelopeHash:
        "mutation_envelope_profile_graph_store_journal_explicit_watermark_tie_a",
      observationIds: ["observation_profile_graph_store_journal_explicit_watermark_tie_a"],
      claimIds: [],
      eventIds: [],
      redactionState: "not_requested"
    }).slice(0, 24)}`;
    const taskBCanonicalJournalEntryId = `journal_${sha256HexFromCanonicalJson({
      recordedAt: "2026-04-04T16:26:30.000Z",
      sourceTaskId: "task_profile_graph_store_journal_explicit_watermark_tie_b",
      sourceFingerprint: "fingerprint_profile_graph_store_journal_explicit_watermark_tie_b",
      mutationEnvelopeHash:
        "mutation_envelope_profile_graph_store_journal_explicit_watermark_tie_b",
      observationIds: ["observation_profile_graph_store_journal_explicit_watermark_tie_b"],
      claimIds: [],
      eventIds: [],
      redactionState: "not_requested"
    }).slice(0, 24)}`;
    const expectedSourceTaskIdOrder =
      taskACanonicalJournalEntryId.localeCompare(taskBCanonicalJournalEntryId) <= 0
        ? [
          "task_profile_graph_store_journal_explicit_watermark_tie_a",
          "task_profile_graph_store_journal_explicit_watermark_tie_b"
        ]
        : [
          "task_profile_graph_store_journal_explicit_watermark_tie_b",
          "task_profile_graph_store_journal_explicit_watermark_tie_a"
        ];
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:27:00.000Z",
        observations: [
          createSchemaEnvelopeV1(
            PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
            {
              observationId:
                "observation_profile_graph_store_journal_explicit_watermark_tie_a",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.store.explicit.tie.a",
              normalizedValue: "Owen sent store explicit tie update A",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_explicit_watermark_tie_a",
              sourceFingerprint:
                "fingerprint_profile_graph_store_journal_explicit_watermark_tie_a",
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
              observationId:
                "observation_profile_graph_store_journal_explicit_watermark_tie_b",
              stableRefId: null,
              family: "contact.context",
              normalizedKey: "contact.owen.context.store.explicit.tie.b",
              normalizedValue: "Owen sent store explicit tie update B",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_journal_explicit_watermark_tie_b",
              sourceFingerprint:
                "fingerprint_profile_graph_store_journal_explicit_watermark_tie_b",
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
              journalEntryId: " aaa_legacy_profile_graph_store_journal_explicit_watermark_tie_b ",
              watermark: 4,
              recordedAt: " 2026-04-04T16:26:30.000Z ",
              sourceTaskId: " task_profile_graph_store_journal_explicit_watermark_tie_b ",
              sourceFingerprint:
                " fingerprint_profile_graph_store_journal_explicit_watermark_tie_b ",
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_explicit_watermark_tie_b ",
              observationIds: [
                " observation_profile_graph_store_journal_explicit_watermark_tie_b "
              ],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            },
            {
              journalEntryId: " zzz_legacy_profile_graph_store_journal_explicit_watermark_tie_a ",
              watermark: 4,
              recordedAt: " 2026-04-04T16:26:30.000Z ",
              sourceTaskId: " task_profile_graph_store_journal_explicit_watermark_tie_a ",
              sourceFingerprint:
                " fingerprint_profile_graph_store_journal_explicit_watermark_tie_a ",
              mutationEnvelopeHash:
                " mutation_envelope_profile_graph_store_journal_explicit_watermark_tie_a ",
              observationIds: [
                " observation_profile_graph_store_journal_explicit_watermark_tie_a "
              ],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };

    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.sourceTaskId),
      expectedSourceTaskIdOrder
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [4, 5]
    );
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 6);
    assert.equal(loaded.graph.readModel.watermark, 5);
  });
});

test("profile memory load trims padded graph record ids and retained graph refs", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:21:30.000Z",
        observations: [
          createSchemaEnvelopeV1(
            PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME,
            {
              observationId: " observation_profile_graph_store_identity_trim ",
              stableRefId: null,
              family: "employment.current",
              normalizedKey: "employment.current",
              normalizedValue: "Lantern",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_identity_trim_old",
              sourceFingerprint: "fingerprint_profile_graph_store_identity_trim_old",
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
              observationId: "observation_profile_graph_store_identity_trim",
              stableRefId: null,
              family: "employment.current",
              normalizedKey: "employment.current",
              normalizedValue: "Lantern",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_identity_trim_new",
              sourceFingerprint: "fingerprint_profile_graph_store_identity_trim_new",
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
              claimId: " claim_profile_graph_store_identity_trim ",
              stableRefId: null,
              family: "employment.current",
              normalizedKey: "employment.current",
              normalizedValue: "Lantern",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_identity_trim_claim_old",
              sourceFingerprint: "fingerprint_profile_graph_store_identity_trim_claim_old",
              sourceTier: "explicit_user_statement",
              assertedAt: "2026-04-04T16:19:00.000Z",
              validFrom: "2026-04-04T16:19:00.000Z",
              validTo: "2026-04-04T16:19:30.000Z",
              endedAt: "2026-04-04T16:19:30.000Z",
              endedByClaimId: " claim_profile_graph_store_identity_trim_successor ",
              timePrecision: "instant",
              timeSource: "user_stated",
              derivedFromObservationIds: [
                " observation_profile_graph_store_identity_trim ",
                "observation_profile_graph_store_identity_trim"
              ],
              projectionSourceIds: [
                " fact_profile_graph_store_identity_trim ",
                "fact_profile_graph_store_identity_trim"
              ],
              entityRefIds: [" entity_owen ", "entity_owen"],
              active: false
            },
            "2026-04-04T16:19:00.000Z"
          ),
          createSchemaEnvelopeV1(
            PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME,
            {
              claimId: " claim_profile_graph_store_identity_trim_successor ",
              stableRefId: null,
              family: "employment.current",
              normalizedKey: "employment.current",
              normalizedValue: "Lantern",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_identity_trim_claim_new",
              sourceFingerprint: "fingerprint_profile_graph_store_identity_trim_claim_new",
              sourceTier: "explicit_user_statement",
              assertedAt: "2026-04-04T16:19:30.000Z",
              validFrom: "2026-04-04T16:19:30.000Z",
              validTo: null,
              endedAt: null,
              endedByClaimId: null,
              timePrecision: "instant",
              timeSource: "user_stated",
              derivedFromObservationIds: [
                " observation_profile_graph_store_identity_trim ",
                "observation_profile_graph_store_identity_trim"
              ],
              projectionSourceIds: [
                " fact_profile_graph_store_identity_trim_successor ",
                "fact_profile_graph_store_identity_trim_successor"
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
              eventId: " event_profile_graph_store_identity_trim ",
              stableRefId: null,
              family: "episode.candidate",
              title: "Lantern update",
              summary: "Lantern changed plans.",
              redactionState: "not_requested",
              redactedAt: null,
              sensitive: false,
              sourceTaskId: "task_profile_graph_store_identity_trim_event",
              sourceFingerprint: "fingerprint_profile_graph_store_identity_trim_event",
              sourceTier: "explicit_user_statement",
              assertedAt: "2026-04-04T16:19:30.000Z",
              observedAt: "2026-04-04T16:19:30.000Z",
              validFrom: "2026-04-04T16:19:30.000Z",
              validTo: null,
              timePrecision: "instant",
              timeSource: "user_stated",
              derivedFromObservationIds: [
                " observation_profile_graph_store_identity_trim ",
                "observation_profile_graph_store_identity_trim"
              ],
              projectionSourceIds: [
                " episode_profile_graph_store_identity_trim ",
                "episode_profile_graph_store_identity_trim"
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
            journalEntryId: "journal_profile_graph_store_identity_trim_keep",
            watermark: 1,
            recordedAt: "2026-04-04T16:19:30.000Z",
            sourceTaskId: "task_profile_graph_store_identity_trim",
            sourceFingerprint: "fingerprint_profile_graph_store_identity_trim",
            mutationEnvelopeHash: null,
            observationIds: [
              " observation_profile_graph_store_identity_trim ",
              "observation_profile_graph_store_identity_trim"
            ],
            claimIds: [
              " claim_profile_graph_store_identity_trim ",
              " claim_profile_graph_store_identity_trim_successor "
            ],
            eventIds: [
              " event_profile_graph_store_identity_trim ",
              "event_profile_graph_store_identity_trim"
            ],
            redactionState: "not_requested"
          }]
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const observations = loaded.graph.observations.filter(
      (entry) => entry.payload.observationId === "observation_profile_graph_store_identity_trim"
    );
    assert.equal(observations.length, 1);
    assert.equal(
      observations[0]?.payload.sourceFingerprint,
      "fingerprint_profile_graph_store_identity_trim_new"
    );
    assert.deepEqual(observations[0]?.payload.entityRefIds, ["entity_owen"]);

    const claim = loaded.graph.claims.find(
      (entry) => entry.payload.claimId === "claim_profile_graph_store_identity_trim"
    );
    const successorClaim = loaded.graph.claims.find(
      (entry) => entry.payload.claimId === "claim_profile_graph_store_identity_trim_successor"
    );
    const event = loaded.graph.events.find(
      (entry) => entry.payload.eventId === "event_profile_graph_store_identity_trim"
    );

    assert.ok(claim);
    assert.equal(
      claim?.payload.endedByClaimId,
      "claim_profile_graph_store_identity_trim_successor"
    );
    assert.deepEqual(claim?.payload.derivedFromObservationIds, [
      "observation_profile_graph_store_identity_trim"
    ]);
    assert.deepEqual(claim?.payload.entityRefIds, ["entity_owen"]);

    assert.ok(successorClaim);
    assert.deepEqual(successorClaim?.payload.derivedFromObservationIds, [
      "observation_profile_graph_store_identity_trim"
    ]);
    assert.deepEqual(successorClaim?.payload.entityRefIds, ["entity_owen"]);

    assert.ok(event);
    assert.deepEqual(event?.payload.derivedFromObservationIds, [
      "observation_profile_graph_store_identity_trim"
    ]);
    assert.deepEqual(event?.payload.entityRefIds, ["entity_owen"]);

    assert.deepEqual(loaded.graph.mutationJournal.entries[0]?.observationIds, [
      "observation_profile_graph_store_identity_trim"
    ]);
    assert.deepEqual(loaded.graph.mutationJournal.entries[0]?.claimIds, [
      "claim_profile_graph_store_identity_trim",
      "claim_profile_graph_store_identity_trim_successor"
    ]);
    assert.deepEqual(loaded.graph.mutationJournal.entries[0]?.eventIds, [
      "event_profile_graph_store_identity_trim"
    ]);
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["employment.current"],
      "claim_profile_graph_store_identity_trim_successor"
    );
  });
});

test("profile memory load trims padded non-redacted event text and repairs blank event text", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:22:30.000Z",
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_event_text_trimmed",
            stableRefId: null,
            family: "episode.candidate",
            title: "  Avery follow-up  ",
            summary: "  Avery followed up later.  ",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_event_text_trimmed",
            sourceFingerprint: "fingerprint_profile_graph_store_event_text_trimmed",
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
            eventId: "event_profile_graph_store_event_text_blank",
            stableRefId: null,
            family: "episode.candidate",
            title: "   ",
            summary: "   ",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_event_text_blank",
            sourceFingerprint: "fingerprint_profile_graph_store_event_text_blank",
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
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const trimmedEvent = loaded.graph.events.find(
      (entry) => entry.payload.eventId === "event_profile_graph_store_event_text_trimmed"
    );
    const blankEvent = loaded.graph.events.find(
      (entry) => entry.payload.eventId === "event_profile_graph_store_event_text_blank"
    );

    assert.equal(trimmedEvent?.payload.title, "Avery follow-up");
    assert.equal(trimmedEvent?.payload.summary, "Avery followed up later.");
    assert.equal(blankEvent?.payload.title, "[untitled episode]");
    assert.equal(blankEvent?.payload.summary, "[missing episode summary]");
  });
});

test("profile memory load trims padded enum-like graph metadata before payload salvage", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:24:00.000Z",
        observations: [
          createPersistedGraphEnvelope(PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME, {
            observationId: "observation_profile_graph_store_enum_trimmed",
            stableRefId: null,
            family: "contact.relationship",
            normalizedKey: "contact.avery.relationship",
            normalizedValue: "friend",
            redactionState: "  not_requested  ",
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_enum_trimmed_observation",
            sourceFingerprint: "fingerprint_profile_graph_store_enum_trimmed_observation",
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
            claimId: "claim_profile_graph_store_enum_trimmed",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "   ",
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_enum_trimmed_claim",
            sourceFingerprint: "fingerprint_profile_graph_store_enum_trimmed_claim",
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
            eventId: "event_profile_graph_store_enum_trimmed",
            stableRefId: null,
            family: "episode.candidate",
            title: "Avery follow-up",
            summary: "Avery followed up later.",
            redactionState: "  redacted  ",
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_enum_trimmed_event",
            sourceFingerprint: "fingerprint_profile_graph_store_enum_trimmed_event",
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
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const observation = loaded.graph.observations.find(
      (entry) => entry.payload.observationId === "observation_profile_graph_store_enum_trimmed"
    );
    const claim = loaded.graph.claims.find(
      (entry) => entry.payload.claimId === "claim_profile_graph_store_enum_trimmed"
    );
    const event = loaded.graph.events.find(
      (entry) => entry.payload.eventId === "event_profile_graph_store_enum_trimmed"
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
});

test("profile memory load trims padded mutation-journal redaction state", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:26:00.000Z",
        events: [
          createPersistedGraphEnvelope(PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME, {
            eventId: "event_profile_graph_store_journal_redaction_trimmed",
            stableRefId: null,
            family: "episode.candidate",
            title: "Avery follow-up",
            summary: "Avery followed up later.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_journal_redaction_trimmed",
            sourceFingerprint: "fingerprint_profile_graph_store_journal_redaction_trimmed",
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
              journalEntryId: "journal_profile_graph_store_journal_redaction_trimmed",
              watermark: 1,
              recordedAt: "2026-04-04T16:25:30.000Z",
              sourceTaskId: "task_profile_graph_store_journal_redaction_trimmed",
              sourceFingerprint: "fingerprint_profile_graph_store_journal_redaction_trimmed",
              mutationEnvelopeHash: null,
              observationIds: [],
              claimIds: [],
              eventIds: ["event_profile_graph_store_journal_redaction_trimmed"],
              redactionState: "  requested  "
            }
          ]
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    assert.equal(
      loaded.graph.mutationJournal.entries[0]?.redactionState,
      "requested"
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.eventIds,
      ["event_profile_graph_store_journal_redaction_trimmed"]
    );
  });
});

test("profile memory load normalizes retained mutation-journal recordedAt", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:26:00.000Z",
        events: [
          createPersistedGraphEnvelope(PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME, {
            eventId: "event_profile_graph_store_journal_recorded_at_trimmed",
            stableRefId: null,
            family: "episode.candidate",
            title: "Avery follow-up",
            summary: "Avery followed up later.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_journal_recorded_at_trimmed",
            sourceFingerprint: "fingerprint_profile_graph_store_journal_recorded_at_trimmed",
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
              journalEntryId: "journal_profile_graph_store_journal_recorded_at_offset",
              watermark: 1,
              recordedAt: " 2026-04-04T11:25:30-05:00 ",
              sourceTaskId: "task_profile_graph_store_journal_recorded_at_offset",
              sourceFingerprint: "fingerprint_profile_graph_store_journal_recorded_at_offset",
              mutationEnvelopeHash: null,
              observationIds: [],
              claimIds: [],
              eventIds: ["event_profile_graph_store_journal_recorded_at_trimmed"],
              redactionState: "not_requested"
            },
            {
              journalEntryId: "journal_profile_graph_store_journal_recorded_at_fallback",
              watermark: 2,
              recordedAt: "not-a-date",
              sourceTaskId: "task_profile_graph_store_journal_recorded_at_fallback",
              sourceFingerprint: "fingerprint_profile_graph_store_journal_recorded_at_fallback",
              mutationEnvelopeHash: null,
              observationIds: [],
              claimIds: [],
              eventIds: ["event_profile_graph_store_journal_recorded_at_trimmed"],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.recordedAt),
      [
        "2026-04-04T16:25:30.000Z",
        "2026-04-04T16:26:00.000Z"
      ]
    );
  });
});

test("profile memory load repairs omitted and non-string retained mutation-journal recordedAt", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:27:00.000Z",
        events: [
          createPersistedGraphEnvelope(PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME, {
            eventId: "event_profile_graph_store_journal_recorded_at_missing_or_malformed",
            stableRefId: null,
            family: "episode.candidate",
            title: "Avery follow-up fallback",
            summary: "Avery followed up without retained store journal timestamps.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId:
              "task_profile_graph_store_journal_recorded_at_missing_or_malformed",
            sourceFingerprint:
              "fingerprint_profile_graph_store_journal_recorded_at_missing_or_malformed",
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
              journalEntryId: "journal_profile_graph_store_journal_recorded_at_omitted",
              watermark: 1,
              sourceTaskId: "task_profile_graph_store_journal_recorded_at_omitted",
              sourceFingerprint:
                "fingerprint_profile_graph_store_journal_recorded_at_omitted",
              mutationEnvelopeHash: null,
              observationIds: [],
              claimIds: [],
              eventIds: ["event_profile_graph_store_journal_recorded_at_missing_or_malformed"],
              redactionState: "not_requested"
            },
            {
              journalEntryId:
                "journal_profile_graph_store_journal_recorded_at_non_string",
              watermark: 2,
              recordedAt: 7 as unknown as string,
              sourceTaskId: "task_profile_graph_store_journal_recorded_at_non_string",
              sourceFingerprint:
                "fingerprint_profile_graph_store_journal_recorded_at_non_string",
              mutationEnvelopeHash: null,
              observationIds: [],
              claimIds: [],
              eventIds: ["event_profile_graph_store_journal_recorded_at_missing_or_malformed"],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.recordedAt),
      [
        "2026-04-04T16:27:00.000Z",
        "2026-04-04T16:27:00.000Z"
      ]
    );
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 3);
    assert.equal(loaded.graph.readModel.watermark, 2);
  });
});

test("profile memory load normalizes graph compaction lastCompactedAt", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:26:00.000Z",
        compaction: {
          ...emptyState.graph.compaction,
          snapshotWatermark: 7,
          lastCompactedAt: " 2026-04-04T11:25:30-05:00 ",
          maxObservationCount: 128,
          maxClaimCount: 256,
          maxEventCount: 64,
          maxJournalEntries: 32
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.equal(
      loaded.graph.compaction.lastCompactedAt,
      "2026-04-04T16:25:30.000Z"
    );
  });
});

test("profile memory load normalizes retained graph updatedAt", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: " 2026-04-04T11:25:30-05:00 "
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.equal(loaded.graph.updatedAt, "2026-04-04T16:25:30.000Z");
    assert.equal(loaded.graph.readModel.rebuiltAt, "2026-04-04T16:25:30.000Z");
  });
});

test("profile memory load normalizes retained graph envelope createdAt", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:26:00.000Z",
        observations: [
          createPersistedGraphEnvelope(PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME, {
            observationId: "observation_profile_graph_store_created_at_trimmed",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.avery.context.1",
            normalizedValue: "Avery followed up later.",
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_created_at_trimmed",
            sourceFingerprint: "fingerprint_profile_graph_store_created_at_trimmed",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:25:00.000Z",
            observedAt: "2026-04-04T16:25:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          }, " 2026-04-04T11:25:30-05:00 "),
          createPersistedGraphEnvelope(PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME, {
            observationId: "observation_profile_graph_store_created_at_fallback",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.avery.context.2",
            normalizedValue: "Avery replied the next day.",
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_created_at_fallback",
            sourceFingerprint: "fingerprint_profile_graph_store_created_at_fallback",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:25:00.000Z",
            observedAt: "2026-04-04T16:25:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          }, "not-a-date")
        ]
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.deepEqual(
      Object.fromEntries(
        loaded.graph.observations.map((observation) => [
          observation.payload.observationId,
          observation.createdAt
        ])
      ),
      {
        observation_profile_graph_store_created_at_trimmed: "2026-04-04T16:25:30.000Z",
        observation_profile_graph_store_created_at_fallback: "2026-04-04T16:26:00.000Z"
      }
    );
  });
});

test("profile memory load compacts observations against repaired redacted event lineage", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:21:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_redacted_event_lineage_old",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.1",
            normalizedValue: "Owen mentioned the issue.",
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_redacted_event_lineage_old",
            sourceFingerprint: "fingerprint_profile_graph_store_redacted_event_lineage_old",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:01:00.000Z",
            observedAt: "2026-04-04T16:01:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: ["entity_owen"]
          }),
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_redacted_event_lineage_new",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.milo.context.1",
            normalizedValue: "Milo followed up later.",
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_redacted_event_lineage_new",
            sourceFingerprint: "fingerprint_profile_graph_store_redacted_event_lineage_new",
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
            eventId: "event_profile_graph_store_redacted_event_lineage",
            stableRefId: null,
            family: "episode.candidate",
            title: "Raw forgotten event",
            summary: "Raw forgotten event summary.",
            redactionState: "redacted",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_redacted_event_lineage",
            sourceFingerprint: "fingerprint_profile_graph_store_redacted_event_lineage",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:01:30.000Z",
            observedAt: "2026-04-04T16:01:30.000Z",
            validFrom: "2026-04-04T16:01:30.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_store_redacted_event_lineage_old"],
            projectionSourceIds: ["episode_profile_graph_store_redacted_event_lineage"],
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
          maxEventCount: 1024,
          maxJournalEntries: 4096
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.deepEqual(
      loaded.graph.observations.map((observation) => observation.payload.observationId),
      ["observation_profile_graph_store_redacted_event_lineage_new"]
    );
    assert.deepEqual(
      loaded.graph.events[0]?.payload.derivedFromObservationIds,
      []
    );
  });
});

test("profile memory load prunes duplicate and dangling projection-source refs when retained source ids are padded", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      facts: [
        {
          id: " fact_profile_graph_store_projection_valid ",
          key: "identity.preferred_name",
          value: "Avery",
          sensitive: false,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_graph_store_projection_valid",
          source: "user_input_pattern.name_phrase",
          observedAt: "2026-04-04T16:16:00.000Z",
          confirmedAt: "2026-04-04T16:16:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-04T16:16:00.000Z"
        }
      ],
      episodes: [
        {
          id: " episode_profile_graph_store_projection_valid ",
          title: "Lantern sync",
          summary: "Lantern sync happened.",
          status: "unresolved",
          sourceTaskId: "task_profile_graph_store_projection_episode_valid",
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
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:17:00.000Z",
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_projection_duplicate",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_projection_duplicate",
            sourceFingerprint: "fingerprint_profile_graph_store_projection_duplicate",
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
              "fact_profile_graph_store_projection_valid",
              "fact_profile_graph_store_projection_missing",
              "fact_profile_graph_store_projection_valid",
              "episode_profile_graph_store_projection_valid"
            ],
            entityRefIds: [],
            active: true
          })
        ],
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_projection_duplicate",
            stableRefId: null,
            family: "episode.candidate",
            title: "Lantern sync",
            summary: "Lantern sync happened.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_projection_event_duplicate",
            sourceFingerprint: "fingerprint_profile_graph_store_projection_event_duplicate",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:16:30.000Z",
            observedAt: "2026-04-04T16:16:30.000Z",
            validFrom: "2026-04-04T16:16:30.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: [
              "episode_profile_graph_store_projection_valid",
              "episode_profile_graph_store_projection_missing",
              "episode_profile_graph_store_projection_valid",
              "fact_profile_graph_store_projection_valid"
            ],
            entityRefIds: []
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.deepEqual(
      loaded.graph.claims[0]?.payload.projectionSourceIds,
      ["fact_profile_graph_store_projection_valid"]
    );
    assert.deepEqual(
      loaded.graph.events[0]?.payload.projectionSourceIds,
      ["episode_profile_graph_store_projection_valid"]
    );
  });
});

test("profile memory load prunes duplicate entity refs from retained graph payloads", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T16:20:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_entity_ref_payload_duplicate",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.1",
            normalizedValue: "Owen mentioned Lantern.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_entity_ref_payload_duplicate_observation",
            sourceFingerprint:
              "fingerprint_profile_graph_store_entity_ref_payload_duplicate_observation",
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
            claimId: "claim_profile_graph_store_entity_ref_payload_duplicate",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_entity_ref_payload_duplicate_claim",
            sourceFingerprint: "fingerprint_profile_graph_store_entity_ref_payload_duplicate_claim",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:15:00.000Z",
            validFrom: "2026-04-04T16:15:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_entity_ref_payload_duplicate"],
            entityRefIds: ["entity_lantern", "entity_lantern", "entity_lantern"],
            active: true
          })
        ],
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_entity_ref_payload_duplicate",
            stableRefId: null,
            family: "episode.candidate",
            title: "Lantern sync",
            summary: "Lantern sync happened.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_entity_ref_payload_duplicate_event",
            sourceFingerprint: "fingerprint_profile_graph_store_entity_ref_payload_duplicate_event",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T16:15:00.000Z",
            observedAt: "2026-04-04T16:15:00.000Z",
            validFrom: "2026-04-04T16:15:00.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["episode_profile_graph_store_entity_ref_payload_duplicate"],
            entityRefIds: ["entity_lantern", "entity_lantern"]
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const seededObservation = loaded.graph.observations.find(
      (observation) =>
        observation.payload.observationId ===
        "observation_profile_graph_store_entity_ref_payload_duplicate"
    );
    assert.deepEqual(
      seededObservation?.payload.entityRefIds,
      ["entity_owen"]
    );
    assert.deepEqual(
      loaded.graph.claims[0]?.payload.entityRefIds,
      ["entity_lantern"]
    );
    assert.deepEqual(
      loaded.graph.events[0]?.payload.entityRefIds,
      ["entity_lantern"]
    );
  });
});

test("profile memory load prunes dangling journal refs to missing graph records", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const emptyGraphState = (({ compaction, mutationJournal, ...graphState }) => graphState)(
      emptyState.graph
    );
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyGraphState,
        updatedAt: "2026-04-04T15:00:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_journal_ref_valid",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_journal_ref_valid",
            sourceFingerprint: "fingerprint_profile_graph_store_journal_ref_valid",
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
            claimId: "claim_profile_graph_store_journal_ref_valid",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_journal_ref_valid",
            sourceFingerprint: "fingerprint_profile_graph_store_journal_ref_valid",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T14:55:00.000Z",
            validFrom: "2026-04-04T14:55:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_store_journal_ref_valid"],
            projectionSourceIds: ["fact_profile_graph_store_journal_ref_valid"],
            entityRefIds: [],
            active: true
          })
        ],
        compaction: {
          ...emptyState.graph.compaction,
          snapshotWatermark: 1,
          lastCompactedAt: "2026-04-03T20:00:00.000Z"
        },
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 3,
          entries: [
            {
              journalEntryId: "journal_profile_graph_store_journal_ref_keep",
              watermark: 1,
              recordedAt: "2026-04-04T14:55:00.000Z",
              sourceTaskId: "task_profile_graph_store_journal_ref_keep",
              sourceFingerprint: "fingerprint_profile_graph_store_journal_ref_keep",
              mutationEnvelopeHash: null,
              observationIds: [
                "observation_profile_graph_store_journal_ref_valid",
                "observation_profile_graph_store_missing"
              ],
              claimIds: [
                "claim_profile_graph_store_journal_ref_missing",
                "claim_profile_graph_store_journal_ref_valid"
              ],
              eventIds: ["event_profile_graph_store_missing"],
              redactionState: "not_requested"
            },
            {
              journalEntryId: "journal_profile_graph_store_journal_ref_drop",
              watermark: 2,
              recordedAt: "2026-04-04T14:56:00.000Z",
              sourceTaskId: "task_profile_graph_store_journal_ref_drop",
              sourceFingerprint: "fingerprint_profile_graph_store_journal_ref_drop",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_missing_only"],
              claimIds: ["claim_profile_graph_store_journal_ref_missing_only"],
              eventIds: ["event_profile_graph_store_missing_only"],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const canonicalJournalEntryId =
      `journal_${sha256HexFromCanonicalJson({
        recordedAt: "2026-04-04T14:55:00.000Z",
        sourceTaskId: "task_profile_graph_store_journal_ref_keep",
        sourceFingerprint: "fingerprint_profile_graph_store_journal_ref_keep",
        mutationEnvelopeHash: null,
        observationIds: ["observation_profile_graph_store_journal_ref_valid"],
        claimIds: ["claim_profile_graph_store_journal_ref_valid"],
        eventIds: [],
        redactionState: "not_requested"
      }).slice(0, 24)}`;
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.journalEntryId),
      [canonicalJournalEntryId]
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.claimIds,
      ["claim_profile_graph_store_journal_ref_valid"]
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.observationIds,
      ["observation_profile_graph_store_journal_ref_valid"]
    );
    assert.deepEqual(loaded.graph.mutationJournal.entries[0]?.eventIds, []);
  });
});

test("profile memory load collapses pruned journal entries that converge on one canonical replay payload", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const canonicalJournalEntryId =
      `journal_${sha256HexFromCanonicalJson({
        recordedAt: "2026-04-04T15:05:00.000Z",
        sourceTaskId: "task_profile_graph_store_journal_ref_collapse",
        sourceFingerprint: "fingerprint_profile_graph_store_journal_ref_collapse",
        mutationEnvelopeHash: null,
        observationIds: ["observation_profile_graph_store_journal_ref_collapse_valid"],
        claimIds: ["claim_profile_graph_store_journal_ref_collapse_valid"],
        eventIds: [],
        redactionState: "not_requested"
      }).slice(0, 24)}`;
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T15:10:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_journal_ref_collapse_valid",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.help",
            normalizedValue: "Owen still needs help",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_journal_ref_collapse",
            sourceFingerprint: "fingerprint_profile_graph_store_journal_ref_collapse",
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
            claimId: "claim_profile_graph_store_journal_ref_collapse_valid",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.help",
            normalizedValue: "Owen still needs help",            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_journal_ref_collapse",
            sourceFingerprint: "fingerprint_profile_graph_store_journal_ref_collapse",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T15:05:00.000Z",
            validFrom: "2026-04-04T15:05:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [
              "observation_profile_graph_store_journal_ref_collapse_valid"
            ],
            projectionSourceIds: [],
            entityRefIds: [],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 3,
          entries: [
            {
              journalEntryId: "journal_profile_graph_store_journal_ref_collapse_a",
              watermark: 1,
              recordedAt: "2026-04-04T15:05:00.000Z",
              sourceTaskId: "task_profile_graph_store_journal_ref_collapse",
              sourceFingerprint: "fingerprint_profile_graph_store_journal_ref_collapse",
              mutationEnvelopeHash: null,
              observationIds: [
                "observation_profile_graph_store_journal_ref_collapse_valid",
                "observation_profile_graph_store_journal_ref_collapse_missing"
              ],
              claimIds: ["claim_profile_graph_store_journal_ref_collapse_valid"],
              eventIds: [],
              redactionState: "not_requested"
            },
            {
              journalEntryId: "journal_profile_graph_store_journal_ref_collapse_b",
              watermark: 2,
              recordedAt: "2026-04-04T15:05:00.000Z",
              sourceTaskId: "task_profile_graph_store_journal_ref_collapse",
              sourceFingerprint: "fingerprint_profile_graph_store_journal_ref_collapse",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_journal_ref_collapse_valid"],
              claimIds: ["claim_profile_graph_store_journal_ref_collapse_valid"],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        },
        compaction: {
          ...emptyState.graph.compaction,
          snapshotWatermark: 1,
          lastCompactedAt: "2026-04-04T15:00:00.000Z"
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    assert.equal(loaded.graph.mutationJournal.entries[0]?.journalEntryId, canonicalJournalEntryId);
    assert.equal(loaded.graph.mutationJournal.entries[0]?.watermark, 2);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.observationIds,
      ["observation_profile_graph_store_journal_ref_collapse_valid"]
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.claimIds,
      ["claim_profile_graph_store_journal_ref_collapse_valid"]
    );
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 3);
  });
});

test("profile memory load collapses semantic-duplicate active claims to one canonical winner", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      facts: [
        {
          id: "fact_profile_graph_store_duplicate_active_1",
          key: "identity.preferred_name",
          value: "Avery",
          sensitive: true,
          status: "confirmed",
          confidence: 0.92,
          sourceTaskId: "task_profile_graph_store_duplicate_active_1",
          source: "user_input_pattern.name_phrase",
          observedAt: "2026-04-04T13:00:00.000Z",
          confirmedAt: "2026-04-04T13:00:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-04T13:00:00.000Z"
        },
        {
          id: "fact_profile_graph_store_duplicate_active_2",
          key: "identity.preferred_name",
          value: "Avery",
          sensitive: false,
          status: "uncertain",
          confidence: 0.71,
          sourceTaskId: "task_profile_graph_store_duplicate_active_2",
          source: "user_input_pattern.name_phrase",
          observedAt: "2026-04-04T13:05:00.000Z",
          confirmedAt: null,
          supersededAt: null,
          lastUpdatedAt: "2026-04-04T13:05:00.000Z"
        }
      ],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-04T14:10:00.000Z",
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_duplicate_active_1",
            stableRefId: "stable_avery",
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: true,
            sourceTaskId: "task_profile_graph_store_duplicate_active_1",
            sourceFingerprint: "fingerprint_profile_graph_store_duplicate_active_1",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T13:00:00.000Z",
            validFrom: "2026-04-04T13:00:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_store_duplicate_active_1"],
            projectionSourceIds: ["fact_profile_graph_store_duplicate_active_1"],
            entityRefIds: ["entity_avery"],
            active: true
          }, "2026-04-04T13:00:00.000Z"),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_duplicate_active_2",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: null,
            sourceFingerprint: "fingerprint_profile_graph_store_duplicate_active_2",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-04T13:05:00.000Z",
            validFrom: "2026-04-04T13:05:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_store_duplicate_active_2"],
            projectionSourceIds: ["fact_profile_graph_store_duplicate_active_2"],
            entityRefIds: [],
            active: true
          }, "2026-04-04T13:05:00.000Z")
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 3,
          entries: [
            {
              journalEntryId: "journal_profile_graph_store_duplicate_active_1",
              watermark: 1,
              recordedAt: "2026-04-04T13:00:00.000Z",
              sourceTaskId: "task_profile_graph_store_duplicate_active_1",
              sourceFingerprint: "fingerprint_profile_graph_store_duplicate_active_1",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_duplicate_active_1"],
              claimIds: ["claim_profile_graph_store_duplicate_active_1"],
              eventIds: [],
              redactionState: "not_requested"
            },
            {
              journalEntryId: "journal_profile_graph_store_duplicate_active_2",
              watermark: 2,
              recordedAt: "2026-04-04T13:05:00.000Z",
              sourceTaskId: "task_profile_graph_store_duplicate_active_2",
              sourceFingerprint: "fingerprint_profile_graph_store_duplicate_active_2",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_duplicate_active_2"],
              claimIds: ["claim_profile_graph_store_duplicate_active_2"],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.equal(loaded.graph.claims.length, 3);
    assert.equal(loaded.graph.observations.length, 1);
    const activeClaims = loaded.graph.claims.filter((claim) => claim.payload.active);
    const inactiveClaims = loaded.graph.claims.filter((claim) => !claim.payload.active);
    assert.equal(activeClaims.length, 1);
    assert.equal(inactiveClaims.length, 2);
    assert.notEqual(
      activeClaims[0]?.payload.claimId,
      "claim_profile_graph_store_duplicate_active_1"
    );
    assert.notEqual(
      activeClaims[0]?.payload.claimId,
      "claim_profile_graph_store_duplicate_active_2"
    );
    assert.equal(activeClaims[0]?.payload.stableRefId, "stable_self_profile_owner");
    assert.equal(activeClaims[0]?.payload.sensitive, true);
    assert.deepEqual(
      [...(activeClaims[0]?.payload.derivedFromObservationIds ?? [])].sort((left, right) =>
        left.localeCompare(right)
      ),
      loaded.graph.observations
        .map((observation) => observation.payload.observationId)
        .sort((left, right) => left.localeCompare(right))
    );
    assert.deepEqual(activeClaims[0]?.payload.projectionSourceIds, [
      "fact_profile_graph_store_duplicate_active_1"
    ]);
    assert.deepEqual(activeClaims[0]?.payload.entityRefIds, []);
    assert.deepEqual(
      inactiveClaims.map((claim) => claim.payload.endedByClaimId),
      [activeClaims[0]?.payload.claimId, activeClaims[0]?.payload.claimId]
    );
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
      activeClaims[0]?.payload.claimId
    );
    assert.deepEqual(
      loaded.graph.readModel.inventoryClaimIdsByFamily["identity.preferred_name"],
      [activeClaims[0]?.payload.claimId]
    );
    assert.deepEqual(loaded.graph.readModel.conflictingCurrentClaimIdsByKey, {});
    assert.deepEqual(loaded.graph.indexes.activeClaimIds, [
      activeClaims[0]?.payload.claimId
    ]);
  });
});

test("profile memory load keeps semantic-duplicate retained current claims from inheriting stale loser lineage or provenance metadata", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-06T16:10:00.000Z",
      facts: [
        {
          id: "fact_profile_graph_store_duplicate_loser_lineage_old",
          key: "identity.preferred_name",
          value: "Avery",
          sensitive: false,
          status: "superseded",
          confidence: 0.6,
          sourceTaskId: "task_profile_graph_store_duplicate_loser_lineage_old",
          source: "user_input_pattern.name_phrase",
          observedAt: "2026-04-06T13:00:00.000Z",
          confirmedAt: "2026-04-06T13:00:00.000Z",
          supersededAt: "2026-04-06T15:30:00.000Z",
          lastUpdatedAt: "2026-04-06T15:30:00.000Z"
        },
        {
          id: "fact_profile_graph_store_duplicate_loser_lineage_current",
          key: "identity.preferred_name",
          value: "Avery",
          sensitive: false,
          status: "superseded",
          confidence: 0.7,
          sourceTaskId: "task_profile_graph_store_duplicate_loser_lineage_current",
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
            observationId: "observation_profile_graph_store_duplicate_loser_lineage_old",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_duplicate_loser_lineage_old",
            sourceFingerprint: "fingerprint_profile_graph_store_duplicate_loser_lineage_old",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-06T13:00:00.000Z",
            observedAt: "2026-04-06T13:00:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          }, "2026-04-06T13:00:00.000Z"),
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_duplicate_loser_lineage_current",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_duplicate_loser_lineage_current",
            sourceFingerprint: "fingerprint_profile_graph_store_duplicate_loser_lineage_current",
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
            claimId: "claim_profile_graph_store_duplicate_loser_lineage_old",
            stableRefId: "stable_avery_old",
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_duplicate_loser_lineage_old",
            sourceFingerprint: "fingerprint_profile_graph_store_duplicate_loser_lineage_old",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-06T13:00:00.000Z",
            validFrom: "2026-04-06T13:00:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_store_duplicate_loser_lineage_old"],
            projectionSourceIds: ["fact_profile_graph_store_duplicate_loser_lineage_old"],
            entityRefIds: ["entity_avery_stray"],
            active: true
          }, "2026-04-06T13:00:00.000Z"),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_duplicate_loser_lineage_current",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: null,
            sourceFingerprint: "fingerprint_profile_graph_store_duplicate_loser_lineage_current",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-06T13:05:00.000Z",
            validFrom: "2026-04-06T13:05:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_store_duplicate_loser_lineage_current"],
            projectionSourceIds: ["fact_profile_graph_store_duplicate_loser_lineage_current"],
            entityRefIds: [],
            active: true
          }, "2026-04-06T13:05:00.000Z")
        ]
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.equal(loaded.graph.claims.length, 2);
    assert.equal(loaded.graph.observations.length, 2);
    const activeClaims = loaded.graph.claims.filter((claim) => claim.payload.active);
    const inactiveClaims = loaded.graph.claims.filter((claim) => !claim.payload.active);
    assert.equal(activeClaims.length, 1);
    assert.equal(inactiveClaims.length, 1);
    assert.equal(
      activeClaims[0]?.payload.claimId,
      "claim_profile_graph_store_duplicate_loser_lineage_current"
    );
    assert.equal(activeClaims[0]?.payload.stableRefId, "stable_self_profile_owner");
    assert.equal(activeClaims[0]?.payload.sourceTaskId, null);
    assert.deepEqual(
      [...(activeClaims[0]?.payload.derivedFromObservationIds ?? [])].sort((left, right) =>
        left.localeCompare(right)
      ),
      [
        "observation_profile_graph_store_duplicate_loser_lineage_current",
        "observation_profile_graph_store_duplicate_loser_lineage_old"
      ]
    );
    assert.deepEqual(activeClaims[0]?.payload.projectionSourceIds, [
      "fact_profile_graph_store_duplicate_loser_lineage_current"
    ]);
    assert.deepEqual(activeClaims[0]?.payload.entityRefIds, []);
    assert.equal(
      inactiveClaims[0]?.payload.endedByClaimId,
      "claim_profile_graph_store_duplicate_loser_lineage_current"
    );
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
      "claim_profile_graph_store_duplicate_loser_lineage_current"
    );
    assert.deepEqual(
      loaded.graph.readModel.inventoryClaimIdsByFamily["identity.preferred_name"],
      ["claim_profile_graph_store_duplicate_loser_lineage_current"]
    );
    assert.deepEqual(loaded.graph.readModel.conflictingCurrentClaimIdsByKey, {});
    assert.deepEqual(loaded.graph.indexes.activeClaimIds, [
      "claim_profile_graph_store_duplicate_loser_lineage_current"
    ]);
  });
});

test("profile memory load keeps current-surface-ineligible semantic duplicates from closing valid explicit claims", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-06T03:10:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_duplicate_invalid_explicit",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_duplicate_invalid_explicit",
            sourceFingerprint: "fingerprint_profile_graph_store_duplicate_invalid_explicit",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-06T02:00:00.000Z",
            observedAt: "2026-04-06T02:00:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          }),
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_duplicate_invalid_assistant",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_duplicate_invalid_assistant",
            sourceFingerprint: "fingerprint_profile_graph_store_duplicate_invalid_assistant",
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
            claimId: "claim_profile_graph_store_duplicate_invalid_explicit",
            stableRefId: "stable_avery_explicit",
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_duplicate_invalid_explicit",
            sourceFingerprint: "fingerprint_profile_graph_store_duplicate_invalid_explicit",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-06T02:00:00.000Z",
            validFrom: "2026-04-06T02:00:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_store_duplicate_invalid_explicit"],
            projectionSourceIds: ["fact_profile_graph_store_duplicate_invalid_explicit"],
            entityRefIds: ["entity_avery"],
            active: true
          }, "2026-04-06T02:00:00.000Z"),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_duplicate_invalid_assistant",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_duplicate_invalid_assistant",
            sourceFingerprint: "fingerprint_profile_graph_store_duplicate_invalid_assistant",
            sourceTier: "assistant_inference",
            assertedAt: "2026-04-06T02:05:00.000Z",
            validFrom: "2026-04-06T02:05:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "inferred",
            derivedFromObservationIds: ["observation_profile_graph_store_duplicate_invalid_assistant"],
            projectionSourceIds: ["fact_profile_graph_store_duplicate_invalid_assistant"],
            entityRefIds: [],
            active: true
          }, "2026-04-06T02:05:00.000Z")
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 3,
          entries: [
            {
              journalEntryId: "journal_profile_graph_store_duplicate_invalid_explicit",
              watermark: 1,
              recordedAt: "2026-04-06T02:00:00.000Z",
              sourceTaskId: "task_profile_graph_store_duplicate_invalid_explicit",
              sourceFingerprint: "fingerprint_profile_graph_store_duplicate_invalid_explicit",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_duplicate_invalid_explicit"],
              claimIds: ["claim_profile_graph_store_duplicate_invalid_explicit"],
              eventIds: [],
              redactionState: "not_requested"
            },
            {
              journalEntryId: "journal_profile_graph_store_duplicate_invalid_assistant",
              watermark: 2,
              recordedAt: "2026-04-06T02:05:00.000Z",
              sourceTaskId: "task_profile_graph_store_duplicate_invalid_assistant",
              sourceFingerprint: "fingerprint_profile_graph_store_duplicate_invalid_assistant",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_duplicate_invalid_assistant"],
              claimIds: ["claim_profile_graph_store_duplicate_invalid_assistant"],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.claims.length, 2);
    assert.equal(loaded.graph.observations.length, 2);
    const activeClaims = loaded.graph.claims.filter((claim) => claim.payload.active);
    assert.equal(activeClaims.length, 2);
    assert.deepEqual(
      activeClaims.map((claim) => claim.payload.claimId).sort((left, right) => left.localeCompare(right)),
      [
        "claim_profile_graph_store_duplicate_invalid_assistant",
        "claim_profile_graph_store_duplicate_invalid_explicit"
      ]
    );
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
      "claim_profile_graph_store_duplicate_invalid_explicit"
    );
    assert.deepEqual(
      loaded.graph.readModel.inventoryClaimIdsByFamily["identity.preferred_name"],
      ["claim_profile_graph_store_duplicate_invalid_explicit"]
    );
    assert.deepEqual(loaded.graph.readModel.conflictingCurrentClaimIdsByKey, {});
    assert.deepEqual(
      loaded.graph.indexes.activeClaimIds.sort((left, right) => left.localeCompare(right)),
      [
        "claim_profile_graph_store_duplicate_invalid_assistant",
        "claim_profile_graph_store_duplicate_invalid_explicit"
      ]
    );
  });
});

test("profile memory load dedupes duplicate journal entries and repairs replay watermarks", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:15:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_store_1",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.1",
            normalizedValue: "Owen still needs help",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_duplicate_observation",
            sourceFingerprint: "fingerprint_profile_graph_store_duplicate_observation",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:01:00.000Z",
            observedAt: "2026-04-03T21:01:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          })
        ],
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_store_1",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_duplicate_claim",
            sourceFingerprint: "fingerprint_profile_graph_store_duplicate_claim",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:02:00.000Z",
            validFrom: "2026-04-03T21:02:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_store_duplicate_claim_1"],
            entityRefIds: [],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 3,
          entries: [
            {
              journalEntryId: "journal_profile_graph_store_duplicate_a",
              watermark: 1,
              recordedAt: "2026-04-03T21:01:00.000Z",
              sourceTaskId: "task_profile_graph_store_duplicate_a",
              sourceFingerprint: "fingerprint_profile_graph_store_duplicate_a",
              mutationEnvelopeHash: null,
              observationIds: ["observation_store_1", "observation_store_1"],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            },
            {
              journalEntryId: "journal_profile_graph_store_duplicate_a",
              watermark: 2,
              recordedAt: "2026-04-03T21:01:00.000Z",
              sourceTaskId: "task_profile_graph_store_duplicate_a",
              sourceFingerprint: "fingerprint_profile_graph_store_duplicate_a",
              mutationEnvelopeHash: null,
              observationIds: ["observation_store_1"],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            },
          {
            journalEntryId: "journal_profile_graph_store_duplicate_b",
            watermark: 2,
            recordedAt: "2026-04-03T21:02:00.000Z",
              sourceTaskId: "task_profile_graph_store_duplicate_b",
              sourceFingerprint: "fingerprint_profile_graph_store_duplicate_b",
              mutationEnvelopeHash: null,
              observationIds: [],
              claimIds: ["claim_store_1", "claim_store_1"],
              eventIds: [],
            redactionState: "not_requested"
          }
        ]
        },
        compaction: {
          ...emptyState.graph.compaction,
          snapshotWatermark: 1,
          lastCompactedAt: "2026-04-03T20:00:00.000Z"
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.mutationJournal.entries.length, 2);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.journalEntryId),
      [
        "journal_profile_graph_store_duplicate_a",
        "journal_profile_graph_store_duplicate_b"
      ]
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [2, 3]
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.observationIds,
      ["observation_store_1"]
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[1]?.claimIds,
      ["claim_store_1"]
    );
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 4);
    assert.equal(loaded.graph.readModel.watermark, 3);
  });
});

test("profile memory load breaks same-id same-watermark journal freshness ties by canonical replay payload", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const sharedJournalEntryId = "journal_profile_graph_store_duplicate_payload_tie";
    const sharedObservationId = "observation_store_payload_tie_shared";
    const leftPayloadSourceFingerprint =
      "fingerprint_profile_graph_store_duplicate_payload_tie_left";
    const rightPayloadSourceFingerprint =
      "fingerprint_profile_graph_store_duplicate_payload_tie_right";
    const leftCanonicalJournalEntryId =
      `journal_${sha256HexFromCanonicalJson({
        recordedAt: "2026-04-03T21:03:00.000Z",
        sourceTaskId: "task_profile_graph_store_duplicate_payload_tie",
        sourceFingerprint: leftPayloadSourceFingerprint,
        mutationEnvelopeHash: null,
        observationIds: [sharedObservationId],
        claimIds: [],
        eventIds: [],
        redactionState: "not_requested"
      }).slice(0, 24)}`;
    const rightCanonicalJournalEntryId =
      `journal_${sha256HexFromCanonicalJson({
        recordedAt: "2026-04-03T21:03:00.000Z",
        sourceTaskId: "task_profile_graph_store_duplicate_payload_tie",
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
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:05:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: sharedObservationId,
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.store.payload.tie.shared",
            normalizedValue: "Owen still needs shared help",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_duplicate_payload_tie",
            sourceFingerprint: "fingerprint_profile_graph_store_duplicate_payload_tie_seed",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:03:00.000Z",
            observedAt: "2026-04-03T21:03:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 2,
          entries: [
            {
              journalEntryId: sharedJournalEntryId,
              watermark: 1,
              recordedAt: "2026-04-03T21:03:00.000Z",
              sourceTaskId: "task_profile_graph_store_duplicate_payload_tie",
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
              recordedAt: "2026-04-03T21:03:00.000Z",
              sourceTaskId: "task_profile_graph_store_duplicate_payload_tie",
              sourceFingerprint: expectedSourceFingerprint,
              mutationEnvelopeHash: null,
              observationIds: [sharedObservationId],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    assert.equal(loaded.graph.mutationJournal.entries[0]?.journalEntryId, sharedJournalEntryId);
    assert.equal(
      loaded.graph.mutationJournal.entries[0]?.sourceFingerprint,
      expectedSourceFingerprint
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.observationIds,
      [sharedObservationId]
    );
    assert.equal(loaded.graph.mutationJournal.entries[0]?.watermark, 1);
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 2);
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("profile memory load dedupes retained journal entries that share one canonical replay payload but carry different stored ids", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const canonicalJournalEntryId =
      `journal_${sha256HexFromCanonicalJson({
        recordedAt: "2026-04-03T21:01:00.000Z",
        sourceTaskId: "task_profile_graph_store_duplicate_payload",
        sourceFingerprint: "fingerprint_profile_graph_store_duplicate_payload",
        mutationEnvelopeHash: null,
        observationIds: ["observation_store_payload_1"],
        claimIds: [],
        eventIds: [],
        redactionState: "not_requested"
      }).slice(0, 24)}`;
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:05:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_store_payload_1",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.payload",
            normalizedValue: "Owen still needs help",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_duplicate_payload",
            sourceFingerprint: "fingerprint_profile_graph_store_duplicate_payload",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:01:00.000Z",
            observedAt: "2026-04-03T21:01:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
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
              recordedAt: "2026-04-03T21:01:00.000Z",
              sourceTaskId: "task_profile_graph_store_duplicate_payload",
              sourceFingerprint: "fingerprint_profile_graph_store_duplicate_payload",
              mutationEnvelopeHash: null,
              observationIds: ["observation_store_payload_1"],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            },
            {
              journalEntryId: "journal_profile_graph_store_duplicate_payload_legacy",
              watermark: 2,
              recordedAt: "2026-04-03T21:01:00.000Z",
              sourceTaskId: "task_profile_graph_store_duplicate_payload",
              sourceFingerprint: "fingerprint_profile_graph_store_duplicate_payload",
              mutationEnvelopeHash: null,
              observationIds: ["observation_store_payload_1"],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    assert.equal(loaded.graph.mutationJournal.entries[0]?.journalEntryId, canonicalJournalEntryId);
    assert.equal(loaded.graph.mutationJournal.entries[0]?.watermark, 2);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.observationIds,
      ["observation_store_payload_1"]
    );
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 3);
    assert.equal(loaded.graph.readModel.watermark, 2);
  });
});

test("profile memory load backfills missing graph events and replay markers from legacy episodes", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const expectedEventId =
      `event_${sha256HexFromCanonicalJson({ episodeId: "episode_profile_graph_store_event_backfill" }).slice(0, 24)}`;
    const seededEpisode = {
      ...createProfileEpisodeRecord({
        title: "Owen tax follow-up",
        summary: "Owen still needs to send the tax form.",
        sourceTaskId: "task_profile_graph_store_event_backfill",
        source: "test.seed",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt: "2026-04-03T21:20:00.000Z",
        confidence: 0.88,
        entityRefs: ["entity_owen"],
        openLoopRefs: ["open_loop_owen_tax"],
        tags: ["followup"]
      }),
      id: " episode_profile_graph_store_event_backfill "
    };
    const seededState = {
      ...emptyState,
      episodes: [seededEpisode],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:25:00.000Z",
        events: [],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.events.length, 1);
    assert.equal(loaded.graph.events[0]?.payload.eventId, expectedEventId);
    assert.equal(
      loaded.graph.events[0]?.payload.projectionSourceIds[0],
      "episode_profile_graph_store_event_backfill"
    );
    assert.equal(loaded.graph.events[0]?.payload.summary, seededEpisode.summary);
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.eventIds,
      [expectedEventId]
    );
    assert.equal(loaded.graph.mutationJournal.entries[0]?.sourceTaskId, null);
    assert.equal(
      loaded.graph.mutationJournal.entries[0]?.sourceFingerprint?.startsWith("graph_event_replay_backfill_"),
      true
    );
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 2);
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("profile memory load repairs current-surface-ineligible retained unresolved events from surviving episodes", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const canonicalEpisodeId = "episode_profile_graph_store_event_repair";
    const expectedEventId =
      `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
    const seededEpisode = {
      ...createProfileEpisodeRecord({
        title: "Owen tax follow-up",
        summary: "Owen still needs to send the tax form.",
        sourceTaskId: "task_profile_graph_store_event_repair",
        source: "user_input_pattern.episode_candidate",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt: "2026-04-07T14:30:00.000Z",
        confidence: 0.88,
        entityRefs: ["entity_owen"],
        openLoopRefs: ["open_loop_owen_tax"],
        tags: ["followup"]
      }),
      id: ` ${canonicalEpisodeId} `
    };
    const seededState = {
      ...emptyState,
      episodes: [seededEpisode],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-07T15:00:00.000Z",
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
            sourceTaskId: "task_profile_graph_store_event_repair_stale",
            sourceFingerprint: "fingerprint_profile_graph_store_event_repair_stale",
            sourceTier: "validated_structured_candidate",
            assertedAt: "2026-04-07T14:10:00.000Z",
            observedAt: "2026-04-07T14:10:00.000Z",
            validFrom: "2026-04-07T14:10:00.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["episode_profile_graph_store_event_repair_wrong"],
            entityRefIds: ["entity_owen"]
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.events.length, 1);
    assert.equal(loaded.graph.events[0]?.payload.eventId, expectedEventId);
    assert.equal(loaded.graph.events[0]?.payload.title, seededEpisode.title);
    assert.equal(loaded.graph.events[0]?.payload.summary, seededEpisode.summary);
    assert.equal(loaded.graph.events[0]?.payload.sourceTier, "explicit_user_statement");
    assert.deepEqual(
      loaded.graph.events[0]?.payload.projectionSourceIds,
      [canonicalEpisodeId]
    );
    assert.equal(
      loaded.graph.events[0]?.payload.sourceFingerprint?.startsWith("graph_event_backfill_"),
      true
    );
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.eventIds,
      [expectedEventId]
    );
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("profile memory load repairs retained unresolved events missing the surviving canonical episode projection source", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const canonicalEpisodeId = "episode_profile_graph_store_event_projection_repair";
    const expectedEventId =
      `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
    const seededEpisode = {
      ...createProfileEpisodeRecord({
        title: "Owen tax follow-up",
        summary: "Owen still needs to send the tax form.",
        sourceTaskId: "task_profile_graph_store_event_projection_repair",
        source: "user_input_pattern.episode_candidate",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt: "2026-04-07T14:35:00.000Z",
        confidence: 0.88,
        entityRefs: ["entity_owen"],
        openLoopRefs: ["open_loop_owen_tax"],
        tags: ["followup"]
      }),
      id: ` ${canonicalEpisodeId} `
    };
    const seededState = {
      ...emptyState,
      episodes: [seededEpisode],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-07T15:10:00.000Z",
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
            sourceTaskId: "task_profile_graph_store_event_projection_repair_stale",
            sourceFingerprint: "fingerprint_profile_graph_store_event_projection_repair_stale",
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
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.events.length, 1);
    assert.equal(loaded.graph.events[0]?.payload.eventId, expectedEventId);
    assert.equal(loaded.graph.events[0]?.payload.title, seededEpisode.title);
    assert.equal(loaded.graph.events[0]?.payload.summary, seededEpisode.summary);
    assert.deepEqual(
      loaded.graph.events[0]?.payload.projectionSourceIds,
      [canonicalEpisodeId]
    );
    assert.equal(
      loaded.graph.events[0]?.payload.sourceFingerprint?.startsWith("graph_event_backfill_"),
      true
    );
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.eventIds,
      [expectedEventId]
    );
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("profile memory load repairs retained unresolved events whose same-id payload no longer matches the surviving episode", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const canonicalEpisodeId = "episode_profile_graph_store_event_payload_repair";
    const expectedEventId =
      `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
    const retainedCreatedAt = "2026-04-07T14:12:00.000Z";
    const seededEpisode = {
      ...createProfileEpisodeRecord({
        title: "Owen tax follow-up",
        summary: "Owen still needs to send the tax form.",
        sourceTaskId: "task_profile_graph_store_event_payload_repair",
        source: "user_input_pattern.episode_candidate",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt: "2026-04-07T14:45:00.000Z",
        confidence: 0.88,
        entityRefs: ["entity_owen", "entity_tax_form"],
        openLoopRefs: ["open_loop_owen_tax"],
        tags: ["followup"]
      }),
      id: canonicalEpisodeId
    };
    const seededState = {
      ...emptyState,
      episodes: [seededEpisode],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-07T15:20:00.000Z",
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
            sourceTaskId: "task_profile_graph_store_event_payload_repair_stale",
            sourceFingerprint: "fingerprint_profile_graph_store_event_payload_repair_stale",
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
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.events.length, 1);
    assert.equal(loaded.graph.events[0]?.payload.eventId, expectedEventId);
    assert.equal(loaded.graph.events[0]?.createdAt, retainedCreatedAt);
    assert.equal(loaded.graph.events[0]?.payload.title, "Owen tax follow-up");
    assert.equal(
      loaded.graph.events[0]?.payload.summary,
      "Owen still needs to send the tax form."
    );
    assert.equal(loaded.graph.events[0]?.payload.sensitive, false);
    assert.equal(
      loaded.graph.events[0]?.payload.sourceTaskId,
      "task_profile_graph_store_event_payload_repair"
    );
    assert.equal(loaded.graph.events[0]?.payload.observedAt, "2026-04-07T14:45:00.000Z");
    assert.equal(loaded.graph.events[0]?.payload.timeSource, "user_stated");
    assert.deepEqual(
      loaded.graph.events[0]?.payload.projectionSourceIds,
      [canonicalEpisodeId]
    );
    assert.deepEqual(
      loaded.graph.events[0]?.payload.entityRefIds,
      ["entity_owen", "entity_tax_form"]
    );
    assert.equal(
      loaded.graph.events[0]?.payload.sourceFingerprint?.startsWith("graph_event_backfill_"),
      true
    );
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.eventIds,
      [expectedEventId]
    );
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("applyProfileMemoryGraphMutations stays no-op when a touched same-id event already matches canonical episode state", () => {
  const emptyState = createEmptyProfileMemoryState();
  const canonicalEpisodeId = "episode_profile_graph_store_event_same_id_noop";
  const sourceFingerprint = "fingerprint_profile_graph_store_event_same_id_noop";
  const recordedAt = "2026-04-07T15:20:00.000Z";
  const retainedCreatedAt = "2026-04-07T14:12:00.000Z";
  const expectedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
  const seededEpisode = {
    ...createProfileEpisodeRecord({
      title: "Owen tax follow-up",
      summary: "Owen still needs to send the tax form.",
      sourceTaskId: "task_profile_graph_store_event_same_id_noop",
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-07T14:45:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_tax_form"],
      openLoopRefs: ["open_loop_owen_tax"],
      tags: ["followup"]
    }),
    id: canonicalEpisodeId
  };
  const existingEvent = createGraphEventEnvelope({
    eventId: expectedEventId,
    stableRefId: null,
    family: "episode.candidate",
    title: seededEpisode.title,
    summary: seededEpisode.summary,
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: seededEpisode.sourceTaskId,
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
  const seededState = {
    ...emptyState,
    episodes: [seededEpisode],
    graph: {
      ...emptyState.graph,
      updatedAt: recordedAt,
      events: [existingEvent]
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [],
    touchedEpisodes: [seededEpisode],
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, false);
  assert.equal(result.nextState, seededState);
  assert.equal(result.nextState.graph.events.length, 1);
  assert.deepEqual(result.nextState.graph.events[0], existingEvent);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 0);
});

test("applyProfileMemoryGraphMutations stays no-op when a touched same-id observation already matches canonical fact support state", () => {
  const emptyState = createEmptyProfileMemoryState();
  const sourceFingerprint = "fingerprint_profile_graph_store_observation_same_id_noop";
  const recordedAt = "2026-04-07T15:20:00.000Z";
  const retainedCreatedAt = "2026-04-07T14:12:00.000Z";
  const observedAt = "2026-04-07T14:45:00.000Z";
  const factDecision = {
    candidate: {
      key: "contact.context.owen.tax_form",
      value: "pending",
      sensitive: false,
      sourceTaskId: "task_profile_graph_store_observation_same_id_noop",
      source: " User_Input_Pattern.Followup_Context ",
      observedAt,
      confidence: 0.88
    },
    decision: {
      evidenceClass: "user_hint_or_context" as const,
      family: "contact.context" as const,
      action: "allow_episode_support" as const,
      reason: "contact_context_is_support_only" as const
    }
  };
  const existingObservationId = `observation_${sha256HexFromCanonicalJson({
    family: factDecision.decision.family,
    normalizedKey: "contact.context.owen.tax_form",
    normalizedValue: "pending",
    source: "user_input_pattern.followup_context",
    observedAt,
    sourceFingerprint
  }).slice(0, 24)}`;
  const existingObservation = createGraphObservationEnvelope({
    observationId: existingObservationId,
    stableRefId: null,
    family: factDecision.decision.family,
    normalizedKey: "contact.context.owen.tax_form",
    normalizedValue: "pending",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_observation_same_id_noop",
    sourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    observedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: []
  }, retainedCreatedAt);
  const seededState = {
    ...emptyState,
    graph: {
      ...emptyState.graph,
      updatedAt: recordedAt,
      observations: [existingObservation]
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [factDecision],
    touchedEpisodes: [],
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, false);
  assert.equal(result.nextState, seededState);
  assert.equal(result.nextState.graph.observations.length, 1);
  assert.deepEqual(result.nextState.graph.observations[0], existingObservation);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 0);
});

test("applyProfileMemoryGraphMutations appends a canonical replay entry for new observation mutations after optional metadata salvage", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T18:55:00.000Z";
  const observedAt = "2026-04-08T18:30:00.000Z";
  const sourceFingerprint = "fingerprint_profile_graph_store_observation_append_canonical_new";
  const factDecision = {
    candidate: {
      key: "contact.context.owen.tax_form",
      value: "pending",
      sensitive: false,
      sourceTaskId: " task_profile_graph_store_observation_append_canonical_new ",
      source: " User_Input_Pattern.Followup_Context ",
      observedAt,
      confidence: 0.88
    },
    decision: {
      evidenceClass: "user_hint_or_context" as const,
      family: "contact.context" as const,
      action: "allow_episode_support" as const,
      reason: "contact_context_is_support_only" as const
    }
  };
  const expectedObservationId = `observation_${sha256HexFromCanonicalJson({
    family: factDecision.decision.family,
    normalizedKey: "contact.context.owen.tax_form",
    normalizedValue: "pending",
    source: "user_input_pattern.followup_context",
    observedAt,
    sourceFingerprint
  }).slice(0, 24)}`;
  const expectedJournalPayload = {
    recordedAt,
    sourceTaskId: "task_profile_graph_store_observation_append_canonical_new",
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [expectedObservationId],
    claimIds: [],
    eventIds: [],
    redactionState: "not_requested" as const
  };
  const expectedJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(expectedJournalPayload).slice(0, 24)}`;

  const result = applyProfileMemoryGraphMutations({
    state: emptyState,
    factDecisions: [factDecision],
    touchedEpisodes: [],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: "  ",
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.observations.length, 1);
  assert.equal(result.nextState.graph.claims.length, 0);
  assert.equal(result.nextState.graph.events.length, 0);
  assert.equal(
    result.nextState.graph.observations[0]?.payload.observationId,
    expectedObservationId
  );
  assert.equal(
    result.nextState.graph.observations[0]?.payload.sourceTaskId,
    "task_profile_graph_store_observation_append_canonical_new"
  );
  assert.equal(
    result.nextState.graph.observations[0]?.payload.sourceFingerprint,
    sourceFingerprint
  );
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0], {
    journalEntryId: expectedJournalEntryId,
    watermark: 1,
    ...expectedJournalPayload
  });
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 2);
});

test("applyProfileMemoryGraphMutations reuses a retained legacy replay entry when observation payload canonicalization already matches", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T19:00:00.000Z";
  const observedAt = "2026-04-08T18:35:00.000Z";
  const sourceFingerprint = "fingerprint_profile_graph_store_observation_append_duplicate_payload";
  const factDecision = {
    candidate: {
      key: "contact.context.owen.tax_form",
      value: "pending",
      sensitive: false,
      sourceTaskId: " task_profile_graph_store_observation_append_duplicate_payload ",
      source: " User_Input_Pattern.Followup_Context ",
      observedAt,
      confidence: 0.88
    },
    decision: {
      evidenceClass: "user_hint_or_context" as const,
      family: "contact.context" as const,
      action: "allow_episode_support" as const,
      reason: "contact_context_is_support_only" as const
    }
  };
  const expectedObservationId = `observation_${sha256HexFromCanonicalJson({
    family: factDecision.decision.family,
    normalizedKey: "contact.context.owen.tax_form",
    normalizedValue: "pending",
    source: "user_input_pattern.followup_context",
    observedAt,
    sourceFingerprint
  }).slice(0, 24)}`;
  const canonicalJournalPayload = {
    recordedAt,
    sourceTaskId: "task_profile_graph_store_observation_append_duplicate_payload",
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [expectedObservationId],
    claimIds: [],
    eventIds: [],
    redactionState: "not_requested" as const
  };
  const expectedCanonicalJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(canonicalJournalPayload).slice(0, 24)}`;
  const retainedLegacyEntry = {
    journalEntryId: "journal_profile_graph_store_observation_append_duplicate_payload_legacy",
    watermark: 1,
    ...canonicalJournalPayload
  };

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 2,
          entries: [retainedLegacyEntry]
        }
      }
    },
    factDecisions: [factDecision],
    touchedEpisodes: [],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: "  ",
    recordedAt
  });

  assert.notEqual(retainedLegacyEntry.journalEntryId, expectedCanonicalJournalEntryId);
  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.observations.length, 1);
  assert.equal(result.nextState.graph.claims.length, 0);
  assert.equal(result.nextState.graph.events.length, 0);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 1);
  assert.equal(
    result.nextState.graph.observations[0]?.payload.observationId,
    expectedObservationId
  );
  assert.equal(
    result.nextState.graph.observations[0]?.payload.sourceTaskId,
    "task_profile_graph_store_observation_append_duplicate_payload"
  );
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.journalEntryId,
    retainedLegacyEntry.journalEntryId
  );
  assert.equal(result.nextState.graph.mutationJournal.entries[0]?.watermark, 1);
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.sourceTaskId,
    "task_profile_graph_store_observation_append_duplicate_payload"
  );
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.sourceFingerprint,
    sourceFingerprint
  );
  assert.equal(result.nextState.graph.mutationJournal.entries[0]?.mutationEnvelopeHash, null);
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries[0]?.observationIds,
    [expectedObservationId]
  );
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0]?.claimIds, []);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 2);
});

test("applyProfileMemoryGraphMutations reuses an already-canonical retained replay entry when observation payload canonicalization matches", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T19:05:00.000Z";
  const observedAt = "2026-04-08T18:40:00.000Z";
  const sourceFingerprint =
    "fingerprint_profile_graph_store_observation_append_duplicate_payload_canonical";
  const factDecision = {
    candidate: {
      key: "contact.context.owen.tax_form",
      value: "pending",
      sensitive: false,
      sourceTaskId: " task_profile_graph_store_observation_append_duplicate_payload_canonical ",
      source: " User_Input_Pattern.Followup_Context ",
      observedAt,
      confidence: 0.88
    },
    decision: {
      evidenceClass: "user_hint_or_context" as const,
      family: "contact.context" as const,
      action: "allow_episode_support" as const,
      reason: "contact_context_is_support_only" as const
    }
  };
  const expectedObservationId = `observation_${sha256HexFromCanonicalJson({
    family: factDecision.decision.family,
    normalizedKey: "contact.context.owen.tax_form",
    normalizedValue: "pending",
    source: "user_input_pattern.followup_context",
    observedAt,
    sourceFingerprint
  }).slice(0, 24)}`;
  const canonicalJournalPayload = {
    recordedAt,
    sourceTaskId: "task_profile_graph_store_observation_append_duplicate_payload_canonical",
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [expectedObservationId],
    claimIds: [],
    eventIds: [],
    redactionState: "not_requested" as const
  };
  const expectedCanonicalJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(canonicalJournalPayload).slice(0, 24)}`;
  const retainedCanonicalEntry = {
    journalEntryId: expectedCanonicalJournalEntryId,
    watermark: 1,
    ...canonicalJournalPayload
  };

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 2,
          entries: [retainedCanonicalEntry]
        }
      }
    },
    factDecisions: [factDecision],
    touchedEpisodes: [],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: "  ",
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.observations.length, 1);
  assert.equal(result.nextState.graph.claims.length, 0);
  assert.equal(result.nextState.graph.events.length, 0);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 1);
  assert.equal(
    result.nextState.graph.observations[0]?.payload.observationId,
    expectedObservationId
  );
  assert.equal(
    result.nextState.graph.observations[0]?.payload.sourceTaskId,
    "task_profile_graph_store_observation_append_duplicate_payload_canonical"
  );
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.journalEntryId,
    expectedCanonicalJournalEntryId
  );
  assert.equal(result.nextState.graph.mutationJournal.entries[0]?.watermark, 1);
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.sourceTaskId,
    "task_profile_graph_store_observation_append_duplicate_payload_canonical"
  );
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.sourceFingerprint,
    sourceFingerprint
  );
  assert.equal(result.nextState.graph.mutationJournal.entries[0]?.mutationEnvelopeHash, null);
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries[0]?.observationIds,
    [expectedObservationId]
  );
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0]?.claimIds, []);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 2);
});

test("applyProfileMemoryGraphMutations appends a canonical replay entry when an observation retained journal id is spoofed by a different payload", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T19:10:00.000Z";
  const observedAt = "2026-04-08T18:45:00.000Z";
  const sourceFingerprint =
    "fingerprint_profile_graph_store_observation_spoofed_journal";
  const sourceTaskId = "task_profile_graph_store_observation_spoofed_journal";
  const factDecision = {
    candidate: {
      key: "contact.context.owen.tax_form",
      value: "pending",
      sensitive: false,
      sourceTaskId,
      source: " User_Input_Pattern.Followup_Context ",
      observedAt,
      confidence: 0.88
    },
    decision: {
      evidenceClass: "user_hint_or_context" as const,
      family: "contact.context" as const,
      action: "allow_episode_support" as const,
      reason: "contact_context_is_support_only" as const
    }
  };
  const expectedObservationId = `observation_${sha256HexFromCanonicalJson({
    family: factDecision.decision.family,
    normalizedKey: "contact.context.owen.tax_form",
    normalizedValue: "pending",
    source: "user_input_pattern.followup_context",
    observedAt,
    sourceFingerprint
  }).slice(0, 24)}`;
  const expectedJournalEntryId =
    `journal_${sha256HexFromCanonicalJson({
      recordedAt,
      sourceTaskId,
      sourceFingerprint,
      mutationEnvelopeHash: null,
      observationIds: [expectedObservationId],
      claimIds: [],
      eventIds: [],
      redactionState: "not_requested"
    }).slice(0, 24)}`;
  const spoofedRetainedEntry = {
    journalEntryId: expectedJournalEntryId,
    watermark: 1,
    recordedAt,
    sourceTaskId,
    sourceFingerprint:
      "fingerprint_profile_graph_store_observation_spoofed_journal_legacy",
    mutationEnvelopeHash: null,
    observationIds: [expectedObservationId],
    claimIds: [],
    eventIds: [],
    redactionState: "not_requested" as const
  };

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 2,
          entries: [spoofedRetainedEntry]
        }
      }
    },
    factDecisions: [factDecision],
    touchedEpisodes: [],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.observations.length, 1);
  assert.equal(result.nextState.graph.claims.length, 0);
  assert.equal(result.nextState.graph.events.length, 0);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 2);
  assert.equal(
    result.nextState.graph.mutationJournal.entries.filter(
      (entry) => entry.journalEntryId === expectedJournalEntryId
    ).length,
    2
  );
  const appendedEntry = result.nextState.graph.mutationJournal.entries.find(
    (entry) => entry.watermark === 2
  );
  assert.ok(appendedEntry);
  assert.equal(appendedEntry?.journalEntryId, expectedJournalEntryId);
  assert.equal(appendedEntry?.sourceTaskId, sourceTaskId);
  assert.equal(appendedEntry?.sourceFingerprint, sourceFingerprint);
  assert.deepEqual(appendedEntry?.observationIds, [expectedObservationId]);
  assert.deepEqual(appendedEntry?.claimIds, []);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 3);
});

test("applyProfileMemoryGraphMutations stays a true no-op when a same-id retained observation replay row and compaction are already replay-safe", () => {
  const emptyState = createEmptyProfileMemoryState();
  const sourceFingerprint = "fingerprint_profile_graph_store_observation_same_id_noop_replay_safe";
  const recordedAt = "2026-04-08T19:05:00.000Z";
  const retainedLastCompactedAt = "2026-04-08T18:30:00.000Z";
  const retainedCreatedAt = "2026-04-08T17:40:00.000Z";
  const observedAt = "2026-04-08T17:15:00.000Z";
  const factDecision = {
    candidate: {
      key: "contact.context.owen.tax_form",
      value: "pending",
      sensitive: false,
      sourceTaskId: "task_profile_graph_store_observation_same_id_noop_replay_safe",
      source: " User_Input_Pattern.Followup_Context ",
      observedAt,
      confidence: 0.88
    },
    decision: {
      evidenceClass: "user_hint_or_context" as const,
      family: "contact.context" as const,
      action: "allow_episode_support" as const,
      reason: "contact_context_is_support_only" as const
    }
  };
  const observationId = `observation_${sha256HexFromCanonicalJson({
    family: factDecision.decision.family,
    normalizedKey: "contact.context.owen.tax_form",
    normalizedValue: "pending",
    source: "user_input_pattern.followup_context",
    observedAt,
    sourceFingerprint
  }).slice(0, 24)}`;
  const existingObservation = createGraphObservationEnvelope({
    observationId,
    stableRefId: null,
    family: factDecision.decision.family,
    normalizedKey: "contact.context.owen.tax_form",
    normalizedValue: "pending",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_observation_same_id_noop_replay_safe",
    sourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    observedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: []
  }, retainedCreatedAt);
  const retainedObservationPayload = {
    recordedAt,
    sourceTaskId: "task_profile_graph_store_observation_same_id_noop_replay_safe",
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [observationId],
    claimIds: [],
    eventIds: [],
    redactionState: "not_requested" as const
  };
  const retainedObservationEntry = {
    journalEntryId: `journal_${sha256HexFromCanonicalJson(retainedObservationPayload).slice(0, 24)}`,
    watermark: 4,
    ...retainedObservationPayload
  };
  const seededState = {
    ...emptyState,
    graph: {
      ...emptyState.graph,
      updatedAt: "2026-04-08T18:00:00.000Z",
      observations: [existingObservation],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 5,
        entries: [retainedObservationEntry]
      },
      compaction: {
        ...emptyState.graph.compaction,
        snapshotWatermark: 3,
        lastCompactedAt: retainedLastCompactedAt,
        maxJournalEntries: 4
      },
      readModel: {
        ...emptyState.graph.readModel,
        watermark: 4
      }
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [factDecision],
    touchedEpisodes: [],
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, false);
  assert.equal(result.nextState, seededState);
  assert.deepEqual(result.nextState.graph.observations, [existingObservation]);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries, [retainedObservationEntry]);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 5);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 3);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, retainedLastCompactedAt);
  assert.equal(result.nextState.graph.readModel.watermark, 4);
});

test("applyProfileMemoryGraphMutations clamps stale snapshot watermark without restamping lastCompactedAt when a same-id retained observation stays no-op under cap", () => {
  const emptyState = createEmptyProfileMemoryState();
  const sourceFingerprint = "fingerprint_profile_graph_store_observation_same_id_noop_clamp";
  const recordedAt = "2026-04-08T19:20:00.000Z";
  const retainedLastCompactedAt = "2026-04-08T18:35:00.000Z";
  const retainedCreatedAt = "2026-04-08T17:45:00.000Z";
  const observedAt = "2026-04-08T17:20:00.000Z";
  const factDecision = {
    candidate: {
      key: "contact.context.owen.tax_form",
      value: "pending",
      sensitive: false,
      sourceTaskId: "task_profile_graph_store_observation_same_id_noop_clamp",
      source: " User_Input_Pattern.Followup_Context ",
      observedAt,
      confidence: 0.88
    },
    decision: {
      evidenceClass: "user_hint_or_context" as const,
      family: "contact.context" as const,
      action: "allow_episode_support" as const,
      reason: "contact_context_is_support_only" as const
    }
  };
  const observationId = `observation_${sha256HexFromCanonicalJson({
    family: factDecision.decision.family,
    normalizedKey: "contact.context.owen.tax_form",
    normalizedValue: "pending",
    source: "user_input_pattern.followup_context",
    observedAt,
    sourceFingerprint
  }).slice(0, 24)}`;
  const existingObservation = createGraphObservationEnvelope({
    observationId,
    stableRefId: null,
    family: factDecision.decision.family,
    normalizedKey: "contact.context.owen.tax_form",
    normalizedValue: "pending",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_observation_same_id_noop_clamp",
    sourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    observedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: []
  }, retainedCreatedAt);
  const retainedObservationPayload = {
    recordedAt,
    sourceTaskId: "task_profile_graph_store_observation_same_id_noop_clamp",
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [observationId],
    claimIds: [],
    eventIds: [],
    redactionState: "not_requested" as const
  };
  const retainedObservationEntry = {
    journalEntryId: `journal_${sha256HexFromCanonicalJson(retainedObservationPayload).slice(0, 24)}`,
    watermark: 4,
    ...retainedObservationPayload
  };
  const seededState = {
    ...emptyState,
    graph: {
      ...emptyState.graph,
      updatedAt: "2026-04-08T18:05:00.000Z",
      observations: [existingObservation],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 5,
        entries: [retainedObservationEntry]
      },
      compaction: {
        ...emptyState.graph.compaction,
        snapshotWatermark: 99,
        lastCompactedAt: retainedLastCompactedAt,
        maxJournalEntries: 4
      },
      readModel: {
        ...emptyState.graph.readModel,
        watermark: 4
      }
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [factDecision],
    touchedEpisodes: [],
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.updatedAt, recordedAt);
  assert.deepEqual(result.nextState.graph.observations, [existingObservation]);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries, [retainedObservationEntry]);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 5);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 3);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, retainedLastCompactedAt);
  assert.equal(result.nextState.graph.readModel.watermark, 4);
});

test("applyProfileMemoryGraphMutations clamps stale snapshot watermark from nextWatermark when a same-id retained observation stays no-op with no retained journal entries", () => {
  const emptyState = createEmptyProfileMemoryState();
  const sourceFingerprint = "fingerprint_profile_graph_store_observation_same_id_noop_empty_retained";
  const recordedAt = "2026-04-08T19:25:00.000Z";
  const retainedLastCompactedAt = "2026-04-08T18:40:00.000Z";
  const retainedCreatedAt = "2026-04-08T17:50:00.000Z";
  const observedAt = "2026-04-08T17:25:00.000Z";
  const factDecision = {
    candidate: {
      key: "contact.context.owen.tax_form",
      value: "pending",
      sensitive: false,
      sourceTaskId: "task_profile_graph_store_observation_same_id_noop_empty_retained",
      source: " User_Input_Pattern.Followup_Context ",
      observedAt,
      confidence: 0.88
    },
    decision: {
      evidenceClass: "user_hint_or_context" as const,
      family: "contact.context" as const,
      action: "allow_episode_support" as const,
      reason: "contact_context_is_support_only" as const
    }
  };
  const observationId = `observation_${sha256HexFromCanonicalJson({
    family: factDecision.decision.family,
    normalizedKey: "contact.context.owen.tax_form",
    normalizedValue: "pending",
    source: "user_input_pattern.followup_context",
    observedAt,
    sourceFingerprint
  }).slice(0, 24)}`;
  const existingObservation = createGraphObservationEnvelope({
    observationId,
    stableRefId: null,
    family: factDecision.decision.family,
    normalizedKey: "contact.context.owen.tax_form",
    normalizedValue: "pending",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_observation_same_id_noop_empty_retained",
    sourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    observedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: []
  }, retainedCreatedAt);
  const seededState = {
    ...emptyState,
    graph: {
      ...emptyState.graph,
      updatedAt: "2026-04-08T18:10:00.000Z",
      observations: [existingObservation],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 4,
        entries: []
      },
      compaction: {
        ...emptyState.graph.compaction,
        snapshotWatermark: 99,
        lastCompactedAt: retainedLastCompactedAt,
        maxJournalEntries: 4
      },
      readModel: {
        ...emptyState.graph.readModel,
        watermark: 3
      }
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [factDecision],
    touchedEpisodes: [],
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.updatedAt, recordedAt);
  assert.deepEqual(result.nextState.graph.observations, [existingObservation]);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries, []);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 4);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 3);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, retainedLastCompactedAt);
  assert.equal(result.nextState.graph.readModel.watermark, 3);
});

test("applyProfileMemoryGraphMutations compacts the oldest replay entry when a new canonical observation append exceeds the journal cap", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T19:45:00.000Z";
  const retainedLastCompactedAt = "2026-04-08T18:50:00.000Z";
  const retainedObservedAt = "2026-04-08T18:10:00.000Z";
  const observedAt = "2026-04-08T18:40:00.000Z";
  const sourceFingerprint = "fingerprint_profile_graph_store_observation_compaction_public";
  const factDecision = {
    candidate: {
      key: "contact.context.owen.tax_form",
      value: "pending",
      sensitive: false,
      sourceTaskId: "task_profile_graph_store_observation_compaction_public_new",
      source: " User_Input_Pattern.Followup_Context ",
      observedAt,
      confidence: 0.88
    },
    decision: {
      evidenceClass: "user_hint_or_context" as const,
      family: "contact.context" as const,
      action: "allow_episode_support" as const,
      reason: "contact_context_is_support_only" as const
    }
  };
  const retainedObservation = createGraphObservationEnvelope({
    observationId: "observation_profile_graph_store_observation_compaction_public_retained",
    stableRefId: null,
    family: "contact.context",
    normalizedKey: "contact.context.owen.passport",
    normalizedValue: "missing",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_observation_compaction_public_retained",
    sourceFingerprint: "fingerprint_profile_graph_store_observation_compaction_public_retained",
    sourceTier: "explicit_user_statement",
    assertedAt: retainedObservedAt,
    observedAt: retainedObservedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: []
  }, "2026-04-08T18:10:00.000Z");
  const recentObservedAt = "2026-04-08T18:20:00.000Z";
  const recentObservationId = "observation_profile_graph_store_observation_compaction_public_recent";
  const recentObservation = createGraphObservationEnvelope({
    observationId: recentObservationId,
    stableRefId: null,
    family: "contact.context",
    normalizedKey: "contact.context.owen.onboarding",
    normalizedValue: "sent",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_observation_compaction_public_recent",
    sourceFingerprint: "fingerprint_profile_graph_store_observation_compaction_public_recent",
    sourceTier: "explicit_user_statement",
    assertedAt: recentObservedAt,
    observedAt: recentObservedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: []
  }, "2026-04-08T18:20:00.000Z");
  const expectedObservationId = `observation_${sha256HexFromCanonicalJson({
    family: factDecision.decision.family,
    normalizedKey: "contact.context.owen.tax_form",
    normalizedValue: "pending",
    source: "user_input_pattern.followup_context",
    observedAt,
    sourceFingerprint
  }).slice(0, 24)}`;
  const expectedJournalPayload = {
    recordedAt,
    sourceTaskId: "task_profile_graph_store_observation_compaction_public_new",
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [expectedObservationId],
    claimIds: [],
    eventIds: [],
    redactionState: "not_requested" as const
  };
  const expectedJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(expectedJournalPayload).slice(0, 24)}`;
  const retainedEntryThree = {
    journalEntryId: "journal_profile_graph_store_observation_compaction_public_3",
    watermark: 3,
    recordedAt: "2026-04-08T18:15:00.000Z",
    sourceTaskId: "task_profile_graph_store_observation_compaction_public_retained",
    sourceFingerprint: "fingerprint_profile_graph_store_observation_compaction_public_retained",
    mutationEnvelopeHash: null,
    observationIds: [retainedObservation.payload.observationId],
    claimIds: [],
    eventIds: [],
    redactionState: "not_requested" as const
  };
  const retainedEntryFour = {
    journalEntryId: "journal_profile_graph_store_observation_compaction_public_4",
    watermark: 4,
    recordedAt: "2026-04-08T18:20:00.000Z",
    sourceTaskId: "task_profile_graph_store_observation_compaction_public_recent",
    sourceFingerprint: "fingerprint_profile_graph_store_observation_compaction_public_recent",
    mutationEnvelopeHash: null,
    observationIds: [recentObservationId],
    claimIds: [],
    eventIds: [],
    redactionState: "not_requested" as const
  };
  const seededState = {
    ...emptyState,
    graph: {
      ...emptyState.graph,
      updatedAt: "2026-04-08T18:25:00.000Z",
      observations: [retainedObservation, recentObservation],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 5,
        entries: [retainedEntryThree, retainedEntryFour]
      },
      compaction: {
        ...emptyState.graph.compaction,
        snapshotWatermark: 2,
        lastCompactedAt: retainedLastCompactedAt,
        maxJournalEntries: 2
      }
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [factDecision],
    touchedEpisodes: [],
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.updatedAt, recordedAt);
  assert.deepEqual(
    result.nextState.graph.observations.map((observation) => observation.payload.observationId),
    [retainedObservation.payload.observationId, recentObservationId, expectedObservationId]
  );
  const appendedObservation = result.nextState.graph.observations.find(
    (observation) => observation.payload.observationId === expectedObservationId
  );
  assert.ok(appendedObservation);
  assert.equal(
    appendedObservation?.payload.sourceTaskId,
    "task_profile_graph_store_observation_compaction_public_new"
  );
  assert.equal(appendedObservation?.payload.sourceFingerprint, sourceFingerprint);
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [4, 5]
  );
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0], retainedEntryFour);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[1], {
    journalEntryId: expectedJournalEntryId,
    watermark: 5,
    ...expectedJournalPayload
  });
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 6);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 3);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, recordedAt);
  assert.equal(result.nextState.graph.readModel.watermark, 5);
});

test("applyProfileMemoryGraphMutations stays no-op when a same-id retained current claim already matches canonical winner state", () => {
  const emptyState = createEmptyProfileMemoryState();
  const sourceFingerprint = "fingerprint_profile_graph_store_claim_same_id_noop";
  const recordedAt = "2026-04-07T15:20:00.000Z";
  const retainedCreatedAt = "2026-04-07T14:12:00.000Z";
  const observedAt = "2026-04-07T14:45:00.000Z";
  const factId = "fact_profile_graph_store_claim_same_id_noop";
  const factDecision = {
    candidate: {
      key: "identity.preferred_name",
      value: "Avery",
      sensitive: true,
      sourceTaskId: "task_profile_graph_store_claim_same_id_noop",
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
  const fact = {
    id: factId,
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: true,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_store_claim_same_id_noop",
    source: "user_input_pattern.name_phrase",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };
  const existingObservation = createGraphObservationEnvelope({
    observationId,
    stableRefId: null,
    family: factDecision.decision.family,
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: true,
    sourceTaskId: "task_profile_graph_store_claim_same_id_noop",
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
    sourceTaskId: "task_profile_graph_store_claim_same_id_noop",
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
  const seededState = {
    ...emptyState,
    facts: [fact],
    graph: {
      ...emptyState.graph,
      updatedAt: recordedAt,
      observations: [existingObservation],
      claims: [existingClaim]
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [factDecision],
    touchedEpisodes: [],
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, false);
  assert.equal(result.nextState, seededState);
  assert.equal(result.nextState.graph.observations.length, 1);
  assert.equal(result.nextState.graph.claims.length, 1);
  assert.deepEqual(result.nextState.graph.observations[0], existingObservation);
  assert.deepEqual(result.nextState.graph.claims[0], existingClaim);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 0);
});

test("applyProfileMemoryGraphMutations stays a true no-op when a same-id retained current claim replay row and compaction are already replay-safe", () => {
  const emptyState = createEmptyProfileMemoryState();
  const sourceFingerprint = "fingerprint_profile_graph_store_claim_same_id_noop_replay_safe";
  const recordedAt = "2026-04-08T20:05:00.000Z";
  const retainedLastCompactedAt = "2026-04-08T19:30:00.000Z";
  const retainedCreatedAt = "2026-04-08T19:01:00.000Z";
  const observedAt = "2026-04-08T18:45:00.000Z";
  const factId = "fact_profile_graph_store_claim_same_id_noop_replay_safe";
  const factDecision = {
    candidate: {
      key: "identity.preferred_name",
      value: "Avery",
      sensitive: true,
      sourceTaskId: "task_profile_graph_store_claim_same_id_noop_replay_safe",
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
  const fact = {
    id: factId,
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: true,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_store_claim_same_id_noop_replay_safe",
    source: "user_input_pattern.name_phrase",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };
  const existingObservation = createGraphObservationEnvelope({
    observationId,
    stableRefId: null,
    family: factDecision.decision.family,
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: true,
    sourceTaskId: "task_profile_graph_store_claim_same_id_noop_replay_safe",
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
    sourceTaskId: "task_profile_graph_store_claim_same_id_noop_replay_safe",
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
  const retainedClaimPayload = {
    recordedAt,
    sourceTaskId: "task_profile_graph_store_claim_same_id_noop_replay_safe",
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [observationId],
    claimIds: [claimId],
    eventIds: [],
    redactionState: "not_requested" as const
  };
  const retainedClaimEntry = {
    journalEntryId: `journal_${sha256HexFromCanonicalJson(retainedClaimPayload).slice(0, 24)}`,
    watermark: 4,
    ...retainedClaimPayload
  };
  const seededState = {
    ...emptyState,
    facts: [fact],
    graph: {
      ...emptyState.graph,
      updatedAt: "2026-04-08T19:10:00.000Z",
      observations: [existingObservation],
      claims: [existingClaim],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 5,
        entries: [retainedClaimEntry]
      },
      compaction: {
        ...emptyState.graph.compaction,
        snapshotWatermark: 3,
        lastCompactedAt: retainedLastCompactedAt,
        maxJournalEntries: 4
      },
      readModel: {
        ...emptyState.graph.readModel,
        watermark: 4
      }
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [factDecision],
    touchedEpisodes: [],
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, false);
  assert.equal(result.nextState, seededState);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries, [retainedClaimEntry]);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 5);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 3);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, retainedLastCompactedAt);
  assert.equal(result.nextState.graph.readModel.watermark, 4);
});

test("applyProfileMemoryGraphMutations clamps stale snapshot watermark without restamping lastCompactedAt when a same-id retained current claim stays no-op under cap", () => {
  const emptyState = createEmptyProfileMemoryState();
  const sourceFingerprint = "fingerprint_profile_graph_store_claim_same_id_noop_clamp";
  const recordedAt = "2026-04-08T20:20:00.000Z";
  const retainedLastCompactedAt = "2026-04-08T19:40:00.000Z";
  const retainedCreatedAt = "2026-04-08T19:05:00.000Z";
  const observedAt = "2026-04-08T18:55:00.000Z";
  const factId = "fact_profile_graph_store_claim_same_id_noop_clamp";
  const factDecision = {
    candidate: {
      key: "identity.preferred_name",
      value: "Avery",
      sensitive: true,
      sourceTaskId: "task_profile_graph_store_claim_same_id_noop_clamp",
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
  const fact = {
    id: factId,
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: true,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_store_claim_same_id_noop_clamp",
    source: "user_input_pattern.name_phrase",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };
  const existingObservation = createGraphObservationEnvelope({
    observationId,
    stableRefId: null,
    family: factDecision.decision.family,
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: true,
    sourceTaskId: "task_profile_graph_store_claim_same_id_noop_clamp",
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
    sourceTaskId: "task_profile_graph_store_claim_same_id_noop_clamp",
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
  const retainedClaimPayload = {
    recordedAt,
    sourceTaskId: "task_profile_graph_store_claim_same_id_noop_clamp",
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [observationId],
    claimIds: [claimId],
    eventIds: [],
    redactionState: "not_requested" as const
  };
  const retainedClaimEntry = {
    journalEntryId: `journal_${sha256HexFromCanonicalJson(retainedClaimPayload).slice(0, 24)}`,
    watermark: 4,
    ...retainedClaimPayload
  };
  const seededState = {
    ...emptyState,
    facts: [fact],
    graph: {
      ...emptyState.graph,
      updatedAt: "2026-04-08T19:15:00.000Z",
      observations: [existingObservation],
      claims: [existingClaim],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 5,
        entries: [retainedClaimEntry]
      },
      compaction: {
        ...emptyState.graph.compaction,
        snapshotWatermark: 99,
        lastCompactedAt: retainedLastCompactedAt,
        maxJournalEntries: 4
      },
      readModel: {
        ...emptyState.graph.readModel,
        watermark: 4
      }
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [factDecision],
    touchedEpisodes: [],
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.updatedAt, recordedAt);
  assert.equal(result.nextState.graph.observations.length, 1);
  assert.equal(result.nextState.graph.claims.length, 1);
  assert.deepEqual(result.nextState.graph.observations[0], existingObservation);
  assert.deepEqual(result.nextState.graph.claims[0], existingClaim);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries, [retainedClaimEntry]);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 5);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 3);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, retainedLastCompactedAt);
  assert.equal(result.nextState.graph.readModel.watermark, 4);
});

test("applyProfileMemoryGraphMutations clamps stale snapshot watermark from nextWatermark when a same-id retained current claim stays no-op with no retained journal entries", () => {
  const emptyState = createEmptyProfileMemoryState();
  const sourceFingerprint = "fingerprint_profile_graph_store_claim_same_id_noop_empty_retained";
  const recordedAt = "2026-04-08T20:25:00.000Z";
  const retainedLastCompactedAt = "2026-04-08T19:45:00.000Z";
  const retainedCreatedAt = "2026-04-08T19:10:00.000Z";
  const observedAt = "2026-04-08T19:00:00.000Z";
  const factId = "fact_profile_graph_store_claim_same_id_noop_empty_retained";
  const factDecision = {
    candidate: {
      key: "identity.preferred_name",
      value: "Avery",
      sensitive: true,
      sourceTaskId: "task_profile_graph_store_claim_same_id_noop_empty_retained",
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
  const fact = {
    id: factId,
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: true,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_store_claim_same_id_noop_empty_retained",
    source: "user_input_pattern.name_phrase",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };
  const existingObservation = createGraphObservationEnvelope({
    observationId,
    stableRefId: null,
    family: factDecision.decision.family,
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: true,
    sourceTaskId: "task_profile_graph_store_claim_same_id_noop_empty_retained",
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
    sourceTaskId: "task_profile_graph_store_claim_same_id_noop_empty_retained",
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
  const seededState = {
    ...emptyState,
    facts: [fact],
    graph: {
      ...emptyState.graph,
      updatedAt: "2026-04-08T19:20:00.000Z",
      observations: [existingObservation],
      claims: [existingClaim],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 6,
        entries: []
      },
      compaction: {
        ...emptyState.graph.compaction,
        snapshotWatermark: 99,
        lastCompactedAt: retainedLastCompactedAt,
        maxJournalEntries: 4
      },
      readModel: {
        ...emptyState.graph.readModel,
        watermark: 5
      }
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [factDecision],
    touchedEpisodes: [],
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.updatedAt, recordedAt);
  assert.equal(result.nextState.graph.observations.length, 1);
  assert.equal(result.nextState.graph.claims.length, 1);
  assert.deepEqual(result.nextState.graph.observations[0], existingObservation);
  assert.deepEqual(result.nextState.graph.claims[0], existingClaim);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries, []);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 6);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 5);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, retainedLastCompactedAt);
  assert.equal(result.nextState.graph.readModel.watermark, 5);
});

test("applyProfileMemoryGraphMutations repairs semantically mismatched fact-side claim lineage and canonicalizes claim timestamps", () => {
  const emptyState = createEmptyProfileMemoryState();
  const sourceFingerprint = "fingerprint_profile_graph_store_claim_lineage_public_mismatch";
  const recordedAt = "2026-04-08T20:30:00.000Z";
  const observedAt = "2026-04-08T19:05:00.000Z";
  const factId = "fact_profile_graph_store_claim_lineage_public_mismatch";
  const factDecision = {
    candidate: {
      key: "identity.preferred_name",
      value: "Avery",
      sensitive: true,
      sourceTaskId: "task_profile_graph_store_claim_lineage_public_mismatch",
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
  const expectedObservationId = `observation_${sha256HexFromCanonicalJson({
    family: factDecision.decision.family,
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    source: "user_input_pattern.name_phrase",
    observedAt,
    sourceFingerprint
  }).slice(0, 24)}`;
  const wrongObservationId = "observation_profile_graph_store_claim_lineage_public_mismatch_wrong";
  const claimIdentity = {
    family: factDecision.decision.family,
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery"
  };
  const claimId = `claim_${sha256HexFromCanonicalJson(claimIdentity).slice(0, 24)}`;
  const claimSourceFingerprint = sha256HexFromCanonicalJson(claimIdentity).slice(0, 32);
  const fact = {
    id: factId,
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: true,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_store_claim_lineage_public_mismatch",
    source: "user_input_pattern.name_phrase",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };
  const existingWrongObservation = createGraphObservationEnvelope({
    observationId: wrongObservationId,
    stableRefId: null,
    family: factDecision.decision.family,
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Ava",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: true,
    sourceTaskId: "task_profile_graph_store_claim_lineage_public_mismatch_wrong",
    sourceFingerprint: "fingerprint_profile_graph_store_claim_lineage_public_mismatch_wrong",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    observedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: []
  }, "2026-04-08T19:10:00.000Z");
  const existingClaim = createGraphClaimEnvelope({
    claimId,
    stableRefId: null,
    family: factDecision.decision.family,
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: true,
    sourceTaskId: "task_profile_graph_store_claim_lineage_public_mismatch",
    sourceFingerprint: claimSourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: " 2026-04-08T19:05:00.000Z ",
    validFrom: " 2026-04-08T19:05:00.000Z ",
    validTo: null,
    endedAt: null,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [wrongObservationId],
    projectionSourceIds: [factId],
    entityRefIds: [],
    active: true
  }, "2026-04-08T19:11:00.000Z");
  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      facts: [fact],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-08T19:15:00.000Z",
        observations: [existingWrongObservation],
        claims: [existingClaim]
      }
    },
    factDecisions: [factDecision],
    touchedEpisodes: [],
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.updatedAt, recordedAt);
  assert.equal(result.nextState.graph.observations.length, 2);
  assert.equal(
    result.nextState.graph.observations.some(
      (observation) => observation.payload.observationId === wrongObservationId
    ),
    true
  );
  assert.equal(
    result.nextState.graph.observations.some(
      (observation) => observation.payload.observationId === expectedObservationId
    ),
    true
  );
  assert.deepEqual(
    result.nextState.graph.claims[0]?.payload.derivedFromObservationIds,
    [expectedObservationId]
  );
  assert.equal(result.nextState.graph.claims[0]?.payload.assertedAt, observedAt);
  assert.equal(result.nextState.graph.claims[0]?.payload.validFrom, observedAt);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 1);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0]?.observationIds, [expectedObservationId]);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0]?.claimIds, [claimId]);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 2);
});

test("profile memory load keeps already-canonical retained current-claim lanes inert during legacy fact backfill", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const sourceFingerprint = "fingerprint_profile_graph_store_legacy_claim_same_id_noop";
    const retainedCreatedAt = "2026-04-07T14:12:00.000Z";
    const observedAt = "2026-04-07T14:45:00.000Z";
    const factId = "fact_profile_graph_store_legacy_claim_same_id_noop";
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
    const retainedJournalEntry = {
      journalEntryId: "journal_profile_graph_store_legacy_claim_same_id_noop",
      watermark: 1,
      recordedAt: "2026-04-07T15:00:00.000Z",
      sourceTaskId: "task_profile_graph_store_legacy_claim_same_id_noop",
      sourceFingerprint,
      mutationEnvelopeHash: null,
      observationIds: [observationId],
      claimIds: [claimId],
      eventIds: [],
      redactionState: "not_requested" as const
    };
    const existingObservation = createGraphObservationEnvelope({
      observationId,
      stableRefId: "stable_self_profile_owner",
      family: "identity.preferred_name",
      normalizedKey: "identity.preferred_name",
      normalizedValue: "Avery",
      redactionState: "not_requested",
      redactedAt: null,
      sensitive: true,
      sourceTaskId: "task_profile_graph_store_legacy_claim_same_id_noop",
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
      stableRefId: "stable_self_profile_owner",
      family: "identity.preferred_name",
      normalizedKey: "identity.preferred_name",
      normalizedValue: "Avery",
      redactionState: "not_requested",
      redactedAt: null,
      sensitive: true,
      sourceTaskId: "task_profile_graph_store_legacy_claim_same_id_noop",
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
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-07T15:20:00.000Z",
      facts: [{
        id: factId,
        key: "identity.preferred_name",
        value: "Avery",
        sensitive: true,
        status: "confirmed" as const,
        confidence: 0.95,
        sourceTaskId: "task_profile_graph_store_legacy_claim_same_id_noop",
        source: "user_input_pattern.name_phrase",
        observedAt,
        confirmedAt: observedAt,
        supersededAt: null,
        lastUpdatedAt: observedAt
      }],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-07T15:20:00.000Z",
        observations: [existingObservation],
        claims: [existingClaim],
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 2,
          entries: [retainedJournalEntry]
        },
        readModel: {
          schemaVersion: "v1" as const,
          watermark: 1,
          rebuiltAt: "2026-04-07T15:00:00.000Z",
          currentClaimIdsByKey: {
            "identity.preferred_name": claimId
          },
          conflictingCurrentClaimIdsByKey: {},
          inventoryClaimIdsByFamily: {
            "identity.preferred_name": [claimId]
          }
        },
        indexes: {
          schemaVersion: "v1" as const,
          byNormalizedKey: {
            "identity.preferred_name": [claimId]
          },
          byFamily: {
            "identity.preferred_name": [claimId]
          },
          bySourceTier: {
            explicit_user_statement: [claimId],
            validated_structured_candidate: [],
            reconciliation_or_projection: [],
            assistant_inference: []
          },
          byEntityRefId: {},
          validityWindow: [{
            claimId,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            validFrom: observedAt,
            validTo: null,
            active: true
          }],
          activeClaimIds: [claimId]
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.observations.length, 1);
    assert.equal(loaded.graph.claims.length, 1);
    assert.deepEqual(loaded.graph.observations[0], existingObservation);
    assert.deepEqual(loaded.graph.claims[0], existingClaim);
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    assert.deepEqual(loaded.graph.mutationJournal.entries[0], retainedJournalEntry);
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
      claimId
    );
  });
});

test("applyProfileMemoryGraphMutations stays no-op when a redacted same-id event already matches canonical forget state", () => {
  const emptyState = createEmptyProfileMemoryState();
  const canonicalEpisodeId = "episode_profile_graph_store_redacted_event_same_id_noop";
  const sourceTaskId = "task_profile_graph_store_redacted_event_same_id_noop";
  const sourceFingerprint = "fingerprint_profile_graph_store_redacted_event_same_id_noop";
  const recordedAt = "2026-04-07T15:20:00.000Z";
  const retainedCreatedAt = "2026-04-07T14:12:00.000Z";
  const expectedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
  const seededEpisode = {
    ...createProfileEpisodeRecord({
      title: "Owen tax follow-up",
      summary: "Owen still needs to send the tax form.",
      sourceTaskId,
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-07T14:45:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_tax_form"],
      openLoopRefs: ["open_loop_owen_tax"],
      tags: ["followup"]
    }),
    id: canonicalEpisodeId
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
  const seededState = {
    ...emptyState,
    episodes: [seededEpisode],
    graph: {
      ...emptyState.graph,
      updatedAt: recordedAt,
      events: [existingEvent]
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [],
    touchedEpisodes: [],
    redactedEpisodes: [seededEpisode],
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, false);
  assert.equal(result.nextState, seededState);
  assert.equal(result.nextState.graph.events.length, 1);
  assert.deepEqual(result.nextState.graph.events[0], existingEvent);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 0);
});

test("applyProfileMemoryGraphMutations appends a canonical replay entry when a retained journal id is spoofed by a different payload", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-07T15:20:00.000Z";
  const observedAt = "2026-04-07T14:45:00.000Z";
  const sourceTaskId = "task_profile_graph_store_fact_redaction_spoofed_journal";
  const sourceFingerprint = "fingerprint_profile_graph_store_fact_redaction_spoofed_journal";
  const existingObservation = createGraphObservationEnvelope({
    observationId: "observation_profile_graph_store_fact_redaction_spoofed_journal",
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_spoofed_seed",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_spoofed_seed",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    observedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:12:00.000Z");
  const existingClaim = createGraphClaimEnvelope({
    claimId: "claim_profile_graph_store_fact_redaction_spoofed_journal",
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_spoofed_seed",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_spoofed_seed",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,    validFrom: observedAt,
    validTo: null,
    endedAt: null,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    active: true,
    derivedFromObservationIds: [existingObservation.payload.observationId],
    projectionSourceIds: ["fact_profile_graph_store_fact_redaction_spoofed_journal"],
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:13:00.000Z");
  const expectedJournalEntryId =
    `journal_${sha256HexFromCanonicalJson({
      recordedAt,
      sourceTaskId,
      sourceFingerprint,
      mutationEnvelopeHash: null,
      observationIds: [existingObservation.payload.observationId],
      claimIds: [existingClaim.payload.claimId],
      eventIds: [],
      redactionState: "redacted"
    }).slice(0, 24)}`;
  const redactedFact = {
    id: "fact_profile_graph_store_fact_redaction_spoofed_journal",
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: false,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_store_fact_redaction_spoofed_seed",
    source: "user_input_pattern.name_preference",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };
  const spoofedRetainedEntry = {
    journalEntryId: expectedJournalEntryId,
    watermark: 1,
    recordedAt,
    sourceTaskId,
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_spoofed_legacy",
    mutationEnvelopeHash: null,
    observationIds: [existingObservation.payload.observationId],
    claimIds: [existingClaim.payload.claimId],
    eventIds: [],
    redactionState: "redacted" as const
  };
  const seededState = {
    ...emptyState,
    graph: {
      ...emptyState.graph,
      updatedAt: recordedAt,
      observations: [existingObservation],
      claims: [existingClaim],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 2,
        entries: [spoofedRetainedEntry]
      }
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [],
    touchedEpisodes: [],
    redactedFacts: [redactedFact],
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 2);
  assert.equal(
    result.nextState.graph.mutationJournal.entries.filter(
      (entry) => entry.journalEntryId === expectedJournalEntryId
    ).length,
    2
  );
  const appendedEntry = result.nextState.graph.mutationJournal.entries.find(
    (entry) => entry.watermark === 2
  );
  assert.ok(appendedEntry);
  assert.equal(appendedEntry?.journalEntryId, expectedJournalEntryId);
  assert.equal(appendedEntry?.sourceFingerprint, sourceFingerprint);
  assert.deepEqual(appendedEntry?.observationIds, [existingObservation.payload.observationId]);
  assert.deepEqual(appendedEntry?.claimIds, [existingClaim.payload.claimId]);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 3);
});

test("applyProfileMemoryGraphMutations appends a canonical replay entry for new fact-side mutations after optional metadata salvage", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T15:55:00.000Z";
  const observedAt = "2026-04-08T15:40:00.000Z";
  const sourceFingerprint = "fingerprint_profile_graph_store_append_canonical_new";
  const factId = "fact_profile_graph_store_append_canonical_new";
  const factDecision = {
    candidate: {
      key: "identity.preferred_name",
      value: "Avery",
      sensitive: true,
      sourceTaskId: " task_profile_graph_store_append_canonical_new ",
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
  const expectedObservationId = `observation_${sha256HexFromCanonicalJson({
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
  const expectedClaimId =
    `claim_${sha256HexFromCanonicalJson(claimIdentity).slice(0, 24)}`;
  const fact = {
    id: factId,
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: true,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_store_append_canonical_new",
    source: "user_input_pattern.name_phrase",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };
  const expectedJournalPayload = {
    recordedAt,
    sourceTaskId: "task_profile_graph_store_append_canonical_new",
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [expectedObservationId],
    claimIds: [expectedClaimId],
    eventIds: [],
    redactionState: "not_requested" as const
  };
  const expectedJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(expectedJournalPayload).slice(0, 24)}`;

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      facts: [fact]
    },
    factDecisions: [factDecision],
    touchedEpisodes: [],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: "  ",
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.observations.length, 1);
  assert.equal(result.nextState.graph.claims.length, 1);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 1);
  assert.equal(
    result.nextState.graph.observations[0]?.payload.sourceTaskId,
    "task_profile_graph_store_append_canonical_new"
  );
  assert.equal(
    result.nextState.graph.claims[0]?.payload.sourceTaskId,
    "task_profile_graph_store_append_canonical_new"
  );
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0], {
    journalEntryId: expectedJournalEntryId,
    watermark: 1,
    ...expectedJournalPayload
  });
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 2);
});

test("applyProfileMemoryGraphMutations reuses a retained legacy replay entry when fact-side payload canonicalization already matches", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T16:05:00.000Z";
  const observedAt = "2026-04-08T15:40:00.000Z";
  const sourceFingerprint = "fingerprint_profile_graph_store_append_duplicate_payload";
  const factId = "fact_profile_graph_store_append_duplicate_payload";
  const factDecision = {
    candidate: {
      key: "identity.preferred_name",
      value: "Avery",
      sensitive: true,
      sourceTaskId: " task_profile_graph_store_append_duplicate_payload ",
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
  const expectedObservationId = `observation_${sha256HexFromCanonicalJson({
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
  const expectedClaimId =
    `claim_${sha256HexFromCanonicalJson(claimIdentity).slice(0, 24)}`;
  const fact = {
    id: factId,
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: true,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_store_append_duplicate_payload",
    source: "user_input_pattern.name_phrase",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };
  const canonicalJournalPayload = {
    recordedAt,
    sourceTaskId: "task_profile_graph_store_append_duplicate_payload",
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [expectedObservationId],
    claimIds: [expectedClaimId],
    eventIds: [],
    redactionState: "not_requested" as const
  };
  const expectedCanonicalJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(canonicalJournalPayload).slice(0, 24)}`;
  const retainedLegacyEntry = {
    journalEntryId: "journal_profile_graph_store_append_duplicate_payload_legacy",
    watermark: 1,
    ...canonicalJournalPayload
  };

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      facts: [fact],
      graph: {
        ...emptyState.graph,
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 2,
          entries: [retainedLegacyEntry]
        }
      }
    },
    factDecisions: [factDecision],
    touchedEpisodes: [],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: "  ",
    recordedAt
  });

  assert.notEqual(retainedLegacyEntry.journalEntryId, expectedCanonicalJournalEntryId);
  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.observations.length, 1);
  assert.equal(result.nextState.graph.claims.length, 1);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 1);
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.journalEntryId,
    retainedLegacyEntry.journalEntryId
  );
  assert.equal(result.nextState.graph.mutationJournal.entries[0]?.watermark, 1);
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.sourceTaskId,
    "task_profile_graph_store_append_duplicate_payload"
  );
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.sourceFingerprint,
    sourceFingerprint
  );
  assert.equal(result.nextState.graph.mutationJournal.entries[0]?.mutationEnvelopeHash, null);
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries[0]?.observationIds,
    [expectedObservationId]
  );
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries[0]?.claimIds,
    [expectedClaimId]
  );
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 2);
});

test("applyProfileMemoryGraphMutations reuses an already-canonical retained replay entry when fact-side payload canonicalization matches", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T16:15:00.000Z";
  const observedAt = "2026-04-08T15:45:00.000Z";
  const sourceFingerprint = "fingerprint_profile_graph_store_append_duplicate_payload_canonical";
  const factId = "fact_profile_graph_store_append_duplicate_payload_canonical";
  const factDecision = {
    candidate: {
      key: "identity.preferred_name",
      value: "Avery",
      sensitive: true,
      sourceTaskId: " task_profile_graph_store_append_duplicate_payload_canonical ",
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
  const expectedObservationId = `observation_${sha256HexFromCanonicalJson({
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
  const expectedClaimId =
    `claim_${sha256HexFromCanonicalJson(claimIdentity).slice(0, 24)}`;
  const fact = {
    id: factId,
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: true,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_store_append_duplicate_payload_canonical",
    source: "user_input_pattern.name_phrase",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };
  const canonicalJournalPayload = {
    recordedAt,
    sourceTaskId: "task_profile_graph_store_append_duplicate_payload_canonical",
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [expectedObservationId],
    claimIds: [expectedClaimId],
    eventIds: [],
    redactionState: "not_requested" as const
  };
  const expectedCanonicalJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(canonicalJournalPayload).slice(0, 24)}`;
  const retainedCanonicalEntry = {
    journalEntryId: expectedCanonicalJournalEntryId,
    watermark: 1,
    ...canonicalJournalPayload
  };

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      facts: [fact],
      graph: {
        ...emptyState.graph,
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 2,
          entries: [retainedCanonicalEntry]
        }
      }
    },
    factDecisions: [factDecision],
    touchedEpisodes: [],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: "  ",
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.observations.length, 1);
  assert.equal(result.nextState.graph.claims.length, 1);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 1);
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.journalEntryId,
    expectedCanonicalJournalEntryId
  );
  assert.equal(result.nextState.graph.mutationJournal.entries[0]?.watermark, 1);
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.sourceTaskId,
    "task_profile_graph_store_append_duplicate_payload_canonical"
  );
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.sourceFingerprint,
    sourceFingerprint
  );
  assert.equal(result.nextState.graph.mutationJournal.entries[0]?.mutationEnvelopeHash, null);
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries[0]?.observationIds,
    [expectedObservationId]
  );
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries[0]?.claimIds,
    [expectedClaimId]
  );
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 2);
});

test("applyProfileMemoryGraphMutations compacts the oldest replay entry when a new canonical fact-side append exceeds the journal cap", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T16:20:00.000Z";
  const observedAt = "2026-04-08T15:50:00.000Z";
  const sourceFingerprint = "fingerprint_profile_graph_store_append_canonical_compaction";
  const factId = "fact_profile_graph_store_append_canonical_compaction";
  const factDecision = {
    candidate: {
      key: "identity.preferred_name",
      value: "Avery",
      sensitive: true,
      sourceTaskId: " task_profile_graph_store_append_canonical_compaction ",
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
  const expectedObservationId = `observation_${sha256HexFromCanonicalJson({
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
  const expectedClaimId =
    `claim_${sha256HexFromCanonicalJson(claimIdentity).slice(0, 24)}`;
  const fact = {
    id: factId,
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: true,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_store_append_canonical_compaction",
    source: "user_input_pattern.name_phrase",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };
  const retainedObservationOne = createGraphObservationEnvelope({
    observationId: "observation_profile_graph_store_append_canonical_compaction_1",
    stableRefId: null,
    family: "contact.owen.context.passport",
    normalizedKey: "contact.owen.context.passport",
    normalizedValue: "passport scan pending",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_append_canonical_compaction_1",
    sourceFingerprint: "fingerprint_profile_graph_store_append_canonical_compaction_1",
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-08T15:20:00.000Z",
    observedAt: "2026-04-08T15:20:00.000Z",
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: ["entity_owen"]
  }, "2026-04-08T15:20:00.000Z");
  const retainedClaimOne = createGraphClaimEnvelope({
    claimId: "claim_profile_graph_store_append_canonical_compaction_1",
    stableRefId: null,
    family: "contact.owen.context.passport",
    normalizedKey: "contact.owen.context.passport",
    normalizedValue: "passport scan pending",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_append_canonical_compaction_1",
    sourceFingerprint: "fingerprint_profile_graph_store_append_canonical_compaction_1",
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-08T15:20:00.000Z",    validFrom: "2026-04-08T15:20:00.000Z",
    validTo: null,
    endedAt: null,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    active: true,
    derivedFromObservationIds: [retainedObservationOne.payload.observationId],
    projectionSourceIds: ["fact_profile_graph_store_append_canonical_compaction_1"],
    entityRefIds: ["entity_owen"]
  }, "2026-04-08T15:20:00.000Z");
  const retainedObservationTwo = createGraphObservationEnvelope({
    observationId: "observation_profile_graph_store_append_canonical_compaction_2",
    stableRefId: null,
    family: "contact.owen.context.visa",
    normalizedKey: "contact.owen.context.visa",
    normalizedValue: "visa form pending",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_append_canonical_compaction_2",
    sourceFingerprint: "fingerprint_profile_graph_store_append_canonical_compaction_2",
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-08T15:25:00.000Z",
    observedAt: "2026-04-08T15:25:00.000Z",
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: ["entity_owen"]
  }, "2026-04-08T15:25:00.000Z");
  const retainedClaimTwo = createGraphClaimEnvelope({
    claimId: "claim_profile_graph_store_append_canonical_compaction_2",
    stableRefId: null,
    family: "contact.owen.context.visa",
    normalizedKey: "contact.owen.context.visa",
    normalizedValue: "visa form pending",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_append_canonical_compaction_2",
    sourceFingerprint: "fingerprint_profile_graph_store_append_canonical_compaction_2",
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-08T15:25:00.000Z",    validFrom: "2026-04-08T15:25:00.000Z",
    validTo: null,
    endedAt: null,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    active: true,
    derivedFromObservationIds: [retainedObservationTwo.payload.observationId],
    projectionSourceIds: ["fact_profile_graph_store_append_canonical_compaction_2"],
    entityRefIds: ["entity_owen"]
  }, "2026-04-08T15:25:00.000Z");
  const expectedJournalPayload = {
    recordedAt,
    sourceTaskId: "task_profile_graph_store_append_canonical_compaction",
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [expectedObservationId],
    claimIds: [expectedClaimId],
    eventIds: [],
    redactionState: "not_requested" as const
  };
  const expectedJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(expectedJournalPayload).slice(0, 24)}`;
  const seededJournalEntryOne = {
    journalEntryId: "journal_profile_graph_store_append_canonical_compaction_1",
    watermark: 1,
    recordedAt: "2026-04-08T15:20:00.000Z",
    sourceTaskId: retainedClaimOne.payload.sourceTaskId,
    sourceFingerprint: retainedClaimOne.payload.sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [retainedObservationOne.payload.observationId],
    claimIds: [retainedClaimOne.payload.claimId],
    eventIds: [],
    redactionState: "not_requested" as const
  };
  const seededJournalEntryTwo = {
    journalEntryId: "journal_profile_graph_store_append_canonical_compaction_2",
    watermark: 2,
    recordedAt: "2026-04-08T15:25:00.000Z",
    sourceTaskId: retainedClaimTwo.payload.sourceTaskId,
    sourceFingerprint: retainedClaimTwo.payload.sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [retainedObservationTwo.payload.observationId],
    claimIds: [retainedClaimTwo.payload.claimId],
    eventIds: [],
    redactionState: "not_requested" as const
  };

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      facts: [fact],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-08T15:30:00.000Z",
        observations: [retainedObservationOne, retainedObservationTwo],
        claims: [retainedClaimOne, retainedClaimTwo],
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 3,
          entries: [seededJournalEntryOne, seededJournalEntryTwo]
        },
        compaction: {
          ...emptyState.graph.compaction,
          maxJournalEntries: 2
        }
      }
    },
    factDecisions: [factDecision],
    touchedEpisodes: [],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: "  ",
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries.map((entry) => entry.journalEntryId),
    [
      seededJournalEntryTwo.journalEntryId,
      expectedJournalEntryId
    ]
  );
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [2, 3]
  );
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 4);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 1);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, recordedAt);
  assert.deepEqual(
    result.nextState.graph.observations.map((observation) => observation.payload.observationId),
    [
      retainedObservationOne.payload.observationId,
      retainedObservationTwo.payload.observationId,
      expectedObservationId
    ]
  );
  assert.deepEqual(
    result.nextState.graph.claims.map((claim) => claim.payload.claimId),
    [
      retainedClaimOne.payload.claimId,
      retainedClaimTwo.payload.claimId,
      expectedClaimId
    ]
  );
  assert.equal(result.nextState.graph.readModel.watermark, 3);
});

test("applyProfileMemoryGraphMutations appends a canonical replay entry for new episode-event mutations after optional metadata salvage", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T16:25:00.000Z";
  const canonicalEpisodeId = "episode_profile_graph_store_event_append_canonical";
  const sourceFingerprint = "fingerprint_profile_graph_store_event_append_canonical";
  const seededEpisode = {
    ...createProfileEpisodeRecord({
      title: "Owen tax follow-up",
      summary: "Owen still needs to send the tax form.",
      sourceTaskId: "task_profile_graph_store_event_append_canonical",
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T15:45:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_tax_form"],
      openLoopRefs: ["open_loop_owen_tax"],
      tags: ["followup"]
    }),
    id: canonicalEpisodeId
  };
  const expectedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
  const expectedJournalPayload = {
    recordedAt,
    sourceTaskId: seededEpisode.sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [expectedEventId],
    redactionState: "not_requested" as const
  };
  const expectedJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(expectedJournalPayload).slice(0, 24)}`;

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      episodes: [seededEpisode]
    },
    factDecisions: [],
    touchedEpisodes: [seededEpisode],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: "  ",
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.events.length, 1);
  assert.equal(result.nextState.graph.events[0]?.payload.eventId, expectedEventId);
  assert.equal(
    result.nextState.graph.events[0]?.payload.sourceTaskId,
    seededEpisode.sourceTaskId
  );
  assert.deepEqual(
    result.nextState.graph.events[0]?.payload.projectionSourceIds,
    [canonicalEpisodeId]
  );
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 1);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0], {
    journalEntryId: expectedJournalEntryId,
    watermark: 1,
    ...expectedJournalPayload
  });
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 2);
});

test("applyProfileMemoryGraphMutations reuses a retained legacy replay entry when episode-event payload canonicalization already matches", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T16:35:00.000Z";
  const canonicalEpisodeId = "episode_profile_graph_store_event_append_duplicate_payload";
  const sourceFingerprint = "fingerprint_profile_graph_store_event_append_duplicate_payload";
  const seededEpisode = {
    ...createProfileEpisodeRecord({
      title: "Owen passport follow-up",
      summary: "Owen still needs to send the passport scan.",
      sourceTaskId: "task_profile_graph_store_event_append_duplicate_payload",
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T15:55:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_passport_scan"],
      openLoopRefs: ["open_loop_owen_passport"],
      tags: ["followup"]
    }),
    id: canonicalEpisodeId
  };
  const expectedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
  const canonicalJournalPayload = {
    recordedAt,
    sourceTaskId: seededEpisode.sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [expectedEventId],
    redactionState: "not_requested" as const
  };
  const expectedCanonicalJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(canonicalJournalPayload).slice(0, 24)}`;
  const retainedLegacyEntry = {
    journalEntryId: "journal_profile_graph_store_event_append_duplicate_payload_legacy",
    watermark: 1,
    ...canonicalJournalPayload
  };

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      episodes: [seededEpisode],
      graph: {
        ...emptyState.graph,
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 2,
          entries: [retainedLegacyEntry]
        }
      }
    },
    factDecisions: [],
    touchedEpisodes: [seededEpisode],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: "  ",
    recordedAt
  });

  assert.notEqual(retainedLegacyEntry.journalEntryId, expectedCanonicalJournalEntryId);
  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.events.length, 1);
  assert.equal(result.nextState.graph.events[0]?.payload.eventId, expectedEventId);
  assert.equal(
    result.nextState.graph.events[0]?.payload.sourceTaskId,
    seededEpisode.sourceTaskId
  );
  assert.deepEqual(
    result.nextState.graph.events[0]?.payload.projectionSourceIds,
    [canonicalEpisodeId]
  );
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 1);
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.journalEntryId,
    retainedLegacyEntry.journalEntryId
  );
  assert.equal(result.nextState.graph.mutationJournal.entries[0]?.watermark, 1);
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.sourceTaskId,
    seededEpisode.sourceTaskId
  );
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.sourceFingerprint,
    sourceFingerprint
  );
  assert.equal(result.nextState.graph.mutationJournal.entries[0]?.mutationEnvelopeHash, null);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0]?.observationIds, []);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0]?.claimIds, []);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0]?.eventIds, [expectedEventId]);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 2);
});

test("applyProfileMemoryGraphMutations reuses an already-canonical retained replay entry when episode-event payload canonicalization matches", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T16:45:00.000Z";
  const canonicalEpisodeId = "episode_profile_graph_store_event_append_duplicate_payload_canonical";
  const sourceFingerprint = "fingerprint_profile_graph_store_event_append_duplicate_payload_canonical";
  const seededEpisode = {
    ...createProfileEpisodeRecord({
      title: "Owen onboarding follow-up",
      summary: "Owen still needs to submit the onboarding packet.",
      sourceTaskId: "task_profile_graph_store_event_append_duplicate_payload_canonical",
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T16:05:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_onboarding_packet"],
      openLoopRefs: ["open_loop_owen_onboarding"],
      tags: ["followup"]
    }),
    id: canonicalEpisodeId
  };
  const expectedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
  const canonicalJournalPayload = {
    recordedAt,
    sourceTaskId: seededEpisode.sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [expectedEventId],
    redactionState: "not_requested" as const
  };
  const expectedCanonicalJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(canonicalJournalPayload).slice(0, 24)}`;
  const retainedCanonicalEntry = {
    journalEntryId: expectedCanonicalJournalEntryId,
    watermark: 1,
    ...canonicalJournalPayload
  };

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      episodes: [seededEpisode],
      graph: {
        ...emptyState.graph,
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 2,
          entries: [retainedCanonicalEntry]
        }
      }
    },
    factDecisions: [],
    touchedEpisodes: [seededEpisode],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: "  ",
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.events.length, 1);
  assert.equal(result.nextState.graph.events[0]?.payload.eventId, expectedEventId);
  assert.equal(
    result.nextState.graph.events[0]?.payload.sourceTaskId,
    seededEpisode.sourceTaskId
  );
  assert.deepEqual(
    result.nextState.graph.events[0]?.payload.projectionSourceIds,
    [canonicalEpisodeId]
  );
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 1);
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.journalEntryId,
    expectedCanonicalJournalEntryId
  );
  assert.equal(result.nextState.graph.mutationJournal.entries[0]?.watermark, 1);
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.sourceTaskId,
    seededEpisode.sourceTaskId
  );
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.sourceFingerprint,
    sourceFingerprint
  );
  assert.equal(result.nextState.graph.mutationJournal.entries[0]?.mutationEnvelopeHash, null);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0]?.observationIds, []);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0]?.claimIds, []);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0]?.eventIds, [expectedEventId]);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 2);
});

test("applyProfileMemoryGraphMutations appends a canonical replay entry for redacted episode-event mutations after optional metadata salvage", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T16:55:00.000Z";
  const canonicalEpisodeId = "episode_profile_graph_store_redacted_event_append_canonical";
  const sourceFingerprint = "fingerprint_profile_graph_store_redacted_event_append_canonical";
  const sourceTaskId = "task_profile_graph_store_redacted_event_append_canonical";
  const seededEpisode = {
    ...createProfileEpisodeRecord({
      title: "Owen benefits follow-up",
      summary: "Owen still needs to send the benefits enrollment form.",
      sourceTaskId,
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T16:15:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_benefits_form"],
      openLoopRefs: ["open_loop_owen_benefits"],
      tags: ["followup"]
    }),
    id: canonicalEpisodeId
  };
  const expectedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
  const expectedJournalPayload = {
    recordedAt,
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [expectedEventId],
    redactionState: "redacted" as const
  };
  const expectedJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(expectedJournalPayload).slice(0, 24)}`;

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      episodes: [seededEpisode]
    },
    factDecisions: [],
    touchedEpisodes: [],
    redactedEpisodes: [seededEpisode],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: "  ",
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.events.length, 1);
  assert.equal(result.nextState.graph.events[0]?.payload.eventId, expectedEventId);
  assert.equal(result.nextState.graph.events[0]?.payload.title, "[redacted episode]");
  assert.equal(result.nextState.graph.events[0]?.payload.summary, "[redacted episode details]");
  assert.equal(result.nextState.graph.events[0]?.payload.redactionState, "redacted");
  assert.equal(result.nextState.graph.events[0]?.payload.redactedAt, recordedAt);
  assert.equal(result.nextState.graph.events[0]?.payload.sourceTaskId, null);
  assert.equal(result.nextState.graph.events[0]?.payload.sourceFingerprint, sourceFingerprint);
  assert.equal(result.nextState.graph.events[0]?.payload.sensitive, true);
  assert.equal(result.nextState.graph.events[0]?.payload.validTo, recordedAt);
  assert.deepEqual(
    result.nextState.graph.events[0]?.payload.projectionSourceIds,
    [canonicalEpisodeId]
  );
  assert.deepEqual(result.nextState.graph.events[0]?.payload.entityRefIds, []);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 1);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0], {
    journalEntryId: expectedJournalEntryId,
    watermark: 1,
    ...expectedJournalPayload
  });
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 2);
});

test("applyProfileMemoryGraphMutations reuses a retained legacy replay entry when redacted episode-event payload canonicalization already matches", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T17:05:00.000Z";
  const canonicalEpisodeId = "episode_profile_graph_store_redacted_event_append_duplicate_payload";
  const sourceFingerprint = "fingerprint_profile_graph_store_redacted_event_append_duplicate_payload";
  const sourceTaskId = "task_profile_graph_store_redacted_event_append_duplicate_payload";
  const seededEpisode = {
    ...createProfileEpisodeRecord({
      title: "Owen payroll follow-up",
      summary: "Owen still needs to send the payroll update form.",
      sourceTaskId,
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T16:25:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_payroll_form"],
      openLoopRefs: ["open_loop_owen_payroll"],
      tags: ["followup"]
    }),
    id: canonicalEpisodeId
  };
  const expectedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
  const canonicalJournalPayload = {
    recordedAt,
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [expectedEventId],
    redactionState: "redacted" as const
  };
  const expectedCanonicalJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(canonicalJournalPayload).slice(0, 24)}`;
  const retainedLegacyEntry = {
    journalEntryId: "journal_profile_graph_store_redacted_event_append_duplicate_payload_legacy",
    watermark: 1,
    ...canonicalJournalPayload
  };

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      episodes: [seededEpisode],
      graph: {
        ...emptyState.graph,
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 2,
          entries: [retainedLegacyEntry]
        }
      }
    },
    factDecisions: [],
    touchedEpisodes: [],
    redactedEpisodes: [seededEpisode],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: "  ",
    recordedAt
  });

  assert.notEqual(retainedLegacyEntry.journalEntryId, expectedCanonicalJournalEntryId);
  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.events.length, 1);
  assert.equal(result.nextState.graph.events[0]?.payload.eventId, expectedEventId);
  assert.equal(result.nextState.graph.events[0]?.payload.title, "[redacted episode]");
  assert.equal(result.nextState.graph.events[0]?.payload.summary, "[redacted episode details]");
  assert.equal(result.nextState.graph.events[0]?.payload.redactionState, "redacted");
  assert.equal(result.nextState.graph.events[0]?.payload.redactedAt, recordedAt);
  assert.equal(result.nextState.graph.events[0]?.payload.sourceTaskId, null);
  assert.equal(result.nextState.graph.events[0]?.payload.sourceFingerprint, sourceFingerprint);
  assert.equal(result.nextState.graph.events[0]?.payload.sensitive, true);
  assert.equal(result.nextState.graph.events[0]?.payload.validTo, recordedAt);
  assert.deepEqual(
    result.nextState.graph.events[0]?.payload.projectionSourceIds,
    [canonicalEpisodeId]
  );
  assert.deepEqual(result.nextState.graph.events[0]?.payload.entityRefIds, []);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 1);
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.journalEntryId,
    retainedLegacyEntry.journalEntryId
  );
  assert.equal(result.nextState.graph.mutationJournal.entries[0]?.watermark, 1);
  assert.equal(result.nextState.graph.mutationJournal.entries[0]?.sourceTaskId, sourceTaskId);
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.sourceFingerprint,
    sourceFingerprint
  );
  assert.equal(result.nextState.graph.mutationJournal.entries[0]?.mutationEnvelopeHash, null);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0]?.observationIds, []);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0]?.claimIds, []);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0]?.eventIds, [expectedEventId]);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 2);
});

test("applyProfileMemoryGraphMutations reuses an already-canonical retained replay entry when redacted episode-event payload canonicalization matches", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T17:15:00.000Z";
  const canonicalEpisodeId = "episode_profile_graph_store_redacted_event_append_duplicate_payload_canonical";
  const sourceFingerprint =
    "fingerprint_profile_graph_store_redacted_event_append_duplicate_payload_canonical";
  const sourceTaskId = "task_profile_graph_store_redacted_event_append_duplicate_payload_canonical";
  const seededEpisode = {
    ...createProfileEpisodeRecord({
      title: "Owen payroll correction follow-up",
      summary: "Owen still needs to send the payroll correction form.",
      sourceTaskId,
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T16:35:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_payroll_correction_form"],
      openLoopRefs: ["open_loop_owen_payroll_correction"],
      tags: ["followup"]
    }),
    id: canonicalEpisodeId
  };
  const expectedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
  const canonicalJournalPayload = {
    recordedAt,
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [expectedEventId],
    redactionState: "redacted" as const
  };
  const expectedCanonicalJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(canonicalJournalPayload).slice(0, 24)}`;
  const retainedCanonicalEntry = {
    journalEntryId: expectedCanonicalJournalEntryId,
    watermark: 1,
    ...canonicalJournalPayload
  };

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      episodes: [seededEpisode],
      graph: {
        ...emptyState.graph,
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 2,
          entries: [retainedCanonicalEntry]
        }
      }
    },
    factDecisions: [],
    touchedEpisodes: [],
    redactedEpisodes: [seededEpisode],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: "  ",
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.events.length, 1);
  assert.equal(result.nextState.graph.events[0]?.payload.eventId, expectedEventId);
  assert.equal(result.nextState.graph.events[0]?.payload.title, "[redacted episode]");
  assert.equal(result.nextState.graph.events[0]?.payload.summary, "[redacted episode details]");
  assert.equal(result.nextState.graph.events[0]?.payload.redactionState, "redacted");
  assert.equal(result.nextState.graph.events[0]?.payload.redactedAt, recordedAt);
  assert.equal(result.nextState.graph.events[0]?.payload.sourceTaskId, null);
  assert.equal(result.nextState.graph.events[0]?.payload.sourceFingerprint, sourceFingerprint);
  assert.equal(result.nextState.graph.events[0]?.payload.sensitive, true);
  assert.equal(result.nextState.graph.events[0]?.payload.validTo, recordedAt);
  assert.deepEqual(
    result.nextState.graph.events[0]?.payload.projectionSourceIds,
    [canonicalEpisodeId]
  );
  assert.deepEqual(result.nextState.graph.events[0]?.payload.entityRefIds, []);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 1);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0], retainedCanonicalEntry);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 2);
});

test("applyProfileMemoryGraphMutations appends a canonical replay entry when a redacted episode-event retained journal id is spoofed by a different payload", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T17:25:00.000Z";
  const canonicalEpisodeId = "episode_profile_graph_store_redacted_event_spoofed_journal";
  const sourceFingerprint = "fingerprint_profile_graph_store_redacted_event_spoofed_journal";
  const sourceTaskId = "task_profile_graph_store_redacted_event_spoofed_journal";
  const seededEpisode = {
    ...createProfileEpisodeRecord({
      title: "Owen benefits correction follow-up",
      summary: "Owen still needs to send the corrected benefits form.",
      sourceTaskId,
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T16:45:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_benefits_correction_form"],
      openLoopRefs: ["open_loop_owen_benefits_correction"],
      tags: ["followup"]
    }),
    id: canonicalEpisodeId
  };
  const expectedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
  const expectedJournalEntryId =
    `journal_${sha256HexFromCanonicalJson({
      recordedAt,
      sourceTaskId,
      sourceFingerprint,
      mutationEnvelopeHash: null,
      observationIds: [],
      claimIds: [],
      eventIds: [expectedEventId],
      redactionState: "redacted"
    }).slice(0, 24)}`;
  const spoofedRetainedEntry = {
    journalEntryId: expectedJournalEntryId,
    watermark: 1,
    recordedAt,
    sourceTaskId,
    sourceFingerprint: "fingerprint_profile_graph_store_redacted_event_spoofed_legacy",
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [expectedEventId],
    redactionState: "redacted" as const
  };

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      episodes: [seededEpisode],
      graph: {
        ...emptyState.graph,
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 2,
          entries: [spoofedRetainedEntry]
        }
      }
    },
    factDecisions: [],
    touchedEpisodes: [],
    redactedEpisodes: [seededEpisode],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.events.length, 1);
  assert.equal(result.nextState.graph.events[0]?.payload.eventId, expectedEventId);
  assert.equal(result.nextState.graph.events[0]?.payload.title, "[redacted episode]");
  assert.equal(result.nextState.graph.events[0]?.payload.summary, "[redacted episode details]");
  assert.equal(result.nextState.graph.events[0]?.payload.redactionState, "redacted");
  assert.equal(result.nextState.graph.events[0]?.payload.redactedAt, recordedAt);
  assert.equal(result.nextState.graph.events[0]?.payload.sourceTaskId, null);
  assert.equal(result.nextState.graph.events[0]?.payload.sourceFingerprint, sourceFingerprint);
  assert.equal(result.nextState.graph.events[0]?.payload.sensitive, true);
  assert.equal(result.nextState.graph.events[0]?.payload.validTo, recordedAt);
  assert.deepEqual(
    result.nextState.graph.events[0]?.payload.projectionSourceIds,
    [canonicalEpisodeId]
  );
  assert.deepEqual(result.nextState.graph.events[0]?.payload.entityRefIds, []);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 2);
  assert.equal(
    result.nextState.graph.mutationJournal.entries.filter(
      (entry) => entry.journalEntryId === expectedJournalEntryId
    ).length,
    2
  );
  const appendedEntry = result.nextState.graph.mutationJournal.entries.find(
    (entry) => entry.watermark === 2
  );
  assert.ok(appendedEntry);
  assert.equal(appendedEntry?.journalEntryId, expectedJournalEntryId);
  assert.equal(appendedEntry?.sourceTaskId, sourceTaskId);
  assert.equal(appendedEntry?.sourceFingerprint, sourceFingerprint);
  assert.equal(appendedEntry?.mutationEnvelopeHash, null);
  assert.deepEqual(appendedEntry?.observationIds, []);
  assert.deepEqual(appendedEntry?.claimIds, []);
  assert.deepEqual(appendedEntry?.eventIds, [expectedEventId]);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 3);
});

test("applyProfileMemoryGraphMutations compacts the oldest replay entry when a new canonical episode-event append exceeds the journal cap", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T17:40:00.000Z";
  const sourceFingerprint = "fingerprint_profile_graph_store_event_compaction_public";
  const seededEpisodeOne = {
    ...createProfileEpisodeRecord({
      title: "Owen passport follow-up",
      summary: "Owen still needs to send the passport scan.",
      sourceTaskId: "task_profile_graph_store_event_compaction_public_1",
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T17:00:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_passport_scan"],
      openLoopRefs: ["open_loop_owen_passport"],
      tags: ["followup"]
    }),
    id: "episode_profile_graph_store_event_compaction_public_1"
  };
  const seededEpisodeTwo = {
    ...createProfileEpisodeRecord({
      title: "Owen visa follow-up",
      summary: "Owen still needs to send the visa form.",
      sourceTaskId: "task_profile_graph_store_event_compaction_public_2",
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T17:05:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_visa_form"],
      openLoopRefs: ["open_loop_owen_visa"],
      tags: ["followup"]
    }),
    id: "episode_profile_graph_store_event_compaction_public_2"
  };
  const seededEpisodeThree = {
    ...createProfileEpisodeRecord({
      title: "Owen benefits follow-up",
      summary: "Owen still needs to send the benefits form.",
      sourceTaskId: "task_profile_graph_store_event_compaction_public_3",
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T17:10:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_benefits_form"],
      openLoopRefs: ["open_loop_owen_benefits"],
      tags: ["followup"]
    }),
    id: "episode_profile_graph_store_event_compaction_public_3"
  };
  const existingEventOneId =
    `event_${sha256HexFromCanonicalJson({ episodeId: seededEpisodeOne.id }).slice(0, 24)}`;
  const existingEventTwoId =
    `event_${sha256HexFromCanonicalJson({ episodeId: seededEpisodeTwo.id }).slice(0, 24)}`;
  const expectedEventThreeId =
    `event_${sha256HexFromCanonicalJson({ episodeId: seededEpisodeThree.id }).slice(0, 24)}`;
  const existingEventOne = createGraphEventEnvelope({
    eventId: existingEventOneId,
    stableRefId: null,
    family: "episode.candidate",
    title: seededEpisodeOne.title,
    summary: seededEpisodeOne.summary,
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: seededEpisodeOne.sourceTaskId,
    sourceFingerprint: "fingerprint_profile_graph_store_event_compaction_public_1",
    sourceTier: "explicit_user_statement",
    assertedAt: seededEpisodeOne.observedAt,
    observedAt: seededEpisodeOne.observedAt,
    validFrom: seededEpisodeOne.observedAt,
    validTo: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: [seededEpisodeOne.id],
    entityRefIds: ["entity_owen", "entity_passport_scan"]
  }, "2026-04-08T17:00:00.000Z");
  const existingEventTwo = createGraphEventEnvelope({
    eventId: existingEventTwoId,
    stableRefId: null,
    family: "episode.candidate",
    title: seededEpisodeTwo.title,
    summary: seededEpisodeTwo.summary,
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: seededEpisodeTwo.sourceTaskId,
    sourceFingerprint: "fingerprint_profile_graph_store_event_compaction_public_2",
    sourceTier: "explicit_user_statement",
    assertedAt: seededEpisodeTwo.observedAt,
    observedAt: seededEpisodeTwo.observedAt,
    validFrom: seededEpisodeTwo.observedAt,
    validTo: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: [seededEpisodeTwo.id],
    entityRefIds: ["entity_owen", "entity_visa_form"]
  }, "2026-04-08T17:05:00.000Z");
  const expectedJournalPayload = {
    recordedAt,
    sourceTaskId: seededEpisodeThree.sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [expectedEventThreeId],
    redactionState: "not_requested" as const
  };
  const expectedJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(expectedJournalPayload).slice(0, 24)}`;
  const seededJournalEntryOne = {
    journalEntryId: "journal_profile_graph_store_event_compaction_public_1",
    watermark: 1,
    recordedAt: "2026-04-08T17:00:00.000Z",
    sourceTaskId: seededEpisodeOne.sourceTaskId,
    sourceFingerprint: "fingerprint_profile_graph_store_event_compaction_public_1",
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [existingEventOneId],
    redactionState: "not_requested" as const
  };
  const seededJournalEntryTwo = {
    journalEntryId: "journal_profile_graph_store_event_compaction_public_2",
    watermark: 2,
    recordedAt: "2026-04-08T17:05:00.000Z",
    sourceTaskId: seededEpisodeTwo.sourceTaskId,
    sourceFingerprint: "fingerprint_profile_graph_store_event_compaction_public_2",
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [existingEventTwoId],
    redactionState: "not_requested" as const
  };

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      episodes: [seededEpisodeOne, seededEpisodeTwo, seededEpisodeThree],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-08T17:06:00.000Z",
        events: [existingEventOne, existingEventTwo],
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 3,
          entries: [seededJournalEntryOne, seededJournalEntryTwo]
        },
        compaction: {
          ...emptyState.graph.compaction,
          maxJournalEntries: 2
        }
      }
    },
    factDecisions: [],
    touchedEpisodes: [seededEpisodeThree],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: "  ",
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries.map((entry) => entry.journalEntryId),
    [
      seededJournalEntryTwo.journalEntryId,
      expectedJournalEntryId
    ]
  );
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [2, 3]
  );
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 4);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 1);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, recordedAt);
  assert.deepEqual(
    result.nextState.graph.events.map((event) => event.payload.eventId),
    [existingEventOneId, existingEventTwoId, expectedEventThreeId]
  );
  assert.equal(result.nextState.graph.readModel.watermark, 3);
});

test("applyProfileMemoryGraphMutations compacts the oldest replay entry when a new canonical redacted episode-event append exceeds the journal cap", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T17:45:00.000Z";
  const sourceFingerprint = "fingerprint_profile_graph_store_redacted_event_compaction_public";
  const seededEpisodeOne = {
    ...createProfileEpisodeRecord({
      title: "Owen passport follow-up",
      summary: "Owen still needs to send the passport scan.",
      sourceTaskId: "task_profile_graph_store_redacted_event_compaction_public_1",
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T17:00:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_passport_scan"],
      openLoopRefs: ["open_loop_owen_passport"],
      tags: ["followup"]
    }),
    id: "episode_profile_graph_store_redacted_event_compaction_public_1"
  };
  const seededEpisodeTwo = {
    ...createProfileEpisodeRecord({
      title: "Owen visa follow-up",
      summary: "Owen still needs to send the visa form.",
      sourceTaskId: "task_profile_graph_store_redacted_event_compaction_public_2",
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T17:05:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_visa_form"],
      openLoopRefs: ["open_loop_owen_visa"],
      tags: ["followup"]
    }),
    id: "episode_profile_graph_store_redacted_event_compaction_public_2"
  };
  const seededEpisodeThree = {
    ...createProfileEpisodeRecord({
      title: "Owen benefits follow-up",
      summary: "Owen still needs to send the benefits form.",
      sourceTaskId: "task_profile_graph_store_redacted_event_compaction_public_3",
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T17:10:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_benefits_form"],
      openLoopRefs: ["open_loop_owen_benefits"],
      tags: ["followup"]
    }),
    id: "episode_profile_graph_store_redacted_event_compaction_public_3"
  };
  const existingEventOneId =
    `event_${sha256HexFromCanonicalJson({ episodeId: seededEpisodeOne.id }).slice(0, 24)}`;
  const existingEventTwoId =
    `event_${sha256HexFromCanonicalJson({ episodeId: seededEpisodeTwo.id }).slice(0, 24)}`;
  const expectedRedactedEventThreeId =
    `event_${sha256HexFromCanonicalJson({ episodeId: seededEpisodeThree.id }).slice(0, 24)}`;
  const existingEventOne = createGraphEventEnvelope({
    eventId: existingEventOneId,
    stableRefId: null,
    family: "episode.candidate",
    title: seededEpisodeOne.title,
    summary: seededEpisodeOne.summary,
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: seededEpisodeOne.sourceTaskId,
    sourceFingerprint: "fingerprint_profile_graph_store_redacted_event_compaction_public_1",
    sourceTier: "explicit_user_statement",
    assertedAt: seededEpisodeOne.observedAt,
    observedAt: seededEpisodeOne.observedAt,
    validFrom: seededEpisodeOne.observedAt,
    validTo: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: [seededEpisodeOne.id],
    entityRefIds: ["entity_owen", "entity_passport_scan"]
  }, "2026-04-08T17:00:00.000Z");
  const existingEventTwo = createGraphEventEnvelope({
    eventId: existingEventTwoId,
    stableRefId: null,
    family: "episode.candidate",
    title: seededEpisodeTwo.title,
    summary: seededEpisodeTwo.summary,
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: seededEpisodeTwo.sourceTaskId,
    sourceFingerprint: "fingerprint_profile_graph_store_redacted_event_compaction_public_2",
    sourceTier: "explicit_user_statement",
    assertedAt: seededEpisodeTwo.observedAt,
    observedAt: seededEpisodeTwo.observedAt,
    validFrom: seededEpisodeTwo.observedAt,
    validTo: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: [seededEpisodeTwo.id],
    entityRefIds: ["entity_owen", "entity_visa_form"]
  }, "2026-04-08T17:05:00.000Z");
  const expectedJournalPayload = {
    recordedAt,
    sourceTaskId: seededEpisodeThree.sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [expectedRedactedEventThreeId],
    redactionState: "redacted" as const
  };
  const expectedJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(expectedJournalPayload).slice(0, 24)}`;
  const seededJournalEntryOne = {
    journalEntryId: "journal_profile_graph_store_redacted_event_compaction_public_1",
    watermark: 1,
    recordedAt: "2026-04-08T17:00:00.000Z",
    sourceTaskId: seededEpisodeOne.sourceTaskId,
    sourceFingerprint: "fingerprint_profile_graph_store_redacted_event_compaction_public_1",
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [existingEventOneId],
    redactionState: "not_requested" as const
  };
  const seededJournalEntryTwo = {
    journalEntryId: "journal_profile_graph_store_redacted_event_compaction_public_2",
    watermark: 2,
    recordedAt: "2026-04-08T17:05:00.000Z",
    sourceTaskId: seededEpisodeTwo.sourceTaskId,
    sourceFingerprint: "fingerprint_profile_graph_store_redacted_event_compaction_public_2",
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [existingEventTwoId],
    redactionState: "not_requested" as const
  };

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      episodes: [seededEpisodeOne, seededEpisodeTwo, seededEpisodeThree],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-08T17:06:00.000Z",
        events: [existingEventOne, existingEventTwo],
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 3,
          entries: [seededJournalEntryOne, seededJournalEntryTwo]
        },
        compaction: {
          ...emptyState.graph.compaction,
          maxJournalEntries: 2
        }
      }
    },
    factDecisions: [],
    touchedEpisodes: [],
    redactedEpisodes: [seededEpisodeThree],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: "  ",
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries.map((entry) => entry.journalEntryId),
    [seededJournalEntryTwo.journalEntryId, expectedJournalEntryId]
  );
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [2, 3]
  );
  const appendedEntry = result.nextState.graph.mutationJournal.entries[1];
  assert.equal(appendedEntry?.sourceTaskId, seededEpisodeThree.sourceTaskId);
  assert.equal(appendedEntry?.sourceFingerprint, sourceFingerprint);
  assert.equal(appendedEntry?.mutationEnvelopeHash, null);
  assert.deepEqual(appendedEntry?.observationIds, []);
  assert.deepEqual(appendedEntry?.claimIds, []);
  assert.deepEqual(appendedEntry?.eventIds, [expectedRedactedEventThreeId]);
  assert.equal(appendedEntry?.redactionState, "redacted");
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 4);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 1);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, recordedAt);
  assert.deepEqual(
    result.nextState.graph.events.map((event) => event.payload.eventId),
    [existingEventOneId, existingEventTwoId, expectedRedactedEventThreeId]
  );
  const redactedEvent = result.nextState.graph.events[2];
  assert.equal(redactedEvent?.payload.title, "[redacted episode]");
  assert.equal(redactedEvent?.payload.summary, "[redacted episode details]");
  assert.equal(redactedEvent?.payload.redactionState, "redacted");
  assert.equal(redactedEvent?.payload.redactedAt, recordedAt);
  assert.equal(redactedEvent?.payload.sourceTaskId, null);
  assert.equal(redactedEvent?.payload.sourceFingerprint, sourceFingerprint);
  assert.equal(redactedEvent?.payload.sensitive, true);
  assert.equal(redactedEvent?.payload.validTo, recordedAt);
  assert.deepEqual(redactedEvent?.payload.projectionSourceIds, [seededEpisodeThree.id]);
  assert.deepEqual(redactedEvent?.payload.entityRefIds, []);
  assert.equal(result.nextState.graph.readModel.watermark, 3);
});

test("applyProfileMemoryGraphMutations clamps stale snapshot watermark without restamping lastCompactedAt when a touched same-id event stays no-op under cap", () => {
  const emptyState = createEmptyProfileMemoryState();
  const retainedEpisodeId = "episode_profile_graph_store_event_compaction_public_clamp_retained";
  const touchedEpisodeId = "episode_profile_graph_store_event_compaction_public_clamp_touched";
  const sourceFingerprint = "fingerprint_profile_graph_store_event_compaction_public_clamp_touched";
  const retainedLastCompactedAt = "2026-04-08T17:00:00.000Z";
  const recordedAt = "2026-04-08T17:50:00.000Z";
  const retainedEpisode = {
    ...createProfileEpisodeRecord({
      title: "Owen passport follow-up",
      summary: "Owen still needs to send the passport scan.",
      sourceTaskId: "task_profile_graph_store_event_compaction_public_clamp_retained",
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T17:20:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_passport_scan"],
      openLoopRefs: ["open_loop_owen_passport"],
      tags: ["followup"]
    }),
    id: retainedEpisodeId
  };
  const touchedEpisode = {
    ...createProfileEpisodeRecord({
      title: "Owen onboarding follow-up",
      summary: "Owen still needs to send the onboarding checklist.",
      sourceTaskId: "task_profile_graph_store_event_compaction_public_clamp_touched",
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T17:22:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_onboarding_checklist"],
      openLoopRefs: ["open_loop_owen_onboarding"],
      tags: ["followup"]
    }),
    id: touchedEpisodeId
  };
  const retainedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: retainedEpisodeId }).slice(0, 24)}`;
  const touchedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: touchedEpisodeId }).slice(0, 24)}`;
  const retainedEvent = createGraphEventEnvelope({
    eventId: retainedEventId,
    stableRefId: null,
    family: "episode.candidate",
    title: retainedEpisode.title,
    summary: retainedEpisode.summary,
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: retainedEpisode.sourceTaskId,
    sourceFingerprint: "fingerprint_profile_graph_store_event_compaction_public_clamp_retained",
    sourceTier: "explicit_user_statement",
    assertedAt: retainedEpisode.observedAt,
    observedAt: retainedEpisode.observedAt,
    validFrom: retainedEpisode.observedAt,
    validTo: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: [retainedEpisodeId],
    entityRefIds: ["entity_owen", "entity_passport_scan"]
  }, "2026-04-08T17:20:00.000Z");
  const touchedEvent = createGraphEventEnvelope({
    eventId: touchedEventId,
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
    assertedAt: touchedEpisode.observedAt,
    observedAt: touchedEpisode.observedAt,
    validFrom: touchedEpisode.observedAt,
    validTo: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: [touchedEpisodeId],
    entityRefIds: ["entity_onboarding_checklist", "entity_owen"]
  }, "2026-04-08T17:22:00.000Z");
  const retainedEntryThree = {
    journalEntryId: "journal_profile_graph_store_event_compaction_public_clamp_3",
    watermark: 3,
    recordedAt: "2026-04-08T17:21:00.000Z",
    sourceTaskId: retainedEpisode.sourceTaskId,
    sourceFingerprint: "fingerprint_profile_graph_store_event_compaction_public_clamp_retained",
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [retainedEventId],
    redactionState: "not_requested" as const
  };
  const retainedEntryFour = {
    journalEntryId: "journal_profile_graph_store_event_compaction_public_clamp_4",
    watermark: 4,
    recordedAt: "2026-04-08T17:22:00.000Z",
    sourceTaskId: touchedEpisode.sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [touchedEventId],
    redactionState: "not_requested" as const
  };
  const seededState = {
    ...emptyState,
    episodes: [retainedEpisode, touchedEpisode],
    graph: {
      ...emptyState.graph,
      updatedAt: "2026-04-08T17:23:00.000Z",
      events: [retainedEvent, touchedEvent],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 5,
        entries: [retainedEntryThree, retainedEntryFour]
      },
      compaction: {
        ...emptyState.graph.compaction,
        snapshotWatermark: 99,
        lastCompactedAt: retainedLastCompactedAt,
        maxJournalEntries: 4
      }
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [],
    touchedEpisodes: [touchedEpisode],
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.updatedAt, recordedAt);
  assert.deepEqual(
    result.nextState.graph.events.map((event) => event.payload.eventId),
    [retainedEventId, touchedEventId]
  );
  assert.equal(result.nextState.graph.events[1]?.createdAt, touchedEvent.createdAt);
  assert.equal(result.nextState.graph.events[1]?.payload.eventId, touchedEventId);
  assert.equal(result.nextState.graph.events[1]?.payload.title, touchedEpisode.title);
  assert.equal(result.nextState.graph.events[1]?.payload.summary, touchedEpisode.summary);
  assert.equal(result.nextState.graph.events[1]?.payload.sourceTaskId, touchedEpisode.sourceTaskId);
  assert.equal(result.nextState.graph.events[1]?.payload.sourceFingerprint, sourceFingerprint);
  assert.deepEqual(
    result.nextState.graph.events[1]?.payload.projectionSourceIds,
    [touchedEpisodeId]
  );
  assert.deepEqual(
    result.nextState.graph.events[1]?.payload.entityRefIds,
    ["entity_onboarding_checklist", "entity_owen"]
  );
  assert.deepEqual(result.nextState.graph.mutationJournal.entries, [retainedEntryThree, retainedEntryFour]);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 5);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 2);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, retainedLastCompactedAt);
  assert.equal(result.nextState.graph.readModel.watermark, 4);
});

test("applyProfileMemoryGraphMutations clamps stale snapshot watermark from nextWatermark when a touched same-id event stays no-op with no retained journal entries", () => {
  const emptyState = createEmptyProfileMemoryState();
  const canonicalEpisodeId = "episode_profile_graph_store_event_compaction_public_empty_clamp";
  const sourceFingerprint = "fingerprint_profile_graph_store_event_compaction_public_empty_clamp";
  const retainedLastCompactedAt = "2026-04-08T17:45:00.000Z";
  const recordedAt = "2026-04-08T17:55:00.000Z";
  const retainedCreatedAt = "2026-04-08T17:12:00.000Z";
  const expectedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
  const seededEpisode = {
    ...createProfileEpisodeRecord({
      title: "Owen tax follow-up",
      summary: "Owen still needs to send the tax form.",
      sourceTaskId: "task_profile_graph_store_event_compaction_public_empty_clamp",
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T17:32:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_tax_form"],
      openLoopRefs: ["open_loop_owen_tax"],
      tags: ["followup"]
    }),
    id: canonicalEpisodeId
  };
  const existingEvent = createGraphEventEnvelope({
    eventId: expectedEventId,
    stableRefId: null,
    family: "episode.candidate",
    title: seededEpisode.title,
    summary: seededEpisode.summary,
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: seededEpisode.sourceTaskId,
    sourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: seededEpisode.observedAt,
    observedAt: seededEpisode.observedAt,
    validFrom: seededEpisode.observedAt,
    validTo: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: [canonicalEpisodeId],
    entityRefIds: ["entity_owen", "entity_tax_form"]
  }, retainedCreatedAt);
  const seededState = {
    ...emptyState,
    episodes: [seededEpisode],
    graph: {
      ...emptyState.graph,
      updatedAt: "2026-04-08T17:40:00.000Z",
      events: [existingEvent],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 6,
        entries: []
      },
      compaction: {
        ...emptyState.graph.compaction,
        snapshotWatermark: 99,
        lastCompactedAt: retainedLastCompactedAt,
        maxJournalEntries: 4
      }
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [],
    touchedEpisodes: [seededEpisode],
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.updatedAt, recordedAt);
  assert.equal(result.nextState.graph.events.length, 1);
  assert.deepEqual(result.nextState.graph.events[0]?.payload.eventId, expectedEventId);
  assert.equal(result.nextState.graph.events[0]?.createdAt, retainedCreatedAt);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries, []);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 6);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 5);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, retainedLastCompactedAt);
  assert.equal(result.nextState.graph.readModel.watermark, 5);
});

test("applyProfileMemoryGraphMutations stays a true no-op when retained replay rows and compaction are already replay-safe", () => {
  const emptyState = createEmptyProfileMemoryState();
  const retainedEpisodeId = "episode_profile_graph_store_event_compaction_public_noop_retained";
  const touchedEpisodeId = "episode_profile_graph_store_event_compaction_public_noop_touched";
  const retainedLastCompactedAt = "2026-04-08T18:00:00.000Z";
  const recordedAt = "2026-04-08T18:10:00.000Z";
  const touchedSourceFingerprint = "fingerprint_profile_graph_store_event_compaction_public_noop_touched";
  const retainedEpisode = {
    ...createProfileEpisodeRecord({
      title: "Owen passport follow-up",
      summary: "Owen still needs to send the passport scan.",
      sourceTaskId: "task_profile_graph_store_event_compaction_public_noop_retained",
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T17:40:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_passport_scan"],
      openLoopRefs: ["open_loop_owen_passport"],
      tags: ["followup"]
    }),
    id: retainedEpisodeId
  };
  const touchedEpisode = {
    ...createProfileEpisodeRecord({
      title: "Owen onboarding follow-up",
      summary: "Owen still needs to send the onboarding checklist.",
      sourceTaskId: "task_profile_graph_store_event_compaction_public_noop_touched",
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T17:42:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_onboarding_checklist"],
      openLoopRefs: ["open_loop_owen_onboarding"],
      tags: ["followup"]
    }),
    id: touchedEpisodeId
  };
  const retainedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: retainedEpisodeId }).slice(0, 24)}`;
  const touchedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: touchedEpisodeId }).slice(0, 24)}`;
  const retainedEvent = createGraphEventEnvelope({
    eventId: retainedEventId,
    stableRefId: null,
    family: "episode.candidate",
    title: retainedEpisode.title,
    summary: retainedEpisode.summary,
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: retainedEpisode.sourceTaskId,
    sourceFingerprint: "fingerprint_profile_graph_store_event_compaction_public_noop_retained",
    sourceTier: "explicit_user_statement",
    assertedAt: retainedEpisode.observedAt,
    observedAt: retainedEpisode.observedAt,
    validFrom: retainedEpisode.observedAt,
    validTo: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: [retainedEpisodeId],
    entityRefIds: ["entity_owen", "entity_passport_scan"]
  }, "2026-04-08T17:40:00.000Z");
  const touchedEvent = createGraphEventEnvelope({
    eventId: touchedEventId,
    stableRefId: null,
    family: "episode.candidate",
    title: touchedEpisode.title,
    summary: touchedEpisode.summary,
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: touchedEpisode.sourceTaskId,
    sourceFingerprint: touchedSourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: touchedEpisode.observedAt,
    observedAt: touchedEpisode.observedAt,
    validFrom: touchedEpisode.observedAt,
    validTo: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: [touchedEpisodeId],
    entityRefIds: ["entity_onboarding_checklist", "entity_owen"]
  }, "2026-04-08T17:42:00.000Z");
  const retainedEntryThree = {
    journalEntryId: "journal_profile_graph_store_event_compaction_public_noop_3",
    watermark: 3,
    recordedAt: "2026-04-08T17:41:00.000Z",
    sourceTaskId: retainedEpisode.sourceTaskId,
    sourceFingerprint: "fingerprint_profile_graph_store_event_compaction_public_noop_retained",
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [retainedEventId],
    redactionState: "not_requested" as const
  };
  const retainedEntryFour = {
    journalEntryId: "journal_profile_graph_store_event_compaction_public_noop_4",
    watermark: 4,
    recordedAt: "2026-04-08T17:42:00.000Z",
    sourceTaskId: touchedEpisode.sourceTaskId,
    sourceFingerprint: touchedSourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [touchedEventId],
    redactionState: "not_requested" as const
  };
  const seededState = {
    ...emptyState,
    episodes: [retainedEpisode, touchedEpisode],
    graph: {
      ...emptyState.graph,
      updatedAt: "2026-04-08T17:43:00.000Z",
      events: [retainedEvent, touchedEvent],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 5,
        entries: [retainedEntryThree, retainedEntryFour]
      },
      compaction: {
        ...emptyState.graph.compaction,
        snapshotWatermark: 2,
        lastCompactedAt: retainedLastCompactedAt,
        maxJournalEntries: 4
      }
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [],
    touchedEpisodes: [touchedEpisode],
    sourceFingerprint: touchedSourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, false);
  assert.equal(result.nextState, seededState);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries, [retainedEntryThree, retainedEntryFour]);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 5);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 2);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, retainedLastCompactedAt);
});

test("applyProfileMemoryGraphMutations keeps redacted same-id events as a true no-op when retained replay rows and compaction are already replay-safe", () => {
  const emptyState = createEmptyProfileMemoryState();
  const retainedEpisodeId = "episode_profile_graph_store_redacted_event_compaction_noop_retained";
  const redactedEpisodeId = "episode_profile_graph_store_redacted_event_compaction_noop_redacted";
  const sourceTaskId = "task_profile_graph_store_redacted_event_compaction_noop";
  const sourceFingerprint = "fingerprint_profile_graph_store_redacted_event_compaction_noop";
  const retainedLastCompactedAt = "2026-04-08T18:20:00.000Z";
  const recordedAt = "2026-04-08T18:30:00.000Z";
  const retainedEpisode = {
    ...createProfileEpisodeRecord({
      title: "Owen passport follow-up",
      summary: "Owen still needs to send the passport scan.",
      sourceTaskId: "task_profile_graph_store_redacted_event_compaction_noop_retained",
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T18:00:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_passport_scan"],
      openLoopRefs: ["open_loop_owen_passport"],
      tags: ["followup"]
    }),
    id: retainedEpisodeId
  };
  const redactedEpisode = {
    ...createProfileEpisodeRecord({
      title: "Owen tax follow-up",
      summary: "Owen still needs to send the tax form.",
      sourceTaskId,
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T18:05:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_tax_form"],
      openLoopRefs: ["open_loop_owen_tax"],
      tags: ["followup"]
    }),
    id: redactedEpisodeId
  };
  const retainedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: retainedEpisodeId }).slice(0, 24)}`;
  const redactedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: redactedEpisodeId }).slice(0, 24)}`;
  const retainedEvent = createGraphEventEnvelope({
    eventId: retainedEventId,
    stableRefId: null,
    family: "episode.candidate",
    title: retainedEpisode.title,
    summary: retainedEpisode.summary,
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: retainedEpisode.sourceTaskId,
    sourceFingerprint: "fingerprint_profile_graph_store_redacted_event_compaction_noop_retained",
    sourceTier: "explicit_user_statement",
    assertedAt: retainedEpisode.observedAt,
    observedAt: retainedEpisode.observedAt,
    validFrom: retainedEpisode.observedAt,
    validTo: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: [retainedEpisodeId],
    entityRefIds: ["entity_owen", "entity_passport_scan"]
  }, "2026-04-08T18:00:00.000Z");
  const redactedEvent = createGraphEventEnvelope({
    eventId: redactedEventId,
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
    assertedAt: redactedEpisode.observedAt,
    observedAt: redactedEpisode.observedAt,
    validFrom: redactedEpisode.observedAt,
    validTo: recordedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: [redactedEpisodeId],
    entityRefIds: []
  }, "2026-04-08T18:05:00.000Z");
  const retainedEntryThree = {
    journalEntryId: "journal_profile_graph_store_redacted_event_compaction_noop_3",
    watermark: 3,
    recordedAt: "2026-04-08T18:00:00.000Z",
    sourceTaskId: retainedEpisode.sourceTaskId,
    sourceFingerprint: "fingerprint_profile_graph_store_redacted_event_compaction_noop_retained",
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [retainedEventId],
    redactionState: "not_requested" as const
  };
  const retainedEntryFour = {
    journalEntryId: "journal_profile_graph_store_redacted_event_compaction_noop_4",
    watermark: 4,
    recordedAt,
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [redactedEventId],
    redactionState: "redacted" as const
  };
  const seededState = {
    ...emptyState,
    episodes: [retainedEpisode, redactedEpisode],
    graph: {
      ...emptyState.graph,
      updatedAt: recordedAt,
      events: [retainedEvent, redactedEvent],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 5,
        entries: [retainedEntryThree, retainedEntryFour]
      },
      compaction: {
        ...emptyState.graph.compaction,
        snapshotWatermark: 2,
        lastCompactedAt: retainedLastCompactedAt,
        maxJournalEntries: 4
      }
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [],
    touchedEpisodes: [],
    redactedEpisodes: [redactedEpisode],
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, false);
  assert.equal(result.nextState, seededState);
  assert.deepEqual(result.nextState.graph.events, [retainedEvent, redactedEvent]);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries, [retainedEntryThree, retainedEntryFour]);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 5);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 2);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, retainedLastCompactedAt);
});

test("applyProfileMemoryGraphMutations clamps stale snapshot watermark without restamping lastCompactedAt when a redacted same-id event stays no-op under cap", () => {
  const emptyState = createEmptyProfileMemoryState();
  const retainedEpisodeId = "episode_profile_graph_store_redacted_event_compaction_clamp_retained";
  const redactedEpisodeId = "episode_profile_graph_store_redacted_event_compaction_clamp_redacted";
  const sourceTaskId = "task_profile_graph_store_redacted_event_compaction_clamp";
  const sourceFingerprint = "fingerprint_profile_graph_store_redacted_event_compaction_clamp";
  const retainedLastCompactedAt = "2026-04-08T18:40:00.000Z";
  const recordedAt = "2026-04-08T18:50:00.000Z";
  const retainedEpisode = {
    ...createProfileEpisodeRecord({
      title: "Owen passport follow-up",
      summary: "Owen still needs to send the passport scan.",
      sourceTaskId: "task_profile_graph_store_redacted_event_compaction_clamp_retained",
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T18:20:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_passport_scan"],
      openLoopRefs: ["open_loop_owen_passport"],
      tags: ["followup"]
    }),
    id: retainedEpisodeId
  };
  const redactedEpisode = {
    ...createProfileEpisodeRecord({
      title: "Owen tax follow-up",
      summary: "Owen still needs to send the tax form.",
      sourceTaskId,
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T18:25:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_tax_form"],
      openLoopRefs: ["open_loop_owen_tax"],
      tags: ["followup"]
    }),
    id: redactedEpisodeId
  };
  const retainedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: retainedEpisodeId }).slice(0, 24)}`;
  const redactedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: redactedEpisodeId }).slice(0, 24)}`;
  const retainedEvent = createGraphEventEnvelope({
    eventId: retainedEventId,
    stableRefId: null,
    family: "episode.candidate",
    title: retainedEpisode.title,
    summary: retainedEpisode.summary,
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: retainedEpisode.sourceTaskId,
    sourceFingerprint: "fingerprint_profile_graph_store_redacted_event_compaction_clamp_retained",
    sourceTier: "explicit_user_statement",
    assertedAt: retainedEpisode.observedAt,
    observedAt: retainedEpisode.observedAt,
    validFrom: retainedEpisode.observedAt,
    validTo: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: [retainedEpisodeId],
    entityRefIds: ["entity_owen", "entity_passport_scan"]
  }, "2026-04-08T18:20:00.000Z");
  const redactedEvent = createGraphEventEnvelope({
    eventId: redactedEventId,
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
    assertedAt: redactedEpisode.observedAt,
    observedAt: redactedEpisode.observedAt,
    validFrom: redactedEpisode.observedAt,
    validTo: recordedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: [redactedEpisodeId],
    entityRefIds: []
  }, "2026-04-08T18:25:00.000Z");
  const retainedEntryThree = {
    journalEntryId: "journal_profile_graph_store_redacted_event_compaction_clamp_3",
    watermark: 3,
    recordedAt: "2026-04-08T18:20:00.000Z",
    sourceTaskId: retainedEpisode.sourceTaskId,
    sourceFingerprint: "fingerprint_profile_graph_store_redacted_event_compaction_clamp_retained",
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [retainedEventId],
    redactionState: "not_requested" as const
  };
  const retainedEntryFour = {
    journalEntryId: "journal_profile_graph_store_redacted_event_compaction_clamp_4",
    watermark: 4,
    recordedAt,
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [],
    claimIds: [],
    eventIds: [redactedEventId],
    redactionState: "redacted" as const
  };
  const seededState = {
    ...emptyState,
    episodes: [retainedEpisode, redactedEpisode],
    graph: {
      ...emptyState.graph,
      updatedAt: "2026-04-08T18:45:00.000Z",
      events: [retainedEvent, redactedEvent],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 5,
        entries: [retainedEntryThree, retainedEntryFour]
      },
      compaction: {
        ...emptyState.graph.compaction,
        snapshotWatermark: 99,
        lastCompactedAt: retainedLastCompactedAt,
        maxJournalEntries: 4
      }
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [],
    touchedEpisodes: [],
    redactedEpisodes: [redactedEpisode],
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.updatedAt, recordedAt);
  assert.deepEqual(result.nextState.graph.events, [retainedEvent, redactedEvent]);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries, [retainedEntryThree, retainedEntryFour]);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 5);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 2);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, retainedLastCompactedAt);
  assert.equal(result.nextState.graph.readModel.watermark, 4);
});

test("applyProfileMemoryGraphMutations clamps stale snapshot watermark from nextWatermark when a redacted same-id event stays no-op with no retained journal entries", () => {
  const emptyState = createEmptyProfileMemoryState();
  const redactedEpisodeId = "episode_profile_graph_store_redacted_event_compaction_public_empty_clamp";
  const sourceTaskId = "task_profile_graph_store_redacted_event_compaction_public_empty_clamp";
  const sourceFingerprint = "fingerprint_profile_graph_store_redacted_event_compaction_public_empty_clamp";
  const retainedLastCompactedAt = "2026-04-08T18:55:00.000Z";
  const recordedAt = "2026-04-08T19:05:00.000Z";
  const retainedCreatedAt = "2026-04-08T18:22:00.000Z";
  const expectedEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: redactedEpisodeId }).slice(0, 24)}`;
  const redactedEpisode = {
    ...createProfileEpisodeRecord({
      title: "Owen tax follow-up",
      summary: "Owen still needs to send the tax form.",
      sourceTaskId,
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      sensitive: false,
      observedAt: "2026-04-08T18:42:00.000Z",
      confidence: 0.88,
      entityRefs: ["entity_owen", "entity_tax_form"],
      openLoopRefs: ["open_loop_owen_tax"],
      tags: ["followup"]
    }),
    id: redactedEpisodeId
  };
  const existingRedactedEvent = createGraphEventEnvelope({
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
    assertedAt: redactedEpisode.observedAt,
    observedAt: redactedEpisode.observedAt,
    validFrom: redactedEpisode.observedAt,
    validTo: recordedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    derivedFromObservationIds: [],
    projectionSourceIds: [redactedEpisodeId],
    entityRefIds: []
  }, retainedCreatedAt);
  const seededState = {
    ...emptyState,
    episodes: [redactedEpisode],
    graph: {
      ...emptyState.graph,
      updatedAt: "2026-04-08T18:50:00.000Z",
      events: [existingRedactedEvent],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 6,
        entries: []
      },
      compaction: {
        ...emptyState.graph.compaction,
        snapshotWatermark: 99,
        lastCompactedAt: retainedLastCompactedAt,
        maxJournalEntries: 4
      }
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [],
    touchedEpisodes: [],
    redactedEpisodes: [redactedEpisode],
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.updatedAt, recordedAt);
  assert.equal(result.nextState.graph.events.length, 1);
  assert.deepEqual(result.nextState.graph.events[0]?.payload.eventId, expectedEventId);
  assert.equal(result.nextState.graph.events[0]?.createdAt, retainedCreatedAt);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries, []);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 6);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 5);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, retainedLastCompactedAt);
  assert.equal(result.nextState.graph.readModel.watermark, 5);
});

test("applyProfileMemoryGraphMutations appends a canonical replay entry for fact-forget mutations after optional metadata salvage", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-07T15:10:00.000Z";
  const observedAt = "2026-04-07T14:45:00.000Z";
  const sourceTaskId = "task_profile_graph_store_fact_redaction_append_canonical";
  const sourceFingerprint = "fingerprint_profile_graph_store_fact_redaction_append_canonical";
  const observationId = "observation_profile_graph_store_fact_redaction_append_canonical";
  const claimId = "claim_profile_graph_store_fact_redaction_append_canonical";
  const redactedFactId = "fact_profile_graph_store_fact_redaction_append_canonical";
  const existingObservation = createGraphObservationEnvelope({
    observationId,
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_append_seed",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_append_seed",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    observedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:12:00.000Z");
  const existingClaim = createGraphClaimEnvelope({
    claimId,
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_append_seed",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_append_seed",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,    validFrom: observedAt,
    validTo: null,
    endedAt: null,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    active: true,
    derivedFromObservationIds: [observationId],
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
    sourceTaskId: "task_profile_graph_store_fact_redaction_append_seed",
    source: "user_input_pattern.name_preference",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };
  const expectedJournalPayload = {
    recordedAt,
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [observationId],
    claimIds: [claimId],
    eventIds: [],
    redactionState: "redacted" as const
  };
  const expectedJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(expectedJournalPayload).slice(0, 24)}`;

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        observations: [existingObservation],
        claims: [existingClaim]
      }
    },
    factDecisions: [],
    touchedEpisodes: [],
    redactedFacts: [redactedFact],
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: "  ",
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.observations[0]?.payload.normalizedValue, null);
  assert.equal(result.nextState.graph.observations[0]?.payload.redactionState, "redacted");
  assert.equal(result.nextState.graph.observations[0]?.payload.redactedAt, recordedAt);
  assert.equal(result.nextState.graph.observations[0]?.payload.sourceTaskId, sourceTaskId);
  assert.equal(result.nextState.graph.observations[0]?.payload.sourceFingerprint, sourceFingerprint);
  assert.equal(result.nextState.graph.claims[0]?.payload.normalizedValue, null);
  assert.equal(result.nextState.graph.claims[0]?.payload.redactionState, "redacted");
  assert.equal(result.nextState.graph.claims[0]?.payload.redactedAt, recordedAt);
  assert.equal(result.nextState.graph.claims[0]?.payload.sourceTaskId, sourceTaskId);
  assert.equal(result.nextState.graph.claims[0]?.payload.sourceFingerprint, sourceFingerprint);
  assert.equal(result.nextState.graph.claims[0]?.payload.active, false);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 1);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0], {
    journalEntryId: expectedJournalEntryId,
    watermark: 1,
    ...expectedJournalPayload
  });
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 2);
  assert.equal(result.nextState.graph.readModel.watermark, 1);
});

test("applyProfileMemoryGraphMutations reuses a retained legacy replay entry when fact-forget payload canonicalization already matches", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-07T15:15:00.000Z";
  const observedAt = "2026-04-07T14:45:00.000Z";
  const sourceFingerprint = "fingerprint_profile_graph_store_fact_redaction_duplicate_payload";
  const redactedFactSourceTaskId = "task_profile_graph_store_fact_redaction_duplicate_payload";
  const observationId = "observation_profile_graph_store_fact_redaction_duplicate_payload";
  const claimId = "claim_profile_graph_store_fact_redaction_duplicate_payload";
  const redactedFactId = "fact_profile_graph_store_fact_redaction_duplicate_payload";
  const existingObservation = createGraphObservationEnvelope({
    observationId,
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_duplicate_seed",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_duplicate_seed",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    observedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:12:00.000Z");
  const existingClaim = createGraphClaimEnvelope({
    claimId,
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_duplicate_seed",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_duplicate_seed",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,    validFrom: observedAt,
    validTo: null,
    endedAt: null,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    active: true,
    derivedFromObservationIds: [observationId],
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
    sourceTaskId: redactedFactSourceTaskId,
    source: "user_input_pattern.name_preference",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };
  const canonicalJournalPayload = {
    recordedAt,
    sourceTaskId: redactedFactSourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [observationId],
    claimIds: [claimId],
    eventIds: [],
    redactionState: "redacted" as const
  };
  const expectedCanonicalJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(canonicalJournalPayload).slice(0, 24)}`;
  const retainedLegacyEntry = {
    journalEntryId: "journal_profile_graph_store_fact_redaction_duplicate_payload_legacy",
    watermark: 1,
    ...canonicalJournalPayload
  };

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        observations: [existingObservation],
        claims: [existingClaim],
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 2,
          entries: [retainedLegacyEntry]
        }
      }
    },
    factDecisions: [],
    touchedEpisodes: [],
    redactedFacts: [redactedFact],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: "  ",
    recordedAt
  });

  assert.notEqual(retainedLegacyEntry.journalEntryId, expectedCanonicalJournalEntryId);
  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.observations.length, 1);
  assert.equal(result.nextState.graph.claims.length, 1);
  assert.equal(result.nextState.graph.observations[0]?.payload.redactionState, "redacted");
  assert.equal(result.nextState.graph.observations[0]?.payload.sourceTaskId, null);
  assert.equal(result.nextState.graph.claims[0]?.payload.redactionState, "redacted");
  assert.equal(result.nextState.graph.claims[0]?.payload.sourceTaskId, null);
  assert.equal(result.nextState.graph.claims[0]?.payload.active, false);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 1);
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.journalEntryId,
    retainedLegacyEntry.journalEntryId
  );
  assert.equal(result.nextState.graph.mutationJournal.entries[0]?.watermark, 1);
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.sourceTaskId,
    redactedFactSourceTaskId
  );
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.sourceFingerprint,
    sourceFingerprint
  );
  assert.equal(result.nextState.graph.mutationJournal.entries[0]?.mutationEnvelopeHash, null);
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries[0]?.observationIds,
    [observationId]
  );
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries[0]?.claimIds,
    [claimId]
  );
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0]?.eventIds, []);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 2);
  assert.equal(result.nextState.graph.readModel.watermark, 1);
});

test("applyProfileMemoryGraphMutations reuses an already-canonical retained replay entry when fact-forget payload canonicalization matches", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-07T15:17:00.000Z";
  const observedAt = "2026-04-07T14:45:00.000Z";
  const sourceFingerprint =
    "fingerprint_profile_graph_store_fact_redaction_duplicate_payload_canonical";
  const redactedFactSourceTaskId =
    "task_profile_graph_store_fact_redaction_duplicate_payload_canonical";
  const observationId = "observation_profile_graph_store_fact_redaction_duplicate_payload_canonical";
  const claimId = "claim_profile_graph_store_fact_redaction_duplicate_payload_canonical";
  const redactedFactId = "fact_profile_graph_store_fact_redaction_duplicate_payload_canonical";
  const existingObservation = createGraphObservationEnvelope({
    observationId,
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_duplicate_canonical_seed",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_duplicate_canonical_seed",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    observedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:12:00.000Z");
  const existingClaim = createGraphClaimEnvelope({
    claimId,
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_duplicate_canonical_seed",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_duplicate_canonical_seed",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,    validFrom: observedAt,
    validTo: null,
    endedAt: null,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    active: true,
    derivedFromObservationIds: [observationId],
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
    sourceTaskId: redactedFactSourceTaskId,
    source: "user_input_pattern.name_preference",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };
  const canonicalJournalPayload = {
    recordedAt,
    sourceTaskId: redactedFactSourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [observationId],
    claimIds: [claimId],
    eventIds: [],
    redactionState: "redacted" as const
  };
  const expectedCanonicalJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(canonicalJournalPayload).slice(0, 24)}`;
  const retainedCanonicalEntry = {
    journalEntryId: expectedCanonicalJournalEntryId,
    watermark: 1,
    ...canonicalJournalPayload
  };

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        observations: [existingObservation],
        claims: [existingClaim],
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 2,
          entries: [retainedCanonicalEntry]
        }
      }
    },
    factDecisions: [],
    touchedEpisodes: [],
    redactedFacts: [redactedFact],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: "  ",
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.observations.length, 1);
  assert.equal(result.nextState.graph.claims.length, 1);
  assert.equal(result.nextState.graph.observations[0]?.payload.redactionState, "redacted");
  assert.equal(result.nextState.graph.observations[0]?.payload.sourceTaskId, null);
  assert.equal(result.nextState.graph.claims[0]?.payload.redactionState, "redacted");
  assert.equal(result.nextState.graph.claims[0]?.payload.sourceTaskId, null);
  assert.equal(result.nextState.graph.claims[0]?.payload.active, false);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 1);
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.journalEntryId,
    expectedCanonicalJournalEntryId
  );
  assert.equal(result.nextState.graph.mutationJournal.entries[0]?.watermark, 1);
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.sourceTaskId,
    redactedFactSourceTaskId
  );
  assert.equal(
    result.nextState.graph.mutationJournal.entries[0]?.sourceFingerprint,
    sourceFingerprint
  );
  assert.equal(result.nextState.graph.mutationJournal.entries[0]?.mutationEnvelopeHash, null);
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries[0]?.observationIds,
    [observationId]
  );
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries[0]?.claimIds,
    [claimId]
  );
  assert.deepEqual(result.nextState.graph.mutationJournal.entries[0]?.eventIds, []);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 2);
  assert.equal(result.nextState.graph.readModel.watermark, 1);
});

test("applyProfileMemoryGraphMutations compacts the oldest replay entry when a new canonical fact-forget append exceeds the journal cap", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-07T15:25:00.000Z";
  const sourceFingerprint = "fingerprint_profile_graph_store_fact_redaction_compaction_public";
  const targetObservedAt = "2026-04-07T14:45:00.000Z";
  const redactedFactSourceTaskId = "task_profile_graph_store_fact_redaction_compaction_public_3";
  const retainedObservationOne = createGraphObservationEnvelope({
    observationId: "observation_profile_graph_store_fact_redaction_compaction_public_1",
    stableRefId: null,
    family: "contact.owen.context.passport",
    normalizedKey: "contact.owen.context.passport",
    normalizedValue: "passport scan pending",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_compaction_public_1",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_compaction_public_1",
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-07T14:00:00.000Z",
    observedAt: "2026-04-07T14:00:00.000Z",
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: ["entity_owen"]
  }, "2026-04-07T14:00:00.000Z");
  const retainedClaimOne = createGraphClaimEnvelope({
    claimId: "claim_profile_graph_store_fact_redaction_compaction_public_1",
    stableRefId: null,
    family: "contact.owen.context.passport",
    normalizedKey: "contact.owen.context.passport",
    normalizedValue: "passport scan pending",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_compaction_public_1",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_compaction_public_1",
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-07T14:00:00.000Z",    validFrom: "2026-04-07T14:00:00.000Z",
    validTo: null,
    endedAt: null,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    active: true,
    derivedFromObservationIds: [retainedObservationOne.payload.observationId],
    projectionSourceIds: ["fact_profile_graph_store_fact_redaction_compaction_public_1"],
    entityRefIds: ["entity_owen"]
  }, "2026-04-07T14:00:00.000Z");
  const retainedObservationTwo = createGraphObservationEnvelope({
    observationId: "observation_profile_graph_store_fact_redaction_compaction_public_2",
    stableRefId: null,
    family: "contact.owen.context.visa",
    normalizedKey: "contact.owen.context.visa",
    normalizedValue: "visa form pending",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_compaction_public_2",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_compaction_public_2",
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-07T14:05:00.000Z",
    observedAt: "2026-04-07T14:05:00.000Z",
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: ["entity_owen"]
  }, "2026-04-07T14:05:00.000Z");
  const retainedClaimTwo = createGraphClaimEnvelope({
    claimId: "claim_profile_graph_store_fact_redaction_compaction_public_2",
    stableRefId: null,
    family: "contact.owen.context.visa",
    normalizedKey: "contact.owen.context.visa",
    normalizedValue: "visa form pending",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_compaction_public_2",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_compaction_public_2",
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-07T14:05:00.000Z",    validFrom: "2026-04-07T14:05:00.000Z",
    validTo: null,
    endedAt: null,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    active: true,
    derivedFromObservationIds: [retainedObservationTwo.payload.observationId],
    projectionSourceIds: ["fact_profile_graph_store_fact_redaction_compaction_public_2"],
    entityRefIds: ["entity_owen"]
  }, "2026-04-07T14:05:00.000Z");
  const targetObservation = createGraphObservationEnvelope({
    observationId: "observation_profile_graph_store_fact_redaction_compaction_public_3",
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_compaction_seed",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_compaction_seed",
    sourceTier: "explicit_user_statement",
    assertedAt: targetObservedAt,
    observedAt: targetObservedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:12:00.000Z");
  const targetClaim = createGraphClaimEnvelope({
    claimId: "claim_profile_graph_store_fact_redaction_compaction_public_3",
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_compaction_seed",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_compaction_seed",
    sourceTier: "explicit_user_statement",
    assertedAt: targetObservedAt,    validFrom: targetObservedAt,
    validTo: null,
    endedAt: null,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    active: true,
    derivedFromObservationIds: [targetObservation.payload.observationId],
    projectionSourceIds: ["fact_profile_graph_store_fact_redaction_compaction_public_3"],
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:13:00.000Z");
  const expectedJournalPayload = {
    recordedAt,
    sourceTaskId: redactedFactSourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [targetObservation.payload.observationId],
    claimIds: [targetClaim.payload.claimId],
    eventIds: [],
    redactionState: "redacted" as const
  };
  const expectedJournalEntryId =
    `journal_${sha256HexFromCanonicalJson(expectedJournalPayload).slice(0, 24)}`;
  const seededJournalEntryOne = {
    journalEntryId: "journal_profile_graph_store_fact_redaction_compaction_public_1",
    watermark: 1,
    recordedAt: "2026-04-07T14:00:00.000Z",
    sourceTaskId: retainedClaimOne.payload.sourceTaskId,
    sourceFingerprint: retainedClaimOne.payload.sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [retainedObservationOne.payload.observationId],
    claimIds: [retainedClaimOne.payload.claimId],
    eventIds: [],
    redactionState: "not_requested" as const
  };
  const seededJournalEntryTwo = {
    journalEntryId: "journal_profile_graph_store_fact_redaction_compaction_public_2",
    watermark: 2,
    recordedAt: "2026-04-07T14:05:00.000Z",
    sourceTaskId: retainedClaimTwo.payload.sourceTaskId,
    sourceFingerprint: retainedClaimTwo.payload.sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [retainedObservationTwo.payload.observationId],
    claimIds: [retainedClaimTwo.payload.claimId],
    eventIds: [],
    redactionState: "not_requested" as const
  };
  const redactedFact = {
    id: "fact_profile_graph_store_fact_redaction_compaction_public_3",
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: false,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: redactedFactSourceTaskId,
    source: "user_input_pattern.name_preference",
    observedAt: targetObservedAt,
    confirmedAt: targetObservedAt,
    supersededAt: null,
    lastUpdatedAt: targetObservedAt
  };

  const result = applyProfileMemoryGraphMutations({
    state: {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        observations: [retainedObservationOne, retainedObservationTwo, targetObservation],
        claims: [retainedClaimOne, retainedClaimTwo, targetClaim],
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 3,
          entries: [seededJournalEntryOne, seededJournalEntryTwo]
        },
        compaction: {
          ...emptyState.graph.compaction,
          maxJournalEntries: 2
        }
      }
    },
    factDecisions: [],
    touchedEpisodes: [],
    redactedFacts: [redactedFact],
    sourceTaskId: "   ",
    sourceFingerprint,
    mutationEnvelopeHash: "  ",
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.observations.length, 3);
  assert.equal(result.nextState.graph.claims.length, 3);
  assert.equal(result.nextState.graph.observations[2]?.payload.redactionState, "redacted");
  assert.equal(result.nextState.graph.claims[2]?.payload.redactionState, "redacted");
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries.map((entry) => entry.journalEntryId),
    [
      seededJournalEntryTwo.journalEntryId,
      expectedJournalEntryId
    ]
  );
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries.map((entry) => entry.watermark),
    [2, 3]
  );
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 4);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 1);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, recordedAt);
  assert.equal(result.nextState.graph.readModel.watermark, 3);
});

test("applyProfileMemoryGraphMutations preserves retained observation and claim envelope createdAt during fact forget repair", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-07T15:20:00.000Z";
  const observedAt = "2026-04-07T14:45:00.000Z";
  const sourceTaskId = "task_profile_graph_store_fact_redaction_created_at";
  const sourceFingerprint = "fingerprint_profile_graph_store_fact_redaction_created_at";
  const existingObservation = createGraphObservationEnvelope({
    observationId: "observation_profile_graph_store_fact_redaction_created_at",
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_seed",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_seed",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    observedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:12:00.000Z");
  const existingClaim = createGraphClaimEnvelope({
    claimId: "claim_profile_graph_store_fact_redaction_created_at",
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: "Avery",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_seed",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_seed",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,    validFrom: observedAt,
    validTo: null,
    endedAt: null,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    active: true,
    derivedFromObservationIds: [existingObservation.payload.observationId],
    projectionSourceIds: ["fact_profile_graph_store_fact_redaction_created_at"],
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:13:00.000Z");
  const redactedFact = {
    id: "fact_profile_graph_store_fact_redaction_created_at",
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: false,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_store_fact_redaction_seed",
    source: "user_input_pattern.name_preference",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };
  const seededState = {
    ...emptyState,
    graph: {
      ...emptyState.graph,
      updatedAt: recordedAt,
      observations: [existingObservation],
      claims: [existingClaim]
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [],
    touchedEpisodes: [],
    redactedFacts: [redactedFact],
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.observations.length, 1);
  assert.equal(result.nextState.graph.claims.length, 1);
  assert.equal(result.nextState.graph.observations[0]?.createdAt, existingObservation.createdAt);
  assert.equal(result.nextState.graph.claims[0]?.createdAt, existingClaim.createdAt);
  assert.equal(result.nextState.graph.observations[0]?.payload.normalizedValue, null);
  assert.equal(result.nextState.graph.observations[0]?.payload.redactionState, "redacted");
  assert.equal(result.nextState.graph.observations[0]?.payload.redactedAt, recordedAt);
  assert.equal(result.nextState.graph.observations[0]?.payload.sourceTaskId, sourceTaskId);
  assert.equal(result.nextState.graph.observations[0]?.payload.sourceFingerprint, sourceFingerprint);
  assert.equal(result.nextState.graph.claims[0]?.payload.normalizedValue, null);
  assert.equal(result.nextState.graph.claims[0]?.payload.redactionState, "redacted");
  assert.equal(result.nextState.graph.claims[0]?.payload.redactedAt, recordedAt);
  assert.equal(result.nextState.graph.claims[0]?.payload.sourceTaskId, sourceTaskId);
  assert.equal(result.nextState.graph.claims[0]?.payload.sourceFingerprint, sourceFingerprint);
  assert.equal(result.nextState.graph.claims[0]?.payload.active, false);
  assert.equal(result.nextState.graph.claims[0]?.payload.validTo, recordedAt);
  assert.equal(result.nextState.graph.claims[0]?.payload.endedAt, recordedAt);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 1);
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries[0]?.observationIds,
    [existingObservation.payload.observationId]
  );
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries[0]?.claimIds,
    [existingClaim.payload.claimId]
  );
});

test("applyProfileMemoryGraphMutations repairs already-redacted observation and claim metadata via retained claim lineage while preserving createdAt", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-07T15:20:00.000Z";
  const observedAt = "2026-04-07T14:45:00.000Z";
  const priorRedactedAt = "2026-04-07T15:00:00.000Z";
  const sourceTaskId = "task_profile_graph_store_fact_redaction_repeat";
  const sourceFingerprint = "fingerprint_profile_graph_store_fact_redaction_repeat";
  const redactedFactId = "fact_profile_graph_store_fact_redaction_repeat";
  const existingObservation = createGraphObservationEnvelope({
    observationId: "observation_profile_graph_store_fact_redaction_repeat",
    stableRefId: "stable_ref_profile_graph_store_fact_redaction_repeat_observation",
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: priorRedactedAt,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_old",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_old",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    observedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:12:00.000Z");
  const existingClaim = createGraphClaimEnvelope({
    claimId: "claim_profile_graph_store_fact_redaction_repeat",
    stableRefId: "stable_ref_profile_graph_store_fact_redaction_repeat_claim",
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: priorRedactedAt,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_old",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_old",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,    validFrom: observedAt,
    validTo: priorRedactedAt,
    endedAt: priorRedactedAt,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    active: true,
    derivedFromObservationIds: [existingObservation.payload.observationId],
    projectionSourceIds: [redactedFactId, "fact_profile_graph_store_fact_redaction_repeat_stray"],
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:13:00.000Z");
  const redactedFact = {
    id: redactedFactId,
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: false,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_store_fact_redaction_seed",
    source: "user_input_pattern.name_preference",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };
  const seededState = {
    ...emptyState,
    graph: {
      ...emptyState.graph,
      updatedAt: recordedAt,
      observations: [existingObservation],
      claims: [existingClaim]
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [],
    touchedEpisodes: [],
    redactedFacts: [redactedFact],
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.graph.observations[0]?.createdAt, existingObservation.createdAt);
  assert.equal(result.nextState.graph.claims[0]?.createdAt, existingClaim.createdAt);
  assert.equal(result.nextState.graph.observations[0]?.payload.stableRefId, null);
  assert.equal(result.nextState.graph.observations[0]?.payload.redactedAt, recordedAt);
  assert.equal(result.nextState.graph.observations[0]?.payload.sourceTaskId, sourceTaskId);
  assert.equal(result.nextState.graph.observations[0]?.payload.sourceFingerprint, sourceFingerprint);
  assert.equal(result.nextState.graph.observations[0]?.payload.sensitive, true);
  assert.deepEqual(result.nextState.graph.observations[0]?.payload.entityRefIds, []);
  assert.equal(result.nextState.graph.claims[0]?.payload.stableRefId, null);
  assert.equal(result.nextState.graph.claims[0]?.payload.redactedAt, recordedAt);
  assert.equal(result.nextState.graph.claims[0]?.payload.sourceTaskId, sourceTaskId);
  assert.equal(result.nextState.graph.claims[0]?.payload.sourceFingerprint, sourceFingerprint);
  assert.equal(result.nextState.graph.claims[0]?.payload.sensitive, true);
  assert.equal(result.nextState.graph.claims[0]?.payload.active, false);
  assert.equal(result.nextState.graph.claims[0]?.payload.validTo, priorRedactedAt);
  assert.equal(result.nextState.graph.claims[0]?.payload.endedAt, priorRedactedAt);
  assert.deepEqual(result.nextState.graph.claims[0]?.payload.projectionSourceIds, [redactedFactId]);
  assert.deepEqual(result.nextState.graph.claims[0]?.payload.entityRefIds, []);
  assert.equal(result.nextState.graph.mutationJournal.entries.length, 1);
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries[0]?.observationIds,
    [existingObservation.payload.observationId]
  );
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries[0]?.claimIds,
    [existingClaim.payload.claimId]
  );
});

test("applyProfileMemoryGraphMutations fail-closes stale unrelated retained claim lineage during repeat fact forget", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-07T15:40:00.000Z";
  const observedAt = "2026-04-07T14:45:00.000Z";
  const priorRedactedAt = "2026-04-07T15:00:00.000Z";
  const sourceTaskId = "task_profile_graph_store_fact_redaction_repeat_stale_lineage";
  const sourceFingerprint = "fingerprint_profile_graph_store_fact_redaction_repeat_stale_lineage";
  const redactedFactId = "fact_profile_graph_store_fact_redaction_repeat_stale_lineage";
  const targetedObservation = createGraphObservationEnvelope({
    observationId: "observation_profile_graph_store_fact_redaction_repeat_stale_lineage_target",
    stableRefId: "stable_ref_profile_graph_store_fact_redaction_repeat_stale_lineage_target",
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: priorRedactedAt,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_repeat_old",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_repeat_old",
    sourceTier: "explicit_user_statement",
    assertedAt: observedAt,
    observedAt,
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:12:00.000Z");
  const unrelatedObservation = createGraphObservationEnvelope({
    observationId: "observation_profile_graph_store_fact_redaction_repeat_stale_lineage_unrelated",
    stableRefId: "stable_ref_profile_graph_store_fact_redaction_repeat_stale_lineage_unrelated",
    family: "contact.context",
    normalizedKey: "contact.avery.context.1",
    normalizedValue: "Avery likes hiking",
    redactionState: "not_requested",
    redactedAt: null,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_repeat_stale_lineage_unrelated",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_repeat_stale_lineage_unrelated",
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-07T14:46:00.000Z",
    observedAt: "2026-04-07T14:46:00.000Z",
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: ["entity_avery"]
  }, "2026-04-07T14:14:00.000Z");
  const existingClaim = createGraphClaimEnvelope({
    claimId: "claim_profile_graph_store_fact_redaction_repeat_stale_lineage",
    stableRefId: "stable_ref_profile_graph_store_fact_redaction_repeat_stale_lineage_claim",
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: priorRedactedAt,
    sensitive: false,
    sourceTaskId: "task_profile_graph_store_fact_redaction_repeat_old",
    sourceFingerprint: "fingerprint_profile_graph_store_fact_redaction_repeat_old",
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
    sourceTaskId: "task_profile_graph_store_fact_redaction_repeat_seed",
    source: "user_input_pattern.name_preference",
    observedAt,
    confirmedAt: observedAt,
    supersededAt: null,
    lastUpdatedAt: observedAt
  };
  const seededState = {
    ...emptyState,
    graph: {
      ...emptyState.graph,
      updatedAt: recordedAt,
      observations: [targetedObservation, unrelatedObservation],
      claims: [existingClaim]
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [],
    touchedEpisodes: [],
    redactedFacts: [redactedFact],
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  const repairedTargetedObservation = result.nextState.graph.observations.find(
    (observation) => observation.payload.observationId === targetedObservation.payload.observationId
  );
  const survivingUnrelatedObservation = result.nextState.graph.observations.find(
    (observation) => observation.payload.observationId === unrelatedObservation.payload.observationId
  );

  assert.equal(result.changed, true);
  assert.deepEqual(
    result.nextState.graph.mutationJournal.entries[0]?.observationIds,
    [targetedObservation.payload.observationId]
  );
  assert.equal(repairedTargetedObservation?.payload.redactedAt, recordedAt);
  assert.equal(repairedTargetedObservation?.payload.sourceTaskId, sourceTaskId);
  assert.equal(survivingUnrelatedObservation?.payload.redactionState, "not_requested");
  assert.equal(survivingUnrelatedObservation?.payload.normalizedValue, "Avery likes hiking");
  assert.equal(
    survivingUnrelatedObservation?.payload.sourceTaskId,
    unrelatedObservation.payload.sourceTaskId
  );
  assert.deepEqual(result.nextState.graph.claims[0]?.payload.derivedFromObservationIds, [
    targetedObservation.payload.observationId
  ]);
});

test("applyProfileMemoryGraphMutations stays no-op when retained redacted observation and claim already match canonical repeat-forget state", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-07T15:40:00.000Z";
  const sourceTaskId = "task_profile_graph_store_fact_redaction_repeat_noop";
  const sourceFingerprint = "fingerprint_profile_graph_store_fact_redaction_repeat_noop";
  const redactedFactId = "fact_profile_graph_store_fact_redaction_repeat_noop";
  const existingObservation = createGraphObservationEnvelope({
    observationId: "observation_profile_graph_store_fact_redaction_repeat_noop",
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: recordedAt,
    sensitive: true,
    sourceTaskId,
    sourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-07T14:45:00.000Z",
    observedAt: "2026-04-07T14:45:00.000Z",
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: []
  }, "2026-04-07T14:12:00.000Z");
  const existingClaim = createGraphClaimEnvelope({
    claimId: "claim_profile_graph_store_fact_redaction_repeat_noop",
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: recordedAt,
    sensitive: true,
    sourceTaskId,
    sourceFingerprint,
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
    sourceTaskId: "task_profile_graph_store_fact_redaction_seed",
    source: "user_input_pattern.name_preference",
    observedAt: "2026-04-07T14:45:00.000Z",
    confirmedAt: "2026-04-07T14:45:00.000Z",
    supersededAt: null,
    lastUpdatedAt: "2026-04-07T14:45:00.000Z"
  };
  const seededState = {
    ...emptyState,
    graph: {
      ...emptyState.graph,
      updatedAt: recordedAt,
      observations: [existingObservation],
      claims: [existingClaim]
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [],
    touchedEpisodes: [],
    redactedFacts: [redactedFact],
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, false);
  assert.equal(result.nextState, seededState);
});

test("applyProfileMemoryGraphMutations clamps stale snapshot watermark without restamping lastCompactedAt when explicit fact-forget stays no-op under cap", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T19:05:00.000Z";
  const retainedLastCompactedAt = "2026-04-08T18:30:00.000Z";
  const sourceTaskId = "task_profile_graph_store_fact_redaction_repeat_noop_clamp";
  const sourceFingerprint = "fingerprint_profile_graph_store_fact_redaction_repeat_noop_clamp";
  const redactedFactId = "fact_profile_graph_store_fact_redaction_repeat_noop_clamp";
  const observationId = "observation_profile_graph_store_fact_redaction_repeat_noop_clamp";
  const claimId = "claim_profile_graph_store_fact_redaction_repeat_noop_clamp";
  const existingObservation = createGraphObservationEnvelope({
    observationId,
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: recordedAt,
    sensitive: true,
    sourceTaskId,
    sourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-08T18:10:00.000Z",
    observedAt: "2026-04-08T18:10:00.000Z",
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: []
  }, "2026-04-08T18:11:00.000Z");
  const existingClaim = createGraphClaimEnvelope({
    claimId,
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: recordedAt,
    sensitive: true,
    sourceTaskId,
    sourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-08T18:10:00.000Z",    validFrom: "2026-04-08T18:10:00.000Z",
    validTo: recordedAt,
    endedAt: recordedAt,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    active: false,
    derivedFromObservationIds: [observationId],
    projectionSourceIds: [redactedFactId],
    entityRefIds: []
  }, "2026-04-08T18:12:00.000Z");
  const redactedFact = {
    id: redactedFactId,
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: false,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_store_fact_redaction_repeat_noop_clamp_seed",
    source: "user_input_pattern.name_preference",
    observedAt: "2026-04-08T18:10:00.000Z",
    confirmedAt: "2026-04-08T18:10:00.000Z",
    supersededAt: null,
    lastUpdatedAt: "2026-04-08T18:10:00.000Z"
  };
  const retainedForgetPayload = {
    recordedAt,
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [observationId],
    claimIds: [claimId],
    eventIds: [],
    redactionState: "redacted" as const
  };
  const retainedForgetEntry = {
    journalEntryId: `journal_${sha256HexFromCanonicalJson(retainedForgetPayload).slice(0, 24)}`,
    watermark: 4,
    ...retainedForgetPayload
  };
  const seededState = {
    ...emptyState,
    graph: {
      ...emptyState.graph,
      updatedAt: "2026-04-08T18:40:00.000Z",
      observations: [existingObservation],
      claims: [existingClaim],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 5,
        entries: [retainedForgetEntry]
      },
      compaction: {
        ...emptyState.graph.compaction,
        snapshotWatermark: 99,
        lastCompactedAt: retainedLastCompactedAt,
        maxJournalEntries: 4
      }
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [],
    touchedEpisodes: [],
    redactedFacts: [redactedFact],
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.updatedAt, recordedAt);
  assert.equal(result.nextState.graph.observations.length, 1);
  assert.equal(result.nextState.graph.claims.length, 1);
  assert.equal(result.nextState.graph.observations[0]?.createdAt, existingObservation.createdAt);
  assert.equal(result.nextState.graph.claims[0]?.createdAt, existingClaim.createdAt);
  assert.equal(result.nextState.graph.observations[0]?.payload.redactionState, "redacted");
  assert.equal(result.nextState.graph.observations[0]?.payload.redactedAt, recordedAt);
  assert.equal(result.nextState.graph.claims[0]?.payload.redactionState, "redacted");
  assert.equal(result.nextState.graph.claims[0]?.payload.redactedAt, recordedAt);
  assert.equal(result.nextState.graph.claims[0]?.payload.active, false);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries, [retainedForgetEntry]);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 5);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 3);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, retainedLastCompactedAt);
  assert.equal(result.nextState.graph.readModel.watermark, 4);
});

test("applyProfileMemoryGraphMutations clamps stale snapshot watermark from nextWatermark when explicit fact-forget stays no-op with no retained journal entries", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T19:20:00.000Z";
  const retainedLastCompactedAt = "2026-04-08T18:45:00.000Z";
  const sourceTaskId = "task_profile_graph_store_fact_redaction_repeat_noop_empty_clamp";
  const sourceFingerprint = "fingerprint_profile_graph_store_fact_redaction_repeat_noop_empty_clamp";
  const redactedFactId = "fact_profile_graph_store_fact_redaction_repeat_noop_empty_clamp";
  const observationId = "observation_profile_graph_store_fact_redaction_repeat_noop_empty_clamp";
  const claimId = "claim_profile_graph_store_fact_redaction_repeat_noop_empty_clamp";
  const retainedObservationCreatedAt = "2026-04-08T18:21:00.000Z";
  const retainedClaimCreatedAt = "2026-04-08T18:22:00.000Z";
  const existingObservation = createGraphObservationEnvelope({
    observationId,
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: recordedAt,
    sensitive: true,
    sourceTaskId,
    sourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-08T18:20:00.000Z",
    observedAt: "2026-04-08T18:20:00.000Z",
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: []
  }, retainedObservationCreatedAt);
  const existingClaim = createGraphClaimEnvelope({
    claimId,
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: recordedAt,
    sensitive: true,
    sourceTaskId,
    sourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-08T18:20:00.000Z",    validFrom: "2026-04-08T18:20:00.000Z",
    validTo: recordedAt,
    endedAt: recordedAt,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    active: false,
    derivedFromObservationIds: [observationId],
    projectionSourceIds: [redactedFactId],
    entityRefIds: []
  }, retainedClaimCreatedAt);
  const redactedFact = {
    id: redactedFactId,
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: false,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_store_fact_redaction_repeat_noop_empty_clamp_seed",
    source: "user_input_pattern.name_preference",
    observedAt: "2026-04-08T18:20:00.000Z",
    confirmedAt: "2026-04-08T18:20:00.000Z",
    supersededAt: null,
    lastUpdatedAt: "2026-04-08T18:20:00.000Z"
  };
  const seededState = {
    ...emptyState,
    graph: {
      ...emptyState.graph,
      updatedAt: "2026-04-08T18:55:00.000Z",
      observations: [existingObservation],
      claims: [existingClaim],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 6,
        entries: []
      },
      compaction: {
        ...emptyState.graph.compaction,
        snapshotWatermark: 99,
        lastCompactedAt: retainedLastCompactedAt,
        maxJournalEntries: 4
      }
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [],
    touchedEpisodes: [],
    redactedFacts: [redactedFact],
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, true);
  assert.equal(result.nextState.updatedAt, recordedAt);
  assert.equal(result.nextState.graph.observations.length, 1);
  assert.equal(result.nextState.graph.claims.length, 1);
  assert.equal(result.nextState.graph.observations[0]?.createdAt, retainedObservationCreatedAt);
  assert.equal(result.nextState.graph.claims[0]?.createdAt, retainedClaimCreatedAt);
  assert.equal(result.nextState.graph.observations[0]?.payload.redactionState, "redacted");
  assert.equal(result.nextState.graph.observations[0]?.payload.redactedAt, recordedAt);
  assert.equal(result.nextState.graph.claims[0]?.payload.redactionState, "redacted");
  assert.equal(result.nextState.graph.claims[0]?.payload.redactedAt, recordedAt);
  assert.equal(result.nextState.graph.claims[0]?.payload.active, false);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries, []);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 6);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 5);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, retainedLastCompactedAt);
  assert.equal(result.nextState.graph.readModel.watermark, 5);
});

test("applyProfileMemoryGraphMutations stays a true no-op when explicit fact-forget replay rows and compaction are already replay-safe", () => {
  const emptyState = createEmptyProfileMemoryState();
  const recordedAt = "2026-04-08T19:35:00.000Z";
  const retainedLastCompactedAt = "2026-04-08T19:00:00.000Z";
  const sourceTaskId = "task_profile_graph_store_fact_redaction_repeat_noop_replay_safe";
  const sourceFingerprint = "fingerprint_profile_graph_store_fact_redaction_repeat_noop_replay_safe";
  const redactedFactId = "fact_profile_graph_store_fact_redaction_repeat_noop_replay_safe";
  const observationId = "observation_profile_graph_store_fact_redaction_repeat_noop_replay_safe";
  const claimId = "claim_profile_graph_store_fact_redaction_repeat_noop_replay_safe";
  const retainedObservationCreatedAt = "2026-04-08T19:01:00.000Z";
  const retainedClaimCreatedAt = "2026-04-08T19:02:00.000Z";
  const existingObservation = createGraphObservationEnvelope({
    observationId,
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: recordedAt,
    sensitive: true,
    sourceTaskId,
    sourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-08T18:55:00.000Z",
    observedAt: "2026-04-08T18:55:00.000Z",
    timePrecision: "instant",
    timeSource: "user_stated",
    entityRefIds: []
  }, retainedObservationCreatedAt);
  const existingClaim = createGraphClaimEnvelope({
    claimId,
    stableRefId: null,
    family: "identity.preferred_name",
    normalizedKey: "identity.preferred_name",
    normalizedValue: null,
    redactionState: "redacted",
    redactedAt: recordedAt,
    sensitive: true,
    sourceTaskId,
    sourceFingerprint,
    sourceTier: "explicit_user_statement",
    assertedAt: "2026-04-08T18:55:00.000Z",    validFrom: "2026-04-08T18:55:00.000Z",
    validTo: recordedAt,
    endedAt: recordedAt,
    endedByClaimId: null,
    timePrecision: "instant",
    timeSource: "user_stated",
    active: false,
    derivedFromObservationIds: [observationId],
    projectionSourceIds: [redactedFactId],
    entityRefIds: []
  }, retainedClaimCreatedAt);
  const redactedFact = {
    id: redactedFactId,
    key: "identity.preferred_name",
    value: "Avery",
    sensitive: false,
    status: "confirmed" as const,
    confidence: 0.95,
    sourceTaskId: "task_profile_graph_store_fact_redaction_repeat_noop_replay_safe_seed",
    source: "user_input_pattern.name_preference",
    observedAt: "2026-04-08T18:55:00.000Z",
    confirmedAt: "2026-04-08T18:55:00.000Z",
    supersededAt: null,
    lastUpdatedAt: "2026-04-08T18:55:00.000Z"
  };
  const retainedForgetPayload = {
    recordedAt,
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    observationIds: [observationId],
    claimIds: [claimId],
    eventIds: [],
    redactionState: "redacted" as const
  };
  const retainedForgetEntry = {
    journalEntryId: `journal_${sha256HexFromCanonicalJson(retainedForgetPayload).slice(0, 24)}`,
    watermark: 4,
    ...retainedForgetPayload
  };
  const seededState = {
    ...emptyState,
    graph: {
      ...emptyState.graph,
      updatedAt: "2026-04-08T19:10:00.000Z",
      observations: [existingObservation],
      claims: [existingClaim],
      mutationJournal: {
        schemaVersion: "v1" as const,
        nextWatermark: 5,
        entries: [retainedForgetEntry]
      },
      compaction: {
        ...emptyState.graph.compaction,
        snapshotWatermark: 3,
        lastCompactedAt: retainedLastCompactedAt,
        maxJournalEntries: 4
      },
      readModel: {
        ...emptyState.graph.readModel,
        watermark: 4
      }
    }
  };

  const result = applyProfileMemoryGraphMutations({
    state: asProfileMemoryState(seededState),
    factDecisions: [],
    touchedEpisodes: [],
    redactedFacts: [redactedFact],
    sourceTaskId,
    sourceFingerprint,
    mutationEnvelopeHash: null,
    recordedAt
  });

  assert.equal(result.changed, false);
  assert.equal(result.nextState, seededState);
  assert.deepEqual(result.nextState.graph.mutationJournal.entries, [retainedForgetEntry]);
  assert.equal(result.nextState.graph.mutationJournal.nextWatermark, 5);
  assert.equal(result.nextState.graph.compaction.snapshotWatermark, 3);
  assert.equal(result.nextState.graph.compaction.lastCompactedAt, retainedLastCompactedAt);
  assert.equal(result.nextState.graph.readModel.watermark, 4);
});

test("profile memory load preserves deleted fact projection lineage on redacted claims after projection-source pruning", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const redactedFactId = "fact_profile_graph_store_redacted_claim_projection_lineage";
    const survivingFactId = "fact_profile_graph_store_redacted_claim_projection_lineage_surviving";
    const existingObservation = createGraphObservationEnvelope({
      observationId: "observation_profile_graph_store_redacted_claim_projection_lineage",
      stableRefId: null,
      family: "identity.preferred_name",
      normalizedKey: "identity.preferred_name",
      normalizedValue: null,
      redactionState: "redacted",
      redactedAt: "2026-04-07T15:00:00.000Z",
      sensitive: true,
      sourceTaskId: "task_profile_graph_store_redacted_claim_projection_lineage",
      sourceFingerprint: "fingerprint_profile_graph_store_redacted_claim_projection_lineage",
      sourceTier: "explicit_user_statement",
      assertedAt: "2026-04-07T14:45:00.000Z",
      observedAt: "2026-04-07T14:45:00.000Z",
      timePrecision: "instant",
      timeSource: "user_stated",
      entityRefIds: []
    });
    const unrelatedLiveObservation = createGraphObservationEnvelope({
      observationId: "observation_profile_graph_store_redacted_claim_projection_lineage_live_unrelated",
      stableRefId: null,
      family: "contact.context",
      normalizedKey: "contact.avery.context.1",
      normalizedValue: "Avery likes hiking",
      redactionState: "not_requested",
      redactedAt: null,
      sensitive: false,
      sourceTaskId: "task_profile_graph_store_redacted_claim_projection_lineage_live_unrelated",
      sourceFingerprint:
        "fingerprint_profile_graph_store_redacted_claim_projection_lineage_live_unrelated",
      sourceTier: "explicit_user_statement",
      assertedAt: "2026-04-07T14:46:00.000Z",
      observedAt: "2026-04-07T14:46:00.000Z",
      timePrecision: "instant",
      timeSource: "user_stated",
      entityRefIds: []
    });
    const existingClaim = createGraphClaimEnvelope({
      claimId: "claim_profile_graph_store_redacted_claim_projection_lineage",
      stableRefId: null,
      family: "identity.preferred_name",
      normalizedKey: "identity.preferred_name",
      normalizedValue: null,
      redactionState: "redacted",
      redactedAt: "2026-04-07T15:20:00.000Z",
      sensitive: true,
      sourceTaskId: "task_profile_graph_store_redacted_claim_projection_lineage",
      sourceFingerprint: "fingerprint_profile_graph_store_redacted_claim_projection_lineage",
      sourceTier: "explicit_user_statement",
      assertedAt: "2026-04-07T14:45:00.000Z",      validFrom: "2026-04-07T14:45:00.000Z",
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
    const seededState = {
      ...emptyState,
      facts: [
        {
          id: survivingFactId,
          key: "identity.preferred_name",
          value: "Avery",
          sensitive: false,
          status: "confirmed" as const,
          confidence: 0.95,
          sourceTaskId: "task_profile_graph_store_redacted_claim_projection_lineage_surviving",
          source: "user_input_pattern.name_phrase",
          observedAt: "2026-04-07T14:45:00.000Z",
          confirmedAt: "2026-04-07T14:45:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-07T14:45:00.000Z"
        }
      ],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-07T15:30:00.000Z",
        observations: [existingObservation, unrelatedLiveObservation],
        claims: [existingClaim]
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    const redactedClaim = loaded.graph.claims.find(
      (claim) => claim.payload.claimId === existingClaim.payload.claimId
    );
    assert.ok(redactedClaim);
    assert.deepEqual(redactedClaim.payload.derivedFromObservationIds, [
      existingObservation.payload.observationId
    ]);
    assert.deepEqual(redactedClaim.payload.projectionSourceIds, [redactedFactId]);
  });
});

test("profile memory load preserves deleted episode projection lineage on redacted events after projection-source pruning", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const redactedEpisodeId = "episode_profile_graph_store_redacted_event_projection_lineage";
    const survivingEpisodeId = "episode_profile_graph_store_redacted_event_projection_lineage_surviving";
    const unrelatedDeletedEpisodeId =
      "episode_profile_graph_store_redacted_event_projection_lineage_other";
    const existingEvent = createGraphEventEnvelope({
      eventId: `event_${sha256HexFromCanonicalJson({ episodeId: redactedEpisodeId }).slice(0, 24)}`,
      stableRefId: null,
      family: "episode.candidate",
      title: "[redacted episode]",
      summary: "[redacted episode details]",
      redactionState: "redacted",
      redactedAt: "2026-04-07T15:20:00.000Z",
      sensitive: true,
      sourceTaskId: "memory_forget_profile_graph_store_redacted_event_projection_lineage",
      sourceFingerprint: "fingerprint_profile_graph_store_redacted_event_projection_lineage",
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
    const seededState = {
      ...emptyState,
      episodes: [
        {
          id: survivingEpisodeId,
          title: "Owen follow-up still active",
          summary: "Owen still needs a follow-up.",
          status: "unresolved" as const,
          sourceTaskId: "task_profile_graph_store_redacted_event_projection_lineage_surviving",
          source: "user_input_pattern.episode_candidate",
          sourceKind: "explicit_user_statement" as const,
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
        ...emptyState.graph,
        updatedAt: "2026-04-07T15:30:00.000Z",
        events: [existingEvent]
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    const redactedEvent = loaded.graph.events.find(
      (event) => event.payload.eventId === existingEvent.payload.eventId
    );
    assert.ok(redactedEvent);
    assert.deepEqual(redactedEvent.payload.projectionSourceIds, [redactedEpisodeId]);
  });
});

test("profile memory load repairs retained resolved events whose same-id payload no longer matches the surviving episode", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const canonicalEpisodeId = "episode_profile_graph_store_event_resolved_payload_repair";
    const expectedEventId =
      `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
    const retainedCreatedAt = "2026-04-07T14:14:00.000Z";
    const seededEpisode = {
      ...createProfileEpisodeRecord({
        title: "Owen tax follow-up resolved",
        summary: "Owen sent the tax form.",
        sourceTaskId: "task_profile_graph_store_event_resolved_payload_repair",
        source: "user_input_pattern.episode_candidate",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt: "2026-04-07T14:50:00.000Z",
        confidence: 0.91,
        status: "resolved",
        lastMentionedAt: "2026-04-07T15:05:00.000Z",
        lastUpdatedAt: "2026-04-07T15:05:00.000Z",
        resolvedAt: "2026-04-07T15:05:00.000Z",
        entityRefs: ["entity_owen", "entity_tax_form"],
        openLoopRefs: ["open_loop_owen_tax"],
        tags: ["followup"]
      }),
      id: canonicalEpisodeId
    };
    const seededState = {
      ...emptyState,
      episodes: [seededEpisode],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-07T15:30:00.000Z",
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
            sourceTaskId: "task_profile_graph_store_event_resolved_payload_repair_stale",
            sourceFingerprint: "fingerprint_profile_graph_store_event_resolved_payload_repair_stale",
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
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.events.length, 1);
    assert.equal(loaded.graph.events[0]?.payload.eventId, expectedEventId);
    assert.equal(loaded.graph.events[0]?.createdAt, retainedCreatedAt);
    assert.equal(loaded.graph.events[0]?.payload.title, "Owen tax follow-up resolved");
    assert.equal(loaded.graph.events[0]?.payload.summary, "Owen sent the tax form.");
    assert.equal(loaded.graph.events[0]?.payload.sensitive, false);
    assert.equal(
      loaded.graph.events[0]?.payload.sourceTaskId,
      "task_profile_graph_store_event_resolved_payload_repair"
    );
    assert.equal(loaded.graph.events[0]?.payload.observedAt, "2026-04-07T14:50:00.000Z");
    assert.equal(loaded.graph.events[0]?.payload.validTo, "2026-04-07T15:05:00.000Z");
    assert.equal(loaded.graph.events[0]?.payload.timeSource, "user_stated");
    assert.deepEqual(
      loaded.graph.events[0]?.payload.projectionSourceIds,
      [canonicalEpisodeId]
    );
    assert.deepEqual(
      loaded.graph.events[0]?.payload.entityRefIds,
      ["entity_owen", "entity_tax_form"]
    );
    assert.equal(
      loaded.graph.events[0]?.payload.sourceFingerprint?.startsWith("graph_event_backfill_"),
      true
    );
    assert.equal(loaded.graph.mutationJournal.entries.length, 0);
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 1);
    assert.equal(loaded.graph.readModel.watermark, 0);
  });
});

test("profile memory load adds replay markers for active legacy graph events with empty journal coverage", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:00.000Z",
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_replay_backfill_1",
            stableRefId: null,
            family: "episode.candidate",
            title: "Owen tax follow-up",
            summary: "Owen still needs to send the tax form.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_replay_backfill_1",
            sourceFingerprint: "fingerprint_profile_graph_store_replay_backfill_1",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:12:00.000Z",
            observedAt: "2026-04-03T21:12:00.000Z",
            validFrom: "2026-04-03T21:12:00.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["episode_profile_graph_store_replay_backfill_1"],
            entityRefIds: ["entity_owen"]
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.events.length, 1);
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.eventIds,
      ["event_profile_graph_store_replay_backfill_1"]
    );
    assert.equal(loaded.graph.mutationJournal.entries[0]?.sourceTaskId, null);
    assert.equal(
      loaded.graph.mutationJournal.entries[0]?.sourceFingerprint?.startsWith(
        "graph_event_replay_backfill_"
      ),
      true
    );
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 2);
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("profile memory load adds replay markers for active legacy graph claims with empty journal coverage", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:19:00.000Z",
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_replay_backfill_1",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_claim_replay_backfill_1",
            sourceFingerprint: "fingerprint_profile_graph_store_claim_replay_backfill_1",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:13:00.000Z",
            validFrom: "2026-04-03T21:13:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_replay_backfill_1"],
            entityRefIds: [],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.observations.length, 1);
    assert.equal(loaded.graph.claims.length, 1);
    assert.deepEqual(
      loaded.graph.claims[0]?.payload.derivedFromObservationIds,
      [loaded.graph.observations[0]!.payload.observationId]
    );
    assert.equal(loaded.graph.mutationJournal.entries.length, 2);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.observationIds,
      [loaded.graph.observations[0]!.payload.observationId]
    );
    assert.equal(
      loaded.graph.mutationJournal.entries[0]?.sourceFingerprint?.startsWith(
        "graph_observation_replay_backfill_"
      ),
      true
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[1]?.claimIds,
      ["claim_profile_graph_store_replay_backfill_1"]
    );
    assert.equal(loaded.graph.mutationJournal.entries[1]?.sourceTaskId, null);
    assert.equal(
      loaded.graph.mutationJournal.entries[1]?.sourceFingerprint?.startsWith(
        "graph_claim_replay_backfill_"
      ),
      true
    );
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
      "claim_profile_graph_store_replay_backfill_1"
    );
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 3);
    assert.equal(loaded.graph.readModel.watermark, 2);
  });
});

test("profile memory load adds replay markers for legacy graph observations with empty journal coverage", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_replay_backfill_1",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.1",
            normalizedValue: "Owen fell down",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_observation_replay_backfill_1",
            sourceFingerprint: "fingerprint_profile_graph_store_observation_replay_backfill_1",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:04:00.000Z",
            observedAt: "2026-04-03T21:04:00.000Z",
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
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.observations.length, 1);
    assert.equal(loaded.graph.claims.length, 0);
    assert.equal(loaded.graph.events.length, 0);
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.observationIds,
      ["observation_profile_graph_store_replay_backfill_1"]
    );
    assert.equal(
      loaded.graph.mutationJournal.entries[0]?.sourceFingerprint?.startsWith(
        "graph_observation_replay_backfill_"
      ),
      true
    );
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 2);
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("profile memory load clamps malformed retained snapshot watermarks before observation replay repair", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:05.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_replay_backfill_snapshot_clamp_1",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.snapshot",
            normalizedValue: "Owen slipped on the ice",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_replay_backfill_snapshot_clamp_1",
            sourceFingerprint: "fingerprint_profile_graph_store_replay_backfill_snapshot_clamp_1",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:04:05.000Z",
            observedAt: "2026-04-03T21:04:05.000Z",
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
          lastCompactedAt: "2026-04-03T21:10:00.000Z",
          maxObservationCount: 2048,
          maxClaimCount: 2048,
          maxEventCount: 1024,
          maxJournalEntries: 4096
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.compaction.snapshotWatermark, 0);
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.observationIds,
      ["observation_profile_graph_store_replay_backfill_snapshot_clamp_1"]
    );
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 2);
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("profile memory load clamps malformed retained nextWatermark before observation replay repair", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:06.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_replay_backfill_next_watermark_clamp_1",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.next_watermark",
            normalizedValue: "Owen still needs a winter coat",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_replay_backfill_next_watermark_clamp_1",
            sourceFingerprint: "fingerprint_profile_graph_store_replay_backfill_next_watermark_clamp_1",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:04:06.000Z",
            observedAt: "2026-04-03T21:04:06.000Z",
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
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.compaction.snapshotWatermark, 0);
    assert.equal(loaded.graph.mutationJournal.entries.length, 1);
    assert.equal(loaded.graph.mutationJournal.entries[0]?.watermark, 1);
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 2);
    assert.equal(loaded.graph.readModel.watermark, 1);
  });
});

test("profile memory load repairs missing replay coverage for uncompacted partial journal state", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:30.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_partial_replay_existing",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.existing",
            normalizedValue: "Owen already mentioned this before",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_partial_replay_existing",
            sourceFingerprint: "fingerprint_profile_graph_store_partial_replay_existing",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:03:30.000Z",
            observedAt: "2026-04-03T21:03:30.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: ["entity_owen"]
          }),
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_partial_replay_1",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.1",
            normalizedValue: "Owen still needs help",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_partial_replay_1",
            sourceFingerprint: "fingerprint_profile_graph_store_partial_replay_1",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:04:30.000Z",
            observedAt: "2026-04-03T21:04:30.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: ["entity_owen"]
          })
        ],
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_partial_replay_1",
            stableRefId: null,
            family: "contact.relationship",
            normalizedKey: "contact.owen.relationship",
            normalizedValue: "friend",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_partial_replay_1",
            sourceFingerprint: "fingerprint_profile_graph_store_partial_replay_1",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:05:30.000Z",
            validFrom: "2026-04-03T21:05:30.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_store_partial_replay_1"],
            projectionSourceIds: ["fact_profile_graph_store_partial_replay_1"],
            entityRefIds: ["entity_owen"],
            active: true
          })
        ],
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_partial_replay_1",
            stableRefId: null,
            family: "episode.candidate",
            title: "Owen follow-up",
            summary: "Owen still needs help.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_partial_replay_1",
            sourceFingerprint: "fingerprint_profile_graph_store_partial_replay_1",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:06:30.000Z",
            observedAt: "2026-04-03T21:06:30.000Z",
            validFrom: "2026-04-03T21:06:30.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["episode_profile_graph_store_partial_replay_1"],
            entityRefIds: ["entity_owen"]
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 2,
          entries: [
            {
              journalEntryId: "journal_profile_graph_store_partial_replay_existing",
              watermark: 1,
              recordedAt: "2026-04-03T21:03:30.000Z",
              sourceTaskId: "task_profile_graph_store_partial_replay_existing",
              sourceFingerprint: "fingerprint_profile_graph_store_partial_replay_existing",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_partial_replay_existing"],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        },
        compaction: {
          ...emptyState.graph.compaction,
          snapshotWatermark: 0
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.mutationJournal.entries.length, 4);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [1, 2, 3, 4]
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[1]?.eventIds,
      ["event_profile_graph_store_partial_replay_1"]
    );
    assert.equal(
      loaded.graph.mutationJournal.entries[1]?.sourceFingerprint?.startsWith(
        "graph_event_replay_backfill_"
      ),
      true
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[2]?.observationIds,
      ["observation_profile_graph_store_partial_replay_1"]
    );
    assert.equal(
      loaded.graph.mutationJournal.entries[2]?.sourceFingerprint?.startsWith(
        "graph_observation_replay_backfill_"
      ),
      true
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[3]?.claimIds,
      ["claim_profile_graph_store_partial_replay_1"]
    );
    assert.equal(
      loaded.graph.mutationJournal.entries[3]?.sourceFingerprint?.startsWith(
        "graph_claim_replay_backfill_"
      ),
      true
    );
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["contact.owen.relationship"],
      "claim_profile_graph_store_partial_replay_1"
    );
    assert.equal(loaded.graph.readModel.watermark, 4);
  });
});

test("profile memory load repairs detached claim lineage inside a partially populated observation lane", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:45.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_claim_lineage_unrelated",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.1",
            normalizedValue: "Owen still needs help",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_claim_lineage_unrelated",
            sourceFingerprint: "fingerprint_profile_graph_store_claim_lineage_unrelated",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:01:45.000Z",
            observedAt: "2026-04-03T21:01:45.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: ["entity_owen"]
          })
        ],
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_claim_lineage_detached",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_claim_lineage_detached",
            sourceFingerprint: "fingerprint_profile_graph_store_claim_lineage_detached",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:04:45.000Z",
            validFrom: "2026-04-03T21:04:45.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_claim_lineage_detached"],
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
        compaction: {
          ...emptyState.graph.compaction,
          snapshotWatermark: 0
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const synthesizedObservation = loaded.graph.observations.find(
      (observation) =>
        observation.payload.observationId !==
        "observation_profile_graph_store_claim_lineage_unrelated"
    );

    assert.equal(loaded.graph.observations.length, 2);
    assert.ok(synthesizedObservation);
    const synthesizedObservationId = synthesizedObservation.payload.observationId;
    assert.deepEqual(
      loaded.graph.claims[0]?.payload.derivedFromObservationIds,
      [synthesizedObservationId]
    );
    assert.equal(loaded.graph.mutationJournal.entries.length, 2);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.observationIds,
      [
        "observation_profile_graph_store_claim_lineage_unrelated",
        synthesizedObservationId
      ].sort((left, right) => left.localeCompare(right))
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[1]?.claimIds,
      ["claim_profile_graph_store_claim_lineage_detached"]
    );
  });
});

test("profile memory load repairs stale claim lineage ids by reusing matching surviving observations", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:46.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_claim_lineage_stale_existing",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_claim_lineage_stale_existing",
            sourceFingerprint: "fingerprint_profile_graph_store_claim_lineage_stale_existing",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:04:46.000Z",
            observedAt: "2026-04-03T21:04:46.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          }),
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_claim_lineage_stale_unrelated",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.1",
            normalizedValue: "Owen still needs help",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_claim_lineage_stale_unrelated",
            sourceFingerprint: "fingerprint_profile_graph_store_claim_lineage_stale_unrelated",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:01:46.000Z",
            observedAt: "2026-04-03T21:01:46.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: ["entity_owen"]
          })
        ],
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_claim_lineage_stale_existing",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_claim_lineage_stale_existing",
            sourceFingerprint: "fingerprint_profile_graph_store_claim_lineage_stale_existing",
            sourceTier: "explicit_user_statement",
            assertedAt: " 2026-04-03T21:04:46.000Z ",
            validFrom: " 2026-04-03T21:04:46.000Z ",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_store_claim_lineage_stale_missing"],
            projectionSourceIds: ["fact_profile_graph_store_claim_lineage_stale_existing"],
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
        compaction: {
          ...emptyState.graph.compaction,
          snapshotWatermark: 0
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.observations.length, 2);
    assert.deepEqual(
      loaded.graph.claims[0]?.payload.derivedFromObservationIds,
      ["observation_profile_graph_store_claim_lineage_stale_existing"]
    );
    assert.equal(loaded.graph.mutationJournal.entries.length, 2);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.observationIds,
      [
        "observation_profile_graph_store_claim_lineage_stale_existing",
        "observation_profile_graph_store_claim_lineage_stale_unrelated"
      ]
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[1]?.claimIds,
      ["claim_profile_graph_store_claim_lineage_stale_existing"]
    );
  });
});

test("profile memory load repairs surviving but semantically mismatched claim lineage observations", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const expectedObservationId =
      `observation_${sha256HexFromCanonicalJson({
        claimId: "claim_profile_graph_store_claim_lineage_mismatch_existing",
        family: "identity.preferred_name",
        normalizedKey: "identity.preferred_name",
        normalizedValue: "Avery",
        sourceFingerprint: "fingerprint_profile_graph_store_claim_lineage_mismatch_existing",
        assertedAt: "2026-04-03T21:04:47.000Z"
      }).slice(0, 24)}`;
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:47.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_claim_lineage_mismatch_wrong",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Ava",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_claim_lineage_mismatch_wrong",
            sourceFingerprint: "fingerprint_profile_graph_store_claim_lineage_mismatch_wrong",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:04:47.000Z",
            observedAt: "2026-04-03T21:04:47.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          })
        ],
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_claim_lineage_mismatch_existing",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_claim_lineage_mismatch_existing",
            sourceFingerprint: "fingerprint_profile_graph_store_claim_lineage_mismatch_existing",
            sourceTier: "explicit_user_statement",
            assertedAt: " 2026-04-03T21:04:47.000Z ",
            validFrom: " 2026-04-03T21:04:47.000Z ",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_store_claim_lineage_mismatch_wrong"],
            projectionSourceIds: ["fact_profile_graph_store_claim_lineage_mismatch_existing"],
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
        compaction: {
          ...emptyState.graph.compaction,
          snapshotWatermark: 0
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.observations.length, 2);
    assert.equal(
      loaded.graph.observations.some(
        (observation) => observation.payload.observationId === expectedObservationId
      ),
      true
    );
    assert.deepEqual(
      loaded.graph.claims[0]?.payload.derivedFromObservationIds,
      [expectedObservationId]
    );
    assert.equal(loaded.graph.mutationJournal.entries.length, 2);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.observationIds,
      [
        "observation_profile_graph_store_claim_lineage_mismatch_wrong",
        expectedObservationId
      ].sort((left, right) => left.localeCompare(right))
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[1]?.claimIds,
      ["claim_profile_graph_store_claim_lineage_mismatch_existing"]
    );
  });
});

test("profile memory load backfills graph observations and current claims from legacy active facts", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      facts: [
        {
          id: " fact_profile_graph_store_legacy_backfill_1 ",
          key: "employment.current",
          value: "Lantern",
          sensitive: false,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_graph_store_legacy_backfill_1",
          source: "user_input_pattern.work_at",
          observedAt: "2026-04-03T21:05:00.000Z",
          confirmedAt: "2026-04-03T21:05:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-03T21:05:00.000Z"
        },
        {
          id: "fact_profile_graph_store_legacy_backfill_2",
          key: "employment.current",
          value: "Northstar",
          sensitive: false,
          status: "uncertain",
          confidence: 0.6,
          sourceTaskId: "task_profile_graph_store_legacy_backfill_2",
          source: "user_input_pattern.job_is",
          observedAt: "2026-04-03T21:06:00.000Z",
          confirmedAt: null,
          supersededAt: null,
          lastUpdatedAt: "2026-04-03T21:06:00.000Z"
        }
      ],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:30.000Z",
        observations: [],
        claims: [],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.observations.length, 2);
    assert.equal(loaded.graph.claims.length, 1);
    assert.equal(loaded.graph.claims[0]?.payload.normalizedValue, "Lantern");
    assert.deepEqual(
      loaded.graph.claims[0]?.payload.projectionSourceIds,
      ["fact_profile_graph_store_legacy_backfill_1"]
    );
    assert.equal(loaded.graph.mutationJournal.entries.length, 2);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.observationIds,
      loaded.graph.observations
        .map((observation) => observation.payload.observationId)
        .sort((left, right) => left.localeCompare(right))
    );
    assert.equal(
      loaded.graph.mutationJournal.entries[0]?.sourceFingerprint?.startsWith(
        "graph_observation_replay_backfill_"
      ),
      true
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[1]?.claimIds,
      [loaded.graph.claims[0]!.payload.claimId]
    );
    assert.equal(
      loaded.graph.mutationJournal.entries[1]?.sourceFingerprint?.startsWith(
        "graph_claim_replay_backfill_"
      ),
      true
    );
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["employment.current"],
      loaded.graph.claims[0]!.payload.claimId
    );
    assert.equal(loaded.graph.readModel.watermark, 2);
  });
});

test("profile memory load reuses existing graph observations when retained fact sourceTaskIds are padded", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      facts: [
        {
          id: "fact_profile_graph_store_legacy_source_task_padding_1",
          key: "employment.current",
          value: "Lantern",
          sensitive: false,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: " task_profile_graph_store_legacy_source_task_padding_1 ",
          source: "user_input_pattern.work_at",
          observedAt: " 2026-04-03T16:05:05-05:00 ",
          confirmedAt: "2026-04-03T21:05:05.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-03T21:05:05.000Z"
        }
      ],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:30.500Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_legacy_source_task_padding_existing",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_legacy_source_task_padding_1",
            sourceFingerprint:
              "fingerprint_profile_graph_store_legacy_source_task_padding_existing",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:05:05.000Z",
            observedAt: "2026-04-03T21:05:05.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          })
        ],
        claims: [],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const matchingObservations = loaded.graph.observations.filter(
      (observation) =>
        observation.payload.normalizedKey === "employment.current" &&
        observation.payload.normalizedValue === "Lantern"
    );

    assert.equal(matchingObservations.length, 1);
    assert.equal(
      matchingObservations[0]?.payload.observationId,
      "observation_profile_graph_store_legacy_source_task_padding_existing"
    );
    assert.equal(
      matchingObservations[0]?.payload.sourceTaskId,
      "task_profile_graph_store_legacy_source_task_padding_1"
    );
    assert.equal(loaded.graph.claims.length, 1);
    assert.deepEqual(
      loaded.graph.claims[0]?.payload.derivedFromObservationIds,
      ["observation_profile_graph_store_legacy_source_task_padding_existing"]
    );
  });
});

test("profile memory load canonicalizes retained fact sources before legacy observation backfill", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const baseState = {
      ...emptyState,
      facts: [
        {
          id: "fact_profile_graph_store_legacy_source_padding_1",
          key: "employment.current",
          value: "Lantern",
          sensitive: false,
          status: "confirmed" as const,
          confidence: 0.95,
          sourceTaskId: "task_profile_graph_store_legacy_source_padding_1",
          observedAt: "2026-04-03T16:05:05-05:00",
          confirmedAt: "2026-04-03T21:05:05.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-03T21:05:05.000Z"
        }
      ],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:30.550Z",
        observations: [],
        claims: [],
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 1,
          entries: []
        }
      }
    };
    const expected = normalizeProfileMemoryState({
      ...baseState,
      facts: [
        {
          ...baseState.facts[0]!,
          source: "user_input_pattern.work_at"
        }
      ]
    });
    await saveSeededProfileMemoryState(filePath, encryptionKey, {
      ...baseState,
      facts: [
        {
          ...baseState.facts[0]!,
          source: " User_Input_Pattern.Work_At "
        }
      ]
    });

    const loaded = await store.load();

    assert.equal(loaded.graph.observations.length, 1);
    assert.equal(loaded.graph.claims.length, 1);
    assert.equal(
      loaded.graph.observations[0]?.payload.observationId,
      expected.graph.observations[0]?.payload.observationId
    );
    assert.equal(
      loaded.graph.observations[0]?.payload.sourceFingerprint,
      expected.graph.observations[0]?.payload.sourceFingerprint
    );
    assert.deepEqual(
      loaded.graph.claims[0]?.payload.derivedFromObservationIds,
      [expected.graph.observations[0]!.payload.observationId]
    );
  });
});

test("profile memory load canonicalizes retained fact keys and values before legacy backfill fingerprints", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const baseState = {
      ...emptyState,
      facts: [
        {
          id: "fact_profile_graph_store_legacy_key_value_padding_1",
          sensitive: false,
          status: "confirmed" as const,
          confidence: 0.95,
          sourceTaskId: "task_profile_graph_store_legacy_key_value_padding_1",
          source: "user_input_pattern.work_at",
          observedAt: "2026-04-03T16:05:05-05:00",
          confirmedAt: "2026-04-03T21:05:05.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-03T21:05:05.000Z"
        }
      ],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:30.560Z",
        observations: [],
        claims: [],
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 1,
          entries: []
        }
      }
    };
    const expected = normalizeProfileMemoryState({
      ...baseState,
      facts: [
        {
          ...baseState.facts[0]!,
          key: "employment.current",
          value: "Lantern"
        }
      ]
    });
    await saveSeededProfileMemoryState(filePath, encryptionKey, {
      ...baseState,
      facts: [
        {
          ...baseState.facts[0]!,
          key: " employment.current ",
          value: " Lantern "
        }
      ]
    });

    const loaded = await store.load();

    assert.equal(loaded.graph.observations.length, 1);
    assert.equal(loaded.graph.claims.length, 1);
    assert.equal(
      loaded.graph.observations[0]?.payload.observationId,
      expected.graph.observations[0]?.payload.observationId
    );
    assert.equal(
      loaded.graph.observations[0]?.payload.sourceFingerprint,
      expected.graph.observations[0]?.payload.sourceFingerprint
    );
    assert.deepEqual(
      loaded.graph.claims[0]?.payload.derivedFromObservationIds,
      [expected.graph.observations[0]!.payload.observationId]
    );
  });
});

test("profile memory load canonicalizes retained fact observedAt before legacy backfill fingerprints", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const baseState = {
      ...emptyState,
      facts: [
        {
          id: "fact_profile_graph_store_legacy_observed_at_padding_1",
          key: "employment.current",
          value: "Lantern",
          sensitive: false,
          status: "confirmed" as const,
          confidence: 0.95,
          sourceTaskId: "task_profile_graph_store_legacy_observed_at_padding_1",
          source: "user_input_pattern.work_at",
          confirmedAt: "2026-04-03T21:05:05.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-03T21:05:05.000Z"
        }
      ],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:30.565Z",
        observations: [],
        claims: [],
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 1,
          entries: []
        }
      }
    };
    const expected = normalizeProfileMemoryState({
      ...baseState,
      facts: [
        {
          ...baseState.facts[0]!,
          observedAt: "2026-04-03T21:05:05.000Z"
        }
      ]
    });
    await saveSeededProfileMemoryState(filePath, encryptionKey, {
      ...baseState,
      facts: [
        {
          ...baseState.facts[0]!,
          observedAt: " 2026-04-03T16:05:05-05:00 "
        }
      ]
    });

    const loaded = await store.load();

    assert.equal(loaded.graph.observations.length, 1);
    assert.equal(loaded.graph.claims.length, 1);
    assert.equal(
      loaded.graph.observations[0]?.payload.observationId,
      expected.graph.observations[0]?.payload.observationId
    );
    assert.equal(
      loaded.graph.observations[0]?.payload.sourceFingerprint,
      expected.graph.observations[0]?.payload.sourceFingerprint
    );
    assert.equal(
      loaded.graph.observations[0]?.payload.observedAt,
      expected.graph.observations[0]?.payload.observedAt
    );
    assert.deepEqual(
      loaded.graph.claims[0]?.payload.derivedFromObservationIds,
      [expected.graph.observations[0]!.payload.observationId]
    );
  });
});

test("profile memory load canonicalizes retained fact ids before legacy winner tie-break repair", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      facts: [
        {
          id: "fact_profile_graph_store_legacy_id_padding_1",
          key: "employment.current",
          value: "Lantern",
          sensitive: false,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_graph_store_legacy_id_padding_1",
          source: "user_input_pattern.work_at",
          observedAt: "2026-04-03T21:05:05.750Z",
          confirmedAt: "2026-04-03T21:05:05.750Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-03T21:05:05.750Z"
        },
        {
          id: " fact_profile_graph_store_legacy_id_padding_2 ",
          key: "employment.current",
          value: "Northstar",
          sensitive: false,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_graph_store_legacy_id_padding_2",
          source: "user_input_pattern.job_is",
          observedAt: "2026-04-03T21:05:05.750Z",
          confirmedAt: "2026-04-03T21:05:05.750Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-03T21:05:05.750Z"
        }
      ],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:30.575Z",
        observations: [],
        claims: [],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const activeClaims = loaded.graph.claims.filter((claim) => claim.payload.active);

    assert.equal(loaded.graph.observations.length, 2);
    assert.equal(activeClaims.length, 1);
    assert.equal(activeClaims[0]?.payload.normalizedValue, "Lantern");
    assert.deepEqual(
      activeClaims[0]?.payload.projectionSourceIds,
      ["fact_profile_graph_store_legacy_id_padding_1"]
    );
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["employment.current"],
      activeClaims[0]!.payload.claimId
    );
  });
});

test("profile memory load treats whitespace-only retained fact supersededAt as active during legacy backfill", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      facts: [
        {
          id: "fact_profile_graph_store_blank_superseded_at_1",
          key: "employment.current",
          value: "Lantern",
          sensitive: false,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_graph_store_blank_superseded_at_1",
          source: "user_input_pattern.work_at",
          observedAt: "2026-04-03T21:05:06.000Z",
          confirmedAt: "2026-04-03T21:05:06.000Z",
          supersededAt: "   ",
          lastUpdatedAt: "2026-04-03T21:05:06.000Z"
        }
      ],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:30.600Z",
        observations: [],
        claims: [],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.observations.length, 1);
    assert.equal(loaded.graph.claims.length, 1);
    assert.equal(loaded.graph.claims[0]?.payload.normalizedValue, "Lantern");
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["employment.current"],
      loaded.graph.claims[0]!.payload.claimId
    );
  });
});

test("profile memory load backfills current claims from legacy active facts when matching observations already exist", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      facts: [
        {
          id: "fact_profile_graph_store_legacy_partial_backfill_1",
          key: " employment.current ",
          value: "Lantern",
          sensitive: false,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_graph_store_legacy_partial_backfill_1",
          source: "user_input_pattern.work_at",
          observedAt: " 2026-04-03T16:05:10-05:00 ",
          confirmedAt: "2026-04-03T21:05:10.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-03T21:05:10.000Z"
        },
        {
          id: "fact_profile_graph_store_legacy_partial_backfill_2",
          key: " employment.current ",
          value: "Northstar",
          sensitive: false,
          status: "uncertain",
          confidence: 0.6,
          sourceTaskId: "task_profile_graph_store_legacy_partial_backfill_2",
          source: "user_input_pattern.job_is",
          observedAt: " 2026-04-03T16:06:10-05:00 ",
          confirmedAt: null,
          supersededAt: null,
          lastUpdatedAt: "2026-04-03T21:06:10.000Z"
        }
      ],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:31.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_legacy_partial_backfill_existing",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_legacy_partial_backfill_1",
            sourceFingerprint: "fingerprint_profile_graph_store_legacy_partial_backfill_existing",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:05:10.000Z",
            observedAt: "2026-04-03T21:05:10.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          }),
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_legacy_partial_backfill_unrelated",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.1",
            normalizedValue: "Owen still needs help",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_legacy_partial_backfill_unrelated",
            sourceFingerprint: "fingerprint_profile_graph_store_legacy_partial_backfill_unrelated",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:01:10.000Z",
            observedAt: "2026-04-03T21:01:10.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: ["entity_owen"]
          })
        ],
        claims: [],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const lanternObservations = loaded.graph.observations.filter(
      (observation) =>
        observation.payload.normalizedKey === "employment.current" &&
        observation.payload.normalizedValue === "Lantern"
    );

    assert.equal(loaded.graph.observations.length, 3);
    assert.equal(lanternObservations.length, 1);
    assert.equal(
      lanternObservations[0]?.payload.observationId,
      "observation_profile_graph_store_legacy_partial_backfill_existing"
    );
    assert.equal(
      loaded.graph.observations.find(
        (observation) =>
          observation.payload.normalizedKey === "employment.current" &&
          observation.payload.normalizedValue === "Northstar"
      )?.payload.observedAt,
      "2026-04-03T21:06:10.000Z"
    );
    assert.equal(loaded.graph.claims.length, 1);
    assert.equal(loaded.graph.claims[0]?.payload.family, "employment.current");
    assert.equal(loaded.graph.claims[0]?.payload.normalizedValue, "Lantern");
    assert.equal(loaded.graph.claims[0]?.payload.assertedAt, "2026-04-03T21:05:10.000Z");
    assert.deepEqual(
      loaded.graph.claims[0]?.payload.derivedFromObservationIds,
      ["observation_profile_graph_store_legacy_partial_backfill_existing"]
    );
    assert.equal(loaded.graph.mutationJournal.entries.length, 2);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.observationIds,
      loaded.graph.observations
        .map((observation) => observation.payload.observationId)
        .sort((left, right) => left.localeCompare(right))
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[1]?.claimIds,
      [loaded.graph.claims[0]!.payload.claimId]
    );
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["employment.current"],
      loaded.graph.claims[0]!.payload.claimId
    );
    assert.equal(loaded.graph.readModel.watermark, 2);
  });
});

test("profile memory load backfills current claims when only inactive legacy claims remain", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      facts: [
        {
          id: "fact_profile_graph_store_legacy_inactive_backfill_1",
          key: "employment.current",
          value: "Lantern",
          sensitive: false,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_graph_store_legacy_inactive_backfill_1",
          source: "user_input_pattern.work_at",
          observedAt: "2026-04-03T21:05:20.000Z",
          confirmedAt: "2026-04-03T21:05:20.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-03T21:05:20.000Z"
        },
        {
          id: "fact_profile_graph_store_legacy_inactive_backfill_2",
          key: "employment.current",
          value: "Northstar",
          sensitive: false,
          status: "uncertain",
          confidence: 0.6,
          sourceTaskId: "task_profile_graph_store_legacy_inactive_backfill_2",
          source: "user_input_pattern.job_is",
          observedAt: "2026-04-03T21:06:20.000Z",
          confirmedAt: null,
          supersededAt: null,
          lastUpdatedAt: "2026-04-03T21:06:20.000Z"
        }
      ],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:32.000Z",
        observations: [],
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_legacy_inactive_backfill_closed",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "OldCo",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_legacy_inactive_backfill_closed",
            sourceFingerprint: "fingerprint_profile_graph_store_legacy_inactive_backfill_closed",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T20:05:20.000Z",
            validFrom: "2026-04-03T20:05:20.000Z",
            validTo: "2026-04-03T20:45:20.000Z",
            endedAt: "2026-04-03T20:45:20.000Z",
            endedByClaimId: "claim_profile_graph_store_legacy_inactive_backfill_successor",
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_legacy_inactive_backfill_closed"],
            entityRefIds: [],
            active: false
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const activeClaims = loaded.graph.claims.filter((claim) => claim.payload.active);

    assert.equal(loaded.graph.observations.length, 2);
    assert.equal(loaded.graph.claims.length, 2);
    assert.equal(activeClaims.length, 1);
    assert.equal(activeClaims[0]?.payload.normalizedValue, "Lantern");
    assert.deepEqual(
      activeClaims[0]?.payload.derivedFromObservationIds,
      [loaded.graph.observations[0]!.payload.observationId]
    );
    assert.equal(
      loaded.graph.claims.some(
        (claim) => claim.payload.claimId === "claim_profile_graph_store_legacy_inactive_backfill_closed"
      ),
      true
    );
    assert.equal(loaded.graph.mutationJournal.entries.length, 2);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[1]?.claimIds,
      [activeClaims[0]!.payload.claimId]
    );
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["employment.current"],
      activeClaims[0]!.payload.claimId
    );
    assert.equal(loaded.graph.readModel.watermark, 2);
  });
});

test("profile memory load repairs stale active legacy claims when canonical current winner differs", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      facts: [
        {
          id: "fact_profile_graph_store_legacy_stale_active_backfill_1",
          key: "employment.current",
          value: "Lantern",
          sensitive: false,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_graph_store_legacy_stale_active_backfill_1",
          source: "user_input_pattern.work_at",
          observedAt: "2026-04-03T21:45:30.000Z",
          confirmedAt: "2026-04-03T21:45:30.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-03T21:45:30.000Z"
        },
        {
          id: "fact_profile_graph_store_legacy_stale_active_backfill_2",
          key: "employment.current",
          value: "Northstar",
          sensitive: false,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_graph_store_legacy_stale_active_backfill_2",
          source: "user_input_pattern.job_is",
          observedAt: "2026-04-03T22:15:30+01:00",
          confirmedAt: "2026-04-03T21:15:30.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-03T22:15:30+01:00"
        }
      ],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:33.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_legacy_stale_active_backfill_existing",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_legacy_stale_active_backfill_1",
            sourceFingerprint: "fingerprint_profile_graph_store_legacy_stale_active_backfill_existing",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:45:30.000Z",
            observedAt: "2026-04-03T21:45:30.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          })
        ],
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_legacy_stale_active_backfill_oldco",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "OldCo",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_legacy_stale_active_backfill_oldco",
            sourceFingerprint: "fingerprint_profile_graph_store_legacy_stale_active_backfill_oldco",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T20:05:30.000Z",
            validFrom: "2026-04-03T20:05:30.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_legacy_stale_active_backfill_oldco"],
            entityRefIds: [],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const activeClaims = loaded.graph.claims.filter((claim) => claim.payload.active);
    const closedOldClaim = loaded.graph.claims.find(
      (claim) => claim.payload.claimId === "claim_profile_graph_store_legacy_stale_active_backfill_oldco"
    );
    const northstarObservation = loaded.graph.observations.find(
      (observation) =>
        observation.payload.normalizedKey === "employment.current" &&
        observation.payload.normalizedValue === "Northstar"
    );

    assert.equal(loaded.graph.observations.length, 2);
    assert.equal(activeClaims.length, 1);
    assert.equal(activeClaims[0]?.payload.normalizedValue, "Northstar");
    assert.equal(northstarObservation?.payload.observedAt, "2026-04-03T21:15:30.000Z");
    assert.deepEqual(
      activeClaims[0]?.payload.derivedFromObservationIds,
      [northstarObservation!.payload.observationId]
    );
    assert.equal(closedOldClaim?.payload.active, false);
    assert.equal(closedOldClaim?.payload.endedByClaimId, activeClaims[0]?.payload.claimId ?? null);
    assert.equal(loaded.graph.mutationJournal.entries.length, 2);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.observationIds,
      loaded.graph.observations
        .map((observation) => observation.payload.observationId)
        .sort((left, right) => left.localeCompare(right))
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[1]?.claimIds.sort((left, right) => left.localeCompare(right)),
      [activeClaims[0]!.payload.claimId]
    );
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["employment.current"],
      activeClaims[0]!.payload.claimId
    );
    assert.equal(loaded.graph.readModel.watermark, 2);
  });
});

test("profile memory load repairs legacy current claims when matching observations exist but active claim source tier is invalid", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      facts: [
        {
          id: "fact_profile_graph_store_invalid_source_claim_1",
          key: "identity.preferred_name",
          value: "Avery",
          sensitive: true,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_graph_store_invalid_source_claim_1",
          source: "user_input_pattern.name_phrase",
          observedAt: "2026-04-06T03:10:00.000Z",
          confirmedAt: "2026-04-06T03:10:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-06T03:10:00.000Z"
        }
      ],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-06T03:40:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_invalid_source_claim_existing",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: true,
            sourceTaskId: "task_profile_graph_store_invalid_source_claim_1",
            sourceFingerprint: "fingerprint_profile_graph_store_invalid_source_claim_existing",
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
            claimId: "claim_profile_graph_store_invalid_source_claim_old",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: true,
            sourceTaskId: "task_profile_graph_store_invalid_source_claim_1",
            sourceFingerprint: "fingerprint_profile_graph_store_invalid_source_claim_old",
            sourceTier: "assistant_inference",
            assertedAt: "2026-04-06T03:10:00.000Z",
            validFrom: "2026-04-06T03:10:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "inferred",
            derivedFromObservationIds: [
              "observation_profile_graph_store_invalid_source_claim_existing"
            ],
            projectionSourceIds: ["fact_profile_graph_store_invalid_source_claim_1"],
            entityRefIds: [],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const activeClaims = loaded.graph.claims.filter((claim) => claim.payload.active);
    const closedOldClaim = loaded.graph.claims.find(
      (claim) => claim.payload.claimId === "claim_profile_graph_store_invalid_source_claim_old"
    );

    assert.equal(loaded.graph.observations.length, 1);
    assert.equal(activeClaims.length, 1);
    assert.notEqual(
      activeClaims[0]?.payload.claimId,
      "claim_profile_graph_store_invalid_source_claim_old"
    );
    assert.equal(activeClaims[0]?.payload.sourceTier, "explicit_user_statement");
    assert.deepEqual(
      activeClaims[0]?.payload.derivedFromObservationIds,
      ["observation_profile_graph_store_invalid_source_claim_existing"]
    );
    assert.equal(closedOldClaim?.payload.active, false);
    assert.equal(closedOldClaim?.payload.endedByClaimId, activeClaims[0]?.payload.claimId ?? null);
    assert.equal(loaded.graph.mutationJournal.entries.length, 2);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.observationIds,
      ["observation_profile_graph_store_invalid_source_claim_existing"]
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[1]?.claimIds,
      [activeClaims[0]!.payload.claimId]
    );
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
      activeClaims[0]!.payload.claimId
    );
    assert.equal(loaded.graph.readModel.watermark, 2);
  });
});

test("profile memory load repairs semantically aligned legacy current claims with stale metadata, stale projection lineage, stray entity refs, and empty lineage", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
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
    const seededState = {
      ...emptyState,
      facts: [
        {
          id: "fact_profile_graph_store_stale_same_id_claim_old",
          key: "identity.preferred_name",
          value: "Avery",
          sensitive: true,
          status: "superseded",
          confidence: 0.82,
          sourceTaskId: "task_profile_graph_store_stale_same_id_claim_old",
          source: "user_input_pattern.name_phrase",
          observedAt: "2026-04-06T02:10:00.000Z",
          confirmedAt: "2026-04-06T02:10:00.000Z",
          supersededAt: "2026-04-06T03:10:00.000Z",
          lastUpdatedAt: "2026-04-06T03:10:00.000Z"
        },
        {
          id: "fact_profile_graph_store_stale_same_id_claim_1",
          key: "identity.preferred_name",
          value: "Avery",
          sensitive: true,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_graph_store_stale_same_id_claim_1",
          source: "user_input_pattern.name_phrase",
          observedAt: "2026-04-06T03:10:00.000Z",
          confirmedAt: "2026-04-06T03:10:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-06T03:10:00.000Z"
        }
      ],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-06T03:50:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_stale_same_id_claim_existing",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: true,
            sourceTaskId: "task_profile_graph_store_stale_same_id_claim_1",
            sourceFingerprint: "fingerprint_profile_graph_store_stale_same_id_claim_existing",
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
            sourceTaskId: "task_profile_graph_store_stale_same_id_claim_stale",
            sourceFingerprint: "fingerprint_profile_graph_store_stale_same_id_claim_stale",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-06T02:10:00.000Z",
            validFrom: "2026-04-06T02:10:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "system_generated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_stale_same_id_claim_old"],
            entityRefIds: ["entity_profile_graph_store_stale_same_id_claim_stray"],
            active: true
          }, retainedCreatedAt)
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.observations.length, 1);
    assert.equal(loaded.graph.claims.length, 1);
    assert.equal(loaded.graph.claims[0]?.payload.claimId, expectedClaimId);
    assert.equal(loaded.graph.claims[0]?.createdAt, retainedCreatedAt);
    assert.equal(loaded.graph.claims[0]?.payload.active, true);
    assert.equal(
      loaded.graph.claims[0]?.payload.sourceTaskId,
      "task_profile_graph_store_stale_same_id_claim_1"
    );
    assert.equal(
      loaded.graph.claims[0]?.payload.sourceFingerprint,
      expectedSourceFingerprint
    );
    assert.equal(loaded.graph.claims[0]?.payload.assertedAt, "2026-04-06T03:10:00.000Z");
    assert.equal(loaded.graph.claims[0]?.payload.validFrom, "2026-04-06T03:10:00.000Z");
    assert.equal(loaded.graph.claims[0]?.payload.timeSource, "user_stated");
    assert.deepEqual(loaded.graph.claims[0]?.payload.projectionSourceIds, [
      "fact_profile_graph_store_stale_same_id_claim_1"
    ]);
    assert.deepEqual(loaded.graph.claims[0]?.payload.entityRefIds, []);
    assert.deepEqual(
      loaded.graph.claims[0]?.payload.derivedFromObservationIds,
      ["observation_profile_graph_store_stale_same_id_claim_existing"]
    );
    assert.equal(
      loaded.graph.indexes.byEntityRefId["entity_profile_graph_store_stale_same_id_claim_stray"],
      undefined
    );
    assert.equal(loaded.graph.mutationJournal.entries.length, 2);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.observationIds,
      ["observation_profile_graph_store_stale_same_id_claim_existing"]
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[1]?.claimIds,
      [expectedClaimId]
    );
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
      expectedClaimId
    );
    assert.equal(loaded.graph.readModel.watermark, 2);
  });
});

test("profile memory load repairs stale active legacy claims when effective sensitivity differs from stored claim", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      facts: [
        {
          id: "fact_profile_graph_store_sensitive_floor_claim_1",
          key: "residence.current",
          value: "Detroit",
          sensitive: false,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_graph_store_sensitive_floor_claim_1",
          source: "user_input_pattern.residence",
          observedAt: "2026-04-03T21:45:31.000Z",
          confirmedAt: "2026-04-03T21:45:31.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-03T21:45:31.000Z"
        }
      ],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:33.100Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_sensitive_floor_claim_existing",
            stableRefId: null,
            family: "residence.current",
            normalizedKey: "residence.current",
            normalizedValue: "Detroit",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: true,
            sourceTaskId: "task_profile_graph_store_sensitive_floor_claim_1",
            sourceFingerprint: "fingerprint_profile_graph_store_sensitive_floor_claim_existing",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:45:31.000Z",
            observedAt: "2026-04-03T21:45:31.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          })
        ],
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_sensitive_floor_claim_existing",
            stableRefId: null,
            family: "residence.current",
            normalizedKey: "residence.current",
            normalizedValue: "Detroit",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_sensitive_floor_claim_1",
            sourceFingerprint: "fingerprint_profile_graph_store_sensitive_floor_claim_existing",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:45:31.000Z",
            validFrom: "2026-04-03T21:45:31.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [
              "observation_profile_graph_store_sensitive_floor_claim_existing"
            ],
            projectionSourceIds: ["fact_profile_graph_store_sensitive_floor_claim_1"],
            entityRefIds: [],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const activeClaims = loaded.graph.claims.filter((claim) => claim.payload.active);

    assert.equal(loaded.graph.observations.length, 1);
    assert.equal(activeClaims.length, 1);
    assert.equal(activeClaims[0]?.payload.normalizedKey, "residence.current");
    assert.equal(activeClaims[0]?.payload.normalizedValue, "Detroit");
    assert.equal(activeClaims[0]?.payload.sensitive, true);
    assert.deepEqual(
      activeClaims[0]?.payload.derivedFromObservationIds,
      ["observation_profile_graph_store_sensitive_floor_claim_existing"]
    );
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["residence.current"],
      activeClaims[0]!.payload.claimId
    );
  });
});

test("profile memory load repairs stale supporting observations when aligned legacy claims already match", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const sourceFingerprint =
      `graph_fact_backfill_${sha256HexFromCanonicalJson([
        {
          family: "residence.current",
          key: "residence.current",
          value: "Detroit",
          source: "user_input_pattern.residence",
          sourceTaskId: "task_profile_graph_store_sensitive_floor_observation_1",
          observedAt: "2026-04-03T21:45:31.500Z"
        }
      ]).slice(0, 24)}`;
    const observationId =
      `observation_${sha256HexFromCanonicalJson({
        family: "residence.current",
        normalizedKey: "residence.current",
        normalizedValue: "Detroit",
        source: "user_input_pattern.residence",
        observedAt: "2026-04-03T21:45:31.500Z",
        sourceFingerprint
      }).slice(0, 24)}`;
    const seededState = {
      ...emptyState,
      facts: [
        {
          id: "fact_profile_graph_store_sensitive_floor_observation_1",
          key: "residence.current",
          value: "Detroit",
          sensitive: false,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_graph_store_sensitive_floor_observation_1",
          source: "user_input_pattern.residence",
          observedAt: "2026-04-03T21:45:31.500Z",
          confirmedAt: "2026-04-03T21:45:31.500Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-03T21:45:31.500Z"
        }
      ],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:18:33.150Z",
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
            sourceTaskId: "task_profile_graph_store_sensitive_floor_observation_1",
            sourceFingerprint,
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:45:31.500Z",
            observedAt: "2026-04-03T21:45:31.500Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          })
        ],
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_sensitive_floor_observation_existing",
            stableRefId: null,
            family: "residence.current",
            normalizedKey: "residence.current",
            normalizedValue: "Detroit",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: true,
            sourceTaskId: "task_profile_graph_store_sensitive_floor_observation_1",
            sourceFingerprint: "fingerprint_profile_graph_store_sensitive_floor_observation_existing",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:45:31.500Z",
            validFrom: "2026-04-03T21:45:31.500Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [observationId],
            projectionSourceIds: ["fact_profile_graph_store_sensitive_floor_observation_1"],
            entityRefIds: [],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const activeClaims = loaded.graph.claims.filter((claim) => claim.payload.active);

    assert.equal(loaded.graph.observations.length, 1);
    assert.equal(loaded.graph.observations[0]?.payload.observationId, observationId);
    assert.equal(loaded.graph.observations[0]?.payload.sensitive, true);
    assert.equal(activeClaims.length, 1);
    assert.equal(activeClaims[0]?.payload.sensitive, true);
    assert.deepEqual(activeClaims[0]?.payload.derivedFromObservationIds, [observationId]);
  });
});

test("profile memory load reuses canonical graph event ids when retained episode ids are padded", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const canonicalEpisodeId = "episode_profile_graph_store_event_id_canonical";
    const canonicalEventId =
      `event_${sha256HexFromCanonicalJson({ episodeId: canonicalEpisodeId }).slice(0, 24)}`;
    const seededState = {
      ...emptyState,
      episodes: [
        {
          ...createProfileEpisodeRecord({
            title: "Owen tax follow-up",
            summary: "Owen still needs to send the tax form.",
            sourceTaskId: "task_profile_graph_store_event_id_canonical",
            source: "test.seed",
            sourceKind: "explicit_user_statement",
            sensitive: false,
            observedAt: "2026-04-03T21:20:30.000Z",
            confidence: 0.88,
            entityRefs: ["entity_owen"],
            openLoopRefs: ["open_loop_owen_tax"],
            tags: ["followup"]
          }),
          id: ` ${canonicalEpisodeId} `
        }
      ],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:25:30.000Z",
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
            sourceTaskId: "task_profile_graph_store_event_id_canonical",
            sourceFingerprint: "fingerprint_profile_graph_store_event_id_canonical",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:20:30.000Z",
            observedAt: "2026-04-03T21:20:30.000Z",
            validFrom: "2026-04-03T21:20:30.000Z",
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
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.events.length, 1);
    assert.equal(loaded.graph.events[0]?.payload.eventId, canonicalEventId);
    assert.deepEqual(
      loaded.graph.events[0]?.payload.projectionSourceIds,
      [canonicalEpisodeId]
    );
  });
});

test("profile memory load fail-closes malformed retained fact confidence during stale active claim repair", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      facts: [
        {
          id: "fact_profile_graph_store_invalid_confidence_backfill_1",
          key: "employment.current",
          value: "Northstar",
          sensitive: false,
          status: "confirmed",
          confidence: 99,
          sourceTaskId: "task_profile_graph_store_invalid_confidence_backfill_1",
          source: "user_input_pattern.job_is",
          observedAt: "2026-04-03T21:45:30.000Z",
          confirmedAt: "2026-04-03T21:45:30.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-03T21:45:30.000Z"
        },
        {
          id: "fact_profile_graph_store_invalid_confidence_backfill_2",
          key: "employment.current",
          value: "Lantern",
          sensitive: false,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_graph_store_invalid_confidence_backfill_2",
          source: "user_input_pattern.work_at",
          observedAt: "2026-04-03T21:45:30.000Z",
          confirmedAt: "2026-04-03T21:45:30.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-03T21:45:30.000Z"
        }
      ],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T21:49:30.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_invalid_confidence_backfill_existing",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "Lantern",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_invalid_confidence_backfill_2",
            sourceFingerprint:
              "fingerprint_profile_graph_store_invalid_confidence_backfill_existing",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:45:30.000Z",
            observedAt: "2026-04-03T21:45:30.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          })
        ],
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_invalid_confidence_backfill_oldco",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "OldCo",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_invalid_confidence_backfill_oldco",
            sourceFingerprint:
              "fingerprint_profile_graph_store_invalid_confidence_backfill_oldco",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T20:05:30.000Z",
            validFrom: "2026-04-03T20:05:30.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_invalid_confidence_backfill_oldco"],
            entityRefIds: [],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const activeClaims = loaded.graph.claims.filter((claim) => claim.payload.active);
    const closedOldClaim = loaded.graph.claims.find(
      (claim) =>
        claim.payload.claimId ===
        "claim_profile_graph_store_invalid_confidence_backfill_oldco"
    );

    assert.equal(loaded.graph.observations.length, 2);
    assert.equal(activeClaims.length, 1);
    assert.equal(activeClaims[0]?.payload.normalizedValue, "Lantern");
    assert.deepEqual(
      activeClaims[0]?.payload.derivedFromObservationIds,
      ["observation_profile_graph_store_invalid_confidence_backfill_existing"]
    );
    assert.equal(closedOldClaim?.payload.active, false);
    assert.equal(closedOldClaim?.payload.endedByClaimId, activeClaims[0]?.payload.claimId ?? null);
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[0]?.observationIds,
      loaded.graph.observations
        .map((observation) => observation.payload.observationId)
        .sort((left, right) => left.localeCompare(right))
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries[1]?.claimIds.sort((left, right) =>
        left.localeCompare(right)
      ),
      [activeClaims[0]!.payload.claimId]
    );
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["employment.current"],
      activeClaims[0]?.payload.claimId
    );
    assert.equal(loaded.graph.readModel.watermark, 2);
  });
});

test("profile memory ingest populates additive graph observations, current claims, and a journal entry", async () => {
  await withProfileStore(async (store) => {
    const result = await store.ingestFromTaskInput(
      "task_profile_graph_ingest_current",
      "My name is Avery.",
      "2026-04-03T22:00:00.000Z"
    );

    const state = await store.load();
    const preferredNameFact = state.facts.find((fact) => fact.key === "identity.preferred_name");
    const observation = state.graph.observations[0];
    const claim = state.graph.claims[0];
    const journalEntry = state.graph.mutationJournal.entries[0];

    assert.equal(result.appliedFacts, 1);
    assert.ok(preferredNameFact);
    assert.equal(state.graph.observations.length, 1);
    assert.equal(state.graph.claims.length, 1);
    assert.equal(state.graph.mutationJournal.entries.length, 1);
    assert.equal(observation?.payload.family, "identity.preferred_name");
    assert.equal(observation?.payload.normalizedKey, "identity.preferred_name");
    assert.equal(observation?.payload.normalizedValue, "Avery");
    assert.equal(claim?.payload.family, "identity.preferred_name");
    assert.equal(claim?.payload.normalizedKey, "identity.preferred_name");
    assert.equal(claim?.payload.normalizedValue, "Avery");
    assert.equal(claim?.payload.active, true);
    assert.deepEqual(
      claim?.payload.derivedFromObservationIds,
      [observation!.payload.observationId]
    );
    assert.deepEqual(claim?.payload.projectionSourceIds, [preferredNameFact!.id]);
    assert.deepEqual(journalEntry?.observationIds, [observation!.payload.observationId]);
    assert.deepEqual(journalEntry?.claimIds, [claim!.payload.claimId]);
    assert.equal(
      state.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
      claim?.payload.claimId
    );
  });
});

test("profile memory ingest persists corroboration-gated contact hints as graph observations while keeping hinted names out of flat claims", async () => {
  await withProfileStore(async (store) => {
    const result = await store.ingestFromTaskInput(
      "task_profile_graph_ingest_hint_only",
      "I know Sarah.",
      "2026-04-03T22:05:00.000Z"
    );

    const state = await store.load();
    const journalEntry = state.graph.mutationJournal.entries[0];
    const hintObservation = state.graph.observations.find(
      (observation) =>
        observation.payload.family === "contact.entity_hint" &&
        observation.payload.normalizedKey === "contact.sarah.name" &&
        observation.payload.normalizedValue === "Sarah"
    );

    assert.deepEqual(result, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(state.facts.length, 1);
    assert.equal(
      state.facts.some(
        (fact) =>
          fact.key.startsWith("contact.sarah.context.") &&
          fact.value === "I know Sarah"
      ),
      true
    );
    assert.ok(hintObservation);
    assert.equal(state.graph.observations.length, 2);
    assert.equal(state.graph.claims.length, 0);
    assert.equal(state.graph.mutationJournal.entries.length, 1);
    assert.equal(
      journalEntry?.observationIds.includes(hintObservation!.payload.observationId),
      true
    );
    assert.equal(journalEntry?.observationIds.length, 2);
    assert.deepEqual(journalEntry?.claimIds, []);
    assert.equal(
      state.graph.readModel.currentClaimIdsByKey["contact.sarah.name"],
      undefined
    );
  });
});

test("profile memory store skips duplicate same-turn ingest across conversational and broker seams", async () => {
  await withProfileStore(async (store) => {
    const userInput = "I work with Owen at Lantern Studio.";
    const observedAt = "2026-04-02T15:00:00.000Z";
    const sourceFingerprint = buildProfileMemorySourceFingerprint(userInput);

    const firstResult = await store.ingestFromTaskInput(
      "task_profile_idempotency_1",
      userInput,
      observedAt,
      {
        provenance: {
          conversationId: "conversation_profile_idempotency_1",
          turnId: "turn_profile_idempotency_1",
          dominantLaneAtWrite: "profile",
          sourceSurface: "conversation_profile_input",
          sourceFingerprint
        }
      }
    );
    const secondResult = await store.ingestFromTaskInput(
      "task_profile_idempotency_2",
      userInput,
      observedAt,
      {
        provenance: {
          conversationId: "conversation_profile_idempotency_1",
          turnId: "turn_profile_idempotency_1",
          dominantLaneAtWrite: "workflow",
          sourceSurface: "broker_task_ingest",
          sourceFingerprint
        }
      }
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });
    const state = await store.load();

    assert.equal(firstResult.appliedFacts > 0, true);
    assert.deepEqual(secondResult, {
      appliedFacts: 0,
      supersededFacts: 0
    });
    assert.equal(
      facts.filter(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "work_peer"
      ).length,
      1
    );
    assert.equal(
      facts.filter(
        (fact) =>
          fact.key === "contact.owen.work_association" &&
          fact.value === "Lantern Studio"
      ).length,
      1
    );
    assert.equal(state.ingestReceipts.length, 1);
    assert.equal(state.ingestReceipts[0]?.turnId, "turn_profile_idempotency_1");
    assert.equal(state.ingestReceipts[0]?.sourceFingerprint, sourceFingerprint);
    assert.equal(state.graph.observations.length, 4);
    assert.equal(state.graph.claims.length, 3);
    assert.equal(state.graph.mutationJournal.entries.length, 1);
  });
});

test("profile memory store emits bounded mutation envelopes for provenance-backed ingests", async () => {
  await withProfileStore(async (store) => {
    const userInput = "My name is Avery.";
    const observedAt = "2026-04-03T18:00:00.000Z";
    const sourceFingerprint = buildProfileMemorySourceFingerprint(userInput);

    const result = await store.ingestFromTaskInput(
      "task_profile_mutation_envelope_1",
      userInput,
      observedAt,
      {
        provenance: {
          conversationId: "conversation_profile_mutation_envelope_1",
          turnId: "turn_profile_mutation_envelope_1",
          dominantLaneAtWrite: "profile",
          threadKey: "thread_profile_mutation_envelope_1",
          sourceSurface: "conversation_profile_input",
          sourceFingerprint
        }
      }
    );

    assert.equal(result.appliedFacts, 1);
    assert.ok(result.mutationEnvelope);
    assert.deepEqual(result.mutationEnvelope?.requestCorrelation, {
      conversationId: "conversation_profile_mutation_envelope_1",
      turnId: "turn_profile_mutation_envelope_1",
      dominantLaneAtWrite: "profile",
      threadKey: "thread_profile_mutation_envelope_1",
      sourceSurface: "conversation_profile_input",
      sourceFingerprint,
      normalizedInputIdentity: `input_${sourceFingerprint}`
    });
    assert.equal(result.mutationEnvelope?.redactionState, "not_requested");
    assert.equal(result.mutationEnvelope?.candidateRefs.length, 1);
    assert.equal(result.mutationEnvelope?.appliedWriteRefs.length, 1);
    assert.equal(
      result.mutationEnvelope?.governanceDecisions[0]?.family,
      "identity.preferred_name"
    );
    assert.equal(
      result.mutationEnvelope?.governanceDecisions[0]?.governanceAction,
      "allow_current_state"
    );
    assert.deepEqual(
      result.mutationEnvelope?.governanceDecisions[0]?.appliedWriteRefs,
      result.mutationEnvelope?.appliedWriteRefs
    );
  });
});

test("profile memory store quarantines unsupported validated fact sources before canonical mutation", async () => {
  await withProfileStore(async (store) => {
    const ingestResult = await store.ingestFromTaskInput(
      "task_profile_governance_quarantine",
      "",
      "2026-04-02T15:00:00.000Z",
      {
        validatedFactCandidates: [
          {
            key: "identity.preferred_name",
            candidateValue: "Avery",
            source: "assistant.generated_fact",
            confidence: 0.81
          }
        ]
      }
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(ingestResult, {
      appliedFacts: 0,
      supersededFacts: 0
    });
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "identity.preferred_name" &&
          fact.value === "Avery"
      ),
      false
    );
  });
});

test("profile memory store does not project historical self employment or residence into current flat facts", async () => {
  await withProfileStore(async (store) => {
    const ingestResult = await store.ingestFromTaskInput(
      "task_profile_governance_historical_self",
      "I used to work at Lantern. I used to live in Detroit.",
      "2026-04-02T15:00:00.000Z"
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_historical_self_1"
    });

    assert.deepEqual(ingestResult, {
      appliedFacts: 0,
      supersededFacts: 0
    });
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "employment.current" &&
          fact.value === "Lantern"
      ),
      false
    );
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "residence.current" &&
          fact.value === "Detroit"
      ),
      false
    );
  });
});

test("profile memory store keeps explicit self end-state phrasing out of current flat facts", async () => {
  await withProfileStore(async (store) => {
    const ingestResult = await store.ingestFromTaskInput(
      "task_profile_governance_end_state_self",
      "I quit my job at Lantern. I don't live in Detroit anymore.",
      "2026-04-02T15:00:00.000Z"
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_end_state_self_1"
    });

    assert.deepEqual(ingestResult, {
      appliedFacts: 0,
      supersededFacts: 0
    });
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "employment.current" &&
          fact.value === "Lantern"
      ),
      false
    );
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "residence.current" &&
          fact.value === "Detroit"
      ),
      false
    );
  });
});

test("profile memory store keeps severed contact work-linkage out of current flat facts while preserving contact identity", async () => {
  await withProfileStore(async (store) => {
    const ingestResult = await store.ingestFromTaskInput(
      "task_profile_governance_severed_contact",
      "I don't work with Owen at Lantern Studio anymore.",
      "2026-04-02T15:00:00.000Z"
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.equal(ingestResult.appliedFacts, 1);
    assert.equal(ingestResult.supersededFacts, 0);
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "work_peer"
      ),
      false
    );
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "contact.owen.work_association" &&
          fact.value === "Lantern Studio"
      ),
      false
    );
  });
});

test("profile memory store keeps historical contact work-linkage out of current flat facts while preserving contact identity", async () => {
  await withProfileStore(async (store) => {
    const workedWithResult = await store.ingestFromTaskInput(
      "task_profile_governance_historical_contact_work_with",
      "I worked with Owen at Lantern Studio.",
      "2026-04-02T15:00:00.000Z"
    );

    const workedWithFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(workedWithResult, {
      appliedFacts: 2,
      supersededFacts: 0
    });
    assert.equal(
      workedWithFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      workedWithFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "work_peer"
      ),
      false
    );
    assert.equal(
      workedWithFacts.some(
        (fact) =>
          fact.key === "contact.owen.work_association" &&
          fact.value === "Lantern Studio"
      ),
      false
    );

    const workedWithMeResult = await store.ingestFromTaskInput(
      "task_profile_governance_historical_contact_work_association",
      "My friend Riley worked with me at Lantern Studio.",
      "2026-04-02T15:00:30.000Z"
    );

    const workedWithMeFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(workedWithMeResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      workedWithMeFacts.some(
        (fact) =>
          fact.key === "contact.riley.name" &&
          fact.value === "Riley"
      ),
      true
    );
    assert.equal(
      workedWithMeFacts.some(
        (fact) =>
          fact.key === "contact.riley.relationship" &&
          fact.value === "friend"
      ),
      true
    );
    assert.equal(
      workedWithMeFacts.some(
        (fact) =>
          fact.key === "contact.riley.relationship" &&
          fact.value === "work_peer"
      ),
      false
    );
    assert.equal(
      workedWithMeFacts.some(
        (fact) =>
          fact.key === "contact.riley.work_association" &&
          fact.value === "Lantern Studio"
      ),
      false
    );
  });
});

test("profile memory store keeps historical and severed direct contact relationships out of current flat facts while preserving contact identity", async () => {
  await withProfileStore(async (store) => {
    const formerCoworkerResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_historical_contact",
      "Owen is my former coworker at Lantern Studio.",
      "2026-04-02T15:00:00.000Z"
    );
    const formerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(formerCoworkerResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      formerFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      formerFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "coworker"
      ),
      false
    );
    assert.equal(
      formerFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "work_peer"
      ),
      false
    );
    assert.equal(
      formerFacts.some(
        (fact) =>
          fact.key === "contact.owen.work_association" &&
          fact.value === "Lantern Studio"
      ),
      false
    );

    const formerFriendResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_friend_historical_contact",
      "Owen and I used to be friends.",
      "2026-04-03T15:00:30.000Z"
    );
    const formerFriendFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(formerFriendResult, {
      appliedFacts: 2,
      supersededFacts: 0
    });
    assert.equal(
      formerFriendFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      formerFriendFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "friend"
      ),
      false
    );

    const formerPartnerResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_partner_historical_contact",
      "Sam is my former girlfriend.",
      "2026-04-03T15:00:40.000Z"
    );
    const formerPartnerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(formerPartnerResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      formerPartnerFacts.some(
        (fact) =>
          fact.key === "contact.sam.name" &&
          fact.value === "Sam"
      ),
      true
    );
    assert.equal(
      formerPartnerFacts.some(
        (fact) =>
          fact.key === "contact.sam.relationship" &&
          fact.value === "partner"
      ),
      false
    );

    const formerMarriedPartnerResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_married_historical_contact",
      "I used to be married to Jules.",
      "2026-04-03T15:00:42.000Z"
    );
    const formerMarriedPartnerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(formerMarriedPartnerResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      formerMarriedPartnerFacts.some(
        (fact) =>
          fact.key === "contact.jules.name" &&
          fact.value === "Jules"
      ),
      true
    );
    assert.equal(
      formerMarriedPartnerFacts.some(
        (fact) =>
          fact.key === "contact.jules.relationship" &&
          fact.value === "partner"
      ),
      false
    );

    const formerRoommateResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_roommate_historical_contact",
      "Mira is my former roommate.",
      "2026-04-03T15:00:43.000Z"
    );
    const formerRoommateFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(formerRoommateResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      formerRoommateFacts.some(
        (fact) =>
          fact.key === "contact.mira.name" &&
          fact.value === "Mira"
      ),
      true
    );
    assert.equal(
      formerRoommateFacts.some(
        (fact) =>
          fact.key === "contact.mira.relationship" &&
          fact.value === "roommate"
      ),
      false
    );

    const severedRoommateResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_roommate_severed_contact",
      "Noah is no longer my roommate.",
      "2026-04-03T15:00:43.500Z"
    );
    const severedRoommateFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedRoommateResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedRoommateFacts.some(
        (fact) =>
          fact.key === "contact.noah.name" &&
          fact.value === "Noah"
      ),
      true
    );
    assert.equal(
      severedRoommateFacts.some(
        (fact) =>
          fact.key === "contact.noah.relationship" &&
          fact.value === "roommate"
      ),
      false
    );

    const formerPeerResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_peer_historical_contact",
      "Parker and I used to be peers.",
      "2026-04-03T15:00:45.000Z"
    );
    const formerPeerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(formerPeerResult, {
      appliedFacts: 2,
      supersededFacts: 0
    });
    assert.equal(
      formerPeerFacts.some(
        (fact) =>
          fact.key === "contact.parker.name" &&
          fact.value === "Parker"
      ),
      true
    );
    assert.equal(
      formerPeerFacts.some(
        (fact) =>
          fact.key === "contact.parker.relationship" &&
          fact.value === "work_peer"
      ),
      false
    );

    const formerCousinResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_cousin_historical_contact",
      "Owen and I used to be cousins.",
      "2026-04-03T15:00:50.000Z"
    );
    const formerCousinFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(formerCousinResult, {
      appliedFacts: 2,
      supersededFacts: 0
    });
    assert.equal(
      formerCousinFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      formerCousinFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "cousin"
      ),
      false
    );

    const formerDistantRelativeResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_distant_relative_historical_contact",
      "Rosa and I used to be distant relatives.",
      "2026-04-03T15:00:55.000Z"
    );
    const formerDistantRelativeFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(formerDistantRelativeResult, {
      appliedFacts: 2,
      supersededFacts: 0
    });
    assert.equal(
      formerDistantRelativeFacts.some(
        (fact) =>
          fact.key === "contact.rosa.name" &&
          fact.value === "Rosa"
      ),
      true
    );
    assert.equal(
      formerDistantRelativeFacts.some(
        (fact) =>
          fact.key === "contact.rosa.relationship" &&
          fact.value === "relative"
      ),
      false
    );

    const formerFamilyResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_family_historical_contact",
      "Mina and I used to be family.",
      "2026-04-03T15:00:57.500Z"
    );
    const formerFamilyFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.equal(formerFamilyResult.appliedFacts >= 1, true);
    assert.equal(
      formerFamilyFacts.some(
        (fact) =>
          fact.key === "contact.mina.name" &&
          fact.value === "Mina"
      ),
      true
    );
    assert.equal(
      formerFamilyFacts.some(
        (fact) =>
          fact.key === "contact.mina.relationship" &&
          fact.value === "relative"
      ),
      false
    );

    const currentBossResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_current_boss_contact",
      "Milo is my boss at Northstar Creative.",
      "2026-04-02T15:03:00.000Z"
    );
    const currentFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentBossResult, {
      appliedFacts: 4,
      supersededFacts: 0
    });
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.milo.relationship" &&
          fact.value === "manager"
      ),
      true
    );
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.milo.work_association" &&
          fact.value === "Northstar Creative"
      ),
      true
    );

    const currentSupervisorResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_supervisor_contact",
      "My supervisor is Dana.",
      "2026-04-02T15:04:00.000Z"
    );
    const supervisorFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentSupervisorResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      supervisorFacts.some(
        (fact) =>
          fact.key === "contact.dana.name" &&
          fact.value === "Dana"
      ),
      true
    );
    assert.equal(
      supervisorFacts.some(
        (fact) =>
          fact.key === "contact.dana.relationship" &&
          fact.value === "manager"
      ),
      true
    );
    assert.equal(
      supervisorFacts.some(
        (fact) =>
          fact.key === "supervisor" &&
          fact.value === "Dana"
      ),
      false
    );

    const currentNamedBossResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_boss_contact",
      "My boss is Dana.",
      "2026-04-03T15:04:05.000Z"
    );
    const namedBossFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentNamedBossResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      namedBossFacts.some(
        (fact) =>
          fact.key === "contact.dana.name" &&
          fact.value === "Dana"
      ),
      true
    );
    assert.equal(
      namedBossFacts.some(
        (fact) =>
          fact.key === "contact.dana.relationship" &&
          fact.value === "manager"
      ),
      true
    );
    assert.equal(
      namedBossFacts.some(
        (fact) =>
          fact.key === "boss" &&
          fact.value === "Dana"
      ),
      false
    );

    const currentTeamLeadResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_team_lead_contact",
      "My team lead is Reese.",
      "2026-04-02T15:04:30.000Z"
    );
    const teamLeadFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentTeamLeadResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      teamLeadFacts.some(
        (fact) =>
          fact.key === "contact.reese.name" &&
          fact.value === "Reese"
      ),
      true
    );
    assert.equal(
      teamLeadFacts.some(
        (fact) =>
          fact.key === "contact.reese.relationship" &&
          fact.value === "manager"
      ),
      true
    );

    const currentLeadResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_lead_contact",
      "My lead is Avery.",
      "2026-04-02T15:04:45.000Z"
    );
    const leadFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentLeadResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      leadFacts.some(
        (fact) =>
          fact.key === "contact.avery.name" &&
          fact.value === "Avery"
      ),
      true
    );
    assert.equal(
      leadFacts.some(
        (fact) =>
          fact.key === "contact.avery.relationship" &&
          fact.value === "manager"
      ),
      true
    );

    const currentNeighbourResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_neighbour_contact",
      "My neighbour is Priya.",
      "2026-04-02T15:04:50.000Z"
    );
    const neighbourFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentNeighbourResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      neighbourFacts.some(
        (fact) =>
          fact.key === "contact.priya.name" &&
          fact.value === "Priya"
      ),
      true
    );
    assert.equal(
      neighbourFacts.some(
        (fact) =>
          fact.key === "contact.priya.relationship" &&
          fact.value === "neighbor"
      ),
      true
    );

    const currentPeerResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_peer_contact",
      "My peer is Nolan.",
      "2026-04-02T15:04:55.000Z"
    );
    const peerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentPeerResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      peerFacts.some(
        (fact) =>
          fact.key === "contact.nolan.name" &&
          fact.value === "Nolan"
      ),
      true
    );
    assert.equal(
      peerFacts.some(
        (fact) =>
          fact.key === "contact.nolan.relationship" &&
          fact.value === "work_peer"
      ),
      true
    );

    const currentWorkPeerResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_work_peer_contact",
      "My work peer is Rowan.",
      "2026-04-03T15:04:55.500Z"
    );
    const workPeerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentWorkPeerResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      workPeerFacts.some(
        (fact) =>
          fact.key === "contact.rowan.name" &&
          fact.value === "Rowan"
      ),
      true
    );
    assert.equal(
      workPeerFacts.some(
        (fact) =>
          fact.key === "contact.rowan.relationship" &&
          fact.value === "work_peer"
      ),
      true
    );
    assert.equal(
      workPeerFacts.some(
        (fact) =>
          fact.key === "work.peer" &&
          fact.value === "Rowan"
      ),
      false
    );

    const currentColleagueResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_colleague_contact",
      "My colleague is Evan.",
      "2026-04-03T15:04:55.750Z"
    );
    const colleagueFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentColleagueResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      colleagueFacts.some(
        (fact) =>
          fact.key === "contact.evan.name" &&
          fact.value === "Evan"
      ),
      true
    );
    assert.equal(
      colleagueFacts.some(
        (fact) =>
          fact.key === "contact.evan.relationship" &&
          fact.value === "work_peer"
      ),
      true
    );
    assert.equal(
      colleagueFacts.some(
        (fact) =>
          fact.key === "contact.evan.relationship" &&
          fact.value === "colleague"
      ),
      false
    );

    const currentAcquaintanceResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_acquaintance_contact",
      "My acquaintance is Riley.",
      "2026-04-03T15:04:56.000Z"
    );
    const acquaintanceFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentAcquaintanceResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      acquaintanceFacts.some(
        (fact) =>
          fact.key === "contact.riley.name" &&
          fact.value === "Riley"
      ),
      true
    );
    assert.equal(
      acquaintanceFacts.some(
        (fact) =>
          fact.key === "contact.riley.relationship" &&
          fact.value === "acquaintance"
      ),
      true
    );
    assert.equal(
      acquaintanceFacts.some(
        (fact) =>
          fact.key === "acquaintance" &&
          fact.value === "Riley"
      ),
      false
    );

    const currentCousinResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_cousin_contact",
      "My cousin is Liam.",
      "2026-04-02T15:04:57.000Z"
    );
    const cousinFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentCousinResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      cousinFacts.some(
        (fact) =>
          fact.key === "contact.liam.name" &&
          fact.value === "Liam"
      ),
      true
    );
    assert.equal(
      cousinFacts.some(
        (fact) =>
          fact.key === "contact.liam.relationship" &&
          fact.value === "cousin"
      ),
      true
    );
    assert.equal(
      cousinFacts.some(
        (fact) =>
          fact.key === "cousin" &&
          fact.value === "Liam"
      ),
      false
    );

    const currentAuntResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_aunt_contact",
      "My aunt is Rosa.",
      "2026-04-03T15:04:57.500Z"
    );
    const auntFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentAuntResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      auntFacts.some(
        (fact) =>
          fact.key === "contact.rosa.name" &&
          fact.value === "Rosa"
      ),
      true
    );
    assert.equal(
      auntFacts.some(
        (fact) =>
          fact.key === "contact.rosa.relationship" &&
          fact.value === "relative"
      ),
      true
    );
    assert.equal(
      auntFacts.some(
        (fact) =>
          fact.key === "aunt" &&
          fact.value === "Rosa"
      ),
      false
    );

    const currentMomResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_mom_contact",
      "My mom is Ava.",
      "2026-04-03T15:04:57.563Z"
    );
    const momFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentMomResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      momFacts.some(
        (fact) =>
          fact.key === "contact.ava.name" &&
          fact.value === "Ava"
      ),
      true
    );
    assert.equal(
      momFacts.some(
        (fact) =>
          fact.key === "contact.ava.relationship" &&
          fact.value === "relative"
      ),
      true
    );
    assert.equal(
      momFacts.some(
        (fact) =>
          fact.key === "mom" &&
          fact.value === "Ava"
      ),
      false
    );

    const currentFamilyMemberResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_family_member_contact",
      "My family member is Rosa.",
      "2026-04-03T15:04:57.594Z"
    );
    const familyMemberFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentFamilyMemberResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      familyMemberFacts.some(
        (fact) =>
          fact.key === "contact.rosa.name" &&
          fact.value === "Rosa"
      ),
      true
    );
    assert.equal(
      familyMemberFacts.some(
        (fact) =>
          fact.key === "contact.rosa.relationship" &&
          fact.value === "relative"
      ),
      true
    );
    assert.equal(
      familyMemberFacts.some(
        (fact) =>
          fact.key === "family.member" &&
          fact.value === "Rosa"
      ),
      false
    );

    const currentSonResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_son_contact",
      "My son is Mason.",
      "2026-04-03T15:04:57.610Z"
    );
    const sonFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentSonResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      sonFacts.some(
        (fact) =>
          fact.key === "contact.mason.name" &&
          fact.value === "Mason"
      ),
      true
    );
    assert.equal(
      sonFacts.some(
        (fact) =>
          fact.key === "contact.mason.relationship" &&
          fact.value === "relative"
      ),
      true
    );
    assert.equal(
      sonFacts.some(
        (fact) =>
          fact.key === "son" &&
          fact.value === "Mason"
      ),
      false
    );

    const currentPartnerResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_partner_contact",
      "My wife is Sam.",
      "2026-04-03T15:04:57.625Z"
    );
    const partnerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentPartnerResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      partnerFacts.some(
        (fact) =>
          fact.key === "contact.sam.name" &&
          fact.value === "Sam"
      ),
      true
    );
    assert.equal(
      partnerFacts.some(
        (fact) =>
          fact.key === "contact.sam.relationship" &&
          fact.value === "partner"
      ),
      true
    );
    assert.equal(
      partnerFacts.some(
        (fact) =>
          fact.key === "wife" &&
          fact.value === "Sam"
      ),
      false
    );

    const currentRoommateResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_roommate_contact",
      "My roommate is Kai.",
      "2026-04-03T15:04:57.600Z"
    );
    const roommateFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentRoommateResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      roommateFacts.some(
        (fact) =>
          fact.key === "contact.kai.name" &&
          fact.value === "Kai"
      ),
      true
    );
    assert.equal(
      roommateFacts.some(
        (fact) =>
          fact.key === "contact.kai.relationship" &&
          fact.value === "roommate"
      ),
      true
    );
    assert.equal(
      roommateFacts.some(
        (fact) =>
          fact.key === "roommate" &&
          fact.value === "Kai"
      ),
      false
    );

    const currentMarriedPartnerResult = await store.ingestFromTaskInput(
      "task_profile_governance_current_married_contact",
      "Jules and I are married.",
      "2026-04-03T15:04:57.700Z"
    );
    const marriedPartnerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentMarriedPartnerResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      marriedPartnerFacts.some(
        (fact) =>
          fact.key === "contact.jules.name" &&
          fact.value === "Jules"
      ),
      true
    );
    assert.equal(
      marriedPartnerFacts.some(
        (fact) =>
          fact.key === "contact.jules.relationship" &&
          fact.value === "partner"
      ),
      true
    );

    const currentDistantRelativeResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_distant_relative_contact",
      "My distant relative is June.",
      "2026-04-03T15:04:57.750Z"
    );
    const distantRelativeFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentDistantRelativeResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      distantRelativeFacts.some(
        (fact) =>
          fact.key === "contact.june.name" &&
          fact.value === "June"
      ),
      true
    );
    assert.equal(
      distantRelativeFacts.some(
        (fact) =>
          fact.key === "contact.june.relationship" &&
          fact.value === "relative"
      ),
      true
    );
    assert.equal(
      distantRelativeFacts.some(
        (fact) =>
          fact.key === "distant.relative" &&
          fact.value === "June"
      ),
      false
    );

    const currentFriendResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_friend_current_contact",
      "I'm friends with Quinn.",
      "2026-04-03T15:04:58.000Z"
    );
    const currentFriendFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentFriendResult, {
      appliedFacts: 2,
      supersededFacts: 0
    });
    assert.equal(
      currentFriendFacts.some(
        (fact) =>
          fact.key === "contact.quinn.name" &&
          fact.value === "Quinn"
      ),
      true
    );
    assert.equal(
      currentFriendFacts.some(
        (fact) =>
          fact.key === "contact.quinn.relationship" &&
          fact.value === "friend"
      ),
      true
    );

    const currentTeammateResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_teammate_current_contact",
      "Parker and I are teammates.",
      "2026-04-03T15:04:59.000Z"
    );
    const currentTeammateFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentTeammateResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      currentTeammateFacts.some(
        (fact) =>
          fact.key === "contact.parker.name" &&
          fact.value === "Parker"
      ),
      true
    );
    assert.equal(
      currentTeammateFacts.some(
        (fact) =>
          fact.key === "contact.parker.relationship" &&
          fact.value === "work_peer"
      ),
      true
    );

    const currentDistantRelativeSymmetricResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_distant_relative_current_contact",
      "Rosa and I are distant relatives.",
      "2026-04-03T15:04:59.500Z"
    );
    const currentDistantRelativeSymmetricFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentDistantRelativeSymmetricResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      currentDistantRelativeSymmetricFacts.some(
        (fact) =>
          fact.key === "contact.rosa.name" &&
          fact.value === "Rosa"
      ),
      true
    );
    assert.equal(
      currentDistantRelativeSymmetricFacts.some(
        (fact) =>
          fact.key === "contact.rosa.relationship" &&
          fact.value === "relative"
      ),
      true
    );

    const severedManagerResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_severed_contact",
      "Jordan is no longer my boss.",
      "2026-04-02T15:05:00.000Z"
    );
    const severedFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedManagerResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedFacts.some(
        (fact) =>
          fact.key === "contact.jordan.name" &&
          fact.value === "Jordan"
      ),
      true
    );
    assert.equal(
      severedFacts.some(
        (fact) =>
          fact.key === "contact.jordan.relationship" &&
          fact.value === "manager"
      ),
      false
    );

    const severedFriendResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_friend_severed_contact",
      "I'm not friends with Owen anymore.",
      "2026-04-03T15:05:05.000Z"
    );
    const severedFriendFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedFriendResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedFriendFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      severedFriendFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "friend"
      ),
      false
    );

    const severedSymmetricPeerResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_peer_severed_contact",
      "I'm not peers with Avery anymore.",
      "2026-04-03T15:05:07.000Z"
    );
    const severedSymmetricPeerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedSymmetricPeerResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedSymmetricPeerFacts.some(
        (fact) =>
          fact.key === "contact.avery.name" &&
          fact.value === "Avery"
      ),
      true
    );
    assert.equal(
      severedSymmetricPeerFacts.some(
        (fact) =>
          fact.key === "contact.avery.relationship" &&
          fact.value === "work_peer"
      ),
      false
    );

    const severedCousinResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_cousin_severed_contact",
      "I'm not cousins with Owen anymore.",
      "2026-04-03T15:05:08.000Z"
    );
    const severedCousinFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedCousinResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedCousinFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      severedCousinFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "cousin"
      ),
      false
    );

    const severedDistantRelativeResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_distant_relative_severed_contact",
      "Naomi and I aren't distant relatives anymore.",
      "2026-04-03T15:05:09.000Z"
    );
    const severedDistantRelativeFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedDistantRelativeResult, {
      appliedFacts: 2,
      supersededFacts: 0
    });
    assert.equal(
      severedDistantRelativeFacts.some(
        (fact) =>
          fact.key === "contact.naomi.name" &&
          fact.value === "Naomi"
      ),
      true
    );
    assert.equal(
      severedDistantRelativeFacts.some(
        (fact) =>
          fact.key === "contact.naomi.relationship" &&
          fact.value === "relative"
      ),
      false
    );

    const severedSiblingResult = await store.ingestFromTaskInput(
      "task_profile_governance_symmetric_sibling_severed_contact",
      "Lena and I aren't siblings anymore.",
      "2026-04-03T15:05:09.500Z"
    );
    const severedSiblingFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.equal(severedSiblingResult.appliedFacts >= 1, true);
    assert.equal(
      severedSiblingFacts.some(
        (fact) =>
          fact.key === "contact.lena.name" &&
          fact.value === "Lena"
      ),
      true
    );
    assert.equal(
      severedSiblingFacts.some(
        (fact) =>
          fact.key === "contact.lena.relationship" &&
          fact.value === "relative"
      ),
      false
    );

    const severedLeadResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_severed_lead_contact",
      "Robin is no longer my lead.",
      "2026-04-02T15:05:15.000Z"
    );
    const severedLeadFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedLeadResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedLeadFacts.some(
        (fact) =>
          fact.key === "contact.robin.name" &&
          fact.value === "Robin"
      ),
      true
    );
    assert.equal(
      severedLeadFacts.some(
        (fact) =>
          fact.key === "contact.robin.relationship" &&
          fact.value === "manager"
      ),
      false
    );

    const severedNeighbourResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_severed_neighbour_contact",
      "Taylor is no longer my neighbour.",
      "2026-04-02T15:05:20.000Z"
    );
    const severedNeighbourFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedNeighbourResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedNeighbourFacts.some(
        (fact) =>
          fact.key === "contact.taylor.name" &&
          fact.value === "Taylor"
      ),
      true
    );
    assert.equal(
      severedNeighbourFacts.some(
        (fact) =>
          fact.key === "contact.taylor.relationship" &&
          fact.value === "neighbor"
      ),
      false
    );

    const severedPeerResult = await store.ingestFromTaskInput(
      "task_profile_governance_direct_severed_peer_contact",
      "Piper is no longer my peer.",
      "2026-04-02T15:05:25.000Z"
    );
    const severedPeerFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedPeerResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedPeerFacts.some(
        (fact) =>
          fact.key === "contact.piper.name" &&
          fact.value === "Piper"
      ),
      true
    );
    assert.equal(
      severedPeerFacts.some(
        (fact) =>
          fact.key === "contact.piper.relationship" &&
          fact.value === "work_peer"
      ),
      false
    );
  });
});

test("profile memory store keeps wrapped named-contact work-with phrasing on one canonical contact token", async () => {
  await withProfileStore(async (store) => {
    const wrappedWorkWithResult = await store.ingestFromTaskInput(
      "task_profile_governance_wrapped_named_work_with_contact",
      "I work with a guy named Milo at Northstar Creative.",
      "2026-04-03T15:10:00.000Z"
    );
    const wrappedFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.equal(wrappedWorkWithResult.appliedFacts > 0, true);
    assert.equal(wrappedWorkWithResult.supersededFacts >= 0, true);
    assert.equal(
      wrappedFacts.some(
        (fact) =>
          fact.key === "contact.milo.name" &&
          fact.value === "Milo"
      ),
      true
    );
    assert.equal(
      wrappedFacts.some(
        (fact) =>
          fact.key === "contact.milo.relationship" &&
          fact.value === "work_peer"
      ),
      true
    );
    assert.equal(
      wrappedFacts.some(
        (fact) =>
          fact.key === "contact.milo.work_association" &&
          fact.value === "Northstar Creative"
      ),
      true
    );
    assert.equal(
      wrappedFacts.some((fact) =>
        fact.key.includes("northstar") || fact.key.includes("a.guy.named.milo")
      ),
      false
    );

    const plainWorkWithMeResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_plain_work_with_me_contact",
      "A person named Milo works with me.",
      "2026-04-03T15:11:00.000Z"
    );
    const plainFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.equal(plainWorkWithMeResult.appliedFacts >= 0, true);
    assert.equal(plainWorkWithMeResult.supersededFacts >= 0, true);
    assert.equal(
      plainFacts.some(
        (fact) =>
          fact.key === "contact.milo.relationship" &&
          fact.value === "work_peer"
      ),
      true
    );
  });
});

test("profile memory store keeps current direct-report aliases current while historical and severed variants fail closed", async () => {
  await withProfileStore(async (store) => {
    const currentDirectReportResult = await store.ingestFromTaskInput(
      "task_profile_governance_named_direct_report_contact",
      "My direct report is Casey.",
      "2026-04-02T15:06:00.000Z"
    );
    const currentFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentDirectReportResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.casey.name" &&
          fact.value === "Casey"
      ),
      true
    );
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.casey.relationship" &&
          fact.value === "employee"
      ),
      true
    );

    const historicalDirectReportResult = await store.ingestFromTaskInput(
      "task_profile_governance_historical_direct_report_contact",
      "Quinn is my former direct report at Northstar Creative.",
      "2026-04-02T15:07:00.000Z"
    );
    const historicalFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(historicalDirectReportResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      historicalFacts.some(
        (fact) =>
          fact.key === "contact.quinn.name" &&
          fact.value === "Quinn"
      ),
      true
    );
    assert.equal(
      historicalFacts.some(
        (fact) =>
          fact.key === "contact.quinn.relationship" &&
          fact.value === "employee"
      ),
      false
    );
    assert.equal(
      historicalFacts.some(
        (fact) =>
          fact.key === "contact.quinn.work_association" &&
          fact.value === "Northstar Creative"
      ),
      false
    );

    const severedDirectReportResult = await store.ingestFromTaskInput(
      "task_profile_governance_severed_direct_report_contact",
      "Taylor is no longer my direct report.",
      "2026-04-02T15:08:00.000Z"
    );
    const severedFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedDirectReportResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedFacts.some(
        (fact) =>
          fact.key === "contact.taylor.name" &&
          fact.value === "Taylor"
      ),
      true
    );
    assert.equal(
      severedFacts.some(
        (fact) =>
          fact.key === "contact.taylor.relationship" &&
          fact.value === "employee"
      ),
      false
    );
  });
});

test("profile memory store keeps works-for-me employee-direction current while historical and severed variants fail closed", async () => {
  await withProfileStore(async (store) => {
    const currentEmployeeLinkResult = await store.ingestFromTaskInput(
      "task_profile_governance_current_employee_link_contact",
      "Owen works for me at Lantern Studio.",
      "2026-04-02T15:09:00.000Z"
    );
    const currentFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentEmployeeLinkResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "employee"
      ),
      true
    );
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.owen.work_association" &&
          fact.value === "Lantern Studio"
      ),
      true
    );

    const historicalEmployeeLinkResult = await store.ingestFromTaskInput(
      "task_profile_governance_historical_employee_link_contact",
      "Quinn used to work for me at Northstar Creative.",
      "2026-04-02T15:10:00.000Z"
    );
    const historicalFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(historicalEmployeeLinkResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      historicalFacts.some(
        (fact) =>
          fact.key === "contact.quinn.name" &&
          fact.value === "Quinn"
      ),
      true
    );
    assert.equal(
      historicalFacts.some(
        (fact) =>
          fact.key === "contact.quinn.relationship" &&
          fact.value === "employee"
      ),
      false
    );
    assert.equal(
      historicalFacts.some(
        (fact) =>
          fact.key === "contact.quinn.work_association" &&
          fact.value === "Northstar Creative"
      ),
      false
    );

    const severedEmployeeLinkResult = await store.ingestFromTaskInput(
      "task_profile_governance_severed_employee_link_contact",
      "Taylor no longer works for me at Northstar Creative.",
      "2026-04-02T15:11:00.000Z"
    );
    const severedFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedEmployeeLinkResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedFacts.some(
        (fact) =>
          fact.key === "contact.taylor.name" &&
          fact.value === "Taylor"
      ),
      true
    );
    assert.equal(
      severedFacts.some(
        (fact) =>
          fact.key === "contact.taylor.relationship" &&
          fact.value === "employee"
      ),
      false
    );
    assert.equal(
      severedFacts.some(
        (fact) =>
          fact.key === "contact.taylor.work_association" &&
          fact.value === "Northstar Creative"
      ),
      false
    );
  });
});

test("profile memory store closes works-with-me work-peer current winners when historical and severed variants arrive", async () => {
  await withProfileStore(async (store) => {
    const currentResult = await store.ingestFromTaskInput(
      "task_profile_governance_current_work_peer_link",
      "Owen works with me at Lantern Studio.",
      "2026-04-02T15:00:00.000Z"
    );
    const currentFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(currentResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "work_peer"
      ),
      true
    );
    assert.equal(
      currentFacts.some(
        (fact) =>
          fact.key === "contact.owen.work_association" &&
          fact.value === "Lantern Studio"
      ),
      true
    );

    const historicalResult = await store.ingestFromTaskInput(
      "task_profile_governance_historical_work_peer_link",
      "Owen worked with me at Lantern Studio.",
      "2026-04-02T15:00:30.000Z"
    );
    const historicalFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(historicalResult, {
      appliedFacts: 1,
      supersededFacts: 2
    });
    assert.equal(
      historicalFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      historicalFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "work_peer"
      ),
      false
    );
    assert.equal(
      historicalFacts.some(
        (fact) =>
          fact.key === "contact.owen.work_association" &&
          fact.value === "Lantern Studio"
      ),
      false
    );

    const severedResult = await store.ingestFromTaskInput(
      "task_profile_governance_severed_work_peer_link",
      "Owen no longer works with me at Lantern Studio.",
      "2026-04-02T15:01:00.000Z"
    );
    const severedFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });

    assert.deepEqual(severedResult, {
      appliedFacts: 1,
      supersededFacts: 0
    });
    assert.equal(
      severedFacts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      severedFacts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "work_peer"
      ),
      false
    );
    assert.equal(
      severedFacts.some(
        (fact) =>
          fact.key === "contact.owen.work_association" &&
          fact.value === "Lantern Studio"
      ),
      false
    );
  });
});

test("profile memory store closes prior current coworker winners and preserves historical recall after successor updates", async () => {
  await withProfileStore(async (store) => {
    const initialResult = await store.ingestFromTaskInput(
      "task_profile_contact_successor_initial",
      "I work with Jordan at Northstar. I used to work with Milo at Lumen Studio.",
      "2026-04-09T10:00:00.000Z"
    );
    const updateResult = await store.ingestFromTaskInput(
      "task_profile_contact_successor_update",
      "I don't work with Jordan anymore. I work with Priya at Northstar now.",
      "2026-04-09T10:05:00.000Z"
    );
    const factsAfterUpdate = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false,
      maxFacts: 50
    });
    const continuityAfterUpdate = await store.queryFactsForContinuity(
      createEmptyEntityGraphV1("2026-04-09T10:05:00.000Z"),
      createEmptyConversationStackV1("2026-04-09T10:05:00.000Z"),
      {
        entityHints: ["Jordan", "Priya", "Milo", "Northstar"],
        semanticMode: "relationship_inventory",
        relevanceScope: "global_profile",
        maxFacts: 10
      }
    );

    assert.deepEqual(initialResult, {
      appliedFacts: 6,
      supersededFacts: 0
    });
    assert.deepEqual(updateResult, {
      appliedFacts: 5,
      supersededFacts: 2
    });
    assert.equal(
      factsAfterUpdate.some(
        (fact) =>
          fact.key === "contact.jordan.relationship" &&
          fact.value === "work_peer"
      ),
      false
    );
    assert.equal(
      factsAfterUpdate.some(
        (fact) =>
          fact.key === "contact.jordan.work_association" &&
          fact.value === "Northstar"
      ),
      false
    );
    assert.equal(
      factsAfterUpdate.some(
        (fact) =>
          fact.key === "contact.priya.work_association" &&
          fact.value === "Northstar"
      ),
      true
    );
    assert.equal(
      factsAfterUpdate.some(
        (fact) =>
          fact.key === "contact.priya.work_association" &&
          fact.value === "Northstar now"
      ),
      false
    );
    assert.deepEqual(continuityAfterUpdate.temporalSynthesis?.currentState, [
      "contact.relationship: work_peer",
      "contact.work_association: Northstar"
    ]);
    assert.deepEqual(continuityAfterUpdate.temporalSynthesis?.historicalContext, [
      "contact.relationship (historical): work_peer",
      "contact.work_association (historical): Northstar"
    ]);
    assert.equal(
      continuityAfterUpdate.temporalSynthesis?.laneMetadata.some(
        (entry) =>
          entry.focusStableRefId === "stable_contact_priya" &&
          entry.family === "contact.relationship" &&
          entry.answerMode === "current"
      ),
      true
    );
    assert.equal(
      continuityAfterUpdate.temporalSynthesis?.laneMetadata.some(
        (entry) =>
          entry.focusStableRefId === "stable_contact_jordan" &&
          entry.family === "contact.relationship" &&
          entry.answerMode === "historical"
      ),
      true
    );

    const hedgedResult = await store.ingestFromTaskInput(
      "task_profile_contact_successor_hedged",
      "I think maybe Jordan still might be there, not sure.",
      "2026-04-09T10:06:00.000Z"
    );
    const continuityAfterHedge = await store.queryFactsForContinuity(
      createEmptyEntityGraphV1("2026-04-09T10:06:00.000Z"),
      createEmptyConversationStackV1("2026-04-09T10:06:00.000Z"),
      {
        entityHints: ["Jordan", "Priya", "Milo", "Northstar"],
        semanticMode: "relationship_inventory",
        relevanceScope: "global_profile",
        maxFacts: 10
      }
    );

    assert.deepEqual(hedgedResult, {
      appliedFacts: 0,
      supersededFacts: 0
    });
    assert.deepEqual(
      continuityAfterHedge.temporalSynthesis,
      continuityAfterUpdate.temporalSynthesis
    );
  });
});

test("profile memory store keeps third-person contact continuity available for current organization plus historical and object follow-ups", async () => {
  await withProfileStore(async (store) => {
    const ingestResult = await store.ingestFromTaskInput(
      "task_profile_contact_billy_continuity",
      "Billy used to be at Beacon. He's at Northstar now. He drives a gray Accord.",
      "2026-04-09T11:00:00.000Z"
    );
    const readableFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false,
      maxFacts: 50
    });
    const continuityFacts = await store.queryFactsForContinuity(
      createEmptyEntityGraphV1("2026-04-09T11:00:00.000Z"),
      createEmptyConversationStackV1("2026-04-09T11:00:00.000Z"),
      {
        entityHints: ["Billy", "Beacon", "Northstar", "Accord"],
        semanticMode: "relationship_inventory",
        relevanceScope: "conversation_local",
        maxFacts: 10
      }
    );

    assert.equal(ingestResult.appliedFacts > 0, true);
    assert.equal(
      readableFacts.some(
        (fact) =>
          fact.key === "contact.billy.name" &&
          fact.value === "Billy"
      ),
      true
    );
    assert.equal(
      readableFacts.some(
        (fact) =>
          fact.key === "contact.billy.work_association" &&
          fact.value === "Northstar"
      ),
      true
    );
    assert.equal(
      readableFacts.some(
        (fact) =>
          fact.key === "contact.billy.work_association" &&
          fact.value === "Beacon"
      ),
      false
    );
    assert.equal(
      continuityFacts.some(
        (fact) =>
          fact.key === "contact.billy.work_association" &&
          fact.value === "Northstar"
      ),
      true
    );
    assert.equal(
      continuityFacts.some(
        (fact) =>
          /^contact\.billy\.context\.[a-f0-9]{8}$/.test(fact.key) &&
          fact.value === "Billy used to be at Beacon"
      ),
      true
    );
    assert.equal(
      continuityFacts.some(
        (fact) =>
          /^contact\.billy\.context\.[a-f0-9]{8}$/.test(fact.key) &&
          fact.value === "Billy drives a gray Accord"
      ),
      true
    );
  });
});

test("profile memory store ingests long-form third-person work updates without flattening current and historical organization state", async () => {
  await withProfileStore(async (store) => {
    const ingestResult = await store.ingestFromTaskInput(
      "task_profile_contact_longform_continuity",
      [
        "Billy used to work at Sample Web Studio as a front-end contractor, but by late February he had started interviewing elsewhere.",
        "Billy is no longer at Sample Web Studio.",
        "Billy has already started at Crimson Analytics, and Garrett still owns Harbor Signal Studio.",
        "Garrett prefers short direct updates.",
        "Billy is still in Ferndale for now, and Garrett is still splitting time between Detroit and Ann Arbor."
      ].join(" "),
      "2026-04-12T18:05:00.000Z"
    );
    const readableFacts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false,
      maxFacts: 50
    });
    const continuityFacts = await store.queryFactsForContinuity(
      createEmptyEntityGraphV1("2026-04-12T18:05:00.000Z"),
      createEmptyConversationStackV1("2026-04-12T18:05:00.000Z"),
      {
        entityHints: ["Billy", "Garrett", "Sample Web Studio", "Crimson Analytics"],
        semanticMode: "relationship_inventory",
        relevanceScope: "conversation_local",
        maxFacts: 20
      }
    );

    assert.equal(ingestResult.appliedFacts > 0, true);
    assert.equal(
      readableFacts.some(
        (fact) =>
          fact.key === "contact.billy.work_association" &&
          fact.value === "Crimson Analytics"
      ),
      true
    );
    assert.equal(
      readableFacts.some(
        (fact) =>
          fact.key === "contact.billy.work_association" &&
          fact.value === "Sample Web Studio"
      ),
      false
    );
    assert.equal(
      continuityFacts.some(
        (fact) =>
          fact.key === "contact.billy.work_association" &&
          fact.value === "Crimson Analytics"
      ),
      true
    );
    assert.equal(
      readableFacts.some(
        (fact) =>
          /^contact\.garrett\.context\.[a-f0-9]{8}$/.test(fact.key) &&
          fact.value === "Garrett still owns Harbor Signal Studio"
      ),
      true
    );
    assert.equal(
      readableFacts.some(
        (fact) =>
          /^contact\.garrett\.context\.[a-f0-9]{8}$/.test(fact.key) &&
          fact.value === "Garrett still owns Harbor Signal Studio"
      ),
      true
    );
    assert.equal(
      readableFacts.some(
        (fact) =>
          /^contact\.garrett\.context\.[a-f0-9]{8}$/.test(fact.key) &&
          fact.value === "Garrett prefers short direct updates"
      ),
      true
    );
    assert.equal(
      readableFacts.some(
        (fact) =>
          /^contact\.billy\.context\.[a-f0-9]{8}$/.test(fact.key) &&
          fact.value === "Billy is still in Ferndale for now"
      ),
      true
    );
    assert.equal(
      readableFacts.some(
        (fact) =>
          /^contact\.garrett\.context\.[a-f0-9]{8}$/.test(fact.key) &&
          fact.value === "Garrett is still splitting time between Detroit and Ann Arbor"
      ),
      true
    );
  });
});

test("planning context is query-aware and surfaces matching contact facts", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_query_1",
      "my favorite editor is Helix and my name is Benny",
      "2026-02-24T00:00:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_query_2",
      "I used to work with Owen at Lantern Studio.",
      "2026-02-24T00:01:00.000Z"
    );

    const planningContext = await store.getPlanningContext(4, "who is Owen?");
    assert.equal(planningContext.includes("contact.owen.name: Owen"), true);
    assert.equal(
      planningContext.includes("contact.owen.work_association: Lantern Studio"),
      false
    );
  });
});

test("profile memory store keeps historical school association out of current flat facts while preserving contact identity", async () => {
  await withProfileStore(async (store) => {
    const ingestResult = await store.ingestFromTaskInput(
      "task_profile_school_association_historical",
      "I went to school with a guy named Owen.",
      "2026-04-03T15:00:00.000Z"
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });
    const planningContext = await store.getPlanningContext(4, "who is Owen?");

    assert.deepEqual(ingestResult, {
      appliedFacts: 3,
      supersededFacts: 0
    });
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "contact.owen.name" &&
          fact.value === "Owen"
      ),
      true
    );
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "contact.owen.relationship" &&
          fact.value === "acquaintance"
      ),
      true
    );
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "contact.owen.school_association" &&
          fact.value === "went_to_school_together"
      ),
      false
    );
    assert.equal(
      planningContext.includes("contact.owen.school_association: went_to_school_together"),
      false
    );
  });
});

test("profile memory store keeps contact entity hints out of current flat and planning surfaces until corroborated", async () => {
  await withProfileStore(async (store) => {
    const ingestResult = await store.ingestFromTaskInput(
      "task_profile_contact_entity_hint_support_only",
      "I know Sarah.",
      "2026-04-03T15:05:00.000Z",
      {
        provenance: {
          conversationId: "conversation_profile_contact_hint_support_only",
          turnId: "turn_profile_contact_hint_support_only",
          dominantLaneAtWrite: "profile",
          sourceSurface: "conversation_profile_input",
          sourceFingerprint: buildProfileMemorySourceFingerprint("I know Sarah.")
        }
      }
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: false,
      explicitHumanApproval: false
    });
    const planningContext = await store.getPlanningContext(4, "who is Sarah?");

    assert.equal(ingestResult.appliedFacts, 1);
    assert.equal(ingestResult.supersededFacts, 0);
    assert.equal(
      facts.some(
        (fact) =>
          fact.key === "contact.sarah.name" &&
          fact.value === "Sarah"
      ),
      false
    );
    assert.equal(
      facts.some(
        (fact) =>
          fact.key.startsWith("contact.sarah.context.") &&
          fact.value === "I know Sarah"
      ),
      true
    );
    assert.ok(ingestResult.mutationEnvelope);
    assert.equal(
      ingestResult.mutationEnvelope?.governanceDecisions.some(
        (decision) =>
          decision.family === "contact.entity_hint" &&
          decision.governanceAction === "support_only_legacy" &&
          decision.appliedWriteRefs.length === 0
      ),
      true
    );
    assert.equal(
      ingestResult.mutationEnvelope?.governanceDecisions.some(
        (decision) =>
          decision.family === "contact.context" &&
          decision.governanceAction === "support_only_legacy" &&
          decision.appliedWriteRefs.length === 1
      ),
      true
    );
    assert.equal(planningContext.includes("contact.sarah.name: Sarah"), false);
    assert.equal(planningContext.includes("I know Sarah"), true);
  });
});

test("episode planning context is query-aware and surfaces matching unresolved situations", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_episode_context_1",
      "Owen fell down three weeks ago and I never told you how it ended.",
      "2026-03-08T10:00:00.000Z"
    );

    const episodePlanningContext = await store.getEpisodePlanningContext(
      2,
      "How is Owen doing after the fall?"
    );

    assert.match(episodePlanningContext, /Owen fell down/);
    assert.match(episodePlanningContext, /status=unresolved/);
  });
});

test("readEpisodes hides sensitive episodes unless explicit approval is present", async () => {
  await withProfileStore(async (store) => {
    const seededState = {
      ...createEmptyProfileMemoryState(),
      episodes: [
        createProfileEpisodeRecord({
          title: "Owen fell down",
          summary: "Owen fell down and the outcome was unresolved.",
          sourceTaskId: "task_profile_store_read_episode_1",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: false,
          observedAt: "2026-03-08T10:00:00.000Z"
        }),
        createProfileEpisodeRecord({
          title: "Private family health situation",
          summary: "A private health situation came up.",
          sourceTaskId: "task_profile_store_read_episode_2",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: true,
          observedAt: "2026-03-08T11:00:00.000Z"
        })
      ]
    };

    await (store as unknown as { save: (state: typeof seededState) => Promise<void> }).save(
      seededState
    );

    const withoutApproval = await store.readEpisodes({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: false
    });
    assert.equal(withoutApproval.length, 1);
    assert.equal(withoutApproval[0]?.title, "Owen fell down");

    const withApproval = await store.readEpisodes({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_episode_read_1"
    });
    assert.equal(withApproval.length, 2);
  });
});

test("queryEpisodesForContinuity returns linked unresolved episodes for re-mentioned entity hints", async () => {
  await withProfileStore(async (store, filePath) => {
    const observedAt = "2026-03-08T10:00:00.000Z";
    const seededState = {
      ...createEmptyProfileMemoryState(),
      episodes: [
        createProfileEpisodeRecord({
          title: "Owen fell down",
          summary: "Owen fell down a few weeks ago and the outcome was unresolved.",
          sourceTaskId: "task_profile_store_query_episode_1",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: false,
          observedAt,
          entityRefs: ["contact.owen"],
          tags: ["followup", "injury"]
        })
      ]
    };

    await saveSeededProfileMemoryState(filePath, Buffer.alloc(32, 7), seededState);

    const graph = applyEntityExtractionToGraph(
      createEmptyEntityGraphV1(observedAt),
      extractEntityCandidates({
        text: "Owen checked in after the fall.",
        observedAt,
        evidenceRef: "trace:store_query_episode_1"
      }),
      observedAt,
      "trace:store_query_episode_1"
    ).graph;
    const seededStack = buildConversationStackFromTurnsV1(
      [
        {
          role: "user",
          text: "Owen fell down a few weeks ago.",
          at: observedAt
        }
      ],
      observedAt
    );
    const stack = upsertOpenLoopOnConversationStackV1({
      stack: seededStack,
      threadKey: seededStack.activeThreadKey!,
      text: "Remind me later to ask how Owen is doing after the fall.",
      observedAt,
      entityRefs: ["Owen"]
    }).stack;

    const matches = await store.queryEpisodesForContinuity(graph, stack, {
      entityHints: ["Owen"]
    });

    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.episode.title, "Owen fell down");
    assert.equal(matches[0]?.entityLinks.length > 0, true);
    assert.equal(matches[0]?.openLoopLinks.length > 0, true);
  });
});

test("profile memory store load preserves persisted episodic-memory state", async () => {
  await withProfileStore(async (store, filePath) => {
    const seededState = {
      ...createEmptyProfileMemoryState(),
      episodes: [
        createProfileEpisodeRecord({
          title: "Owen fall situation",
          summary: "Owen fell down a few weeks ago and the outcome was never mentioned.",
          sourceTaskId: "task_profile_store_episode_1",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: false,
          observedAt: "2026-03-08T10:00:00.000Z",
          entityRefs: ["entity_owen"],
          openLoopRefs: ["loop_owen"],
          tags: ["followup", "injury"]
        })
      ]
    };

    await saveSeededProfileMemoryState(filePath, Buffer.alloc(32, 7), seededState);

    const loaded = await store.load();
    assert.equal(loaded.episodes.length, 1);
    assert.equal(loaded.episodes[0]?.title, "Owen fall situation");
    assert.deepEqual(loaded.episodes[0]?.entityRefs, ["entity_owen"]);
  });
});

test("profile memory store load consolidates duplicate episodic-memory records", async () => {
  await withProfileStore(async (store, filePath) => {
    const seededState = {
      ...createEmptyProfileMemoryState(),
      episodes: [
        createProfileEpisodeRecord({
          title: "Owen fell down",
          summary: "Owen fell down near the stairs.",
          sourceTaskId: "task_profile_store_episode_consolidation_1",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: false,
          observedAt: "2026-03-01T10:00:00.000Z",
          entityRefs: ["contact.owen"],
          openLoopRefs: ["loop_old"],
          tags: ["injury"]
        }),
        createProfileEpisodeRecord({
          title: "Owen fell down",
          summary: "Owen fell down near the stairs and the outcome was unresolved.",
          sourceTaskId: "task_profile_store_episode_consolidation_2",
          source: "test",
          sourceKind: "assistant_inference",
          sensitive: false,
          observedAt: "2026-03-02T10:00:00.000Z",
          entityRefs: ["contact.owen"],
          openLoopRefs: ["loop_new"],
          tags: ["followup", "injury"]
        })
      ]
    };

    await saveSeededProfileMemoryState(filePath, Buffer.alloc(32, 7), seededState);

    const loaded = await store.load();
    assert.equal(loaded.episodes.length, 1);
    assert.match(loaded.episodes[0]?.summary ?? "", /outcome was unresolved/i);
    assert.deepEqual(loaded.episodes[0]?.openLoopRefs, ["loop_new", "loop_old"]);
  });
});

test("ingestFromTaskInput extracts and later resolves bounded episodic-memory situations", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_store_episode_ingest_1",
      "Owen fell down three weeks ago and I never told you how it ended.",
      "2026-03-08T10:00:00.000Z"
    );

    let state = await store.load();
    assert.equal(state.episodes.length, 1);
    assert.equal(state.graph.events.length, 1);
    assert.equal(state.episodes[0]?.title, "Owen fell down");
    assert.equal(state.episodes[0]?.status, "unresolved");
    const eventId = state.graph.events[0]?.payload.eventId;
    assert.ok(eventId);
    assert.equal(state.graph.events[0]?.payload.title, "Owen fell down");
    assert.equal(state.graph.events[0]?.payload.validTo, null);
    assert.equal(
      lastItem(state.graph.mutationJournal.entries)?.eventIds.includes(eventId),
      true
    );

    await store.ingestFromTaskInput(
      "task_profile_store_episode_ingest_2",
      "Owen is doing better now after the fall.",
      "2026-03-08T12:00:00.000Z"
    );

    state = await store.load();
    assert.equal(state.episodes.length, 1);
    assert.equal(state.graph.events.length, 1);
    assert.equal(state.graph.events[0]?.payload.eventId, eventId);
    assert.equal(state.episodes[0]?.status, "resolved");
    assert.equal(state.episodes[0]?.resolvedAt, "2026-03-08T12:00:00.000Z");
    assert.equal(state.graph.events[0]?.payload.validTo, "2026-03-08T12:00:00.000Z");
    assert.equal(
      lastItem(state.graph.mutationJournal.entries)?.eventIds.includes(eventId),
      true
    );
  });
});

test("ingestFromTaskInput persists pending and tentative timeline items as episodic memory", async () => {
  await withProfileStore(async (store) => {
    const result = await store.ingestFromTaskInput(
      "task_profile_store_episode_timeline_ingest_1",
      [
        "The March 27 Docklight launch review is still pending.",
        "Crimson Analytics is considering a case-study page, but that is still tentative and not scheduled.",
        "Billy says he may revisit moving in summer."
      ].join(" "),
      "2026-04-13T08:30:38.000Z"
    );

    assert.equal(result.appliedFacts, 3);

    const state = await store.load();
    assert.equal(state.episodes.length, 3);
    assert.equal(state.graph.events.length, 3);

    const launchReview = state.episodes.find((episode) => episode.title === "Docklight launch review");
    const caseStudy = state.episodes.find((episode) => episode.title === "Crimson Analytics case-study page");
    const move = state.episodes.find((episode) => episode.title === "Billy possible move");

    assert.ok(launchReview);
    assert.equal(launchReview?.status, "unresolved");
    assert.deepEqual(launchReview?.tags, ["followup", "milestone", "pending", "review"]);

    assert.ok(caseStudy);
    assert.equal(caseStudy?.status, "outcome_unknown");
    assert.deepEqual(caseStudy?.entityRefs, ["Crimson Analytics"]);

    assert.ok(move);
    assert.equal(move?.status, "outcome_unknown");
    assert.deepEqual(move?.entityRefs, ["contact.billy"]);
  });
});

test("ingestFromTaskInput uses voice transcripts for durable fact and episode extraction", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_store_media_voice_1",
      [
        "Please fix this before lunch.",
        "",
        "Attached media context:",
        "- Voice note transcript: My name is Benny and Owen fell down last week."
      ].join("\n"),
      "2026-03-08T13:00:00.000Z"
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_profile_media_voice_1",
      maxFacts: 10
    });
    assert.equal(
      facts.some((fact) => fact.key === "identity.preferred_name" && fact.value === "Benny"),
      true
    );

    const episodes = await store.reviewEpisodesForUser(5, "2026-03-08T13:05:00.000Z");
    assert.equal(episodes.some((episode) => episode.title === "Owen fell down"), true);
  });
});

test("ingestFromTaskInput suppresses generic media-only prompts but still accepts interpreted situation summaries", async () => {
  await withProfileStore(async (store) => {
    const genericResult = await store.ingestFromTaskInput(
      "task_profile_store_media_generic_1",
      "Please review the attached image and respond based on what it shows.",
      "2026-03-08T14:00:00.000Z"
    );
    assert.deepEqual(genericResult, {
      appliedFacts: 0,
      supersededFacts: 0
    });

    await store.ingestFromTaskInput(
      "task_profile_store_media_summary_1",
      [
        "You did this wrong.",
        "",
        "Attached media context:",
        "- image summary: Owen fell down near the stairs and the outcome still sounds unresolved.",
        "- OCR text: Owen fell down near the stairs"
      ].join("\n"),
      "2026-03-08T14:10:00.000Z"
    );

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_profile_media_summary_1",
      maxFacts: 10
    });
    assert.equal(facts.some((fact) => fact.key === "identity.preferred_name"), false);

    const episodes = await store.reviewEpisodesForUser(5, "2026-03-08T14:15:00.000Z");
    assert.equal(episodes.some((episode) => episode.title === "Owen fell down"), true);
  });
});

test("fromEnv returns undefined when profile memory is disabled", () => {
  const store = ProfileMemoryStore.fromEnv({});
  assert.equal(store, undefined);
});

test("fromEnv throws when enabled without encryption key", () => {
  assert.throws(
    () =>
      ProfileMemoryStore.fromEnv({
        BRAIN_PROFILE_MEMORY_ENABLED: "true"
      }),
    /BRAIN_PROFILE_ENCRYPTION_KEY/
  );
});

test("fromEnv initializes store when enabled with valid key", () => {
  const key = Buffer.alloc(32, 9).toString("base64");
  const store = ProfileMemoryStore.fromEnv({
    BRAIN_PROFILE_MEMORY_ENABLED: "true",
    BRAIN_PROFILE_ENCRYPTION_KEY: key
  });
  assert.ok(store);
});

test("evaluateAgentPulse allows stale-fact revalidation when stale facts exist", async () => {
  await withProfileStore(async (store, filePath) => {
    let seededState = createEmptyProfileMemoryState();
    seededState = upsertTemporalProfileFact(seededState, {
      key: "favorite.editor",
      value: "vscode",
      sensitive: false,
      sourceTaskId: "task_profile_stale_1",
      source: "user_input_pattern.my_is",
      observedAt: "2025-01-10T00:00:00.000Z",
      confidence: 0.95
    }).nextState;
    await saveSeededProfileMemoryState(filePath, Buffer.alloc(32, 7), seededState);

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 60
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "stale_fact_revalidation",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(evaluation.staleFactCount > 0, true);
    assert.equal(evaluation.decision.allowed, true);
    assert.equal(evaluation.decision.decisionCode, "ALLOWED");
  });
});

test("ingestFromTaskInput accepts validated identity candidates without requiring discourse-heavy raw extraction", async () => {
  await withProfileStore(async (store) => {
    const result = await store.ingestFromTaskInput(
      "task_profile_store_validated_identity_1",
      "I already told you my name is Avery several times.",
      "2026-03-21T12:00:00.000Z",
      {
        validatedFactCandidates: [
          {
            key: "identity.preferred_name",
            candidateValue: "Avery",
            source: "conversation.identity_interpretation",
            confidence: 0.95
          }
        ]
      }
    );

    assert.equal(result.appliedFacts, 1);

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "approval_profile_validated_identity_1",
      maxFacts: 10
    });
    assert.equal(
      facts.some((fact) => fact.key === "identity.preferred_name" && fact.value === "Avery"),
      true
    );
  });
});

test("ingestFromTaskInput dual-writes validated candidates into compatibility facts and graph-backed claim truth", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_store_validated_identity_dual_write",
      "I already told you my name is Avery several times.",
      "2026-04-08T20:00:00.000Z",
      {
        validatedFactCandidates: [
          {
            key: "identity.preferred_name",
            candidateValue: "Avery",
            source: "conversation.identity_interpretation",
            confidence: 0.95
          }
        ]
      }
    );

    const state = await store.load();
    const graphObservation = state.graph.observations[0];
    const graphClaim = state.graph.claims[0];

    assert.equal(
      state.facts.some((fact) => fact.key === "identity.preferred_name" && fact.value === "Avery"),
      true
    );
    assert.equal(state.graph.observations.length, 1);
    assert.equal(state.graph.claims.length, 1);
    assert.equal(graphObservation?.payload.sourceTier, "validated_structured_candidate");
    assert.equal(graphClaim?.payload.family, "identity.preferred_name");
    assert.equal(graphClaim?.payload.normalizedValue, "Avery");
    assert.equal(graphClaim?.payload.sourceTier, "validated_structured_candidate");
    assert.deepEqual(
      graphClaim?.payload.derivedFromObservationIds,
      [graphObservation!.payload.observationId]
    );
    assert.equal(
      state.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
      graphClaim?.payload.claimId
    );
  });
});

test("ingestFromTaskInput emits current-surface org and place claims for continuity synchronization", async () => {
  let latestResolvedClaims: readonly ProfileMemoryGraphClaimRecord[] | null = null;

  await withProfileStore(
    async (store) => {
      await store.ingestFromTaskInput(
        "task_profile_store_continuity_sync_contact_associations",
        [
          "Billy used to work at Sample Web Studio as a front-end contractor, but he is no longer there.",
          "Billy has already started at Crimson Analytics.",
          "Billy is still in Ferndale for now.",
          "Garrett still owns Harbor Signal Studio.",
          "Garrett is still splitting time between Detroit and Ann Arbor."
        ].join(" "),
        "2026-04-12T21:30:00.000Z"
      );

      const state = await store.load();
      assert.equal(
        state.graph.claims.some(
          (claim) =>
            claim.payload.normalizedKey === "contact.garrett.organization_association" &&
            claim.payload.normalizedValue === "Harbor Signal Studio"
        ),
        true
      );
      assert.equal(
        state.graph.claims.some(
          (claim) =>
            claim.payload.normalizedKey === "contact.billy.location_association" &&
            claim.payload.normalizedValue === "Ferndale"
        ),
        true
      );
      assert.equal(
        state.graph.claims.some(
          (claim) =>
            claim.payload.normalizedKey === "contact.garrett.primary_location_association" &&
            claim.payload.normalizedValue === "Detroit"
        ),
        true
      );
      assert.equal(
        state.graph.claims.some(
          (claim) =>
            claim.payload.normalizedKey === "contact.garrett.secondary_location_association" &&
            claim.payload.normalizedValue === "Ann Arbor"
        ),
        true
      );
    },
    {
      onCurrentSurfaceGraphClaimsChanged: async (claims) => {
        latestResolvedClaims = claims;
      }
    }
  );

  assert.ok(latestResolvedClaims);
  const resolvedClaims = latestResolvedClaims as unknown as readonly ProfileMemoryGraphClaimRecord[];
  assert.equal(
    resolvedClaims.some(
      (claim) =>
        claim.payload.normalizedKey === "contact.billy.work_association" &&
        claim.payload.normalizedValue === "Crimson Analytics"
    ),
    true
  );
  assert.equal(
    resolvedClaims.some(
      (claim) =>
        claim.payload.normalizedKey === "contact.garrett.organization_association" &&
        claim.payload.normalizedValue === "Harbor Signal Studio"
    ),
    true
  );
  assert.equal(
    resolvedClaims.some(
      (claim) =>
        claim.payload.normalizedKey === "contact.billy.location_association" &&
        claim.payload.normalizedValue === "Ferndale"
    ),
    true
  );
  assert.equal(
    resolvedClaims.some(
      (claim) =>
        claim.payload.normalizedKey === "contact.garrett.primary_location_association" &&
        claim.payload.normalizedValue === "Detroit"
    ),
    true
  );
  assert.equal(
    resolvedClaims.some(
      (claim) =>
        claim.payload.normalizedKey === "contact.garrett.secondary_location_association" &&
        claim.payload.normalizedValue === "Ann Arbor"
    ),
    true
  );
});

test("ingestFromTaskInput persists stable refs and keeps provisional contact truth out of resolved_current outputs", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_store_stable_ref_self",
      "My name is Avery.",
      "2026-04-09T15:00:00.000Z",
      {
        validatedFactCandidates: [
          {
            key: "identity.preferred_name",
            candidateValue: "Avery",
            source: "conversation.identity_interpretation",
            confidence: 0.95
          }
        ]
      }
    );
    await store.ingestFromTaskInput(
      "task_profile_store_stable_ref_contact",
      "Owen is my friend.",
      "2026-04-09T15:05:00.000Z",
      {
        additionalEpisodeCandidates: [
          {
            title: "Owen follow-up",
            summary: "Owen still owes the form.",
            sourceTaskId: "task_profile_store_stable_ref_contact",
            source: "user_input_pattern.episode_candidate",
            sourceKind: "explicit_user_statement",
            sensitive: false,
            observedAt: "2026-04-09T15:05:00.000Z",
            entityRefs: ["contact.owen"]
          }
        ]
      }
    );

    const state = await store.load();
    const selfClaim = state.graph.claims.find(
      (claim) => claim.payload.normalizedKey === "identity.preferred_name"
    );
    const contactClaim = state.graph.claims.find(
      (claim) => claim.payload.normalizedKey === "contact.owen.relationship"
    );
    const contactEvent = state.graph.events.find(
      (event) => event.payload.entityRefIds.includes("contact.owen")
    );

    assert.equal(selfClaim?.payload.stableRefId, "stable_self_profile_owner");
    assert.equal(contactClaim?.payload.stableRefId, "stable_contact_owen");
    assert.equal(contactEvent?.payload.stableRefId, "stable_contact_owen");

    const groups = await store.queryGraphStableRefGroups();
    const selfGroup = groups.find(
      (group) => group.stableRefId === "stable_self_profile_owner"
    );
    const contactGroup = groups.find(
      (group) => group.stableRefId === "stable_contact_owen"
    );
    const resolvedCurrentClaims = await store.queryResolvedCurrentGraphClaims();

    assert.equal(selfGroup?.claimIds.includes(selfClaim?.payload.claimId ?? ""), true);
    assert.equal(
      contactGroup?.claimIds.includes(contactClaim?.payload.claimId ?? ""),
      true
    );
    assert.equal(
      contactGroup?.eventIds.includes(contactEvent?.payload.eventId ?? ""),
      true
    );
    assert.deepEqual(
      resolvedCurrentClaims.map((claim) => claim.payload.claimId),
      selfClaim ? [selfClaim.payload.claimId] : []
    );
  });
});

test("queryResolvedCurrentGraphClaims excludes quarantined stable refs after encrypted load", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const seededState = {
      ...createEmptyProfileMemoryState(),
      graph: {
        ...createEmptyProfileMemoryState().graph,
        observations: [],
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_store_stable_ref_self",
            stableRefId: "stable_self_profile_owner",
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_store_stable_ref_self",
            sourceFingerprint: "fingerprint_profile_store_stable_ref_self",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-09T16:00:00.000Z",
            validFrom: "2026-04-09T16:00:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_store_stable_ref_self"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_store_stable_ref_quarantine",
            stableRefId: "stable_quarantine_contact_owen",
            family: "contact.relationship.current",
            normalizedKey: "contact.owen.relationship",
            normalizedValue: "friend",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_store_stable_ref_quarantine",
            sourceFingerprint: "fingerprint_profile_store_stable_ref_quarantine",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-09T16:05:00.000Z",
            validFrom: "2026-04-09T16:05:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_store_stable_ref_quarantine"],
            entityRefIds: [],
            active: true
          })
        ],
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_store_stable_ref_quarantine",
            stableRefId: "stable_quarantine_contact_owen",
            family: "episode.candidate",
            title: "Owen ambiguity",
            summary: "Owen stays quarantined pending later alignment.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_store_event_stable_ref_quarantine",
            sourceFingerprint: "fingerprint_profile_store_event_stable_ref_quarantine",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-09T16:05:00.000Z",
            observedAt: "2026-04-09T16:05:00.000Z",
            validFrom: "2026-04-09T16:05:00.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["episode_profile_store_stable_ref_quarantine"],
            entityRefIds: ["contact.owen"]
          })
        ]
      }
    };

    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const groups = await store.queryGraphStableRefGroups();
    const quarantinedGroup = groups.find(
      (group) => group.stableRefId === "stable_quarantine_contact_owen"
    );
    const resolvedCurrentClaims = await store.queryResolvedCurrentGraphClaims();

    assert.equal(quarantinedGroup?.resolution, "quarantined");
    assert.deepEqual(quarantinedGroup?.claimIds, ["claim_profile_store_stable_ref_quarantine"]);
    assert.deepEqual(quarantinedGroup?.eventIds, ["event_profile_store_stable_ref_quarantine"]);
    assert.deepEqual(
      resolvedCurrentClaims.map((claim) => claim.payload.claimId),
      ["claim_profile_store_stable_ref_self"]
    );
  });
});

test("queryAlignedGraphStableRefGroups attaches bounded Stage 6.86 entity keys without promoting provisional truth", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const seededState = {
      ...createEmptyProfileMemoryState(),
      graph: {
        ...createEmptyProfileMemoryState().graph,
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_store_aligned_stable_ref",
            stableRefId: "stable_contact_owen",
            family: "contact.relationship.current",
            normalizedKey: "contact.owen.relationship",
            normalizedValue: "friend",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_store_aligned_stable_ref",
            sourceFingerprint: "fingerprint_profile_store_aligned_stable_ref",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-09T16:15:00.000Z",
            validFrom: "2026-04-09T16:15:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_store_aligned_stable_ref"],
            entityRefIds: ["contact.owen"],
            active: true
          })
        ]
      }
    };
    const entityKey = buildEntityKey("William Bena", "person", null);
    const entityGraph = {
      ...createEmptyEntityGraphV1("2026-04-09T16:15:00.000Z"),
      entities: [
        {
          entityKey,
          canonicalName: "William Bena",
          entityType: "person" as const,
          disambiguator: null,
          domainHint: null,
          aliases: ["Owen"],
          firstSeenAt: "2026-04-09T16:15:00.000Z",
          lastSeenAt: "2026-04-09T16:15:00.000Z",
          salience: 1,
          evidenceRefs: ["trace:profile_store_aligned_stable_ref"]
        }
      ]
    };

    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const groups = await store.queryAlignedGraphStableRefGroups(entityGraph);
    const alignedGroup = groups.find((group) => group.stableRefId === "stable_contact_owen");
    const resolvedCurrentClaims = await store.queryResolvedCurrentGraphClaims();

    assert.equal(alignedGroup?.resolution, "provisional");
    assert.equal(alignedGroup?.primaryEntityKey, entityKey);
    assert.equal(alignedGroup?.observedEntityKey, entityKey);
    assert.deepEqual(
      resolvedCurrentClaims.map((claim) => claim.payload.claimId),
      []
    );
  });
});

test("queryAlignedGraphStableRefGroups keeps quarantined stable refs available for ambiguity surfaces while excluding them from resolved_current", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const seededState = {
      ...createEmptyProfileMemoryState(),
      graph: {
        ...createEmptyProfileMemoryState().graph,
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_store_aligned_quarantine",
            stableRefId: "stable_quarantine_contact_owen",
            family: "contact.relationship.current",
            normalizedKey: "contact.owen.relationship",
            normalizedValue: "friend",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_store_aligned_quarantine",
            sourceFingerprint: "fingerprint_profile_store_aligned_quarantine_claim",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-09T16:20:00.000Z",
            validFrom: "2026-04-09T16:20:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_store_aligned_quarantine"],
            entityRefIds: ["contact.owen"],
            active: true
          })
        ],
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_store_aligned_quarantine",
            stableRefId: "stable_quarantine_contact_owen",
            family: "episode.candidate",
            title: "Owen ambiguity",
            summary: "Owen may match a Stage 6.86 entity but stays quarantined.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_store_aligned_quarantine_event",
            sourceFingerprint: "fingerprint_profile_store_aligned_quarantine_event",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-09T16:20:00.000Z",
            observedAt: "2026-04-09T16:20:00.000Z",
            validFrom: "2026-04-09T16:20:00.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["episode_profile_store_aligned_quarantine"],
            entityRefIds: ["contact.owen"]
          })
        ]
      }
    };
    const entityKey = buildEntityKey("Owen", "person", null);
    const entityGraph = {
      ...createEmptyEntityGraphV1("2026-04-09T16:20:00.000Z"),
      entities: [
        {
          entityKey,
          canonicalName: "Owen",
          entityType: "person" as const,
          disambiguator: null,
          domainHint: null,
          aliases: ["Owen"],
          firstSeenAt: "2026-04-09T16:20:00.000Z",
          lastSeenAt: "2026-04-09T16:20:00.000Z",
          salience: 1,
          evidenceRefs: ["trace:profile_store_aligned_quarantine"]
        }
      ]
    };

    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const groups = await store.queryAlignedGraphStableRefGroups(entityGraph);
    const quarantinedGroup = groups.find(
      (group) => group.stableRefId === "stable_quarantine_contact_owen"
    );
    const resolvedCurrentClaims = await store.queryResolvedCurrentGraphClaims();

    assert.equal(quarantinedGroup?.resolution, "quarantined");
    assert.equal(quarantinedGroup?.primaryEntityKey, null);
    assert.equal(quarantinedGroup?.observedEntityKey, entityKey);
    assert.deepEqual(quarantinedGroup?.claimIds, [
      "claim_profile_store_aligned_quarantine"
    ]);
    assert.deepEqual(
      resolvedCurrentClaims.map((claim) => claim.payload.claimId),
      []
    );
  });
});

test("rekeyGraphStableRef deterministically rewrites one provisional stable-ref lane without Stage 6.86 merge", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const seededState = {
      ...createEmptyProfileMemoryState(),
      graph: {
        ...createEmptyProfileMemoryState().graph,
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_store_stable_ref_rekey",
            stableRefId: "stable_contact_owen",
            family: "contact.name",
            normalizedKey: "contact.owen.name",
            normalizedValue: "Owen",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_store_stable_ref_rekey",
            sourceFingerprint: "fingerprint_profile_store_stable_ref_rekey_observation",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-09T16:30:00.000Z",
            observedAt: "2026-04-09T16:30:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: ["contact.owen"]
          })
        ],
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_store_stable_ref_self_for_rekey",
            stableRefId: "stable_self_profile_owner",
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_store_stable_ref_self_for_rekey",
            sourceFingerprint: "fingerprint_profile_store_stable_ref_self_for_rekey",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-09T16:29:00.000Z",
            validFrom: "2026-04-09T16:29:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_store_stable_ref_self_for_rekey"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_store_stable_ref_rekey",
            stableRefId: "stable_contact_owen",
            family: "contact.relationship.current",
            normalizedKey: "contact.owen.relationship",
            normalizedValue: "friend",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_store_stable_ref_rekey",
            sourceFingerprint: "fingerprint_profile_store_stable_ref_rekey_claim",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-09T16:30:00.000Z",
            validFrom: "2026-04-09T16:30:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_store_stable_ref_rekey"],
            projectionSourceIds: ["fact_profile_store_stable_ref_rekey"],
            entityRefIds: ["contact.owen"],
            active: true
          })
        ],
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_store_stable_ref_rekey",
            stableRefId: "stable_contact_owen",
            family: "episode.candidate",
            title: "Owen follow-up",
            summary: "Owen still owes the form.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_store_event_stable_ref_rekey",
            sourceFingerprint: "fingerprint_profile_store_event_stable_ref_rekey",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-09T16:30:00.000Z",
            observedAt: "2026-04-09T16:30:00.000Z",
            validFrom: "2026-04-09T16:30:00.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["episode_profile_store_stable_ref_rekey"],
            entityRefIds: ["contact.owen"]
          })
        ]
      }
    };

    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const result = await store.rekeyGraphStableRef(
      "stable_contact_owen",
      "stable_contact_owen_primary",
      "task_profile_store_stable_ref_rekey_apply",
      "Rekey Owen's provisional stable ref inside personal memory.",
      "2026-04-09T16:35:00.000Z"
    );
    const state = await store.load();
    const groups = await store.queryGraphStableRefGroups();
    const resolvedCurrentClaims = await store.queryResolvedCurrentGraphClaims();

    const rekeyedObservation = state.graph.observations.find(
      (observation) =>
        observation.payload.observationId === "observation_profile_store_stable_ref_rekey"
    );
    const rekeyedClaim = state.graph.claims.find(
      (claim) => claim.payload.claimId === "claim_profile_store_stable_ref_rekey"
    );
    const rekeyedEvent = state.graph.events.find(
      (event) => event.payload.eventId === "event_profile_store_stable_ref_rekey"
    );
    const rekeyedGroup = groups.find(
      (group) => group.stableRefId === "stable_contact_owen_primary"
    );

    assert.equal(result.changed, true);
    assert.equal(result.mutationEnvelope?.action, "stable_ref_rekey");
    assert.equal(rekeyedObservation?.payload.stableRefId, "stable_contact_owen_primary");
    assert.equal(rekeyedClaim?.payload.stableRefId, "stable_contact_owen_primary");
    assert.equal(rekeyedEvent?.payload.stableRefId, "stable_contact_owen_primary");
    assert.equal(
      groups.some((group) => group.stableRefId === "stable_contact_owen"),
      false
    );
    assert.equal(rekeyedGroup?.resolution, "provisional");
    assert.deepEqual(rekeyedGroup?.observationIds, ["observation_profile_store_stable_ref_rekey"]);
    assert.deepEqual(rekeyedGroup?.claimIds, ["claim_profile_store_stable_ref_rekey"]);
    assert.deepEqual(rekeyedGroup?.eventIds, ["event_profile_store_stable_ref_rekey"]);
    assert.deepEqual(
      resolvedCurrentClaims.map((claim) => claim.payload.claimId),
      ["claim_profile_store_stable_ref_self_for_rekey"]
    );
    assert.equal(state.graph.decisionRecords?.length, 1);
    assert.equal(state.graph.decisionRecords?.[0]?.action, "rekey");
    assert.equal(
      state.graph.decisionRecords?.[0]?.fromStableRefId,
      "stable_contact_owen"
    );
    assert.equal(
      state.graph.decisionRecords?.[0]?.toStableRefId,
      "stable_contact_owen_primary"
    );
    assert.equal(
      state.graph.decisionRecords?.[0]?.mutationEnvelopeHash,
      sha256HexFromCanonicalJson(result.mutationEnvelope)
    );
    assert.deepEqual(
      state.graph.decisionRecords?.[0]?.observationIds,
      ["observation_profile_store_stable_ref_rekey"]
    );
    assert.deepEqual(
      state.graph.decisionRecords?.[0]?.claimIds,
      ["claim_profile_store_stable_ref_rekey"]
    );
    assert.deepEqual(
      state.graph.decisionRecords?.[0]?.eventIds,
      ["event_profile_store_stable_ref_rekey"]
    );
    assert.equal(lastItem(state.graph.mutationJournal.entries)?.sourceTaskId, "task_profile_store_stable_ref_rekey_apply");
    assert.equal(
      lastItem(state.graph.mutationJournal.entries)?.mutationEnvelopeHash,
      sha256HexFromCanonicalJson(result.mutationEnvelope)
    );
  });
});

test("ingestFromTaskInput merges same-value refreshes into one current claim while preserving support observations", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_store_same_value_refresh_1",
      "My name is Avery.",
      "2026-04-08T20:10:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_store_same_value_refresh_2",
      "My name is Avery.",
      "2026-04-08T20:11:00.000Z"
    );

    const state = await store.load();
    const activeClaims = state.graph.claims.filter((claim) => claim.payload.active);

    assert.equal(activeClaims.length, 1);
    assert.equal(activeClaims[0]?.payload.normalizedValue, "Avery");
    assert.equal(state.graph.observations.length, 2);
    assert.equal(
      activeClaims[0]?.payload.derivedFromObservationIds.length,
      2
    );
    assert.equal(
      state.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
      activeClaims[0]?.payload.claimId
    );
  });
});

test("ingestFromTaskInput closes prior singular-family claims with explicit successor linkage on value changes", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_store_successor_refresh_1",
      "My name is Avery.",
      "2026-04-08T20:20:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_store_successor_refresh_2",
      "My name is Ava.",
      "2026-04-08T20:21:00.000Z"
    );

    const state = await store.load();
    const activeClaim = state.graph.claims.find((claim) => claim.payload.active);
    const closedClaim = state.graph.claims.find((claim) => !claim.payload.active);

    assert.equal(state.graph.claims.length, 2);
    assert.equal(activeClaim?.payload.normalizedValue, "Ava");
    assert.equal(closedClaim?.payload.normalizedValue, "Avery");
    assert.equal(closedClaim?.payload.endedByClaimId, activeClaim?.payload.claimId ?? null);
    assert.equal(closedClaim?.payload.validTo, "2026-04-08T20:21:00.000Z");
    assert.equal(
      state.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
      activeClaim?.payload.claimId
    );
  });
});

test("ingestFromTaskInput stays idempotent across retry provenance and does not duplicate graph writes", async () => {
  await withProfileStore(async (store) => {
    const provenance = {
      turnId: "turn_profile_store_retry_idempotent_1",
      sourceSurface: "conversation_profile_input" as const,
      sourceFingerprint: "fingerprint_profile_store_retry_idempotent_1"
    };

    const first = await store.ingestFromTaskInput(
      "task_profile_store_retry_idempotent_1",
      "My name is Avery.",
      "2026-04-08T20:30:00.000Z",
      { provenance }
    );
    const second = await store.ingestFromTaskInput(
      "task_profile_store_retry_idempotent_1_retry",
      "My name is Avery.",
      "2026-04-08T20:30:00.000Z",
      { provenance }
    );

    const state = await store.load();

    assert.equal(first.appliedFacts, 1);
    assert.equal(second.appliedFacts, 0);
    assert.equal(second.supersededFacts, 0);
    assert.equal(state.ingestReceipts.length, 1);
    assert.ok(findProfileMemoryIngestReceipt(state, provenance));
    assert.equal(state.graph.observations.length, 1);
    assert.equal(state.graph.claims.length, 1);
    assert.equal(state.graph.mutationJournal.entries.length, 1);
  });
});

test("evaluateAgentPulse suppresses stale-fact revalidation for workflow-dominant sessions", async () => {
  await withProfileStore(async (store, filePath) => {
    let seededState = createEmptyProfileMemoryState();
    seededState = upsertTemporalProfileFact(seededState, {
      key: "favorite.editor",
      value: "vscode",
      sensitive: false,
      sourceTaskId: "task_profile_stale_workflow_1",
      source: "user_input_pattern.my_is",
      observedAt: "2025-01-10T00:00:00.000Z",
      confidence: 0.95
    }).nextState;
    await saveSeededProfileMemoryState(filePath, Buffer.alloc(32, 7), seededState);

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "stale_fact_revalidation",
        lastPulseSentAtIso: null,
        sessionDominantLane: "workflow",
        sessionHasActiveWorkflowContinuity: true,
        overrideQuietHours: true
      }
    );

    assert.equal(evaluation.staleFactCount > 0, true);
    assert.equal(evaluation.decision.allowed, false);
    assert.equal(evaluation.decision.decisionCode, "SESSION_DOMAIN_SUPPRESSED");
  });
});

test("evaluateAgentPulse exposes bounded fresh unresolved situations for pulse grounding", async () => {
  await withProfileStore(async (store, filePath) => {
    const seededState = {
      ...createEmptyProfileMemoryState(),
      episodes: [
        createProfileEpisodeRecord({
          title: "Owen finished rehab",
          summary: "Owen finished rehab and fully recovered.",
          sourceTaskId: "task_profile_store_pulse_episode_1",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: false,
          observedAt: "2026-03-05T10:00:00.000Z",
          lastMentionedAt: "2026-03-05T10:00:00.000Z",
          status: "resolved",
          resolvedAt: "2026-03-05T12:00:00.000Z",
          entityRefs: ["contact.owen"]
        }),
        createProfileEpisodeRecord({
          title: "Owen fell down",
          summary: "Owen fell down and the outcome is unresolved.",
          sourceTaskId: "task_profile_store_pulse_episode_2",
          source: "test",
          sourceKind: "explicit_user_statement",
          sensitive: false,
          observedAt: "2026-03-07T10:00:00.000Z",
          lastMentionedAt: "2026-03-07T10:00:00.000Z",
          entityRefs: ["contact.owen"]
        })
      ]
    };

    await saveSeededProfileMemoryState(filePath, Buffer.alloc(32, 7), seededState);

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-03-08T10:00:00.000Z",
        userOptIn: true,
        reason: "contextual_followup",
        contextualLinkageConfidence: 0.9,
        lastPulseSentAtIso: null,
        overrideQuietHours: true
      }
    );

    assert.equal(evaluation.decision.allowed, true);
    assert.deepEqual(
      evaluation.relevantEpisodes.map((episode) => episode.title),
      ["Owen fell down"]
    );
  });
});

test("evaluateAgentPulse blocks stale-fact reason when no stale facts exist", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_stale_2",
      "my favorite editor is vscode",
      "2026-02-23T12:00:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 60
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "stale_fact_revalidation",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(evaluation.staleFactCount, 0);
    assert.equal(evaluation.decision.allowed, false);
    assert.equal(evaluation.decision.decisionCode, "NO_STALE_FACTS");
  });
});

test("evaluateAgentPulse applies unresolved-commitment signal and deterministic rate limit", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_commitment_1",
      "my todo item is finish taxes",
      "2026-02-23T10:00:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 60
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: "2026-02-23T14:20:00.000Z"
      }
    );

    assert.equal(evaluation.unresolvedCommitmentCount, 1);
    assert.equal(evaluation.decision.allowed, false);
    assert.equal(evaluation.decision.decisionCode, "RATE_LIMIT");
    assert.equal(evaluation.decision.nextEligibleAtIso, "2026-02-23T15:20:00.000Z");
  });
});

test("evaluateAgentPulse treats noisy follow-up keys as unresolved commitments", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_commitment_noisy_key",
      "my followup'sda tax filing is pending.",
      "2026-02-23T10:00:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(evaluation.unresolvedCommitmentCount > 0, true);
    assert.equal(evaluation.decision.allowed, true);
    assert.equal(evaluation.decision.decisionCode, "ALLOWED");
  });
});

test("evaluateAgentPulse exposes unresolved commitment topics for prompt grounding", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_commitment_topics",
      "my followup.tax filing is pending.",
      "2026-02-23T10:00:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(evaluation.unresolvedCommitmentCount, 1);
    assert.equal(evaluation.unresolvedCommitmentTopics.includes("tax filing"), true);
  });
});

test("ingest resolves unresolved follow-up when completion update references same topic", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_commitment_topic_resolve_1",
      "my followup.tax filing is pending.",
      "2026-02-25T02:03:42.097Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_commitment_topic_resolve_2",
      "my tax filing is complete, I dont need help",
      "2026-02-25T02:04:24.081Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-02-25T03:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null,
        overrideQuietHours: true
      }
    );

    assert.equal(evaluation.unresolvedCommitmentCount, 0);
    assert.deepEqual(evaluation.unresolvedCommitmentTopics, []);

    const state = await store.load();
    const resolvedFollowup = state.facts
      .filter((fact) => fact.status !== "superseded")
      .find((fact) => fact.key === "followup.tax.filing");
    assert.ok(resolvedFollowup);
    assert.equal(resolvedFollowup?.value, "resolved");
    assert.ok(resolvedFollowup?.mutationAudit);
    assert.equal(
      resolvedFollowup?.mutationAudit?.rulepackVersion,
      "CommitmentSignalRulepackV1"
    );
    assert.equal(
      resolvedFollowup?.mutationAudit?.matchedRuleId ===
        "commitment_signal_v1_user_input_topic_resolution_candidate" ||
      resolvedFollowup?.mutationAudit?.matchedRuleId ===
        "commitment_signal_v1_user_input_generic_resolution",
      true
    );
    assert.equal(resolvedFollowup?.mutationAudit?.confidenceTier, "HIGH");
    assert.equal(resolvedFollowup?.mutationAudit?.conflict, false);
  });
});

test("ingest keeps unresolved follow-up when commitment text contains conflicting resolution and unresolved signals", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_conflict_1",
      "my followup.tax filing is pending.",
      "2026-02-25T02:03:42.097Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_conflict_2",
      "my tax filing is complete but still pending",
      "2026-02-25T02:04:24.081Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-02-25T03:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null,
        overrideQuietHours: true
      }
    );

    assert.equal(evaluation.unresolvedCommitmentCount, 1);
    assert.equal(evaluation.unresolvedCommitmentTopics.includes("tax filing"), true);
  });
});

test("load reconciles contradictory completion facts and unresolved follow-up facts", async () => {
  await withProfileStore(async (store) => {
    let seededState = createEmptyProfileMemoryState();
    seededState = upsertTemporalProfileFact(seededState, {
      key: "followup.tax.filing",
      value: "pending",
      sensitive: false,
      sourceTaskId: "seed_followup_pending",
      source: "user_input_pattern.my_is",
      observedAt: "2026-02-25T02:03:42.097Z",
      confidence: 0.95
    }).nextState;
    seededState = upsertTemporalProfileFact(seededState, {
      key: "tax.filing",
      value: "complete",
      sensitive: false,
      sourceTaskId: "seed_topic_complete",
      source: "user_input_pattern.my_is",
      observedAt: "2026-02-25T02:04:24.081Z",
      confidence: 0.95
    }).nextState;

    await (store as unknown as { save: (state: typeof seededState) => Promise<void> }).save(
      seededState
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 0
      },
      {
        nowIso: "2026-02-25T03:10:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null,
        overrideQuietHours: true
      }
    );
    assert.equal(evaluation.unresolvedCommitmentCount, 0);

    const facts = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: true,
      approvalId: "test_approval",
      maxFacts: 20
    });
    const followupTax = facts.find((fact) => fact.key === "followup.tax.filing");
    assert.ok(followupTax);
    assert.equal(followupTax?.value, "resolved");

    const state = await store.load();
    const resolvedFollowup = state.facts
      .filter((fact) => fact.status !== "superseded")
      .find((fact) => fact.key === "followup.tax.filing");
    assert.ok(resolvedFollowup?.mutationAudit);
    assert.equal(
      resolvedFollowup?.mutationAudit?.matchedRuleId,
      "commitment_signal_v1_fact_value_resolved_marker"
    );
    assert.equal(
      resolvedFollowup?.mutationAudit?.rulepackVersion,
      "CommitmentSignalRulepackV1"
    );
  });
});

test("evaluateAgentPulse blocks check-ins during quiet hours unless overridden", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_commitment_2",
      "my todo item is finish taxes",
      "2026-02-23T10:00:00.000Z"
    );

    const blocked = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 10
      },
      {
        nowIso: "2026-02-23T23:30:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(blocked.decision.allowed, false);
    assert.equal(blocked.decision.decisionCode, "QUIET_HOURS");

    const overridden = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 10
      },
      {
        nowIso: "2026-02-23T23:30:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null,
        overrideQuietHours: true
      }
    );

    assert.equal(overridden.decision.allowed, true);
    assert.equal(overridden.decision.decisionCode, "ALLOWED");
  });
});

test("reviewEpisodesForUser and explicit user episode updates remain bounded and deterministic", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_store_user_review_1",
      "Owen fell down three weeks ago and I never told you how it ended.",
      "2026-03-08T10:00:00.000Z"
    );

    const reviewed = await store.reviewEpisodesForUser(
      5,
      "2026-03-08T10:05:00.000Z"
    );
    assert.equal(reviewed.length, 1);
    assert.equal(reviewed[0]?.status, "unresolved");

    const resolved = await store.updateEpisodeFromUser(
      reviewed[0]!.episodeId,
      "resolved",
      "memory_resolve_1",
      "/memory resolve episode",
      "Owen recovered and is fine now.",
      "2026-03-08T11:00:00.000Z"
    );
    assert.equal(resolved.episode?.status, "resolved");
    assert.equal(resolved.episode?.resolvedAt, "2026-03-08T11:00:00.000Z");
    assert.ok(resolved.mutationEnvelope);
    assert.equal(
      resolved.mutationEnvelope?.governanceDecisions[0]?.governanceReason,
      "memory_review_resolution"
    );
    assert.equal(resolved.mutationEnvelope?.retraction, undefined);
    let graphState = await store.load();
    assert.equal(graphState.graph.events.length, 1);
    assert.equal(graphState.graph.events[0]?.payload.validTo, "2026-03-08T11:00:00.000Z");

    const markedWrong = await store.updateEpisodeFromUser(
      reviewed[0]!.episodeId,
      "no_longer_relevant",
      "memory_wrong_1",
      "/memory wrong episode",
      "That memory is wrong.",
      "2026-03-08T11:30:00.000Z"
    );
    assert.equal(markedWrong.episode?.status, "no_longer_relevant");
    assert.ok(markedWrong.mutationEnvelope);
    assert.equal(
      markedWrong.mutationEnvelope?.governanceDecisions[0]?.governanceReason,
      "memory_review_correction_override"
    );
    assert.equal(
      markedWrong.mutationEnvelope?.retraction?.retractionClass,
      "correction_override"
    );
    assert.equal(
      markedWrong.mutationEnvelope?.retraction?.clearsCompatibilityProjection,
      true
    );
    graphState = await store.load();
    assert.equal(graphState.graph.events.length, 1);
    assert.equal(graphState.graph.events[0]?.payload.validTo, "2026-03-08T11:00:00.000Z");

    const forgotten = await store.forgetEpisodeFromUser(
      reviewed[0]!.episodeId,
      "memory_forget_1",
      "/memory forget episode",
      "2026-03-08T12:00:00.000Z"
    );
    assert.equal(forgotten.episode?.episodeId, reviewed[0]?.episodeId);
    assert.ok(forgotten.mutationEnvelope);
    assert.equal(
      forgotten.mutationEnvelope?.governanceDecisions[0]?.governanceReason,
      "memory_review_forget_or_delete"
    );
    assert.equal(
      forgotten.mutationEnvelope?.retraction?.retractionClass,
      "forget_or_delete"
    );
    assert.equal(forgotten.mutationEnvelope?.redactionState, "value_redacted");
    assert.deepEqual(
      forgotten.mutationEnvelope?.appliedWriteRefs,
      [reviewed[0]!.episodeId]
    );
    graphState = await store.load();
    assert.equal(graphState.graph.events.length, 1);
    assert.equal(graphState.graph.events[0]?.payload.title, "[redacted episode]");
    assert.equal(graphState.graph.events[0]?.payload.summary, "[redacted episode details]");
    assert.equal(graphState.graph.events[0]?.payload.redactionState, "redacted");
    assert.equal(graphState.graph.events[0]?.payload.redactedAt, "2026-03-08T12:00:00.000Z");
    assert.deepEqual(graphState.graph.events[0]?.payload.entityRefIds, []);
    assert.equal(graphState.graph.events[0]?.payload.validTo, "2026-03-08T11:00:00.000Z");
    assert.deepEqual(
      graphState.graph.indexes.byFamily["episode.candidate"] ?? [],
      []
    );
    assert.deepEqual(
      graphState.graph.indexes.byEntityRefId["entity_owen"] ?? [],
      []
    );
    assert.equal(
      lastItem(graphState.graph.mutationJournal.entries)?.redactionState,
      "redacted"
    );
    assert.deepEqual(
      lastItem(graphState.graph.mutationJournal.entries)?.eventIds,
      [graphState.graph.events[0]!.payload.eventId]
    );

    const afterForget = await store.reviewEpisodesForUser(
      5,
      "2026-03-08T12:10:00.000Z"
    );
    assert.equal(afterForget.length, 0);
  });
});

test("forgetEpisodeFromUser redacts active graph events and closes their validity window", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_store_user_review_active_forget",
      "Owen fell down three weeks ago and I never told you how it ended.",
      "2026-03-09T09:00:00.000Z"
    );

    const reviewed = await store.reviewEpisodesForUser(
      5,
      "2026-03-09T09:05:00.000Z"
    );
    assert.equal(reviewed.length, 1);

    const forgotten = await store.forgetEpisodeFromUser(
      reviewed[0]!.episodeId,
      "memory_forget_active_1",
      "/memory forget episode",
      "2026-03-09T09:30:00.000Z"
    );
    assert.equal(forgotten.episode?.episodeId, reviewed[0]?.episodeId);

    const graphState = await store.load();
    assert.equal(graphState.graph.events.length, 1);
    assert.equal(graphState.graph.events[0]?.payload.redactionState, "redacted");
    assert.equal(graphState.graph.events[0]?.payload.redactedAt, "2026-03-09T09:30:00.000Z");
    assert.equal(graphState.graph.events[0]?.payload.validTo, "2026-03-09T09:30:00.000Z");
    assert.equal(graphState.graph.events[0]?.payload.sourceTaskId, "memory_forget_active_1");
    assert.deepEqual(
      graphState.graph.indexes.byFamily["episode.candidate"] ?? [],
      []
    );
    assert.equal(
      lastItem(graphState.graph.mutationJournal.entries)?.redactionState,
      "redacted"
    );
  });
});

test("graph mutation journal compacts to configured retention caps under the store seam", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const seededState = {
      ...createEmptyProfileMemoryState(),
      graph: {
        ...createEmptyProfileMemoryState().graph,
        compaction: {
          ...createEmptyProfileMemoryState().graph.compaction,
          maxJournalEntries: 2
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    await store.ingestFromTaskInput(
      "task_profile_graph_compaction_store_1",
      "my favorite editor is Helix",
      "2026-04-03T22:00:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_graph_compaction_store_2",
      "my favorite shell is PowerShell",
      "2026-04-03T22:01:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_graph_compaction_store_3",
      "my favorite font is JetBrains Mono",
      "2026-04-03T22:02:00.000Z"
    );

    const graphState = await store.load();
    assert.deepEqual(
      graphState.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [2, 3]
    );
    assert.equal(graphState.graph.compaction.snapshotWatermark, 1);
    assert.equal(graphState.graph.compaction.lastCompactedAt, "2026-04-03T22:02:00.000Z");
    assert.equal(graphState.graph.readModel.watermark, 3);
  });
});

test("graph mutation journal clamps stale snapshot watermark without restamping lastCompactedAt when under cap during store load", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const observationThree = createGraphObservationEnvelope({
      observationId: "observation_profile_graph_store_compaction_snapshot_clamp_3",
      stableRefId: null,
      family: "contact.context",
      normalizedKey: "contact.owen.context.compaction_snapshot_clamp_3",
      normalizedValue: "Owen mentioned the snapshot clamp replay lane.",
      redactionState: "not_requested",
      redactedAt: null,
      sensitive: false,
      sourceTaskId: "task_profile_graph_store_compaction_snapshot_clamp_3",
      sourceFingerprint: "fingerprint_profile_graph_store_compaction_snapshot_clamp_3",
      sourceTier: "explicit_user_statement",
      assertedAt: "2026-04-08T15:59:00.000Z",
      observedAt: "2026-04-08T15:59:00.000Z",
      timePrecision: "instant",
      timeSource: "user_stated",
      entityRefIds: []
    }, "2026-04-08T15:59:30.000Z");
    const observationFour = createGraphObservationEnvelope({
      observationId: "observation_profile_graph_store_compaction_snapshot_clamp_4",
      stableRefId: null,
      family: "contact.context",
      normalizedKey: "contact.owen.context.compaction_snapshot_clamp_4",
      normalizedValue: "Owen confirmed the retained journal clamp still holds.",
      redactionState: "not_requested",
      redactedAt: null,
      sensitive: false,
      sourceTaskId: "task_profile_graph_store_compaction_snapshot_clamp_4",
      sourceFingerprint: "fingerprint_profile_graph_store_compaction_snapshot_clamp_4",
      sourceTier: "explicit_user_statement",
      assertedAt: "2026-04-08T16:00:30.000Z",
      observedAt: "2026-04-08T16:00:30.000Z",
      timePrecision: "instant",
      timeSource: "user_stated",
      entityRefIds: []
    }, "2026-04-08T16:01:30.000Z");
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-08T16:02:00.000Z",
        observations: [observationThree, observationFour],
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 5,
          entries: [
            {
              journalEntryId: "journal_profile_graph_store_compaction_snapshot_clamp_3",
              watermark: 3,
              recordedAt: "2026-04-08T16:00:00.000Z",
              sourceTaskId: "task_profile_graph_store_compaction_snapshot_clamp_3",
              sourceFingerprint: "fingerprint_profile_graph_store_compaction_snapshot_clamp_3",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_compaction_snapshot_clamp_3"],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested" as const
            },
            {
              journalEntryId: "journal_profile_graph_store_compaction_snapshot_clamp_4",
              watermark: 4,
              recordedAt: "2026-04-08T16:01:00.000Z",
              sourceTaskId: "task_profile_graph_store_compaction_snapshot_clamp_4",
              sourceFingerprint: "fingerprint_profile_graph_store_compaction_snapshot_clamp_4",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_compaction_snapshot_clamp_4"],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested" as const
            }
          ]
        },
        compaction: {
          ...emptyState.graph.compaction,
          snapshotWatermark: 99,
          lastCompactedAt: "2026-04-08T15:30:00.000Z",
          maxJournalEntries: 4
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.journalEntryId),
      [
        "journal_profile_graph_store_compaction_snapshot_clamp_3",
        "journal_profile_graph_store_compaction_snapshot_clamp_4"
      ]
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [3, 4]
    );
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 5);
    assert.equal(loaded.graph.compaction.snapshotWatermark, 2);
    assert.equal(loaded.graph.compaction.lastCompactedAt, "2026-04-08T15:30:00.000Z");
  });
});

test("graph mutation journal clamps stale snapshot watermark from nextWatermark when no retained journal entries remain during store load", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-08T16:11:00.000Z",
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 6,
          entries: []
        },
        compaction: {
          ...emptyState.graph.compaction,
          snapshotWatermark: 99,
          lastCompactedAt: "2026-04-08T15:45:00.000Z",
          maxJournalEntries: 4
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.graph.mutationJournal.entries.length, 0);
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 6);
    assert.equal(loaded.graph.compaction.snapshotWatermark, 5);
    assert.equal(loaded.graph.compaction.lastCompactedAt, "2026-04-08T15:45:00.000Z");
  });
});

test("graph mutation journal stays a true no-op when journal and compaction are already replay-safe during store load", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const observationThree = createGraphObservationEnvelope({
      observationId: "observation_profile_graph_store_compaction_no_op_3",
      stableRefId: null,
      family: "contact.context",
      normalizedKey: "contact.owen.context.compaction_no_op_3",
      normalizedValue: "Owen confirmed the replay-safe compaction lane is stable.",
      redactionState: "not_requested",
      redactedAt: null,
      sensitive: false,
      sourceTaskId: "task_profile_graph_store_compaction_no_op_3",
      sourceFingerprint: "fingerprint_profile_graph_store_compaction_no_op_3",
      sourceTier: "explicit_user_statement",
      assertedAt: "2026-04-08T16:20:00.000Z",
      observedAt: "2026-04-08T16:20:00.000Z",
      timePrecision: "instant",
      timeSource: "user_stated",
      entityRefIds: []
    }, "2026-04-08T16:20:00.000Z");
    const observationFour = createGraphObservationEnvelope({
      observationId: "observation_profile_graph_store_compaction_no_op_4",
      stableRefId: null,
      family: "contact.context",
      normalizedKey: "contact.owen.context.compaction_no_op_4",
      normalizedValue: "Owen said the persisted replay window already matches.",
      redactionState: "not_requested",
      redactedAt: null,
      sensitive: false,
      sourceTaskId: "task_profile_graph_store_compaction_no_op_4",
      sourceFingerprint: "fingerprint_profile_graph_store_compaction_no_op_4",
      sourceTier: "explicit_user_statement",
      assertedAt: "2026-04-08T16:21:00.000Z",
      observedAt: "2026-04-08T16:21:00.000Z",
      timePrecision: "instant",
      timeSource: "user_stated",
      entityRefIds: []
    }, "2026-04-08T16:21:00.000Z");
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-08T16:22:00.000Z",
        observations: [observationThree, observationFour],
        mutationJournal: {
          schemaVersion: "v1" as const,
          nextWatermark: 5,
          entries: [
            {
              journalEntryId: "journal_profile_graph_store_compaction_no_op_3",
              watermark: 3,
              recordedAt: "2026-04-08T16:20:00.000Z",
              sourceTaskId: "task_profile_graph_store_compaction_no_op_3",
              sourceFingerprint: "fingerprint_profile_graph_store_compaction_no_op_3",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_compaction_no_op_3"],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested" as const
            },
            {
              journalEntryId: "journal_profile_graph_store_compaction_no_op_4",
              watermark: 4,
              recordedAt: "2026-04-08T16:21:00.000Z",
              sourceTaskId: "task_profile_graph_store_compaction_no_op_4",
              sourceFingerprint: "fingerprint_profile_graph_store_compaction_no_op_4",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_compaction_no_op_4"],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested" as const
            }
          ]
        },
        compaction: {
          ...emptyState.graph.compaction,
          snapshotWatermark: 2,
          lastCompactedAt: "2026-04-08T16:00:00.000Z",
          maxJournalEntries: 4
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.journalEntryId),
      [
        "journal_profile_graph_store_compaction_no_op_3",
        "journal_profile_graph_store_compaction_no_op_4"
      ]
    );
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [3, 4]
    );
    assert.equal(loaded.graph.mutationJournal.nextWatermark, 5);
    assert.equal(loaded.graph.compaction.snapshotWatermark, 2);
    assert.equal(loaded.graph.compaction.lastCompactedAt, "2026-04-08T16:00:00.000Z");
    assert.equal(loaded.graph.readModel.watermark, 4);
  });
});

test("graph observation retention compacts hint-only observations after the retained journal window moves forward", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        compaction: {
          ...emptyState.graph.compaction,
          maxObservationCount: 1,
          maxJournalEntries: 1
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    await store.ingestFromTaskInput(
      "task_profile_graph_observation_retention_1",
      "I know Sarah.",
      "2026-04-03T22:10:00.000Z",
      {
        provenance: {
          conversationId: "conversation_profile_graph_observation_retention",
          turnId: "turn_profile_graph_observation_retention_1",
          dominantLaneAtWrite: "profile",
          sourceSurface: "conversation_profile_input",
          sourceFingerprint: buildProfileMemorySourceFingerprint("I know Sarah.")
        }
      }
    );
    await store.ingestFromTaskInput(
      "task_profile_graph_observation_retention_2",
      "I know Jordan.",
      "2026-04-03T22:11:00.000Z",
      {
        provenance: {
          conversationId: "conversation_profile_graph_observation_retention",
          turnId: "turn_profile_graph_observation_retention_2",
          dominantLaneAtWrite: "profile",
          sourceSurface: "conversation_profile_input",
          sourceFingerprint: buildProfileMemorySourceFingerprint("I know Jordan.")
        }
      }
    );
    await store.ingestFromTaskInput(
      "task_profile_graph_observation_retention_3",
      "I know Milo.",
      "2026-04-03T22:12:00.000Z",
      {
        provenance: {
          conversationId: "conversation_profile_graph_observation_retention",
          turnId: "turn_profile_graph_observation_retention_3",
          dominantLaneAtWrite: "profile",
          sourceSurface: "conversation_profile_input",
          sourceFingerprint: buildProfileMemorySourceFingerprint("I know Milo.")
        }
      }
    );

    const graphState = await store.load();
    assert.deepEqual(
      graphState.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [3]
    );
    assert.equal(graphState.graph.compaction.snapshotWatermark, 2);
    assert.equal(graphState.graph.compaction.lastCompactedAt, "2026-04-03T22:12:00.000Z");
    assert.equal(graphState.graph.observations.length, 2);
    assert.equal(
      graphState.graph.observations.every(
        (observation) =>
          observation.payload.sourceTaskId === "task_profile_graph_observation_retention_3"
      ),
      true
    );
  });
});

test("graph observation retention compacts redacted observations after the retained journal window trims their last replay protection", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-08T04:05:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_redacted_observation_compaction_drop",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: null,
            redactionState: "redacted",
            redactedAt: "2026-04-08T04:01:00.000Z",
            sensitive: true,
            sourceTaskId: "task_profile_graph_store_redacted_observation_compaction_drop",
            sourceFingerprint: "fingerprint_profile_graph_store_redacted_observation_compaction_drop",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-08T04:00:00.000Z",
            observedAt: "2026-04-08T04:00:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          }),
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_redacted_observation_compaction_keep",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.rowan.context.1",
            normalizedValue: "I know Rowan",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_redacted_observation_compaction_keep",
            sourceFingerprint: "fingerprint_profile_graph_store_redacted_observation_compaction_keep",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-08T04:02:00.000Z",
            observedAt: "2026-04-08T04:02:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          })
        ],
        claims: [],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 3,
          entries: [
            {
              journalEntryId: "journal_profile_graph_store_redacted_observation_compaction_drop",
              watermark: 1,
              recordedAt: "2026-04-08T04:00:00.000Z",
              sourceTaskId: "task_profile_graph_store_redacted_observation_compaction_drop",
              sourceFingerprint:
                "fingerprint_profile_graph_store_redacted_observation_compaction_drop",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_redacted_observation_compaction_drop"],
              claimIds: [],
              eventIds: [],
              redactionState: "redacted"
            },
            {
              journalEntryId: "journal_profile_graph_store_redacted_observation_compaction_keep",
              watermark: 2,
              recordedAt: "2026-04-08T04:02:00.000Z",
              sourceTaskId: "task_profile_graph_store_redacted_observation_compaction_keep",
              sourceFingerprint:
                "fingerprint_profile_graph_store_redacted_observation_compaction_keep",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_redacted_observation_compaction_keep"],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        },
        compaction: {
          ...emptyState.graph.compaction,
          maxObservationCount: 1,
          maxJournalEntries: 1
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const graphState = await store.load();
    assert.deepEqual(
      graphState.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [2]
    );
    assert.deepEqual(
      graphState.graph.observations.map((observation) => observation.payload.observationId),
      ["observation_profile_graph_store_redacted_observation_compaction_keep"]
    );
    assert.equal(graphState.graph.compaction.snapshotWatermark, 1);
    assert.equal(graphState.graph.compaction.lastCompactedAt, "2026-04-08T04:05:00.000Z");
  });
});

test("graph observation retention does not let live claims or events pin redacted observations during store load compaction", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-08T04:30:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_redacted_lineage_claim_drop",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: null,
            redactionState: "redacted",
            redactedAt: "2026-04-08T04:21:00.000Z",
            sensitive: true,
            sourceTaskId: "task_profile_graph_store_redacted_lineage_claim_drop",
            sourceFingerprint: "fingerprint_profile_graph_store_redacted_lineage_claim_drop",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-08T04:20:00.000Z",
            observedAt: "2026-04-08T04:20:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          }),
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_redacted_lineage_claim_keep",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_redacted_lineage_claim_keep",
            sourceFingerprint: "fingerprint_profile_graph_store_redacted_lineage_claim_keep",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-08T04:22:00.000Z",
            observedAt: "2026-04-08T04:22:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          }),
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_redacted_lineage_event_drop",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.rowan.context.1",
            normalizedValue: null,
            redactionState: "redacted",
            redactedAt: "2026-04-08T04:23:00.000Z",
            sensitive: true,
            sourceTaskId: "task_profile_graph_store_redacted_lineage_event_drop",
            sourceFingerprint: "fingerprint_profile_graph_store_redacted_lineage_event_drop",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-08T04:23:00.000Z",
            observedAt: "2026-04-08T04:23:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          }),
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_redacted_lineage_event_keep",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.rowan.context.2",
            normalizedValue: "Rowan asked for help",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_redacted_lineage_event_keep",
            sourceFingerprint: "fingerprint_profile_graph_store_redacted_lineage_event_keep",
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
            claimId: "claim_profile_graph_store_redacted_lineage_keep",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_redacted_lineage_claim_keep",
            sourceFingerprint: "fingerprint_profile_graph_store_redacted_lineage_claim_keep",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-08T04:22:00.000Z",
            validFrom: "2026-04-08T04:22:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [
              "observation_profile_graph_store_redacted_lineage_claim_drop",
              "observation_profile_graph_store_redacted_lineage_claim_keep"
            ],
            projectionSourceIds: ["fact_profile_graph_store_redacted_lineage_claim_keep"],
            entityRefIds: [],
            active: true
          })
        ],
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_redacted_lineage_keep",
            stableRefId: null,
            family: "episode.candidate",
            title: "Rowan asked for help",
            summary: "Rowan asked for help and the outcome stayed unresolved.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_redacted_lineage_event_keep",
            sourceFingerprint: "fingerprint_profile_graph_store_redacted_lineage_event_keep",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-08T04:24:00.000Z",
            observedAt: "2026-04-08T04:24:00.000Z",
            validFrom: "2026-04-08T04:24:00.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [
              "observation_profile_graph_store_redacted_lineage_event_drop",
              "observation_profile_graph_store_redacted_lineage_event_keep"
            ],
            projectionSourceIds: ["episode_profile_graph_store_redacted_lineage_event_keep"],
            entityRefIds: ["entity_rowan"]
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 5,
          entries: [
            {
              journalEntryId: "journal_profile_graph_store_redacted_lineage_claim_drop",
              watermark: 1,
              recordedAt: "2026-04-08T04:20:00.000Z",
              sourceTaskId: "task_profile_graph_store_redacted_lineage_claim_drop",
              sourceFingerprint: "fingerprint_profile_graph_store_redacted_lineage_claim_drop",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_redacted_lineage_claim_drop"],
              claimIds: [],
              eventIds: [],
              redactionState: "redacted"
            },
            {
              journalEntryId: "journal_profile_graph_store_redacted_lineage_event_drop",
              watermark: 2,
              recordedAt: "2026-04-08T04:23:00.000Z",
              sourceTaskId: "task_profile_graph_store_redacted_lineage_event_drop",
              sourceFingerprint: "fingerprint_profile_graph_store_redacted_lineage_event_drop",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_redacted_lineage_event_drop"],
              claimIds: [],
              eventIds: [],
              redactionState: "redacted"
            },
            {
              journalEntryId: "journal_profile_graph_store_redacted_lineage_claim_keep",
              watermark: 3,
              recordedAt: "2026-04-08T04:22:00.000Z",
              sourceTaskId: "task_profile_graph_store_redacted_lineage_claim_keep",
              sourceFingerprint: "fingerprint_profile_graph_store_redacted_lineage_claim_keep",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_redacted_lineage_claim_keep"],
              claimIds: ["claim_profile_graph_store_redacted_lineage_keep"],
              eventIds: [],
              redactionState: "not_requested"
            },
            {
              journalEntryId: "journal_profile_graph_store_redacted_lineage_event_keep",
              watermark: 4,
              recordedAt: "2026-04-08T04:24:00.000Z",
              sourceTaskId: "task_profile_graph_store_redacted_lineage_event_keep",
              sourceFingerprint: "fingerprint_profile_graph_store_redacted_lineage_event_keep",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_redacted_lineage_event_keep"],
              claimIds: [],
              eventIds: ["event_profile_graph_store_redacted_lineage_keep"],
              redactionState: "not_requested"
            }
          ]
        },
        compaction: {
          ...emptyState.graph.compaction,
          maxObservationCount: 2,
          maxJournalEntries: 2
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const graphState = await store.load();
    assert.deepEqual(
      graphState.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [3, 4]
    );
    assert.deepEqual(
      graphState.graph.observations.map((observation) => observation.payload.observationId),
      [
        "observation_profile_graph_store_redacted_lineage_claim_keep",
        "observation_profile_graph_store_redacted_lineage_event_keep"
      ]
    );
    assert.deepEqual(
      graphState.graph.claims[0]?.payload.derivedFromObservationIds,
      ["observation_profile_graph_store_redacted_lineage_claim_keep"]
    );
    assert.deepEqual(
      graphState.graph.events[0]?.payload.derivedFromObservationIds,
      ["observation_profile_graph_store_redacted_lineage_event_keep"]
    );
    assert.equal(graphState.graph.compaction.snapshotWatermark, 2);
    assert.equal(graphState.graph.compaction.lastCompactedAt, "2026-04-08T04:30:00.000Z");
  });
});

test("graph observation retention does not let redacted claims pin stale observations during store load compaction", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T22:05:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_redacted_claim_retention_old",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: null,
            redactionState: "redacted",
            redactedAt: "2026-04-03T21:01:00.000Z",
            sensitive: true,
            sourceTaskId: "task_profile_graph_store_redacted_claim_retention_old",
            sourceFingerprint: "fingerprint_profile_graph_store_redacted_claim_retention_old",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:00:00.000Z",
            observedAt: "2026-04-03T21:00:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: []
          }),
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_redacted_claim_retention_new",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.sarah.context.1",
            normalizedValue: "I know Sarah",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_redacted_claim_retention_new",
            sourceFingerprint: "fingerprint_profile_graph_store_redacted_claim_retention_new",
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
            claimId: "claim_profile_graph_store_redacted_claim_retention_old",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: null,
            redactionState: "redacted",
            redactedAt: "2026-04-03T21:01:00.000Z",
            sensitive: true,
            sourceTaskId: "task_profile_graph_store_redacted_claim_retention_old",
            sourceFingerprint: "fingerprint_profile_graph_store_redacted_claim_retention_old",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T21:00:00.000Z",
            validFrom: "2026-04-03T21:00:00.000Z",
            validTo: "2026-04-03T21:01:00.000Z",
            endedAt: "2026-04-03T21:01:00.000Z",
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_store_redacted_claim_retention_old"],
            projectionSourceIds: ["fact_profile_graph_store_redacted_claim_retention_old"],
            entityRefIds: [],
            active: false
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 3,
          entries: [
            {
              journalEntryId: "journal_profile_graph_store_redacted_claim_retention_old",
              watermark: 1,
              recordedAt: "2026-04-03T21:00:00.000Z",
              sourceTaskId: "task_profile_graph_store_redacted_claim_retention_old",
              sourceFingerprint: "fingerprint_profile_graph_store_redacted_claim_retention_old",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_redacted_claim_retention_old"],
              claimIds: ["claim_profile_graph_store_redacted_claim_retention_old"],
              eventIds: [],
              redactionState: "redacted"
            },
            {
              journalEntryId: "journal_profile_graph_store_redacted_claim_retention_new",
              watermark: 2,
              recordedAt: "2026-04-03T21:02:00.000Z",
              sourceTaskId: "task_profile_graph_store_redacted_claim_retention_new",
              sourceFingerprint: "fingerprint_profile_graph_store_redacted_claim_retention_new",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_redacted_claim_retention_new"],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        },
        compaction: {
          ...emptyState.graph.compaction,
          maxObservationCount: 1,
          maxJournalEntries: 1
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const graphState = await store.load();
    assert.deepEqual(
      graphState.graph.observations.map((observation) => observation.payload.observationId),
      ["observation_profile_graph_store_redacted_claim_retention_new"]
    );
    assert.deepEqual(
      graphState.graph.claims[0]?.payload.derivedFromObservationIds,
      []
    );
  });
});

test("graph observation retention preserves event-derived observations during store load compaction", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-03T22:10:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_event_lineage_1",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.1",
            normalizedValue: "Owen fell down yesterday",
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_event_lineage_1",
            sourceFingerprint: "fingerprint_profile_graph_store_event_lineage_1",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T22:01:00.000Z",
            observedAt: "2026-04-03T22:01:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: ["entity_owen"]
          }),
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_event_lineage_2",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.jordan.context.1",
            normalizedValue: "Jordan was there too",
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_event_lineage_2",
            sourceFingerprint: "fingerprint_profile_graph_store_event_lineage_2",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T22:02:00.000Z",
            observedAt: "2026-04-03T22:02:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: ["entity_jordan"]
          }),
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_event_lineage_3",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.milo.context.1",
            normalizedValue: "Milo asked about it later",
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_event_lineage_3",
            sourceFingerprint: "fingerprint_profile_graph_store_event_lineage_3",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T22:03:00.000Z",
            observedAt: "2026-04-03T22:03:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: ["entity_milo"]
          })
        ],
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_event_lineage_1",
            stableRefId: null,
            family: "episode.candidate",
            title: "Owen fall situation",
            summary: "Owen fell down and the outcome stayed unresolved.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_event_lineage_event",
            sourceFingerprint: "fingerprint_profile_graph_store_event_lineage_event",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-03T22:02:00.000Z",
            observedAt: "2026-04-03T22:02:00.000Z",
            validFrom: "2026-04-03T22:02:00.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_store_event_lineage_2"],
            projectionSourceIds: ["episode_profile_graph_store_event_lineage_1"],
            entityRefIds: ["entity_owen"]
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 4,
          entries: [
            {
              journalEntryId: "journal_profile_graph_store_event_lineage_1",
              watermark: 1,
              recordedAt: "2026-04-03T22:01:00.000Z",
              sourceTaskId: "task_profile_graph_store_event_lineage_1",
              sourceFingerprint: "fingerprint_profile_graph_store_event_lineage_1",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_event_lineage_1"],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            },
            {
              journalEntryId: "journal_profile_graph_store_event_lineage_2",
              watermark: 2,
              recordedAt: "2026-04-03T22:02:00.000Z",
              sourceTaskId: "task_profile_graph_store_event_lineage_2",
              sourceFingerprint: "fingerprint_profile_graph_store_event_lineage_2",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_event_lineage_2"],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            },
            {
              journalEntryId: "journal_profile_graph_store_event_lineage_3",
              watermark: 3,
              recordedAt: "2026-04-03T22:03:00.000Z",
              sourceTaskId: "task_profile_graph_store_event_lineage_3",
              sourceFingerprint: "fingerprint_profile_graph_store_event_lineage_3",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_event_lineage_3"],
              claimIds: [],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        },
        compaction: {
          ...emptyState.graph.compaction,
          maxObservationCount: 1,
          maxJournalEntries: 1
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const graphState = await store.load();

    assert.deepEqual(
      graphState.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [4]
    );
    assert.deepEqual(
      graphState.graph.observations.map((observation) => observation.payload.observationId),
      ["observation_profile_graph_store_event_lineage_2"]
    );
    assert.deepEqual(
      graphState.graph.events[0]?.payload.derivedFromObservationIds,
      ["observation_profile_graph_store_event_lineage_2"]
    );
    assert.equal(graphState.graph.compaction.snapshotWatermark, 3);
    assert.equal(graphState.graph.compaction.lastCompactedAt, "2026-04-03T22:10:00.000Z");
  });
});

test("graph claim retention compacts inactive claims after the retained journal window moves forward", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        compaction: {
          ...emptyState.graph.compaction,
          maxClaimCount: 1,
          maxJournalEntries: 1
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    await store.ingestFromTaskInput(
      "task_profile_graph_claim_retention_1",
      "My name is Avery.",
      "2026-04-03T22:30:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_graph_claim_retention_2",
      "My name is Ava.",
      "2026-04-03T22:31:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_graph_claim_retention_3",
      "My name is June.",
      "2026-04-03T22:32:00.000Z"
    );

    const graphState = await store.load();
    const activeClaims = graphState.graph.claims.filter((claim) => claim.payload.active);
    const inactiveClaims = graphState.graph.claims.filter((claim) => !claim.payload.active);
    const retainedClaimIds = graphState.graph.claims
      .map((claim) => claim.payload.claimId)
      .sort((left, right) => left.localeCompare(right));
    const journalClaimIds = [...(graphState.graph.mutationJournal.entries[0]?.claimIds ?? [])]
      .sort((left, right) => left.localeCompare(right));

    assert.deepEqual(
      graphState.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [3]
    );
    assert.equal(graphState.graph.compaction.snapshotWatermark, 2);
    assert.equal(graphState.graph.compaction.lastCompactedAt, "2026-04-03T22:32:00.000Z");
    assert.equal(graphState.graph.claims.length, 2);
    assert.equal(activeClaims.length, 1);
    assert.equal(inactiveClaims.length, 1);
    assert.equal(activeClaims[0]?.payload.normalizedValue, "June");
    assert.equal(inactiveClaims[0]?.payload.normalizedValue, "Ava");
    assert.equal(
      graphState.graph.claims.some((claim) => claim.payload.normalizedValue === "Avery"),
      false
    );
    assert.deepEqual(journalClaimIds, retainedClaimIds);
    assert.equal(
      graphState.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
      activeClaims[0]?.payload.claimId
    );
  });
});

test("graph claim retention compacts redacted claims after the retained journal window trims their last replay protection", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-08T03:15:00.000Z",
        observations: [],
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_redacted_claim_compaction_drop",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: null,
            redactionState: "redacted",
            redactedAt: "2026-04-08T03:02:00.000Z",
            sensitive: true,
            sourceTaskId: "task_profile_graph_store_redacted_claim_compaction_drop",
            sourceFingerprint: "fingerprint_profile_graph_store_redacted_claim_compaction_drop",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-08T03:00:00.000Z",
            validFrom: "2026-04-08T03:00:00.000Z",
            validTo: "2026-04-08T03:02:00.000Z",
            endedAt: "2026-04-08T03:02:00.000Z",
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_redacted_claim_compaction_drop"],
            entityRefIds: [],
            active: false
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_redacted_claim_compaction_keep",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Ava",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_redacted_claim_compaction_keep",
            sourceFingerprint: "fingerprint_profile_graph_store_redacted_claim_compaction_keep",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-08T03:05:00.000Z",
            validFrom: "2026-04-08T03:05:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_graph_store_redacted_claim_compaction_keep"],
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
              journalEntryId: "journal_profile_graph_store_redacted_claim_compaction_drop",
              watermark: 1,
              recordedAt: "2026-04-08T03:02:00.000Z",
              sourceTaskId: "task_profile_graph_store_redacted_claim_compaction_drop",
              sourceFingerprint: "fingerprint_profile_graph_store_redacted_claim_compaction_drop",
              mutationEnvelopeHash: null,
              observationIds: [],
              claimIds: ["claim_profile_graph_store_redacted_claim_compaction_drop"],
              eventIds: [],
              redactionState: "redacted"
            },
            {
              journalEntryId: "journal_profile_graph_store_redacted_claim_compaction_keep",
              watermark: 2,
              recordedAt: "2026-04-08T03:05:00.000Z",
              sourceTaskId: "task_profile_graph_store_redacted_claim_compaction_keep",
              sourceFingerprint: "fingerprint_profile_graph_store_redacted_claim_compaction_keep",
              mutationEnvelopeHash: null,
              observationIds: [],
              claimIds: ["claim_profile_graph_store_redacted_claim_compaction_keep"],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        },
        compaction: {
          ...emptyState.graph.compaction,
          maxClaimCount: 1,
          maxJournalEntries: 1
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const graphState = await store.load();
    assert.deepEqual(
      graphState.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [3]
    );
    assert.deepEqual(
      graphState.graph.claims.map((claim) => claim.payload.claimId),
      ["claim_profile_graph_store_redacted_claim_compaction_keep"]
    );
    assert.equal(graphState.graph.compaction.snapshotWatermark, 2);
    assert.equal(graphState.graph.compaction.lastCompactedAt, "2026-04-08T03:15:00.000Z");
  });
});

test("graph retention does not let source-tier-invalid retained claims pin observations or claim retention during store load compaction", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-06T02:20:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_invalid_source_retention_old",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_invalid_source_retention_old",
            sourceFingerprint: "fingerprint_profile_graph_store_invalid_source_retention_old",
            sourceTier: "assistant_inference",
            assertedAt: "2026-04-06T01:00:00.000Z",
            observedAt: "2026-04-06T01:00:00.000Z",
            timePrecision: "instant",
            timeSource: "inferred",
            entityRefIds: []
          }),
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_invalid_source_retention_new",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Ava",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_invalid_source_retention_new",
            sourceFingerprint: "fingerprint_profile_graph_store_invalid_source_retention_new",
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
            claimId: "claim_profile_graph_store_invalid_source_retention_old",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Avery",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_invalid_source_retention_old",
            sourceFingerprint: "fingerprint_profile_graph_store_invalid_source_retention_old",
            sourceTier: "assistant_inference",
            assertedAt: "2026-04-06T01:00:00.000Z",
            validFrom: "2026-04-06T01:00:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "inferred",
            derivedFromObservationIds: ["observation_profile_graph_store_invalid_source_retention_old"],
            projectionSourceIds: ["fact_profile_graph_store_invalid_source_retention_old"],
            entityRefIds: [],
            active: true
          }),
          createGraphClaimEnvelope({
            claimId: "claim_profile_graph_store_invalid_source_retention_new",
            stableRefId: null,
            family: "identity.preferred_name",
            normalizedKey: "identity.preferred_name",
            normalizedValue: "Ava",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_invalid_source_retention_new",
            sourceFingerprint: "fingerprint_profile_graph_store_invalid_source_retention_new",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-06T01:05:00.000Z",
            validFrom: "2026-04-06T01:05:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_store_invalid_source_retention_new"],
            projectionSourceIds: ["fact_profile_graph_store_invalid_source_retention_new"],
            entityRefIds: [],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 3,
          entries: [
            {
              journalEntryId: "journal_profile_graph_store_invalid_source_retention_1",
              watermark: 1,
              recordedAt: "2026-04-06T01:00:00.000Z",
              sourceTaskId: "task_profile_graph_store_invalid_source_retention_old",
              sourceFingerprint: "fingerprint_profile_graph_store_invalid_source_retention_old",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_invalid_source_retention_old"],
              claimIds: ["claim_profile_graph_store_invalid_source_retention_old"],
              eventIds: [],
              redactionState: "not_requested"
            },
            {
              journalEntryId: "journal_profile_graph_store_invalid_source_retention_2",
              watermark: 2,
              recordedAt: "2026-04-06T01:05:00.000Z",
              sourceTaskId: "task_profile_graph_store_invalid_source_retention_new",
              sourceFingerprint: "fingerprint_profile_graph_store_invalid_source_retention_new",
              mutationEnvelopeHash: null,
              observationIds: ["observation_profile_graph_store_invalid_source_retention_new"],
              claimIds: ["claim_profile_graph_store_invalid_source_retention_new"],
              eventIds: [],
              redactionState: "not_requested"
            }
          ]
        },
        compaction: {
          ...emptyState.graph.compaction,
          maxObservationCount: 1,
          maxClaimCount: 1,
          maxJournalEntries: 1
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const graphState = await store.load();

    assert.deepEqual(
      graphState.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [2]
    );
    assert.deepEqual(
      graphState.graph.claims.map((claim) => claim.payload.claimId),
      ["claim_profile_graph_store_invalid_source_retention_new"]
    );
    assert.deepEqual(
      graphState.graph.observations.map((observation) => observation.payload.observationId),
      ["observation_profile_graph_store_invalid_source_retention_new"]
    );
    assert.deepEqual(
      graphState.graph.mutationJournal.entries[0]?.claimIds,
      ["claim_profile_graph_store_invalid_source_retention_new"]
    );
    assert.deepEqual(
      graphState.graph.mutationJournal.entries[0]?.observationIds,
      ["observation_profile_graph_store_invalid_source_retention_new"]
    );
    assert.equal(
      graphState.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
      "claim_profile_graph_store_invalid_source_retention_new"
    );
    assert.equal(graphState.graph.compaction.snapshotWatermark, 1);
    assert.equal(graphState.graph.compaction.lastCompactedAt, "2026-04-06T02:20:00.000Z");
  });
});

test("graph event retention compacts terminal events after the retained journal window moves forward", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededEpisodes = [
      createProfileEpisodeRecord({
        title: "Owen fell down",
        summary: "Owen fell down and the outcome is unresolved.",
        sourceTaskId: "task_profile_graph_event_retention_seed_1",
        source: "test.seed",
        sourceKind: "explicit_user_statement",
        observedAt: "2026-04-03T22:20:00.000Z",
        sensitive: false,
        confidence: 0.95,
        entityRefs: ["entity_owen"]
      }),
      createProfileEpisodeRecord({
        title: "Jordan lost keys",
        summary: "Jordan lost keys and the outcome is unresolved.",
        sourceTaskId: "task_profile_graph_event_retention_seed_2",
        source: "test.seed",
        sourceKind: "explicit_user_statement",
        observedAt: "2026-04-03T22:21:00.000Z",
        sensitive: false,
        confidence: 0.95,
        entityRefs: ["entity_jordan"]
      }),
      createProfileEpisodeRecord({
        title: "Milo missed the train",
        summary: "Milo missed the train and the outcome is unresolved.",
        sourceTaskId: "task_profile_graph_event_retention_seed_3",
        source: "test.seed",
        sourceKind: "explicit_user_statement",
        observedAt: "2026-04-03T22:22:00.000Z",
        sensitive: false,
        confidence: 0.95,
        entityRefs: ["entity_milo"]
      })
    ];
    const seededState = {
      ...emptyState,
      episodes: seededEpisodes,
      graph: {
        ...emptyState.graph,
        compaction: {
          ...emptyState.graph.compaction,
          maxEventCount: 1,
          maxJournalEntries: 1
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    await store.updateEpisodeFromUser(
      seededEpisodes[0]!.id,
      "resolved",
      "memory_resolve_graph_event_retention_1",
      "/memory resolve episode",
      "Owen recovered.",
      "2026-04-03T22:23:00.000Z"
    );
    await store.updateEpisodeFromUser(
      seededEpisodes[1]!.id,
      "resolved",
      "memory_resolve_graph_event_retention_2",
      "/memory resolve episode",
      "Jordan found the keys.",
      "2026-04-03T22:24:00.000Z"
    );
    await store.updateEpisodeFromUser(
      seededEpisodes[2]!.id,
      "resolved",
      "memory_resolve_graph_event_retention_3",
      "/memory resolve episode",
      "Milo made it home.",
      "2026-04-03T22:25:00.000Z"
    );

    const graphState = await store.load();
    assert.deepEqual(
      graphState.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [4]
    );
    assert.equal(graphState.graph.compaction.snapshotWatermark, 3);
    assert.equal(graphState.graph.compaction.lastCompactedAt, "2026-04-03T22:25:00.000Z");
    assert.equal(graphState.graph.events.length, 1);
    assert.equal(
      graphState.graph.events[0]?.payload.sourceTaskId,
      "memory_resolve_graph_event_retention_3"
    );
    assert.equal(
      graphState.graph.events[0]?.payload.validTo,
      "2026-04-03T22:25:00.000Z"
    );
  });
});

test("graph retention does not let orphaned retained active events mint replay markers or pin retention during store load compaction", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const validEpisode = {
      ...createProfileEpisodeRecord({
      title: "Owen fall situation",
      summary: "Owen fell down and the outcome stayed unresolved.",
      sourceTaskId: "task_profile_graph_store_event_surface_valid_episode",
      source: "user_input_pattern.episode_candidate",
      sourceKind: "explicit_user_statement",
      observedAt: "2026-04-07T02:11:00.000Z",
      sensitive: false,
      confidence: 0.9,
      entityRefs: ["entity_owen"]
      }),
      id: "episode_profile_graph_store_event_surface_valid"
    };
    const validEventId =
      `event_${sha256HexFromCanonicalJson({ episodeId: validEpisode.id }).slice(0, 24)}`;
    const seededState = {
      ...emptyState,
      episodes: [validEpisode],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-07T02:20:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_event_surface_orphaned",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.orphaned",
            normalizedValue: "Owen mentioned an older unresolved thread.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_event_surface_orphaned_observation",
            sourceFingerprint: "fingerprint_profile_graph_store_event_surface_orphaned_observation",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-07T02:09:00.000Z",
            observedAt: "2026-04-07T02:09:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: ["entity_owen"]
          }),
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_event_surface_valid",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.valid",
            normalizedValue: "Owen still needs a follow-up.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_event_surface_valid_observation",
            sourceFingerprint: "fingerprint_profile_graph_store_event_surface_valid_observation",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-07T02:11:00.000Z",
            observedAt: "2026-04-07T02:11:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: ["entity_owen"]
          })
        ],
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_event_surface_orphaned",
            stableRefId: null,
            family: "episode.candidate",
            title: "Orphaned episode",
            summary: "An old unresolved episode lost its canonical source.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_event_surface_orphaned",
            sourceFingerprint: "fingerprint_profile_graph_store_event_surface_orphaned",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-07T02:09:00.000Z",
            observedAt: "2026-04-07T02:09:00.000Z",
            validFrom: "2026-04-07T02:09:00.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_store_event_surface_orphaned"],
            projectionSourceIds: ["episode_profile_graph_store_event_surface_missing"],
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
            sourceTaskId: "task_profile_graph_store_event_surface_valid",
            sourceFingerprint: "fingerprint_profile_graph_store_event_surface_valid",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-07T02:11:00.000Z",
            observedAt: "2026-04-07T02:11:00.000Z",
            validFrom: "2026-04-07T02:11:00.000Z",
            validTo: null,
              timePrecision: "instant",
              timeSource: "user_stated",
              derivedFromObservationIds: ["observation_profile_graph_store_event_surface_valid"],
              projectionSourceIds: [validEpisode.id],
              entityRefIds: ["entity_owen"]
          })
        ],
        compaction: {
          ...emptyState.graph.compaction,
          maxObservationCount: 1,
          maxEventCount: 1,
          maxJournalEntries: 2
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const graphState = await store.load();

      assert.deepEqual(
        graphState.graph.events.map((event) => event.payload.eventId),
        [validEventId]
      );
    assert.deepEqual(
      graphState.graph.observations.map((observation) => observation.payload.observationId),
      ["observation_profile_graph_store_event_surface_valid"]
    );
      assert.deepEqual(
        graphState.graph.mutationJournal.entries[0]?.eventIds,
        [validEventId]
      );
    assert.equal(
      graphState.graph.mutationJournal.entries[0]?.sourceFingerprint?.startsWith(
        "graph_event_replay_backfill_"
      ),
      true
    );
    assert.deepEqual(
      graphState.graph.mutationJournal.entries[1]?.observationIds,
      ["observation_profile_graph_store_event_surface_valid"]
    );
    assert.equal(
      graphState.graph.mutationJournal.entries[1]?.sourceFingerprint?.startsWith(
        "graph_observation_replay_backfill_"
      ),
      true
    );
    assert.equal(
      graphState.graph.mutationJournal.entries.some((entry) =>
        entry.eventIds.includes("event_profile_graph_store_event_surface_orphaned")
      ),
      false
    );
    assert.equal(
      graphState.graph.mutationJournal.entries.some((entry) =>
        entry.observationIds.includes("observation_profile_graph_store_event_surface_orphaned")
      ),
      false
    );
    assert.equal(graphState.graph.compaction.snapshotWatermark, 0);
    assert.equal(graphState.graph.compaction.lastCompactedAt, "2026-04-07T02:20:00.000Z");
  });
});

test("graph retention compacts redacted events after journal retention trims their last replay protection during store load", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-08T02:30:00.000Z",
        observations: [],
        claims: [],
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_redacted_event_compaction_drop",
            stableRefId: null,
            family: "episode.candidate",
            title: "[redacted episode]",
            summary: "[redacted episode details]",
            redactionState: "redacted",
            redactedAt: "2026-04-08T02:10:00.000Z",
            sensitive: true,
            sourceTaskId: "task_profile_graph_store_redacted_event_compaction_drop",
            sourceFingerprint: "fingerprint_profile_graph_store_redacted_event_compaction_drop",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-08T02:00:00.000Z",
            observedAt: "2026-04-08T02:00:00.000Z",
            validFrom: "2026-04-08T02:00:00.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["episode_profile_graph_store_redacted_event_compaction_drop"],
            entityRefIds: []
          }),
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_redacted_event_compaction_keep",
            stableRefId: null,
            family: "episode.candidate",
            title: "Resolved follow-up",
            summary: "The retained journal still covers this terminal event.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_redacted_event_compaction_keep",
            sourceFingerprint: "fingerprint_profile_graph_store_redacted_event_compaction_keep",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-08T02:05:00.000Z",
            observedAt: "2026-04-08T02:05:00.000Z",
            validFrom: "2026-04-08T02:05:00.000Z",
            validTo: "2026-04-08T02:12:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["episode_profile_graph_store_redacted_event_compaction_keep"],
            entityRefIds: []
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 3,
          entries: [
            {
              journalEntryId: "journal_profile_graph_store_redacted_event_compaction_drop",
              watermark: 1,
              recordedAt: "2026-04-08T02:10:00.000Z",
              sourceTaskId: "task_profile_graph_store_redacted_event_compaction_drop",
              sourceFingerprint: "fingerprint_profile_graph_store_redacted_event_compaction_drop",
              mutationEnvelopeHash: null,
              observationIds: [],
              claimIds: [],
              eventIds: ["event_profile_graph_store_redacted_event_compaction_drop"],
              redactionState: "redacted"
            },
            {
              journalEntryId: "journal_profile_graph_store_redacted_event_compaction_keep",
              watermark: 2,
              recordedAt: "2026-04-08T02:12:00.000Z",
              sourceTaskId: "task_profile_graph_store_redacted_event_compaction_keep",
              sourceFingerprint: "fingerprint_profile_graph_store_redacted_event_compaction_keep",
              mutationEnvelopeHash: null,
              observationIds: [],
              claimIds: [],
              eventIds: ["event_profile_graph_store_redacted_event_compaction_keep"],
              redactionState: "not_requested"
            }
          ]
        },
        compaction: {
          ...emptyState.graph.compaction,
          maxEventCount: 1,
          maxJournalEntries: 1
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    assert.deepEqual(
      loaded.graph.mutationJournal.entries.map((entry) => entry.watermark),
      [2]
    );
    assert.deepEqual(
      loaded.graph.events.map((event) => event.payload.eventId),
      ["event_profile_graph_store_redacted_event_compaction_keep"]
    );
    assert.equal(loaded.graph.compaction.snapshotWatermark, 1);
    assert.equal(loaded.graph.compaction.lastCompactedAt, "2026-04-08T02:30:00.000Z");
  });
});

test("graph retention does not let source-tier-invalid retained active events mint replay markers or pin retention during store load compaction", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-07T03:20:00.000Z",
        observations: [
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_event_source_tier_invalid",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.invalid_event_source",
            normalizedValue: "Owen mentioned an untrusted structured episode candidate.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_event_source_tier_invalid_observation",
            sourceFingerprint: "fingerprint_profile_graph_store_event_source_tier_invalid_observation",
            sourceTier: "validated_structured_candidate",
            assertedAt: "2026-04-07T03:09:00.000Z",
            observedAt: "2026-04-07T03:09:00.000Z",
            timePrecision: "instant",
            timeSource: "asserted_at",
            entityRefIds: ["entity_owen"]
          }),
          createGraphObservationEnvelope({
            observationId: "observation_profile_graph_store_event_source_tier_valid",
            stableRefId: null,
            family: "contact.context",
            normalizedKey: "contact.owen.context.valid_event_source",
            normalizedValue: "Owen still needs a real follow-up.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_event_source_tier_valid_observation",
            sourceFingerprint: "fingerprint_profile_graph_store_event_source_tier_valid_observation",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-07T03:11:00.000Z",
            observedAt: "2026-04-07T03:11:00.000Z",
            timePrecision: "instant",
            timeSource: "user_stated",
            entityRefIds: ["entity_owen"]
          })
        ],
        events: [
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_event_source_tier_invalid",
            stableRefId: null,
            family: "episode.candidate",
            title: "Structured candidate that should stay quarantined",
            summary: "A retained structured episode candidate should remain audit-only.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_event_source_tier_invalid",
            sourceFingerprint: "fingerprint_profile_graph_store_event_source_tier_invalid",
            sourceTier: "validated_structured_candidate",
            assertedAt: "2026-04-07T03:09:00.000Z",
            observedAt: "2026-04-07T03:09:00.000Z",
            validFrom: "2026-04-07T03:09:00.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "asserted_at",
            derivedFromObservationIds: ["observation_profile_graph_store_event_source_tier_invalid"],
            projectionSourceIds: [],
            entityRefIds: ["entity_owen"]
          }),
          createGraphEventEnvelope({
            eventId: "event_profile_graph_store_event_source_tier_valid",
            stableRefId: null,
            family: "episode.candidate",
            title: "Valid explicit candidate",
            summary: "A retained explicit episode candidate should stay active.",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_graph_store_event_source_tier_valid",
            sourceFingerprint: "fingerprint_profile_graph_store_event_source_tier_valid",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-07T03:11:00.000Z",
            observedAt: "2026-04-07T03:11:00.000Z",
            validFrom: "2026-04-07T03:11:00.000Z",
            validTo: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: ["observation_profile_graph_store_event_source_tier_valid"],
            projectionSourceIds: [],
            entityRefIds: ["entity_owen"]
          })
        ],
        compaction: {
          ...emptyState.graph.compaction,
          maxObservationCount: 1,
          maxEventCount: 1,
          maxJournalEntries: 2
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const graphState = await store.load();

    assert.deepEqual(
      graphState.graph.events.map((event) => event.payload.eventId),
      ["event_profile_graph_store_event_source_tier_valid"]
    );
    assert.deepEqual(
      graphState.graph.observations.map((observation) => observation.payload.observationId),
      ["observation_profile_graph_store_event_source_tier_valid"]
    );
    assert.deepEqual(
      graphState.graph.mutationJournal.entries[0]?.eventIds,
      ["event_profile_graph_store_event_source_tier_valid"]
    );
    assert.equal(
      graphState.graph.mutationJournal.entries[0]?.sourceFingerprint?.startsWith(
        "graph_event_replay_backfill_"
      ),
      true
    );
    assert.deepEqual(
      graphState.graph.mutationJournal.entries[1]?.observationIds,
      ["observation_profile_graph_store_event_source_tier_valid"]
    );
    assert.equal(
      graphState.graph.mutationJournal.entries[1]?.sourceFingerprint?.startsWith(
        "graph_observation_replay_backfill_"
      ),
      true
    );
    assert.equal(
      graphState.graph.mutationJournal.entries.some((entry) =>
        entry.eventIds.includes("event_profile_graph_store_event_source_tier_invalid")
      ),
      false
    );
    assert.equal(
      graphState.graph.mutationJournal.entries.some((entry) =>
        entry.observationIds.includes("observation_profile_graph_store_event_source_tier_invalid")
      ),
      false
    );
    assert.equal(graphState.graph.compaction.snapshotWatermark, 0);
    assert.equal(graphState.graph.compaction.lastCompactedAt, "2026-04-07T03:20:00.000Z");
  });
});

test("reviewFactsForUser reuses the bounded approval-aware fact review seam", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_store_fact_review_residence",
      "I live in Detroit.",
      "2026-04-03T18:00:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_store_fact_review_context",
      "I know Sarah.",
      "2026-04-03T18:01:00.000Z"
    );

    const review = await store.reviewFactsForUser(
      "Sarah Detroit",
      4,
      "2026-04-03T18:05:00.000Z"
    );

    assert.equal(review.entries.length, 2);
    assert.match(review.entries[0]?.fact.key ?? "", /^contact\.sarah\.context\.[a-f0-9]{8}$/);
    assert.equal(review.entries[0]?.fact.sensitive, false);
    assert.equal(
      review.entries[0]?.decisionRecord.disposition,
      "selected_supporting_history"
    );
    assert.equal(review.entries[1]?.fact.key, "residence.current");
    assert.equal(review.entries[1]?.fact.sensitive, true);
    assert.equal(
      review.entries[1]?.decisionRecord.disposition,
      "selected_current_state"
    );
    assert.deepEqual(review.hiddenDecisionRecords, []);
  });
});

test("profile memory store exposes bounded planning inspection with selected facts and hidden decisions", async () => {
  await withProfileStore(async (store, filePath) => {
    await store.ingestFromTaskInput(
      "task_profile_store_planning_inspection_1",
      "I work with Owen at Lantern Studio.",
      "2026-04-03T00:00:00.000Z"
    );
    let seededState = await store.load();
    seededState = upsertTemporalProfileFact(seededState, {
      key: "contact.sarah.name",
      value: "Sarah",
      sensitive: false,
      sourceTaskId: "task_profile_store_planning_inspection_2",
      source: "user_input_pattern.contact_entity_hint",
      observedAt: "2026-04-03T00:01:00.000Z",
      confidence: 0.7
    }).nextState;
    await saveSeededProfileMemoryState(filePath, Buffer.alloc(32, 7), seededState);

    const inspection = await store.inspectFactsForPlanningContext(
      "who is Owen?",
      3,
      undefined,
      "2026-04-03T00:02:00.000Z"
    );

    assert.equal(
      inspection.entries.some((entry) => entry.fact.key === "contact.owen.name"),
      true
    );
    assert.equal(
      inspection.entries.some(
        (entry) => entry.fact.key === "contact.owen.work_association"
      ),
      true
    );
    assert.equal(inspection.hiddenDecisionRecords.length, 1);
    assert.equal(inspection.hiddenDecisionRecords[0]?.family, "contact.entity_hint");
    assert.equal(
      inspection.hiddenDecisionRecords[0]?.asOfObservedTime,
      "2026-04-03T00:02:00.000Z"
    );
  });
});

test("store review keeps legacy generic sensitive-key facts behind approval and marks them effectively sensitive", async () => {
  await withProfileStore(async (store, filePath) => {
    let seededState = createEmptyProfileMemoryState();
    seededState = upsertTemporalProfileFact(seededState, {
      key: "employment.current",
      value: "Lantern",
      sensitive: false,
      sourceTaskId: "task_profile_store_generic_floor_employment",
      source: "test.seed",
      observedAt: "2026-04-03T18:20:00.000Z",
      confidence: 0.95
    }).nextState;
    seededState = upsertTemporalProfileFact(seededState, {
      key: "email.address",
      value: "avery@example.com",
      sensitive: false,
      sourceTaskId: "task_profile_store_generic_floor_email",
      source: "user_input_pattern.my_is",
      observedAt: "2026-04-03T18:21:00.000Z",
      confidence: 0.95
    }).nextState;
    await saveSeededProfileMemoryState(filePath, Buffer.alloc(32, 7), seededState);

    const hidden = await store.readFacts({
      purpose: "operator_view",
      includeSensitive: true,
      explicitHumanApproval: false
    });
    const review = await store.reviewFactsForUser(
      "email",
      4,
      "2026-04-03T18:25:00.000Z"
    );

    assert.equal(hidden.some((fact) => fact.key === "email.address"), false);
    const emailEntry = review.entries.find((entry) => entry.fact.key === "email.address");
    assert.ok(emailEntry);
    assert.equal(emailEntry?.fact.value, "avery@example.com");
    assert.equal(emailEntry?.fact.sensitive, true);
    assert.equal(emailEntry?.decisionRecord.disposition, "selected_current_state");
  });
});

test("bounded fact review mutations remain deterministic and emit fact-review proof", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_store_fact_mutation_name",
      "My name is Avery.",
      "2026-04-03T18:10:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_store_fact_mutation_context",
      "I know Sarah.",
      "2026-04-03T18:11:00.000Z"
    );

    const reviewed = await store.reviewFactsForUser(
      "Avery Sarah",
      5,
      "2026-04-03T18:12:00.000Z"
    );
    const preferredName = reviewed.entries.find(
      (entry) => entry.fact.key === "identity.preferred_name"
    );
    const contactContext = reviewed.entries.find((entry) =>
      /^contact\.sarah\.context\.[a-f0-9]{8}$/.test(entry.fact.key)
    );

    assert.ok(preferredName);
    assert.ok(contactContext);

    const corrected = await store.mutateFactFromUser({
      factId: preferredName!.fact.factId,
      action: "correct",
      replacementValue: "Ava",
      nowIso: "2026-04-03T18:13:00.000Z",
      sourceTaskId: "memory_fact_correct_1",
      sourceText: "/memory correct fact"
    });

    assert.equal(corrected.fact?.key, "identity.preferred_name");
    assert.equal(corrected.fact?.value, "Ava");
    assert.ok(corrected.mutationEnvelope);
    assert.equal(
      corrected.mutationEnvelope?.requestCorrelation.sourceSurface,
      "memory_review_fact"
    );
    assert.equal(
      corrected.mutationEnvelope?.governanceDecisions[0]?.governanceReason,
      "memory_review_correction_override"
    );
    assert.equal(
      corrected.mutationEnvelope?.retraction?.retractionClass,
      "correction_override"
    );
    const afterCorrectionState = await store.load();
    const correctedGraphObservation = afterCorrectionState.graph.observations.find(
      (observation) =>
        observation.payload.normalizedKey === "identity.preferred_name" &&
        observation.payload.normalizedValue === "Ava" &&
        observation.payload.sourceTaskId === "memory_fact_correct_1"
    );
    const correctedGraphClaimId =
      afterCorrectionState.graph.readModel.currentClaimIdsByKey["identity.preferred_name"];
    const correctedGraphClaim = afterCorrectionState.graph.claims.find(
      (claim) => claim.payload.claimId === correctedGraphClaimId
    );
    const correctionJournalEntry = afterCorrectionState.graph.mutationJournal.entries.find(
      (entry) => entry.sourceTaskId === "memory_fact_correct_1"
    );
    assert.ok(correctedGraphObservation);
    assert.ok(correctedGraphClaim);
    assert.equal(correctedGraphClaim?.payload.normalizedValue, "Ava");
    assert.equal(correctedGraphClaim?.payload.active, true);
    assert.deepEqual(
      correctedGraphClaim?.payload.derivedFromObservationIds,
      [correctedGraphObservation!.payload.observationId]
    );
    assert.ok(correctionJournalEntry);
    assert.deepEqual(
      correctionJournalEntry?.observationIds,
      [correctedGraphObservation!.payload.observationId]
    );
    assert.ok(correctionJournalEntry?.claimIds.includes(correctedGraphClaim!.payload.claimId));
    assert.equal(correctionJournalEntry?.claimIds.length, 2);
    assert.equal(correctionJournalEntry?.mutationEnvelopeHash, sha256HexFromCanonicalJson(
      corrected.mutationEnvelope
    ));

    await assert.rejects(
      () =>
        store.mutateFactFromUser({
          factId: contactContext!.fact.factId,
          action: "correct",
          replacementValue: "Sarah works with me now.",
          nowIso: "2026-04-03T18:14:00.000Z",
          sourceTaskId: "memory_fact_correct_unsupported",
          sourceText: "/memory correct contact context"
        }),
      /does not support correction override/i
    );

    const forgotten = await store.mutateFactFromUser({
      factId: corrected.fact!.factId,
      action: "forget",
      nowIso: "2026-04-03T18:15:00.000Z",
      sourceTaskId: "memory_fact_forget_1",
      sourceText: "/memory forget fact"
    });

    assert.equal(forgotten.fact?.factId, corrected.fact?.factId);
    assert.ok(forgotten.mutationEnvelope);
    assert.equal(
      forgotten.mutationEnvelope?.governanceDecisions[0]?.governanceReason,
      "memory_review_forget_or_delete"
    );
    assert.equal(
      forgotten.mutationEnvelope?.retraction?.retractionClass,
      "forget_or_delete"
    );
    assert.equal(forgotten.mutationEnvelope?.redactionState, "value_redacted");
    const afterForgetState = await store.load();
    const forgottenGraphObservation = afterForgetState.graph.observations.find(
      (observation) =>
        observation.payload.observationId === correctedGraphObservation!.payload.observationId
    );
    const forgottenGraphClaim = afterForgetState.graph.claims.find(
      (claim) => claim.payload.claimId === correctedGraphClaim!.payload.claimId
    );
    const forgetJournalEntry = afterForgetState.graph.mutationJournal.entries.find(
      (entry) => entry.sourceTaskId === "memory_fact_forget_1"
    );
    assert.equal(
      afterForgetState.graph.readModel.currentClaimIdsByKey["identity.preferred_name"],
      undefined
    );
    assert.equal(forgottenGraphObservation?.payload.redactionState, "redacted");
    assert.equal(forgottenGraphObservation?.payload.redactedAt, "2026-04-03T18:15:00.000Z");
    assert.equal(forgottenGraphObservation?.payload.normalizedValue, null);
    assert.equal(forgottenGraphClaim?.payload.redactionState, "redacted");
    assert.equal(forgottenGraphClaim?.payload.redactedAt, "2026-04-03T18:15:00.000Z");
    assert.equal(forgottenGraphClaim?.payload.normalizedValue, null);
    assert.equal(forgottenGraphClaim?.payload.active, false);
    assert.ok(forgetJournalEntry);
    assert.deepEqual(
      forgetJournalEntry?.observationIds,
      [correctedGraphObservation!.payload.observationId]
    );
    assert.ok(forgetJournalEntry?.claimIds.includes(correctedGraphClaim!.payload.claimId));
    assert.equal(forgetJournalEntry?.redactionState, "redacted");
    assert.equal(
      forgetJournalEntry?.mutationEnvelopeHash,
      sha256HexFromCanonicalJson(forgotten.mutationEnvelope)
    );

    const afterForget = await store.reviewFactsForUser(
      "Ava Sarah",
      5,
      "2026-04-03T18:16:00.000Z"
    );
    assert.equal(
      afterForget.entries.some((entry) => entry.fact.key === "identity.preferred_name"),
      false
    );
  });
});

test("relationship-aware temporal nudging role taxonomy suppresses socially distant unresolved-commitment nudges", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_relationship_1",
      "my relationship role is acquaintance",
      "2026-02-23T10:00:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_relationship_2",
      "my todo item is finish taxes",
      "2026-02-23T10:05:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 10
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(evaluation.relationship.role, "acquaintance");
    assert.equal(evaluation.decision.allowed, false);
    assert.equal(evaluation.decision.decisionCode, "RELATIONSHIP_ROLE_SUPPRESSED");
  });
});

test("relationship-aware temporal nudging context drift requires revalidation before allowed nudge", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_drift_1",
      "my manager is Jordan",
      "2026-02-23T08:00:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_drift_2",
      "my job is OldCo",
      "2026-02-23T08:30:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_drift_3",
      "my new job is NewCo",
      "2026-02-23T09:00:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_drift_4",
      "my todo item is finish taxes",
      "2026-02-23T09:10:00.000Z"
    );

    const evaluation = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 10
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(evaluation.relationship.role, "manager");
    assert.equal(evaluation.contextDrift.detected, true);
    assert.equal(evaluation.contextDrift.domains.includes("job"), true);
    assert.equal(evaluation.contextDrift.requiresRevalidation, true);
    assert.equal(evaluation.decision.allowed, true);
    assert.equal(evaluation.decision.decisionCode, "ALLOWED");
  });
});

test("relationship-aware temporal nudging role taxonomy updates behavior after correction-resolved relationship changes", async () => {
  await withProfileStore(async (store) => {
    await store.ingestFromTaskInput(
      "task_profile_relationship_change_1",
      "my relationship role is acquaintance",
      "2026-02-23T10:00:00.000Z"
    );
    await store.ingestFromTaskInput(
      "task_profile_relationship_change_2",
      "my todo item is finish taxes",
      "2026-02-23T10:05:00.000Z"
    );

    const first = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 10
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );
    assert.equal(first.decision.decisionCode, "RELATIONSHIP_ROLE_SUPPRESSED");

    const reviewedFacts = await store.reviewFactsForUser(
      "relationship",
      5,
      "2026-02-23T10:09:00.000Z"
    );
    const relationshipFact = reviewedFacts.entries.find(
      (entry) => entry.fact.key === "relationship.role"
    );
    assert.ok(relationshipFact);

    await store.mutateFactFromUser({
      factId: relationshipFact!.fact.factId,
      action: "correct",
      replacementValue: "friend",
      nowIso: "2026-02-23T10:10:00.000Z",
      sourceTaskId: "task_profile_relationship_change_3",
      sourceText: "/memory fact wrong acquaintance; correct to friend"
    });

    const second = await store.evaluateAgentPulse(
      {
        enabled: true,
        timezoneOffsetMinutes: 0,
        quietHoursStartHourLocal: 22,
        quietHoursEndHourLocal: 8,
        minIntervalMinutes: 10
      },
      {
        nowIso: "2026-02-23T15:00:00.000Z",
        userOptIn: true,
        reason: "unresolved_commitment",
        lastPulseSentAtIso: null
      }
    );

    assert.equal(second.relationship.role, "friend");
    assert.equal(second.decision.allowed, true);
    assert.equal(second.decision.decisionCode, "ALLOWED");
  });
});

test("profile memory load canonicalizes retained flat-fact timestamps and repairs malformed fact lifecycle boundaries", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-04T23:30:00.000Z",
      facts: [
        {
          id: "fact_profile_store_timestamp_normalization_active",
          key: "employment.current",
          value: "Lantern",
          sensitive: false,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_store_timestamp_normalization_active",
          source: "user_input_pattern.work_at",
          observedAt: " 2026-04-04T18:00:00-05:00 ",
          confirmedAt: "   ",
          supersededAt: " 2026-04-04T23:59:00.000Z ",
          lastUpdatedAt: " 2026-04-04T23:10:00+00:00 "
        },
        {
          id: "fact_profile_store_timestamp_normalization_superseded",
          key: "employment.current",
          value: "Northstar",
          sensitive: false,
          status: "superseded",
          confidence: 0.7,
          sourceTaskId: "task_profile_store_timestamp_normalization_superseded",
          source: "user_input_pattern.job_is",
          observedAt: " 2026-04-04T17:30:00-05:00 ",
          confirmedAt: " 2026-04-04T22:00:00+00:00 ",
          supersededAt: "   ",
          lastUpdatedAt: " 2026-04-04T23:20:00+00:00 "
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const activeFact = loaded.facts.find(
      (fact) => fact.id === "fact_profile_store_timestamp_normalization_active"
    );
    const supersededFact = loaded.facts.find(
      (fact) => fact.id === "fact_profile_store_timestamp_normalization_superseded"
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
});

test("profile memory load canonicalizes retained flat-fact semantic and provenance strings", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-04T23:45:00.000Z",
      facts: [
        {
          id: " fact_profile_store_string_normalization ",
          key: " Preferred.Name ",
          value: "  Avery   Quinn  ",
          sensitive: false,
          status: "confirmed",
          confidence: 0.9,
          sourceTaskId: " task_profile_store_string_normalization ",
          source: " User_Input_Pattern.Name_Phrase ",
          observedAt: "2026-04-04T23:40:00.000Z",
          confirmedAt: "2026-04-04T23:41:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-04T23:42:00.000Z"
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const fact = loaded.facts[0];

    assert.equal(fact?.id, "fact_profile_store_string_normalization");
    assert.equal(fact?.key, "identity.preferred_name");
    assert.equal(fact?.value, "Avery Quinn");
    assert.equal(fact?.sourceTaskId, "task_profile_store_string_normalization");
    assert.equal(fact?.source, "user_input_pattern.name_phrase");
  });
});

test("profile memory load canonicalizes retained flat-fact ids and drops blank ids", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-04T23:47:30.000Z",
      facts: [
        {
          id: " fact_profile_store_id_normalization ",
          key: "identity.preferred_name",
          value: "Avery",
          sensitive: false,
          status: "confirmed",
          confidence: 0.9,
          sourceTaskId: "task_profile_store_id_normalization",
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
          sourceTaskId: "task_profile_store_blank_id",
          source: "user_input_pattern.name_phrase",
          observedAt: "2026-04-04T23:39:00.000Z",
          confirmedAt: "2026-04-04T23:39:30.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-04T23:39:45.000Z"
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.facts.length, 1);
    assert.equal(loaded.facts[0]?.id, "fact_profile_store_id_normalization");
  });
});

test("profile memory load dedupes retained flat facts by canonical fact id", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T00:03:00.000Z",
      facts: [
        {
          id: " fact_profile_store_duplicate_id ",
          key: " identity.preferred_name ",
          value: " Avery ",
          sensitive: false,
          status: "uncertain",
          confidence: 0.6,
          sourceTaskId: " task_profile_store_duplicate_id_old ",
          source: " User_Input_Pattern.Name_Phrase ",
          observedAt: "2026-04-05T00:00:00.000Z",
          confirmedAt: null,
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:01:00.000Z"
        },
        {
          id: "fact_profile_store_duplicate_id",
          key: "identity.preferred_name",
          value: "Avery Quinn",
          sensitive: false,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_store_duplicate_id_new",
          source: "user_input_pattern.name_phrase",
          observedAt: "2026-04-05T00:01:30.000Z",
          confirmedAt: "2026-04-05T00:02:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:02:30.000Z"
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.facts.length, 1);
    assert.equal(loaded.facts[0]?.id, "fact_profile_store_duplicate_id");
    assert.equal(loaded.facts[0]?.value, "Avery Quinn");
    assert.equal(
      loaded.facts[0]?.sourceTaskId,
      "task_profile_store_duplicate_id_new"
    );
    assert.equal(loaded.facts[0]?.status, "confirmed");
    assert.equal(loaded.facts[0]?.confidence, 0.95);
  });
});

test("profile memory load repairs semantic-duplicate retained active facts with different ids", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T00:14:00.000Z",
      facts: [
        {
          id: "fact_profile_store_semantic_duplicate_confirmed",
          key: " employment.current ",
          value: " Lantern ",
          sensitive: false,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_store_semantic_duplicate_confirmed",
          source: " user_input_pattern.work_at ",
          observedAt: "2026-04-05T00:10:00.000Z",
          confirmedAt: "2026-04-05T00:11:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:12:00.000Z",
          mutationAudit: {
            classifier: "commitment_signal",
            category: "GENERIC_RESOLUTION",
            confidenceTier: "HIGH",
            matchedRuleId: "commitment_signal_v1_semantic_duplicate_store",
            rulepackVersion: "CommitmentSignalRulepackV1",
            conflict: false
          }
        },
        {
          id: "fact_profile_store_semantic_duplicate_uncertain",
          key: "employment.current",
          value: "Lantern",
          sensitive: true,
          status: "uncertain",
          confidence: 0.6,
          sourceTaskId: "task_profile_store_semantic_duplicate_uncertain",
          source: "user_input_pattern.work_at",
          observedAt: "2026-04-05T00:08:00.000Z",
          confirmedAt: null,
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:13:00.000Z"
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const activeFacts = loaded.facts.filter(
      (fact) => fact.status !== "superseded" && fact.supersededAt === null
    );
    const supersededFact = loaded.facts.find(
      (fact) => fact.id === "fact_profile_store_semantic_duplicate_uncertain"
    );

    assert.equal(loaded.facts.length, 2);
    assert.equal(activeFacts.length, 1);
    assert.equal(activeFacts[0]?.id, "fact_profile_store_semantic_duplicate_confirmed");
    assert.equal(activeFacts[0]?.status, "confirmed");
    assert.equal(activeFacts[0]?.sensitive, true);
    assert.equal(activeFacts[0]?.observedAt, "2026-04-05T00:08:00.000Z");
    assert.equal(activeFacts[0]?.lastUpdatedAt, "2026-04-05T00:13:00.000Z");
    assert.equal(
      activeFacts[0]?.mutationAudit?.matchedRuleId,
      "commitment_signal_v1_semantic_duplicate_store"
    );
    assert.equal(supersededFact?.status, "superseded");
    assert.equal(supersededFact?.supersededAt, "2026-04-05T00:13:00.000Z");
  });
});

test("profile memory load repairs replace-family retained active fact conflicts with different values", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T00:20:00.000Z",
      facts: [
        {
          id: "fact_profile_store_replace_conflict_old",
          key: " identity.preferred_name ",
          value: " Avery ",
          sensitive: false,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_store_replace_conflict_old",
          source: " user_input_pattern.name_phrase ",
          observedAt: "2026-04-05T00:10:00.000Z",
          confirmedAt: "2026-04-05T00:11:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:12:00.000Z"
        },
        {
          id: "fact_profile_store_replace_conflict_new",
          key: "identity.preferred_name",
          value: "Ava",
          sensitive: false,
          status: "uncertain",
          confidence: 0.6,
          sourceTaskId: "task_profile_store_replace_conflict_new",
          source: "user_input_pattern.name_phrase",
          observedAt: "2026-04-05T00:13:00.000Z",
          confirmedAt: null,
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:14:00.000Z"
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const activeFacts = loaded.facts.filter(
      (fact) => fact.status !== "superseded" && fact.supersededAt === null
    );
    const supersededFact = loaded.facts.find(
      (fact) => fact.id === "fact_profile_store_replace_conflict_old"
    );

    assert.equal(loaded.facts.length, 2);
    assert.equal(activeFacts.length, 1);
    assert.equal(activeFacts[0]?.id, "fact_profile_store_replace_conflict_new");
    assert.equal(activeFacts[0]?.key, "identity.preferred_name");
    assert.equal(activeFacts[0]?.value, "Ava");
    assert.equal(activeFacts[0]?.status, "uncertain");
    assert.equal(supersededFact?.status, "superseded");
    assert.equal(supersededFact?.supersededAt, "2026-04-05T00:14:00.000Z");
  });
});

test("profile memory load repairs preserve-prior retained active fact conflicts with multiple confirmed winners", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T00:30:00.000Z",
      facts: [
        {
          id: "fact_profile_store_preserve_conflict_old",
          key: " employment.current ",
          value: " Pro-Green ",
          sensitive: false,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_store_preserve_conflict_old",
          source: " user_input_pattern.work_at ",
          observedAt: "2026-04-05T00:10:00.000Z",
          confirmedAt: "2026-04-05T00:11:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:12:00.000Z"
        },
        {
          id: "fact_profile_store_preserve_conflict_new",
          key: "employment.current",
          value: "Lantern",
          sensitive: false,
          status: "confirmed",
          confidence: 0.99,
          sourceTaskId: "task_profile_store_preserve_conflict_new",
          source: "user_input_pattern.work_at",
          observedAt: "2026-04-05T00:13:00.000Z",
          confirmedAt: "2026-04-05T00:14:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:15:00.000Z"
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const activeFacts = loaded.facts.filter(
      (fact) => fact.status !== "superseded" && fact.supersededAt === null
    );
    const confirmedFacts = activeFacts.filter((fact) => fact.status === "confirmed");
    const uncertainFacts = activeFacts.filter((fact) => fact.status === "uncertain");
    const downgradedFact = loaded.facts.find(
      (fact) => fact.id === "fact_profile_store_preserve_conflict_new"
    );

    assert.equal(loaded.facts.length, 2);
    assert.equal(activeFacts.length, 2);
    assert.equal(confirmedFacts.length, 1);
    assert.equal(uncertainFacts.length, 1);
    assert.equal(confirmedFacts[0]?.id, "fact_profile_store_preserve_conflict_old");
    assert.equal(confirmedFacts[0]?.key, "employment.current");
    assert.equal(confirmedFacts[0]?.value, "Pro-Green");
    assert.equal(downgradedFact?.status, "uncertain");
    assert.equal(downgradedFact?.confirmedAt, null);
    assert.equal(downgradedFact?.supersededAt, null);
    assert.equal(downgradedFact?.lastUpdatedAt, "2026-04-05T00:15:00.000Z");
  });
});

test("profile memory load repairs mixed-policy retained active fact conflicts into a live-upsert-valid shape", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T00:40:00.000Z",
      facts: [
        {
          id: "fact_profile_store_mixed_policy_pending",
          key: " followup.tax.filing ",
          value: " pending ",
          sensitive: false,
          status: "confirmed",
          confidence: 0.95,
          sourceTaskId: "task_profile_store_mixed_policy_pending",
          source: " user_input_pattern.my_is ",
          observedAt: "2026-04-05T00:10:00.000Z",
          confirmedAt: "2026-04-05T00:11:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:11:00.000Z"
        },
        {
          id: "fact_profile_store_mixed_policy_resolved",
          key: "followup.tax.filing",
          value: "resolved",
          sensitive: false,
          status: "confirmed",
          confidence: 0.99,
          sourceTaskId: "task_profile_store_mixed_policy_resolved",
          source: "user_input_pattern.followup_resolved",
          observedAt: "2026-04-05T00:12:00.000Z",
          confirmedAt: "2026-04-05T00:13:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:13:00.000Z"
        },
        {
          id: "fact_profile_store_mixed_policy_challenger",
          key: "followup.tax.filing",
          value: "waiting_on_refund",
          sensitive: false,
          status: "confirmed",
          confidence: 0.7,
          sourceTaskId: "task_profile_store_mixed_policy_challenger",
          source: "user_input_pattern.my_is",
          observedAt: "2026-04-05T00:14:00.000Z",
          confirmedAt: "2026-04-05T00:15:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:15:00.000Z"
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const activeFacts = loaded.facts.filter(
      (fact) => fact.status !== "superseded" && fact.supersededAt === null
    );
    const resolvedFact = loaded.facts.find(
      (fact) => fact.id === "fact_profile_store_mixed_policy_resolved"
    );
    const challengerFact = loaded.facts.find(
      (fact) => fact.id === "fact_profile_store_mixed_policy_challenger"
    );
    const supersededPendingFact = loaded.facts.find(
      (fact) => fact.id === "fact_profile_store_mixed_policy_pending"
    );

    assert.equal(loaded.facts.length, 3);
    assert.equal(activeFacts.length, 1);
    assert.equal(activeFacts[0]?.id, "fact_profile_store_mixed_policy_resolved");
    assert.equal(resolvedFact?.status, "confirmed");
    assert.equal(resolvedFact?.confirmedAt, "2026-04-05T00:13:00.000Z");
    assert.equal(challengerFact?.status, "superseded");
    assert.notEqual(challengerFact?.supersededAt, null);
    assert.equal(supersededPendingFact?.status, "superseded");
    assert.equal(supersededPendingFact?.supersededAt, "2026-04-05T00:13:00.000Z");
  });
});

test("profile memory load suppresses preserve-prior graph current claims when only uncertain conflicting facts remain", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T00:40:00.000Z",
      facts: [
        {
          id: "fact_profile_store_preserve_no_winner_1",
          key: "employment.current",
          value: "Lantern",
          sensitive: false,
          status: "uncertain",
          confidence: 0.6,
          sourceTaskId: "task_profile_store_preserve_no_winner_1",
          source: "user_input_pattern.work_at",
          observedAt: "2026-04-05T00:10:00.000Z",
          confirmedAt: null,
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:11:00.000Z"
        },
        {
          id: "fact_profile_store_preserve_no_winner_2",
          key: "employment.current",
          value: "Northstar",
          sensitive: false,
          status: "uncertain",
          confidence: 0.7,
          sourceTaskId: "task_profile_store_preserve_no_winner_2",
          source: "user_input_pattern.job_is",
          observedAt: "2026-04-05T00:12:00.000Z",
          confirmedAt: null,
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:13:00.000Z"
        }
      ],
      graph: {
        ...emptyState.graph,
        updatedAt: "2026-04-05T00:39:00.000Z",
        observations: [],
        claims: [
          createGraphClaimEnvelope({
            claimId: "claim_profile_store_preserve_no_winner_stale",
            stableRefId: null,
            family: "employment.current",
            normalizedKey: "employment.current",
            normalizedValue: "OldCo",
            redactionState: "not_requested",
            redactedAt: null,
            sensitive: false,
            sourceTaskId: "task_profile_store_preserve_no_winner_stale",
            sourceFingerprint: "fingerprint_profile_store_preserve_no_winner_stale",
            sourceTier: "explicit_user_statement",
            assertedAt: "2026-04-05T00:00:00.000Z",
            validFrom: "2026-04-05T00:00:00.000Z",
            validTo: null,
            endedAt: null,
            endedByClaimId: null,
            timePrecision: "instant",
            timeSource: "user_stated",
            derivedFromObservationIds: [],
            projectionSourceIds: ["fact_profile_store_preserve_no_winner_stale"],
            entityRefIds: [],
            active: true
          })
        ],
        mutationJournal: {
          schemaVersion: "v1",
          nextWatermark: 1,
          entries: []
        }
      }
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const activeClaims = loaded.graph.claims.filter((claim) => claim.payload.active);
    const closedClaim = loaded.graph.claims.find(
      (claim) => claim.payload.claimId === "claim_profile_store_preserve_no_winner_stale"
    );

    assert.equal(loaded.graph.observations.length, 2);
    assert.equal(activeClaims.length, 0);
    assert.equal(closedClaim?.payload.active, false);
    assert.equal(closedClaim?.payload.endedByClaimId, null);
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["employment.current"],
      undefined
    );
  });
});

test("profile memory load drops retained flat facts whose normalized key or value is blank", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T00:05:00.000Z",
      facts: [
        {
          id: "fact_profile_store_blank_semantics_keep",
          key: " identity.preferred_name ",
          value: " Avery ",
          sensitive: false,
          status: "confirmed",
          confidence: 0.9,
          sourceTaskId: "task_profile_store_blank_semantics_keep",
          source: "user_input_pattern.name_phrase",
          observedAt: "2026-04-05T00:00:00.000Z",
          confirmedAt: "2026-04-05T00:01:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:02:00.000Z"
        },
        {
          id: "fact_profile_store_blank_semantics_key_drop",
          key: " !!! ",
          value: "KeepMe",
          sensitive: false,
          status: "confirmed",
          confidence: 0.8,
          sourceTaskId: "task_profile_store_blank_semantics_key_drop",
          source: "user_input_pattern.name_phrase",
          observedAt: "2026-04-05T00:00:30.000Z",
          confirmedAt: "2026-04-05T00:01:30.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:02:30.000Z"
        },
        {
          id: "fact_profile_store_blank_semantics_value_drop",
          key: "identity.preferred_name",
          value: "   ",
          sensitive: false,
          status: "confirmed",
          confidence: 0.7,
          sourceTaskId: "task_profile_store_blank_semantics_value_drop",
          source: "user_input_pattern.name_phrase",
          observedAt: "2026-04-05T00:00:45.000Z",
          confirmedAt: "2026-04-05T00:01:45.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:02:45.000Z"
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.facts.length, 1);
    assert.equal(loaded.facts[0]?.id, "fact_profile_store_blank_semantics_keep");
    assert.equal(loaded.facts[0]?.key, "identity.preferred_name");
    assert.equal(loaded.facts[0]?.value, "Avery");
  });
});

test("profile memory load drops retained flat facts whose required provenance normalizes blank", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T00:12:00.000Z",
      facts: [
        {
          id: "fact_profile_store_blank_provenance_keep",
          key: "identity.preferred_name",
          value: "Avery",
          sensitive: false,
          status: "confirmed",
          confidence: 0.9,
          sourceTaskId: " task_profile_store_blank_provenance_keep ",
          source: " User_Input_Pattern.Name_Phrase ",
          observedAt: "2026-04-05T00:07:00.000Z",
          confirmedAt: "2026-04-05T00:08:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:09:00.000Z"
        },
        {
          id: "fact_profile_store_blank_provenance_task_drop",
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
          id: "fact_profile_store_blank_provenance_source_drop",
          key: "identity.preferred_name",
          value: "DropSource",
          sensitive: false,
          status: "confirmed",
          confidence: 0.7,
          sourceTaskId: "task_profile_store_blank_provenance_source_drop",
          source: "   ",
          observedAt: "2026-04-05T00:07:45.000Z",
          confirmedAt: "2026-04-05T00:08:45.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:09:45.000Z"
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.facts.length, 1);
    assert.equal(loaded.facts[0]?.id, "fact_profile_store_blank_provenance_keep");
    assert.equal(
      loaded.facts[0]?.sourceTaskId,
      "task_profile_store_blank_provenance_keep"
    );
    assert.equal(loaded.facts[0]?.source, "user_input_pattern.name_phrase");
  });
});

test("profile memory load drops retained flat facts whose source authority is quarantined", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T00:13:00.000Z",
      facts: [
        {
          id: "fact_profile_store_supported_current_source",
          key: "identity.preferred_name",
          value: "Avery",
          sensitive: false,
          status: "confirmed",
          confidence: 0.9,
          sourceTaskId: "task_profile_store_supported_current_source",
          source: " user_input_pattern.name_phrase ",
          observedAt: "2026-04-05T00:08:00.000Z",
          confirmedAt: "2026-04-05T00:09:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:10:00.000Z"
        },
        {
          id: "fact_profile_store_supported_support_source",
          key: "employment.current",
          value: "Northstar",
          sensitive: false,
          status: "superseded",
          confidence: 0.5,
          sourceTaskId: "task_profile_store_supported_support_source",
          source: " user_input_pattern.work_at_historical ",
          observedAt: "2026-04-05T00:07:30.000Z",
          confirmedAt: "2026-04-05T00:08:30.000Z",
          supersededAt: "2026-04-05T00:09:30.000Z",
          lastUpdatedAt: "2026-04-05T00:10:30.000Z"
        },
        {
          id: "fact_profile_store_quarantined_source",
          key: "identity.preferred_name",
          value: "DropMe",
          sensitive: false,
          status: "confirmed",
          confidence: 0.7,
          sourceTaskId: "task_profile_store_quarantined_source",
          source: " user_input_pattern.preference_statement ",
          observedAt: "2026-04-05T00:08:45.000Z",
          confirmedAt: "2026-04-05T00:09:45.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:10:45.000Z"
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(
      loaded.facts.some((fact) => fact.id === "fact_profile_store_supported_current_source"),
      true
    );
    assert.equal(
      loaded.facts.some((fact) => fact.id === "fact_profile_store_supported_support_source"),
      true
    );
    assert.equal(
      loaded.facts.some((fact) => fact.id === "fact_profile_store_quarantined_source"),
      false
    );
  });
});

test("profile memory load applies family sensitivity floors to retained flat facts", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T00:14:00.000Z",
      facts: [
        {
          id: "fact_profile_store_sensitive_floor_residence",
          key: " residence.current ",
          value: " Seattle ",
          sensitive: false,
          status: "confirmed",
          confidence: 0.9,
          sourceTaskId: "task_profile_store_sensitive_floor_residence",
          source: "user_input_pattern.residence",
          observedAt: "2026-04-05T00:10:00.000Z",
          confirmedAt: "2026-04-05T00:11:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:12:00.000Z"
        },
        {
          id: "fact_profile_store_sensitive_floor_identity",
          key: " identity.preferred_name ",
          value: " Avery ",
          sensitive: false,
          status: "confirmed",
          confidence: 0.8,
          sourceTaskId: "task_profile_store_sensitive_floor_identity",
          source: "user_input_pattern.name_phrase",
          observedAt: "2026-04-05T00:10:30.000Z",
          confirmedAt: "2026-04-05T00:11:30.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-05T00:12:30.000Z"
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const residenceFact = loaded.facts.find(
      (fact) => fact.id === "fact_profile_store_sensitive_floor_residence"
    );
    const identityFact = loaded.facts.find(
      (fact) => fact.id === "fact_profile_store_sensitive_floor_identity"
    );

    assert.equal(residenceFact?.key, "residence.current");
    assert.equal(residenceFact?.sensitive, true);
    assert.equal(identityFact?.key, "identity.preferred_name");
    assert.equal(identityFact?.sensitive, false);
  });
});

test("profile memory load clears retained mutation audit metadata when rule ids normalize blank", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T00:18:00.000Z",
      facts: [
        {
          id: "fact_profile_store_mutation_audit_keep",
          key: "followup.launch",
          value: "resolved",
          sensitive: false,
          status: "confirmed",
          confidence: 0.9,
          sourceTaskId: "task_profile_store_mutation_audit_keep",
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
          id: "fact_profile_store_mutation_audit_drop",
          key: "followup.launch",
          value: "resolved",
          sensitive: false,
          status: "confirmed",
          confidence: 0.7,
          sourceTaskId: "task_profile_store_mutation_audit_drop",
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
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const keptFact = loaded.facts.find(
      (fact) => fact.id === "fact_profile_store_mutation_audit_keep"
    );
    const droppedFact = loaded.facts.find(
      (fact) => fact.id === "fact_profile_store_mutation_audit_drop"
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
});

test("profile memory load canonicalizes retained mutation audit enums before keeping audit metadata", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T00:21:00.000Z",
      facts: [
        {
          id: "fact_profile_store_mutation_audit_enum_normalization",
          key: "followup.launch",
          value: "resolved",
          sensitive: false,
          status: "confirmed",
          confidence: 0.9,
          sourceTaskId: "task_profile_store_mutation_audit_enum_normalization",
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
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const fact = loaded.facts[0];

    assert.equal(fact?.mutationAudit?.classifier, "commitment_signal");
    assert.equal(fact?.mutationAudit?.category, "GENERIC_RESOLUTION");
    assert.equal(fact?.mutationAudit?.confidenceTier, "HIGH");
  });
});

test("profile memory load canonicalizes retained flat-fact status strings and drops unknown statuses", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-04T23:50:00.000Z",
      facts: [
        {
          id: "fact_profile_store_status_normalization_confirmed",
          key: "employment.current",
          value: "Lantern",
          sensitive: false,
          status: " Confirmed ",
          confidence: 0.95,
          sourceTaskId: "task_profile_store_status_normalization_confirmed",
          source: "user_input_pattern.work_at",
          observedAt: "2026-04-04T23:40:00.000Z",
          confirmedAt: "   ",
          supersededAt: null,
          lastUpdatedAt: "2026-04-04T23:41:00.000Z"
        },
        {
          id: "fact_profile_store_status_normalization_superseded",
          key: "employment.current",
          value: "Northstar",
          sensitive: false,
          status: " SUPERSEDED ",
          confidence: 0.7,
          sourceTaskId: "task_profile_store_status_normalization_superseded",
          source: "user_input_pattern.job_is",
          observedAt: "2026-04-04T23:39:00.000Z",
          confirmedAt: null,
          supersededAt: "   ",
          lastUpdatedAt: "2026-04-04T23:42:00.000Z"
        },
        {
          id: "fact_profile_store_status_normalization_invalid",
          key: "employment.current",
          value: "BadStatus",
          sensitive: false,
          status: " pending ",
          confidence: 0.5,
          sourceTaskId: "task_profile_store_status_normalization_invalid",
          source: "user_input_pattern.job_is",
          observedAt: "2026-04-04T23:38:00.000Z",
          confirmedAt: null,
          supersededAt: null,
          lastUpdatedAt: "2026-04-04T23:43:00.000Z"
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const confirmedFact = loaded.facts.find(
      (fact) => fact.id === "fact_profile_store_status_normalization_confirmed"
    );
    const supersededFact = loaded.facts.find(
      (fact) => fact.id === "fact_profile_store_status_normalization_superseded"
    );

    assert.equal(loaded.facts.length, 2);
    assert.equal(confirmedFact?.status, "confirmed");
    assert.equal(confirmedFact?.confirmedAt, "2026-04-04T23:41:00.000Z");
    assert.equal(supersededFact?.status, "superseded");
    assert.equal(supersededFact?.supersededAt, "2026-04-04T23:42:00.000Z");
    assert.equal(
      loaded.facts.some((fact) => fact.id === "fact_profile_store_status_normalization_invalid"),
      false
    );
  });
});

test("profile memory load fail-closes malformed retained flat-fact confidence on the compatibility lane", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-04T23:55:00.000Z",
      facts: [
        {
          id: "fact_profile_store_confidence_normalization",
          key: "identity.preferred_name",
          value: "Avery",
          sensitive: false,
          status: "confirmed",
          confidence: 99,
          sourceTaskId: "task_profile_store_confidence_normalization",
          source: "user_input_pattern.name_phrase",
          observedAt: "2026-04-04T23:50:00.000Z",
          confirmedAt: "2026-04-04T23:51:00.000Z",
          supersededAt: null,
          lastUpdatedAt: "2026-04-04T23:52:00.000Z"
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const fact = loaded.facts[0];

    assert.equal(fact?.confidence, 0);
  });
});

test("profile memory load canonicalizes retained ingest receipts for reload-safe idempotency", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const expectedReceiptKey = buildProfileMemoryIngestReceiptKey({
      sourceSurface: "conversation_profile_input",
      turnId: "turn_profile_store_receipt_normalization",
      sourceFingerprint: "fingerprint_profile_store_receipt_normalization"
    });
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T00:15:00.000Z",
      ingestReceipts: [
        {
          receiptKey: " receipt_profile_store_receipt_raw ",
          turnId: " turn_profile_store_receipt_normalization ",
          sourceFingerprint: " fingerprint_profile_store_receipt_normalization ",
          sourceTaskId: " task_profile_store_receipt_normalization ",
          recordedAt: " 2026-04-05T00:05:00+00:00 "
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.ingestReceipts[0]?.receiptKey, expectedReceiptKey);
    assert.equal(loaded.ingestReceipts[0]?.turnId, "turn_profile_store_receipt_normalization");
    assert.equal(
      loaded.ingestReceipts[0]?.sourceFingerprint,
      "fingerprint_profile_store_receipt_normalization"
    );
    assert.equal(
      loaded.ingestReceipts[0]?.sourceTaskId,
      "task_profile_store_receipt_normalization"
    );
    assert.equal(loaded.ingestReceipts[0]?.recordedAt, "2026-04-05T00:05:00.000Z");
    assert.ok(findProfileMemoryIngestReceipt(loaded, {
      sourceSurface: "conversation_profile_input",
      turnId: "turn_profile_store_receipt_normalization",
      sourceFingerprint: "fingerprint_profile_store_receipt_normalization"
    }));
  });
});

test("profile memory load dedupes and caps retained ingest receipts after canonicalization", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const duplicateReceiptKey = buildProfileMemoryIngestReceiptKey({
      sourceSurface: "conversation_profile_input",
      turnId: "turn_profile_store_receipt_cap_1",
      sourceFingerprint: "fingerprint_profile_store_receipt_cap_1"
    });
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T00:30:00.000Z",
      ingestReceipts: [
        ...Array.from({ length: MAX_PROFILE_MEMORY_INGEST_RECEIPTS + 1 }, (_, index) => ({
          receiptKey: ` receipt_profile_store_receipt_cap_${index} `,
          turnId: ` turn_profile_store_receipt_cap_${index} `,
          sourceFingerprint: ` fingerprint_profile_store_receipt_cap_${index} `,
          sourceTaskId: ` task_profile_store_receipt_cap_${index} `,
          recordedAt:
            `2026-04-05T${String(Math.floor(index / 60)).padStart(2, "0")}:` +
            `${String(index % 60).padStart(2, "0")}:00.000Z`
        })),
        {
          receiptKey: " receipt_profile_store_receipt_cap_duplicate ",
          turnId: " turn_profile_store_receipt_cap_1 ",
          sourceFingerprint: " fingerprint_profile_store_receipt_cap_1 ",
          sourceTaskId: " task_profile_store_receipt_cap_duplicate_latest ",
          recordedAt: "2026-04-05T23:59:00.000Z"
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.ingestReceipts.length, MAX_PROFILE_MEMORY_INGEST_RECEIPTS);
    assert.equal(
      loaded.ingestReceipts.some((receipt) => receipt.turnId === "turn_profile_store_receipt_cap_0"),
      false
    );
    assert.equal(lastItem(loaded.ingestReceipts)?.receiptKey, duplicateReceiptKey);
    assert.equal(
      lastItem(loaded.ingestReceipts)?.sourceTaskId,
      "task_profile_store_receipt_cap_duplicate_latest"
    );
    assert.equal(
      loaded.ingestReceipts.filter((receipt) => receipt.receiptKey === duplicateReceiptKey).length,
      1
    );
  });
});

test("profile memory load recovers retained ingest receipts when only stored receiptKey is malformed", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const expectedReceiptKey = buildProfileMemoryIngestReceiptKey({
      sourceSurface: "conversation_profile_input",
      turnId: "turn_profile_store_receipt_recovery",
      sourceFingerprint: "fingerprint_profile_store_receipt_recovery"
    });
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T00:45:00.000Z",
      ingestReceipts: [
        {
          turnId: " turn_profile_store_receipt_recovery ",
          sourceFingerprint: " fingerprint_profile_store_receipt_recovery ",
          sourceTaskId: " task_profile_store_receipt_recovery ",
          recordedAt: " 2026-04-05T00:35:00+00:00 "
        }
      ]
    };
    await saveSeededProfileMemoryState(
      filePath,
      encryptionKey,
      seededState as unknown as typeof emptyState
    );

    const loaded = await store.load();

    assert.equal(loaded.ingestReceipts.length, 1);
    assert.equal(loaded.ingestReceipts[0]?.receiptKey, expectedReceiptKey);
    assert.equal(loaded.ingestReceipts[0]?.turnId, "turn_profile_store_receipt_recovery");
    assert.equal(
      loaded.ingestReceipts[0]?.sourceFingerprint,
      "fingerprint_profile_store_receipt_recovery"
    );
    assert.equal(
      loaded.ingestReceipts[0]?.sourceTaskId,
      "task_profile_store_receipt_recovery"
    );
  });
});

test("profile memory load recovers retained ingest receipts when only stored recordedAt is malformed", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const expectedReceiptKey = buildProfileMemoryIngestReceiptKey({
      sourceSurface: "conversation_profile_input",
      turnId: "turn_profile_store_receipt_recorded_at_recovery",
      sourceFingerprint: "fingerprint_profile_store_receipt_recorded_at_recovery"
    });
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T01:00:00.000Z",
      ingestReceipts: [
        {
          receiptKey: " receipt_profile_store_receipt_recorded_at_recovery ",
          turnId: " turn_profile_store_receipt_recorded_at_recovery ",
          sourceFingerprint: " fingerprint_profile_store_receipt_recorded_at_recovery ",
          sourceTaskId: " task_profile_store_receipt_recorded_at_recovery "
        }
      ]
    };
    await saveSeededProfileMemoryState(
      filePath,
      encryptionKey,
      seededState as unknown as typeof emptyState
    );

    const loaded = await store.load();

    assert.equal(loaded.ingestReceipts.length, 1);
    assert.equal(loaded.ingestReceipts[0]?.receiptKey, expectedReceiptKey);
    assert.equal(
      loaded.ingestReceipts[0]?.turnId,
      "turn_profile_store_receipt_recorded_at_recovery"
    );
    assert.equal(
      loaded.ingestReceipts[0]?.sourceFingerprint,
      "fingerprint_profile_store_receipt_recorded_at_recovery"
    );
    assert.equal(
      loaded.ingestReceipts[0]?.sourceTaskId,
      "task_profile_store_receipt_recorded_at_recovery"
    );
    assert.equal(loaded.ingestReceipts[0]?.recordedAt, "2026-04-05T01:00:00.000Z");
  });
});

test("profile memory load keeps the newest retained duplicate receipt by canonical recordedAt", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const expectedReceiptKey = buildProfileMemoryIngestReceiptKey({
      sourceSurface: "conversation_profile_input",
      turnId: "turn_profile_store_receipt_duplicate_recency",
      sourceFingerprint: "fingerprint_profile_store_receipt_duplicate_recency"
    });
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T01:10:00.000Z",
      ingestReceipts: [
        {
          receiptKey: " receipt_profile_store_receipt_duplicate_recency_newer ",
          turnId: " turn_profile_store_receipt_duplicate_recency ",
          sourceFingerprint: " fingerprint_profile_store_receipt_duplicate_recency ",
          sourceTaskId: " task_profile_store_receipt_duplicate_recency_newer ",
          recordedAt: " 2026-04-05T01:09:00+00:00 "
        },
        {
          receiptKey: " receipt_profile_store_receipt_duplicate_recency_older ",
          turnId: " turn_profile_store_receipt_duplicate_recency ",
          sourceFingerprint: " fingerprint_profile_store_receipt_duplicate_recency ",
          sourceTaskId: " task_profile_store_receipt_duplicate_recency_older ",
          recordedAt: " 2026-04-05T00:09:00+00:00 "
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.ingestReceipts.length, 1);
    assert.equal(loaded.ingestReceipts[0]?.receiptKey, expectedReceiptKey);
    assert.equal(
      loaded.ingestReceipts[0]?.sourceTaskId,
      "task_profile_store_receipt_duplicate_recency_newer"
    );
    assert.equal(loaded.ingestReceipts[0]?.recordedAt, "2026-04-05T01:09:00.000Z");
  });
});

test("profile memory load recovers retained ingest receipts when only stored sourceTaskId is malformed", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const expectedReceiptKey = buildProfileMemoryIngestReceiptKey({
      sourceSurface: "conversation_profile_input",
      turnId: "turn_profile_store_receipt_source_task_recovery",
      sourceFingerprint: "fingerprint_profile_store_receipt_source_task_recovery"
    });
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T01:20:00.000Z",
      ingestReceipts: [
        {
          receiptKey: " receipt_profile_store_receipt_source_task_recovery ",
          turnId: " turn_profile_store_receipt_source_task_recovery ",
          sourceFingerprint: " fingerprint_profile_store_receipt_source_task_recovery ",
          sourceTaskId: "   ",
          recordedAt: " 2026-04-05T01:19:00+00:00 "
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.ingestReceipts.length, 1);
    assert.equal(loaded.ingestReceipts[0]?.receiptKey, expectedReceiptKey);
    assert.equal(
      loaded.ingestReceipts[0]?.sourceTaskId,
      `profile_ingest_receipt_recovered_${expectedReceiptKey!.slice(-24)}`
    );
    assert.equal(loaded.ingestReceipts[0]?.recordedAt, "2026-04-05T01:19:00.000Z");
  });
});

test("profile memory load recovers retained ingest receipts when only stored turnId and sourceFingerprint are malformed", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const expectedReceiptKey = buildProfileMemoryIngestReceiptKey({
      sourceSurface: "conversation_profile_input",
      turnId: "turn_profile_store_receipt_provenance_recovery",
      sourceFingerprint: "fingerprint_profile_store_receipt_provenance_recovery"
    });
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T01:25:00.000Z",
      ingestReceipts: [
        {
          receiptKey: ` ${expectedReceiptKey} `,
          turnId: "   ",
          sourceFingerprint: "   ",
          sourceTaskId: " task_profile_store_receipt_provenance_recovery ",
          recordedAt: " 2026-04-05T01:24:00+00:00 "
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();
    const reloaded = await store.load();

    assert.equal(loaded.ingestReceipts.length, 1);
    assert.equal(loaded.ingestReceipts[0]?.receiptKey, expectedReceiptKey);
    assert.equal(
      loaded.ingestReceipts[0]?.turnId,
      `profile_ingest_receipt_turn_recovered_${expectedReceiptKey!.slice(-24)}`
    );
    assert.equal(
      loaded.ingestReceipts[0]?.sourceFingerprint,
      `profile_ingest_receipt_fingerprint_recovered_${expectedReceiptKey!.slice(-24)}`
    );
    assert.equal(
      loaded.ingestReceipts[0]?.sourceTaskId,
      "task_profile_store_receipt_provenance_recovery"
    );
    assert.equal(loaded.ingestReceipts[0]?.recordedAt, "2026-04-05T01:24:00.000Z");
    assert.deepEqual(reloaded.ingestReceipts, loaded.ingestReceipts);
  });
});

test("profile memory load prefers explicit retained turn and fingerprint provenance when canonical recordedAt ties", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const explicitTurnId = "alpha_turn_profile_store_receipt_metadata_strength";
    const explicitSourceFingerprint =
      "alpha_fingerprint_profile_store_receipt_metadata_strength";
    const expectedReceiptKey = buildProfileMemoryIngestReceiptKey({
      sourceSurface: "conversation_profile_input",
      turnId: explicitTurnId,
      sourceFingerprint: explicitSourceFingerprint
    });
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T01:40:00.000Z",
      ingestReceipts: [
        {
          receiptKey: ` ${expectedReceiptKey} `,
          turnId: "   ",
          sourceFingerprint: "   ",
          sourceTaskId: " task_profile_store_receipt_metadata_strength ",
          recordedAt: " 2026-04-05T01:39:00+00:00 "
        },
        {
          receiptKey: " receipt_profile_store_receipt_metadata_strength_explicit ",
          turnId: ` ${explicitTurnId} `,
          sourceFingerprint: ` ${explicitSourceFingerprint} `,
          sourceTaskId: " task_profile_store_receipt_metadata_strength ",
          recordedAt: " 2026-04-04T20:39:00-05:00 "
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.ingestReceipts.length, 1);
    assert.equal(loaded.ingestReceipts[0]?.receiptKey, expectedReceiptKey);
    assert.equal(loaded.ingestReceipts[0]?.turnId, explicitTurnId);
    assert.equal(
      loaded.ingestReceipts[0]?.sourceFingerprint,
      explicitSourceFingerprint
    );
    assert.equal(
      loaded.ingestReceipts[0]?.sourceTaskId,
      "task_profile_store_receipt_metadata_strength"
    );
    assert.equal(loaded.ingestReceipts[0]?.recordedAt, "2026-04-05T01:39:00.000Z");
  });
});

test("profile memory load prefers stronger retained duplicate receipt provenance when canonical recordedAt ties", async () => {
  await withProfileStore(async (store, filePath) => {
    const encryptionKey = Buffer.alloc(32, 7);
    const expectedReceiptKey = buildProfileMemoryIngestReceiptKey({
      sourceSurface: "conversation_profile_input",
      turnId: "turn_profile_store_receipt_duplicate_provenance",
      sourceFingerprint: "fingerprint_profile_store_receipt_duplicate_provenance"
    });
    const emptyState = createEmptyProfileMemoryState();
    const seededState = {
      ...emptyState,
      updatedAt: "2026-04-05T01:30:00.000Z",
      ingestReceipts: [
        {
          receiptKey: " receipt_profile_store_receipt_duplicate_provenance_explicit ",
          turnId: " turn_profile_store_receipt_duplicate_provenance ",
          sourceFingerprint: " fingerprint_profile_store_receipt_duplicate_provenance ",
          sourceTaskId: " task_profile_store_receipt_duplicate_provenance_explicit ",
          recordedAt: " 2026-04-05T01:29:00+00:00 "
        },
        {
          receiptKey: " receipt_profile_store_receipt_duplicate_provenance_recovered ",
          turnId: " turn_profile_store_receipt_duplicate_provenance ",
          sourceFingerprint: " fingerprint_profile_store_receipt_duplicate_provenance ",
          sourceTaskId: "   ",
          recordedAt: " 2026-04-04T20:29:00-05:00 "
        }
      ]
    };
    await saveSeededProfileMemoryState(filePath, encryptionKey, seededState);

    const loaded = await store.load();

    assert.equal(loaded.ingestReceipts.length, 1);
    assert.equal(loaded.ingestReceipts[0]?.receiptKey, expectedReceiptKey);
    assert.equal(
      loaded.ingestReceipts[0]?.sourceTaskId,
      "task_profile_store_receipt_duplicate_provenance_explicit"
    );
    assert.equal(loaded.ingestReceipts[0]?.recordedAt, "2026-04-05T01:29:00.000Z");
  });
});

