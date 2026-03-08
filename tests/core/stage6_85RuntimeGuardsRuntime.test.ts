/**
 * @fileoverview Tests canonical Stage 6.85 runtime-guard helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateStage685RuntimeGuard } from "../../src/core/stage6_85/runtimeGuards";

test("stage6_85 runtime guards preserve deterministic resume-safety enforcement", () => {
  const result = evaluateStage685RuntimeGuard({
    type: "write_file",
    params: {
      approvalUses: 2,
      approvalMaxUses: 2,
      freshnessValid: true,
      diffHashMatches: false
    }
  } as never);

  assert.equal(result?.violation.code, "APPROVAL_MAX_USES_EXCEEDED");
  assert.equal(result?.conflictCode, null);
});

test("stage6_85 runtime guards preserve deterministic workflow replay enforcement", () => {
  const result = evaluateStage685RuntimeGuard({
    type: "run_skill",
    params: {
      actionFamily: "computer_use",
      operation: "replay_step",
      schemaSupported: true,
      windowFocused: true,
      navigationMatches: true,
      selectorFound: false,
      assertionPassed: true
    }
  } as never);

  assert.equal(result?.violation.code, "WORKFLOW_DRIFT_DETECTED");
  assert.equal(result?.conflictCode, "SELECTOR_NOT_FOUND");
});
