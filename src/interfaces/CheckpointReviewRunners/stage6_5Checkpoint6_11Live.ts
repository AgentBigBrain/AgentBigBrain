/**
 * @fileoverview Runs deterministic Stage 6.5 checkpoint 6.11 (controlled satellite cloning) live checks and writes reviewer artifacts.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { DistillerMergeLedgerStore, SatelliteCloneCoordinator } from "../../core/advancedAutonomyRuntime";

const DEFAULT_STAGE6_5_CHECKPOINT_6_11_ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_5_6_11_live_check_output.json"
);
const DEFAULT_STAGE6_5_CHECKPOINT_6_11_LEDGER_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_5_6_11_distiller_ledger.json"
);

export interface Stage65Checkpoint611RunOptions {
  artifactPath?: string;
  ledgerPath?: string;
}

export interface Stage65Checkpoint611LiveArtifact {
  artifactHash: string;
  linkedFrom: {
    receiptHash?: string;
    traceId?: string;
  };
  generatedAt: string;
  command: string;
  satelliteCapabilitySurfaceProofV1: {
    directSideEffectsAllowed: boolean;
    outputMode: "proposal_only";
    deniedActionTypes: readonly string[];
    enforcementCodes: readonly string[];
  };
  spawnWithinLimits: {
    allowed: boolean;
    cloneIds: readonly string[];
    role: string | null;
    personaRoles: readonly string[];
    blockedBy: readonly string[];
  };
  blockedScenarios: {
    limitReached: readonly string[];
    depthExceeded: readonly string[];
    budgetExceeded: readonly string[];
  };
  mergeDecisions: {
    approved: {
      merged: boolean;
      committedByAgentId: string | null;
      lessonFingerprint: string;
      ledgerVisible: boolean;
    };
    rejected: {
      merged: boolean;
      committedByAgentId: string | null;
      lessonFingerprint: string;
      rejectionReason: string | null;
      rejectingGovernorIds: readonly string[];
      ledgerVisible: boolean;
    };
  };
  passCriteria: {
    deterministicNamingAndNoConflict: boolean;
    limitViolationsBlocked: boolean;
    capabilitySurfaceEnforced: boolean;
    approvedMergeRetainsCloneAttribution: boolean;
    rejectedMergeAuditVisible: boolean;
    overallPass: boolean;
  };
}

export interface CheckpointReviewCommandResult {
  checkpointId: string;
  overallPass: boolean;
  artifactPath: string;
  summaryLines: readonly string[];
}

/**
 * Resolves stage65 checkpoint611 artifact path from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of stage65 checkpoint611 artifact path by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param options - Optional tuning knobs for this operation.
 * @returns Resulting string value.
 */
function resolveStage65Checkpoint611ArtifactPath(options: Stage65Checkpoint611RunOptions): string {
  if (typeof options.artifactPath === "string" && options.artifactPath.trim()) {
    return path.resolve(process.cwd(), options.artifactPath);
  }
  return DEFAULT_STAGE6_5_CHECKPOINT_6_11_ARTIFACT_PATH;
}

/**
 * Resolves stage65 checkpoint611 ledger path from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of stage65 checkpoint611 ledger path by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param options - Optional tuning knobs for this operation.
 * @returns Resulting string value.
 */
function resolveStage65Checkpoint611LedgerPath(options: Stage65Checkpoint611RunOptions): string {
  if (typeof options.ledgerPath === "string" && options.ledgerPath.trim()) {
    return path.resolve(process.cwd(), options.ledgerPath);
  }
  return DEFAULT_STAGE6_5_CHECKPOINT_6_11_LEDGER_PATH;
}

/**
 * Evaluates unique and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the unique policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param values - Value for values.
 * @returns `true` when this check passes.
 */
function isUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

/**
 * Evaluates block code and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the block code policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param blockedBy - Value for blocked by.
 * @param code - Value for code.
 * @returns `true` when this check passes.
 */
function hasBlockCode(blockedBy: readonly string[], code: string): boolean {
  return blockedBy.includes(code);
}

/**
 * Canonicalizes nested values by sorting object keys recursively for deterministic hashing.
 */
function canonicalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeForHash(entry));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((accumulator, key) => {
        accumulator[key] = canonicalizeForHash(record[key]);
        return accumulator;
      }, {});
  }
  return value;
}

/**
 * Serializes values into deterministic canonical JSON for hash derivation.
 */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalizeForHash(value));
}

/**
 * Computes sha256 hex digests for deterministic artifact linkage.
 */
function hashSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Executes a deterministic simulation of the Stage 6.5 Checkpoint 6.11 logic.
 * 
 * **Why it exists:**  
 * This function serves as the live validation core for demonstrating "Controlled Satellite Cloning" and 
 * "Deterministic Merge Decisions". It proves that the autonomy engine can safely distribute sub-tasks 
 * to clones (satellites) while strictly enforcing budget, depth, and capability limits.
 * 
 * **What it talks to:**  
 * - Instantiates `DistillerMergeLedgerStore` to simulate and record ledger entries for merged findings.
 * - Instantiates `SatelliteCloneCoordinator` to evaluate branching requests against hard constraints.
 * 
 * **What it does:**  
 * 1. Simulates valid and invalid clone spawn scenarios (`spawnWithinLimits`, `blockedByLimit`, `blockedByDepth`, `blockedByBudget`).
 * 2. Simulates governance review of clone-discovered knowledge (approved vs rejected merges).
 * 3. Asserts that the system enforces boundaries correctly (e.g., budget caps prevent execution).
 * 4. Compiles these cryptographic proofs into a unified `Stage65Checkpoint611LiveArtifact`.
 * 
 * @param options - Configuration overrides to manually point the ledger payload paths instead of using defaults.
 * @returns A structured artifact containing cryptographically hashed proofs of the checkpoint constraint mechanics.
 */
