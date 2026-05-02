/**
 * @fileoverview Tests policy-filtered skill projection records.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { buildSkillProjectionEntries } from "../../src/core/projections/skillProjectionPolicy";
import type { SkillManifest } from "../../src/organs/skillRegistry/contracts";

function buildSkillManifestFixture(
  overrides: Partial<SkillManifest> = {}
): SkillManifest {
  return {
    name: "document-reading",
    kind: "markdown_instruction",
    origin: "runtime_user",
    description: "Read documents generically.",
    purpose: "Keep document reading broad and source-labeled.",
    inputSummary: "Document request.",
    outputSummary: "Guidance.",
    riskLevel: "low",
    allowedSideEffects: [],
    tags: ["document"],
    capabilities: ["reading"],
    version: "1.0.0",
    createdAt: "2026-04-12T00:00:00.000Z",
    updatedAt: "2026-04-12T00:00:00.000Z",
    verificationStatus: "unverified",
    verificationVerifiedAt: null,
    verificationFailureReason: null,
    verificationTestInput: null,
    verificationExpectedOutputContains: null,
    userSummary: "Document reading guidance.",
    invocationHints: ["Use document reading guidance."],
    lifecycleStatus: "active",
    activationSource: "explicit_user_request",
    instructionPath: null,
    primaryPath: "document-reading.md",
    compatibilityPath: "document-reading.md",
    memoryPolicy: "candidate_only",
    projectionPolicy: "review_safe_excerpt",
    ...overrides
  };
}

test("buildSkillProjectionEntries redacts review-safe Markdown excerpts", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-skill-projection-"));
  try {
    const instructionPath = path.join(tempDir, "document-reading.md");
    await writeFile(
      instructionPath,
      [
        "---",
        "kind: markdown_instruction",
        "---",
        "# Document Reading",
        "",
        "Use source labels for extracted text.",
        "C:\\Users\\example\\Desktop\\private-draft"
      ].join("\n"),
      "utf8"
    );

    const entries = await buildSkillProjectionEntries("review_safe", [
      buildSkillManifestFixture({ instructionPath })
    ]);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.contentMode, "review_safe_excerpt");
    assert.match(entries[0]?.projectedContent ?? "", /Use source labels/);
    assert.doesNotMatch(entries[0]?.projectedContent ?? "", /private-draft/);
    assert.match(entries[0]?.projectedContent ?? "", /\[redacted projection line\]/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildSkillProjectionEntries exposes full Markdown only when operator-full policy allows it", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-skill-projection-full-"));
  try {
    const instructionPath = path.join(tempDir, "full-guidance.md");
    await writeFile(
      instructionPath,
      ["# Full Guidance", "", "Detailed operator-visible guidance."].join("\n"),
      "utf8"
    );

    const [entry] = await buildSkillProjectionEntries("operator_full", [
      buildSkillManifestFixture({
        name: "full-guidance",
        instructionPath,
        projectionPolicy: "operator_full_content"
      })
    ]);

    assert.equal(entry?.contentMode, "operator_full_content");
    assert.match(entry?.projectedContent ?? "", /Detailed operator-visible guidance/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
