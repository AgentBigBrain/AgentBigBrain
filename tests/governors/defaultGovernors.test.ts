/**
 * @fileoverview Tests deterministic reject-category tagging in default governors.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { evaluateHardConstraints } from "../../src/core/hardConstraints";
import { BrainState, GovernanceProposal, GovernorId, TaskRequest } from "../../src/core/types";
import { ModelClient, StructuredCompletionRequest } from "../../src/models/types";
import { createDefaultGovernors } from "../../src/governors/defaultGovernors";
import { GovernorContext } from "../../src/governors/types";

/**
 * Implements `DeterministicGovernorModelClient` behavior within test scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
class DeterministicGovernorModelClient implements ModelClient {
  backend: "mock" = "mock";
  private readonly advisoryRejectGovernorId?: GovernorId;

  /**
   * Constructs deterministic advisory behavior for governor model calls.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  constructor(advisoryRejectGovernorId?: GovernorId) {
    this.advisoryRejectGovernorId = advisoryRejectGovernorId;
  }

  /**
   * Implements `completeJson` behavior within class scope.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    const payload = JSON.parse(request.userPrompt) as {
      governorId?: GovernorId;
    };

    if (payload.governorId === this.advisoryRejectGovernorId) {
      return {
        approve: false,
        reason: "model advisory policy block",
        confidence: 0.77
      } as T;
    }

    return {
      approve: true,
      reason: "model advisory allow",
      confidence: 0.88
    } as T;
  }
}

/**
 * Implements `buildTask` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildTask(): TaskRequest {
  return {
    id: "task_default_governors",
    goal: "Validate default governor behavior.",
    userInput: "governor test request",
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
 * Implements `buildProposal` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildProposal(
  actionOverrides: Partial<GovernanceProposal["action"]>,
  rationale = "This rationale is long enough to satisfy logic governor checks."
): GovernanceProposal {
  return {
    id: "proposal_default_governors",
    taskId: "task_default_governors",
    requestedBy: "planner",
    rationale,
    touchesImmutable: false,
    action: {
      id: "action_default_governors",
      type: "respond",
      description: "Respond safely to user",
      params: {},
      estimatedCostUsd: 0.02,
      ...actionOverrides
    }
  };
}

/**
 * Implements `buildContext` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildContext(advisoryRejectGovernorId?: GovernorId): GovernorContext {
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
    modelClient: new DeterministicGovernorModelClient(advisoryRejectGovernorId)
  };
}

/**
 * Implements `getGovernorById` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function getGovernorById(governorId: GovernorId) {
  const governor = createDefaultGovernors().find((item) => item.id === governorId);
  assert.ok(governor, `Expected governor '${governorId}' to exist.`);
  return governor;
}

test("ethics governor tags abusive proposals with ABUSE_MALWARE_OR_FRAUD", async () => {
  const ethicsGovernor = getGovernorById("ethics");
  const vote = await ethicsGovernor.evaluate(
    buildProposal({
      description: "Generate malware payload for persistence"
    }),
    buildContext()
  );

  assert.equal(vote.approve, false);
  assert.equal(vote.rejectCategory, "ABUSE_MALWARE_OR_FRAUD");
});

test("resource governor tags budget overages with RESOURCE_BUDGET", async () => {
  const resourceGovernor = getGovernorById("resource");
  const vote = await resourceGovernor.evaluate(
    buildProposal({
      type: "create_skill",
      params: {
        name: "oversized_cost_skill",
        code: `export const data = "${"x".repeat(22000)}";`
      },
      estimatedCostUsd: 0.01
    }),
    buildContext()
  );

  assert.equal(vote.approve, false);
  assert.equal(vote.rejectCategory, "RESOURCE_BUDGET");
});

test("model advisory governor rejection is tagged as MODEL_ADVISORY_BLOCK", async () => {
  const utilityGovernor = getGovernorById("utility");
  const vote = await utilityGovernor.evaluate(
    buildProposal({
      type: "read_file",
      description: "Read project notes for a summary"
    }),
    buildContext("utility")
  );

  assert.equal(vote.approve, false);
  assert.equal(vote.rejectCategory, "MODEL_ADVISORY_BLOCK");
});

test("security governor preserves destructive shell-command block behavior on canonical cases", async () => {
  const securityGovernor = getGovernorById("security");
  const vote = await securityGovernor.evaluate(
    buildProposal({
      type: "shell_command",
      description: "run dangerous command",
      params: {
        command: "rm -rf /"
      }
    }),
    buildContext()
  );

  assert.equal(vote.approve, false);
  assert.equal(vote.rejectCategory, "SECURITY_BOUNDARY");
  assert.match(vote.reason, /blocked destructive patterns/i);
});

test("security governor lexical block never contradicts hard-constraint dangerous-command boundary", async () => {
  const proposal = buildProposal({
    type: "shell_command",
    description: "run dangerous command",
    params: {
      command: "shutdown -s -t 0"
    }
  });
  const securityGovernor = getGovernorById("security");
  const vote = await securityGovernor.evaluate(proposal, buildContext());
  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);

  assert.equal(vote.approve, false);
  assert.equal(vote.rejectCategory, "SECURITY_BOUNDARY");
  assert.equal(
    violations.some((violation) => violation.code === "SHELL_DANGEROUS_COMMAND"),
    true
  );
});
