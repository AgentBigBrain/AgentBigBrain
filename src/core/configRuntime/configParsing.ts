/**
 * @fileoverview Canonical environment parsing and normalization helpers extracted from the shared config entrypoint.
 */

import type { LedgerBackend, RuntimeMode } from "./envContracts";

const INVALID_USER_PROTECTED_PATH_PATTERN = /[\u0000*?<>|]/;

/**
 * Parses boolean and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for boolean so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns `true` when this check passes.
 */
export function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

/**
 * Parses browser-verification launch visibility from env with deterministic alias precedence.
 *
 * **Why it exists:**
 * Keeps the visible-browser toggle centralized so CLI, Telegram, and Discord runtime assembly all
 * interpret the same env inputs the same way without duplicating alias rules.
 *
 * **What it talks to:**
 * - Uses `parseBoolean` within this module.
 *
 * @param env - Process environment carrying optional browser-verification overrides.
 * @param fallback - Default headless setting when no override is present.
 * @returns `true` when browser verification should stay headless.
 */
export function parseBrowserVerificationHeadless(
  env: NodeJS.ProcessEnv,
  fallback: boolean
): boolean {
  if (env.BRAIN_BROWSER_VERIFY_VISIBLE !== undefined) {
    return !parseBoolean(env.BRAIN_BROWSER_VERIFY_VISIBLE, false);
  }
  return parseBoolean(env.BRAIN_BROWSER_VERIFY_HEADLESS, fallback);
}

/**
 * Parses runtime mode and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for runtime mode so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `RuntimeMode` result.
 */
export function parseRuntimeMode(value: string | undefined): RuntimeMode {
  const normalized = (value ?? "isolated").trim().toLowerCase();
  return normalized === "full_access" ? "full_access" : "isolated";
}

/**
 * Parses ledger backend and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for ledger backend so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `LedgerBackend` result.
 */
export function parseLedgerBackend(value: string | undefined): LedgerBackend {
  const normalized = (value ?? "json").trim().toLowerCase();
  return normalized === "sqlite" ? "sqlite" : "json";
}

/**
 * Parses positive number and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for positive number so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns Computed numeric value.
 */
export function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

/**
 * Parses positive integer and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for positive integer so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns Computed numeric value.
 */
export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = parsePositiveNumber(value, fallback);
  return Number.isInteger(parsed) ? parsed : fallback;
}

/**
 * Parses bounded positive integer and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for bounded positive integer so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @param bounds - Value for bounds.
 * @param envKey - Lookup key or map field identifier.
 * @returns Computed numeric value.
 */
export function parseBoundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  bounds: { min: number; max: number },
  envKey: string
): number {
  const parsed = parsePositiveInteger(value, fallback);
  if (parsed < bounds.min || parsed > bounds.max) {
    throw new Error(`${envKey} out of range: ${parsed}. Expected ${bounds.min}..${bounds.max}.`);
  }
  return parsed;
}

/**
 * Parses integer and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for integer so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns Computed numeric value.
 */
export function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return fallback;
  }

  return parsed;
}

/**
 * Parses non negative integer and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for non negative integer so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns Computed numeric value.
 */
export function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = parseInteger(value, fallback);
  if (parsed < 0) {
    return fallback;
  }
  return parsed;
}

/**
 * Parses hour of day and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for hour of day so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns Computed numeric value.
 */
export function parseHourOfDay(value: string | undefined, fallback: number): number {
  const parsed = parseInteger(value, fallback);
  if (parsed < 0 || parsed > 23) {
    return fallback;
  }
  return parsed;
}

/**
 * Constrains and sanitizes wrapping quotes to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for wrapping quotes before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
export function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === "\"" || first === "'") && first === last) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

/**
 * Parses user protected path prefixes and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for user protected path prefixes so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Ordered collection produced by this step.
 */
export function parseUserProtectedPathPrefixes(value: string | undefined): string[] {
  if (!value || value.trim().length === 0) {
    return [];
  }

  const entries = value.split(";");
  if (entries.some((entry) => entry.trim().length === 0)) {
    throw new Error(
      "BRAIN_USER_PROTECTED_PATHS contains an empty path entry. " +
      "Use ';' separated non-empty paths."
    );
  }

  const parsed: string[] = [];
  for (const rawEntry of entries) {
    const pathEntry = stripWrappingQuotes(rawEntry);
    if (!pathEntry) {
      throw new Error(
        "BRAIN_USER_PROTECTED_PATHS contains an empty path entry after trimming quotes."
      );
    }

    if (INVALID_USER_PROTECTED_PATH_PATTERN.test(pathEntry)) {
      throw new Error(
        `BRAIN_USER_PROTECTED_PATHS contains invalid path entry "${pathEntry}". ` +
        "Wildcards and shell-reserved path characters are not allowed."
      );
    }

    appendProtectedPathPrefix(parsed, pathEntry);
  }

  return parsed;
}

/**
 * Normalizes protected path prefix into a stable shape for `config` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for protected path prefix so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeProtectedPathPrefix(value: string): string {
  const slashNormalized = value.replace(/\\/g, "/");
  let end = slashNormalized.length;
  while (end > 0 && slashNormalized[end - 1] === "/") {
    end -= 1;
  }
  return slashNormalized.slice(0, end).toLowerCase();
}

/**
 * Persists protected path prefix with deterministic state semantics.
 *
 * **Why it exists:**
 * Centralizes protected path prefix mutations for auditability and replay.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param prefixes - Value for prefixes.
 * @param candidate - Timestamp used for ordering, timeout, or recency decisions.
 */
export function appendProtectedPathPrefix(prefixes: string[], candidate: string): void {
  const normalizedCandidate = normalizeProtectedPathPrefix(candidate);
  if (prefixes.some((existing) => normalizeProtectedPathPrefix(existing) === normalizedCandidate)) {
    return;
  }
  prefixes.push(candidate);
}
