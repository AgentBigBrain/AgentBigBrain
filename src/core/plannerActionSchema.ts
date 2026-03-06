/**
 * @fileoverview Shared planner-action schema helpers used by model-boundary validation and planner normalization.
 */

import { ActionType } from "./types";

const PLANNER_ACTION_TYPES: readonly ActionType[] = [
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
  "memory_mutation",
  "pulse_emit"
];

const ACTION_TYPE_SET = new Set<ActionType>(PLANNER_ACTION_TYPES);

const PLANNER_ACTION_TYPE_ALIASES: Record<string, ActionType> = {
  respond: "respond",
  response: "respond",
  reply: "respond",
  say: "respond",
  message: "respond",
  read_file: "read_file",
  read: "read_file",
  file_read: "read_file",
  write_file: "write_file",
  write: "write_file",
  file_write: "write_file",
  delete_file: "delete_file",
  delete: "delete_file",
  remove: "delete_file",
  rm: "delete_file",
  file_delete: "delete_file",
  list_directory: "list_directory",
  list: "list_directory",
  ls: "list_directory",
  dir: "list_directory",
  list_files: "list_directory",
  list_dir: "list_directory",
  create_skill: "create_skill",
  create_tool: "create_skill",
  write_skill: "create_skill",
  run_skill: "run_skill",
  use_skill: "run_skill",
  invoke_skill: "run_skill",
  network_write: "network_write",
  network: "network_write",
  http_request: "network_write",
  api_call: "network_write",
  call_api: "network_write",
  webhook: "network_write",
  self_modify: "self_modify",
  self_edit: "self_modify",
  self_update: "self_modify",
  modify_self: "self_modify",
  shell_command: "shell_command",
  shell: "shell_command",
  command: "shell_command",
  run_command: "shell_command",
  terminal: "shell_command",
  start_process: "start_process",
  start_server: "start_process",
  launch_process: "start_process",
  check_process: "check_process",
  process_status: "check_process",
  stop_process: "stop_process",
  terminate_process: "stop_process",
  kill_process: "stop_process",
  probe_port: "probe_port",
  port_probe: "probe_port",
  wait_for_port: "probe_port",
  probe_http: "probe_http",
  http_probe: "probe_http",
  check_url: "probe_http",
  verify_browser: "verify_browser",
  browser_verify: "verify_browser",
  browser_check: "verify_browser",
  ui_verify: "verify_browser",
  playwright_verify: "verify_browser",
  memory_mutation: "memory_mutation",
  memory_update: "memory_mutation",
  thread_update: "memory_mutation",
  pulse_emit: "pulse_emit",
  emit_pulse: "pulse_emit",
  bridge_question: "pulse_emit",
  run: "run_skill",
  use: "run_skill",
  invoke: "run_skill"
};

/**
 * Converts values into planner record form for consistent downstream use.
 *
 * **Why it exists:**
 * Keeps conversion rules for planner record deterministic so callers do not duplicate mapping logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `Record<string, unknown> | null` result.
 */
export function toPlannerRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * Evaluates planner action type and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the planner action type policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `ActionType` (import `ActionType`) from `./types`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `value is ActionType` result.
 */
export function isPlannerActionType(value: unknown): value is ActionType {
  return typeof value === "string" && ACTION_TYPE_SET.has(value as ActionType);
}

/**
 * Normalizes planner action type alias into a stable shape for `plannerActionSchema` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for planner action type alias so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `ActionType` (import `ActionType`) from `./types`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `ActionType | null` result.
 */
export function normalizePlannerActionTypeAlias(value: unknown): ActionType | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalizedKey = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return PLANNER_ACTION_TYPE_ALIASES[normalizedKey] ?? null;
}

/**
 * Returns the default planner action description used when explicit config is absent.
 *
 * **Why it exists:**
 * Keeps fallback defaults for planner action description centralized so unset-config behavior is predictable.
 *
 * **What it talks to:**
 * - Uses `ActionType` (import `ActionType`) from `./types`.
 *
 * @param type - Value for type.
 * @returns Resulting string value.
 */
export function defaultPlannerActionDescription(type: ActionType): string {
  switch (type) {
    case "respond":
      return "Produce a direct response to the user.";
    case "read_file":
      return "Read file contents needed for the task.";
    case "write_file":
      return "Write generated output to a file.";
    case "delete_file":
      return "Delete a target file path requested by the task.";
    case "list_directory":
      return "List files in a target directory.";
    case "create_skill":
      return "Create a sandboxed auto-skill file.";
    case "run_skill":
      return "Run a previously created skill for the current request.";
    case "network_write":
      return "Call an external API endpoint.";
    case "self_modify":
      return "Propose a governed self-modification.";
    case "shell_command":
      return "Run a shell command required by the task.";
    case "start_process":
      return "Start a managed long-running process required by the task.";
    case "check_process":
      return "Check the status of a managed long-running process.";
    case "stop_process":
      return "Stop a managed long-running process.";
    case "probe_port":
      return "Probe a local TCP port for readiness.";
    case "probe_http":
      return "Probe a local HTTP endpoint for readiness.";
    case "verify_browser":
      return "Verify a local browser-rendered page using governed UI checks.";
    case "memory_mutation":
      return "Apply a governed local memory mutation.";
    case "pulse_emit":
      return "Emit a governed continuity pulse candidate.";
    default:
      return "Execute planned action.";
  }
}

/**
 * Derives planner action candidates from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for planner action candidates in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param payload - Structured input object for this operation.
 * @returns Ordered collection produced by this step.
 */
export function extractPlannerActionCandidates(payload: unknown): unknown[] {
  const record = toPlannerRecord(payload);
  if (!record) {
    return [];
  }

  if (Array.isArray(record.actions)) {
    return record.actions;
  }

  if (record.action !== undefined) {
    return [record.action];
  }

  if (Array.isArray(record.steps)) {
    return record.steps;
  }

  return [];
}

/**
 * Normalizes planner action params into a stable shape for `plannerActionSchema` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for planner action params so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param actionRecord - Value for action record.
 * @param existingParams - Structured input object for this operation.
 * @returns Computed `Record<string, unknown>` result.
 */
export function normalizePlannerActionParams(
  actionRecord: Record<string, unknown>,
  existingParams: Record<string, unknown>
): Record<string, unknown> {
  const params = Object.fromEntries(
    Object.entries(existingParams).filter(([, value]) => value !== null && value !== undefined)
  );
  const stringFields = [
    "message",
    "text",
    "name",
    "code",
    "content",
    "path",
    "command",
    "cwd",
    "workdir",
    "requestedShellKind",
    "leaseId",
    "host",
    "url",
    "expectedTitle",
    "expectedText"
  ] as const;
  for (const field of stringFields) {
    if (typeof actionRecord[field] === "string" && typeof params[field] !== "string") {
      params[field] = actionRecord[field];
    }
  }

  const numberFields = ["port", "timeoutMs", "expectedStatus"] as const;
  for (const field of numberFields) {
    if (typeof actionRecord[field] === "number" && typeof params[field] !== "number") {
      params[field] = actionRecord[field];
    }
  }

  return params;
}