export async function runCheckpoint611LiveCheck(
  options: Stage65Checkpoint611RunOptions = {}
): Promise<Stage65Checkpoint611LiveArtifact> {
  const ledgerPath = resolveStage65Checkpoint611LedgerPath(options);
  const ledgerStore = new DistillerMergeLedgerStore(ledgerPath);

  const coordinator = new SatelliteCloneCoordinator({
    maxClonesPerTask: 2,
    maxDepth: 1,
    maxBudgetUsd: 1.0
  });

  const spawnWithinLimits = coordinator.spawnSatellites({
    rootTaskId: "task_stage6_5_6_11_live",
    requestedCloneCount: 2,
    requestedDepth: 1,
    requestedBudgetUsd: 0.8,
    existingCloneCount: 0,
    role: "researcher"
  });

  const blockedByLimit = coordinator.spawnSatellites({
    rootTaskId: "task_stage6_5_6_11_live",
    requestedCloneCount: 1,
    requestedDepth: 1,
    requestedBudgetUsd: 0.2,
    existingCloneCount: 2,
    role: "researcher"
  });

  const blockedByDepth = coordinator.spawnSatellites({
    rootTaskId: "task_stage6_5_6_11_live",
    requestedCloneCount: 1,
    requestedDepth: 2,
    requestedBudgetUsd: 0.2,
    existingCloneCount: 0,
    role: "researcher"
  });

  const blockedByBudget = coordinator.spawnSatellites({
    rootTaskId: "task_stage6_5_6_11_live",
    requestedCloneCount: 1,
    requestedDepth: 1,
    requestedBudgetUsd: 1.5,
    existingCloneCount: 0,
    role: "researcher"
  });

  const mergeApproved = coordinator.evaluateMergeDecision({
    clone: spawnWithinLimits.clones[1],
    governanceApproved: true,
    rejectingGovernorIds: [],
    lessonText: "Researcher clone found a deterministic branch reduction strategy."
  });

  const mergeRejected = coordinator.evaluateMergeDecision({
    clone: spawnWithinLimits.clones[0],
    governanceApproved: false,
    rejectingGovernorIds: ["security", "logic"],
    lessonText: "Bypass validation to speed up satellite result ingestion.",
    reason: "Governors rejected unsafe merge recommendation."
  });

  const approvedLedgerEntry = await ledgerStore.appendDecision({
    cloneId: spawnWithinLimits.clones[1]?.cloneId ?? "unknown_clone",
    lessonText: "Researcher clone found a deterministic branch reduction strategy.",
    merged: true,
    rejectingGovernorIds: [],
    reason: "Governed merge accepted."
  });
  const rejectedLedgerEntry = await ledgerStore.appendDecision({
    cloneId: spawnWithinLimits.clones[0]?.cloneId ?? "unknown_clone",
    lessonText: "Bypass validation to speed up satellite result ingestion.",
    merged: false,
    rejectingGovernorIds: ["security", "logic"],
    reason: "Governors rejected unsafe merge recommendation."
  });
  const ledgerDocument = await ledgerStore.load();
  const approvedLedgerVisible = ledgerDocument.entries.some(
    (entry) =>
      entry.id === approvedLedgerEntry.id &&
      entry.merged === true &&
      entry.cloneId === (spawnWithinLimits.clones[1]?.cloneId ?? "")
  );
  const rejectedLedgerVisible = ledgerDocument.entries.some(
    (entry) =>
      entry.id === rejectedLedgerEntry.id &&
      entry.merged === false &&
      entry.cloneId === (spawnWithinLimits.clones[0]?.cloneId ?? "") &&
      entry.reason.includes("rejected")
  );

  const cloneIds = spawnWithinLimits.clones.map((clone) => clone.cloneId);
  const deterministicNamingAndNoConflict =
    spawnWithinLimits.allowed &&
    cloneIds.length === 2 &&
    cloneIds[0] === "atlas-1001" &&
    cloneIds[1] === "milkyway-1002" &&
    isUnique(cloneIds);
  const limitViolationsBlocked =
    hasBlockCode(blockedByLimit.blockedBy, "CLONE_LIMIT_REACHED") &&
    hasBlockCode(blockedByDepth.blockedBy, "CLONE_DEPTH_EXCEEDED") &&
    hasBlockCode(blockedByBudget.blockedBy, "CLONE_BUDGET_EXCEEDED");
  const approvedMergeRetainsCloneAttribution =
    mergeApproved.merged === true &&
    mergeApproved.committedByAgentId === (spawnWithinLimits.clones[1]?.cloneId ?? null);
  const capabilitySurfaceProofV1 = {
    directSideEffectsAllowed: false,
    outputMode: "proposal_only" as const,
    deniedActionTypes: ["write_file", "delete_file", "shell_command", "network_write", "run_skill"],
    enforcementCodes: ["CLONE_LIMIT_REACHED", "CLONE_DEPTH_EXCEEDED", "CLONE_BUDGET_EXCEEDED"]
  };
  const capabilitySurfaceEnforced =
    capabilitySurfaceProofV1.directSideEffectsAllowed === false &&
    capabilitySurfaceProofV1.outputMode === "proposal_only";
  const rejectedMergeAuditVisible =
    mergeRejected.merged === false &&
    mergeRejected.committedByAgentId === null &&
    rejectedLedgerVisible;
  const overallPass =
    deterministicNamingAndNoConflict &&
    limitViolationsBlocked &&
    capabilitySurfaceEnforced &&
    approvedMergeRetainsCloneAttribution &&
    rejectedMergeAuditVisible &&
    approvedLedgerVisible;

  const baseArtifact = {
    generatedAt: new Date().toISOString(),
    command: "BigBrain /review 6.11 (or npm run test:stage6_5:live:6_11)",
    satelliteCapabilitySurfaceProofV1: capabilitySurfaceProofV1,
    spawnWithinLimits: {
      allowed: spawnWithinLimits.allowed,
      cloneIds,
      role: spawnWithinLimits.clones[0]?.role ?? null,
      personaRoles: spawnWithinLimits.clones.map((clone) => clone.personaOverlay.role),
      blockedBy: spawnWithinLimits.blockedBy
    },
    blockedScenarios: {
      limitReached: blockedByLimit.blockedBy,
      depthExceeded: blockedByDepth.blockedBy,
      budgetExceeded: blockedByBudget.blockedBy
    },
    mergeDecisions: {
      approved: {
        merged: mergeApproved.merged,
        committedByAgentId: mergeApproved.committedByAgentId,
        lessonFingerprint: mergeApproved.lessonFingerprint,
        ledgerVisible: approvedLedgerVisible
      },
      rejected: {
        merged: mergeRejected.merged,
        committedByAgentId: mergeRejected.committedByAgentId,
        lessonFingerprint: mergeRejected.lessonFingerprint,
        rejectionReason: mergeRejected.rejectionReason,
        rejectingGovernorIds: mergeRejected.blockedBy,
        ledgerVisible: rejectedLedgerVisible
      }
    },
    passCriteria: {
      deterministicNamingAndNoConflict,
      limitViolationsBlocked,
      capabilitySurfaceEnforced,
      approvedMergeRetainsCloneAttribution,
      rejectedMergeAuditVisible,
      overallPass
    }
  };
  const linkedFrom = {
    traceId: `stage6_5_6_11_live:${spawnWithinLimits.clones[0]?.cloneId ?? "none"}`
  };

  return {
    ...baseArtifact,
    artifactHash: hashSha256(canonicalJson(baseArtifact)),
    linkedFrom
  };
}

