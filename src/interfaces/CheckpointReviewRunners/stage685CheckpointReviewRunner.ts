/**
 * @fileoverview Runs Stage 6.85 checkpoint live-review commands with deterministic ID normalization,
 * artifact persistence, and concise summary rendering for interface `/review` routing.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runStage685CheckpointA } from "../../tools/stage6_85Playbooks";
import { runStage685CheckpointB } from "../../tools/stage6_85MissionUx";
import { runStage685CheckpointC } from "../../tools/stage6_85Clones";
import { runStage685CheckpointD } from "../../tools/stage6_85Recovery";
import { runStage685CheckpointE } from "../../tools/stage6_85QualityGates";
import { runStage685CheckpointF } from "../../tools/stage6_85WorkflowReplay";
import { runStage685CheckpointG } from "../../tools/stage6_85Latency";
import { runStage685CheckpointH } from "../../tools/stage6_85Observability";

type Stage685CheckpointId =
  | "6.85.A"
  | "6.85.B"
  | "6.85.C"
  | "6.85.D"
  | "6.85.E"
  | "6.85.F"
  | "6.85.G"
  | "6.85.H";

interface Stage685ArtifactBase {
  checkpointId: Stage685CheckpointId;
  passCriteria: {
    overallPass: boolean;
  };
}

export interface Stage685CheckpointReviewResult {
  checkpointId: string;
  overallPass: boolean;
  artifactPath: string;
  summaryLines: readonly string[];
}

export interface Stage685CheckpointReviewOptions {
  artifactPathOverrides?: Partial<Record<Stage685CheckpointId, string>>;
}

const STAGE685_CHECKPOINTS: readonly Stage685CheckpointId[] = [
  "6.85.A",
  "6.85.B",
  "6.85.C",
  "6.85.D",
  "6.85.E",
  "6.85.F",
  "6.85.G",
  "6.85.H"
];

const DEFAULT_STAGE685_ARTIFACT_PATHS: Record<Stage685CheckpointId, string> = {
  "6.85.A": "runtime/evidence/stage6_85_playbooks_report.json",
  "6.85.B": "runtime/evidence/stage6_85_mission_ux_report.json",
  "6.85.C": "runtime/evidence/stage6_85_clones_report.json",
  "6.85.D": "runtime/evidence/stage6_85_recovery_report.json",
  "6.85.E": "runtime/evidence/stage6_85_quality_gates_report.json",
  "6.85.F": "runtime/evidence/stage6_85_workflow_replay_report.json",
  "6.85.G": "runtime/evidence/stage6_85_latency_report.json",
  "6.85.H": "runtime/evidence/stage6_85_observability_report.json"
};

const STAGE685_CHECKPOINT_ALIASES: Record<string, Stage685CheckpointId> = {
  "6.85.a": "6.85.A",
  "6.85a": "6.85.A",
  "6.85.b": "6.85.B",
  "6.85b": "6.85.B",
  "6.85.c": "6.85.C",
  "6.85c": "6.85.C",
  "6.85.d": "6.85.D",
  "6.85d": "6.85.D",
  "6.85.e": "6.85.E",
  "6.85e": "6.85.E",
  "6.85.f": "6.85.F",
  "6.85f": "6.85.F",
  "6.85.g": "6.85.G",
  "6.85g": "6.85.G",
  "6.85.h": "6.85.H",
  "6.85h": "6.85.H"
};

/**
 * Sanitizes and normalizes organic user input into a rigid checkpoint identifier.
 * 
 * **Why it exists:**  
 * Users interacting via chat interfaces (Telegram/Discord) often type irregularly (e.g. "6.85a" vs "6.85.A").
 * This strips whitespace, lowercases, and maps aliases to guarantee the runner receives a strict enum value.
 * 
 * **What it talks to:**  
 * - Consults the `STAGE685_CHECKPOINT_ALIASES` dictionary to resolve the canonical `Stage685CheckpointId`.
 */
function normalizeStage685CheckpointId(rawCheckpointId: string): Stage685CheckpointId | null {
  const normalized = rawCheckpointId.trim().toLowerCase().replace(/\s+/g, "");
  return STAGE685_CHECKPOINT_ALIASES[normalized] ?? null;
}

/**
 * Resolves artifact path from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of artifact path by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param checkpointId - Stable identifier used to reference an entity or record.
 * @param options - Optional tuning knobs for this operation.
 * @returns Resulting string value.
 */
