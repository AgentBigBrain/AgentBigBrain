/**
 * @fileoverview Tests exported reason-code uniqueness enforcement for AI-first runtime contracts.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  assertReasonCodeUniqueness,
  computeReasonCodeUniquenessDiagnosticsFromEntries
} from "../../src/tools/checkReasonCodeUniqueness";

test("assertReasonCodeUniqueness passes for the current repo", () => {
  assert.doesNotThrow(() => assertReasonCodeUniqueness(process.cwd()));
});

test("computeReasonCodeUniquenessDiagnosticsFromEntries reports duplicate exported reason codes", () => {
  const diagnostics = computeReasonCodeUniquenessDiagnosticsFromEntries([
    {
      filePath: "src/core/a.ts",
      contents: 'export const FIRST_REASON_CODE = "DUPLICATE_REASON";\n'
    },
    {
      filePath: "src/core/b.ts",
      contents: 'export const SECOND_REASON_CODE = "DUPLICATE_REASON";\n'
    }
  ]);

  assert.deepEqual(
    diagnostics.duplicateValues.map((duplicate) => duplicate.value),
    ["DUPLICATE_REASON"]
  );
});

test("assertReasonCodeUniqueness fails when duplicate reason codes exist on disk", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-reason-code-"));
  await mkdir(path.join(repoRoot, "src/core"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "src/core/contractsA.ts"),
    'export const FIRST_REASON_CODE = "DUPLICATE_REASON";\n',
    "utf8"
  );
  await writeFile(
    path.join(repoRoot, "src/core/contractsB.ts"),
    'export const SECOND_REASON_CODE = "DUPLICATE_REASON";\n',
    "utf8"
  );

  assert.throws(
    () =>
      assertReasonCodeUniqueness(repoRoot, [
        "src/core/contractsA.ts",
        "src/core/contractsB.ts"
      ]),
    /Duplicate exported reason-code values detected/i
  );
});
