/**
 * @fileoverview Renders Stage 6.86 entity notes for the Obsidian projection sink.
 */

import type { ProjectionSnapshot } from "../contracts";
import {
  renderMarkdownList,
  renderObsidianFrontmatter,
  type ObsidianProjectedNote
} from "./obsidianFrontmatter";
import {
  collectProjectedCurrentSurfaceClaimsForEntity,
  renderProjectedClaimValue,
  shouldProjectEntityNote
} from "../policy";
import {
  buildEntityNoteRelativePath,
  buildProjectionLinkIndex,
  renderObsidianWikiLink
} from "./obsidianLinks";

/**
 * Renders one Markdown note per entity in the Stage 6.86 entity graph.
 *
 * **Why it exists:**
 * Operators need one stable place to inspect the live entity graph, aliases, and current claims
 * without opening raw runtime JSON or stitching together identity state from multiple stores.
 *
 * **What it talks to:**
 * - Uses `ProjectionSnapshot` from `../contracts`.
 * - Uses rendering helpers from `./obsidianFrontmatter`.
 * - Uses `renderProjectedClaimValue(...)` from `../policy`.
 *
 * @param snapshot - Full projection snapshot.
 * @returns Projected entity notes keyed by stable relative vault paths.
 */
export function renderObsidianEntityNotes(
  snapshot: ProjectionSnapshot
): readonly ObsidianProjectedNote[] {
  const linkIndex = buildProjectionLinkIndex(snapshot);
  return snapshot.entityGraph.entities
    .filter((entity) => shouldProjectEntityNote(snapshot, entity))
    .map((entity) => {
    const matchingClaims = collectProjectedCurrentSurfaceClaimsForEntity(snapshot, entity);
    const relatedEdges = snapshot.entityGraph.edges
      .filter((edge) => edge.sourceEntityKey === entity.entityKey || edge.targetEntityKey === entity.entityKey)
      .map((edge) => {
        const counterpart = edge.sourceEntityKey === entity.entityKey ? edge.targetEntityKey : edge.sourceEntityKey;
        const counterpartPath = linkIndex.entityPathsByKey.get(counterpart);
        const counterpartLabel = linkIndex.entityLabelsByKey.get(counterpart) ?? counterpart;
        const relatedEntity = counterpartPath
          ? renderObsidianWikiLink(counterpartPath, counterpartLabel)
          : counterpartLabel;
        return `${relatedEntity} (${edge.relationType}, ${edge.status})`;
      });
    const relatedEpisodes = (snapshot.profileMemory?.episodes ?? [])
      .filter((episode) => episode.entityRefs.includes(entity.entityKey))
      .map((episode) => {
        const episodePath = linkIndex.episodePathsById.get(episode.id);
        return episodePath
          ? renderObsidianWikiLink(episodePath, episode.summary)
          : episode.summary;
      });
    const relatedOpenLoops = snapshot.runtimeState.conversationStack.threads
      .flatMap((thread) => thread.openLoops ?? [])
      .filter((loop) => (loop.entityRefs ?? []).includes(entity.entityKey))
      .map((loop) => {
        const stableId = loop.loopId;
        const loopPath = linkIndex.openLoopPathsById.get(stableId);
        const label = stableId;
        return loopPath
          ? renderObsidianWikiLink(loopPath, label)
          : label;
      });
    const observationFacts = [
      "Projection lane: Stage 6.86 continuity entity graph",
      `Type: ${entity.entityType}`,
      `Domain: ${entity.domainHint ?? "unspecified"}`,
      `First seen: ${entity.firstSeenAt}`,
      `Last seen: ${entity.lastSeenAt}`,
      `Salience: ${entity.salience.toFixed(2)}`,
      `Continuity evidence refs: ${entity.evidenceRefs.length}`,
      `Current temporal claims: ${matchingClaims.length}`
    ];
    const aliasLines = entity.aliases.filter((alias) => alias !== entity.canonicalName);
    const interpretationLines = matchingClaims.length > 0
      ? [
        `This entity has ${matchingClaims.length} current profile-memory claim${matchingClaims.length === 1 ? "" : "s"} anchored to it.`,
        "Continuity relations and evidence refs below show surrounding context, not the full truth contract."
      ]
      : [
        "No current profile-memory claims are directly aligned to this continuity entity right now.",
        "Related entities and evidence refs below are continuity signals only. They are not verified current facts by themselves."
      ];

    const content = [
      renderObsidianFrontmatter({
        abb_id: entity.entityKey,
        abb_type: "entity",
        canonical_name: entity.canonicalName,
        entity_type: entity.entityType,
        updated_at: entity.lastSeenAt,
        aliases: entity.aliases
      }),
      `# ${entity.canonicalName}`,
      "",
      "## Overview",
      renderMarkdownList(observationFacts),
      "## Interpretation",
      renderMarkdownList(interpretationLines),
      "## Aliases",
      renderMarkdownList(aliasLines),
      "## Current Temporal Claims",
      renderMarkdownList(
        matchingClaims.map((claim) =>
          `${claim.payload.family}: ${renderProjectedClaimValue(snapshot.mode, claim)}`
        ),
        "- No current profile-memory claims anchored to this entity."
      ),
      "## Continuity Relations",
      renderMarkdownList(relatedEdges),
      "## Related Episodes",
      renderMarkdownList(relatedEpisodes),
      "## Open Loops",
      renderMarkdownList(relatedOpenLoops),
      "## Continuity Evidence Refs",
      renderMarkdownList(entity.evidenceRefs)
    ].join("\n");

    return {
      relativePath: linkIndex.entityPathsByKey.get(entity.entityKey)
        ?? buildEntityNoteRelativePath(entity, new Map([[entity.canonicalName, 1]])),
      content
    };
  });
}
