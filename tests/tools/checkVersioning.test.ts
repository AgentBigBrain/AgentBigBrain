/**
 * @fileoverview Tests versioning and changelog-structure enforcement for repo release metadata.
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertVersioning,
  computeVersioningDiagnosticsFromText
} from "../../src/tools/checkVersioning";

test("assertVersioning passes for the current repo", () => {
  assert.doesNotThrow(() => assertVersioning(process.cwd()));
});

test("computeVersioningDiagnosticsFromText reports missing unreleased headings and mojibake", () => {
  const diagnostics = computeVersioningDiagnosticsFromText(
    JSON.stringify({ version: "1.2.3" }),
    [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "### Added",
      "- Added something.",
      "",
      "## [1.2.3] â€” 2026-04-11"
    ].join("\n")
  );

  assert.match(diagnostics.issues.join("\n"), /### Changed/);
  assert.match(diagnostics.issues.join("\n"), /### Fixed/);
  assert.match(diagnostics.issues.join("\n"), /### Security/);
  assert.match(diagnostics.issues.join("\n"), /mojibake/i);
});

test("assertVersioning fails when package version and latest release drift", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-versioning-"));
  await writeFile(
    path.join(repoRoot, "package.json"),
    JSON.stringify({ version: "1.2.4" }, null, 2) + "\n",
    "utf8"
  );
  await writeFile(
    path.join(repoRoot, "CHANGELOG.md"),
    [
      "# Changelog",
      "",
      "## [Unreleased]",
      "",
      "### Added",
      "",
      "### Changed",
      "",
      "### Fixed",
      "",
      "### Security",
      "",
      "## [1.2.3] - 2026-04-11"
    ].join("\n"),
    "utf8"
  );

  assert.throws(
    () => assertVersioning(repoRoot),
    /Version mismatch: package\.json=1\.2\.4, CHANGELOG\.md latest release=1\.2\.3/i
  );
});
