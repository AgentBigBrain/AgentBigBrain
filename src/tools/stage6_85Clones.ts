/**
 * @fileoverview Runs Stage 6.85 checkpoint 6.85.C clone-workflow checks and emits deterministic evidence artifacts.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_BRAIN_CONFIG } from "../core/config";
import { DistillerMergeLedgerStore, SatelliteCloneCoordinator } from "../core/advancedAutonomyRuntime";
import { verifySchemaEnvelopeV1 } from "../core/schemaEnvelope";
import {
  buildFindingsPacketV1,
  buildOptionPacketV1,
  createFindingsPacketEnvelopeV1,
  createOptionPacketEnvelopeV1,
  evaluateCloneActionSurface,
  evaluateClonePacketMergeEligibility,
  resolveParallelSpikeBounds,
  validateCloneQueueRequest
} from "../core/stage6_85CloneWorkflowPolicy";
import { ParallelSpikeBoundsV1 } from "../core/types";

const ARTIFACT_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_85_clones_report.json");
const LEDGER_PATH = path.resolve(process.cwd(), "runtime/evidence/stage6_85_clones_distiller_ledger.json");

interface Stage685CheckpointCArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.85.C";
  bounds: {
    inherited: {
      allowed: boolean;
      bounds: ParallelSpikeBoundsV1 | null;
      reasons: readonly string[];
    };
    invalidRequestBlocked: {
      blocked: boolean;
      blockCode: string | null;
      reasons: readonly string[];
    };
  };
  queueObjects: {
    valid: {
      valid: boolean;
      missionId: string | null;
      phase: string | null;
      requestedCloneCount: number | null;
    };
    invalidBlocked: {
      valid: boolean;
      blockCode: string | null;
      reasons: readonly string[];
    };
  };
  packetContracts: {
    optionEnvelopeHashValid: boolean;
    findingsEnvelopeHashValid: boolean;
    optionContentKind: string;
    findingsContentKind: string;
  };
  mergePolicy: {
    mergeableKind: {
      kind: string;
      mergeable: boolean;
      blockCode: string | null;
    };
    blockedKind: {
      kind: string;
      mergeable: boolean;
      blockCode: string | null;
    };
  };
  sideEffectSurface: {
    proposalOnlyAllowed: boolean;
    sideEffectDenied: boolean;
    deniedBlockCode: string | null;
  };
  cloneLifecycle: {
    spawnAllowed: boolean;
    cloneIds: readonly string[];
    approvedMergeCommittedBy: string | null;
    rejectedMergeCommittedBy: string | null;
    ledgerApprovedVisible: boolean;
    ledgerRejectedVisible: boolean;
  };
  passCriteria: {
    boundsContractPass: boolean;
    queueContractPass: boolean;
    packetEnvelopePass: boolean;
    mergePolicyPass: boolean;
    sideEffectSurfacePass: boolean;
    ledgerAttributionPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Executes stage685 checkpoint c as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the stage685 checkpoint c runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `DistillerMergeLedgerStore` (import `DistillerMergeLedgerStore`) from `../core/advancedAutonomyRuntime`.
 * - Uses `SatelliteCloneCoordinator` (import `SatelliteCloneCoordinator`) from `../core/advancedAutonomyRuntime`.
 * - Uses `DEFAULT_BRAIN_CONFIG` (import `DEFAULT_BRAIN_CONFIG`) from `../core/config`.
 * - Uses `verifySchemaEnvelopeV1` (import `verifySchemaEnvelopeV1`) from `../core/schemaEnvelope`.
 * - Uses `buildFindingsPacketV1` (import `buildFindingsPacketV1`) from `../core/stage6_85CloneWorkflowPolicy`.
 * - Uses `buildOptionPacketV1` (import `buildOptionPacketV1`) from `../core/stage6_85CloneWorkflowPolicy`.
 * - Additional imported collaborators are also used in this function body.
 * @returns Promise resolving to Stage685CheckpointCArtifact.
 */
