/**
 * @fileoverview Builds stable Obsidian note paths and wikilinks for the projection renderers.
 */

import type { ProjectionSnapshot } from "../contracts";
import type { EntityNodeV1 } from "../../types";
import { sanitizeObsidianPathSegment } from "./obsidianFrontmatter";
import { shouldProjectEntityNote } from "../policy";

export interface ProjectionLinkIndex {
  readonly entityPathsByKey: ReadonlyMap<string, string>;
  readonly entityLabelsByKey: ReadonlyMap<string, string>;
  readonly episodePathsById: ReadonlyMap<string, string>;
  readonly openLoopPathsById: ReadonlyMap<string, string>;
  readonly mediaArtifactPathsById: ReadonlyMap<string, string>;
}

/**
 * Builds the canonical relative path for one projected entity note.
 *
 * **Why it exists:**
 * Entity renderers and cross-note link renderers both need the same path logic so note creation
 * and wikilink generation cannot drift.
 *
 * **What it talks to:**
 * - Uses `sanitizeObsidianPathSegment(...)` from `./obsidianFrontmatter`.
 *
 * @param entity - Entity to map to a stable note path.
 * @param projectedNameCounts - Count of projected entities by canonical name.
 * @returns Stable relative note path.
 */
export function buildEntityNoteRelativePath(
  entity: Pick<EntityNodeV1, "entityKey" | "canonicalName" | "entityType" | "domainHint" | "disambiguator">,
  projectedNameCounts: ReadonlyMap<string, number>
): string {
  const duplicateCount = projectedNameCounts.get(entity.canonicalName) ?? 0;
  if (duplicateCount <= 1) {
    return `10 Entities/${sanitizeObsidianPathSegment(entity.canonicalName)}.md`;
  }

  const suffixParts = [
    entity.disambiguator,
    entity.entityType,
    entity.domainHint,
    entity.entityKey.slice(-6)
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

  return `10 Entities/${sanitizeObsidianPathSegment(
    `${entity.canonicalName} (${suffixParts.join(", ")})`
  )}.md`;
}

/**
 * Builds the canonical relative path for one projected episode note.
 *
 * **Why it exists:**
 * Episode notes need stable filenames that still reflect the observed date and summary while
 * staying short enough for Windows path limits.
 *
 * **What it talks to:**
 * - Uses `sanitizeObsidianPathSegment(...)` from `./obsidianFrontmatter`.
 *
 * @param observedAt - Episode observation timestamp.
 * @param summary - Episode summary text.
 * @returns Stable relative note path.
 */
export function buildEpisodeNoteRelativePath(observedAt: string, summary: string): string {
  return `12 Episodes/${sanitizeObsidianPathSegment(`${observedAt.slice(0, 10)} ${summary}`)}.md`;
}

/**
 * Builds the canonical relative path for one projected open-loop note.
 *
 * **Why it exists:**
 * Continuity renderers and cross-note links both refer to open-loop notes, so this path logic
 * needs one shared definition.
 *
 * **What it talks to:**
 * - Uses `sanitizeObsidianPathSegment(...)` from `./obsidianFrontmatter`.
 *
 * @param loopIdOrText - Stable loop id or fallback text.
 * @returns Stable relative note path.
 */
export function buildOpenLoopNoteRelativePath(loopIdOrText: string): string {
  return `13 Open Loops/${sanitizeObsidianPathSegment(loopIdOrText)}.md`;
}

/**
 * Builds the canonical relative path for one projected media-artifact note.
 *
 * **Why it exists:**
 * Media artifact notes need stable companion-note paths for both rendering and wikilink generation.
 *
 * **What it talks to:**
 * - Uses `sanitizeObsidianPathSegment(...)` from `./obsidianFrontmatter`.
 *
 * @param recordedAt - Artifact timestamp.
 * @param titleBase - File name or human-readable artifact title.
 * @returns Stable relative note path.
 */
export function buildMediaArtifactNoteRelativePath(recordedAt: string, titleBase: string): string {
  return `22 Media Artifacts/${sanitizeObsidianPathSegment(`${recordedAt.slice(0, 10)} ${titleBase}`)}.md`;
}

/**
 * Converts one projected Markdown path into an Obsidian wikilink target.
 *
 * **Why it exists:**
 * Obsidian wikilinks should target note paths without the `.md` suffix, and that normalization
 * should stay shared across all renderers.
 *
 * **What it talks to:**
 * - Uses local path-normalization rules within this module.
 *
 * @param relativePath - Relative projected Markdown path.
 * @returns Obsidian wikilink target path.
 */
export function toObsidianWikiTarget(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/\.md$/i, "");
}

