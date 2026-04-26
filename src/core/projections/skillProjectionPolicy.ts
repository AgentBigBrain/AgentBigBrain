/**
 * @fileoverview Builds policy-filtered skill records for external projection mirrors.
 */

import { readFile } from "node:fs/promises";

import type { SkillManifest, SkillProjectionEntry } from "../../organs/skillRegistry/contracts";
import type { ProjectionMode } from "./contracts";

const REVIEW_SAFE_EXCERPT_CHARS = 1_200;
const OPERATOR_FULL_CONTENT_CHARS = 8_000;
const REDACTED_LINE_PATTERN =
  /\b(?:api[_ -]?key|secret|token|password)\s*[:=]|\bC:\\Users\\[^\\\s]+\\|\bOneDrive\\Desktop\\/i;

/**
 * Builds skill projection entries from active manifests and projection mode.
 *
 * **Why it exists:**
 * Skill notes are useful for operator review, but Markdown guidance is still untrusted context.
 * This helper centralizes the rule that projection can show metadata in review-safe mode and only
 * show full Markdown content when operator-full mode and the manifest policy both allow it.
 *
 * **What it talks to:**
 * - Uses `SkillManifest` and `SkillProjectionEntry` from the skill registry contracts.
 * - Uses `ProjectionMode` from projection contracts.
 *
 * @param mode - Active projection mode.
 * @param manifests - Active skill manifests from the registry.
 * @returns Policy-filtered projection records.
 */
export async function buildSkillProjectionEntries(
  mode: ProjectionMode,
  manifests: readonly SkillManifest[]
): Promise<readonly SkillProjectionEntry[]> {
  const entries: SkillProjectionEntry[] = [];
  for (const manifest of manifests) {
    const { contentMode, projectedContent } = await resolveProjectedSkillContent(mode, manifest);
    entries.push({
      name: manifest.name,
      kind: manifest.kind,
      origin: manifest.origin,
      description: manifest.description,
      userSummary: manifest.userSummary,
      tags: manifest.tags,
      invocationHints: manifest.invocationHints,
      verificationStatus: manifest.verificationStatus,
      lifecycleStatus: manifest.lifecycleStatus,
      memoryPolicy: manifest.memoryPolicy,
      projectionPolicy: manifest.projectionPolicy,
      contentMode,
      projectedContent
    });
  }
  return entries.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Resolves the policy-filtered content payload for one skill.
 *
 * @param mode - Active projection mode.
 * @param manifest - Skill manifest under projection.
 * @returns Content mode and optional Markdown payload.
 */
async function resolveProjectedSkillContent(
  mode: ProjectionMode,
  manifest: SkillManifest
): Promise<Pick<SkillProjectionEntry, "contentMode" | "projectedContent">> {
  if (
    manifest.kind !== "markdown_instruction" ||
    !manifest.instructionPath ||
    manifest.projectionPolicy === "metadata_only"
  ) {
    return { contentMode: "metadata_only", projectedContent: null };
  }

  const body = await readMarkdownSkillBody(manifest.instructionPath);
  if (!body) {
    return { contentMode: "metadata_only", projectedContent: null };
  }

  if (mode === "operator_full" && manifest.projectionPolicy === "operator_full_content") {
    return {
      contentMode: "operator_full_content",
      projectedContent: boundProjectionText(body, OPERATOR_FULL_CONTENT_CHARS)
    };
  }

  return {
    contentMode: "review_safe_excerpt",
    projectedContent: boundProjectionText(redactReviewSafeSkillContent(body), REVIEW_SAFE_EXCERPT_CHARS)
  };
}

/**
 * Reads one Markdown skill body without frontmatter.
 *
 * @param instructionPath - Absolute Markdown instruction path from the manifest.
 * @returns Markdown body or `null` when unreadable.
 */
async function readMarkdownSkillBody(instructionPath: string): Promise<string | null> {
  try {
    return stripMarkdownFrontmatter(await readFile(instructionPath, "utf8")).trim();
  } catch {
    return null;
  }
}

/**
 * Redacts review-safe content lines that look like credentials or private desktop paths.
 *
 * @param text - Markdown content body.
 * @returns Redacted Markdown body.
 */
function redactReviewSafeSkillContent(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (REDACTED_LINE_PATTERN.test(line) ? "[redacted projection line]" : line))
    .join("\n")
    .trim();
}

/**
 * Bounds projected Markdown content to keep mirror notes small and reviewable.
 *
 * @param text - Projection text.
 * @param maxChars - Maximum allowed characters.
 * @returns Bounded text.
 */
function boundProjectionText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

/**
 * Removes YAML-style frontmatter from Markdown text.
 *
 * @param markdown - Raw Markdown text.
 * @returns Markdown body.
 */
function stripMarkdownFrontmatter(markdown: string): string {
  const normalized = markdown.replace(/^\uFEFF/u, "");
  if (!normalized.startsWith("---")) {
    return normalized;
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex < 0) {
    return normalized;
  }
  const bodyStart = normalized.indexOf("\n", endIndex + 4);
  return bodyStart >= 0 ? normalized.slice(bodyStart + 1) : "";
}