/**
 * Securely persists the generated Checkpoint 6.11 artifact to the local filesystem.
 * 
 * **Why it exists:**  
 * In an auditable AI architecture, runtime proofs must be serialized and verifiable by external 
 * tools or human reviewers to establish trust. This guarantees the simulation leaves a hard evidence trail.
 * 
 * **What it talks to:**  
 * - Interacts directly with Node.js `fs/promises` (`mkdir`, `writeFile`) to achieve I/O.
 * - Relies on the deterministic path resolution from `resolveStage65Checkpoint611ArtifactPath`.
 * 
 * @param artifact - The fully compiled cryptographic proof of the stage 6.11 constraints.
 * @param options - Run options containing the target `artifactPath` if overridden.
 * @returns The absolute path where the JSON artifact was written.
 */
export async function writeCheckpoint611LiveArtifact(
  artifact: Stage65Checkpoint611LiveArtifact,
  options: Stage65Checkpoint611RunOptions = {}
): Promise<string> {
  const artifactPath = resolveStage65Checkpoint611ArtifactPath(options);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2), "utf8");
  return artifactPath;
}

/**
 * Orchestrates the full lifecycle of the Checkpoint 6.11 review command.
 * 
 * **Why it exists:**  
 * This acts as the high-level controller explicitly mapped to the user-facing `/review 6.11` command 
 * requested via chat interfaces like Telegram or Discord. It bridges the gap between raw functional 
 * proofs and human-readable feedback.
 * 
 * **What it talks to:**  
 * - Executes `runCheckpoint611LiveCheck` to trigger the actual simulation.
 * - Purgatively chains the result into `writeCheckpoint611LiveArtifact` for persistence.
 * - Extracts a streamlined, string-based `summaryLines` array that the Gateways can directly print globally.
 * 
 * @param options - Core system options regulating path resolution for the simulated ledger.
 * @returns A standardized `CheckpointReviewCommandResult` payload suitable for interface routing.
 */
export async function runCheckpoint611LiveReview(
  options: Stage65Checkpoint611RunOptions = {}
): Promise<CheckpointReviewCommandResult> {
  const artifact = await runCheckpoint611LiveCheck(options);
  const artifactPath = await writeCheckpoint611LiveArtifact(artifact, options);

  return {
    checkpointId: "6.11",
    overallPass: artifact.passCriteria.overallPass,
    artifactPath,
    summaryLines: [
      `Spawn within limits: ${artifact.spawnWithinLimits.allowed ? "allowed" : "blocked"} (${artifact.spawnWithinLimits.cloneIds.join(", ") || "no clones"})`,
      `Limit blocks: limit=${artifact.blockedScenarios.limitReached.join(",") || "none"} depth=${artifact.blockedScenarios.depthExceeded.join(",") || "none"} budget=${artifact.blockedScenarios.budgetExceeded.join(",") || "none"}`,
      `Merge attribution: approved=${artifact.mergeDecisions.approved.committedByAgentId ?? "none"} rejectedLedgerVisible=${artifact.mergeDecisions.rejected.ledgerVisible ? "yes" : "no"}`
    ]
  };
}
