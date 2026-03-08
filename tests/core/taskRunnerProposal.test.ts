/**
 * @fileoverview Tests canonical task-runner proposal and governor-context helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildGovernorContext,
  buildProposal
} from "../../src/core/orchestration/taskRunnerProposal";
import { createBrainConfigFromEnv } from "../../src/core/config";

test("buildGovernorContext returns a governor-scoped model context", () => {
  const baseConfig = createBrainConfigFromEnv({});
  const config = {
    ...baseConfig,
    routing: {
      ...baseConfig.routing,
      planner: {
        primary: "planner-model",
        fallback: "planner-model-fallback"
      },
      governor: {
        primary: "governor-model",
        fallback: "governor-model-fallback"
      }
    }
  };

  const context = buildGovernorContext({
    task: {
      id: "task_task_runner_proposal_1",
      goal: "review task",
      userInput: "review task",
      createdAt: "2026-03-07T12:00:00.000Z"
    },
    state: {} as never,
    governanceMemory: {} as never,
    profileMemoryStatus: "disabled",
    config,
    modelClient: {} as never
  });

  assert.equal(context.model, "governor-model");
  assert.equal(context.task.id, "task_task_runner_proposal_1");
  assert.equal(context.profileMemoryStatus, "disabled");
});

test("buildProposal marks immutable targets from path keywords", () => {
  const baseConfig = createBrainConfigFromEnv({});
  const config = {
    ...baseConfig,
    dna: {
      ...baseConfig.dna,
      immutableKeywords: ["archive", "do-not-touch"]
    }
  };

  const proposal = buildProposal(
    {
      id: "task_task_runner_proposal_2",
      goal: "edit archive file",
      userInput: "edit archive file",
      createdAt: "2026-03-07T12:00:00.000Z"
    },
    {
      id: "action_task_runner_proposal_2",
      type: "self_modify",
      description: "update archive",
      params: {
        target: "docs/archive/immutable.md"
      },
      estimatedCostUsd: 0.01
    },
    config
  );

  assert.equal(proposal.taskId, "task_task_runner_proposal_2");
  assert.equal(proposal.touchesImmutable, true);
  assert.equal(proposal.requestedBy, "planner");
});