export async function runStage685CheckpointC(): Promise<Stage685CheckpointCArtifact> {
  const inheritedBounds = resolveParallelSpikeBounds({
    configMaxSubagentsPerTask: DEFAULT_BRAIN_CONFIG.limits.maxSubagentsPerTask,
    configMaxSubagentDepth: DEFAULT_BRAIN_CONFIG.limits.maxSubagentDepth
  });
  const invalidBounds = resolveParallelSpikeBounds({
    configMaxSubagentsPerTask: DEFAULT_BRAIN_CONFIG.limits.maxSubagentsPerTask,
    configMaxSubagentDepth: DEFAULT_BRAIN_CONFIG.limits.maxSubagentDepth,
    requestedBounds: {
      maxClonesPerParallelSpike: DEFAULT_BRAIN_CONFIG.limits.maxSubagentsPerTask + 1,
      maxCloneDepth: DEFAULT_BRAIN_CONFIG.limits.maxSubagentDepth + 1,
      maxCloneBudgetUsd: 1.2,
      maxPacketsPerClone: 6
    }
  });

  if (!inheritedBounds.allowed || !inheritedBounds.bounds) {
    throw new Error("Failed to resolve inherited parallel-spike bounds for Stage 6.85 checkpoint 6.85.C.");
  }

  const validQueue = validateCloneQueueRequest(
    {
      missionId: "mission_6_85_c_001",
      missionAttemptId: 1,
      rootTaskId: "task_6_85_c_001",
      phase: "parallel_spike",
      cloneRole: "researcher",
      requestedCloneCount: inheritedBounds.bounds.maxClonesPerParallelSpike,
      requestedDepth: inheritedBounds.bounds.maxCloneDepth,
      requestedBudgetUsd: inheritedBounds.bounds.maxCloneBudgetUsd,
      packetBudgetPerClone: inheritedBounds.bounds.maxPacketsPerClone
    },
    inheritedBounds.bounds
  );
  const invalidQueue = validateCloneQueueRequest(
    {
      missionId: "mission_6_85_c_001",
      missionAttemptId: 1,
      rootTaskId: "task_6_85_c_001",
      phase: "parallel_spike",
      cloneRole: "researcher",
      requestedCloneCount: inheritedBounds.bounds.maxClonesPerParallelSpike + 1,
      requestedDepth: inheritedBounds.bounds.maxCloneDepth + 1,
      requestedBudgetUsd: inheritedBounds.bounds.maxCloneBudgetUsd + 0.2,
      packetBudgetPerClone: inheritedBounds.bounds.maxPacketsPerClone + 1
    },
    inheritedBounds.bounds
  );

  const optionPacket = buildOptionPacketV1({
    packetId: "option_stage6_85_c_001",
    cloneId: "atlas-1001",
    recommendation: "Use a deterministic replay-safe selector strategy variant.",
    tradeoffs: ["Higher upfront approval interaction", "Lower flaky replay risk"],
    risks: ["Policy profile drift can invalidate replay"],
    evidenceRefs: ["trace_clone_1", "trace_clone_2"],
    confidence: 0.84,
    contentKind: "plan_variant"
  });
  const findingsPacket = buildFindingsPacketV1({
    packetId: "findings_stage6_85_c_001",
    cloneId: "milkyway-1002",
    recommendation: "Persist selector fallback path and explicit assertion points.",
    tradeoffs: ["Slightly slower compile path"],
    risks: ["Selector mismatch if UI drifts"],
    evidenceRefs: ["trace_clone_3"],
    confidence: 0.72,
    contentKind: "selector_strategy"
  });
  const optionEnvelope = createOptionPacketEnvelopeV1(optionPacket, "2026-02-27T00:00:00.000Z");
  const findingsEnvelope = createFindingsPacketEnvelopeV1(
    findingsPacket,
    "2026-02-27T00:00:00.000Z"
  );

  const mergeable = evaluateClonePacketMergeEligibility("plan_variant");
  const blocked = evaluateClonePacketMergeEligibility("secret");

  const proposalSurface = evaluateCloneActionSurface("respond");
  const blockedSurface = evaluateCloneActionSurface("write_file");

  const coordinator = new SatelliteCloneCoordinator({
    maxClonesPerTask: inheritedBounds.bounds.maxClonesPerParallelSpike,
    maxDepth: inheritedBounds.bounds.maxCloneDepth,
    maxBudgetUsd: inheritedBounds.bounds.maxCloneBudgetUsd
  });
  const spawn = coordinator.spawnSatellites({
    rootTaskId: "task_6_85_c_001",
    requestedCloneCount: inheritedBounds.bounds.maxClonesPerParallelSpike,
    requestedDepth: inheritedBounds.bounds.maxCloneDepth,
    requestedBudgetUsd: inheritedBounds.bounds.maxCloneBudgetUsd,
    existingCloneCount: 0,
    role: "researcher"
  });
  const approvedMerge = coordinator.evaluateMergeDecision({
    clone: spawn.clones[0],
    governanceApproved: mergeable.mergeable,
    rejectingGovernorIds: [],
    lessonText: optionPacket.recommendation
  });
  const rejectedMerge = coordinator.evaluateMergeDecision({
    clone: spawn.clones[1],
    governanceApproved: blocked.mergeable,
    rejectingGovernorIds: ["security"],
    lessonText: "Attempt to merge a secret-bearing packet should be denied.",
    reason: "Secret content cannot be merged from clone packets."
  });

  const ledgerStore = new DistillerMergeLedgerStore(LEDGER_PATH);
  const approvedLedgerEntry = await ledgerStore.appendDecision({
    cloneId: spawn.clones[0]?.cloneId ?? "unknown_clone",
    lessonText: optionPacket.recommendation,
    merged: approvedMerge.merged,
    rejectingGovernorIds: [],
    reason: "Mergeable packet accepted by governed merge policy."
  });
  const rejectedLedgerEntry = await ledgerStore.appendDecision({
    cloneId: spawn.clones[1]?.cloneId ?? "unknown_clone",
    lessonText: "Attempt to merge a secret-bearing packet should be denied.",
    merged: rejectedMerge.merged,
    rejectingGovernorIds: ["security"],
    reason: rejectedMerge.rejectionReason ?? "Secret-bearing packet merge denied."
  });
  const ledger = await ledgerStore.load();
  const ledgerApprovedVisible = ledger.entries.some((entry) => entry.id === approvedLedgerEntry.id);
  const ledgerRejectedVisible = ledger.entries.some((entry) => entry.id === rejectedLedgerEntry.id);

  const boundsContractPass =
    inheritedBounds.allowed &&
    inheritedBounds.bounds.maxClonesPerParallelSpike <= DEFAULT_BRAIN_CONFIG.limits.maxSubagentsPerTask &&
    inheritedBounds.bounds.maxCloneDepth <= DEFAULT_BRAIN_CONFIG.limits.maxSubagentDepth &&
    inheritedBounds.bounds.maxCloneBudgetUsd <= 1 &&
    inheritedBounds.bounds.maxPacketsPerClone <= 4 &&
    invalidBounds.allowed === false &&
    invalidBounds.blockCode === "PARALLEL_SPIKE_BOUNDS_INVALID";
  const queueContractPass = validQueue.valid && !invalidQueue.valid;
  const packetEnvelopePass =
    verifySchemaEnvelopeV1(optionEnvelope) && verifySchemaEnvelopeV1(findingsEnvelope);
  const mergePolicyPass =
    mergeable.mergeable &&
    mergeable.blockCode === null &&
    !blocked.mergeable &&
    blocked.blockCode === "CLONE_PACKET_NON_MERGEABLE";
  const sideEffectSurfacePass =
    proposalSurface.allowed &&
    !blockedSurface.allowed &&
    blockedSurface.blockCode === "CLONE_DIRECT_SIDE_EFFECT_DENIED";
  const ledgerAttributionPass =
    spawn.allowed &&
    approvedMerge.committedByAgentId === (spawn.clones[0]?.cloneId ?? null) &&
    rejectedMerge.committedByAgentId === null &&
    ledgerApprovedVisible &&
    ledgerRejectedVisible;
  const overallPass =
    boundsContractPass &&
    queueContractPass &&
    packetEnvelopePass &&
    mergePolicyPass &&
    sideEffectSurfacePass &&
    ledgerAttributionPass;

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_85:clones",
    checkpointId: "6.85.C",
    bounds: {
      inherited: {
        allowed: inheritedBounds.allowed,
        bounds: inheritedBounds.bounds,
        reasons: inheritedBounds.reasons
      },
      invalidRequestBlocked: {
        blocked: !invalidBounds.allowed,
        blockCode: invalidBounds.blockCode,
        reasons: invalidBounds.reasons
      }
    },
    queueObjects: {
      valid: {
        valid: validQueue.valid,
        missionId: validQueue.normalizedRequest?.missionId ?? null,
        phase: validQueue.normalizedRequest?.phase ?? null,
        requestedCloneCount: validQueue.normalizedRequest?.requestedCloneCount ?? null
      },
      invalidBlocked: {
        valid: invalidQueue.valid,
        blockCode: invalidQueue.blockCode,
        reasons: invalidQueue.reasons
      }
    },
    packetContracts: {
      optionEnvelopeHashValid: verifySchemaEnvelopeV1(optionEnvelope),
      findingsEnvelopeHashValid: verifySchemaEnvelopeV1(findingsEnvelope),
      optionContentKind: optionPacket.contentKind,
      findingsContentKind: findingsPacket.contentKind
    },
    mergePolicy: {
      mergeableKind: {
        kind: "plan_variant",
        mergeable: mergeable.mergeable,
        blockCode: mergeable.blockCode
      },
      blockedKind: {
        kind: "secret",
        mergeable: blocked.mergeable,
        blockCode: blocked.blockCode
      }
    },
    sideEffectSurface: {
      proposalOnlyAllowed: proposalSurface.allowed,
      sideEffectDenied: !blockedSurface.allowed,
      deniedBlockCode: blockedSurface.blockCode
    },
    cloneLifecycle: {
      spawnAllowed: spawn.allowed,
      cloneIds: spawn.clones.map((clone) => clone.cloneId),
      approvedMergeCommittedBy: approvedMerge.committedByAgentId,
      rejectedMergeCommittedBy: rejectedMerge.committedByAgentId,
      ledgerApprovedVisible,
      ledgerRejectedVisible
    },
    passCriteria: {
      boundsContractPass,
      queueContractPass,
      packetEnvelopePass,
      mergePolicyPass,
      sideEffectSurfacePass,
      ledgerAttributionPass,
      overallPass
    }
  };
}

/**
 * Runs the `stage6_85Clones` entrypoint workflow.
 *
 * **Why it exists:**
 * Coordinates imported collaborators behind the `main` function boundary.
 *
 * **What it talks to:**
 * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
 * - Uses `writeFile` (import `writeFile`) from `node:fs/promises`.
 * - Uses `path` (import `default`) from `node:path`.
 * @returns Promise resolving to void.
 */
async function main(): Promise<void> {
  const artifact = await runStage685CheckpointC();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.85 checkpoint 6.85.C artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
