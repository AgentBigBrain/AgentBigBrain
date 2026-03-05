/**
 * @fileoverview Shared parsing and stringification utilities for deterministic hard-constraint evaluation.
 */

/**
 * Reads a string parameter from an action parameter bag.
 *
 * **Why it exists:**
 * Keeps string extraction behavior consistent across hard-constraint checks.
 *
 * **What it talks to:**
 * - Reads plain object records only; no cross-module dependencies.
 *
 * @param params - Action params payload under hard-constraint evaluation.
 * @param key - Param key expected to map to a string.
 * @returns Parameter value when it is a string, otherwise `undefined`.
 */
export function getStringParam(
  params: Record<string, unknown>,
  key: string
): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Reads a boolean parameter from an action parameter bag.
 *
 * **Why it exists:**
 * Prevents boolean-default drift in hard-constraint checks.
 *
 * **What it talks to:**
 * - Reads plain object records only; no cross-module dependencies.
 *
 * @param params - Action params payload under hard-constraint evaluation.
 * @param key - Param key expected to map to a boolean.
 * @returns Boolean value when present; otherwise `false`.
 */
export function getBooleanParam(
  params: Record<string, unknown>,
  key: string
): boolean {
  const value = params[key];
  return value === true;
}

/**
 * Reads a finite numeric parameter from an action parameter bag.
 *
 * **Why it exists:**
 * Keeps numeric parsing deterministic for shell timeout and related checks.
 *
 * **What it talks to:**
 * - Reads plain object records only; no cross-module dependencies.
 *
 * @param params - Action params payload under hard-constraint evaluation.
 * @param key - Param key expected to map to a finite number.
 * @returns Finite number when present; otherwise `undefined`.
 */
export function getNumberParam(
  params: Record<string, unknown>,
  key: string
): number | undefined {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return value;
}

/**
 * Converts unknown input into deterministic lowercase string for lexical checks.
 *
 * **Why it exists:**
 * Centralizes stringification behavior so semantic checks avoid inconsistent coercion.
 *
 * **What it talks to:**
 * - Uses local type checks and `JSON.stringify` fallback.
 *
 * @param input - Unknown value consumed by hard-constraint lexical checks.
 * @returns JSON text when serialization succeeds, otherwise an empty string.
 */
export function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return "";
  }
}
