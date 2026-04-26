/**
 * @fileoverview Renders skill registry projection notes for the Obsidian mirror.
 */

import type { SkillProjectionEntry } from "../../../organs/skillRegistry/contracts";
import type { ProjectionSnapshot } from "../contracts";
import {
  renderMarkdownList,
  renderObsidianFrontmatter,
  sanitizeObsidianPathSegment,
  type ObsidianProjectedNote
} from "./obsidianFrontmatter";

/**
 * Renders review notes for active governed skills.
 *
 * **Why it exists:**
 * Operators need a way to inspect built-in and local Markdown guidance without turning the vault
 * into a trusted runtime source. These notes are projection-only and carry explicit policy labels.
 *
 * **What it talks to:**
 * - Uses policy-filtered skill projection entries from `ProjectionSnapshot`.
 * - Uses shared Obsidian rendering helpers.
 *
 * @param snapshot - Full projection snapshot.
 * @returns Obsidian notes for skill review.
 */
export function renderObsidianSkillNotes(
  snapshot: ProjectionSnapshot
): readonly ObsidianProjectedNote[] {
  const summary = renderSkillSummaryNote(snapshot);
  const skillNotes = snapshot.skillProjectionEntries.map((entry) =>
    renderSkillDetailNote(entry, snapshot.generatedAt)
  );
  return [summary, ...skillNotes];
}

/**
 * Renders the skill projection summary note.
 *
 * @param snapshot - Full projection snapshot.
 * @returns Summary note.
 */
function renderSkillSummaryNote(snapshot: ProjectionSnapshot): ObsidianProjectedNote {
  const entries = snapshot.skillProjectionEntries;
  return {
    relativePath: "32 Skills/Skills.md",
    content: [
      renderObsidianFrontmatter({
        abb_type: "skill_projection_summary",
        updated_at: snapshot.generatedAt,
        skill_count: entries.length
      }),
      "# Governed Skills",
      "",
      "These notes are review mirrors only. They are not runtime authority for memory, permissions, execution, or skill selection.",
      "",
      renderMarkdownList(
        entries.map((entry) => `${entry.name} (${entry.kind}, ${entry.origin})`)
      )
    ].join("\n")
  };
}

/**
 * Renders one skill detail note.
 *
 * @param entry - Policy-filtered skill projection entry.
 * @param generatedAt - Snapshot timestamp.
 * @returns Skill detail note.
 */
function renderSkillDetailNote(
  entry: SkillProjectionEntry,
  generatedAt: string
): ObsidianProjectedNote {
  const contentSection = entry.projectedContent
    ? ["## Projected Content", "", entry.projectedContent]
    : [
        "## Projected Content",
        "",
        "Content is withheld by projection policy or unavailable in this mode."
      ];

  return {
    relativePath: `32 Skills/${sanitizeObsidianPathSegment(entry.name)}.md`,
    content: [
      renderObsidianFrontmatter({
        abb_type: "skill_projection",
        updated_at: generatedAt,
        skill_name: entry.name,
        kind: entry.kind,
        origin: entry.origin,
        memory_policy: entry.memoryPolicy,
        projection_policy: entry.projectionPolicy,
        content_mode: entry.contentMode,
        verification_status: entry.verificationStatus
      }),
      `# ${entry.name}`,
      "",
      entry.description,
      "",
      "Projection lane: governed skill review mirror. This note is never runtime authority.",
      "",
      "## Policy",
      "",
      renderMarkdownList([
        `Kind: ${entry.kind}`,
        `Origin: ${entry.origin}`,
        `Lifecycle: ${entry.lifecycleStatus}`,
        `Memory policy: ${entry.memoryPolicy}`,
        `Projection policy: ${entry.projectionPolicy}`,
        `Projected content mode: ${entry.contentMode}`
      ]),
      "## Invocation Hints",
      "",
      renderMarkdownList([...entry.invocationHints]),
      "## Tags",
      "",
      renderMarkdownList([...entry.tags]),
      ...contentSection
    ].join("\n")
  };
}
