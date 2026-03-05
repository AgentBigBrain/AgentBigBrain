/**
 * @fileoverview Deterministic Stage 6.75 stale-state and conflict gating helpers for write preflight checks.
 */

import {
  ConflictObjectV1,
  Stage675BlockCode
} from "./types";

export interface ConsistencyPreflightInput {
  nowIso: string;
  lastReadAtIso: string | null;
  freshnessWindowMs: number;
  unresolvedConflict: ConflictObjectV1 | null;
}

export interface ConsistencyDecision {
  ok: boolean;
  blockCode: Stage675BlockCode | null;
  reason: string;
}

/**
 * Evaluates consistency preflight and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the consistency preflight policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `ConsistencyDecision` result.
 */
export function evaluateConsistencyPreflight(
  input: ConsistencyPreflightInput
): ConsistencyDecision {
  if (input.unresolvedConflict) {
    return {
      ok: false,
      blockCode: "CONFLICT_OBJECT_UNRESOLVED",
      reason: "Write path blocked because conflict object is unresolved."
    };
  }
  if (!input.lastReadAtIso) {
    return {
      ok: false,
      blockCode: "STATE_STALE_REPLAN_REQUIRED",
      reason: "Write path requires a fresh read before execution."
    };
  }

  const nowMs = Date.parse(input.nowIso);
  const lastReadMs = Date.parse(input.lastReadAtIso);
  if (!Number.isFinite(nowMs) || !Number.isFinite(lastReadMs)) {
    return {
      ok: false,
      blockCode: "STATE_STALE_REPLAN_REQUIRED",
      reason: "Invalid watermark timestamps prevent deterministic freshness evaluation."
    };
  }

  if (nowMs - lastReadMs > input.freshnessWindowMs) {
    return {
      ok: false,
      blockCode: "STATE_STALE_REPLAN_REQUIRED",
      reason: "Read watermark is stale and requires deterministic re-read."
    };
  }

  return {
    ok: true,
    blockCode: null,
    reason: "State consistency preflight passed."
  };
}
