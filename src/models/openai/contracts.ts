/**
 * @fileoverview Shared OpenAI model-client contracts for pricing and structured response envelopes.
 */

import type { KnownModelSchemaName } from "../schema/contracts";
import { buildPlannerActionSchemaNode } from "../../core/actionDefinitionRegistry";

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

export const OPENAI_SCHEMA_CONTRACTS: Readonly<Record<KnownModelSchemaName, Record<string, unknown>>> =
  Object.freeze({
    planner_v1: {
      type: "object",
      additionalProperties: false,
      properties: {
        plannerNotes: { type: "string" },
        actions: {
          type: "array",
          items: buildPlannerActionSchemaNode()
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
