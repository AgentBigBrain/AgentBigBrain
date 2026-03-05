/**
 * @fileoverview Loads `.env` and `.env.local` into process.env with non-destructive semantics.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

let isLoaded = false;

/**
 * Implements unquote value behavior used by `envLoader`.
 *
 * **Why it exists:**
 * Keeps `unquote value` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param rawValue - Value for raw value.
 * @returns Resulting string value.
 */
function unquoteValue(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  const commentIndex = trimmed.indexOf(" #");
  if (commentIndex >= 0) {
    return trimmed.slice(0, commentIndex).trim();
  }

  return trimmed;
}

/**
 * Parses env assignment and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for env assignment so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param line - Single text line being parsed or transformed.
 * @returns Computed `{ key: string; value: string } | null` result.
 */
function parseEnvAssignment(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }

  const withoutExport = trimmed.startsWith("export ")
    ? trimmed.slice("export ".length).trim()
    : trimmed;
  const equalsIndex = withoutExport.indexOf("=");
  if (equalsIndex <= 0) {
    return null;
  }

  const key = withoutExport.slice(0, equalsIndex).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return null;
  }

  const rawValue = withoutExport.slice(equalsIndex + 1);
  return {
    key,
    value: unquoteValue(rawValue)
  };
}

/**
 * Reads env file needed for this execution step.
 *
 * **Why it exists:**
 * Separates env file read-path handling from orchestration and mutation code.
 *
 * **What it talks to:**
 * - Uses `existsSync` (import `existsSync`) from `node:fs`.
 * - Uses `readFileSync` (import `readFileSync`) from `node:fs`.
 *
 * @param filePath - Filesystem location used by this operation.
 */
function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }

  const contents = readFileSync(filePath, "utf8");
  const lines = contents.split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseEnvAssignment(line);
    if (!parsed) {
      continue;
    }
    if (process.env[parsed.key] === undefined) {
      process.env[parsed.key] = parsed.value;
    }
  }
}

/**
 * Parses boolean env and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for boolean env so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns `true` when this check passes.
 */
function parseBooleanEnv(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(normalized);
}

/**
 * Applies deterministic validity checks for env loaded.
 *
 * **Why it exists:**
 * Fails fast when env loaded is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses `path` (import `default`) from `node:path`.
 */
export function ensureEnvLoaded(): void {
  if (isLoaded) {
    return;
  }
  isLoaded = true;

  if (parseBooleanEnv(process.env.BRAIN_DISABLE_DOTENV)) {
    return;
  }

  const cwd = process.cwd();
  loadEnvFile(path.resolve(cwd, ".env"));
  loadEnvFile(path.resolve(cwd, ".env.local"));
}

