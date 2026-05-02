/**
 * @fileoverview Canonical action authority metadata shared by planner schemas and hard constraints.
 */

import type { ActionType } from "./types";

type JsonSchemaNode = Readonly<Record<string, unknown>>;

export type ActionRiskClass =
  | "none"
  | "local_read"
  | "local_write"
  | "external_write"
  | "runtime_control"
  | "memory_write"
  | "skill_lifecycle"
  | "self_modification"
  | "continuity";

export type ActionSideEffectClass =
  | "none"
  | "local_filesystem"
  | "external_network"
  | "runtime_process"
  | "browser"
  | "memory"
  | "skill"
  | "self_modification"
  | "pulse";

export interface ActionDefinition {
  readonly type: ActionType;
  readonly description: string;
  readonly aliases: readonly string[];
  readonly legacyAliases?: readonly string[];
  readonly riskClass: ActionRiskClass;
  readonly sideEffectClass: ActionSideEffectClass;
  readonly paramsSchema: JsonSchemaNode;
}

export interface PlannerActionAliasCompatibilityDiagnostic {
  readonly alias: string;
  readonly legacyActionType: ActionType;
  readonly reason: "generic_alias_requires_exact_action_context";
}

const STRING_SCHEMA = { type: "string" } as const;
const INTEGER_SCHEMA = { type: "integer" } as const;
const BOOLEAN_SCHEMA = { type: "boolean" } as const;
const UNKNOWN_OBJECT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {},
  required: []
} as const;

/**
 * Creates a closed object-params schema for one planner action.
 *
 * @param properties - JSON-schema property map.
 * @param required - Required property names before provider strict-mode expansion.
 * @returns Logical JSON-schema node.
 */
function objectParams(
  properties: Record<string, unknown>,
  required: readonly string[] = []
): JsonSchemaNode {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: [...required]
  };
}

/**
 * Creates a params schema that allows one of several closed object shapes.
 *
 * @param schemas - Candidate params schemas.
 * @returns Logical JSON-schema `anyOf` node.
 */
function oneOfParams(schemas: readonly JsonSchemaNode[]): JsonSchemaNode {
  return {
    anyOf: schemas.map((schema) => ({ ...schema }))
  };
}

