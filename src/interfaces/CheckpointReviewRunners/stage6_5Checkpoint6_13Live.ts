/**
 * @fileoverview Runs deterministic Stage 6.5 checkpoint 6.13 (workflow learning and temporal adaptation) live checks and writes reviewer artifacts.
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { adaptWorkflowPatterns } from "../../core/advancedAutonomyFoundation";
import { WorkflowPattern } from "../../core/types";

const DEFAULT_STAGE6_5_CHECKPOINT_6_13_ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_5_6_13_live_check_output.json"
);

export interface Stage65Checkpoint613RunOptions {
  artifactPath?: string;
}

export interface Stage65Checkpoint613LiveArtifact {
  artifactHash: string;
  linkedFrom: {
    receiptHash?: string;
    traceId?: string;
  };
  generatedAt: string;
  command: string;
  seededPatternIds: readonly string[];
  observations: {
    recurringSuccessObservedAt: string;
    changedBehaviorObservedAt: string;
    supersedesKeys: readonly string[];
  };
  confidenceTrace: {
    taxFilingBefore: number;
    taxFilingAfterRecurringSuccess: number;
    taxFilingAfterSupersession: number;
    taxCompletedAfterInsert: number;
    vetBefore: number;
    vetAfterRecurringDecay: number;
    vetAfterChangedBehaviorDecay: number;
  };
  supersession: {
    supersededPatternIds: readonly string[];
    supersededAt: string | null;
    supersededStatus: string | null;
    newActiveWorkflowKey: string;
  };
  passCriteria: {
    deterministicConfidenceUpdates: boolean;
    deterministicDecayApplied: boolean;
    changedBehaviorSupersededStalePattern: boolean;
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
 * Resolves stage65 checkpoint613 artifact path from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of stage65 checkpoint613 artifact path by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param options - Optional tuning knobs for this operation.
 * @returns Resulting string value.
 */
