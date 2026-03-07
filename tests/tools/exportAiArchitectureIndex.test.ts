/**
 * @fileoverview Tests deterministic AI architecture-index rendering.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AiChangeSurfaceCatalog,
  FileClassificationMap,
  renderAiArchitectureIndex
} from "../../src/tools/exportAiArchitectureIndex";

test("renderAiArchitectureIndex sorts surfaces and includes coverage counts", () => {
  const catalog: AiChangeSurfaceCatalog = {
    schema_version: 1,
    description: "Synthetic catalog for renderer tests.",
    surfaces: [
      {
        id: "zeta_surface",
        title: "Zeta Surface",
        phase_target: "Later wave",
        refactor_wave: "future",
        summary: "Later-wave surface.",
        current_surface_files: ["src/zeta.ts"],
        contract_files: [],
        planned_target_files: [],
        verification_files: [],
        doc_files: ["docs/plan.md"],
        validation_commands: ["npm test"]
      },
      {
        id: "alpha_surface",
        title: "Alpha Surface",
        phase_target: "Phase 1",
        refactor_wave: "current",
        summary: "Current-wave surface.",
        current_surface_files: ["src/alpha.ts"],
        contract_files: ["src/contracts.ts"],
        planned_target_files: ["src/next.ts"],
        verification_files: ["tests/alpha.test.ts"],
        doc_files: ["docs/alpha.md"],
        validation_commands: ["npm run build"]
      }
    ]
  };
  const map: FileClassificationMap = {
    schema_version: 1,
    source_root: "src",
    source_file_count: 3,
    bucket_semantics: {
      stays_in_place: "stays",
      becomes_thin_entrypoint: "thin",
      moves_or_splits: "moves",
      explicitly_out_of_scope: "out"
    },
    entries: {
      stays_in_place: ["src/alpha.ts"],
      explicitly_out_of_scope: ["src/zeta.ts"],
      becomes_thin_entrypoint: [
        {
          path: "src/root.ts",
          target_paths: ["src/root.ts", "src/next.ts"],
          phase: 2,
          reason: "Synthetic thin entrypoint."
        }
      ],
      moves_or_splits: []
    }
  };

  const rendered = renderAiArchitectureIndex(catalog, map);

  assert.match(rendered, /Total classified source files: `3`/);
  assert.match(rendered, /`becomes_thin_entrypoint`: `1`/);
  assert.match(rendered, /### Alpha Surface \(`alpha_surface`\)/);
  assert.match(rendered, /### Zeta Surface \(`zeta_surface`\)/);
  assert.ok(
    rendered.indexOf("### Alpha Surface (`alpha_surface`)") <
      rendered.indexOf("### Zeta Surface (`zeta_surface`)"),
    "surfaces should render in deterministic id order"
  );
  assert.match(rendered, /No planned target files recorded yet\./);
});
