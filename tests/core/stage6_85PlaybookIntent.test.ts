/**
 * @fileoverview Tests canonical Stage 6.85 playbook-intent helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  deriveRequestedPlaybookIntent,
  extractCurrentRequestForPlaybookIntent
} from "../../src/core/stage6_85/playbookIntent";

test("stage 6.85 playbook intent extracts the current request from structured prompt scaffolds", () => {
  const wrappedInput = [
    "Recent conversation context (oldest to newest):",
    "- user: Build a deterministic TypeScript CLI scaffold with README and tests.",
    "- assistant: I will proceed with the deterministic build workflow.",
    "Current user request:",
    "Research deterministic sandboxing controls and provide distilled findings with proof refs."
  ].join("\n");

  assert.equal(
    extractCurrentRequestForPlaybookIntent(wrappedInput),
    "Research deterministic sandboxing controls and provide distilled findings with proof refs."
  );
});

test("stage 6.85 playbook intent derives deterministic tags and schema gates", () => {
  const workflowIntent = deriveRequestedPlaybookIntent(
    "Capture this browser workflow, compile replay steps, and block if selector drift appears."
  );
  assert.deepEqual(workflowIntent.requestedTags, ["computer_use", "replay", "workflow"]);
  assert.equal(workflowIntent.requiredInputSchema, "workflow_replay_v1");

  const unmatchedIntent = deriveRequestedPlaybookIntent(
    "Explain why this unfamiliar request cannot use a playbook."
  );
  assert.deepEqual(unmatchedIntent.requestedTags, []);
  assert.equal(unmatchedIntent.requiredInputSchema, "unknown_input_schema");
});
