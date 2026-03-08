/**
 * @fileoverview Tests thin compatibility exports for Stage 6.85 runtime guards.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateStage685RuntimeGuard } from "../../src/core/stage6_85RuntimeGuards";

test("stage6_85 runtime guard policy preserves fail-closed resume safety decisions", () => {
  const result = evaluateStage685RuntimeGuard({
    type: "write_file",
    params: {
      approvalUses: 1,
      approvalMaxUses: 1,
      freshnessValid: false,
      diffHashMatches: true
    }
  } as never);

  assert.equal(result?.violation.code, "APPROVAL_MAX_USES_EXCEEDED");
  assert.equal(result?.conflictCode, null);
});
