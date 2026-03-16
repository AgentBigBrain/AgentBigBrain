/**
 * @fileoverview Canonical action and execution-mode contracts extracted from the shared runtime type surface.
 */

export type ActionType =
  | "respond"
  | "read_file"
  | "write_file"
  | "delete_file"
  | "list_directory"
  | "create_skill"
  | "run_skill"
  | "network_write"
  | "self_modify"
  | "shell_command"
  | "start_process"
  | "check_process"
  | "stop_process"
  | "probe_port"
  | "probe_http"
  | "verify_browser"
  | "open_browser"
  | "close_browser"
  | "inspect_path_holders"
  | "inspect_workspace_resources"
  | "memory_mutation"
  | "pulse_emit";

export type ExecutionMode = "fast_path" | "escalation_path";
