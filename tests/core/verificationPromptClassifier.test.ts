/**
 * @fileoverview Regression tests for deterministic verification prompt classification helpers.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  isVerificationClaimPrompt,
  resolveVerificationCategoryFromPrompt
} from "../../src/core/verificationPromptClassifier";

test("isVerificationClaimPrompt detects done-claim proof prompts", () => {
  assert.equal(
    isVerificationClaimPrompt("claim complete only if deterministic proof artifacts exist"),
    true
  );
  assert.equal(isVerificationClaimPrompt("just summarize this conversation"), false);
});

test("resolveVerificationCategoryFromPrompt classifies build/research/workflow/communication", () => {
  assert.equal(resolveVerificationCategoryFromPrompt("build a scaffold and run tests"), "build");
  assert.equal(resolveVerificationCategoryFromPrompt("provide research findings with sources"), "research");
  assert.equal(resolveVerificationCategoryFromPrompt("capture workflow replay selector drift"), "workflow_replay");
  assert.equal(resolveVerificationCategoryFromPrompt("send a normal response"), "communication");
});
