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
          anyOf?: Array<{
            additionalProperties?: boolean;
            required?: string[];
            properties?: {
              type?: {
                enum?: string[];
              };
              params?: {
                anyOf?: Array<{
                  type?: string;
                  additionalProperties?: boolean;
                  properties?: Record<string, unknown>;
                  required?: string[];
                }>;
                type?: string;
                additionalProperties?: boolean;
                properties?: Record<string, unknown>;
                required?: string[];
              };
            };
          }>;
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
  const actionBranches = schema.properties?.actions?.items?.anyOf ?? [];
  assert.ok(actionBranches.length > 0);
  assert.equal(
    actionBranches.every(
      (entry) =>
        entry.additionalProperties === false &&
        entry.required?.includes("type") &&
        entry.required?.includes("description") &&
        entry.required?.includes("params")
    ),
    true
  );

  const findActionBranch = (type: string) => actionBranches.find((entry) =>
    entry.properties?.type?.enum?.includes(type)
  );
  const writeFileParams = findActionBranch("write_file")?.properties?.params;
  assert.deepEqual(writeFileParams?.required, ["path", "content"]);
  assert.deepEqual(Object.keys(writeFileParams?.properties ?? {}).sort(), ["content", "path"]);

  const networkWriteParams = findActionBranch("network_write")?.properties?.params;
  assert.equal(Array.isArray(networkWriteParams?.anyOf), true);
  assert.equal(
    networkWriteParams?.anyOf?.some((entry) =>
      Boolean(entry.properties?.endpoint) && !Boolean(entry.properties?.path)
    ),
    true
  );
  assert.equal(
    networkWriteParams?.anyOf?.some((entry) => Boolean(entry.properties?.path)),
    false
  );
});