const TEXT_PARAMS = objectParams({
  message: STRING_SCHEMA,
  text: STRING_SCHEMA
});
const PATH_PARAMS = objectParams({ path: STRING_SCHEMA }, ["path"]);
const WRITE_FILE_PARAMS = objectParams({
  path: STRING_SCHEMA,
  content: STRING_SCHEMA
}, ["path", "content"]);
const SHELL_PARAMS = objectParams({
  command: STRING_SCHEMA,
  cwd: STRING_SCHEMA,
  workdir: STRING_SCHEMA,
  requestedShellKind: {
    type: "string",
    enum: ["powershell", "pwsh", "cmd", "bash", "zsh", "wsl_bash"]
  },
  timeoutMs: INTEGER_SCHEMA
}, ["command"]);
const LEASE_PARAMS = objectParams({ leaseId: STRING_SCHEMA }, ["leaseId"]);
const STOP_PROCESS_PARAMS = objectParams({
  leaseId: STRING_SCHEMA,
  pid: INTEGER_SCHEMA,
  preserveLinkedBrowserSessions: BOOLEAN_SCHEMA
});
const PROBE_PORT_PARAMS = objectParams({
  host: STRING_SCHEMA,
  port: INTEGER_SCHEMA,
  timeoutMs: INTEGER_SCHEMA
}, ["port"]);
const PROBE_HTTP_PARAMS = objectParams({
  url: STRING_SCHEMA,
  expectedStatus: INTEGER_SCHEMA,
  timeoutMs: INTEGER_SCHEMA
}, ["url"]);
const VERIFY_BROWSER_PARAMS = objectParams({
  url: STRING_SCHEMA,
  expectedTitle: STRING_SCHEMA,
  expectedText: STRING_SCHEMA,
  timeoutMs: INTEGER_SCHEMA
}, ["url"]);
const OPEN_BROWSER_PARAMS = objectParams({
  url: STRING_SCHEMA,
  timeoutMs: INTEGER_SCHEMA,
  rootPath: STRING_SCHEMA,
  previewProcessLeaseId: STRING_SCHEMA
}, ["url"]);
const CLOSE_BROWSER_PARAMS = objectParams({
  sessionId: STRING_SCHEMA,
  url: STRING_SCHEMA
});
const CREATE_SKILL_PARAMS = oneOfParams([
  objectParams({
    name: STRING_SCHEMA,
    kind: { type: "string", enum: ["executable_module"] },
    code: STRING_SCHEMA
  }, ["name", "kind", "code"]),
  objectParams({
    name: STRING_SCHEMA,
    kind: { type: "string", enum: ["markdown_instruction"] },
    instructions: STRING_SCHEMA
  }, ["name", "kind", "instructions"])
]);
const UPDATE_SKILL_PARAMS = objectParams({
  name: STRING_SCHEMA,
  code: STRING_SCHEMA,
  instructions: STRING_SCHEMA,
  markdownContent: STRING_SCHEMA,
  content: STRING_SCHEMA,
  description: STRING_SCHEMA,
  purpose: STRING_SCHEMA,
  version: STRING_SCHEMA
}, ["name"]);
const SKILL_LIFECYCLE_PARAMS = objectParams({
  name: STRING_SCHEMA,
  reason: STRING_SCHEMA
}, ["name"]);
const RUN_SKILL_PARAMS = objectParams({
  name: STRING_SCHEMA,
  input: STRING_SCHEMA,
  text: STRING_SCHEMA,
  exportName: STRING_SCHEMA
}, ["name"]);
const NETWORK_WRITE_PARAMS = oneOfParams([
  objectParams({ endpoint: STRING_SCHEMA }, ["endpoint"]),
  objectParams({ url: STRING_SCHEMA }, ["url"])
]);
const SELF_MODIFY_PARAMS = objectParams({
  target: STRING_SCHEMA,
  touchesImmutable: BOOLEAN_SCHEMA
});
const STOP_FOLDER_RUNTIME_PROCESSES_PARAMS = objectParams({
  rootPath: STRING_SCHEMA,
  selectorMode: { type: "string", enum: ["starts_with", "contains"] },
  selectorTerm: STRING_SCHEMA
}, ["rootPath", "selectorMode", "selectorTerm"]);
const INSPECT_WORKSPACE_RESOURCES_PARAMS = objectParams({
  rootPath: STRING_SCHEMA,
  path: STRING_SCHEMA,
  previewUrl: STRING_SCHEMA,
  browserSessionId: STRING_SCHEMA,
  previewProcessLeaseId: STRING_SCHEMA
}, ["rootPath"]);
const MEMORY_MUTATION_PARAMS = objectParams({
  store: { type: "string", enum: ["entity_graph", "conversation_stack", "pulse_state"] },
  operation: { type: "string", enum: ["upsert", "merge", "supersede", "resolve", "evict"] },
  payload: UNKNOWN_OBJECT_SCHEMA
}, ["store", "operation", "payload"]);
const PULSE_EMIT_PARAMS = objectParams({
  kind: {
    type: "string",
    enum: ["bridge_question", "open_loop_resume", "topic_resume", "stale_fact_revalidation"]
  },
  reasonCode: STRING_SCHEMA
}, ["kind", "reasonCode"]);

