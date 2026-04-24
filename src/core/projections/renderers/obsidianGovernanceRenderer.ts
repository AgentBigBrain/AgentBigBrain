/**
 * @fileoverview Renders grouped governance decision notes for the Obsidian projection sink.
 */

import type { ProjectionSnapshot } from "../contracts";
import {
  renderMarkdownList,
  renderObsidianFrontmatter,
  type ObsidianProjectedNote
} from "./obsidianFrontmatter";

/**
 * Renders one grouped governance note from the current governance read view.
 *
 * **Why it exists:**
 * Governance history is operationally important but too noisy for one note per event in the first
 * mirror release, so the sink groups recent decisions into one readable summary note.
 *
 * **What it talks to:**
 * - Uses `ProjectionSnapshot` from `../contracts`.
 * - Uses rendering helpers from `./obsidianFrontmatter`.
 *
 * @param snapshot - Full projection snapshot.
 * @returns Grouped governance notes for the vault mirror.
 */
export function renderObsidianGovernanceNotes(
  snapshot: ProjectionSnapshot
): readonly ObsidianProjectedNote[] {
  return [
    {
      relativePath: "20 Governance/Recent Decisions.md",
      content: [
        renderObsidianFrontmatter({
          abb_type: "governance_summary",
          updated_at: snapshot.generatedAt
        }),
        "# Recent Governance Decisions",
        "",
        "## Recent Events",
        renderMarkdownList(
          snapshot.governanceReadView.recentEvents.map((event) =>
            `${event.recordedAt}: ${event.actionType} -> ${event.outcome} (${event.blockCategory})`
          )
        ),
        "## Recent Block Counts",
        renderMarkdownList(
          Object.entries(snapshot.governanceReadView.recentBlockCounts).map(([reason, count]) =>
            `${reason}: ${count}`
          )
        ),
        "## Recent Governor Reject Counts",
        renderMarkdownList(
          Object.entries(snapshot.governanceReadView.recentGovernorRejectCounts).map(([governorId, count]) =>
            `${governorId}: ${count}`
          )
        )
      ].join("\n")
    }
  ];
}
