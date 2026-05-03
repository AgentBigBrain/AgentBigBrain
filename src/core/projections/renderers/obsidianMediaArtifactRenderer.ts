/**
 * @fileoverview Renders media artifact notes for the Obsidian projection sink.
 */

import type { ProjectionSnapshot } from "../contracts";
import {
  buildDerivedConceptGroups,
  buildDerivedConceptLinkIndex,
  normalizeConceptIdentity
} from "./obsidianConceptRenderer";
import {
  renderMarkdownList,
  renderObsidianFrontmatter,
  type ObsidianProjectedNote
} from "./obsidianFrontmatter";
import {
  redactReviewSafeProjectionText,
  shouldMirrorMediaAsset
} from "../policy";
import {
  buildMediaArtifactNoteRelativePath,
  buildProjectionLinkIndex,
  renderObsidianWikiLink
} from "./obsidianLinks";

/**
 * Renders one companion Markdown note per canonical media artifact.
 *
 * **Why it exists:**
 * Raw asset files cannot reliably carry note-style metadata, so the mirror needs companion notes
 * that preserve artifact provenance, derived meaning, and linkable runtime identity.
 *
 * **What it talks to:**
 * - Uses `ProjectionSnapshot` from `../contracts`.
 * - Uses rendering helpers from `./obsidianFrontmatter`.
 * - Uses `shouldMirrorMediaAsset(...)` from `../policy`.
 *
 * @param snapshot - Full projection snapshot.
 * @returns Projected media artifact companion notes.
 */
export function renderObsidianMediaArtifactNotes(
  snapshot: ProjectionSnapshot
): readonly ObsidianProjectedNote[] {
  const linkIndex = buildProjectionLinkIndex(snapshot);
  const conceptGroups = buildDerivedConceptGroups(snapshot);
  const conceptLinkIndex = buildDerivedConceptLinkIndex(snapshot);
  return snapshot.mediaArtifacts.map((artifact) => {
    const assetLink = shouldMirrorMediaAsset(snapshot.mode, artifact)
      ? `![[${artifact.assetFileName}]]`
      : "Raw asset is hidden in review_safe mode.";
    const titleBase = artifact.fileName ?? artifact.assetFileName;
    const entityLinks = artifact.derivedMeaning.entityHints.map((entityHint) => {
      const normalizedHint = normalizeConceptIdentity(entityHint);
      const linkedEntity = snapshot.entityGraph.entities.find((entity) =>
        entity.entityKey === entityHint
        || entity.canonicalName === entityHint
        || entity.aliases.includes(entityHint)
      );
      if (!linkedEntity) {
        const conceptGroup = conceptGroups.find(
          (candidate) => candidate.conceptKey === normalizedHint
        );
        if (!conceptGroup) {
          if (!isRenderableArtifactHint(entityHint, normalizedHint)) {
            return null;
          }
          return entityHint;
        }
        const conceptPath = conceptLinkIndex.get(conceptGroup.conceptKey);
        return conceptPath
          ? renderObsidianWikiLink(conceptPath, conceptGroup.label)
          : conceptGroup.label;
      }
      const entityPath = linkIndex.entityPathsByKey.get(linkedEntity.entityKey);
      return entityPath
        ? renderObsidianWikiLink(entityPath, linkedEntity.canonicalName)
        : linkedEntity.canonicalName;
    }).filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    return {
      relativePath: buildMediaArtifactNoteRelativePath(artifact.recordedAt, titleBase),
      content: [
        renderObsidianFrontmatter({
          abb_id: artifact.artifactId,
          abb_type: "media_artifact",
          recorded_at: artifact.recordedAt,
          provider: artifact.provider,
          kind: artifact.kind,
          projection_lane: "media_artifact_review_mirror",
          checksum_sha256: artifact.checksumSha256,
          mime_type: artifact.mimeType ?? null
        }),
        `# ${titleBase}`,
        "",
        "## Overview",
        renderMarkdownList([
          "Projection lane: media artifact review mirror",
          "Derived meaning is projection-only evidence and never runtime authority by itself."
        ]),
        "",
        "## Asset",
        assetLink,
        "",
        "## Metadata",
        renderMarkdownList([
          `Conversation: ${artifact.sourceConversationKey ?? "unknown"}`,
          `User: ${artifact.sourceUserId ?? "unknown"}`,
          `Mime type: ${artifact.mimeType ?? "unknown"}`,
          `Size bytes: ${artifact.sizeBytes ?? "unknown"}`,
          `Runtime-owned asset: ${artifact.assetFileName}`
        ]),
        "## Derived Meaning",
        renderMarkdownList([
          artifact.derivedMeaning.summary
            ? `Summary: ${redactReviewSafeProjectionText(snapshot.mode, artifact.derivedMeaning.summary)}`
            : "Summary: none",
          artifact.derivedMeaning.transcript
            ? `Transcript: ${redactReviewSafeProjectionText(snapshot.mode, artifact.derivedMeaning.transcript)}`
            : "Transcript: none",
          artifact.derivedMeaning.ocrText
            ? `OCR: ${redactReviewSafeProjectionText(snapshot.mode, artifact.derivedMeaning.ocrText)}`
            : "OCR: none"
        ]),
        "## Interpretation Layers",
        renderMarkdownList(renderMediaArtifactLayerLines(snapshot, artifact)),
        "## Entity Hints",
        renderMarkdownList(entityLinks)
      ].join("\n")
    };
  });
}

/**
 * Renders bounded derived-meaning layer lines for one artifact note.
 *
 * @param snapshot - Current projection snapshot.
 * @param artifact - Media artifact being projected.
 * @returns Review-safe layer summary lines.
 */
function renderMediaArtifactLayerLines(
  snapshot: ProjectionSnapshot,
  artifact: ProjectionSnapshot["mediaArtifacts"][number]
): readonly string[] {
  const layers = artifact.derivedMeaning.layers ?? [];
  if (layers.length === 0) {
    return ["none"];
  }
  return layers.map((layer) => {
    const confidence = layer.confidence === null ? "unknown" : layer.confidence.toFixed(2);
    const text = redactReviewSafeProjectionText(
      snapshot.mode,
      layer.text.length > 1_000 ? `${layer.text.slice(0, 997).trimEnd()}...` : layer.text
    );
    return [
      `${layer.kind}`,
      `source: ${layer.source}`,
      `authority: ${layer.memoryAuthority}`,
      `confidence: ${confidence}`,
      `text: ${text}`
    ].join("; ");
  });
}

/**
 * Evaluates whether renderable artifact hint.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 * @param rawHint - Input consumed by this helper.
 * @param normalizedHint - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
function isRenderableArtifactHint(rawHint: string, normalizedHint: string): boolean {
  if (!normalizedHint) {
    return false;
  }
  if (/^\d+$/.test(normalizedHint.replace(/\s+/g, ""))) {
    return false;
  }
  return rawHint.trim().length >= 3;
}
