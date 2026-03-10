/**
 * @fileoverview Covers the runtime-backed media ingest and execution-intent live smoke artifact.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  runMediaIngestExecutionIntentLiveSmoke
} from "../../scripts/evidence/mediaIngestExecutionIntentLiveSmoke";

test("media-ingest execution-intent live smoke emits a passing artifact with all required proofs", async () => {
  const artifact = await runMediaIngestExecutionIntentLiveSmoke();
  const artifactPath = path.resolve(
    process.cwd(),
    "runtime/evidence/media_ingest_execution_intent_live_smoke_report.json"
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
      (scenario) => scenario.scenarioId === "voice_fix_now" && scenario.passed
    )
  );
  assert.ok(
    persisted.scenarioResults.some(
      (scenario) => scenario.scenarioId === "voice_memory_followup" && scenario.passed
    )
  );
});
