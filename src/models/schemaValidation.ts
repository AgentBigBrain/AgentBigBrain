/**
 * @fileoverview Stable compatibility entrypoint for canonical schema-runtime validation helpers.
 */

export type {
  KnownModelSchemaName
} from "./schema/contracts";
export {
  isKnownModelSchemaName,
  KNOWN_MODEL_SCHEMA_NAMES
} from "./schema/contracts";
export {
  normalizeStructuredModelOutput,
  validateStructuredModelOutput
} from "./schema/validation";
