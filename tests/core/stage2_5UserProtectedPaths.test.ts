/**
 * @fileoverview Stage 2.5 runtime-path tests for owner-declared protected paths, anti-bypass handling, and full-access parity.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { createBrainConfigFromEnv } from "../../src/core/config";
import { evaluateHardConstraints } from "../../src/core/hardConstraints";
import { GovernanceProposal } from "../../src/core/types";

const USER_PROTECTED_PREFIX = "runtime/user_protected";

/**
 * Implements `makeProposal` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function makeProposal(action: GovernanceProposal["action"]): GovernanceProposal {
  return {
    id: "proposal_stage2_5",
    taskId: "task_stage2_5",
    requestedBy: "planner",
    rationale: "Stage 2.5 hardening validation",
    touchesImmutable: false,
    action
  };
}

/**
 * Implements `buildStage25Config` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildStage25Config(runtimeMode: "isolated" | "full_access"): ReturnType<typeof createBrainConfigFromEnv> {
  return createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: runtimeMode,
    BRAIN_ALLOW_FULL_ACCESS: runtimeMode === "full_access" ? "true" : undefined,
    BRAIN_USER_PROTECTED_PATHS: USER_PROTECTED_PREFIX
  });
}

/**
 * Implements `getViolationCodes` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function getViolationCodes(
  proposal: GovernanceProposal,
  runtimeMode: "isolated" | "full_access" = "isolated"
): Set<string> {
  const config = buildStage25Config(runtimeMode);
  const violations = evaluateHardConstraints(proposal, config);
  return new Set(violations.map((violation) => violation.code));
}

/**
 * Implements `toWindowsDriveCaseVariant` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function toWindowsDriveCaseVariant(inputPath: string): string | null {
  const match = inputPath.match(/^[a-z]:/i);
  if (!match) {
    return null;
  }

  const driveLetter = match[0][0];
  const toggled =
    driveLetter === driveLetter.toUpperCase()
      ? driveLetter.toLowerCase()
      : driveLetter.toUpperCase();
  return `${toggled}${inputPath.slice(1)}`;
}

test("stage 2.5 user protection policy surface parses deterministic owner declarations and fails closed on invalid input", () => {
  const parsed = createBrainConfigFromEnv({
    BRAIN_USER_PROTECTED_PATHS: "runtime/user_protected;\"C:\\Users\\benac\\Private\""
  });

  assert.equal(
    parsed.dna.protectedPathPrefixes.includes("runtime/user_protected"),
    true
  );
  assert.equal(
    parsed.dna.protectedPathPrefixes.includes("C:\\Users\\benac\\Private"),
    true
  );

  assert.throws(
    () =>
      createBrainConfigFromEnv({
        BRAIN_USER_PROTECTED_PATHS: "runtime/user_protected;;runtime/another"
      }),
    /BRAIN_USER_PROTECTED_PATHS contains an empty path entry/
  );
});

test("stage 2.5 runtime enforcement blocks user-protected paths for read/write/delete/list actions", () => {
  const readCodes = getViolationCodes(
    makeProposal({
      id: "action_read_protected",
      type: "read_file",
      description: "Read owner protected file",
      params: { path: "runtime/user_protected/notes.txt" },
      estimatedCostUsd: 0.1
    })
  );
  assert.equal(readCodes.has("READ_PROTECTED_PATH"), true);

  const writeCodes = getViolationCodes(
    makeProposal({
      id: "action_write_protected",
      type: "write_file",
      description: "Write owner protected file",
      params: { path: "runtime/user_protected/notes.txt", content: "unsafe" },
      estimatedCostUsd: 0.1
    })
  );
  assert.equal(writeCodes.has("WRITE_PROTECTED_PATH"), true);

  const deleteCodes = getViolationCodes(
    makeProposal({
      id: "action_delete_protected",
      type: "delete_file",
      description: "Delete owner protected file",
      params: { path: "runtime/user_protected/notes.txt" },
      estimatedCostUsd: 0.1
    })
  );
  assert.equal(deleteCodes.has("DELETE_PROTECTED_PATH"), true);

  const listCodes = getViolationCodes(
    makeProposal({
      id: "action_list_protected",
      type: "list_directory",
      description: "List owner protected directory",
      params: { path: "runtime/user_protected" },
      estimatedCostUsd: 0.1
    })
  );
  assert.equal(listCodes.has("LIST_PROTECTED_PATH"), true);
});

test("stage 2.5 runtime enforcement blocks path-targeting shell variants that touch user-protected paths", () => {
  const commandTargetCodes = getViolationCodes(
    makeProposal({
      id: "action_shell_command_protected",
      type: "shell_command",
      description: "Shell command reads protected file",
      params: { command: "type runtime/user_protected/notes.txt" },
      estimatedCostUsd: 0.1
    }),
    "full_access"
  );
  assert.equal(commandTargetCodes.has("SHELL_TARGETS_PROTECTED_PATH"), true);

  const paramTargetCodes = getViolationCodes(
    makeProposal({
      id: "action_shell_param_protected",
      type: "shell_command",
      description: "Shell command with explicit protected workdir",
      params: {
        command: "echo hello",
        workdir: "runtime/user_protected"
      },
      estimatedCostUsd: 0.1
    }),
    "full_access"
  );
  assert.equal(paramTargetCodes.has("SHELL_TARGETS_PROTECTED_PATH"), true);
});

test("stage 2.5 canonical path anti-bypass blocks traversal, separator/case, relative, and drive-letter variants", () => {
  const traversalCodes = getViolationCodes(
    makeProposal({
      id: "action_read_traversal",
      type: "read_file",
      description: "Read protected file via traversal",
      params: { path: "runtime/sandbox/../user_protected/notes.txt" },
      estimatedCostUsd: 0.1
    })
  );
  assert.equal(traversalCodes.has("READ_PROTECTED_PATH"), true);

  const separatorCaseCodes = getViolationCodes(
    makeProposal({
      id: "action_read_separator_case_variant",
      type: "read_file",
      description: "Read protected file via case/slash variant",
      params: { path: "RuNtImE\\UsEr_PrOtEcTeD\\notes.txt" },
      estimatedCostUsd: 0.1
    })
  );
  assert.equal(separatorCaseCodes.has("READ_PROTECTED_PATH"), true);

  const relativeCodes = getViolationCodes(
    makeProposal({
      id: "action_read_relative_variant",
      type: "read_file",
      description: "Read protected file via relative-path variant",
      params: { path: `.${path.sep}${USER_PROTECTED_PREFIX}${path.sep}notes.txt` },
      estimatedCostUsd: 0.1
    })
  );
  assert.equal(relativeCodes.has("READ_PROTECTED_PATH"), true);

  const absoluteProtectedPath = path.resolve(process.cwd(), USER_PROTECTED_PREFIX);
  const driveCaseVariant = toWindowsDriveCaseVariant(absoluteProtectedPath);
  if (!driveCaseVariant) {
    return;
  }

  const windowsDriveVariantConfig = createBrainConfigFromEnv({
    BRAIN_USER_PROTECTED_PATHS: driveCaseVariant
  });
  const windowsDriveVariantProposal = makeProposal({
    id: "action_drive_letter_variant",
    type: "read_file",
    description: "Read protected file with alternate drive-letter case",
    params: { path: absoluteProtectedPath },
    estimatedCostUsd: 0.1
  });
  const windowsDriveCodes = new Set(
    evaluateHardConstraints(windowsDriveVariantProposal, windowsDriveVariantConfig).map(
      (violation) => violation.code
    )
  );
  assert.equal(windowsDriveCodes.has("READ_PROTECTED_PATH"), true);
});

test("stage 2.5 full-access parity keeps user-protected paths blocked", () => {
  const readCodes = getViolationCodes(
    makeProposal({
      id: "action_read_protected_full_access",
      type: "read_file",
      description: "Read protected file in full-access mode",
      params: { path: "runtime/user_protected/secrets.txt" },
      estimatedCostUsd: 0.1
    }),
    "full_access"
  );
  assert.equal(readCodes.has("READ_PROTECTED_PATH"), true);

  const listCodes = getViolationCodes(
    makeProposal({
      id: "action_list_protected_full_access",
      type: "list_directory",
      description: "List protected directory in full-access mode",
      params: { path: "runtime/user_protected" },
      estimatedCostUsd: 0.1
    }),
    "full_access"
  );
  assert.equal(listCodes.has("LIST_PROTECTED_PATH"), true);

  const shellCodes = getViolationCodes(
    makeProposal({
      id: "action_shell_protected_full_access",
      type: "shell_command",
      description: "Shell command touching protected file in full-access mode",
      params: { command: "type runtime/user_protected/secrets.txt" },
      estimatedCostUsd: 0.1
    }),
    "full_access"
  );
  assert.equal(shellCodes.has("SHELL_TARGETS_PROTECTED_PATH"), true);
});
