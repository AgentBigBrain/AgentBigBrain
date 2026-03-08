/**
 * @fileoverview Covers the runtime-backed human-language generalization live smoke artifact.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  runHumanLanguageGeneralizationLiveSmoke
} from "../../scripts/evidence/humanLanguageGeneralizationLiveSmoke";

test("human language live smoke emits pass artifact with all required proofs", async () => {
  const artifact = await runHumanLanguageGeneralizationLiveSmoke();
  const artifactPath = path.resolve(
    process.cwd(),
    "runtime/evidence/human_language_generalization_live_smoke_report.json"
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
      (scenario) =>
        scenario.scenarioId === "contextual_recall_live_positive" &&
        scenario.passed
    )
  );
  assert.ok(
    persisted.scenarioResults.some(
      (scenario) =>
        scenario.scenarioId === "generic_proactive_live_suppressed" &&
        scenario.passed
    )
  );
});
