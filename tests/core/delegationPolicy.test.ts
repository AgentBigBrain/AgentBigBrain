/**
 * @fileoverview Tests deterministic delegation policy decisions for controlled subagent spawning.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateSubagentDelegation } from "../../src/core/delegationPolicy";

/**
 * Implements `blocksDelegationWhenSubagentLimitReached` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function blocksDelegationWhenSubagentLimitReached(): void {
  const decision = evaluateSubagentDelegation(
    {
      capabilityGapScore: 0.95,
      parallelGainScore: 0.9,
      riskReductionScore: 0.7,
      budgetPressureScore: 0.1,
      currentSubagentCount: 2,
      requestedDepth: 1,
      requiresEscalationApproval: false
    },
    {
      maxSubagentsPerTask: 2,
      maxSubagentDepth: 1,
      spawnThresholdScore: 0.6
    }
  );

  assert.equal(decision.shouldSpawn, false);
  assert.ok(decision.blockedBy.includes("SUBAGENT_LIMIT_REACHED"));
}

/**
 * Implements `blocksDelegationWhenDepthExceedsLimit` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function blocksDelegationWhenDepthExceedsLimit(): void {
  const decision = evaluateSubagentDelegation(
    {
      capabilityGapScore: 0.9,
      parallelGainScore: 0.8,
      riskReductionScore: 0.7,
      budgetPressureScore: 0.1,
      currentSubagentCount: 0,
      requestedDepth: 2,
      requiresEscalationApproval: false
    },
    {
      maxSubagentsPerTask: 2,
      maxSubagentDepth: 1,
      spawnThresholdScore: 0.6
    }
  );

  assert.equal(decision.shouldSpawn, false);
  assert.ok(decision.blockedBy.includes("SUBAGENT_DEPTH_EXCEEDED"));
}

/**
 * Implements `blocksDelegationWhenEscalationVoteRequired` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function blocksDelegationWhenEscalationVoteRequired(): void {
  const decision = evaluateSubagentDelegation(
    {
      capabilityGapScore: 0.9,
      parallelGainScore: 0.9,
      riskReductionScore: 0.8,
      budgetPressureScore: 0.1,
      currentSubagentCount: 0,
      requestedDepth: 1,
      requiresEscalationApproval: true
    },
    {
      maxSubagentsPerTask: 2,
      maxSubagentDepth: 1,
      spawnThresholdScore: 0.6
    }
  );

  assert.equal(decision.shouldSpawn, false);
  assert.ok(decision.blockedBy.includes("REQUIRES_ESCALATION_VOTE"));
}

/**
 * Implements `allowsDelegationWhenScoreExceedsThreshold` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function allowsDelegationWhenScoreExceedsThreshold(): void {
  const decision = evaluateSubagentDelegation(
    {
      capabilityGapScore: 0.95,
      parallelGainScore: 0.85,
      riskReductionScore: 0.8,
      budgetPressureScore: 0.05,
      currentSubagentCount: 0,
      requestedDepth: 1,
      requiresEscalationApproval: false
    },
    {
      maxSubagentsPerTask: 2,
      maxSubagentDepth: 1,
      spawnThresholdScore: 0.6
    }
  );

  assert.equal(decision.shouldSpawn, true);
  assert.equal(decision.blockedBy.length, 0);
  assert.ok(decision.spawnScore >= 0.6);
}

/**
 * Implements `deniesDelegationWhenScoreBelowThreshold` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function deniesDelegationWhenScoreBelowThreshold(): void {
  const decision = evaluateSubagentDelegation(
    {
      capabilityGapScore: 0.2,
      parallelGainScore: 0.1,
      riskReductionScore: 0.15,
      budgetPressureScore: 0.9,
      currentSubagentCount: 0,
      requestedDepth: 1,
      requiresEscalationApproval: false
    },
    {
      maxSubagentsPerTask: 2,
      maxSubagentDepth: 1,
      spawnThresholdScore: 0.6
    }
  );

  assert.equal(decision.shouldSpawn, false);
  assert.equal(decision.blockedBy.length, 0);
  assert.ok(decision.spawnScore < 0.6);
}

test("delegation blocks when subagent limit is reached", blocksDelegationWhenSubagentLimitReached);
test("delegation blocks when requested depth exceeds limit", blocksDelegationWhenDepthExceedsLimit);
test("delegation blocks when escalation vote is required", blocksDelegationWhenEscalationVoteRequired);
test("delegation allows spawn when score exceeds threshold", allowsDelegationWhenScoreExceedsThreshold);
test("delegation denies spawn when score is below threshold", deniesDelegationWhenScoreBelowThreshold);
