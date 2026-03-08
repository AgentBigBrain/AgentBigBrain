/**
 * @fileoverview Canonical OpenAI structured-output schema envelope builder.
 */

import {
  OPENAI_SCHEMA_CONTRACTS
} from "./contracts";
import type { OpenAIResponseFormatContract } from "./contracts";

/**
 * Sanitizes schema names for OpenAI `response_format.json_schema.name` constraints.
 *
 * @param schemaName - Internal schema id requested by the caller.
 * @returns Provider-safe schema name.
 */
function sanitizeSchemaContractName(schemaName: string): string {
  const normalized = schemaName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return normalized.length > 0 ? normalized : "schema_contract";
}

/**
 * Returns `true` when a schema node already permits `null`.
 *
 * @param schemaNode - Raw JSON-schema node.
 * @returns `true` when the node already allows `null`.
 */
function schemaAllowsNull(schemaNode: unknown): boolean {
  if (!schemaNode || typeof schemaNode !== "object" || Array.isArray(schemaNode)) {
    return false;
  }

  const node = schemaNode as Record<string, unknown>;
  if (node.type === "null") {
    return true;
  }

  if (Array.isArray(node.anyOf)) {
    return node.anyOf.some((entry) => schemaAllowsNull(entry));
  }

  if (Array.isArray(node.enum)) {
    return node.enum.includes(null);
  }

  return false;
}

/**
 * Converts a logical JSON-schema tree into OpenAI strict-mode form.
 *
 * @param schemaNode - Raw logical JSON-schema node.
 * @returns Provider-safe JSON-schema node for OpenAI strict mode.
 */
function toOpenAIStrictSchemaNode(schemaNode: unknown): unknown {
  if (Array.isArray(schemaNode)) {
    return schemaNode.map((entry) => toOpenAIStrictSchemaNode(entry));
  }

  if (!schemaNode || typeof schemaNode !== "object") {
    return schemaNode;
  }

  const node = schemaNode as Record<string, unknown>;
  const transformed: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const propertyEntries = Object.entries(value as Record<string, unknown>);
      const currentRequired = new Set(
        Array.isArray(node.required)
          ? node.required.filter((entry): entry is string => typeof entry === "string")
          : []
      );
      const strictProperties: Record<string, unknown> = {};

      for (const [propertyKey, propertySchema] of propertyEntries) {
        const strictPropertySchema = toOpenAIStrictSchemaNode(propertySchema);
        strictProperties[propertyKey] =
          currentRequired.has(propertyKey) || schemaAllowsNull(strictPropertySchema)
            ? strictPropertySchema
            : {
                anyOf: [strictPropertySchema, { type: "null" }]
              };
      }

      transformed.properties = strictProperties;
      transformed.required = propertyEntries.map(([propertyKey]) => propertyKey);
      continue;
    }

    if (key === "required") {
      continue;
    }

    if (Array.isArray(value)) {
      transformed[key] = value.map((entry) => toOpenAIStrictSchemaNode(entry));
      continue;
    }

    if (value && typeof value === "object") {
      transformed[key] = toOpenAIStrictSchemaNode(value);
      continue;
    }

    transformed[key] = value;
  }

  if (transformed.type === "object") {
    transformed.additionalProperties = false;
    if (!Object.prototype.hasOwnProperty.call(transformed, "required")) {
      transformed.required = [];
    }
  }

  return transformed;
}

/**
 * Builds the provider `response_format` contract for a known schema.
 *
 * @param schemaName - Requested logical schema name.
 * @returns OpenAI response-format contract used in the chat completion request body.
 */
export function buildOpenAIResponseFormatContract(schemaName: string): OpenAIResponseFormatContract {
  const contractSchema = OPENAI_SCHEMA_CONTRACTS[schemaName as keyof typeof OPENAI_SCHEMA_CONTRACTS];
  if (!contractSchema) {
    return { type: "json_object" };
  }

  return {
    type: "json_schema",
    json_schema: {
      name: sanitizeSchemaContractName(schemaName),
      strict: true,
      schema: toOpenAIStrictSchemaNode(contractSchema) as Record<string, unknown>
    }
  };
}
