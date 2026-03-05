/**
 * @fileoverview Parses Discord rate-limit responses into deterministic millisecond retry delays.
 */

interface DiscordRateLimitPayload {
  retry_after?: number;
}

/**
 * Parses discord retry after ms and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for discord retry after ms so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param payload - Structured input object for this operation.
 * @returns Computed numeric value.
 */
export function parseDiscordRetryAfterMs(payload: unknown): number {
  if (!payload || typeof payload !== "object") {
    return 1_000;
  }

  const value = (payload as DiscordRateLimitPayload).retry_after;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return 1_000;
  }

  // Discord provides retry_after in seconds.
  return Math.max(250, Math.ceil(value * 1_000));
}