/**
 * Renders one Obsidian wikilink for a projected note.
 *
 * **Why it exists:**
 * Multiple renderers need readable links, and keeping the format in one place avoids ad hoc link
 * syntax drift.
 *
 * **What it talks to:**
 * - Uses `toObsidianWikiTarget(...)` in this module.
 *
 * @param relativePath - Relative projected Markdown path.
 * @param label - Optional display label.
 * @returns Obsidian wikilink string.
 */
export function renderObsidianWikiLink(relativePath: string, label?: string | null): string {
  const target = toObsidianWikiTarget(relativePath);
  const normalizedLabel = label?.trim() ?? "";
  return normalizedLabel.length > 0 ? `[[${target}|${normalizedLabel}]]` : `[[${target}]]`;
}

/**
 * Builds link indexes for the main projected note families.
 *
 * **Why it exists:**
 * Renderers need stable cross-note references for entities, episodes, loops, and media artifacts,
 * and precomputing those maps keeps each renderer simple and deterministic.
 *
 * **What it talks to:**
 * - Uses `ProjectionSnapshot` from `../contracts`.
 * - Uses path helpers in this module.
 *
 * @param snapshot - Full projection snapshot.
 * @returns Stable cross-note link index.
 */
export function buildProjectionLinkIndex(snapshot: ProjectionSnapshot): ProjectionLinkIndex {
  const projectedEntities = snapshot.entityGraph.entities.filter((entity) =>
    shouldProjectEntityNote(snapshot, entity)
  );
  const projectedNameCounts = new Map<string, number>();
  for (const entity of projectedEntities) {
    projectedNameCounts.set(
      entity.canonicalName,
      (projectedNameCounts.get(entity.canonicalName) ?? 0) + 1
    );
  }

  const entityPathsByKey = new Map<string, string>();
  const entityLabelsByKey = new Map<string, string>();
  for (const entity of snapshot.entityGraph.entities) {
    entityLabelsByKey.set(entity.entityKey, entity.canonicalName);
    if (!shouldProjectEntityNote(snapshot, entity)) {
      continue;
    }
    entityPathsByKey.set(entity.entityKey, buildEntityNoteRelativePath(entity, projectedNameCounts));
  }

  const episodePathsById = new Map<string, string>();
  for (const episode of snapshot.profileMemory?.episodes ?? []) {
    episodePathsById.set(
      episode.id,
      buildEpisodeNoteRelativePath(episode.observedAt, episode.summary)
    );
  }

  const openLoopPathsById = new Map<string, string>();
  for (const thread of snapshot.runtimeState.conversationStack.threads) {
    for (const loop of thread.openLoops ?? []) {
      const stableId = loop.loopId;
      openLoopPathsById.set(stableId, buildOpenLoopNoteRelativePath(stableId));
    }
  }

  const mediaArtifactPathsById = new Map<string, string>();
  for (const artifact of snapshot.mediaArtifacts) {
    const titleBase = artifact.fileName ?? artifact.assetFileName;
    mediaArtifactPathsById.set(
      artifact.artifactId,
      buildMediaArtifactNoteRelativePath(artifact.recordedAt, titleBase)
    );
  }

  return {
    entityPathsByKey,
    entityLabelsByKey,
    episodePathsById,
    openLoopPathsById,
    mediaArtifactPathsById
  };
}
