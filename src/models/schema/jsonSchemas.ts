/**
 * @fileoverview Canonical JSON Schema builders for model backends that support schema files.
 */

import type { KnownModelSchemaName } from "./contracts";
import { buildPlannerActionSchemaNode } from "../../core/actionDefinitionRegistry";
import { toStrictStructuredSchemaNode } from "./strictStructuredSchema";

const STRING_SCHEMA = { type: "string" } as const;
const NUMBER_SCHEMA = { type: "number" } as const;
const BOOLEAN_SCHEMA = { type: "boolean" } as const;
const STRING_ARRAY_SCHEMA = {
  type: "array",
  items: STRING_SCHEMA
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
          items: buildPlannerActionSchemaNode()
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
