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

test("stage 6.85 playbook intent does not select build tags for planning-only build wording", () => {
  const planningOnlyIntent = deriveRequestedPlaybookIntent(
    "Please plan a calm air-sample landing page in three concise steps. Do not build anything yet."
  );

  assert.deepEqual(planningOnlyIntent.requestedTags, []);
  assert.equal(planningOnlyIntent.requiredInputSchema, "unknown_input_schema");
});

test("stage 6.85 playbook intent leaves adaptable site and test guidance to Markdown skills", () => {
  const staticSiteIntent = deriveRequestedPlaybookIntent(
    "Build a polished static HTML creative agency site with three pages and placeholder images."
  );
  const testGuidanceIntent = deriveRequestedPlaybookIntent(
    "Add tests for this component and explain the tradeoffs."
  );
  const sourceListIntent = deriveRequestedPlaybookIntent(
    "List the sources you would check before making this decision."
  );

  assert.deepEqual(staticSiteIntent.requestedTags, []);
  assert.equal(staticSiteIntent.requiredInputSchema, "unknown_input_schema");
  assert.deepEqual(testGuidanceIntent.requestedTags, []);
  assert.equal(testGuidanceIntent.requiredInputSchema, "unknown_input_schema");
  assert.deepEqual(sourceListIntent.requestedTags, []);
  assert.equal(sourceListIntent.requiredInputSchema, "unknown_input_schema");
});

test("stage 6.85 playbook intent keeps strict schema-backed playbook contracts", () => {
  const cliIntent = deriveRequestedPlaybookIntent(
    "Build and test a deterministic TypeScript CLI scaffold with a README and verification runbook."
  );
  const researchIntent = deriveRequestedPlaybookIntent(
    "Research deterministic sandboxing controls and provide distilled findings with proof refs."
  );
  const workflowIntent = deriveRequestedPlaybookIntent(
    "Capture this browser workflow, compile replay steps, and block if selector drift appears."
  );

  assert.deepEqual(cliIntent.requestedTags, ["build", "cli", "verify"]);
  assert.equal(cliIntent.requiredInputSchema, "build_cli_v1");
  assert.deepEqual(researchIntent.requestedTags, ["research", "security"]);
  assert.equal(researchIntent.requiredInputSchema, "research_v1");
  assert.deepEqual(workflowIntent.requestedTags, ["computer_use", "replay", "workflow"]);
  assert.equal(workflowIntent.requiredInputSchema, "workflow_replay_v1");
});
