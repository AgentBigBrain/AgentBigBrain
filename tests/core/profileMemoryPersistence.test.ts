/**
 * @fileoverview Tests profile-memory runtime persistence helpers for env config and encrypted disk round-trips.
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
  upsertTemporalProfileFact
} from "../../src/core/profileMemory";
import {
  createProfileMemoryPersistenceConfigFromEnv,
  loadPersistedProfileMemoryState,
  saveProfileMemoryState
} from "../../src/core/profileMemoryRuntime/profileMemoryPersistence";

test("createProfileMemoryPersistenceConfigFromEnv returns undefined when profile memory is disabled", () => {
  const config = createProfileMemoryPersistenceConfigFromEnv({});
  assert.equal(config, undefined);
});

test("createProfileMemoryPersistenceConfigFromEnv normalizes enabled profile-memory config", () => {
  const key = Buffer.alloc(32, 3).toString("base64");
  const config = createProfileMemoryPersistenceConfigFromEnv({
    BRAIN_PROFILE_MEMORY_ENABLED: "true",
    BRAIN_PROFILE_ENCRYPTION_KEY: key,
    BRAIN_PROFILE_MEMORY_PATH: "runtime/custom-profile.json",
    BRAIN_PROFILE_STALE_AFTER_DAYS: "45"
  });

  assert.ok(config);
  assert.equal(config?.filePath, "runtime/custom-profile.json");
  assert.equal(config?.staleAfterDays, 45);
  assert.equal(config?.encryptionKey.equals(Buffer.from(key, "base64")), true);
});

test("loadPersistedProfileMemoryState returns empty state when the encrypted file is missing", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-profile-persist-"));
  const filePath = path.join(tempDir, "profile_memory.secure.json");
  const encryptionKey = Buffer.alloc(32, 5);

  try {
    const state = await loadPersistedProfileMemoryState(filePath, encryptionKey);
    assert.equal(state.facts.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("saveProfileMemoryState and loadPersistedProfileMemoryState round-trip encrypted state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-profile-persist-"));
  const filePath = path.join(tempDir, "profile_memory.secure.json");
  const encryptionKey = Buffer.alloc(32, 9);
  let state = createEmptyProfileMemoryState();
  state = upsertTemporalProfileFact(state, {
    key: "employment.current",
    value: "Lantern",
    sensitive: false,
    sourceTaskId: "task_profile_persist_roundtrip",
    source: "user_input_pattern.work_at",
    observedAt: "2026-02-24T00:00:00.000Z",
    confidence: 0.95
  }).nextState;
  const episode = createProfileEpisodeRecord({
    title: "Owen fall situation",
    summary: "Owen fell down and the outcome was not mentioned yet.",
    sourceTaskId: "task_profile_episode_roundtrip",
    source: "test",
    sourceKind: "explicit_user_statement",
    sensitive: false,
    observedAt: "2026-02-24T00:00:00.000Z",
    entityRefs: ["entity_owen"],
    openLoopRefs: ["loop_owen"],
    tags: ["followup"]
  });
  const canonicalClaimId =
    `claim_${sha256HexFromCanonicalJson({
      family: "employment.current",
      normalizedKey: "employment.current",
      normalizedValue: "Lantern"
    }).slice(0, 24)}`;
  const canonicalEventId =
    `event_${sha256HexFromCanonicalJson({ episodeId: episode.id }).slice(0, 24)}`;
  state = {
    ...state,
    episodes: [episode],
    graph: {
      ...state.graph,
      updatedAt: "2026-02-24T00:00:00.000Z",
      observations: [
        createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_OBSERVATION_SCHEMA_NAME, {
          observationId: "observation_profile_persist_roundtrip_1",
          stableRefId: "stable_lantern",
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "Lantern",
          sensitive: false,
          sourceTaskId: "task_profile_persist_roundtrip",
          sourceFingerprint: "fingerprint_profile_persist_roundtrip_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-02-24T00:00:00.000Z",
          observedAt: "2026-02-24T00:00:00.000Z",
          timePrecision: "instant",
          timeSource: "user_stated",
          entityRefIds: ["entity_lantern"]
        })
      ],
      claims: [
        createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_CLAIM_SCHEMA_NAME, {
          claimId: canonicalClaimId,
          stableRefId: "stable_lantern",
          family: "employment.current",
          normalizedKey: "employment.current",
          normalizedValue: "Lantern",
          sensitive: false,
          sourceTaskId: "task_profile_persist_roundtrip",
          sourceFingerprint: "fingerprint_profile_persist_roundtrip_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-02-24T00:00:00.000Z",
          validFrom: "2026-02-24T00:00:00.000Z",
          validTo: null,
          endedAt: null,
          endedByClaimId: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: ["observation_profile_persist_roundtrip_1"],
          projectionSourceIds: ["profile_fact_employment_current_roundtrip"],
          entityRefIds: ["entity_lantern"],
          active: true
        })
      ],
      events: [
        createSchemaEnvelopeV1(PROFILE_MEMORY_GRAPH_EVENT_SCHEMA_NAME, {
          eventId: canonicalEventId,
          stableRefId: null,
          family: "episode.candidate",
          title: "Owen fall situation",
          summary: "Owen fell down and the outcome was unresolved.",
          sensitive: false,
          sourceTaskId: "task_profile_persist_roundtrip",
          sourceFingerprint: "fingerprint_profile_persist_roundtrip_1",
          sourceTier: "explicit_user_statement",
          assertedAt: "2026-02-24T00:00:00.000Z",
          observedAt: "2026-02-24T00:00:00.000Z",
          validFrom: "2026-02-24T00:00:00.000Z",
          validTo: null,
          timePrecision: "instant",
          timeSource: "user_stated",
          derivedFromObservationIds: [],
          projectionSourceIds: [episode.id],
          entityRefIds: ["contact.owen"]
        })
      ],
      mutationJournal: {
        schemaVersion: "v1",
        nextWatermark: 2,
        entries: [
          {
            journalEntryId: "journal_profile_persist_roundtrip_1",
            watermark: 1,
            recordedAt: "2026-02-24T00:00:00.000Z",
            sourceTaskId: "task_profile_persist_roundtrip",
            sourceFingerprint: "fingerprint_profile_persist_roundtrip_1",
            mutationEnvelopeHash: null,
            observationIds: ["observation_profile_persist_roundtrip_1"],
            claimIds: [canonicalClaimId],
            eventIds: [canonicalEventId],
            redactionState: "not_requested"
          }
        ]
      }
    }
  };

  try {
    await saveProfileMemoryState(filePath, encryptionKey, state);

    const raw = await readFile(filePath, "utf8");
    assert.equal(raw.includes("employment.current"), false);
    assert.equal(raw.includes("Lantern"), false);
    assert.equal(raw.includes("claim_profile_persist_roundtrip_1"), false);

    const loaded = await loadPersistedProfileMemoryState(filePath, encryptionKey);
    assert.equal(loaded.facts.length, 1);
    assert.equal(loaded.episodes.length, 1);
    assert.equal(loaded.graph.observations.length, 1);
    assert.equal(loaded.graph.claims.length, 1);
    assert.equal(loaded.graph.events.length, 1);
    assert.equal(loaded.facts[0]?.key, "employment.current");
    assert.equal(loaded.facts[0]?.value, "Lantern");
    assert.equal(loaded.episodes[0]?.title, "Owen fall situation");
    assert.equal(loaded.graph.events[0]?.payload.title, "Owen fall situation");
    assert.equal(
      loaded.graph.readModel.currentClaimIdsByKey["employment.current"],
      canonicalClaimId
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
