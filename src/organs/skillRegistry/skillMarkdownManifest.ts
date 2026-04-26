/**
 * @fileoverview Markdown skill manifest parsing for source-controlled guidance files.
 */

import type { SkillManifest } from "./contracts";
import {
  normalizeAllowedSideEffects,
  normalizeLifecycleStatus,
  normalizeMemoryPolicy,
  normalizeProjectionPolicy,
  normalizeRiskLevel,
  normalizeStringArray,
  normalizeVerificationStatus,
  parseVersion,
  trimToNonEmptyString
} from "./skillManifestNormalization";

const BUILTIN_MARKDOWN_TIMESTAMP = "1970-01-01T00:00:00.000Z";

/**
 * Builds the fallback manifest description when the caller omits one.
 *
 * @param skillName - Canonical skill name.
 * @returns Human-readable default description.
 */
function buildDefaultDescription(skillName: string): string {
  return `Governed runtime skill for ${skillName}.`;
}

/**
 * Builds the fallback user-facing summary when the caller omits one.
 *
 * @param skillName - Canonical skill name.
 * @returns Human-readable default summary.
 */
function buildDefaultUserSummary(skillName: string): string {
  return `Reusable tool for ${skillName}.`;
}

/**
 * Builds the fallback invocation hint for Markdown guidance skills.
 *
 * @param skillName - Canonical skill name.
 * @returns Human-readable invocation hint.
 */
function buildDefaultMarkdownInvocationHint(skillName: string): string {
  return `Ask me to use guidance skill ${skillName}.`;
}

/**
 * Builds a manifest for one source-controlled Markdown guidance skill document.
 *
 * @param markdown - Raw Markdown file content.
 * @param instructionPath - Absolute path to the Markdown document.
 * @returns Built-in manifest, or `null` when the document is not marked as a skill.
 */
export function parseBuiltInMarkdownSkillManifest(
  markdown: string,
  instructionPath: string
): SkillManifest | null {
  const frontmatter = parseMarkdownFrontmatter(markdown);
  if (!frontmatter || frontmatter.kind !== "markdown_instruction") {
    return null;
  }

  const fallbackName = trimToNonEmptyString(
    instructionPath
      .split(/[\\/]/)
      .pop()
      ?.replace(/\.md$/i, "")
  );
  const name = trimToNonEmptyString(frontmatter.name) ?? fallbackName;
  const description =
    trimToNonEmptyString(frontmatter.description) ?? buildDefaultDescription(name ?? "guidance");
  if (!name || !description) {
    return null;
  }

  const tags = normalizeDelimitedStringArray(frontmatter.tags);
  const invocationHints = normalizeDelimitedStringArray(frontmatter.invocationHints);
  return {
    name,
    kind: "markdown_instruction",
    origin: "builtin",
    description,
    purpose: trimToNonEmptyString(frontmatter.purpose) ?? description,
    inputSummary:
      trimToNonEmptyString(frontmatter.inputSummary) ??
      "Natural-language request and local runtime context.",
    outputSummary:
      trimToNonEmptyString(frontmatter.outputSummary) ??
      "Planner guidance only; no direct runtime side effects.",
    riskLevel: normalizeRiskLevel(frontmatter.riskLevel),
    allowedSideEffects: normalizeAllowedSideEffects(frontmatter.allowedSideEffects),
    tags,
    capabilities: normalizeDelimitedStringArray(frontmatter.capabilities ?? frontmatter.tags),
    version: parseVersion(frontmatter.version),
    createdAt: trimToNonEmptyString(frontmatter.createdAt) ?? BUILTIN_MARKDOWN_TIMESTAMP,
    updatedAt: trimToNonEmptyString(frontmatter.updatedAt) ?? BUILTIN_MARKDOWN_TIMESTAMP,
    verificationStatus: normalizeVerificationStatus(frontmatter.verificationStatus),
    verificationVerifiedAt: trimToNonEmptyString(frontmatter.verificationVerifiedAt),
    verificationFailureReason: trimToNonEmptyString(frontmatter.verificationFailureReason),
    verificationTestInput: null,
    verificationExpectedOutputContains: null,
    userSummary: trimToNonEmptyString(frontmatter.userSummary) ?? buildDefaultUserSummary(name),
    invocationHints:
      invocationHints.length > 0 ? invocationHints : [buildDefaultMarkdownInvocationHint(name)],
    lifecycleStatus: normalizeLifecycleStatus(frontmatter.lifecycleStatus),
    instructionPath,
    primaryPath: instructionPath,
    compatibilityPath: instructionPath,
    memoryPolicy: normalizeMemoryPolicy(frontmatter.memoryPolicy, "markdown_instruction"),
    projectionPolicy: normalizeProjectionPolicy(frontmatter.projectionPolicy, "markdown_instruction")
  };
}

/**
 * Parses simple YAML-style frontmatter from a Markdown skill document.
 *
 * @param markdown - Raw Markdown text.
 * @returns Frontmatter key/value map, or `null` when absent.
 */
function parseMarkdownFrontmatter(markdown: string): Record<string, string> | null {
  const normalized = markdown.replace(/^\uFEFF/u, "");
  if (!normalized.startsWith("---")) {
    return null;
  }
  const endIndex = normalized.indexOf("\n---", 3);
  if (endIndex < 0) {
    return null;
  }
  const rawFrontmatter = normalized.slice(3, endIndex);
  const fields: Record<string, string> = {};
  for (const line of rawFrontmatter.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*?)\s*$/);
    if (!match) {
      continue;
    }
    fields[match[1]] = match[2].replace(/^["']|["']$/g, "").trim();
  }
  return fields;
}

/**
 * Normalizes comma-delimited frontmatter fields into a string array.
 *
 * @param value - Frontmatter field value.
 * @returns Deduplicated values.
 */
function normalizeDelimitedStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return normalizeStringArray(value);
  }
  const text = trimToNonEmptyString(value);
  if (!text) {
    return [];
  }
  return [...new Set(
    text
      .split(/[|,]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  )];
}