function resolveArtifactPath(
  checkpointId: Stage685CheckpointId,
  options: Stage685CheckpointReviewOptions
): string {
  const overridePath = options.artifactPathOverrides?.[checkpointId];
  if (typeof overridePath === "string" && overridePath.trim()) {
    return path.resolve(process.cwd(), overridePath);
  }
  return path.resolve(process.cwd(), DEFAULT_STAGE685_ARTIFACT_PATHS[checkpointId]);
}

/**
 * Persists artifact with deterministic state semantics.
 *
 * **Why it exists:**
 * Centralizes artifact mutations for auditability and replay.
 *
 * **What it talks to:**
 * - Uses `mkdir` (import `mkdir`) from `node:fs/promises`.
 * - Uses `writeFile` (import `writeFile`) from `node:fs/promises`.
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param artifactPath - Filesystem location used by this operation.
 * @param artifact - Value for artifact.
 * @returns Promise resolving to string.
 */
async function persistArtifact(artifactPath: string, artifact: unknown): Promise<string> {
  await mkdir(path.dirname(artifactPath), { recursive: true });
  await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return artifactPath;
}

/**
 * Builds checkpoint review result for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of checkpoint review result consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param artifact - Value for artifact.
 * @param artifactPath - Filesystem location used by this operation.
 * @param summaryLines - Message/text content processed by this function.
 * @returns Computed `Stage685CheckpointReviewResult` result.
 */
function buildCheckpointReviewResult(
  artifact: Stage685ArtifactBase,
  artifactPath: string,
  summaryLines: readonly string[]
): Stage685CheckpointReviewResult {
  return {
    checkpointId: artifact.checkpointId,
    overallPass: artifact.passCriteria.overallPass,
    artifactPath,
    summaryLines
  };
}

/**
 * Executes stage685 checkpoint areview as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the stage685 checkpoint areview runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `runStage685CheckpointA` (import `runStage685CheckpointA`) from `../../tools/stage6_85Playbooks`.
 *
 * @param artifactPath - Filesystem location used by this operation.
 * @returns Promise resolving to Stage685CheckpointReviewResult.
 */
async function runStage685CheckpointAReview(
  artifactPath: string
): Promise<Stage685CheckpointReviewResult> {
  const artifact = await runStage685CheckpointA();
  const persistedArtifactPath = await persistArtifact(artifactPath, artifact);
  return buildCheckpointReviewResult(artifact, persistedArtifactPath, [
    `Selected playbook: ${artifact.selection.selectedPlaybookId ?? "none"} (fallback=${artifact.selection.fallbackToPlanner ? "yes" : "no"})`,
    `Selection score: ${artifact.selection.topScore.toFixed(4)} fallbackScenario=${artifact.fallbackScenario.fallbackToPlanner ? "fallback" : "selected"}`
  ]);
}

/**
 * Executes stage685 checkpoint breview as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the stage685 checkpoint breview runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `runStage685CheckpointB` (import `runStage685CheckpointB`) from `../../tools/stage6_85MissionUx`.
 *
 * @param artifactPath - Filesystem location used by this operation.
 * @returns Promise resolving to Stage685CheckpointReviewResult.
 */
async function runStage685CheckpointBReview(
  artifactPath: string
): Promise<Stage685CheckpointReviewResult> {
  const artifact = await runStage685CheckpointB();
  const persistedArtifactPath = await persistArtifact(artifactPath, artifact);
  return buildCheckpointReviewResult(artifact, persistedArtifactPath, [
    `Mission states: planning=${artifact.missionState.planning} awaiting=${artifact.missionState.awaitingApproval} executing=${artifact.missionState.executing} blocked=${artifact.missionState.blocked} completed=${artifact.missionState.completed}`,
    `Approval modes: fallback=${artifact.approvals.fallback.approvalMode} tier3Default=${artifact.approvals.tier3Default.approvalMode} tier3Allowlisted=${artifact.approvals.tier3Allowlisted.approvalMode}`
  ]);
}

/**
 * Executes stage685 checkpoint creview as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the stage685 checkpoint creview runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `runStage685CheckpointC` (import `runStage685CheckpointC`) from `../../tools/stage6_85Clones`.
 *
 * @param artifactPath - Filesystem location used by this operation.
 * @returns Promise resolving to Stage685CheckpointReviewResult.
 */
