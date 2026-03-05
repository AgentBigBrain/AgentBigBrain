/**
 * @fileoverview Tests deterministic Stage 6.75 consistency preflight behavior for stale-state and unresolved-conflict fail-closed blocking.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateConsistencyPreflight } from "../../src/core/stage6_75ConsistencyPolicy";

test("consistency preflight blocks when unresolved conflict object exists", () => {
  const decision = evaluateConsistencyPreflight({
    nowIso: "2026-02-27T21:30:00.000Z",
    lastReadAtIso: "2026-02-27T21:29:00.000Z",
    freshnessWindowMs: 2_000,
    unresolvedConflict: {
      conflictCode: "CONFLICT_OBJECT_UNRESOLVED",
      detail: "Calendar slot overlap",
      observedAtWatermark: "2026-02-27T21:29:30.000Z"
    }
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.blockCode, "CONFLICT_OBJECT_UNRESOLVED");
});

test("consistency preflight blocks stale read watermarks and allows fresh watermarks", () => {
  const staleDecision = evaluateConsistencyPreflight({
    nowIso: "2026-02-27T21:30:00.000Z",
    lastReadAtIso: "2026-02-27T21:20:00.000Z",
    freshnessWindowMs: 2_000,
    unresolvedConflict: null
  });
  assert.equal(staleDecision.ok, false);
  assert.equal(staleDecision.blockCode, "STATE_STALE_REPLAN_REQUIRED");

  const freshDecision = evaluateConsistencyPreflight({
    nowIso: "2026-02-27T21:30:00.000Z",
    lastReadAtIso: "2026-02-27T21:29:59.000Z",
    freshnessWindowMs: 2_000,
    unresolvedConflict: null
  });
  assert.equal(freshDecision.ok, true);
  assert.equal(freshDecision.blockCode, null);
});
