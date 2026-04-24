/**
 * @fileoverview Runs Stage 6.86 checkpoint 6.86.G memory-governance checks and emits deterministic evidence.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  applyMemoryMutationV1,
  runMemoryRollbackDrillV1,
  Stage686MemoryStoresV1
} from "../../src/core/stage6_86MemoryGovernance";

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_86_memory_governance_report.json"
);

interface Stage686CheckpointGArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.86.G";
  mutation: {
    receiptProduced: boolean;
    canonicalDiffProduced: boolean;
    traceLinked: boolean;
  };
  typedConflicts: {
    aliasCollisionPass: boolean;
    staleThreadFramePass: boolean;
    sessionSchemaMismatchPass: boolean;
  };
  rollback: {
    restoredSnapshotPass: boolean;
    rollbackReceiptPass: boolean;
  };
  passCriteria: {
    mutationPass: boolean;
    conflictPass: boolean;
    rollbackPass: boolean;
    overallPass: boolean;
  };
}

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
          entityKey: "entity_beacon_labs",
          canonicalName: "Beacon Labs",
          entityType: "org",
          disambiguator: null,
          domainHint: null,
          aliases: ["Beacon Labs"],
          firstSeenAt: "2025-10-01T00:00:00.000Z",
          lastSeenAt: "2026-03-01T00:00:00.000Z",
          salience: 6,
          evidenceRefs: ["trace:entity_beacon_labs"]
        },
        {
          entityKey: "entity_aurora",
          canonicalName: "Aurora",
          entityType: "concept",
          disambiguator: null,
          domainHint: null,
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
              entityRefs: ["entity_beacon_labs"],
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
 * Implements `runStage686CheckpointG` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runStage686CheckpointG(): Promise<Stage686CheckpointGArtifact> {
  const stores = createFixtureStores();
  const mutation = applyMemoryMutationV1({
    stores,
    params: {
      store: "conversation_stack",
      operation: "resolve",
      mutationPath: ["threads", "thread_budget", "openLoops", "0"],
      payload: {},
      evidenceRefs: ["evidence:conversation_loop_resolve"]
    },
    observedAt: "2026-03-01T12:00:00.000Z",
    scopeId: "scope_686g",
    taskId: "task_686g",
    proposalId: "proposal_686g",
    actionId: "action_686g_1",
    priorReceiptHash: "GENESIS"
  });

  const aliasConflict = applyMemoryMutationV1({
    stores,
    params: {
      store: "entity_graph",
      operation: "merge",
      mutationPath: ["entities", "0"],
      payload: {
        entityKey: "entity_beacon_labs",
        aliases: ["Aurora"]
      },
      evidenceRefs: ["evidence:alias_collision"]
    },
    observedAt: "2026-03-01T12:00:00.000Z",
    scopeId: "scope_686g",
    taskId: "task_686g",
    proposalId: "proposal_686g",
    actionId: "action_686g_alias_collision",
    priorReceiptHash: "GENESIS"
  });
  const staleThreadFrame = applyMemoryMutationV1({
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
    scopeId: "scope_686g",
    taskId: "task_686g",
    proposalId: "proposal_686g",
    actionId: "action_686g_stale_thread",
    priorReceiptHash: "GENESIS"
  });
  const sessionSchemaMismatch = applyMemoryMutationV1({
    stores: {
      ...stores,
      conversationStack: {
        ...stores.conversationStack,
        schemaVersion: "v0" as unknown as "v1"
      }
    },
    params: {
      store: "conversation_stack",
      operation: "resolve",
      mutationPath: ["threads", "thread_budget", "openLoops", "0"],
      payload: {},
      evidenceRefs: ["evidence:session_schema_mismatch"]
    },
    observedAt: "2026-03-01T12:00:00.000Z",
    scopeId: "scope_686g",
    taskId: "task_686g",
    proposalId: "proposal_686g",
    actionId: "action_686g_schema_mismatch",
    priorReceiptHash: "GENESIS"
  });

  if (!mutation.receipt) {
    throw new Error("Checkpoint 6.86.G requires deterministic mutation receipt output.");
  }
  const rollback = runMemoryRollbackDrillV1({
    currentStores: mutation.stores,
    lastKnownGoodStores: stores,
    observedAt: "2026-03-01T12:30:00.000Z",
    scopeId: "scope_686g",
    taskId: "task_686g",
    proposalId: "proposal_686g_rollback",
    actionId: "action_686g_rollback",
    priorReceiptHash: mutation.receipt.mutationId,
    evidenceRefs: ["evidence:rollback"]
  });

  const mutationPass =
    Boolean(mutation.receipt) &&
    Boolean(mutation.canonicalDiff) &&
    Boolean(mutation.traceLink?.traceId);
  const conflictPass =
    aliasConflict.blockDetailReason === "ALIAS_COLLISION" &&
    staleThreadFrame.blockDetailReason === "STALE_THREAD_FRAME" &&
    sessionSchemaMismatch.blockDetailReason === "SESSION_SCHEMA_MISMATCH";
  const rollbackPass =
    rollback.rollbackReceipt.operation === "supersede" &&
    rollback.rollbackReceipt.store === "conversation_stack" &&
    JSON.stringify(rollback.restoredStores) === JSON.stringify(stores);
  const overallPass = mutationPass && conflictPass && rollbackPass;

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_86:memory_governance",
    checkpointId: "6.86.G",
    mutation: {
      receiptProduced: Boolean(mutation.receipt),
      canonicalDiffProduced: Boolean(mutation.canonicalDiff),
      traceLinked: Boolean(mutation.traceLink?.traceId)
    },
    typedConflicts: {
      aliasCollisionPass: aliasConflict.blockDetailReason === "ALIAS_COLLISION",
      staleThreadFramePass: staleThreadFrame.blockDetailReason === "STALE_THREAD_FRAME",
      sessionSchemaMismatchPass: sessionSchemaMismatch.blockDetailReason === "SESSION_SCHEMA_MISMATCH"
    },
    rollback: {
      restoredSnapshotPass: JSON.stringify(rollback.restoredStores) === JSON.stringify(stores),
      rollbackReceiptPass:
        rollback.rollbackReceipt.operation === "supersede" &&
        rollback.rollbackReceipt.store === "conversation_stack"
    },
    passCriteria: {
      mutationPass,
      conflictPass,
      rollbackPass,
      overallPass
    }
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runStage686CheckpointG();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.86 checkpoint 6.86.G artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
