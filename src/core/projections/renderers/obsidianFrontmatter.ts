/**
 * @fileoverview Shared Markdown and YAML rendering helpers for the Obsidian vault projection sink.
 */

import { createHash } from "node:crypto";

export interface ObsidianProjectedNote {
  relativePath: string;
  content: string;
}

type FrontmatterValue = string | number | boolean | null | readonly string[];

/**
 * Renders one stable YAML frontmatter block for projected Markdown notes.
 *
 * **Why it exists:**
 * Entity, episode, artifact, dashboard, and review notes all need the same deterministic property
 * formatting so Obsidian Properties and Bases stay stable across rebuilds.
 *
 * **What it talks to:**
 * - Uses local YAML formatting helpers within this module.
 *
 * @param properties - Flat property map rendered into YAML frontmatter.
 * @returns Complete frontmatter block including delimiters.
 */
export function renderObsidianFrontmatter(
  properties: Record<string, FrontmatterValue>
): string {
  const lines = ["---"];
  for (const [key, value] of Object.entries(properties)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const entry of value) {
        lines.push(`  - ${quoteYamlString(entry)}`);
      }
      continue;
    }
    if (value === null) {
      lines.push(`${key}: null`);
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${String(value)}`);
      continue;
    }
    lines.push(`${key}: ${quoteYamlString(String(value))}`);
  }
  lines.push("---");
  return `${lines.join("\n")}\n`;
}

/**
 * Sanitizes one note-path segment for cross-platform Obsidian file output.
 *
 * **Why it exists:**
 * Runtime-generated note names should stay stable and portable without leaking unsupported path
 * characters from user text, entity names, or receipt ids into the vault.
 *
 * **What it talks to:**
 * - Uses local normalization rules within this module.
 *
 * @param value - Raw note-path segment candidate.
 * @returns Cross-platform safe path segment.
 */
export function sanitizeObsidianPathSegment(value: string, maxLength = 96): string {
  const normalized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const safeValue = normalized.length > 0 ? normalized : "Untitled";
  if (safeValue.length <= maxLength) {
    return safeValue;
  }
  const hash = createHash("sha1").update(safeValue).digest("hex").slice(0, 8);
  const prefixLength = Math.max(1, maxLength - hash.length - 1);
  return `${safeValue.slice(0, prefixLength).trimEnd()}-${hash}`;
}

/**
 * Renders a flat Markdown bullet list with a deterministic empty-state line.
 *
 * **Why it exists:**
 * Most projected notes contain short list sections, and a shared formatter keeps the markdown
 * output readable without repeating small list-rendering branches across renderers.
 *
 * **What it talks to:**
 * - Uses local normalization rules within this module.
 *
 * @param values - List values to render as bullets.
 * @param emptyLine - Fallback line when the list is empty.
 * @returns Markdown list block.
 */
export function renderMarkdownList(
  values: readonly string[],
  emptyLine = "- None"
): string {
  if (values.length === 0) {
    return `${emptyLine}\n`;
  }
  return `${values.map((value) => `- ${value}`).join("\n")}\n`;
}

/**
 * Quotes one YAML string scalar safely for Obsidian property files.
 *
 * **Why it exists:**
 * Projection output includes colons, brackets, and free text from user content, so scalar quoting
 * must be consistent to keep generated frontmatter parseable.
 *
 * **What it talks to:**
 * - Uses local escaping rules within this module.
 *
 * @param value - Raw scalar string value.
 * @returns YAML-safe quoted scalar.
 */
function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}
