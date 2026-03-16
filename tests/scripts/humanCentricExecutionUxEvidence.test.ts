/**
 * @fileoverview Covers deterministic scenario inventory validation and evidence artifact generation for human-centric execution UX.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  computeHumanCentricExecutionUxScenarioDiagnostics,
  loadHumanCentricExecutionUxScenarioInventory
} from "../../scripts/evidence/humanCentricExecutionUxSupport";
import {
  runHumanCentricExecutionUxEvidence
} from "../../scripts/evidence/humanCentricExecutionUxEvidence";

test("human-centric execution UX scenario inventory passes for current fixture", async () => {
  const inventory = await loadHumanCentricExecutionUxScenarioInventory();
  const diagnostics = computeHumanCentricExecutionUxScenarioDiagnostics(inventory);
  assert.equal(diagnostics.errors.length, 0);
  assert.ok(diagnostics.summary.scenarioCount >= 10);
});

test("human-centric execution UX evidence emits a PASS artifact with required proofs", async () => {
  const artifact = await runHumanCentricExecutionUxEvidence();
  const artifactPath = path.resolve(
    process.cwd(),
    "runtime/evidence/human_centric_execution_ux_report.json"
  );
  const persisted = JSON.parse(await readFile(artifactPath, "utf8")) as {
    status: string;
    requiredProofs: Record<string, boolean>;
    localIntentModel: {
      status: string;
    };
    summary: {
      scenarioCount: number;
      passedScenarios: number;
      failedScenarios: number;
    };
  };

  assert.equal(artifact.status, "PASS");
  assert.equal(persisted.status, "PASS");
  assert.equal(persisted.summary.failedScenarios, 0);
  assert.notEqual(persisted.localIntentModel.status, "FAIL");
  assert.equal(
    Object.values(persisted.requiredProofs).every((value) => value === true),
    true
  );
});