async function runStage685CheckpointCReview(
  artifactPath: string
): Promise<Stage685CheckpointReviewResult> {
  const artifact = await runStage685CheckpointC();
  const persistedArtifactPath = await persistArtifact(artifactPath, artifact);
  return buildCheckpointReviewResult(artifact, persistedArtifactPath, [
    `Clone lifecycle: spawnAllowed=${artifact.cloneLifecycle.spawnAllowed ? "yes" : "no"} cloneIds=${artifact.cloneLifecycle.cloneIds.join(",") || "none"}`,
    `Merge policy: mergeable=${artifact.mergePolicy.mergeableKind.mergeable ? "yes" : "no"} blockedKindCode=${artifact.mergePolicy.blockedKind.blockCode ?? "none"}`
  ]);
}

/**
 * Executes stage685 checkpoint dreview as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the stage685 checkpoint dreview runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `runStage685CheckpointD` (import `runStage685CheckpointD`) from `../../tools/stage6_85Recovery`.
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param artifactPath - Filesystem location used by this operation.
 * @returns Promise resolving to Stage685CheckpointReviewResult.
 */
async function runStage685CheckpointDReview(
  artifactPath: string
): Promise<Stage685CheckpointReviewResult> {
  const artifact = await runStage685CheckpointD();
  const persistedArtifactPath = await persistArtifact(artifactPath, artifact);
  return buildCheckpointReviewResult(artifact, persistedArtifactPath, [
    `Last durable checkpoint action: ${artifact.checkpoints.lastDurableActionId ?? "none"} (count=${artifact.checkpoints.count})`,
    `Retry stop-limit block: ${artifact.retryPolicy.stopLimitBlocked.blockCode ?? "none"} postmortem=${artifact.postmortem.path}`
  ]);
}

/**
 * Executes stage685 checkpoint ereview as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the stage685 checkpoint ereview runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `runStage685CheckpointE` (import `runStage685CheckpointE`) from `../../tools/stage6_85QualityGates`.
 *
 * @param artifactPath - Filesystem location used by this operation.
 * @returns Promise resolving to Stage685CheckpointReviewResult.
 */
async function runStage685CheckpointEReview(
  artifactPath: string
): Promise<Stage685CheckpointReviewResult> {
  const artifact = await runStage685CheckpointE();
  const persistedArtifactPath = await persistArtifact(artifactPath, artifact);
  return buildCheckpointReviewResult(artifact, persistedArtifactPath, [
    `Verification: proofs=${artifact.verification.withProofs.passed ? "pass" : "fail"} waiver=${artifact.verification.withWaiver.passed ? "pass" : "fail"} blockedNoProof=${artifact.verification.blockedWithoutProof.passed ? "pass" : "fail"}`,
    `Truthfulness: optimistic=${artifact.truthfulness.blockedOptimistic.passed ? "pass" : "fail"} simulationLabel=${artifact.truthfulness.blockedSimulationLabelMissing.passed ? "pass" : "fail"} truthful=${artifact.truthfulness.allowedTruthful.passed ? "pass" : "fail"}`
  ]);
}

/**
 * Executes stage685 checkpoint freview as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the stage685 checkpoint freview runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `runStage685CheckpointF` (import `runStage685CheckpointF`) from `../../tools/stage6_85WorkflowReplay`.
 *
 * @param artifactPath - Filesystem location used by this operation.
 * @returns Promise resolving to Stage685CheckpointReviewResult.
 */
async function runStage685CheckpointFReview(
  artifactPath: string
): Promise<Stage685CheckpointReviewResult> {
  const artifact = await runStage685CheckpointF();
  const persistedArtifactPath = await persistArtifact(artifactPath, artifact);
  return buildCheckpointReviewResult(artifact, persistedArtifactPath, [
    `Workflow replay: capture=${artifact.capture.captureId} steps=${artifact.script.stepCount} bridgeValid=${artifact.bridge.valid ? "yes" : "no"}`,
    `Drift mapping: conflict=${artifact.drift.conflictCode ?? "none"} block=${artifact.drift.runReceiptBlockCode ?? "none"}`
  ]);
}

/**
 * Executes stage685 checkpoint greview as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the stage685 checkpoint greview runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `runStage685CheckpointG` (import `runStage685CheckpointG`) from `../../tools/stage6_85Latency`.
 *
 * @param artifactPath - Filesystem location used by this operation.
 * @returns Promise resolving to Stage685CheckpointReviewResult.
 */
