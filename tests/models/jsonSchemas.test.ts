/**
 * @fileoverview Guards strict JSON Schema contracts used by non-OpenAI structured backends.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildJsonSchemaForKnownModelSchema } from "../../src/models/schema/jsonSchemas";

test("buildJsonSchemaForKnownModelSchema emits a strict planner schema for Codex-style structured output", () => {
  const schema = buildJsonSchemaForKnownModelSchema("planner_v1") as {
    type?: string;
    additionalProperties?: boolean;
    properties?: {
      actions?: {
        type?: string;
        items?: {
          additionalProperties?: boolean;
          required?: string[];
          properties?: {
            params?: {
              anyOf?: Array<{
                type?: string;
                additionalProperties?: boolean;
              }>;
            };
          };
        };
      };
    };
  };

  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties?.actions?.type, "array");
  assert.equal(schema.properties?.actions?.items?.additionalProperties, false);
  assert.deepEqual(schema.properties?.actions?.items?.required, [
    "type",
    "description",
    "params"
  ]);
  assert.equal(
    schema.properties?.actions?.items?.properties?.params?.anyOf?.every(
      (entry) => entry.type === "object" && entry.additionalProperties === false
    ),
    true
  );
});
