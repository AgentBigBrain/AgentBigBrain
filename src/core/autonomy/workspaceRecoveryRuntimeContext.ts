/**
 * @fileoverview Shared parsing helpers for exact tracked workspace-recovery context embedded in execution input.
 */

const PREFERRED_ROOT_LINE_PATTERNS = [
  /^-\s*Preferred workspace root:\s*(.+)$/im,
  /^-\s*Root path:\s*(.+)$/im
] as const;
const PREVIEW_LEASE_LINE_PATTERNS = [
  /^-\s*Exact tracked preview lease ids:\s*(.+)$/im,
  /^-\s*Preview process leases:\s*(.+)$/im,
  /^-\s*Preview process lease:\s*(.+)$/im
] as const;
const ATTRIBUTABLE_ROOT_LINE_PATTERN = /^-\s*root=([^;\n]+);/gim;

/**
 * Normalizes one optional context value.
 *
 * @param value - Raw context value.
 * @returns Trimmed non-empty value, or `null` when absent.
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
 * Deduplicates normalized string values while preserving first-seen order.
 *
 * @param values - Candidate string values.
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
 * Parses one comma-delimited context line into unique entries.
 *
 * @param value - Raw line value.
 * @returns Unique non-empty entries in first-seen order.
 */
function parseCsvLineValue(value: string | null | undefined): string[] {
  const normalized = normalizeOptionalLineValue(value);
  if (!normalized) {
    return [];
  }
  return dedupeStrings(normalized.split(","));
}

/**
 * Reads the first matching single-line value from one context block.
 *
 * @param input - Execution input containing recovery context.
 * @param patterns - Candidate line-match patterns.
 * @returns First normalized line value, or `null` when none matched.
 */
function readSingleLineValue(input: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = input.match(pattern);
    const value = normalizeOptionalLineValue(match?.[1]);
    if (value) {
      return value;
    }
  }
  return null;
}

/**
 * Normalizes one filesystem path into a stable comparison form.
 *
 * @param value - Candidate filesystem path.
 * @returns Normalized path, or `null` when absent.
 */
function normalizeComparablePath(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * Returns whether two filesystem targets overlap by direct equality or containment.
 *
 * @param left - First path candidate.
 * @param right - Second path candidate.
 * @returns `true` when the paths overlap.
 */
export function workspaceRecoveryPathsOverlap(
  left: string | null | undefined,
  right: string | null | undefined
): boolean {
  const normalizedLeft = normalizeComparablePath(left);
  const normalizedRight = normalizeComparablePath(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  return (
    normalizedLeft.startsWith(`${normalizedRight}\\`) ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}\\`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  );
}

/**
 * Extracts preferred and attributable workspace roots embedded in one recovery-aware execution input.
 *
 * @param input - Execution input containing recovery context.
 * @returns Unique candidate workspace roots in first-seen order.
 */
export function extractWorkspaceRecoveryContextRoots(input: string): string[] {
  const roots = dedupeStrings([
    readSingleLineValue(input, PREFERRED_ROOT_LINE_PATTERNS) ?? ""
  ]);
  for (const match of input.matchAll(ATTRIBUTABLE_ROOT_LINE_PATTERN)) {
    const candidate = normalizeOptionalLineValue(match[1]);
    if (candidate) {
      roots.push(candidate);
    }
  }
  return dedupeStrings(roots);
}

/**
 * Extracts exact tracked preview lease ids embedded in one recovery-aware execution input.
 *
 * @param input - Execution input containing recovery context.
 * @returns Unique exact preview lease ids.
 */
export function extractWorkspaceRecoveryExactPreviewLeaseIds(input: string): string[] {
  for (const pattern of PREVIEW_LEASE_LINE_PATTERNS) {
    const match = input.match(pattern);
    const leaseIds = parseCsvLineValue(match?.[1]);
    if (leaseIds.length > 0) {
      return leaseIds;
    }
  }
  return [];
}
