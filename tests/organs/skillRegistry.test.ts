/**
 * @fileoverview Covers canonical skill-manifest persistence, verification, and inspection helpers.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { applySkillVerificationResult } from "../../src/organs/skillRegistry/skillLifecycle";
import { renderSkillInventory } from "../../src/organs/skillRegistry/skillInspection";
import {
  buildSkillManifest,
  extractSkillVerificationConfig,
  parseSkillManifest
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
    activationSource: "explicit_user_request",
    ...overrides
  };
}

test("skill registry persists manifests and renders trusted inventory entries", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-skill-registry-"));
  try {
    const nowIso = "2026-03-10T12:00:00.000Z";
    const artifactPaths = {
      skillsRoot: tempDir,
      instructionPath: path.join(tempDir, "triage_planner_failure.md"),
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
    const store = new SkillRegistryStore(tempDir, path.join(tempDir, "no-builtins"));
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
    assert.equal(loadedManifest?.kind, "executable_module");
    assert.equal(loadedManifest?.origin, "runtime_user");
    assert.equal(loadedManifest?.memoryPolicy, "none");
    assert.equal(loadedManifest?.projectionPolicy, "metadata_only");
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
    const store = new SkillRegistryStore(tempDir, path.join(tempDir, "no-builtins"));
    const activeArtifactPaths = {
      skillsRoot: tempDir,
      instructionPath: path.join(tempDir, "active.md"),
      primaryPath: path.join(tempDir, "active.js"),
      compatibilityPath: path.join(tempDir, "active.ts"),
      manifestPath: path.join(tempDir, "active.manifest.json")
    };
    const deprecatedArtifactPaths = {
      skillsRoot: tempDir,
      instructionPath: path.join(tempDir, "deprecated.md"),
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

test("parseSkillManifest normalizes legacy executable manifests", () => {
  const parsed = parseSkillManifest({
    name: "legacy_skill",
    description: "Legacy executable skill.",
    purpose: "Keep old manifests compatible.",
    inputSummary: "String input.",
    outputSummary: "String output.",
    riskLevel: "low",
    allowedSideEffects: [],
    tags: [],
    capabilities: [],
    version: "1.0.0",
    createdAt: "2026-03-10T12:00:00.000Z",
    updatedAt: "2026-03-10T12:00:00.000Z",
    verificationStatus: "verified",
    verificationVerifiedAt: "2026-03-10T12:01:00.000Z",
    verificationFailureReason: null,
    verificationTestInput: null,
    verificationExpectedOutputContains: null,
    userSummary: "Legacy skill.",
    invocationHints: [],
    lifecycleStatus: "active",
    primaryPath: "/tmp/legacy_skill.js",
    compatibilityPath: "/tmp/legacy_skill.ts"
  });

  assert.ok(parsed);
  assert.equal(parsed?.kind, "executable_module");
  assert.equal(parsed?.origin, "runtime_user");
  assert.equal(parsed?.instructionPath, null);
  assert.equal(parsed?.memoryPolicy, "none");
  assert.equal(parsed?.projectionPolicy, "metadata_only");
});

test("skill registry merges built-in Markdown guidance and runtime overrides", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-skill-registry-"));
  const builtInDir = path.join(tempDir, "builtins");
  const runtimeDir = path.join(tempDir, "runtime");
  try {
    await mkdir(builtInDir, { recursive: true });
    await writeFile(
      path.join(builtInDir, "static-site-generation.md"),
      [
        "---",
        "kind: markdown_instruction",
        "name: static-site-generation",
        "description: Built-in static site guidance.",
        "tags: static, site, html, browser",
        "memoryPolicy: candidate_only",
        "projectionPolicy: review_safe_excerpt",
        "---",
        "# Static Site",
        "",
        "Prefer a self-contained index.html when no framework is needed."
      ].join("\n"),
      "utf8"
    );

    const store = new SkillRegistryStore(runtimeDir, builtInDir);
    const inventory = await store.listAvailableSkills();
    const guidance = await store.listApplicableGuidance("build a static html site", 3);
    const manifest = await store.loadManifest("static-site-generation");

    assert.equal(inventory.length, 1);
    assert.equal(inventory[0]?.kind, "markdown_instruction");
    assert.equal(inventory[0]?.origin, "builtin");
    assert.equal(manifest?.memoryPolicy, "candidate_only");
    assert.equal(guidance.length, 1);
    assert.equal(guidance[0]?.name, "static-site-generation");
    assert.equal(guidance[0]?.selectionSource, "source_controlled_builtin_manifest");
    assert.equal(guidance[0]?.advisoryAuthority, "advisory_only");
    assert.equal(guidance[0]?.matchedTerms.includes("static"), true);
    assert.match(guidance[0]?.guidance ?? "", /self-contained index\.html/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("skill registry guidance uses exact token matches instead of substring matches", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-skill-registry-"));
  const builtInDir = path.join(tempDir, "builtins");
  const runtimeDir = path.join(tempDir, "runtime");
  try {
    await mkdir(builtInDir, { recursive: true });
    await writeFile(
      path.join(builtInDir, "app-generation.md"),
      [
        "---",
        "kind: markdown_instruction",
        "name: app-generation",
        "description: Application build guidance.",
        "tags: app, build",
        "---",
        "# App",
        "",
        "Use this only for app build requests."
      ].join("\n"),
      "utf8"
    );

    const store = new SkillRegistryStore(runtimeDir, builtInDir);
    const guidance = await store.listApplicableGuidance("What is happening next?", 3);

    assert.equal(guidance.length, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("buildSkillManifest defaults omitted runtime activation source to pending approval", () => {
  const manifest = buildSkillManifest(
    buildCreateSkillParams({
      activationSource: undefined
    }),
    "suggested_skill",
    {
      skillsRoot: "/tmp/skills",
      instructionPath: "/tmp/skills/suggested_skill.md",
      primaryPath: "/tmp/skills/suggested_skill.js",
      compatibilityPath: "/tmp/skills/suggested_skill.ts",
      manifestPath: "/tmp/skills/suggested_skill.manifest.json"
    },
    "2026-03-10T12:00:00.000Z"
  );

  assert.equal(manifest.activationSource, "agent_suggestion");
  assert.equal(manifest.lifecycleStatus, "pending_approval");
});

test("skill registry fail-closes invalid runtime overrides before built-in fallback", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-skill-registry-"));
  const builtInDir = path.join(tempDir, "builtins");
  const runtimeDir = path.join(tempDir, "runtime");
  try {
    await mkdir(builtInDir, { recursive: true });
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(
      path.join(builtInDir, "static-site-generation.md"),
      [
        "---",
        "kind: markdown_instruction",
        "name: static-site-generation",
        "description: Built-in static site guidance.",
        "tags: static, site, html, browser",
        "memoryPolicy: candidate_only",
        "projectionPolicy: review_safe_excerpt",
        "---",
        "# Static Site",
        "",
        "Prefer a self-contained index.html when no framework is needed."
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      path.join(runtimeDir, "static-site-generation.manifest.json"),
      "{ invalid json",
      "utf8"
    );

    const store = new SkillRegistryStore(runtimeDir, builtInDir);
    const manifest = await store.loadManifest("static-site-generation");
    const inventory = await store.listAvailableSkills();
    const guidance = await store.listApplicableGuidance("build a static html site", 3);

    assert.equal(manifest, null);
    assert.equal(inventory.some((entry) => entry.name === "static-site-generation"), false);
    assert.equal(guidance.some((entry) => entry.name === "static-site-generation"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("skill registry selects built-in browser and document Markdown guidance", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-skill-registry-builtins-"));
  try {
    const store = new SkillRegistryStore(path.join(tempDir, "runtime"));
    const browserGuidance = await store.listApplicableGuidance(
      "Reopen the tracked browser preview, close the exact browser session, and stop the linked process lease.",
      5
    );
    const documentGuidance = await store.listApplicableGuidance(
      "Read the uploaded PDF document, extract requested fields, keep source labels, and avoid memory persistence.",
      5
    );
    const staticGuidance = await store.listApplicableGuidance(
      "Build a plain static HTML page on my Desktop and open it in a browser.",
      5
    );

    const browserRecovery = browserGuidance.find((entry) => entry.name === "browser-recovery");
    const documentReading = documentGuidance.find((entry) => entry.name === "document-reading");
    const staticSite = staticGuidance.find((entry) => entry.name === "static-site-generation");
    assert.ok(browserRecovery);
    assert.ok(documentReading);
    assert.ok(staticSite);
    assert.match(browserRecovery.guidance, /tracked browser session ids/i);
    assert.match(documentReading.guidance, /candidate-only/i);
    assert.match(staticSite.guidance, /governed `open_browser` action/i);
    assert.match(staticSite.guidance, /do\s+not use `verify_browser` for local file previews/i);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
