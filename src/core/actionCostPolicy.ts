/**
 * @fileoverview Defines deterministic, system-owned action cost estimation for budgeting and safety gating.
 */

import { ActionType, PlannedAction } from "./types";

const BASE_ACTION_COST_USD: Record<ActionType, number> = {
  respond: 0.02,
  read_file: 0.05,
  write_file: 0.08,
  delete_file: 0.35,
  list_directory: 0.06,
  create_skill: 0.22,
  run_skill: 0.1,
  network_write: 0.15,
  self_modify: 0.2,
  shell_command: 0.25,
  start_process: 0.28,
  check_process: 0.04,
  stop_process: 0.12,
  probe_port: 0.03,
  probe_http: 0.04,
  verify_browser: 0.09,
  memory_mutation: 0.08,
  pulse_emit: 0.04
};

const PAYLOAD_SURCHARGE_PER_UNIT_USD: Record<ActionType, number> = {
  respond: 0.02,
  read_file: 0.01,
  write_file: 0.08,
  delete_file: 0.01,
  list_directory: 0.01,
  create_skill: 0.1,
  run_skill: 0.06,
  network_write: 0.06,
  self_modify: 0.08,
  shell_command: 0.08,
  start_process: 0.06,
  check_process: 0.02,
  stop_process: 0.02,
  probe_port: 0.01,
  probe_http: 0.02,
  verify_browser: 0.04,
  memory_mutation: 0.04,
  pulse_emit: 0.02
};

const PAYLOAD_UNIT_SIZE_CHARS = 1_500;
const MAX_PAYLOAD_SURCHARGE_USD = 1.5;

/**
 * Safely serializes unknown payloads into JSON text.
 *
 * **Why it exists:**
 * Cost policy must never throw while estimating payload size. Some runtime params can contain
 * circular references or non-serializable values, so this helper fail-closes to empty text.
 *
 * **What it talks to:**
 * - Uses native `JSON.stringify`.
 *
 * @param input - Arbitrary action params payload.
 * @returns Serialized payload text or an empty string on serialization failure.
 */
function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return "";
  }
}

/**
 * Normalizes a USD amount into deterministic non-negative fixed precision.
 *
 * **Why it exists:**
 * Budget checks and traces need stable numeric formatting. This helper prevents negative drift and
 * normalizes precision so downstream comparisons are reproducible.
 *
 * **What it talks to:**
 * - Uses `Math.max` and `Number.toFixed`.
 *
 * @param value - Raw cost value candidate.
 * @returns Non-negative USD value rounded to four decimal places.
 */
function normalizeUsd(value: number): number {
  return Number(Math.max(0, value).toFixed(4));
}

/**
 * Computes payload surcharge units from serialized action params size.
 *
 * **Why it exists:**
 * Larger payloads increase execution complexity and risk. This helper applies a deterministic
 * size-based unit model while exempting the first base unit.
 *
 * **What it talks to:**
 * - Calls `safeStringify` for serialization-safe character counting.
 * - Uses policy constants `PAYLOAD_UNIT_SIZE_CHARS`.
 *
 * @param params - Action params object used for cost estimation.
 * @returns Number of surcharge units above the base payload allowance.
 */
function estimatePayloadUnits(params: Record<string, unknown>): number {
  const payloadChars = safeStringify(params).length;
  if (payloadChars <= PAYLOAD_UNIT_SIZE_CHARS) {
    return 0;
  }

  return Math.max(0, Math.ceil(payloadChars / PAYLOAD_UNIT_SIZE_CHARS) - 1);
}

/**
 * Estimates deterministic action cost in USD from type + payload size.
 *
 * **Why it exists:**
 * Cost policy is system-owned and must not rely on model-reported estimates. This function provides
 * a stable source of truth for hard-constraint budget checks and runtime accounting.
 *
 * **What it talks to:**
 * - Reads base/surcharge tables (`BASE_ACTION_COST_USD`, `PAYLOAD_SURCHARGE_PER_UNIT_USD`).
 * - Calls `estimatePayloadUnits` for payload-based surcharge.
 * - Calls `normalizeUsd` before returning.
 *
 * @param action - Minimal action shape containing `type` and `params`.
 * @returns Deterministic USD estimate with capped payload surcharge.
 */
export function estimateActionCostUsd(action: Pick<PlannedAction, "type" | "params">): number {
  const base = BASE_ACTION_COST_USD[action.type] ?? 0.1;
  const units = estimatePayloadUnits(action.params ?? {});
  const surchargePerUnit = PAYLOAD_SURCHARGE_PER_UNIT_USD[action.type] ?? 0.02;
  const payloadSurcharge = Math.min(MAX_PAYLOAD_SURCHARGE_USD, units * surchargePerUnit);
  return normalizeUsd(base + payloadSurcharge);
}

/**
 * Returns the deterministic base cost for an action type (without payload surcharge).
 *
 * **Why it exists:**
 * Some runtime paths need quick baseline cost lookup before param inspection. This helper exposes
 * that canonical base rate with stable formatting.
 *
 * **What it talks to:**
 * - Reads `BASE_ACTION_COST_USD`.
 * - Calls `normalizeUsd` for stable numeric output.
 *
 * @param type - Action type enum value.
 * @returns Base USD estimate for the action family.
 */
export function estimateActionTypeBaseCostUsd(type: ActionType): number {
  return normalizeUsd(BASE_ACTION_COST_USD[type] ?? 0.1);
}
