/**
 * @fileoverview Covers runtime-backed live smoke artifact generation for human-centric execution UX.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  runHumanCentricExecutionUxLiveSmoke
} from "../../scripts/evidence/humanCentricExecutionUxLiveSmoke";

test("human-centric execution UX live smoke emits a PASS artifact with all required proofs", async () => {
  const artifact = await runHumanCentricExecutionUxLiveSmoke();
  const artifactPath = path.resolve(
    process.cwd(),
    "runtime/evidence/human_centric_execution_ux_live_smoke_report.json"
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
  assert.ok(persisted.summary.scenarioCount >= 7);
  assert.equal(
    Object.values(persisted.requiredProofs).every((value) => value === true),
    true
  );
});
