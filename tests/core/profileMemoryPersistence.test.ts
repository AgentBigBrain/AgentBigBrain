/**
 * @fileoverview Tests profile-memory runtime persistence helpers for env config and encrypted disk round-trips.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  createProfileEpisodeRecord,
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
    value: "Flare",
    sensitive: false,
    sourceTaskId: "task_profile_persist_roundtrip",
    source: "test",
    observedAt: "2026-02-24T00:00:00.000Z",
    confidence: 0.95
  }).nextState;
  state = {
    ...state,
    episodes: [
      createProfileEpisodeRecord({
        title: "Billy fall situation",
        summary: "Billy fell down and the outcome was not mentioned yet.",
        sourceTaskId: "task_profile_episode_roundtrip",
        source: "test",
        sourceKind: "explicit_user_statement",
        sensitive: false,
        observedAt: "2026-02-24T00:00:00.000Z",
        entityRefs: ["entity_billy"],
        openLoopRefs: ["loop_billy"],
        tags: ["followup"]
      })
    ]
  };

  try {
    await saveProfileMemoryState(filePath, encryptionKey, state);

    const raw = await readFile(filePath, "utf8");
    assert.equal(raw.includes("employment.current"), false);
    assert.equal(raw.includes("Flare"), false);

    const loaded = await loadPersistedProfileMemoryState(filePath, encryptionKey);
    assert.equal(loaded.facts.length, 1);
    assert.equal(loaded.episodes.length, 1);
    assert.equal(loaded.facts[0]?.key, "employment.current");
    assert.equal(loaded.facts[0]?.value, "Flare");
    assert.equal(loaded.episodes[0]?.title, "Billy fall situation");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
