/**
 * @fileoverview Canonical JSON Schema builders for model backends that support schema files.
 */

import type { KnownModelSchemaName } from "./contracts";
import { toStrictStructuredSchemaNode } from "./strictStructuredSchema";

const STRING_SCHEMA = { type: "string" } as const;
const NUMBER_SCHEMA = { type: "number" } as const;
const BOOLEAN_SCHEMA = { type: "boolean" } as const;
const INTEGER_SCHEMA = { type: "integer" } as const;
const STRING_ARRAY_SCHEMA = {
  type: "array",
  items: STRING_SCHEMA
} as const;

const PLANNER_ACTION_TYPE_VALUES = [
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

const PLANNER_PARAMS_SCHEMA = {
  anyOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: {},
      required: []
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        message: STRING_SCHEMA
      },
      required: ["message"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        text: STRING_SCHEMA
      },
      required: ["text"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        path: STRING_SCHEMA
      },
      required: ["path"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        path: STRING_SCHEMA,
        content: STRING_SCHEMA
      },
      required: ["path", "content"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        command: STRING_SCHEMA,
        cwd: STRING_SCHEMA,
        workdir: STRING_SCHEMA,
        requestedShellKind: {
          type: "string",
          enum: ["powershell", "pwsh", "cmd", "bash", "zsh", "wsl_bash"]
        },
        timeoutMs: INTEGER_SCHEMA
      },
      required: ["command"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        leaseId: STRING_SCHEMA
      },
      required: ["leaseId"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        host: STRING_SCHEMA,
        port: INTEGER_SCHEMA,
        timeoutMs: INTEGER_SCHEMA
      },
      required: ["port"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        url: STRING_SCHEMA,
        expectedStatus: INTEGER_SCHEMA,
        timeoutMs: INTEGER_SCHEMA
      },
      required: ["url"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        url: STRING_SCHEMA,
        expectedTitle: STRING_SCHEMA,
        expectedText: STRING_SCHEMA,
        timeoutMs: INTEGER_SCHEMA
      },
      required: ["url"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        name: STRING_SCHEMA
      },
      required: ["name"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        name: STRING_SCHEMA,
        code: STRING_SCHEMA
      },
      required: ["name", "code"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        name: STRING_SCHEMA,
        kind: {
          type: "string",
          enum: ["executable_module"]
        },
        code: STRING_SCHEMA
      },
      required: ["name", "kind", "code"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        name: STRING_SCHEMA,
        kind: {
          type: "string",
          enum: ["markdown_instruction"]
        },
        instructions: STRING_SCHEMA
      },
      required: ["name", "kind", "instructions"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        name: STRING_SCHEMA,
        input: STRING_SCHEMA
      },
      required: ["name", "input"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        endpoint: STRING_SCHEMA
      },
      required: ["endpoint"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        url: STRING_SCHEMA
      },
      required: ["url"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: STRING_SCHEMA,
        url: STRING_SCHEMA
      },
      required: []
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        rootPath: STRING_SCHEMA,
        selectorMode: {
          type: "string",
          enum: ["starts_with", "contains"]
        },
        selectorTerm: STRING_SCHEMA
      },
      required: ["rootPath", "selectorMode", "selectorTerm"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        rootPath: STRING_SCHEMA,
        previewUrl: STRING_SCHEMA,
        browserSessionId: STRING_SCHEMA,
        previewProcessLeaseId: STRING_SCHEMA
      },
      required: ["rootPath"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        store: { type: "string", enum: ["entity_graph", "conversation_stack", "pulse_state"] },
        operation: { type: "string", enum: ["upsert", "merge", "supersede", "resolve", "evict"] },
        payload: {
          type: "object",
          additionalProperties: false,
          properties: {},
          required: []
        }
      },
      required: ["store", "operation", "payload"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: {
          type: "string",
          enum: ["bridge_question", "open_loop_resume", "topic_resume", "stale_fact_revalidation"]
        },
        reasonCode: STRING_SCHEMA
      },
      required: ["kind", "reasonCode"]
    }
  ]
} as const;

