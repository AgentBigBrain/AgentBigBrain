import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  runAutonomousRuntimeAffordancesEvidence
} from "../../scripts/evidence/autonomousRuntimeAffordancesEvidence";

test("autonomous runtime affordances evidence report covers every behavior family with positive and negative controls", async () => {
  const artifact = await runAutonomousRuntimeAffordancesEvidence();
  const artifactPath = path.resolve(
    process.cwd(),
    "runtime/evidence/autonomous_runtime_affordances_report.json"
  );
  const persisted = JSON.parse(await readFile(artifactPath, "utf8")) as {
    status: string;
    checks: Record<string, boolean>;
    diagnostics: {
      scenarioCount: number;
      categoryCounts: Record<string, number>;
      polarityCounts: Record<string, number>;
    };
    categories: Array<{
      category: string;
      positiveScenario: {
        openingUserPrompt: string;
        expectedOutcomeClass: string[];
      };
      negativeControl: {
        openingUserPrompt: string;
        expectedOutcomeClass: string[];
      };
    }>;
  };

  assert.equal(artifact.status, "PASS");
  assert.equal(persisted.status, "PASS");
  assert.equal(Object.values(persisted.checks).every(Boolean), true);
  assert.equal(persisted.diagnostics.scenarioCount >= 20, true);
  assert.equal(Object.keys(persisted.diagnostics.categoryCounts).length, 10);
  assert.equal(persisted.diagnostics.polarityCounts.positive, 10);
  assert.equal(persisted.diagnostics.polarityCounts.negative, 10);
  assert.equal(persisted.categories.length, 10);
  for (const category of persisted.categories) {
    assert.ok(category.positiveScenario.openingUserPrompt.length >= 40);
    assert.ok(category.negativeControl.openingUserPrompt.length >= 40);
    assert.ok(category.positiveScenario.expectedOutcomeClass.length > 0);
    assert.ok(category.negativeControl.expectedOutcomeClass.length > 0);
  }
});
