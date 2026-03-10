/**
 * @fileoverview Covers the scenario-driven evidence report for media ingest and execution intent.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  runMediaIngestExecutionIntentEvidence
} from "../../scripts/evidence/mediaIngestExecutionIntentEvidence";

test("media-ingest execution-intent evidence emits a passing artifact with required proofs", async () => {
  const artifact = await runMediaIngestExecutionIntentEvidence();
  const artifactPath = path.resolve(
    process.cwd(),
    "runtime/evidence/media_ingest_execution_intent_report.json"
  );
  const persisted = JSON.parse(await readFile(artifactPath, "utf8")) as {
    status: string;
    requiredProofs: Record<string, boolean>;
    summary: {
      scenarioCount: number;
      passedScenarios: number;
      failedScenarios: number;
    };
    scenarioResults: Array<{
      scenarioId: string;
      passed: boolean;
    }>;
  };

  assert.equal(artifact.status, "PASS");
  assert.equal(persisted.status, "PASS");
  assert.equal(persisted.summary.failedScenarios, 0);
  assert.equal(persisted.summary.scenarioCount, 4);
  assert.equal(
    Object.values(persisted.requiredProofs).every((value) => value === true),
    true
  );
  assert.ok(
    persisted.scenarioResults.some(
      (scenario) => scenario.scenarioId === "image_fix_now" && scenario.passed
    )
  );
  assert.ok(
    persisted.scenarioResults.some(
      (scenario) => scenario.scenarioId === "video_plan_or_build" && scenario.passed
    )
  );
  assert.ok(
    persisted.scenarioResults.some(
      (scenario) => scenario.scenarioId === "voice_memory_followup" && scenario.passed
    )
  );
});
