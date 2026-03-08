/**
 * @fileoverview Shared deterministic scoring helpers for non-safety language term overlap.
 */

/**
 * Counts exact overlap between two deterministic term sets.
 *
 * @param left - Left-side normalized terms.
 * @param right - Right-side normalized terms.
 * @returns Overlap count.
 */
export function countLanguageTermOverlap(
  left: readonly string[],
  right: readonly string[]
): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const rightSet = new Set(right);
  let overlap = 0;
  for (const term of left) {
    if (rightSet.has(term)) {
      overlap += 1;
    }
  }
  return overlap;
}
