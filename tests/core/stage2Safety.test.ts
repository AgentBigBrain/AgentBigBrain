/**
 * @fileoverview Stage 2 safety regression suite for isolated-mode hard constraints.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createBrainConfigFromEnv, DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { evaluateHardConstraints } from "../../src/core/hardConstraints";
import { GovernanceProposal } from "../../src/core/types";
import {
  HOST_TEST_DESKTOP_DIR_FORWARD,
  HOST_TEST_UNSAFE_FILE_PATH
} from "../support/windowsPathFixtures";

interface Stage2SafetyCase {
  name: string;
  proposal: GovernanceProposal;
  expectedViolationCodes: string[];
}

/**
 * Implements `makeProposal` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function makeProposal(
  action: GovernanceProposal["action"],
  overrides: Partial<GovernanceProposal> = {}
): GovernanceProposal {
  return {
    id: "proposal_stage2",
    taskId: "task_stage2",
    requestedBy: "planner",
    rationale: "Stage 2 safety baseline validation",
    touchesImmutable: false,
    action,
    ...overrides
  };
}

/**
 * Implements `evaluateViolationCodes` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function evaluateViolationCodes(
  proposal: GovernanceProposal,
  config = DEFAULT_BRAIN_CONFIG
): Set<string> {
  return new Set(evaluateHardConstraints(proposal, config).map((violation) => violation.code));
}

/**
 * Implements `assertContainsCodes` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function assertContainsCodes(
  foundCodes: Set<string>,
  expectedCodes: string[],
  contextName: string
): void {
  for (const expectedCode of expectedCodes) {
    assert.equal(
      foundCodes.has(expectedCode),
      true,
      `Case "${contextName}" expected violation code ${expectedCode}. Found: ${[
        ...foundCodes
      ].join(", ")}`
    );
  }
}

/**
 * Implements `buildIsolatedStage2Baseline` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildIsolatedStage2Baseline(): Stage2SafetyCase[] {
  return [
    {
      name: "shell command blocked by isolated policy",
      proposal: makeProposal({
        id: "action_shell_isolated",
        type: "shell_command",
        description: "Attempt shell execution in isolated mode",
        params: { command: "echo hello" },
        estimatedCostUsd: 0.1
      }),
      expectedViolationCodes: ["SHELL_DISABLED_BY_POLICY"]
    },
    {
      name: "network write blocked by isolated policy",
      proposal: makeProposal({
        id: "action_network_isolated",
        type: "network_write",
        description: "Attempt network write in isolated mode",
        params: { endpoint: "https://example.com", payload: { ok: true } },
        estimatedCostUsd: 0.2
      }),
      expectedViolationCodes: ["NETWORK_WRITE_DISABLED"]
    },
    {
      name: "protected memory path write blocked",
      proposal: makeProposal({
        id: "action_write_memory",
        type: "write_file",
        description: "Attempt to write protected memory path",
        params: { path: "memory/project_memory.md", content: "unsafe overwrite" },
        estimatedCostUsd: 0.1
      }),
      expectedViolationCodes: ["WRITE_PROTECTED_PATH"]
    },
    {
      name: "delete outside sandbox blocked",
      proposal: makeProposal({
        id: "action_delete_outside",
        type: "delete_file",
        description: "Attempt delete outside sandbox",
        params: { path: HOST_TEST_UNSAFE_FILE_PATH },
        estimatedCostUsd: 0.1
      }),
      expectedViolationCodes: ["DELETE_OUTSIDE_SANDBOX"]
    },
    {
      name: "delete traversal escape blocked",
      proposal: makeProposal({
        id: "action_delete_traversal",
        type: "delete_file",
        description: "Attempt delete using traversal escape",
        params: { path: "runtime/sandbox/../../unsafe.txt" },
        estimatedCostUsd: 0.1
      }),
      expectedViolationCodes: ["DELETE_OUTSIDE_SANDBOX"]
    },
    {
      name: "immutable self-modification blocked",
      proposal: makeProposal(
        {
          id: "action_self_modify_immutable",
          type: "self_modify",
          description: "Attempt to mutate immutable rule",
          params: { target: "constitution.core" },
          estimatedCostUsd: 0.1
        },
        { touchesImmutable: true }
      ),
      expectedViolationCodes: ["IMMUTABLE_VIOLATION"]
    },
    {
      name: "list directory outside sandbox blocked in isolated mode",
      proposal: makeProposal({
        id: "action_list_outside",
        type: "list_directory",
        description: "Attempt to list outside sandbox",
        params: { path: HOST_TEST_DESKTOP_DIR_FORWARD },
        estimatedCostUsd: 0.1
      }),
      expectedViolationCodes: ["LIST_OUTSIDE_SANDBOX"]
    },
    {
      name: "list traversal escape blocked in isolated mode",
      proposal: makeProposal({
        id: "action_list_traversal",
        type: "list_directory",
        description: "Attempt list directory using traversal escape",
        params: { path: "runtime/sandbox/../../" },
        estimatedCostUsd: 0.1
      }),
      expectedViolationCodes: ["LIST_OUTSIDE_SANDBOX"]
    },
    {
      name: "create skill with invalid name blocked",
      proposal: makeProposal({
        id: "action_create_skill_invalid_name",
        type: "create_skill",
        description: "Attempt to create skill with traversal name",
        params: { name: "../escape", code: "export const ok = true;" },
        estimatedCostUsd: 0.1
      }),
      expectedViolationCodes: ["CREATE_SKILL_INVALID_NAME"]
    }
  ];
}

test("stage 2 isolated safety baseline rejects unsafe operations", () => {
  for (const safetyCase of buildIsolatedStage2Baseline()) {
    const codes = evaluateViolationCodes(safetyCase.proposal, DEFAULT_BRAIN_CONFIG);
    assertContainsCodes(codes, safetyCase.expectedViolationCodes, safetyCase.name);
  }
});

test("dangerous shell pattern remains blocked even in full access mode", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const proposal = makeProposal({
    id: "action_shell_dangerous",
    type: "shell_command",
    description: "Attempt dangerous command in full access mode",
    params: { command: "rm -rf /tmp/agentbigbrain-test" },
    estimatedCostUsd: 0.1
  });

  const codes = evaluateViolationCodes(proposal, fullAccessConfig);
  assertContainsCodes(
    codes,
    ["SHELL_DANGEROUS_COMMAND"],
    "dangerous shell pattern in full access mode"
  );
});

test("immutable self-modification remains blocked in full access mode", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const proposal = makeProposal(
    {
      id: "action_self_modify_immutable_full",
      type: "self_modify",
      description: "Attempt immutable self-modification in full access mode",
      params: { target: "constitution.core" },
      estimatedCostUsd: 0.1
    },
    { touchesImmutable: true }
  );

  const codes = evaluateViolationCodes(proposal, fullAccessConfig);
  assertContainsCodes(codes, ["IMMUTABLE_VIOLATION"], "immutable self-modification full access");
});
