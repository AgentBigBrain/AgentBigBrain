/**
 * @fileoverview Deterministic planner failure cooldown and fingerprint helpers.
 */

export const PLANNER_FAILURE_WINDOW_MS = 2 * 60 * 1000;
export const PLANNER_FAILURE_COOLDOWN_MS = 60 * 1000;
export const PLANNER_FAILURE_MAX_STRIKES = 2;
export const MAX_FAILURE_FINGERPRINT_SEGMENT_LENGTH = 120;

/**
 * Normalizes fingerprint segments into a stable planner failure key.
 */
export function normalizeFingerprintSegment(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.slice(0, MAX_FAILURE_FINGERPRINT_SEGMENT_LENGTH);
}
