/**
 * @fileoverview Tests deterministic Stage 6.86 memory-governance mutation receipts, conflict handling, and rollback parity for checkpoint 6.86.G.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyMemoryMutationV1,
  runMemoryRollbackDrillV1,
  Stage686MemoryStoresV1
} from "../../src/core/stage6_86MemoryGovernance";

/**
 * Implements `createFixtureStores` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function createFixtureStores(): Stage686MemoryStoresV1 {
  return {
    entityGraph: {
      schemaVersion: "v1",
      updatedAt: "2026-03-01T00:00:00.000Z",
      entities: [
        {
          entityKey: "entity_lantern_labs",
          canonicalName: "Lantern Labs",
          entityType: "org",
          disambiguator: null,
          aliases: ["Lantern Labs"],
          firstSeenAt: "2025-10-01T00:00:00.000Z",
          lastSeenAt: "2026-03-01T00:00:00.000Z",
          salience: 6,
          evidenceRefs: ["trace:entity_lantern_labs"]
        },
        {
          entityKey: "entity_aurora",
          canonicalName: "Aurora",
          entityType: "concept",
          disambiguator: null,
          aliases: ["Aurora"],
          firstSeenAt: "2025-10-01T00:00:00.000Z",
          lastSeenAt: "2026-03-01T00:00:00.000Z",
          salience: 5,
          evidenceRefs: ["trace:entity_aurora"]
        }
      ],
      edges: []
    },
    conversationStack: {
      schemaVersion: "v1",
      updatedAt: "2026-03-01T00:00:00.000Z",
      activeThreadKey: "thread_budget",
      threads: [
        {
          threadKey: "thread_budget",
          topicKey: "topic_budget",
          topicLabel: "Budget runway",
          state: "active",
          resumeHint: "Return to budget assumptions",
          openLoops: [
            {
              loopId: "loop_budget_1",
              threadKey: "thread_budget",
              entityRefs: ["entity_lantern_labs"],
              createdAt: "2026-03-01T00:00:00.000Z",
              lastMentionedAt: "2026-03-01T00:00:00.000Z",
              priority: 0.61,
              status: "open"
            }
          ],
          lastTouchedAt: "2026-03-01T00:00:00.000Z"
        }
      ],
      topics: [
        {
          topicKey: "topic_budget",
          label: "Budget runway",
          firstSeenAt: "2026-03-01T00:00:00.000Z",
          lastSeenAt: "2026-03-01T00:00:00.000Z",
          mentionCount: 2
        }
      ]
    },
    pulseState: {
      schemaVersion: "v1",
      updatedAt: "2026-03-01T00:00:00.000Z",
      lastPulseAt: null,
      emittedTodayCount: 0,
      bridgeHistory: []
    }
  };
}

/**
 * Implements `appliesDeterministicMutationAndProducesReceiptWithDiff` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function appliesDeterministicMutationAndProducesReceiptWithDiff(): void {
  const stores = createFixtureStores();
  const result = applyMemoryMutationV1({
    stores,
    params: {
      store: "entity_graph",
      operation: "upsert",
      mutationPath: ["entities", "0", "aliases"],
      payload: {
        values: ["Lantern Labs", "Lantern"]
      },
      evidenceRefs: ["evidence:mutation_entity_alias"]
    },
    observedAt: "2026-03-01T12:00:00.000Z",
    scopeId: "task_scope_1",
    taskId: "task_1",
    proposalId: "proposal_1",
    actionId: "action_1",
    priorReceiptHash: "GENESIS"
  });

  assert.equal(result.blockCode, null);
  assert.equal(result.conflict, null);
  assert.ok(result.receipt);
  assert.ok(result.canonicalDiff);
  assert.notEqual(result.canonicalDiff!.beforeFingerprint, result.canonicalDiff!.afterFingerprint);
  assert.equal(result.receipt!.store, "entity_graph");
  assert.equal(result.receipt!.operation, "upsert");
  assert.equal(result.receipt!.priorReceiptHash, "GENESIS");
}

/**
 * Implements `blocksAliasCollisionWithTypedConflict` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function blocksAliasCollisionWithTypedConflict(): void {
  const stores = createFixtureStores();
  const result = applyMemoryMutationV1({
    stores,
    params: {
      store: "entity_graph",
      operation: "merge",
      mutationPath: ["entities", "0"],
      payload: {
        entityKey: "entity_lantern_labs",
        aliases: ["Aurora"]
      },
      evidenceRefs: ["evidence:alias_collision"]
    },
    observedAt: "2026-03-01T12:00:00.000Z",
    scopeId: "task_scope_1",
    taskId: "task_1",
    proposalId: "proposal_1",
    actionId: "action_2",
    priorReceiptHash: "GENESIS"
  });

  assert.equal(result.blockCode, "MEMORY_MUTATION_BLOCKED");
  assert.equal(result.blockDetailReason, "ALIAS_COLLISION");
  assert.equal(result.conflict?.conflictCode, "ALIAS_COLLISION");
  assert.equal(result.receipt, null);
}

/**
 * Implements `blocksMissingThreadFrameMutations` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function blocksMissingThreadFrameMutations(): void {
  const stores = createFixtureStores();
  const result = applyMemoryMutationV1({
    stores,
    params: {
      store: "conversation_stack",
      operation: "upsert",
      mutationPath: ["threads", "thread_missing", "openLoops"],
      payload: {
        value: []
      },
      evidenceRefs: ["evidence:stale_thread_frame"]
    },
    observedAt: "2026-03-01T12:00:00.000Z",
    scopeId: "task_scope_1",
    taskId: "task_1",
    proposalId: "proposal_1",
    actionId: "action_3",
    priorReceiptHash: "GENESIS"
  });

  assert.equal(result.blockCode, "MEMORY_MUTATION_BLOCKED");
  assert.equal(result.blockDetailReason, "STALE_THREAD_FRAME");
  assert.equal(result.conflict?.conflictCode, "STALE_THREAD_FRAME");
}

/**
 * Implements `blocksSessionSchemaMismatchMutations` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function blocksSessionSchemaMismatchMutations(): void {
  const stores = createFixtureStores();
  const mutatedStores: Stage686MemoryStoresV1 = {
    ...stores,
    conversationStack: {
      ...stores.conversationStack,
      schemaVersion: "v0" as unknown as "v1"
    }
  };
  const result = applyMemoryMutationV1({
    stores: mutatedStores,
    params: {
      store: "conversation_stack",
      operation: "resolve",
      mutationPath: ["threads", "thread_budget", "openLoops", "0"],
      payload: {},
      evidenceRefs: ["evidence:session_schema_mismatch"]
    },
    observedAt: "2026-03-01T12:00:00.000Z",
    scopeId: "task_scope_1",
    taskId: "task_1",
    proposalId: "proposal_1",
    actionId: "action_4",
    priorReceiptHash: "GENESIS"
  });

  assert.equal(result.blockCode, "MEMORY_MUTATION_BLOCKED");
  assert.equal(result.blockDetailReason, "SESSION_SCHEMA_MISMATCH");
  assert.equal(result.conflict?.conflictCode, "SESSION_SCHEMA_MISMATCH");
}

/**
 * Implements `restoresSnapshotWithRollbackReceipt` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function restoresSnapshotWithRollbackReceipt(): void {
  const baselineStores = createFixtureStores();
  const mutated = applyMemoryMutationV1({
    stores: baselineStores,
    params: {
      store: "pulse_state",
      operation: "upsert",
      mutationPath: ["emittedTodayCount"],
      payload: {
        value: 2
      },
      evidenceRefs: ["evidence:pulse_mutation"]
    },
    observedAt: "2026-03-01T12:00:00.000Z",
    scopeId: "task_scope_1",
    taskId: "task_1",
    proposalId: "proposal_1",
    actionId: "action_5",
    priorReceiptHash: "GENESIS"
  });
  assert.ok(mutated.receipt);

  const rollback = runMemoryRollbackDrillV1({
    currentStores: mutated.stores,
    lastKnownGoodStores: baselineStores,
    observedAt: "2026-03-01T12:30:00.000Z",
    scopeId: "task_scope_1",
    taskId: "task_1",
    proposalId: "proposal_rollback",
    actionId: "action_rollback",
    priorReceiptHash: mutated.receipt!.mutationId,
    evidenceRefs: ["evidence:rollback"]
  });

  assert.equal(rollback.rollbackReceipt.operation, "supersede");
  assert.equal(rollback.rollbackReceipt.store, "conversation_stack");
  assert.notEqual(
    rollback.rollbackReceipt.beforeFingerprint,
    rollback.rollbackReceipt.afterFingerprint
  );
  assert.deepEqual(rollback.restoredStores, baselineStores);
}

test(
  "stage 6.86 memory governance applies deterministic mutation and emits canonical-diff receipt",
  appliesDeterministicMutationAndProducesReceiptWithDiff
);
test(
  "stage 6.86 memory governance blocks alias collisions with typed conflict semantics",
  blocksAliasCollisionWithTypedConflict
);
test(
  "stage 6.86 memory governance blocks stale thread-frame mutations deterministically",
  blocksMissingThreadFrameMutations
);
test(
  "stage 6.86 memory governance blocks session schema mismatch mutations deterministically",
  blocksSessionSchemaMismatchMutations
);
test(
  "stage 6.86 memory governance rollback drill restores last-known-good snapshot with receipt linkage",
  restoresSnapshotWithRollbackReceipt
);
