/**
 * @fileoverview Covers canonical skill-manifest persistence, verification, and inspection helpers.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applySkillVerificationResult } from "../../src/organs/skillRegistry/skillLifecycle";
import { renderSkillInventory } from "../../src/organs/skillRegistry/skillInspection";
import {
  buildSkillManifest,
  extractSkillVerificationConfig
} from "../../src/organs/skillRegistry/skillManifest";
import { SkillRegistryStore } from "../../src/organs/skillRegistry/skillRegistryStore";
import { evaluateSkillVerificationResult } from "../../src/organs/skillRegistry/skillVerification";
import type { CreateSkillActionParams } from "../../src/core/types";

function buildCreateSkillParams(overrides: Partial<CreateSkillActionParams> = {}): CreateSkillActionParams {
  return {
    name: "triage_planner_failure",
    code: "export default async function run(input) { return `triaged:${input}`; }",
    description: "Inspect planner failures and summarize likely causes.",
    purpose: "Provide deterministic planner failure triage.",
    inputSummary: "Short planner failure description.",
    outputSummary: "Short triage summary.",
    riskLevel: "low",
    allowedSideEffects: ["filesystem_read"],
    tags: ["planner", "tests"],
    capabilities: ["triage", "planner"],
    version: "1.0.0",
    userSummary: "Reusable tool for planner failure triage.",
    invocationHints: ["Ask me to run skill triage_planner_failure."],
    testInput: "planner action mismatch",
    expectedOutputContains: "triaged",
    ...overrides
  };
}

test("skill registry persists manifests and renders trusted inventory entries", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-skill-registry-"));
  try {
    const nowIso = "2026-03-10T12:00:00.000Z";
    const artifactPaths = {
      skillsRoot: tempDir,
      primaryPath: path.join(tempDir, "triage_planner_failure.js"),
      compatibilityPath: path.join(tempDir, "triage_planner_failure.ts"),
      manifestPath: path.join(tempDir, "triage_planner_failure.manifest.json")
    };
    const manifest = buildSkillManifest(
      buildCreateSkillParams(),
      "triage_planner_failure",
      artifactPaths,
      nowIso
    );
    const store = new SkillRegistryStore(tempDir);
    await store.saveManifest(manifest);

    const verification = evaluateSkillVerificationResult(
      "triaged: planner action mismatch",
      manifest.verificationExpectedOutputContains,
      "2026-03-10T12:05:00.000Z"
    );
    const verifiedManifest = applySkillVerificationResult(
      manifest,
      verification,
      "2026-03-10T12:05:00.000Z"
    );
    await store.saveManifest(verifiedManifest);

    const loadedManifest = await store.loadManifest("triage_planner_failure");
    const inventory = await store.listAvailableSkills();
    const renderedInventory = renderSkillInventory(inventory);

    assert.ok(loadedManifest);
    assert.equal(loadedManifest?.verificationStatus, "verified");
    assert.equal(loadedManifest?.verificationVerifiedAt, "2026-03-10T12:05:00.000Z");
    assert.equal(inventory.length, 1);
    assert.match(renderedInventory, /^Available skills:/);
    assert.match(renderedInventory, /triage_planner_failure/);
    assert.match(renderedInventory, /verified, low risk/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("skill registry hides deprecated manifests and keeps failed verification explicit", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-skill-registry-"));
  try {
    const nowIso = "2026-03-10T13:00:00.000Z";
    const store = new SkillRegistryStore(tempDir);
    const activeArtifactPaths = {
      skillsRoot: tempDir,
      primaryPath: path.join(tempDir, "active.js"),
      compatibilityPath: path.join(tempDir, "active.ts"),
      manifestPath: path.join(tempDir, "active.manifest.json")
    };
    const deprecatedArtifactPaths = {
      skillsRoot: tempDir,
      primaryPath: path.join(tempDir, "deprecated.js"),
      compatibilityPath: path.join(tempDir, "deprecated.ts"),
      manifestPath: path.join(tempDir, "deprecated.manifest.json")
    };

    const activeManifest = buildSkillManifest(
      buildCreateSkillParams({
        name: "active",
        userSummary: "Active verified summary.",
        invocationHints: ["Ask me to run skill active."]
      }),
      "active",
      activeArtifactPaths,
      nowIso
    );
    const failedVerification = evaluateSkillVerificationResult(
      "summary without expected token",
      activeManifest.verificationExpectedOutputContains,
      "2026-03-10T13:05:00.000Z"
    );
    await store.saveManifest(
      applySkillVerificationResult(activeManifest, failedVerification, "2026-03-10T13:05:00.000Z")
    );

    const deprecatedManifest = buildSkillManifest(
      buildCreateSkillParams({
        name: "deprecated",
        lifecycleStatus: "deprecated",
        userSummary: "Deprecated summary."
      } as Partial<CreateSkillActionParams>),
      "deprecated",
      deprecatedArtifactPaths,
      nowIso
    );
    await store.saveManifest({
      ...deprecatedManifest,
      lifecycleStatus: "deprecated",
      updatedAt: "2026-03-10T13:10:00.000Z"
    });

    const inventory = await store.listAvailableSkills();
    const loadedActive = await store.loadManifest("active");

    assert.equal(inventory.length, 1);
    assert.equal(inventory[0]?.name, "active");
    assert.equal(loadedActive?.verificationStatus, "failed");
    assert.match(loadedActive?.verificationFailureReason ?? "", /Expected skill output to include/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("extractSkillVerificationConfig keeps verification settings bounded and explicit", () => {
  const config = extractSkillVerificationConfig(
    buildCreateSkillParams({
      testInput: "  planner branch mismatch  ",
      expectedOutputContains: "  normalized branch mismatch  "
    })
  );

  assert.equal(config.testInput, "planner branch mismatch");
  assert.equal(config.expectedOutputContains, "normalized branch mismatch");
});
