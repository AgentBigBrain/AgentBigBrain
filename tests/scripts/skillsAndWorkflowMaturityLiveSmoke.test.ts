/**
 * @fileoverview Covers the runtime-backed live smoke artifact for skills/workflow maturity.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  runSkillsAndWorkflowMaturityLiveSmoke
} from "../../scripts/evidence/skillsAndWorkflowMaturityLiveSmoke";

test("skills/workflow maturity live smoke emits pass artifact with all required proofs", async () => {
  const artifact = await runSkillsAndWorkflowMaturityLiveSmoke();
  const artifactPath = path.resolve(
    process.cwd(),
    "runtime/evidence/skills_and_workflow_maturity_live_smoke_report.json"
  );
  const persisted = JSON.parse(await readFile(artifactPath, "utf8")) as {
    status: string;
    requiredProofs: Record<string, boolean>;
    summary: {
      scenarioCount: number;
      failedScenarios: number;
    };
    scenarioResults: Array<{
      scenarioId: string;
      passed: boolean;
    }>;
  };

  assert.equal(artifact.status, "PASS");
  assert.equal(persisted.status, "PASS");
  assert.equal(Object.values(persisted.requiredProofs).every(Boolean), true);
  assert.equal(persisted.summary.scenarioCount, 3);
  assert.equal(persisted.summary.failedScenarios, 0);
  assert.ok(
    persisted.scenarioResults.some(
      (scenario) => scenario.scenarioId === "skill_discovery_text_and_voice" && scenario.passed
    )
  );
});
