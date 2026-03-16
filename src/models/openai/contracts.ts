/**
 * @fileoverview Shared OpenAI model-client contracts for pricing and structured response envelopes.
 */

import type { KnownModelSchemaName } from "../schema/contracts";

export interface OpenAITokenPricing {
  inputPer1MUsd: number;
  outputPer1MUsd: number;
}

export interface OpenAIJsonSchemaContract {
  readonly type: "json_schema";
  readonly json_schema: {
    readonly name: string;
    readonly strict: true;
    readonly schema: Record<string, unknown>;
  };
}

export interface OpenAIJsonObjectContract {
  readonly type: "json_object";
}

export type OpenAIResponseFormatContract = OpenAIJsonSchemaContract | OpenAIJsonObjectContract;

export interface OpenAITextJsonSchemaContract {
  readonly type: "json_schema";
  readonly name: string;
  readonly strict: true;
  readonly schema: Record<string, unknown>;
}

export interface OpenAITextJsonObjectContract {
  readonly type: "json_object";
}

export type OpenAITextFormatContract = OpenAITextJsonSchemaContract | OpenAITextJsonObjectContract;

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
  "memory_mutation",
  "pulse_emit"
] as const;

const GOVERNOR_REJECT_CATEGORY_VALUES = [
  "ABUSE_MALWARE_OR_FRAUD",
  "SECURITY_BOUNDARY",
  "IDENTITY_INTEGRITY",
  "COMPLIANCE_POLICY",
  "RESOURCE_BUDGET",
  "RATIONALE_QUALITY",
  "UTILITY_ALIGNMENT",
  "MODEL_ADVISORY_BLOCK",
  "GOVERNOR_TIMEOUT_OR_FAILURE",
  "GOVERNOR_MALFORMED_VOTE",
  "GOVERNOR_MISSING",
  "OTHER_POLICY"
] as const;

const PLANNER_PARAMS_SCHEMA: Record<string, unknown> = {
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
        message: { type: "string" }
      },
      required: ["message"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string" }
      },
      required: ["text"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" }
      },
      required: ["path"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        content: { type: "string" }
      },
      required: ["path", "content"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        cwd: { type: "string" },
        workdir: { type: "string" },
        requestedShellKind: {
          type: "string",
          enum: ["powershell", "pwsh", "cmd", "bash", "zsh", "wsl_bash"]
        },
        timeoutMs: { type: "integer" }
      },
      required: ["command"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        leaseId: { type: "string" }
      },
      required: ["leaseId"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        host: { type: "string" },
        port: { type: "integer" },
        timeoutMs: { type: "integer" }
      },
      required: ["port"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string" },
        expectedStatus: { type: "integer" },
        timeoutMs: { type: "integer" }
      },
      required: ["url"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string" },
        expectedTitle: { type: "string" },
        expectedText: { type: "string" },
        timeoutMs: { type: "integer" }
      },
      required: ["url"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" }
      },
      required: ["name"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        code: { type: "string" }
      },
      required: ["name", "code"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        input: { type: "string" }
      },
      required: ["name", "input"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        endpoint: { type: "string" }
      },
      required: ["endpoint"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        url: { type: "string" }
      },
      required: ["url"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        sessionId: { type: "string" },
        url: { type: "string" }
      },
      required: []
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        target: { type: "string" }
      },
      required: ["target"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        actorIdentity: { type: "string" }
      },
      required: ["actorIdentity"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        speakerRole: { type: "string" }
      },
      required: ["speakerRole"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        sharePersonalData: { type: "boolean" },
        explicitHumanApproval: { type: "boolean" },
        approvalId: { type: "string" }
      },
      required: ["sharePersonalData", "explicitHumanApproval", "approvalId"]
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        impersonateHuman: { type: "boolean" }
      },
      required: ["impersonateHuman"]
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
        reasonCode: { type: "string" }
      },
      required: ["kind", "reasonCode"]
    }
  ]
};

export const OPENAI_SCHEMA_CONTRACTS: Readonly<Record<KnownModelSchemaName, Record<string, unknown>>> =
  Object.freeze({
    planner_v1: {
      type: "object",
      additionalProperties: false,
      properties: {
        plannerNotes: { type: "string" },
        actions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              type: { type: "string", enum: [...PLANNER_ACTION_TYPE_VALUES] },
              description: { type: "string" },
              params: PLANNER_PARAMS_SCHEMA
            },
            required: ["type", "description", "params"]
          }
        }
      },
      required: ["plannerNotes", "actions"]
    },
    response_v1: {
      type: "object",
      additionalProperties: false,
      properties: {
        message: { type: "string" }
      },
      required: ["message"]
    },
    reflection_v1: {
      type: "object",
      additionalProperties: false,
      properties: {
        lessons: {
          type: "array",
          items: { type: "string" }
        }
      },
      required: ["lessons"]
    },
    reflection_success_v1: {
      type: "object",
      additionalProperties: false,
      properties: {
        lesson: { type: "string" },
        nearMiss: {
          anyOf: [{ type: "string" }, { type: "null" }]
        }
      },
      required: ["lesson", "nearMiss"]
    },
    governor_v1: {
      type: "object",
      additionalProperties: false,
      properties: {
        approve: { type: "boolean" },
        reason: { type: "string" },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1
        },
        rejectCategory: {
          type: "string",
          enum: [...GOVERNOR_REJECT_CATEGORY_VALUES]
        }
      },
      required: ["approve", "reason", "confidence"]
    },
    autonomous_next_step_v1: {
      type: "object",
      additionalProperties: false,
      properties: {
        isGoalMet: { type: "boolean" },
        nextUserInput: { type: "string" },
        reasoning: { type: "string" }
      },
      required: ["isGoalMet", "nextUserInput", "reasoning"]
    },
    proactive_goal_v1: {
      type: "object",
      additionalProperties: false,
      properties: {
        proactiveGoal: { type: "string" },
        reasoning: { type: "string" }
      },
      required: ["proactiveGoal", "reasoning"]
    },
    intent_interpretation_v1: {
      type: "object",
      additionalProperties: false,
      properties: {
        intentType: { type: "string", enum: ["pulse_control", "none"] },
        mode: {
          anyOf: [
            {
              type: "string",
              enum: ["on", "off", "private", "public", "status"]
            },
            { type: "null" }
          ]
        },
        confidence: {
          type: "number",
          minimum: 0,
          maximum: 1
        },
        rationale: { type: "string" }
      },
      required: ["intentType", "mode", "confidence", "rationale"]
    },
    language_episode_extraction_v1: {
      type: "object",
      additionalProperties: false,
      properties: {
        episodes: {
          type: "array",
          maxItems: 2,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              subjectName: { type: "string" },
              eventSummary: { type: "string" },
              supportingSnippet: { type: "string" },
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
              confidence: {
                type: "number",
                minimum: 0,
                maximum: 1
              },
              tags: {
                type: "array",
                items: { type: "string" }
              }
            },
            required: [
              "subjectName",
              "eventSummary",
              "supportingSnippet",
              "status",
              "confidence",
              "tags"
            ]
          }
        }
      },
      required: ["episodes"]
    }
  });