export const ACTION_DEFINITIONS: readonly ActionDefinition[] = [
  {
    type: "respond",
    description: "Produce a direct response to the user.",
    aliases: ["response", "reply", "say", "message"],
    riskClass: "none",
    sideEffectClass: "none",
    paramsSchema: TEXT_PARAMS
  },
  {
    type: "read_file",
    description: "Read file contents needed for the task.",
    aliases: ["file_read"],
    legacyAliases: ["read"],
    riskClass: "local_read",
    sideEffectClass: "none",
    paramsSchema: PATH_PARAMS
  },
  {
    type: "write_file",
    description: "Write generated output to a file.",
    aliases: ["file_write"],
    legacyAliases: ["write"],
    riskClass: "local_write",
    sideEffectClass: "local_filesystem",
    paramsSchema: WRITE_FILE_PARAMS
  },
  {
    type: "delete_file",
    description: "Delete a target file path requested by the task.",
    aliases: ["file_delete"],
    legacyAliases: ["delete", "remove", "rm"],
    riskClass: "local_write",
    sideEffectClass: "local_filesystem",
    paramsSchema: PATH_PARAMS
  },
  {
    type: "list_directory",
    description: "List files in a target directory.",
    aliases: ["list_files", "list_dir"],
    legacyAliases: ["list", "ls", "dir"],
    riskClass: "local_read",
    sideEffectClass: "none",
    paramsSchema: PATH_PARAMS
  },
  {
    type: "create_skill",
    description: "Create a governed runtime skill or Markdown instruction skill.",
    aliases: ["create_tool", "write_skill"],
    riskClass: "skill_lifecycle",
    sideEffectClass: "skill",
    paramsSchema: CREATE_SKILL_PARAMS
  },
  {
    type: "update_skill",
    description: "Update a governed runtime skill or Markdown instruction skill.",
    aliases: ["edit_skill", "revise_skill"],
    riskClass: "skill_lifecycle",
    sideEffectClass: "skill",
    paramsSchema: UPDATE_SKILL_PARAMS
  },
  {
    type: "deprecate_skill",
    description: "Deprecate a governed runtime skill.",
    aliases: ["disable_skill"],
    riskClass: "skill_lifecycle",
    sideEffectClass: "skill",
    paramsSchema: SKILL_LIFECYCLE_PARAMS
  },
  {
    type: "approve_skill",
    description: "Approve a pending governed runtime skill for active reuse.",
    aliases: ["promote_skill"],
    riskClass: "skill_lifecycle",
    sideEffectClass: "skill",
    paramsSchema: SKILL_LIFECYCLE_PARAMS
  },
  {
    type: "reject_skill",
    description: "Reject a pending governed runtime skill.",
    aliases: [],
    riskClass: "skill_lifecycle",
    sideEffectClass: "skill",
    paramsSchema: SKILL_LIFECYCLE_PARAMS
  },
  {
    type: "run_skill",
    description: "Run a previously created skill for the current request.",
    aliases: ["use_skill", "invoke_skill"],
    legacyAliases: ["run", "use", "invoke"],
    riskClass: "runtime_control",
    sideEffectClass: "skill",
    paramsSchema: RUN_SKILL_PARAMS
  },
  {
    type: "network_write",
    description: "Call an external API endpoint.",
    aliases: ["http_request", "api_call", "call_api", "webhook"],
    legacyAliases: ["network"],
    riskClass: "external_write",
    sideEffectClass: "external_network",
    paramsSchema: NETWORK_WRITE_PARAMS
  },
  {
    type: "self_modify",
    description: "Propose a governed self-modification.",
    aliases: ["self_edit", "self_update", "modify_self"],
    riskClass: "self_modification",
    sideEffectClass: "self_modification",
    paramsSchema: SELF_MODIFY_PARAMS
  },
  {
    type: "shell_command",
    description: "Run a shell command required by the task.",
    aliases: ["shell", "run_command", "terminal"],
    legacyAliases: ["command"],
    riskClass: "runtime_control",
    sideEffectClass: "runtime_process",
    paramsSchema: SHELL_PARAMS
  },
  {
    type: "start_process",
    description: "Start a managed long-running process required by the task.",
    aliases: ["start_server", "launch_process"],
    riskClass: "runtime_control",
    sideEffectClass: "runtime_process",
    paramsSchema: SHELL_PARAMS
  },
  {
    type: "check_process",
    description: "Check the status of a managed long-running process.",
    aliases: ["process_status"],
    riskClass: "none",
    sideEffectClass: "none",
    paramsSchema: LEASE_PARAMS
  },
  {
    type: "stop_process",
    description: "Stop a managed long-running process.",
    aliases: ["terminate_process", "kill_process"],
    riskClass: "runtime_control",
    sideEffectClass: "runtime_process",
    paramsSchema: STOP_PROCESS_PARAMS
  },
  {
    type: "probe_port",
    description: "Probe a local TCP port for readiness.",
    aliases: ["port_probe", "wait_for_port"],
    riskClass: "none",
    sideEffectClass: "none",
    paramsSchema: PROBE_PORT_PARAMS
  },
  {
    type: "probe_http",
    description: "Probe a local HTTP endpoint for readiness.",
    aliases: ["http_probe", "check_url"],
    riskClass: "none",
    sideEffectClass: "none",
    paramsSchema: PROBE_HTTP_PARAMS
  },
  {
    type: "verify_browser",
    description: "Verify a local browser-rendered page using governed UI checks.",
    aliases: ["browser_verify", "browser_check", "ui_verify", "playwright_verify"],
    riskClass: "none",
    sideEffectClass: "none",
    paramsSchema: VERIFY_BROWSER_PARAMS
  },
  {
    type: "open_browser",
    description: "Open a local page in a visible browser window and leave it open.",
    aliases: ["browser_open", "launch_browser"],
    riskClass: "runtime_control",
    sideEffectClass: "browser",
    paramsSchema: OPEN_BROWSER_PARAMS
  },
  {
    type: "close_browser",
    description: "Close a tracked browser window that the runtime previously opened.",
    aliases: ["browser_close", "close_tab"],
    riskClass: "runtime_control",
    sideEffectClass: "browser",
    paramsSchema: CLOSE_BROWSER_PARAMS
  },
  {
    type: "stop_folder_runtime_processes",
    description: "Inspect matching user-owned folders and stop only exact local server processes tied to those folders.",
    aliases: ["stop_runtime_folder_processes", "folder_runtime_process_sweep"],
    riskClass: "runtime_control",
    sideEffectClass: "runtime_process",
    paramsSchema: STOP_FOLDER_RUNTIME_PROCESSES_PARAMS
  },
  {
    type: "inspect_path_holders",
    description: "Inspect runtime-owned holders or preview resources that still match one local path.",
    aliases: ["inspect_path_holder", "inspect_holders"],
    riskClass: "local_read",
    sideEffectClass: "none",
    paramsSchema: PATH_PARAMS
  },
  {
    type: "inspect_workspace_resources",
    description: "Inspect runtime-owned browser and preview resources for one tracked workspace.",
    aliases: ["inspect_workspace", "inspect_workspace_resources_for_followup"],
    riskClass: "local_read",
    sideEffectClass: "none",
    paramsSchema: INSPECT_WORKSPACE_RESOURCES_PARAMS
  },
  {
    type: "memory_mutation",
    description: "Apply a governed local memory mutation.",
    aliases: ["memory_update", "thread_update"],
    riskClass: "memory_write",
    sideEffectClass: "memory",
    paramsSchema: MEMORY_MUTATION_PARAMS
  },
  {
    type: "pulse_emit",
    description: "Emit a governed continuity pulse candidate.",
    aliases: ["emit_pulse", "bridge_question"],
    riskClass: "continuity",
    sideEffectClass: "pulse",
    paramsSchema: PULSE_EMIT_PARAMS
  }
] as const;

