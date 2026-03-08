/**
 * @fileoverview Tests governance-driven replan helpers extracted into the orchestration subsystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildGovernanceReplanInput,
  extractGovernanceReplanFeedback
} from "../../src/core/orchestration/orchestratorGovernance";

const BASE_ACTION = {
  id: "action_orchestrator_governance_1",
  type: "write_file" as const,
  description: "write a file",
  params: {
    path: "C:\\temp\\file.txt",
    content: "hello"
  },
  estimatedCostUsd: 0.08
};

test("extractGovernanceReplanFeedback returns null once an attempt has any approved action", () => {
  const feedback = extractGovernanceReplanFeedback([
    {
      action: BASE_ACTION,
      mode: "fast_path",
      approved: true,
      blockedBy: [],
      violations: [],
      votes: []
    }
  ]);

  assert.equal(feedback, null);
});

test("extractGovernanceReplanFeedback summarizes non-approving governor votes", () => {
  const feedback = extractGovernanceReplanFeedback([
    {
      action: BASE_ACTION,
      mode: "escalation_path",
      approved: false,
      blockedBy: [],
      violations: [],
      votes: [
        {
          governorId: "safety",
          approve: false,
          reason: "Path is outside allowed workspace.",
          confidence: 1
        },
        {
          governorId: "utility",
          approve: false,
          reason: "Does not satisfy the user request.",
          confidence: 0.8
        }
      ]
    }
  ]);

  assert.equal(
    feedback,
    "write_file: safety: Path is outside allowed workspace. | utility: Does not satisfy the user request."
  );
});

test("buildGovernanceReplanInput preserves the original user request and injects attempt guidance", () => {
  const prompt = buildGovernanceReplanInput(
    "Create the file and verify it.",
    "write_file: safety: Path is outside allowed workspace.",
    3
  );

  assert.match(prompt, /^Create the file and verify it\./);
  assert.match(prompt, /Replan Attempt 3: the prior plan was blocked by governance\./);
  assert.match(prompt, /Governance feedback:\nwrite_file: safety: Path is outside allowed workspace\./);
});
