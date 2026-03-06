/**
 * @fileoverview Generates compact unique identifiers for tasks, actions, and proposals.
 */

import {
  DEFAULT_RUNTIME_ENTROPY_SOURCE,
  RuntimeEntropySource
} from "./runtimeEntropy";

/**
 * Generates a compact runtime identifier with injectable entropy boundaries.
 *
 * **Why it exists:**
 * Keeps ID generation consistent while allowing deterministic tests and policy-controlled
 * nondeterministic boundaries.
 *
 * **What it talks to:**
 * - Uses `RuntimeEntropySource` (import `RuntimeEntropySource`) from `./runtimeEntropy`.
 * - Uses `DEFAULT_RUNTIME_ENTROPY_SOURCE` (import `DEFAULT_RUNTIME_ENTROPY_SOURCE`) from `./runtimeEntropy`.
 *
 * @param prefix - Stable prefix for the generated identifier.
 * @param entropySource - Optional entropy source for timestamp/random token generation.
 * @returns Compact identifier string in `<prefix>_<time36>_<token>` form.
 */
export function makeId(
  prefix: string,
  entropySource: RuntimeEntropySource = DEFAULT_RUNTIME_ENTROPY_SOURCE
): string {
  const time = entropySource.nowMs().toString(36);
  const rand = entropySource.randomBase36(6);
  return `${prefix}_${time}_${rand}`;
}