/**
 * Builds a JSON Schema object for one known structured model schema name.
 *
 * @param schemaName - Known structured schema identifier.
 * @returns JSON Schema object compatible with Codex CLI output-schema input.
 */
export function buildJsonSchemaForKnownModelSchema(schemaName: KnownModelSchemaName): unknown {
  if (schemaName === "planner_v1") {
    return toStrictStructuredSchemaNode({
      type: "object",
      properties: {
        plannerNotes: STRING_SCHEMA,
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: [...PLANNER_ACTION_TYPE_VALUES]
              },
              description: STRING_SCHEMA,
              params: PLANNER_PARAMS_SCHEMA
            },
            required: ["type", "description", "params"]
          }
        }
      },
      required: ["plannerNotes", "actions"]
    });
  }

  if (schemaName === "response_v1") {
    return toStrictStructuredSchemaNode({
      type: "object",
      properties: {
        message: STRING_SCHEMA
      },
      required: ["message"]
    });
  }

  if (schemaName === "reflection_v1") {
    return toStrictStructuredSchemaNode({
      type: "object",
      properties: {
        lessons: STRING_ARRAY_SCHEMA
      },
      required: ["lessons"]
    });
  }

  if (schemaName === "reflection_success_v1") {
    return toStrictStructuredSchemaNode({
      type: "object",
      properties: {
        lesson: STRING_SCHEMA,
        nearMiss: {
          type: ["string", "null"]
        }
      },
      required: ["lesson", "nearMiss"]
    });
  }

  if (schemaName === "governor_v1") {
    return toStrictStructuredSchemaNode({
      type: "object",
      properties: {
        approve: BOOLEAN_SCHEMA,
        reason: STRING_SCHEMA,
        confidence: NUMBER_SCHEMA
      },
      required: ["approve", "reason", "confidence"]
    });
  }

  if (schemaName === "autonomous_next_step_v1") {
    return toStrictStructuredSchemaNode({
      type: "object",
      properties: {
        isGoalMet: BOOLEAN_SCHEMA,
        nextUserInput: STRING_SCHEMA,
        reasoning: STRING_SCHEMA
      },
      required: ["isGoalMet", "nextUserInput", "reasoning"]
    });
  }

  if (schemaName === "proactive_goal_v1") {
    return toStrictStructuredSchemaNode({
      type: "object",
      properties: {
        proactiveGoal: STRING_SCHEMA,
        reasoning: STRING_SCHEMA
      },
      required: ["proactiveGoal", "reasoning"]
    });
  }

  if (schemaName === "intent_interpretation_v1") {
    return toStrictStructuredSchemaNode({
      type: "object",
      properties: {
        intentType: {
          type: "string",
          enum: ["pulse_control", "none"]
        },
        mode: {
          type: ["string", "null"],
          enum: ["on", "off", "private", "public", "status", null]
        },
        confidence: NUMBER_SCHEMA,
        rationale: STRING_SCHEMA
      },
      required: ["intentType", "mode", "confidence", "rationale"]
    });
  }

  return toStrictStructuredSchemaNode({
    type: "object",
    properties: {
      episodes: {
        type: "array",
        maxItems: 2,
        items: {
          type: "object",
          properties: {
            subjectName: STRING_SCHEMA,
            eventSummary: STRING_SCHEMA,
            supportingSnippet: STRING_SCHEMA,
            status: {
              type: "string",
              enum: [
                "unresolved",
                "partially_resolved",
                "resolved",
                "outcome_unknown",
                "no_longer_relevant"
              ]
            },
            confidence: NUMBER_SCHEMA,
            tags: STRING_ARRAY_SCHEMA
          },
          required: [
            "subjectName",
            "eventSummary",
            "supportingSnippet",
            "status",
            "confidence",
            "tags"
          ],
          additionalProperties: false
        }
      }
    },
    required: ["episodes"]
  });
}
