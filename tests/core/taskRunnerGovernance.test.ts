/**
 * @fileoverview Tests task-runner governance evaluation extracted into the orchestration subsystem.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { MasterGovernor } from "../../src/governors/masterGovernor";
import {
  evaluateTaskRunnerGovernance,
  type EvaluateTaskRunnerGovernanceInput
} from "../../src/core/orchestration/taskRunnerGovernance";

function createGovernanceInput(): {
  traceEvents: Array<{ eventType: string; details?: Record<string, unknown> }>;
  input: EvaluateTaskRunnerGovernanceInput;
} {
  const traceEvents: Array<{ eventType: string; details?: Record<string, unknown> }> = [];
  return {
    traceEvents,
    input: {
      action: {
        id: "action_task_runner_governance_1",
        type: "respond" as const,
        description: "respond to the user",
        params: {},
        estimatedCostUsd: 0.01
      },
      mode: "fast_path" as const,
      proposal: {
        id: "proposal_task_runner_governance_1",
        taskId: "task_task_runner_governance_1",
        requestedBy: "planner" as const,
        rationale: "test rationale",
        action: {
          id: "action_task_runner_governance_1",
          type: "respond" as const,
          description: "respond to the user",
          params: {},
          estimatedCostUsd: 0.01
        },
        touchesImmutable: false
      },
      taskId: "task_task_runner_governance_1",
      governorContext: {} as never,
      governors: [{ id: "security" }] as never,
      masterGovernor: new MasterGovernor(1),
      fastPathGovernorIds: ["security"],
      perGovernorTimeoutMs: 5_000,
      appendTraceEvent: async (input: {
        eventType: string;
        details?: Record<string, unknown>;
      }) => {
        traceEvents.push(input);
      }
    }
  };
}

test("evaluateTaskRunnerGovernance stops at create-skill code-review rejection", async () => {
  const { input, traceEvents } = createGovernanceInput();
  input.action = {
    id: input.action.id,
    type: "create_skill",
    description: input.action.description,
    params: {},
    estimatedCostUsd: input.action.estimatedCostUsd
  };
  input.proposal = {
    ...input.proposal,
    action: input.action
  };

  let councilCalled = false;
  const outcome = await evaluateTaskRunnerGovernance({
    ...input,
    runtime: {
      evaluateCodeReview: async () => ({
        governorId: "codeReview",
        approve: false,
        reason: "Rejected in preflight.",
        confidence: 1
      }),
      runCouncilVote: async () => {
        councilCalled = true;
        throw new Error("council vote should not run after preflight rejection");
      }
    }
  });

  assert.equal(councilCalled, false);
  assert.deepEqual(outcome.blockedResult?.blockedBy, ["codeReview"]);
  assert.equal(outcome.combinedVotes.length, 1);
  assert.deepEqual(
    traceEvents.map((event) => event.eventType),
    ["governance_voted"]
  );
});

test("evaluateTaskRunnerGovernance blocks fast-path requests when no governors match", async () => {
  const { input } = createGovernanceInput();
  input.fastPathGovernorIds = ["utility"];

  const outcome = await evaluateTaskRunnerGovernance(input);

  assert.deepEqual(outcome.blockedResult?.blockedBy, ["GOVERNOR_SET_EMPTY"]);
  assert.deepEqual(outcome.blockedTraceDetails, {
    blockCode: "GOVERNOR_SET_EMPTY",
    blockCategory: "governance"
  });
});

test("evaluateTaskRunnerGovernance fails closed when council vote returns no decision", async () => {
  const { input, traceEvents } = createGovernanceInput();
  input.mode = "escalation_path";

  const outcome = await evaluateTaskRunnerGovernance({
    ...input,
    runtime: {
      runCouncilVote: async () => ({
        votes: [
          {
            governorId: "security",
            approve: true,
            reason: "Safe.",
            confidence: 1
          }
        ],
        decision: undefined
      } as never)
    }
  });

  assert.deepEqual(outcome.blockedResult?.blockedBy, ["GOVERNANCE_DECISION_MISSING"]);
  assert.equal(outcome.combinedVotes.length, 1);
  assert.deepEqual(
    traceEvents.map((event) => event.eventType),
    ["governance_voted"]
  );
});

test("evaluateTaskRunnerGovernance returns combined votes and decision on approval", async () => {
  const { input, traceEvents } = createGovernanceInput();
  input.action = {
    id: input.action.id,
    type: "create_skill",
    description: input.action.description,
    params: {},
    estimatedCostUsd: input.action.estimatedCostUsd
  };
  input.proposal = {
    ...input.proposal,
    action: input.action
  };

  const outcome = await evaluateTaskRunnerGovernance({
    ...input,
    runtime: {
      evaluateCodeReview: async () => ({
        governorId: "codeReview",
        approve: true,
        reason: "Looks good.",
        confidence: 1
      }),
      runCouncilVote: async () => ({
        votes: [
          {
            governorId: "security",
            approve: true,
            reason: "Safe.",
            confidence: 1
          }
        ],
        decision: {
          approved: true,
          yesVotes: 1,
          noVotes: 0,
          threshold: 1,
          dissent: []
        }
      })
    }
  });

  assert.equal(outcome.blockedResult, undefined);
  assert.equal(outcome.decision?.approved, true);
  assert.equal(outcome.combinedVotes.length, 2);
  assert.deepEqual(
    traceEvents.map((event) => event.eventType),
    ["governance_voted", "governance_voted"]
  );
});