function resolveStage65Checkpoint613ArtifactPath(options: Stage65Checkpoint613RunOptions): string {
  if (typeof options.artifactPath === "string" && options.artifactPath.trim()) {
    return path.resolve(process.cwd(), options.artifactPath);
  }
  return DEFAULT_STAGE6_5_CHECKPOINT_6_13_ARTIFACT_PATH;
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
 * Executes a deterministic simulation of the Stage 6.5 Checkpoint 6.13 logic.
 * 
 * **Why it exists:**  
 * This function is the live validation engine for "Workflow Learning and Temporal Adaptation". It proves 
 * that the system can autonomously observe behavioral success across domain lanes, adapt confidence 
 * scores temporally (decaying stale workflows), and supersede obsolete workflows with new, more successful ones.
 * 
 * **What it talks to:**  
 * - Relies on `adaptWorkflowPatterns` from the core foundation to execute mathematical confidence mutations.
 * - Iterates over internal `WorkflowPattern` arrays to simulate memory ingestion and decay passes over time.
 * 
 * **What it does:**  
 * 1. Seeds two mock historical workflows (`followup.tax.filing` and `followup.vet.payment`) with baseline confidences.
 * 2. Simulates a recurring success for the tax workflow, asserting that confidence boosts correctly.
 * 3. Simulates a novel, superseding workflow (`followup.tax.completed`), asserting that the engine structurally supersedes and decays the older tax pattern.
 * 4. Verifies deterministic temporal decay across untouched patterns (like the vet workflow).
 * 5. Compiles a cryptographic trace of the adaptation math into a `Stage65Checkpoint613LiveArtifact`.
 * 
 * @param options - Configuration overrides to manually point the generated artifact to a specific path.
 * @returns A structured artifact containing cryptographically hashed proofs of the temporal learning mechanics.
 */
export async function runCheckpoint613LiveCheck(
  options: Stage65Checkpoint613RunOptions = {}
): Promise<Stage65Checkpoint613LiveArtifact> {
  const startingPatterns: readonly WorkflowPattern[] = [
    {
      id: "workflow_pattern_old_tax",
      workflowKey: "followup.tax.filing",
      status: "active",
      confidence: 0.78,
      firstSeenAt: "2026-02-01T00:00:00.000Z",
      lastSeenAt: "2026-02-10T00:00:00.000Z",
      supersededAt: null,
      domainLane: "workflow",
      successCount: 3,
      failureCount: 1,
      suppressedCount: 0,
      contextTags: ["tax", "followup"]
    },
    {
      id: "workflow_pattern_vet",
      workflowKey: "followup.vet.payment",
      status: "active",
      confidence: 0.66,
      firstSeenAt: "2026-02-01T00:00:00.000Z",
      lastSeenAt: "2026-02-10T00:00:00.000Z",
      supersededAt: null,
      domainLane: "workflow",
      successCount: 2,
      failureCount: 1,
      suppressedCount: 0,
      contextTags: ["vet", "payment"]
    }
  ];

  const recurringSuccessObservedAt = "2026-02-26T00:00:00.000Z";
  const changedBehaviorObservedAt = "2026-02-27T00:00:00.000Z";
  const supersedesKeys = ["followup.tax.filing"];

  const recurringResult = adaptWorkflowPatterns(
    startingPatterns,
    {
      workflowKey: "followup.tax.filing",
      outcome: "success",
      observedAt: recurringSuccessObservedAt,
      domainLane: "workflow",
      contextTags: ["tax", "deadline"]
    },
    {
      decayIntervalDays: 7,
      decayStep: 0.05,
      successBoost: 0.12
    }
  );

  const changedBehaviorResult = adaptWorkflowPatterns(
    recurringResult.patterns,
    {
      workflowKey: "followup.tax.completed",
      outcome: "success",
      observedAt: changedBehaviorObservedAt,
      domainLane: "workflow",
      contextTags: ["tax", "completed"],
      supersedesKeys
    },
    {
      decayIntervalDays: 7,
      decayStep: 0.05,
      successBoost: 0.12
    }
  );

  const recurringTaxPattern = recurringResult.patterns.find(
    (pattern) => pattern.id === "workflow_pattern_old_tax"
  );
  const supersededTaxPattern = changedBehaviorResult.patterns.find(
    (pattern) => pattern.id === "workflow_pattern_old_tax"
  );
  const recurringVetPattern = recurringResult.patterns.find(
    (pattern) => pattern.id === "workflow_pattern_vet"
  );
  const changedVetPattern = changedBehaviorResult.patterns.find(
    (pattern) => pattern.id === "workflow_pattern_vet"
  );
  const insertedTaxCompletedPattern = changedBehaviorResult.updatedPattern;

  const deterministicConfidenceUpdates =
    recurringTaxPattern?.confidence === 0.8 &&
    supersededTaxPattern?.confidence === 0.25 &&
    insertedTaxCompletedPattern.confidence === 0.67;
  const deterministicDecayApplied =
    recurringVetPattern?.confidence === 0.56 &&
    changedVetPattern?.confidence === 0.46;
  const changedBehaviorSupersededStalePattern =
    supersededTaxPattern?.status === "superseded" &&
    supersededTaxPattern.supersededAt === changedBehaviorObservedAt &&
    changedBehaviorResult.supersededPatternIds.includes("workflow_pattern_old_tax");
  const overallPass =
    deterministicConfidenceUpdates &&
    deterministicDecayApplied &&
    changedBehaviorSupersededStalePattern;

  const baseArtifact = {
    generatedAt: new Date().toISOString(),
    command: "BigBrain /review 6.13 (or npm run test:stage6_5:live:6_13)",
    seededPatternIds: startingPatterns.map((pattern) => pattern.id),
    observations: {
      recurringSuccessObservedAt,
      changedBehaviorObservedAt,
      supersedesKeys
    },
    confidenceTrace: {
      taxFilingBefore: startingPatterns[0].confidence,
      taxFilingAfterRecurringSuccess: recurringTaxPattern?.confidence ?? 0,
      taxFilingAfterSupersession: supersededTaxPattern?.confidence ?? 0,
      taxCompletedAfterInsert: insertedTaxCompletedPattern.confidence,
      vetBefore: startingPatterns[1].confidence,
      vetAfterRecurringDecay: recurringVetPattern?.confidence ?? 0,
      vetAfterChangedBehaviorDecay: changedVetPattern?.confidence ?? 0
    },
    supersession: {
      supersededPatternIds: changedBehaviorResult.supersededPatternIds,
      supersededAt: supersededTaxPattern?.supersededAt ?? null,
      supersededStatus: supersededTaxPattern?.status ?? null,
      newActiveWorkflowKey: insertedTaxCompletedPattern.workflowKey
    },
    passCriteria: {
      deterministicConfidenceUpdates,
      deterministicDecayApplied,
      changedBehaviorSupersededStalePattern,
      overallPass
    }
  };
  const linkedFrom = {
    traceId: `stage6_5_6_13_live:${startingPatterns[0].id}`
  };

  return {
    ...baseArtifact,
    artifactHash: hashSha256(canonicalJson(baseArtifact)),
    linkedFrom
  };
}

/**
 * Securely persists the generated Checkpoint 6.13 workflow learning artifact to the local filesystem.
 * 
 * **Why it exists:**  
 * To maintain a transparent, cryptographically linked proof of how the engine adapts over time. 
 * External audits need this JSON graph to verify behavior decay mathematics without running the engine.
 * 
 * **What it talks to:**  
 * - Interfaces directly with Node.js `fs/promises` (`mkdir`, `writeFile`).
 * - Resolves dynamic pathing from `resolveStage65Checkpoint613ArtifactPath`.
 * 
 * @param artifact - The fully compiled cryptographic proof of the stage 6.13 pattern adaptation.
 * @param options - Run options containing the target `artifactPath` if overridden.
 * @returns The absolute path where the JSON artifact was written.
 */
export async function writeCheckpoint613LiveArtifact(
  artifact: Stage65Checkpoint613LiveArtifact,
  options: Stage65Checkpoint613RunOptions = {}
): Promise<string> {
  const artifactPath = resolveStage65Checkpoint613ArtifactPath(options);
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, JSON.stringify(artifact, null, 2), "utf8");
  return artifactPath;
}

