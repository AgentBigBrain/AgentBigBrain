/**
 * @fileoverview Shared parsing helpers for machine-readable workspace-recovery context.
 */

const BLOCKED_FOLDER_PATHS_HEADER_PATTERN = /blocked folder paths:\s*/i;
const WINDOWS_INLINE_PATH_PATTERN = /[A-Za-z]:\\[^,\r\n]+/g;

/**
 * Normalizes one optional recovery line value into a trimmed non-empty string.
 *
 * @param value - Raw line value.
 * @returns Normalized string, or `null` when absent.
 */
function normalizeOptionalLineValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  if (!normalized || normalized === "none" || normalized === "unknown") {
    return null;
  }
  return normalized;
}

/**
 * Deduplicates normalized blocked-path entries while preserving first-seen order.
 *
 * @param values - Candidate blocked-path values.
 * @returns Unique non-empty values.
 */
function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = normalizeOptionalLineValue(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/**
 * Extracts exact blocked folder paths from one marker-bearing workspace-recovery request.
 *
 * Supports both the newer multi-line bullet format and the older single-line comma format so the
 * runtime can stay compatible with older evidence text while keeping future recovery turns easier
 * to ground precisely.
 *
 * @param input - Planner-facing request text.
 * @returns Unique blocked folder paths in first-seen order.
 */
export function extractWorkspaceRecoveryBlockedFolderPaths(input: string): string[] {
  const headerMatch = BLOCKED_FOLDER_PATHS_HEADER_PATTERN.exec(input);
  if (!headerMatch) {
    return [];
  }

  const remainder = input.slice(headerMatch.index + headerMatch[0].length);
  const lines = remainder.split(/\r?\n/);
  const multilineMatches: string[] = [];
  let sawPathLine = false;
  for (const rawLine of lines) {
    const trimmedLine = rawLine.trim();
    if (!trimmedLine) {
      if (sawPathLine) {
        break;
      }
      continue;
    }
    const normalizedLine = trimmedLine.replace(/^-\s*/, "");
    const lineMatches = Array.from(normalizedLine.matchAll(WINDOWS_INLINE_PATH_PATTERN)).map(
      (match) => match[0]
    );
    if (lineMatches.length === 0) {
      if (sawPathLine) {
        break;
      }
      continue;
    }
    sawPathLine = true;
    multilineMatches.push(...lineMatches);
  }
  return dedupeStrings(multilineMatches);
}
