/**
 * @fileoverview Bounded episodic-memory sanitization and packet helpers for brokered model egress.
 */

import {
  sanitizeProfileContextForModelEgress
} from "./contextInjection";
import type { ProfileContextSanitizationResult } from "./contracts";

const EPISODE_CONTEXT_LINE_PREFIX = "- situation:";

/**
 * Redacts sensitive episodic-context lines before planner/model egress.
 *
 * @param episodeContext - Raw episodic-memory context block.
 * @returns Sanitized episodic-memory text plus a deterministic redaction count.
 */
export function sanitizeEpisodeContextForModelEgress(
  episodeContext: string
): ProfileContextSanitizationResult {
  return sanitizeProfileContextForModelEgress(episodeContext);
}

/**
 * Counts rendered episodic-memory summaries in a brokered episode-context block.
 *
 * @param episodeContext - Rendered episodic-memory context block.
 * @returns Count of bounded situation summaries used for audit metadata.
 */
export function countRetrievedEpisodeSummaries(episodeContext: string): number {
  return episodeContext
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith(EPISODE_CONTEXT_LINE_PREFIX))
    .length;
}
