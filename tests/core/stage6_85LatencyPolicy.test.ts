/**
 * @fileoverview Tests deterministic Stage 6.85 latency policy for phase budgets, cache-baseline equivalence, and reject-summary normalization.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildDeterministicRejectSummary,
  evaluateCacheBaselineEquivalence,
  evaluatePhaseLatencies,
  resolveDefaultLatencyBudgetsMs
} from "../../src/core/stage6_85LatencyPolicy";

/**
 * Implements `evaluatesLatencyBudgetsPerMissionPhase` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function evaluatesLatencyBudgetsPerMissionPhase(): void {
  const budgets = resolveDefaultLatencyBudgetsMs();
  const passing = evaluatePhaseLatencies({
    budgetsMs: budgets,
    observedMs: {
      planning: 7_000,
      vote_collection: 2_000,
      execution: 9_000,
      response_rendering: 1_000
    }
  });
  assert.equal(passing.overallPass, true);

  const failing = evaluatePhaseLatencies({
    budgetsMs: budgets,
    observedMs: {
      planning: 9_000,
      vote_collection: 2_000,
      execution: 9_000,
      response_rendering: 1_000
    }
  });
  assert.equal(failing.overallPass, false);
  assert.equal(failing.evaluations[0]?.passed, false);
}

/**
 * Implements `enforcesCacheBaselineEquivalenceFailClosed` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function enforcesCacheBaselineEquivalenceFailClosed(): void {
  const pass = evaluateCacheBaselineEquivalence({
    baselineModelCalls: 4,
    cachedModelCalls: 3
  });
  assert.equal(pass.passed, true);

  const fail = evaluateCacheBaselineEquivalence({
    baselineModelCalls: 4,
    cachedModelCalls: 5
  });
  assert.equal(fail.passed, false);
}

/**
 * Implements `normalizesRejectSummariesDeterministically` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function normalizesRejectSummariesDeterministically(): void {
  const summary = buildDeterministicRejectSummary([
    "budget exceeded",
    "policy denied",
    "budget exceeded"
  ]);
  assert.equal(summary, "budget exceeded | policy denied");
}

test(
  "stage 6.85 latency policy evaluates per-phase mission latency budgets deterministically",
  evaluatesLatencyBudgetsPerMissionPhase
);
test(
  "stage 6.85 latency policy enforces cache baseline-equivalence fail-closed",
  enforcesCacheBaselineEquivalenceFailClosed
);
test(
  "stage 6.85 latency policy emits deterministic reject summaries",
  normalizesRejectSummariesDeterministically
);
