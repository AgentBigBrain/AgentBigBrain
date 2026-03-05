/**
 * @fileoverview Deterministic shell command lexical and path-target helpers for hard constraints.
 */

import { getStringParam } from "./hardConstraintParamUtils";

const SHELL_PATH_PARAM_KEYS = [
  "path",
  "target",
  "file",
  "directory",
  "cwd",
  "workdir",
  "output",
  "input"
] as const;
const DANGEROUS_SHELL_PATTERNS = ["rm -rf /", "del /f /s /q", "format c:", "mkfs", "shutdown -s"];

/**
 * Detects obviously destructive shell command signatures.
 *
 * **Why it exists:**
 * Some command fragments are always unsafe and should be blocked before any deeper policy routing.
 *
 * **What it talks to:**
 * - Uses fixed local denylist patterns only.
 *
 * @param command - Raw shell command string.
 * @returns `true` when command text matches a destructive signature.
 */
export function containsDangerousCommand(command: string): boolean {
  const normalized = command.toLowerCase();
  return DANGEROUS_SHELL_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/**
 * Splits shell command text into tokens while preserving quoted groups.
 *
 * **Why it exists:**
 * Path-target extraction requires deterministic token boundaries for command scanning.
 *
 * **What it talks to:**
 * - Local regex tokenization only.
 *
 * @param command - Raw shell command string.
 * @returns Tokenized command segments preserving quoted groups.
 */
function splitShellCommandTokens(command: string): string[] {
  return command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

/**
 * Normalizes shell token punctuation and quote decoration.
 *
 * **Why it exists:**
 * Path-target extraction should compare cleaned tokens rather than shell redirection punctuation.
 *
 * **What it talks to:**
 * - Local regex string normalization only.
 *
 * @param token - Candidate command token to normalize.
 * @returns Token stripped of redirection and quote decoration.
 */
function stripShellTokenDecoration(token: string): string {
  return token
    .trim()
    .replace(/^[<>]+/, "")
    .replace(/[<>;,]+$/, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}

/**
 * Heuristically checks whether a shell token likely represents a filesystem path.
 *
 * **Why it exists:**
 * Shell path-escape checks need to inspect command arguments and compare only path-like tokens
 * against protected prefixes.
 *
 * **What it talks to:**
 * - Local token-shape checks only.
 *
 * @param token - Normalized shell token candidate.
 * @returns `true` when token shape resembles a local filesystem path.
 */
function isLikelyPathToken(token: string): boolean {
  if (!token || token.startsWith("-")) {
    return false;
  }

  if (/^[a-z]+:\/\//i.test(token)) {
    return false;
  }

  if (/^[a-z]+:/i.test(token) && !/^[a-z]:[\\/]/i.test(token)) {
    return false;
  }

  return (
    token.includes("/") ||
    token.includes("\\") ||
    token.startsWith(".") ||
    token.startsWith("~") ||
    /^[a-z]:/i.test(token)
  );
}

/**
 * Derives candidate path targets from shell params and command tokens.
 *
 * **Why it exists:**
 * Hard constraints must inspect both explicit path params and implicit path tokens inside command
 * text before allowing shell execution.
 *
 * **What it talks to:**
 * - Reads known path-bearing shell param keys via `getStringParam`.
 * - Calls token parsing helpers to extract path-like command tokens.
 *
 * @param params - Shell action parameter bag.
 * @returns Deduplicated candidate path targets extracted from params and command text.
 */
export function extractShellPathTargets(params: Record<string, unknown>): string[] {
  const targets = new Set<string>();

  for (const key of SHELL_PATH_PARAM_KEYS) {
    const value = getStringParam(params, key);
    if (value && value.trim().length > 0) {
      targets.add(value.trim());
    }
  }

  const command = getStringParam(params, "command");
  if (!command) {
    return Array.from(targets);
  }

  for (const rawToken of splitShellCommandTokens(command)) {
    const token = stripShellTokenDecoration(rawToken);
    if (!isLikelyPathToken(token)) {
      continue;
    }
    targets.add(token);
  }

  return Array.from(targets);
}
