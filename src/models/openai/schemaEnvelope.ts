/**
 * @fileoverview Canonical OpenAI structured-output schema envelope builder.
 */

import {
  OPENAI_SCHEMA_CONTRACTS
} from "./contracts";
import type { OpenAIResponseFormatContract, OpenAITextFormatContract } from "./contracts";

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
 * **Why it exists:**
 * Chat Completions requires provider-safe structured-output contracts, and the schema envelope must
 * stay canonical so every caller emits the same strict JSON schema for known runtime schemas.
 *
 * **What it talks to:**
 * - Uses `OPENAI_SCHEMA_CONTRACTS` (import `OPENAI_SCHEMA_CONTRACTS`) from `./contracts`.
 * - Uses local constants/helpers within this module.
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

/**
 * Builds a canonical JSON-object response-format contract.
 *
 * **Why it exists:**
 * Compatibility fallback and unknown-schema handling both need one stable JSON-object contract
 * instead of re-creating ad hoc `{ type: "json_object" }` objects at each call site.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param _schemaName - Unused schema identifier retained for call-site symmetry.
 * @returns OpenAI JSON-object response format contract.
 */
export function buildOpenAIJsonObjectContract(
  _schemaName?: string
): OpenAIResponseFormatContract {
  return { type: "json_object" };
}

/**
 * Builds a canonical JSON-object text-format contract for the Responses API.
 *
 * @returns OpenAI JSON-object text format contract.
 */
export function buildOpenAITextJsonObjectContract(): OpenAITextFormatContract {
  return { type: "json_object" };
}

/**
 * Builds the provider `text.format` contract for the Responses API.
 *
 * **Why it exists:**
 * The Responses API moves structured output under `text.format`, but the runtime should still reuse
 * the same schema-envelope ownership as the Chat Completions path.
 *
 * **What it talks to:**
 * - Uses `buildOpenAIResponseFormatContract` from this module.
 *
 * @param schemaName - Requested logical schema name.
 * @returns OpenAI text-format contract used in the Responses request body.
 */
export function buildOpenAITextFormatContract(schemaName: string): OpenAITextFormatContract {
  const contractSchema = OPENAI_SCHEMA_CONTRACTS[schemaName as keyof typeof OPENAI_SCHEMA_CONTRACTS];
  if (!contractSchema) {
    return { type: "json_object" };
  }

  return {
    type: "json_schema",
    name: sanitizeSchemaContractName(schemaName),
    strict: true,
    schema: toOpenAIStrictSchemaNode(contractSchema) as Record<string, unknown>
  };
}
