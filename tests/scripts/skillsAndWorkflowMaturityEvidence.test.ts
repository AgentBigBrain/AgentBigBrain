/**
 * @fileoverview Covers deterministic evidence for the skills/workflow maturity plan.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  runSkillsAndWorkflowMaturityEvidence
} from "../../scripts/evidence/skillsAndWorkflowMaturityEvidence";

test("skills/workflow maturity evidence emits pass artifact with all required proofs", async () => {
  const artifact = await runSkillsAndWorkflowMaturityEvidence();
  const artifactPath = path.resolve(
    process.cwd(),
    "runtime/evidence/skills_and_workflow_maturity_report.json"
  );
  const persisted = JSON.parse(await readFile(artifactPath, "utf8")) as {
    status: string;
    requiredProofs: Record<string, boolean>;
    checks: Array<{
      label: string;
      passed: boolean;
    }>;
  };

  assert.equal(artifact.status, "PASS");
  assert.equal(persisted.status, "PASS");
  assert.equal(Object.values(persisted.requiredProofs).every(Boolean), true);
  assert.ok(
    persisted.checks.some((check) => check.label === "voice-skills-discovery" && check.passed)
  );
  assert.ok(
    persisted.checks.some((check) => check.label === "workflow-bridge-preferred-skill" && check.passed)
  );
});
