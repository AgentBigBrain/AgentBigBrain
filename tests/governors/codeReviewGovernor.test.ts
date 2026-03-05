/**
 * @fileoverview Unit tests for the CodeReviewGovernor, ensuring it blocks malicious dynamic skills.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { GovernanceProposal } from "../../src/core/types";
import { codeReviewGovernor } from "../../src/governors/codeReviewGovernor";
import { GovernorContext } from "../../src/governors/types";
import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { MockModelClient } from "../../src/models/mockModelClient";

/**
 * Implements `buildContext` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildContext(): GovernorContext {
  return {
    task: { id: "test", goal: "test", userInput: "test", createdAt: new Date().toISOString() },
    config: DEFAULT_BRAIN_CONFIG,
    state: {
      createdAt: new Date().toISOString(),
      runs: [],
      metrics: {
        totalTasks: 0,
        totalActions: 0,
        approvedActions: 0,
        blockedActions: 0,
        fastPathActions: 0,
        escalationActions: 0
      }
    },
    governanceMemory: {
      generatedAt: new Date().toISOString(),
      totalEvents: 0,
      recentEvents: [],
      recentBlockCounts: {
        constraints: 0,
        governance: 0,
        runtime: 0
      },
      recentGovernorRejectCounts: {}
    },
    model: "test-model",
    modelClient: new MockModelClient()
  };
}

/**
 * Implements `buildProposal` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildProposal(code: string): GovernanceProposal {
  return {
    id: "prop-1",
    taskId: "task-1",
    requestedBy: "planner",
    rationale: "Testing",
    touchesImmutable: false,
    action: {
      id: "action-1",
      type: "create_skill",
      description: "Create a test skill",
      estimatedCostUsd: 0.1,
      params: { name: "test_skill", code }
    }
  };
}

test("CodeReviewGovernor allows clean code", async () => {
  const proposal = buildProposal(`
        export function doMath(a: number, b: number) {
            return a + b;
        }
    `);
  const vote = await codeReviewGovernor.evaluate(proposal, buildContext());
  assert.equal(vote.approve, true);
});

test("CodeReviewGovernor blocks eval()", async () => {
  const proposal = buildProposal(`
        const x = eval("2 + 2");
    `);
  const vote = await codeReviewGovernor.evaluate(proposal, buildContext());
  assert.equal(vote.approve, false);
});

test("CodeReviewGovernor blocks imports from core/", async () => {
  const proposal = buildProposal(`
        import { BrainOrchestrator } from "../core/orchestrator";
    `);
  const vote = await codeReviewGovernor.evaluate(proposal, buildContext());
  assert.equal(vote.approve, false);
});

test("CodeReviewGovernor blocks child_process access", async () => {
  const proposal = buildProposal(`
        import { exec } from "child_process";
        export const run = () => exec("whoami");
    `);
  const vote = await codeReviewGovernor.evaluate(proposal, buildContext());
  assert.equal(vote.approve, false);
});

test("CodeReviewGovernor ignores non-create_skill actions", async () => {
  const proposal = buildProposal("");
  proposal.action.type = "respond";

  const vote = await codeReviewGovernor.evaluate(proposal, buildContext());
  assert.equal(vote.approve, true);
});
