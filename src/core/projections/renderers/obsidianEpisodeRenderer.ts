/**
 * @fileoverview Renders profile-memory episode notes for the Obsidian projection sink.
 */

import type { ProjectionSnapshot } from "../contracts";
import {
  renderMarkdownList,
  renderObsidianFrontmatter,
  type ObsidianProjectedNote
} from "./obsidianFrontmatter";
import {
  buildEpisodeNoteRelativePath,
  buildProjectionLinkIndex,
  renderObsidianWikiLink
} from "./obsidianLinks";

/**
 * Renders one Markdown note per retained profile-memory episode.
 *
 * **Why it exists:**
 * Remembered situations are one of the most operator-visible parts of the temporal memory system,
 * so the mirror needs readable episode notes instead of burying them in encrypted store internals.
 *
 * **What it talks to:**
 * - Uses `ProjectionSnapshot` from `../contracts`.
 * - Uses rendering helpers from `./obsidianFrontmatter`.
 *
 * @param snapshot - Full projection snapshot.
 * @returns Projected episode notes keyed by stable relative vault paths.
 */
export function renderObsidianEpisodeNotes(
  snapshot: ProjectionSnapshot
): readonly ObsidianProjectedNote[] {
  const episodes = snapshot.profileMemory?.episodes ?? [];
  const linkIndex = buildProjectionLinkIndex(snapshot);
  return episodes.map((episode) => {
    const entityLinks = episode.entityRefs.map((entityRef) => {
      const entityPath = linkIndex.entityPathsByKey.get(entityRef);
      const label = linkIndex.entityLabelsByKey.get(entityRef) ?? entityRef;
      return entityPath
        ? renderObsidianWikiLink(entityPath, label)
        : label;
    });
    const openLoopLinks = episode.openLoopRefs.map((loopRef) => {
      const loopPath = linkIndex.openLoopPathsById.get(loopRef);
      return loopPath
        ? renderObsidianWikiLink(loopPath, loopRef)
        : loopRef;
    });
    const content = [
      renderObsidianFrontmatter({
        abb_id: episode.id,
        abb_type: "episode",
        status: episode.status,
        updated_at: episode.lastUpdatedAt,
        source_kind: episode.sourceKind
      }),
      `# ${episode.summary}`,
      "",
      "## Status",
      `- ${episode.status}`,
      "",
      "## Entities",
      renderMarkdownList(entityLinks),
      "## Tags",
      renderMarkdownList(episode.tags),
      "## Open Loop Refs",
      renderMarkdownList(openLoopLinks),
      "## Provenance",
      renderMarkdownList([
        `Observed at: ${episode.observedAt}`,
        `Source task: ${episode.sourceTaskId}`,
        `Confidence: ${episode.confidence}`
      ])
    ].join("\n");

    return {
      relativePath: buildEpisodeNoteRelativePath(episode.observedAt, episode.summary),
      content
    };
  });
}
