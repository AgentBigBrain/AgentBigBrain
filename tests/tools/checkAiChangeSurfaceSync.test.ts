/**
 * @fileoverview Tests AI change-surface sync enforcement against the real repo artifacts and synthetic failure cases.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  AiChangeSurfaceCatalog,
  FileClassificationMap,
  renderAiArchitectureIndex
} from "../../src/tools/exportAiArchitectureIndex";
import { assertAiChangeSurfaceSync } from "../../src/tools/checkAiChangeSurfaceSync";

async function writeFixtureRepo(rootDir: string, staleIndex: boolean): Promise<void> {
  const catalog: AiChangeSurfaceCatalog = {
    schema_version: 1,
    description: "Synthetic catalog for sync tests.",
    surfaces: [
      {
        id: "synthetic_surface",
        title: "Synthetic Surface",
        phase_target: "Phase 0",
        refactor_wave: "current",
        summary: "Synthetic change surface for sync tests.",
        current_surface_files: ["src/core/synthetic.ts"],
        contract_files: ["src/core/contracts.ts"],
        planned_target_files: ["src/core/next.ts"],
        verification_files: ["tests/core/synthetic.test.ts"],
        doc_files: ["docs/plans/synthetic-plan.md"],
        validation_commands: ["npm test"]
      }
    ]
  };
  const map: FileClassificationMap = {
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
      stays_in_place: ["src/core/contracts.ts", "src/core/synthetic.ts"],
      explicitly_out_of_scope: [],
      becomes_thin_entrypoint: [],
      moves_or_splits: []
    }
  };

  await mkdir(path.join(rootDir, "docs/ai"), { recursive: true });
  await mkdir(path.join(rootDir, "docs/plans"), { recursive: true });
  await mkdir(path.join(rootDir, "src/core"), { recursive: true });
  await mkdir(path.join(rootDir, "tests/core"), { recursive: true });
  await writeFile(
    path.join(rootDir, "docs/ai/change-surfaces.json"),
    JSON.stringify(catalog, null, 2),
    "utf8"
  );
  await writeFile(
    path.join(rootDir, "docs/ai/file-classification-map.json"),
    JSON.stringify(map, null, 2),
    "utf8"
  );
  await writeFile(path.join(rootDir, "docs/plans/synthetic-plan.md"), "# Synthetic Plan\n", "utf8");
  await writeFile(path.join(rootDir, "src/core/synthetic.ts"), "export {};\n", "utf8");
  await writeFile(path.join(rootDir, "src/core/contracts.ts"), "export {};\n", "utf8");
  await writeFile(path.join(rootDir, "tests/core/synthetic.test.ts"), "export {};\n", "utf8");

  const rendered = renderAiArchitectureIndex(catalog, map);
  await writeFile(
    path.join(rootDir, "docs/ai/architecture-index.md"),
    staleIndex ? "# stale\n" : rendered,
    "utf8"
  );
}

test("assertAiChangeSurfaceSync passes for the current repo artifacts", () => {
  assert.doesNotThrow(() => assertAiChangeSurfaceSync(process.cwd()));
});

test("assertAiChangeSurfaceSync fails when the generated architecture index is stale", async () => {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-ai-sync-"));
  await writeFixtureRepo(repoRoot, true);

  assert.throws(
    () => assertAiChangeSurfaceSync(repoRoot),
    /architecture-index\.md is out of sync/i
  );
});
