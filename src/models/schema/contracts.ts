/**
 * @fileoverview Canonical schema-layer contracts for model-client output normalization and validation.
 */

export const KNOWN_MODEL_SCHEMA_NAMES = [
  "planner_v1",
  "response_v1",
  "reflection_v1",
  "reflection_success_v1",
  "governor_v1",
  "autonomous_next_step_v1",
  "proactive_goal_v1",
  "intent_interpretation_v1"
] as const;

export type KnownModelSchemaName = typeof KNOWN_MODEL_SCHEMA_NAMES[number];

/**
 * Returns `true` when a schema name matches the canonical structured-model schema set.
 *
 * @param value - Candidate schema name.
 * @returns `true` when the schema name is canonical to the schema subsystem.
 */
export function isKnownModelSchemaName(value: string): value is KnownModelSchemaName {
  return (KNOWN_MODEL_SCHEMA_NAMES as readonly string[]).includes(value);
}
