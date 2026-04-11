/**
 * @fileoverview Shared prompt parsing and action-type helpers for the mock model runtime.
 */

import { extractActiveRequestSegment } from "../../core/currentRequestExtraction";
import type { ActionType } from "../../core/types";

export type MockStructuredInput = Record<string, unknown>;

export const ACTION_TYPES: readonly ActionType[] = [
  "respond",
  "read_file",
  "write_file",
  "delete_file",
  "list_directory",
  "create_skill",
  "run_skill",
  "network_write",
  "self_modify",
  "shell_command",
  "start_process",
  "check_process",
  "stop_process",
  "probe_port",
  "probe_http",
  "verify_browser",
  "open_browser",
  "close_browser",
  "stop_folder_runtime_processes",
  "inspect_path_holders",
  "inspect_workspace_resources",
  "memory_mutation",
  "pulse_emit"
] as const;

/**
 * Evaluates action type and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the mock action-type check explicit and reusable across extracted mock response builders.
 *
 * **What it talks to:**
 * - Uses `ActionType` (import `ActionType`) from `../../core/types`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is ActionType` result.
 */
export function isActionType(value: string): value is ActionType {
  return ACTION_TYPES.includes(value as ActionType);
}

/**
 * Parses json object and validates expected structure.
 *
 * **Why it exists:**
 * Keeps mock structured-input parsing deterministic across planner, governor, and synthesis flows.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `MockStructuredInput` result.
 */
export function parseJsonObject(input: string): MockStructuredInput {
  try {
    const parsed = JSON.parse(input);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as MockStructuredInput;
    }
  } catch {
    // Fall through and return empty object.
  }

  return {};
}

/**
 * Converts values into string form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps mock string conversion rules deterministic so extracted builders do not duplicate them.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
export function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Resolves the active user request from structured mock-model input.
 *
 * **Why it exists:**
 * Keeps mock planner and synthesis behavior aligned with wrapped interface payloads so tests
 * target the newest user turn instead of stale conversation context.
 *
 * **What it talks to:**
 * - Uses `extractActiveRequestSegment` (import `extractActiveRequestSegment`) from `../../core/currentRequestExtraction`.
 * - Uses `asString` from this module.
 *
 * @param input - Parsed structured model input object.
 * @param fallbackPrompt - Raw prompt fallback used when no structured user input is present.
 * @returns Active request text used for deterministic mock intent matching.
 */
export function resolveActiveMockUserInput(
  input: MockStructuredInput,
  fallbackPrompt: string
): string {
  const currentUserRequest = asString(input.currentUserRequest).trim();
  if (currentUserRequest.length > 0) {
    return currentUserRequest;
  }

  const structuredUserInput = asString(input.userInput).trim();
  if (structuredUserInput.length > 0) {
    const activeRequest = extractActiveRequestSegment(structuredUserInput);
    return activeRequest.length > 0 ? activeRequest : structuredUserInput;
  }

  return fallbackPrompt;
}

/**
 * Evaluates any and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps lexical inclusion checks centralized for extracted mock response builders.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param text - Message/text content processed by this function.
 * @param patterns - Value for patterns.
 * @returns `true` when this check passes.
 */
export function includesAny(text: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => text.includes(pattern));
}
