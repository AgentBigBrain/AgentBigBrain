/**
 * @fileoverview Parses and validates structured Obsidian review-action notes for guarded memory write-back.
 */

export type ObsidianReviewActionKind =
  | "resolve_episode"
  | "mark_episode_wrong"
  | "forget_episode"
  | "correct_fact"
  | "forget_fact"
  | "create_follow_up_loop";

export type ObsidianReviewActionStatus = "pending" | "applied" | "failed";

type ReviewActionFrontmatterValue = string | readonly string[] | null;

export interface ObsidianReviewAction {
  actionId: string;
  actionKind: ObsidianReviewActionKind;
  targetId: string | null;
  replacementValue: string | null;
  followUpText: string | null;
  status: ObsidianReviewActionStatus;
  noteBody: string;
  sourcePath: string;
  threadKey: string | null;
  entityRefs: readonly string[];
  sourceRecallRefs: readonly string[];
}

/**
 * Parses one structured review-action note from Markdown.
 *
 * **Why it exists:**
 * Guarded write-back starts from vault-authored Markdown, but the runtime still needs a strict
 * parser that accepts only the small action schema it knows how to route into profile-memory
 * mutation methods.
 *
 * **What it talks to:**
 * - Uses local frontmatter parsing helpers within this module.
 *
 * @param markdown - Raw Markdown note contents.
 * @param sourcePath - Absolute or relative source path for diagnostics.
 * @returns Parsed review action, or `null` when the note is not a valid action file.
 */
export function parseObsidianReviewActionMarkdown(
  markdown: string,
  sourcePath: string
): ObsidianReviewAction | null {
  const parsed = parseSimpleFrontmatter(markdown);
  if (!parsed) {
    return null;
  }
  const actionKind = normalizeReviewActionKind(parsed.properties.abb_action_kind);
  const actionId = normalizeText(parsed.properties.abb_review_action_id);
  const targetId = normalizeText(parsed.properties.abb_target_id);
  const status = normalizeReviewActionStatus(parsed.properties.abb_status);
  if (!actionKind || !actionId || !status) {
    return null;
  }
  if (actionKind !== "create_follow_up_loop" && !targetId) {
    return null;
  }

  return {
    actionId,
    actionKind,
    targetId,
    replacementValue: normalizeText(parsed.properties.abb_replacement_value),
    followUpText: normalizeText(parsed.properties.abb_follow_up_text),
    status,
    noteBody: parsed.body,
    sourcePath,
    threadKey: normalizeText(parsed.properties.abb_thread_key),
    entityRefs: normalizeTextArray(parsed.properties.abb_entity_refs),
    sourceRecallRefs: normalizeTextArray(parsed.properties.abb_source_recall_refs)
  };
}

/**
 * Rewrites one review-action note with updated frontmatter properties.
 *
 * **Why it exists:**
 * Applying review actions should leave a durable status trail inside the vault, and this helper
 * keeps the frontmatter rewrite deterministic and centralized.
 *
 * **What it talks to:**
 * - Uses local frontmatter parsing and rendering helpers within this module.
 *
 * @param markdown - Existing Markdown note contents.
 * @param updates - Frontmatter fields to overwrite.
 * @returns Updated Markdown note contents.
 */
export function rewriteObsidianReviewActionMarkdown(
  markdown: string,
  updates: Record<string, ReviewActionFrontmatterValue>
): string {
  const parsed = parseSimpleFrontmatter(markdown) ?? {
    properties: {},
    body: markdown.trim()
  };
  const properties = {
    ...parsed.properties,
    ...updates
  };
  const lines = ["---"];
  for (const [key, value] of Object.entries(properties)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const entry of value) {
        lines.push(`  - ${JSON.stringify(entry)}`);
      }
      continue;
    }
    if (value === null) {
      lines.push(`${key}: null`);
      continue;
    }
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push("---", "", parsed.body.trim());
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Parses one simple YAML-like frontmatter block using flat string scalars only.
 *
 * **Why it exists:**
 * Review-action notes intentionally use a tiny frontmatter schema, so a bounded parser keeps the
 * write-back path small and deterministic without adding a general YAML dependency.
 *
 * **What it talks to:**
 * - Uses local string parsing helpers within this module.
 *
 * @param markdown - Raw Markdown note contents.
 * @returns Parsed frontmatter plus body, or `null` when no frontmatter exists.
 */
