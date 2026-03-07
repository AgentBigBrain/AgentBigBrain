/**
 * @fileoverview Tests AI file-classification coverage enforcement against the real repo map and synthetic failure cases.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { assertFileClassificationCoverage } from "../../src/tools/checkFileClassificationCoverage";

test("assertFileClassificationCoverage passes for the current repo classification map", () => {
  assert.doesNotThrow(() => assertFileClassificationCoverage(process.cwd()));
});

test("assertFileClassificationCoverage fails when a source file is missing from the map", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-file-coverage-"));
  await mkdir(path.join(repoRoot, "docs/ai"), { recursive: true });
  await mkdir(path.join(repoRoot, "src/core"), { recursive: true });
  await writeFile(path.join(repoRoot, "src/core/one.ts"), "export {};\n", "utf8");
  await writeFile(path.join(repoRoot, "src/core/two.ts"), "export {};\n", "utf8");
  await writeFile(
    path.join(repoRoot, "docs/ai/file-classification-map.json"),
    JSON.stringify(
      {
        schema_version: 1,
        source_root: "src",
        source_file_count: 2,
        bucket_semantics: {
          stays_in_place: "stays",
          becomes_thin_entrypoint: "thin",
          moves_or_splits: "moves",
          explicitly_out_of_scope: "out"
        },
        entries: {
          stays_in_place: ["src/core/one.ts"],
          explicitly_out_of_scope: [],
          becomes_thin_entrypoint: [],
          moves_or_splits: []
        }
      },
      null,
      2
    ),
    "utf8"
  );

  assert.throws(
    () => assertFileClassificationCoverage(repoRoot),
    /Missing classified source paths/i
  );
});
