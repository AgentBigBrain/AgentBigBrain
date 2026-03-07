/**
 * @fileoverview Tests subsystem README freshness enforcement for AI-first subsystem docs.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertSubsystemReadmeSync,
  computeSubsystemReadmeSyncDiagnostics,
  SubsystemReadmeSpec
} from "../../src/tools/checkSubsystemReadmeSync";

test("assertSubsystemReadmeSync passes for the current repo", () => {
  assert.doesNotThrow(() => assertSubsystemReadmeSync(process.cwd()));
});

test("computeSubsystemReadmeSyncDiagnostics reports missing headings and file references", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-readme-sync-"));
  await mkdir(path.join(repoRoot, "src/example"), { recursive: true });
  await writeFile(path.join(repoRoot, "src/example/alpha.ts"), "export {};\n", "utf8");
  await writeFile(path.join(repoRoot, "src/example/README.md"), "## Responsibility\n", "utf8");

  const specs: readonly SubsystemReadmeSpec[] = [
    {
      name: "example",
      codeDir: "src/example",
      readmePath: "src/example/README.md",
      requiredHeadings: [
        "## Responsibility",
        "## Inputs",
        "## Outputs",
        "## Invariants",
        "## Related Tests",
        "## When to Update This README"
      ]
    }
  ];

  const diagnostics = computeSubsystemReadmeSyncDiagnostics(repoRoot, specs);

  assert.equal(diagnostics.issues.length, 1);
  assert.deepEqual(diagnostics.issues[0].missingFileReferences, ["alpha.ts"]);
  assert.match(diagnostics.issues[0].missingHeadings.join("\n"), /## Inputs/);
});

test("assertSubsystemReadmeSync fails when a subsystem README is missing", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-readme-missing-"));
  await mkdir(path.join(repoRoot, "src/example"), { recursive: true });
  await writeFile(path.join(repoRoot, "src/example/alpha.ts"), "export {};\n", "utf8");

  const specs: readonly SubsystemReadmeSpec[] = [
    {
      name: "example",
      codeDir: "src/example",
      readmePath: "src/example/README.md",
      requiredHeadings: [
        "## Responsibility",
        "## Inputs",
        "## Outputs",
        "## Invariants",
        "## Related Tests",
        "## When to Update This README"
      ]
    }
  ];

  assert.throws(
    () => assertSubsystemReadmeSync(repoRoot, specs),
    /Subsystem README sync check found issues/i
  );
});