function parseSimpleFrontmatter(
  markdown: string
): { properties: Record<string, ReviewActionFrontmatterValue>; body: string } | null {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return null;
  }
  const closingIndex = normalized.indexOf("\n---\n", 4);
  if (closingIndex < 0) {
    return null;
  }
  const frontmatter = normalized.slice(4, closingIndex);
  const body = normalized.slice(closingIndex + 5).trim();
  const properties: Record<string, ReviewActionFrontmatterValue> = {};
  let currentArrayKey: string | null = null;
  for (const rawLine of frontmatter.split("\n")) {
    const line = rawLine.trimEnd();
    const arrayMatch = line.match(/^\s*-\s+(.*)$/);
    if (arrayMatch && currentArrayKey) {
      const current = properties[currentArrayKey];
      properties[currentArrayKey] = [
        ...(Array.isArray(current) ? current : []),
        stripWrappingQuotes(arrayMatch[1] ?? "")
      ];
      continue;
    }
    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) {
      currentArrayKey = null;
      continue;
    }
    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 1).trim();
    if (rawValue.length === 0) {
      properties[key] = [];
      currentArrayKey = key;
      continue;
    }
    properties[key] = parseFrontmatterScalar(rawValue);
    currentArrayKey = null;
  }
  return {
    properties,
    body
  };
}

/**
 * Normalizes one raw action kind string to the supported review-action union.
 *
 * **Why it exists:**
 * Review-action notes should fail closed when an operator writes an unsupported action kind.
 *
 * **What it talks to:**
 * - Uses local string normalization rules within this module.
 *
 * @param value - Raw action-kind scalar from frontmatter.
 * @returns Supported action kind, or `null`.
 */
function normalizeReviewActionKind(
  value: ReviewActionFrontmatterValue | undefined
): ObsidianReviewActionKind | null {
  if (typeof value !== "string") {
    return null;
  }
  switch (value.trim()) {
    case "resolve_episode":
    case "mark_episode_wrong":
    case "forget_episode":
    case "correct_fact":
    case "forget_fact":
    case "create_follow_up_loop":
      return value.trim() as ObsidianReviewActionKind;
    default:
      return null;
  }
}

/**
 * Normalizes one raw review-action status string.
 *
 * **Why it exists:**
 * The ingestion path only handles pending actions, so status parsing must stay strict and stable.
 *
 * **What it talks to:**
 * - Uses local string normalization rules within this module.
 *
 * @param value - Raw status scalar from frontmatter.
 * @returns Supported review-action status, or `null`.
 */
function normalizeReviewActionStatus(
  value: ReviewActionFrontmatterValue | undefined
): ObsidianReviewActionStatus | null {
  const normalized = typeof value === "string" ? value.trim() : "pending";
  switch (normalized) {
    case "pending":
    case "applied":
    case "failed":
      return normalized as ObsidianReviewActionStatus;
    default:
      return null;
  }
}

/**
 * Normalizes one optional text field from frontmatter.
 *
 * **Why it exists:**
 * Review-action notes carry small scalar fields, and this helper keeps empty-string handling
 * consistent across ids, replacement values, and status-adjacent metadata.
 *
 * **What it talks to:**
 * - Uses local string normalization rules within this module.
 *
 * @param value - Raw scalar from frontmatter.
 * @returns Trimmed text or `null`.
 */
function normalizeText(value: ReviewActionFrontmatterValue | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Normalizes one optional string-list frontmatter field.
 *
 * **Why it exists:**
 * Follow-up loop actions may carry explicit entity refs, and this keeps array parsing aligned with
 * the same bounded frontmatter contract used for the rest of the review-action note.
 *
 * **What it talks to:**
 * - Uses local string normalization rules within this module.
 *
 * @param value - Raw frontmatter scalar or list.
 * @returns Stable trimmed string refs.
 */
function normalizeTextArray(value: ReviewActionFrontmatterValue | undefined): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parses one raw frontmatter scalar into the bounded review-action value union.
 *
 * **Why it exists:**
 * Review-action notes only need a tiny subset of YAML semantics, so this helper keeps scalar
 * normalization deterministic without introducing a general parser dependency.
 *
 * **What it talks to:**
 * - Uses local scalar normalization helpers within this module.
 *
 * @param value - Raw scalar text after the `key:` separator.
 * @returns Parsed frontmatter scalar value.
 */
function parseFrontmatterScalar(value: string): ReviewActionFrontmatterValue {
  if (value === "null") {
    return null;
  }
  return stripWrappingQuotes(value);
}

/**
 * Removes one pair of wrapping single or double quotes from a scalar.
 *
 * **Why it exists:**
 * Frontmatter rewrites use quoted scalars for stability, and the parser should accept those values
 * without leaving the quote characters in the normalized result.
 *
 * **What it talks to:**
 * - Uses local string normalization rules within this module.
 *
 * @param value - Raw scalar string.
 * @returns Unwrapped scalar string.
 */
function stripWrappingQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
