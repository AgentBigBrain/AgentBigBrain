/**
 * @fileoverview Tests append-only governance memory persistence and immutable read-view behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { GovernanceMemoryStore } from "../../src/core/governanceMemory";
import { ActionBlockReason, ConstraintViolationCode } from "../../src/core/types";

/**
 * Implements `withStore` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withStore(
  callback: (store: GovernanceMemoryStore, filePath: string) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-gov-memory-"));
  const filePath = path.join(tempDir, "governance_memory.json");
  const store = new GovernanceMemoryStore(filePath);

  try {
    await callback(store, filePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Implements `withSqliteBackedStore` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withSqliteBackedStore(
  callback: (
    store: GovernanceMemoryStore,
    filePath: string,
    sqlitePath: string
  ) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-gov-memory-sqlite-"));
  const filePath = path.join(tempDir, "governance_memory.json");
  const sqlitePath = path.join(tempDir, "ledgers.sqlite");
  const store = new GovernanceMemoryStore(filePath, {
    backend: "sqlite",
    sqlitePath,
    exportJsonOnWrite: true
  });

  try {
    await callback(store, filePath, sqlitePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Implements `buildBlockedEventInput` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildBlockedEventInput(taskSuffix: string) {
  return {
    taskId: `task-${taskSuffix}`,
    proposalId: `proposal-${taskSuffix}`,
    actionId: `action-${taskSuffix}`,
    actionType: "self_modify" as const,
    mode: "escalation_path" as const,
    outcome: "blocked" as const,
    blockCategory: "governance" as const,
    blockedBy: ["security"] as ActionBlockReason[],
    violationCodes: [] as ConstraintViolationCode[],
    yesVotes: 5,
    noVotes: 2,
    threshold: 6,
    dissentGovernorIds: ["security" as const]
  };
}

test("GovernanceMemoryStore starts empty when file is missing", async () => {
  await withStore(async (store) => {
    const view = await store.getReadView();
    assert.equal(view.totalEvents, 0);
    assert.equal(view.recentEvents.length, 0);
    assert.equal(view.recentBlockCounts.constraints, 0);
    assert.equal(view.recentBlockCounts.governance, 0);
    assert.equal(view.recentBlockCounts.runtime, 0);
  });
});

test("GovernanceMemoryStore appends events and reports recent block summaries", async () => {
  await withStore(async (store) => {
    await store.appendEvent({
      taskId: "task-1",
      proposalId: "proposal-1",
      actionId: "action-1",
      actionType: "delete_file",
      mode: "escalation_path",
      outcome: "blocked",
      blockCategory: "constraints",
      blockedBy: ["DELETE_OUTSIDE_SANDBOX"],
      violationCodes: ["DELETE_OUTSIDE_SANDBOX"],
      yesVotes: 0,
      noVotes: 0,
      threshold: null,
      dissentGovernorIds: []
    });
    await store.appendEvent({
      taskId: "task-1",
      proposalId: "proposal-2",
      actionId: "action-2",
      actionType: "self_modify",
      mode: "escalation_path",
      outcome: "blocked",
      blockCategory: "governance",
      blockedBy: ["security", "continuity"],
      violationCodes: [],
      yesVotes: 5,
      noVotes: 2,
      threshold: 6,
      dissentGovernorIds: ["security", "continuity"]
    });

    const view = await store.getReadView(10);
    assert.equal(view.totalEvents, 2);
    assert.equal(view.recentEvents.length, 2);
    assert.equal(view.recentBlockCounts.constraints, 1);
    assert.equal(view.recentBlockCounts.governance, 1);
    assert.equal(view.recentGovernorRejectCounts.security, 1);
    assert.equal(view.recentGovernorRejectCounts.continuity, 1);
  });
});

test("GovernanceMemoryStore read view is immutable for consumers", async () => {
  await withStore(async (store) => {
    await store.appendEvent({
      taskId: "task-immutable",
      proposalId: "proposal-immutable",
      actionId: "action-immutable",
      actionType: "respond",
      mode: "fast_path",
      outcome: "approved",
      blockCategory: "none",
      blockedBy: [],
      violationCodes: [],
      yesVotes: 1,
      noVotes: 0,
      threshold: 1,
      dissentGovernorIds: []
    });

    const view = await store.getReadView(5);
    assert.equal(Object.isFrozen(view), true);
    assert.equal(Object.isFrozen(view.recentEvents), true);
    assert.equal(Object.isFrozen(view.recentEvents[0]), true);
    assert.equal(Object.isFrozen(view.recentEvents[0].blockedBy), true);
  });
});

test("GovernanceMemoryStore reloads latest events written by another store instance", async () => {
  await withStore(async (store, filePath) => {
    const second = new GovernanceMemoryStore(filePath);
    await store.appendEvent(buildBlockedEventInput("first"));
    await second.appendEvent(buildBlockedEventInput("second"));

    const count = await store.getEventCount();
    assert.equal(count, 2);
  });
});

/**
 * Implements `governanceMemoryStoreSqliteBackendReadsWritesAndExportsJsonParity` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function governanceMemoryStoreSqliteBackendReadsWritesAndExportsJsonParity(): Promise<void> {
  await withSqliteBackedStore(async (store, filePath) => {
    await store.appendEvent(buildBlockedEventInput("sqlite-first"));
    await store.appendEvent(buildBlockedEventInput("sqlite-second"));

    const view = await store.getReadView(10);
    assert.equal(view.totalEvents, 2);
    assert.equal(view.recentEvents.length, 2);
    assert.equal(view.recentBlockCounts.governance, 2);
    assert.equal(view.recentGovernorRejectCounts.security, 2);

    const exportedRaw = await readFile(filePath, "utf8");
    const exported = JSON.parse(exportedRaw) as {
      createdAt: string;
      events: Array<{ id: string }>;
    };
    assert.equal(typeof exported.createdAt, "string");
    assert.equal(exported.events.length, 2);
  });
}

/**
 * Implements `governanceMemoryStoreSqliteBackendImportsLegacyJsonSnapshot` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function governanceMemoryStoreSqliteBackendImportsLegacyJsonSnapshot(): Promise<void> {
  await withSqliteBackedStore(async (_store, filePath, sqlitePath) => {
    const legacyDocument = {
      createdAt: "2026-02-26T00:00:00.000Z",
      lastAppendedAt: "2026-02-26T00:01:00.000Z",
      events: [
        {
          id: "legacy_event_1",
          recordedAt: "2026-02-26T00:01:00.000Z",
          taskId: "legacy_task",
          proposalId: "legacy_proposal",
          actionId: "legacy_action",
          actionType: "self_modify",
          mode: "escalation_path",
          outcome: "blocked",
          blockCategory: "governance",
          blockedBy: ["security"],
          violationCodes: [],
          yesVotes: 5,
          noVotes: 2,
          threshold: 6,
          dissentGovernorIds: ["security"]
        }
      ]
    };
    await writeFile(filePath, JSON.stringify(legacyDocument, null, 2), "utf8");

    const importedStore = new GovernanceMemoryStore(filePath, {
      backend: "sqlite",
      sqlitePath,
      exportJsonOnWrite: false
    });
    const count = await importedStore.getEventCount();
    assert.equal(count, 1);

    const view = await importedStore.getReadView(5);
    assert.equal(view.recentEvents[0].id, "legacy_event_1");
  });
}

test(
  "GovernanceMemoryStore sqlite backend reads writes and exports json parity snapshot",
  governanceMemoryStoreSqliteBackendReadsWritesAndExportsJsonParity
);
test(
  "GovernanceMemoryStore sqlite backend imports legacy json snapshot when sqlite ledger is empty",
  governanceMemoryStoreSqliteBackendImportsLegacyJsonSnapshot
);
