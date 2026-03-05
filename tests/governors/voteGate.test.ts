/**
 * @fileoverview Tests council-vote timeout, malformed, and missing-governor fail-safe behavior.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { BrainState, GovernanceProposal, GovernorId, TaskRequest } from "../../src/core/types";
import { MockModelClient } from "../../src/models/mockModelClient";
import { MasterGovernor } from "../../src/governors/masterGovernor";
import { Governor, GovernorContext } from "../../src/governors/types";
import { runCouncilVote } from "../../src/governors/voteGate";

/**
 * Implements `buildTask` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildTask(): TaskRequest {
  return {
    id: "task_vote_gate",
    goal: "Validate governance behavior.",
    userInput: "governance test",
    createdAt: new Date().toISOString()
  };
}

/**
 * Implements `buildState` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildState(): BrainState {
  return {
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
  };
}

/**
 * Implements `buildContext` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildContext(): GovernorContext {
  return {
    task: buildTask(),
    state: buildState(),
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
    config: DEFAULT_BRAIN_CONFIG,
    model: "mock-policy-model",
    modelClient: new MockModelClient()
  };
}

/**
 * Implements `buildProposal` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildProposal(): GovernanceProposal {
  return {
    id: "proposal_vote_gate",
    taskId: "task_vote_gate",
    requestedBy: "planner",
    rationale: "Vote gate behavior test rationale.",
    touchesImmutable: false,
    action: {
      id: "action_vote_gate",
      type: "respond",
      description: "Respond safely.",
      params: {},
      estimatedCostUsd: 0.02
    }
  };
}

/**
 * Implements `buildGovernor` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildGovernor(
  id: GovernorId,
  evaluate: Governor["evaluate"]
): Governor {
  return { id, evaluate };
}

test("runCouncilVote applies timeout fallback vote", async () => {
  const governors: Governor[] = [
    buildGovernor("ethics", async () => ({
      governorId: "ethics",
      approve: true,
      reason: "ok",
      confidence: 1
    })),
    buildGovernor("security", async () => new Promise(() => {
      // Intentionally never resolves to force timeout fallback.
    }))
  ];

  const result = await runCouncilVote(
    buildProposal(),
    governors,
    buildContext(),
    new MasterGovernor(2),
    10
  );

  const securityVote = result.votes.find((vote) => vote.governorId === "security");
  assert.ok(securityVote);
  assert.equal(securityVote?.approve, false);
  assert.match(securityVote?.reason ?? "", /timeout or failure/i);
  assert.equal(securityVote?.rejectCategory, "GOVERNOR_TIMEOUT_OR_FAILURE");
});

test("runCouncilVote applies malformed-vote fallback", async () => {
  const governors: Governor[] = [
    buildGovernor("ethics", async () => ({
      governorId: "ethics",
      approve: true,
      reason: "ok",
      confidence: 1
    })),
    buildGovernor("logic", async () =>
      ({ approve: true, reason: "bad shape" } as unknown as Awaited<ReturnType<Governor["evaluate"]>>)
    )
  ];

  const result = await runCouncilVote(
    buildProposal(),
    governors,
    buildContext(),
    new MasterGovernor(2),
    50
  );

  const logicVote = result.votes.find((vote) => vote.governorId === "logic");
  assert.ok(logicVote);
  assert.equal(logicVote?.approve, false);
  assert.match(logicVote?.reason ?? "", /malformed/i);
  assert.equal(logicVote?.rejectCategory, "GOVERNOR_MALFORMED_VOTE");
});

test("runCouncilVote fails safe when expected governor is missing", async () => {
  const governors: Governor[] = [
    buildGovernor("ethics", async () => ({
      governorId: "ethics",
      approve: true,
      reason: "ok",
      confidence: 1
    })),
    buildGovernor("logic", async () => ({
      governorId: "logic",
      approve: true,
      reason: "ok",
      confidence: 1
    })),
    buildGovernor("resource", async () => ({
      governorId: "resource",
      approve: true,
      reason: "ok",
      confidence: 1
    })),
    buildGovernor("security", async () => ({
      governorId: "security",
      approve: true,
      reason: "ok",
      confidence: 1
    })),
    buildGovernor("continuity", async () => ({
      governorId: "continuity",
      approve: true,
      reason: "ok",
      confidence: 1
    })),
    buildGovernor("utility", async () => ({
      governorId: "utility",
      approve: true,
      reason: "ok",
      confidence: 1
    }))
  ];

  const result = await runCouncilVote(
    buildProposal(),
    governors,
    buildContext(),
    new MasterGovernor(6),
    50,
    {
      expectedGovernorIds: [
        "ethics",
        "logic",
        "resource",
        "security",
        "continuity",
        "utility",
        "compliance"
      ]
    }
  );

  const missingVote = result.votes.find((vote) => vote.governorId === "compliance");
  assert.ok(missingVote);
  assert.equal(missingVote?.approve, false);
  assert.match(missingVote?.reason ?? "", /missing from council/i);
  assert.equal(missingVote?.rejectCategory, "GOVERNOR_MISSING");
  assert.equal(result.decision.approved, false);
});

test("runCouncilVote preserves approvals when all expected governors respond safely", async () => {
  const governors: Governor[] = [
    buildGovernor("ethics", async () => ({
      governorId: "ethics",
      approve: true,
      reason: "ok",
      confidence: 1
    })),
    buildGovernor("logic", async () => ({
      governorId: "logic",
      approve: true,
      reason: "ok",
      confidence: 1
    })),
    buildGovernor("resource", async () => ({
      governorId: "resource",
      approve: true,
      reason: "ok",
      confidence: 1
    }))
  ];

  const result = await runCouncilVote(
    buildProposal(),
    governors,
    buildContext(),
    new MasterGovernor(3),
    50,
    {
      expectedGovernorIds: ["ethics", "logic", "resource"]
    }
  );

  assert.equal(result.decision.approved, true);
  assert.equal(result.decision.yesVotes, 3);
  assert.equal(result.decision.noVotes, 0);
});
