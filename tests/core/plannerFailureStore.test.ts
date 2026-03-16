/**
 * @fileoverview Tests planner failure fingerprint persistence stores for deterministic cooldown durability.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import {
  InMemoryPlannerFailureStore,
  SqlitePlannerFailureStore
} from "../../src/core/plannerFailureStore";

/**
 * Implements `buildEntry` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildEntry(nowMs: number) {
  return {
    strikes: 2,
    lastFailureAtMs: nowMs,
    blockedUntilMs: nowMs + 60_000
  };
}

test("in-memory planner failure store upserts and deletes entries", async () => {
  const store = new InMemoryPlannerFailureStore();
  const nowMs = Date.now();
  await store.upsert("fingerprint_a", buildEntry(nowMs));

  const found = await store.get("fingerprint_a");
  assert.ok(found);
  assert.equal(found?.strikes, 2);

  await store.delete("fingerprint_a");
  const missing = await store.get("fingerprint_a");
  assert.equal(missing, undefined);
});

test("sqlite planner failure store persists entries across store instances", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-planner-failure-"));
  const sqlitePath = path.join(tempDir, "ledgers.sqlite");

  try {
    const nowMs = Date.now();
    const firstStore = new SqlitePlannerFailureStore(sqlitePath);
    await firstStore.upsert("fingerprint_persisted", buildEntry(nowMs));

    const secondStore = new SqlitePlannerFailureStore(sqlitePath);
    const found = await secondStore.get("fingerprint_persisted");
    assert.ok(found);
    assert.equal(found?.strikes, 2);
    assert.equal(found?.lastFailureAtMs, nowMs);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("sqlite planner failure store cleanup removes stale entries", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-planner-failure-cleanup-"));
  const sqlitePath = path.join(tempDir, "ledgers.sqlite");

  try {
    const nowMs = Date.now();
    const store = new SqlitePlannerFailureStore(sqlitePath);
    await store.upsert("fingerprint_stale", {
      strikes: 1,
      lastFailureAtMs: nowMs - 1_000_000,
      blockedUntilMs: nowMs - 100
    });
    await store.upsert("fingerprint_fresh", buildEntry(nowMs));

    await store.cleanupOlderThan(nowMs - 10_000);

    const stale = await store.get("fingerprint_stale");
    const fresh = await store.get("fingerprint_fresh");
    assert.equal(stale, undefined);
    assert.ok(fresh);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("sqlite planner failure store recreates the schema if the planner-failure table disappears mid-run", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-planner-failure-recover-"));
  const sqlitePath = path.join(tempDir, "ledgers.sqlite");

  try {
    const store = new SqlitePlannerFailureStore(sqlitePath);
    await store.upsert("fingerprint_recover", buildEntry(Date.now()));

    using db = new DatabaseSync(sqlitePath);
    db.exec("DROP TABLE IF EXISTS planner_failure_fingerprints");

    const recoveredMissing = await store.get("fingerprint_missing_after_drop");
    assert.equal(recoveredMissing, undefined);

    await store.upsert("fingerprint_recovered", buildEntry(Date.now()));
    const recoveredEntry = await store.get("fingerprint_recovered");
    assert.ok(recoveredEntry);
    assert.equal(recoveredEntry?.strikes, 2);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

