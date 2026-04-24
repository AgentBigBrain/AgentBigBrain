/**
 * @fileoverview Renders lightweight Obsidian Bases definitions for major projected collections.
 */

import type { ProjectionSnapshot } from "../contracts";
import type { ObsidianProjectedNote } from "./obsidianFrontmatter";

/**
 * Renders a small set of `.base` files for key projected collections.
 *
 * **Why it exists:**
 * Bases gives operators table and card views without a custom plugin, so the mirror should project
 * stable collection definitions alongside the Markdown notes it generates.
 *
 * **What it talks to:**
 * - Uses `ProjectionSnapshot` from `../contracts`.
 *
 * @param snapshot - Full projection snapshot.
 * @returns Projected `.base` definition files.
 */
export function renderObsidianBasesFiles(
  snapshot: ProjectionSnapshot
): readonly ObsidianProjectedNote[] {
  void snapshot;
  return [
    buildBaseFile(
      "30 Bases/entities.base",
      "Entities",
      '"AgentBigBrain/10 Entities"',
      ["canonical_name", "entity_type", "updated_at"]
    ),
    buildBaseFile(
      "30 Bases/profile_subjects.base",
      "Profile Subjects",
      '"AgentBigBrain/11 Profile Subjects"',
      ["subject_label", "subject_key", "updated_at", "current_direct_fact_count", "context_fact_count"]
    ),
    buildBaseFile(
      "30 Bases/concepts.base",
      "Derived Concepts",
      '"AgentBigBrain/15 Concepts"',
      ["concept_label", "concept_kind", "updated_at", "mention_count", "profile_subject_count"]
    ),
    buildBaseFile(
      "30 Bases/episodes.base",
      "Episodes",
      '"AgentBigBrain/12 Episodes"',
      ["status", "updated_at", "source_kind"]
    ),
    buildBaseFile(
      "30 Bases/open_loops.base",
      "Open Loops",
      '"AgentBigBrain/13 Open Loops"',
      ["thread_key", "status", "updated_at"]
    ),
    buildBaseFile(
      "30 Bases/media_artifacts.base",
      "Media Artifacts",
      '"AgentBigBrain/22 Media Artifacts"',
      ["kind", "provider", "recorded_at", "mime_type"]
    )
  ];
}

/**
 * Builds one minimal `.base` file.
 *
 * **Why it exists:**
 * The mirror only needs a small deterministic subset of Bases features for the first release, and
 * a shared helper keeps those generated files uniform across collections.
 *
 * **What it talks to:**
 * - Uses local string-formatting helpers within this module.
 *
 * @param relativePath - Relative vault path for the `.base` file.
 * @param title - Human-readable base title.
 * @param source - Vault path source for the base.
 * @param properties - Ordered property names shown in the base.
 * @returns One projected `.base` file artifact.
 */
function buildBaseFile(
  relativePath: string,
  title: string,
  source: string,
  properties: readonly string[]
): ObsidianProjectedNote {
  return {
    relativePath,
    content: [
      `name: ${JSON.stringify(title)}`,
      `source: ${source}`,
      "views:",
      "  - type: table",
      "    name: \"Table\"",
      "    order:",
      ...properties.map((property) => `      - ${JSON.stringify(property)}`)
    ].join("\n")
  };
}