const ACTION_DEFINITION_BY_TYPE = new Map<ActionType, ActionDefinition>(
  ACTION_DEFINITIONS.map((definition) => [definition.type, definition])
);

const ACTION_ALIAS_BY_KEY = new Map<string, ActionType>();
const LEGACY_ALIAS_BY_KEY = new Map<string, ActionType>();

for (const definition of ACTION_DEFINITIONS) {
  ACTION_ALIAS_BY_KEY.set(normalizeAliasKey(definition.type), definition.type);
  for (const alias of definition.aliases) {
    ACTION_ALIAS_BY_KEY.set(normalizeAliasKey(alias), definition.type);
  }
  for (const alias of definition.legacyAliases ?? []) {
    LEGACY_ALIAS_BY_KEY.set(normalizeAliasKey(alias), definition.type);
  }
}

/**
 * Returns canonical action ids in registry order.
 *
 * @returns Ordered action type list.
 */
export function getPlannerActionTypes(): readonly ActionType[] {
  return ACTION_DEFINITIONS.map((definition) => definition.type);
}

/**
 * Looks up canonical action metadata.
 *
 * @param type - Candidate action type.
 * @returns Registry definition for the action.
 */
export function getPlannerActionDefinition(type: ActionType): ActionDefinition {
  const definition = ACTION_DEFINITION_BY_TYPE.get(type);
  if (!definition) {
    throw new Error(`Missing action definition for ${type}.`);
  }
  return definition;
}

/**
 * Evaluates whether a value is a canonical action id.
 *
 * @param value - Candidate value.
 * @returns `true` when the value is a registered action type.
 */
export function isRegisteredPlannerActionType(value: unknown): value is ActionType {
  return typeof value === "string" && ACTION_DEFINITION_BY_TYPE.has(value as ActionType);
}

/**
 * Normalizes exact action aliases while excluding broad legacy verbs.
 *
 * @param value - Candidate alias.
 * @returns Canonical action type, or `null` when the alias is unknown or legacy-only.
 */
export function normalizePlannerActionAlias(value: unknown): ActionType | null {
  if (typeof value !== "string") {
    return null;
  }
  return ACTION_ALIAS_BY_KEY.get(normalizeAliasKey(value)) ?? null;
}

/**
 * Reports broad legacy aliases without letting them grant action authority.
 *
 * @param value - Candidate alias.
 * @returns Compatibility diagnostic, or `null` when the alias is not legacy-only.
 */
export function getPlannerActionAliasCompatibilityDiagnostic(
  value: unknown
): PlannerActionAliasCompatibilityDiagnostic | null {
  if (typeof value !== "string") {
    return null;
  }
  const alias = normalizeAliasKey(value);
  const legacyActionType = LEGACY_ALIAS_BY_KEY.get(alias);
  if (!legacyActionType) {
    return null;
  }
  return {
    alias,
    legacyActionType,
    reason: "generic_alias_requires_exact_action_context"
  };
}

/**
 * Builds the discriminated planner-action schema node from registry metadata.
 *
 * @returns JSON Schema node for one planner action item.
 */
export function buildPlannerActionSchemaNode(): JsonSchemaNode {
  return {
    anyOf: ACTION_DEFINITIONS.map((definition) => ({
      type: "object",
      additionalProperties: false,
      properties: {
        type: { type: "string", enum: [definition.type] },
        description: STRING_SCHEMA,
        params: definition.paramsSchema
      },
      required: ["type", "description", "params"]
    }))
  };
}

/**
 * Normalizes action aliases into stable registry keys.
 *
 * @param value - Raw alias value.
 * @returns Lowercase underscore-separated alias key.
 */
function normalizeAliasKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, "_");
}
