/**
 * @fileoverview Provides explicit nondeterministic boundary helpers for time/random runtime needs.
 */

import { randomBytes } from "node:crypto";

/**
 * Shared runtime entropy source used by ID and atomic-file helper paths.
 */
export interface RuntimeEntropySource {
  nowMs: () => number;
  randomBase36: (length: number) => string;
  randomHex: (length: number) => string;
}

/**
 * Normalizes requested token length to a deterministic safe range.
 *
 * **Why it exists:**
 * Prevents call-site drift in token-length bounds for entropy-backed string generation.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param length - Requested character length.
 * @returns Safe bounded character length for token generation.
 */
function normalizeEntropyLength(length: number): number {
  if (!Number.isFinite(length)) {
    return 1;
  }
  return Math.max(1, Math.floor(length));
}

/**
 * Builds base36 token text from cryptographic random bytes.
 *
 * **Why it exists:**
 * Provides one deterministic wrapper around random-byte to base36 conversion so callers avoid
 * ad-hoc token generation.
 *
 * **What it talks to:**
 * - Uses `randomBytes` (import `randomBytes`) from `node:crypto`.
 * - Uses `normalizeEntropyLength` in this module.
 *
 * @param length - Requested token length.
 * @returns Base36 token text with deterministic output length.
 */
function buildRandomBase36(length: number): string {
  const normalizedLength = normalizeEntropyLength(length);
  const requiredBytes = Math.max(8, Math.ceil((normalizedLength * 5) / 8));
  const token = randomBytes(requiredBytes).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (token.length >= normalizedLength) {
    return token.slice(0, normalizedLength);
  }
  return token.padEnd(normalizedLength, "0");
}

/**
 * Builds hexadecimal token text from cryptographic random bytes.
 *
 * **Why it exists:**
 * Keeps random hex token generation centralized for deterministic formatting and test injection.
 *
 * **What it talks to:**
 * - Uses `randomBytes` (import `randomBytes`) from `node:crypto`.
 * - Uses `normalizeEntropyLength` in this module.
 *
 * @param length - Requested token length.
 * @returns Hex token text with deterministic output length.
 */
function buildRandomHex(length: number): string {
  const normalizedLength = normalizeEntropyLength(length);
  const requiredBytes = Math.ceil(normalizedLength / 2);
  return randomBytes(requiredBytes).toString("hex").slice(0, normalizedLength);
}

/**
 * Default runtime entropy boundary used in production paths.
 *
 * **Why it exists:**
 * Centralizes nondeterministic sources so call sites remain injectable and testable.
 *
 * **What it talks to:**
 * - Uses `Date.now` global boundary.
 * - Uses cryptographic-random helpers in this module.
 */
export const DEFAULT_RUNTIME_ENTROPY_SOURCE: RuntimeEntropySource = {
  nowMs: () => Date.now(),
  randomBase36: (length: number) => buildRandomBase36(length),
  randomHex: (length: number) => buildRandomHex(length)
};