/**
 * Orchestrates the full lifecycle of the Checkpoint 6.13 review command.
 * 
 * **Why it exists:**  
 * Acts as the centralized execution wrapper for the user-facing `/review 6.13` interaction in a chat Gateway. 
 * Converts complex temporal mathematical proofs into readable human-summarized text for the interface overlay.
 * 
 * **What it talks to:**  
 * - Executes `runCheckpoint613LiveCheck` to drive the core adaptation logic.
 * - Safely saves the proof blob using `writeCheckpoint613LiveArtifact`.
 * - Translates the math diffs into human-readable strings (e.g., Confidence trace: tax=0.78 -> 0.80 -> 0.25).
 * 
 * @param options - Optional system configuration, generally overriding artifact write paths.
 * @returns A structured `CheckpointReviewCommandResult` payload tailored for Gateway transmission.
 */
export async function runCheckpoint613LiveReview(
  options: Stage65Checkpoint613RunOptions = {}
): Promise<CheckpointReviewCommandResult> {
  const artifact = await runCheckpoint613LiveCheck(options);
  const artifactPath = await writeCheckpoint613LiveArtifact(artifact, options);

  return {
    checkpointId: "6.13",
    overallPass: artifact.passCriteria.overallPass,
    artifactPath,
    summaryLines: [
      `Confidence trace: tax=${artifact.confidenceTrace.taxFilingBefore.toFixed(2)} -> ${artifact.confidenceTrace.taxFilingAfterRecurringSuccess.toFixed(2)} -> ${artifact.confidenceTrace.taxFilingAfterSupersession.toFixed(2)} new=${artifact.confidenceTrace.taxCompletedAfterInsert.toFixed(2)}`,
      `Decay trace: vet=${artifact.confidenceTrace.vetBefore.toFixed(2)} -> ${artifact.confidenceTrace.vetAfterRecurringDecay.toFixed(2)} -> ${artifact.confidenceTrace.vetAfterChangedBehaviorDecay.toFixed(2)}`,
      `Supersession: ids=${artifact.supersession.supersededPatternIds.join(",") || "none"} at=${artifact.supersession.supersededAt ?? "none"} status=${artifact.supersession.supersededStatus ?? "none"}`
    ]
  };
}
