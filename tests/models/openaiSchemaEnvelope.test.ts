/**
 * @fileoverview Tests canonical OpenAI schema-envelope generation for structured outputs.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { buildOpenAIResponseFormatContract } from "../../src/models/openai/schemaEnvelope";

function collectMissingAdditionalPropertiesFalsePaths(
  schemaNode: unknown,
  currentPath = "$"
): string[] {
  if (!schemaNode || typeof schemaNode !== "object" || Array.isArray(schemaNode)) {
    return [];
  }

  const node = schemaNode as Record<string, unknown>;
  const violations: string[] = [];
  if (node.type === "object" && node.additionalProperties !== false) {
    violations.push(currentPath);
  }

  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        violations.push(
          ...collectMissingAdditionalPropertiesFalsePaths(entry, `${currentPath}.${key}[${index}]`)
        );
      });
      continue;
    }

    if (value && typeof value === "object") {
      violations.push(
        ...collectMissingAdditionalPropertiesFalsePaths(value, `${currentPath}.${key}`)
      );
    }
  }

  return violations;
}

function collectMissingRequiredPropertyPaths(
  schemaNode: unknown,
  currentPath = "$"
): string[] {
  if (!schemaNode || typeof schemaNode !== "object" || Array.isArray(schemaNode)) {
    return [];
  }

  const node = schemaNode as Record<string, unknown>;
  const violations: string[] = [];
  if (
    node.type === "object" &&
    node.properties &&
    typeof node.properties === "object" &&
    !Array.isArray(node.properties)
  ) {
    const propertyKeys = Object.keys(node.properties as Record<string, unknown>);
    const requiredKeys = Array.isArray(node.required)
      ? new Set(node.required.filter((entry): entry is string => typeof entry === "string"))
      : new Set<string>();
    const missing = propertyKeys.filter((key) => !requiredKeys.has(key));
    if (missing.length > 0) {
      violations.push(`${currentPath} -> ${missing.join(",")}`);
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        violations.push(...collectMissingRequiredPropertyPaths(entry, `${currentPath}.${key}[${index}]`));
      });
      continue;
    }

    if (value && typeof value === "object") {
      violations.push(...collectMissingRequiredPropertyPaths(value, `${currentPath}.${key}`));
    }
  }

  return violations;
}

test("buildOpenAIResponseFormatContract returns strict json_schema envelopes for known schemas", () => {
  const responseFormat = buildOpenAIResponseFormatContract("planner_v1");

  assert.equal(responseFormat.type, "json_schema");
  assert.equal(responseFormat.json_schema.name, "planner_v1");
  assert.equal(responseFormat.json_schema.strict, true);
  assert.equal(typeof responseFormat.json_schema.schema, "object");
});

test("buildOpenAIResponseFormatContract falls back to json_object for unknown schemas", () => {
  assert.deepEqual(buildOpenAIResponseFormatContract("custom_schema_v1"), {
    type: "json_object"
  });
});

test("buildOpenAIResponseFormatContract enforces additionalProperties=false and required coverage", () => {
  const responseFormat = buildOpenAIResponseFormatContract("planner_v1");
  assert.equal(responseFormat.type, "json_schema");
  const schema = responseFormat.json_schema.schema;

  assert.deepEqual(collectMissingAdditionalPropertiesFalsePaths(schema), []);
  assert.deepEqual(collectMissingRequiredPropertyPaths(schema), []);
});
