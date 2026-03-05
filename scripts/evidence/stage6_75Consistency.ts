/**
 * @fileoverview Runs Stage 6.75 checkpoint 6.75.E consistency preflight checks and emits stale/conflict fail-closed evidence artifact.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { evaluateConsistencyPreflight } from "../../src/core/stage6_75ConsistencyPolicy";

const ARTIFACT_PATH = path.resolve(
  process.cwd(),
  "runtime/evidence/stage6_75_consistency_report.json"
);

interface Stage675CheckpointEArtifact {
  generatedAt: string;
  command: string;
  checkpointId: "6.75.E";
  decisions: {
    unresolvedConflictBlocked: boolean;
    staleWatermarkBlocked: boolean;
    freshWatermarkAllowed: boolean;
    staleBlockCode: string | null;
    conflictBlockCode: string | null;
  };
  passCriteria: {
    conflictPass: boolean;
    stalePass: boolean;
    freshPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Implements `runStage675CheckpointE` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
export async function runStage675CheckpointE(): Promise<Stage675CheckpointEArtifact> {
  const unresolvedConflict = evaluateConsistencyPreflight({
    nowIso: "2026-02-27T23:00:00.000Z",
    lastReadAtIso: "2026-02-27T22:59:30.000Z",
    freshnessWindowMs: 2_000,
    unresolvedConflict: {
      conflictCode: "CONFLICT_OBJECT_UNRESOLVED",
      detail: "Calendar event overlap",
      observedAtWatermark: "2026-02-27T22:59:45.000Z"
    }
  });
  const staleWatermark = evaluateConsistencyPreflight({
    nowIso: "2026-02-27T23:00:00.000Z",
    lastReadAtIso: "2026-02-27T22:50:00.000Z",
    freshnessWindowMs: 2_000,
    unresolvedConflict: null
  });
  const freshWatermark = evaluateConsistencyPreflight({
    nowIso: "2026-02-27T23:00:00.000Z",
    lastReadAtIso: "2026-02-27T22:59:59.500Z",
    freshnessWindowMs: 2_000,
    unresolvedConflict: null
  });

  const conflictPass =
    !unresolvedConflict.ok && unresolvedConflict.blockCode === "CONFLICT_OBJECT_UNRESOLVED";
  const stalePass = !staleWatermark.ok && staleWatermark.blockCode === "STATE_STALE_REPLAN_REQUIRED";
  const freshPass = freshWatermark.ok;

  return {
    generatedAt: new Date().toISOString(),
    command: "npm run test:stage6_75:consistency",
    checkpointId: "6.75.E",
    decisions: {
      unresolvedConflictBlocked: !unresolvedConflict.ok,
      staleWatermarkBlocked: !staleWatermark.ok,
      freshWatermarkAllowed: freshWatermark.ok,
      staleBlockCode: staleWatermark.blockCode,
      conflictBlockCode: unresolvedConflict.blockCode
    },
    passCriteria: {
      conflictPass,
      stalePass,
      freshPass,
      overallPass: conflictPass && stalePass && freshPass
    }
  };
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const artifact = await runStage675CheckpointE();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

  console.log(`Stage 6.75 checkpoint 6.75.E artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
