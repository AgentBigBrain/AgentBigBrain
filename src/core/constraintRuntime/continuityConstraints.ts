import { getStringParam } from "../hardConstraintParamUtils";
import { ConstraintViolation } from "../types";

const STAGE_6_86_MEMORY_STORES = new Set(["entity_graph", "conversation_stack", "pulse_state"]);
const STAGE_6_86_MEMORY_OPERATIONS = new Set(["upsert", "merge", "supersede", "resolve", "evict"]);
const STAGE_6_86_PULSE_KINDS = new Set([
  "bridge_question",
  "open_loop_resume",
  "topic_resume",
  "stale_fact_revalidation"
]);

/**
 * Validates Stage 6.86 memory-mutation requests against the supported stores, operations, and payload shape.
 *
 * @param params - Planned memory-mutation params.
 * @returns Constraint violations for invalid memory-mutation requests.
 */
export function evaluateMemoryMutationConstraints(
  params: Record<string, unknown>
): ConstraintViolation[] {
  const violations: ConstraintViolation[] = [];
  const store = getStringParam(params, "store");
  const operation = getStringParam(params, "operation");
  const payload = params.payload;

  if (!store || !STAGE_6_86_MEMORY_STORES.has(store)) {
    violations.push({
      code: "MEMORY_MUTATION_INVALID_STORE",
      message: "Memory mutation requires a supported store (entity_graph|conversation_stack|pulse_state)."
    });
  }

  if (!operation || !STAGE_6_86_MEMORY_OPERATIONS.has(operation)) {
    violations.push({
      code: "MEMORY_MUTATION_INVALID_OPERATION",
      message: "Memory mutation requires a supported operation (upsert|merge|supersede|resolve|evict)."
    });
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    violations.push({
      code: "MEMORY_MUTATION_MISSING_PAYLOAD",
      message: "Memory mutation requires an object payload."
    });
  }

  return violations;
}

/**
 * Validates pulse-emission requests against the bounded Stage 6.86 pulse kinds.
 *
 * @param params - Planned pulse-emission params.
 * @returns Constraint violations for unsupported pulse kinds.
 */
export function evaluatePulseEmitConstraints(
  params: Record<string, unknown>
): ConstraintViolation[] {
  const kind = getStringParam(params, "kind");
  if (kind && STAGE_6_86_PULSE_KINDS.has(kind)) {
    return [];
  }

  return [
    {
      code: "PULSE_EMIT_INVALID_KIND",
      message:
        "Pulse emit requires a supported kind (bridge_question|open_loop_resume|topic_resume|stale_fact_revalidation)."
    }
  ];
}
