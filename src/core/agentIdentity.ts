/**
 * @fileoverview Provides deterministic agent identity helpers for main-agent identity and satellite-clone naming.
 */

const DEFAULT_CLONE_PREFIXES = ["atlas", "milkyway", "astro", "orion", "nova", "cosmos"] as const;
const CLONE_NAME_PATTERN = /^([a-z][a-z0-9]*)-([1-9][0-9]*)$/;

export const MAIN_AGENT_ID = "main-agent";

/**
 * Normalizes a clone prefix candidate into safe lowercase slug form.
 *
 * **Why it exists:**
 * Clone IDs must stay deterministic and filesystem-safe; this helper rejects malformed prefixes
 * before they become part of agent identity strings.
 *
 * **What it talks to:**
 * - Uses regex normalization and validation.
 *
 * @param prefix - Raw prefix candidate.
 * @returns Normalized prefix or `null` when invalid.
 */
function normalizePrefix(prefix: string): string | null {
  const normalized = prefix.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!normalized) {
    return null;
  }
  if (!/^[a-z][a-z0-9]*$/.test(normalized)) {
    return null;
  }
  return normalized;
}

/**
 * Builds the deterministic prefix preference order for clone allocation.
 *
 * **Why it exists:**
 * Allocation should honor explicit user preference when valid, but still fall back to stable
 * defaults without duplicates.
 *
 * **What it talks to:**
 * - Calls `normalizePrefix`.
 * - Reads `DEFAULT_CLONE_PREFIXES`.
 *
 * @param preferredPrefix - Optional preferred prefix from caller intent.
 * @returns Ordered unique prefix list for allocation.
 */
function toUniquePrefixOrder(preferredPrefix?: string): string[] {
  const preferred = preferredPrefix ? normalizePrefix(preferredPrefix) : null;
  const ordered = preferred ? [preferred, ...DEFAULT_CLONE_PREFIXES] : [...DEFAULT_CLONE_PREFIXES];
  return [...new Set(ordered)];
}

/**
 * Parses existing clone IDs into per-prefix used sequence sets.
 *
 * **Why it exists:**
 * Clone naming must avoid collisions while reusing first missing sequence numbers.
 * This helper extracts current occupancy from the existing identity list.
 *
 * **What it talks to:**
 * - Uses `CLONE_NAME_PATTERN` to validate + parse clone IDs.
 *
 * @param existingAgentIds - Current known agent IDs.
 * @returns Map of prefix -> used sequence numbers.
 */
function readUsedSequences(existingAgentIds: readonly string[]): Map<string, Set<number>> {
  const usedByPrefix = new Map<string, Set<number>>();
  for (const rawId of existingAgentIds) {
    const normalizedId = rawId.trim().toLowerCase();
    const match = CLONE_NAME_PATTERN.exec(normalizedId);
    if (!match) {
      continue;
    }

    const prefix = match[1];
    const sequence = Number(match[2]);
    const current = usedByPrefix.get(prefix) ?? new Set<number>();
    current.add(sequence);
    usedByPrefix.set(prefix, current);
  }
  return usedByPrefix;
}

/**
 * Returns the first positive integer not present in a set.
 *
 * **Why it exists:**
 * Clone IDs should be compact and stable over time (`prefix-1`, `prefix-2`, ...), including
 * gap reuse after deletions.
 *
 * **What it talks to:**
 * - Reads numeric membership from `ReadonlySet<number>`.
 *
 * @param numbers - Used sequence set.
 * @returns Smallest missing positive sequence number.
 */
function firstMissingPositive(numbers: ReadonlySet<number>): number {
  let sequence = 1;
  while (numbers.has(sequence)) {
    sequence += 1;
  }
  return sequence;
}

/**
 * Chooses the prefix with the lowest current clone load.
 *
 * **Why it exists:**
 * When no preferred prefix is supplied, allocation should distribute clones across available
 * prefixes in a deterministic way to avoid runaway concentration.
 *
 * **What it talks to:**
 * - Reads current usage counts from `usedByPrefix`.
 *
 * @param orderedPrefixes - Candidate prefixes in deterministic priority order.
 * @param usedByPrefix - Prefix usage map.
 * @returns Selected prefix key for next clone allocation.
 */
function selectPrefixWithLowestLoad(
  orderedPrefixes: readonly string[],
  usedByPrefix: ReadonlyMap<string, ReadonlySet<number>>
): string {
  let selected = orderedPrefixes[0];
  let selectedCount = (usedByPrefix.get(selected) ?? new Set<number>()).size;
  for (const prefix of orderedPrefixes.slice(1)) {
    const count = (usedByPrefix.get(prefix) ?? new Set<number>()).size;
    if (count < selectedCount) {
      selected = prefix;
      selectedCount = count;
    }
  }
  return selected;
}

/**
 * Normalizes agent identity with fail-safe fallback to main agent.
 *
 * **Why it exists:**
 * Identity plumbing across runtime boundaries should never propagate blank or undefined IDs.
 * This helper guarantees a canonical non-empty identity string.
 *
 * **What it talks to:**
 * - Uses `MAIN_AGENT_ID` fallback constant.
 *
 * @param candidate - Raw agent ID candidate.
 * @returns Normalized ID or `MAIN_AGENT_ID` fallback.
 */
export function normalizeAgentId(candidate: string | null | undefined): string {
  if (typeof candidate !== "string") {
    return MAIN_AGENT_ID;
  }

  const normalized = candidate.trim().toLowerCase();
  return normalized.length > 0 ? normalized : MAIN_AGENT_ID;
}

/**
 * Allocates the next deterministic clone agent ID.
 *
 * **Why it exists:**
 * Clone orchestration needs collision-free IDs that preserve readable numbering and deterministic
 * selection behavior across retries/restarts.
 *
 * **What it talks to:**
 * - Calls `toUniquePrefixOrder` to derive candidate prefixes.
 * - Calls `readUsedSequences` to parse existing occupancy.
 * - Calls `normalizePrefix` and `selectPrefixWithLowestLoad` for prefix choice.
 * - Calls `firstMissingPositive` to pick next sequence.
 *
 * @param existingAgentIds - Existing agent IDs to avoid collisions.
 * @param preferredPrefix - Optional preferred prefix hint.
 * @returns New clone agent ID in `<prefix>-<sequence>` format.
 */
export function allocateCloneAgentId(
  existingAgentIds: readonly string[],
  preferredPrefix?: string
): string {
  const orderedPrefixes = toUniquePrefixOrder(preferredPrefix);
  const usedByPrefix = readUsedSequences(existingAgentIds);
  const normalizedPreferredPrefix = preferredPrefix ? normalizePrefix(preferredPrefix) : null;
  const selectedPrefix = normalizedPreferredPrefix
    ? normalizedPreferredPrefix
    : selectPrefixWithLowestLoad(orderedPrefixes, usedByPrefix);
  const usedSequences = usedByPrefix.get(selectedPrefix) ?? new Set<number>();
  const nextSequence = firstMissingPositive(usedSequences);
  return `${selectedPrefix}-${nextSequence}`;
}
