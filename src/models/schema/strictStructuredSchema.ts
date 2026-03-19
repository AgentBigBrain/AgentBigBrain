/**
 * @fileoverview Converts canonical JSON Schema nodes into the stricter closed-object subset used
 * by structured-output backends like Codex.
 */

/**
 * Evaluates whether one schema node already allows `null`.
 *
 * @param schemaNode - Candidate JSON schema node.
 * @returns `true` when the node allows `null` directly or through a supported union form.
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
 * Converts a canonical schema node into the stricter structured-output subset required by provider
 * transports that mandate closed object shapes.
 *
 * @param schemaNode - Candidate canonical schema node.
 * @returns Strict structured-schema representation with closed object properties.
 */
export function toStrictStructuredSchemaNode(schemaNode: unknown): unknown {
  if (Array.isArray(schemaNode)) {
    return schemaNode.map((entry) => toStrictStructuredSchemaNode(entry));
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
        const strictPropertySchema = toStrictStructuredSchemaNode(propertySchema);
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
      transformed[key] = value.map((entry) => toStrictStructuredSchemaNode(entry));
      continue;
    }

    if (value && typeof value === "object") {
      transformed[key] = toStrictStructuredSchemaNode(value);
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
