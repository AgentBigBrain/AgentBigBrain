/**
 * @fileoverview Verifies canonical schema-runtime validation and normalization helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isKnownModelSchemaName,
  KNOWN_MODEL_SCHEMA_NAMES
} from "../../src/models/schema/contracts";
import {
  normalizeStructuredModelOutput,
  validateStructuredModelOutput
} from "../../src/models/schema/validation";
import * as schemaValidationShim from "../../src/models/schemaValidation";

test("schema-runtime contracts expose the canonical known schema names", () => {
  assert.equal(isKnownModelSchemaName("planner_v1"), true);
  assert.equal(isKnownModelSchemaName("unknown_schema"), false);
  assert.deepEqual(KNOWN_MODEL_SCHEMA_NAMES, [
    "planner_v1",
    "response_v1",
    "reflection_v1",
    "reflection_success_v1",
    "governor_v1",
    "autonomous_next_step_v1",
    "proactive_goal_v1",
    "intent_interpretation_v1",
    "language_episode_extraction_v1"
  ]);
});

test("normalizeStructuredModelOutput canonicalizes planner action aliases in the schema subsystem", () => {
  const normalized = normalizeStructuredModelOutput("planner_v1", {
    notes: "plan",
    actions: [
      {
        tool: "read",
        params: {
          path: "README.md"
        }
      }
    ]
  }) as Record<string, unknown>;

  assert.equal(normalized.plannerNotes, "plan");
  assert.deepEqual(normalized.actions, [
    {
      type: "read_file",
      description: "Read file contents needed for the task.",
      params: {
        path: "README.md"
      }
    }
  ]);
});

test("validateStructuredModelOutput fails closed on malformed planner payloads", () => {
  assert.throws(
    () =>
      validateStructuredModelOutput("planner_v1", {
        plannerNotes: "plan",
        actions: [
          {
            type: "not_real",
            description: "bad"
          }
        ]
      }),
    /failed planner_v1 validation/i
  );
});

test("schemaValidation shim re-exports the canonical schema-runtime helpers", () => {
  assert.equal(schemaValidationShim.isKnownModelSchemaName("response_v1"), true);
  const normalized = schemaValidationShim.normalizeStructuredModelOutput("response_v1", {
    message: "ok"
  });
  assert.deepEqual(normalized, { message: "ok" });
  assert.doesNotThrow(() =>
    schemaValidationShim.validateStructuredModelOutput("response_v1", { message: "ok" })
  );
});

test("validateStructuredModelOutput accepts bounded language episode extraction payloads", () => {
  assert.doesNotThrow(() =>
    validateStructuredModelOutput("language_episode_extraction_v1", {
      episodes: [
        {
          subjectName: "Owen",
          eventSummary: "had a medical situation",
          supportingSnippet: "Owen had a scare at the hospital and we still do not know what happened.",
          status: "unresolved",
          confidence: 0.82,
          tags: ["medical", "followup"]
        }
      ]
    })
  );
});
