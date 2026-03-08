/**
 * @fileoverview Tests explicit-action intent inference and run-skill filtering directly.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  filterNonExplicitRunSkillActions,
  hasRequiredAction,
  inferRequiredActionType
} from "../../src/organs/plannerPolicy/explicitActionIntent";
import {
  MAX_FAILURE_FINGERPRINT_SEGMENT_LENGTH,
  normalizeFingerprintSegment
} from "../../src/organs/plannerPolicy/plannerFailurePolicy";

test("inferRequiredActionType recognizes explicit runtime tools and create-skill intent", () => {
  assert.equal(
    inferRequiredActionType('verify_browser url=http://localhost:3000 expect_title="Smoke"'),
    "verify_browser"
  );
  assert.equal(
    inferRequiredActionType("Create a skill called workflow_helper that validates smoke state."),
    "create_skill"
  );
});

test("filterNonExplicitRunSkillActions removes run_skill work unless the request explicitly asks for it", () => {
  const actions = [
    {
      id: "action_run_skill",
      type: "run_skill" as const,
      description: "run workflow skill",
      params: {
        name: "workflow_skill"
      },
      estimatedCostUsd: 0.05
    },
    {
      id: "action_respond",
      type: "respond" as const,
      description: "respond",
      params: {
        message: "fallback"
      },
      estimatedCostUsd: 0.01
    }
  ];

  assert.deepEqual(
    filterNonExplicitRunSkillActions(
      actions,
      "Summarize deterministic sandboxing controls rather than running a skill."
    ).map((action) => action.type),
    ["respond"]
  );
  assert.deepEqual(
    filterNonExplicitRunSkillActions(
      actions,
      "Run skill workflow_skill to capture the browser replay."
    ).map((action) => action.type),
    ["run_skill", "respond"]
  );
  assert.equal(hasRequiredAction(actions, "run_skill"), true);
});

test("normalizeFingerprintSegment lowercases, collapses whitespace, and truncates deterministically", () => {
  const noisy = `  MULTI   space ${"x".repeat(MAX_FAILURE_FINGERPRINT_SEGMENT_LENGTH + 20)}  `;
  const normalized = normalizeFingerprintSegment(noisy);

  assert.equal(normalized, normalized.toLowerCase());
  assert.ok(!/\s{2,}/.test(normalized));
  assert.ok(normalized.length <= MAX_FAILURE_FINGERPRINT_SEGMENT_LENGTH);
});