async function runStage685CheckpointGReview(
  artifactPath: string
): Promise<Stage685CheckpointReviewResult> {
  const artifact = await runStage685CheckpointG();
  const persistedArtifactPath = await persistArtifact(artifactPath, artifact);
  return buildCheckpointReviewResult(artifact, persistedArtifactPath, [
    `Latency observations: passingOverall=${artifact.observations.passingOverall ? "pass" : "fail"} failingOverall=${artifact.observations.failingOverall ? "pass" : "fail"}`,
    `Cache baseline: passing=${artifact.cacheEquivalence.passing.passed ? "pass" : "fail"} failing=${artifact.cacheEquivalence.failing.passed ? "pass" : "fail"}`
  ]);
}

/**
 * Executes stage685 checkpoint hreview as part of this module's control flow.
 *
 * **Why it exists:**
 * Isolates the stage685 checkpoint hreview runtime step so higher-level orchestration stays readable.
 *
 * **What it talks to:**
 * - Uses `runStage685CheckpointH` (import `runStage685CheckpointH`) from `../../tools/stage6_85Observability`.
 *
 * @param artifactPath - Filesystem location used by this operation.
 * @returns Promise resolving to Stage685CheckpointReviewResult.
 */
async function runStage685CheckpointHReview(
  artifactPath: string
): Promise<Stage685CheckpointReviewResult> {
  const artifact = await runStage685CheckpointH();
  const persistedArtifactPath = await persistArtifact(artifactPath, artifact);
  return buildCheckpointReviewResult(artifact, persistedArtifactPath, [
    `Timeline: missionId=${artifact.timeline.missionId} events=${artifact.timeline.orderedEventTypes.join(",")}`,
    `Redaction bundle: artifacts=${artifact.redactedBundle.artifactPaths.length} redactions=${artifact.redactedBundle.redactionCount}`
  ]);
}

/**
 * Reads stage685 live review checkpoints needed for this execution step.
 *
 * **Why it exists:**
 * Separates stage685 live review checkpoints read-path handling from orchestration and mutation code.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @returns Ordered collection produced by this step.
 */
export function listStage685LiveReviewCheckpoints(): readonly string[] {
  return STAGE685_CHECKPOINTS;
}

/**
 * Orchestrates the execution and artifact persistence for Stage 6.85 Checkpoints.
 * 
 * **Why it exists:**  
 * This serves as the unified interface boundary for all Stage 6.85 review commands (A through H).
 * Rather than the Gateways knowing about 8 different underlying test engines, they route a single 
 * `rawCheckpointId` here, which normalizes the input, executes the requested cryptographic proof, 
 * and formats the result for human consumption.
 * 
 * **What it talks to:**  
 * - Dynamically routes to the corresponding core playbooks/checkpoints imported from `src/tools/`.
 * - Coordinates with `persistArtifact` to securely write the audit trails to disk.
 * 
 * @param rawCheckpointId - The unverified user input (e.g., "6.85A", "6.85.A", "6.85a").
 * @param options - Configuration overrides to manually point the generated artifacts to specific paths.
 * @returns A structured `Stage685CheckpointReviewResult` summarizing the execution, or null if the ID is invalid.
 */
export async function runStage685CheckpointLiveReview(
  rawCheckpointId: string,
  options: Stage685CheckpointReviewOptions = {}
): Promise<Stage685CheckpointReviewResult | null> {
  const checkpointId = normalizeStage685CheckpointId(rawCheckpointId);
  if (!checkpointId) {
    return null;
  }

  const artifactPath = resolveArtifactPath(checkpointId, options);
  if (checkpointId === "6.85.A") {
    return runStage685CheckpointAReview(artifactPath);
  }
  if (checkpointId === "6.85.B") {
    return runStage685CheckpointBReview(artifactPath);
  }
  if (checkpointId === "6.85.C") {
    return runStage685CheckpointCReview(artifactPath);
  }
  if (checkpointId === "6.85.D") {
    return runStage685CheckpointDReview(artifactPath);
  }
  if (checkpointId === "6.85.E") {
    return runStage685CheckpointEReview(artifactPath);
  }
  if (checkpointId === "6.85.F") {
    return runStage685CheckpointFReview(artifactPath);
  }
  if (checkpointId === "6.85.G") {
    return runStage685CheckpointGReview(artifactPath);
  }
  if (checkpointId === "6.85.H") {
    return runStage685CheckpointHReview(artifactPath);
  }

  return null;
}
