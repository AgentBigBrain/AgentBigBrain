/**
 * @fileoverview Validates deterministic hard-constraint behavior for safety-critical proposals.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { createBrainConfigFromEnv, DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { evaluateHardConstraints } from "../../src/core/hardConstraints";
import { GovernanceProposal } from "../../src/core/types";
import {
  HOST_TEST_DESKTOP_DIR_FORWARD,
  HOST_TEST_SOMETHING_FILE_PATH
} from "../support/windowsPathFixtures";

/**
 * Implements `makeProposal` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function makeProposal(overrides: Partial<GovernanceProposal> = {}): GovernanceProposal {
  return {
    id: "proposal_test",
    taskId: "task_test",
    requestedBy: "planner",
    rationale: "Task goal: safety test. Execute action with clear rationale.",
    touchesImmutable: false,
    action: {
      id: "action_test",
      type: "respond",
      description: "Respond to user.",
      params: {},
      estimatedCostUsd: 0.05
    },
    ...overrides
  };
}

test("blocks delete outside sandbox", () => {
  const proposal = makeProposal({
    action: {
      id: "action_delete",
      type: "delete_file",
      description: "Delete file",
      params: { path: HOST_TEST_SOMETHING_FILE_PATH },
      estimatedCostUsd: 0.2
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "DELETE_OUTSIDE_SANDBOX"));
});

test("blocks immutable self modification", () => {
  const proposal = makeProposal({
    touchesImmutable: true,
    action: {
      id: "action_self_modify",
      type: "self_modify",
      description: "Update constitution",
      params: { target: "constitution.core" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "IMMUTABLE_VIOLATION"));
});

test("blocks shell command in isolated profile", () => {
  const proposal = makeProposal({
    action: {
      id: "action_shell",
      type: "shell_command",
      description: "Run shell command",
      params: { command: "echo hi" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "SHELL_DISABLED_BY_POLICY"));
});

test("allows delete outside sandbox in full access profile", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const proposal = makeProposal({
    action: {
      id: "action_delete_full",
      type: "delete_file",
      description: "Delete file",
      params: { path: HOST_TEST_SOMETHING_FILE_PATH },
      estimatedCostUsd: 0.2
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.equal(
    violations.some((violation) => violation.code === "DELETE_OUTSIDE_SANDBOX"),
    false
  );
});

test("blocks list directory outside sandbox in isolated profile", () => {
  const proposal = makeProposal({
    action: {
      id: "action_list",
      type: "list_directory",
      description: "List directories",
      params: { path: HOST_TEST_DESKTOP_DIR_FORWARD },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "LIST_OUTSIDE_SANDBOX"));
});

test("allows list directory outside sandbox in full access profile", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const proposal = makeProposal({
    action: {
      id: "action_list_full",
      type: "list_directory",
      description: "List directories",
      params: { path: HOST_TEST_DESKTOP_DIR_FORWARD },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.equal(
    violations.some((violation) => violation.code === "LIST_OUTSIDE_SANDBOX"),
    false
  );
});

test("blocks create_skill with invalid name", () => {
  const proposal = makeProposal({
    action: {
      id: "action_create_skill_invalid",
      type: "create_skill",
      description: "Create invalid skill name",
      params: { name: "../escape", code: "export const ok = true;" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "CREATE_SKILL_INVALID_NAME"));
});

test("allows create_skill with valid payload", () => {
  const proposal = makeProposal({
    action: {
      id: "action_create_skill_valid",
      type: "create_skill",
      description: "Create valid skill",
      params: {
        name: "safe_skill",
        code: "export function safeSkill(input: string): string { return input.trim(); }"
      },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code.startsWith("CREATE_SKILL")),
    false
  );
});

test("blocks create_skill when code is non-executable", () => {
  const proposal = makeProposal({
    action: {
      id: "action_create_skill_non_exec",
      type: "create_skill",
      description: "Create skill with placeholder code",
      params: { name: "placeholder_skill", code: "// TODO: fill this later" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "CREATE_SKILL_NON_EXECUTABLE"));
});

test("blocks create_skill when code uses unsafe runtime capability", () => {
  const proposal = makeProposal({
    action: {
      id: "action_create_skill_unsafe",
      type: "create_skill",
      description: "Create skill with unsafe capability",
      params: {
        name: "unsafe_skill",
        code: "export function unsafeSkill(): string { return process.env.SECRET ?? ''; }"
      },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "CREATE_SKILL_UNSAFE_CODE"));
});

test("blocks delete when path is missing", () => {
  const proposal = makeProposal({
    action: {
      id: "action_delete_missing_path",
      type: "delete_file",
      description: "Delete file",
      params: {},
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "DELETE_MISSING_PATH"));
});

test("blocks delete traversal that escapes sandbox", () => {
  const proposal = makeProposal({
    action: {
      id: "action_delete_traversal",
      type: "delete_file",
      description: "Delete file with traversal",
      params: { path: "runtime/sandbox/../../outside.txt" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "DELETE_OUTSIDE_SANDBOX"));
});

test("blocks write when path is missing", () => {
  const proposal = makeProposal({
    action: {
      id: "action_write_missing_path",
      type: "write_file",
      description: "Write file without path",
      params: { content: "test" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "WRITE_MISSING_PATH"));
});

test("blocks read when path is missing", () => {
  const proposal = makeProposal({
    action: {
      id: "action_read_missing_path",
      type: "read_file",
      description: "Read file without path",
      params: {},
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "READ_MISSING_PATH"));
});

test("blocks reads to protected paths with case and separator variants", () => {
  const proposal = makeProposal({
    action: {
      id: "action_read_protected_variant",
      type: "read_file",
      description: "Read protected file path variant",
      params: { path: "MeMoRy\\project_memory.md" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "READ_PROTECTED_PATH"));
});

test("blocks protected path writes with case and separator variants", () => {
  const proposal = makeProposal({
    action: {
      id: "action_write_memory_variant",
      type: "write_file",
      description: "Write protected file",
      params: { path: "MeMoRy\\decision_log.md", content: "test" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "WRITE_PROTECTED_PATH"));
});

test("blocks writes to encrypted profile-memory store path", () => {
  const proposal = makeProposal({
    action: {
      id: "action_write_profile_memory",
      type: "write_file",
      description: "Attempt to overwrite encrypted profile memory.",
      params: { path: "runtime/profile_memory.secure.json", content: "tamper" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "WRITE_PROTECTED_PATH"));
});

test("blocks writes to memory-access audit log path", () => {
  const proposal = makeProposal({
    action: {
      id: "action_write_memory_access_log",
      type: "write_file",
      description: "Attempt to overwrite memory-access audit log.",
      params: { path: "runtime/memory_access_log.json", content: "tamper" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "WRITE_PROTECTED_PATH"));
});

test("blocks deletes to memory-access audit log path", () => {
  const proposal = makeProposal({
    action: {
      id: "action_delete_memory_access_log",
      type: "delete_file",
      description: "Attempt to delete memory-access audit log.",
      params: { path: "runtime/memory_access_log.json" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "DELETE_PROTECTED_PATH"));
});

test("blocks writes to runtime trace log path", () => {
  const proposal = makeProposal({
    action: {
      id: "action_write_runtime_trace_log",
      type: "write_file",
      description: "Attempt to overwrite runtime trace log.",
      params: { path: "runtime/runtime_trace.jsonl", content: "tamper" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "WRITE_PROTECTED_PATH"));
});

test("blocks deletes to runtime trace log path", () => {
  const proposal = makeProposal({
    action: {
      id: "action_delete_runtime_trace_log",
      type: "delete_file",
      description: "Attempt to delete runtime trace log.",
      params: { path: "runtime/runtime_trace.jsonl" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "DELETE_PROTECTED_PATH"));
});

test("does not overblock writes that resolve outside protected prefix", () => {
  const proposal = makeProposal({
    action: {
      id: "action_write_escape_protected",
      type: "write_file",
      description: "Write docs path via normalized traversal",
      params: { path: "memory/../docs/stage2-note.md", content: "safe" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code === "WRITE_PROTECTED_PATH"),
    false
  );
});

test("blocks list directory when path is missing", () => {
  const proposal = makeProposal({
    action: {
      id: "action_list_missing_path",
      type: "list_directory",
      description: "List directory without path",
      params: {},
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "LIST_MISSING_PATH"));
});

test("blocks list traversal that escapes sandbox", () => {
  const proposal = makeProposal({
    action: {
      id: "action_list_traversal",
      type: "list_directory",
      description: "List directory with traversal",
      params: { path: "runtime/sandbox/../../" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "LIST_OUTSIDE_SANDBOX"));
});

test("blocks list directory on protected path even in full access mode", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const proposal = makeProposal({
    action: {
      id: "action_list_protected_full",
      type: "list_directory",
      description: "List protected memory folder in full access mode",
      params: { path: "memory/" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.ok(violations.some((violation) => violation.code === "LIST_PROTECTED_PATH"));
});

test("blocks create_skill when name is missing", () => {
  const proposal = makeProposal({
    action: {
      id: "action_create_skill_missing_name",
      type: "create_skill",
      description: "Create skill missing name",
      params: { code: "export const safe = true;" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "CREATE_SKILL_MISSING_NAME"));
});

test("blocks create_skill when code is missing", () => {
  const proposal = makeProposal({
    action: {
      id: "action_create_skill_missing_code",
      type: "create_skill",
      description: "Create skill missing code",
      params: { name: "safe_skill" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "CREATE_SKILL_MISSING_CODE"));
});

test("blocks create_skill when code size exceeds limit", () => {
  const proposal = makeProposal({
    action: {
      id: "action_create_skill_large_code",
      type: "create_skill",
      description: "Create skill with oversized code",
      params: { name: "safe_skill", code: "x".repeat(20_001) },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "CREATE_SKILL_CODE_TOO_LARGE"));
});

test("blocks create_skill when feature is disabled", () => {
  const disabledConfig = {
    ...DEFAULT_BRAIN_CONFIG,
    permissions: {
      ...DEFAULT_BRAIN_CONFIG.permissions,
      allowCreateSkillAction: false
    }
  };
  const proposal = makeProposal({
    action: {
      id: "action_create_skill_disabled",
      type: "create_skill",
      description: "Create skill when disabled",
      params: { name: "safe_skill", code: "export const safe = true;" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, disabledConfig);
  assert.ok(violations.some((violation) => violation.code === "CREATE_SKILL_DISABLED"));
});

test("blocks run_skill when name is missing", () => {
  const proposal = makeProposal({
    action: {
      id: "action_run_skill_missing_name",
      type: "run_skill",
      description: "Run skill without name",
      params: {},
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "RUN_SKILL_MISSING_NAME"));
});

test("blocks run_skill when name is invalid", () => {
  const proposal = makeProposal({
    action: {
      id: "action_run_skill_invalid_name",
      type: "run_skill",
      description: "Run skill with invalid name",
      params: { name: "../escape" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "RUN_SKILL_INVALID_NAME"));
});

test("blocks run_skill when artifact is missing", () => {
  const proposal = makeProposal({
    action: {
      id: "action_run_skill_missing_artifact",
      type: "run_skill",
      description: "Run skill with valid name but no artifact",
      params: { name: "missing_skill_artifact", input: "hello" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "RUN_SKILL_ARTIFACT_MISSING"));
});

test("allows run_skill with valid payload and existing artifact", () => {
  const skillRoot = path.resolve(process.cwd(), "runtime/skills");
  const skillPath = path.resolve(skillRoot, "safe_skill.js");
  mkdirSync(skillRoot, { recursive: true });
  writeFileSync(skillPath, "export default async function safeSkill() { return 'ok'; }\n", "utf8");

  const proposal = makeProposal({
    action: {
      id: "action_run_skill_valid",
      type: "run_skill",
      description: "Run skill with valid name",
      params: { name: "safe_skill", input: "hello" },
      estimatedCostUsd: 0.1
    }
  });

  try {
    const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
    assert.equal(
      violations.some((violation) => violation.code.startsWith("RUN_SKILL")),
      false
    );
  } finally {
    rmSync(skillPath, { force: true });
  }
});

test("blocks shell command when command is missing", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const proposal = makeProposal({
    action: {
      id: "action_shell_missing",
      type: "shell_command",
      description: "Run missing shell command",
      params: {},
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.ok(violations.some((violation) => violation.code === "SHELL_MISSING_COMMAND"));
});

test("blocks managed process start when command is missing", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const proposal = makeProposal({
    action: {
      id: "action_process_missing",
      type: "start_process",
      description: "Start missing managed process command",
      params: {},
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.ok(violations.some((violation) => violation.code === "PROCESS_MISSING_COMMAND"));
});

test("blocks probe_port when port is missing", () => {
  const proposal = makeProposal({
    action: {
      id: "action_probe_port_missing_port",
      type: "probe_port",
      description: "Probe local port without port value.",
      params: {
        host: "127.0.0.1"
      },
      estimatedCostUsd: 0.03
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "PROBE_MISSING_PORT"));
});

test("blocks probe_port when host is not local", () => {
  const proposal = makeProposal({
    action: {
      id: "action_probe_port_remote_host",
      type: "probe_port",
      description: "Probe non-local TCP host.",
      params: {
        host: "example.com",
        port: 3000
      },
      estimatedCostUsd: 0.03
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "PROBE_HOST_NOT_LOCAL"));
});

test("blocks probe_http when url is missing", () => {
  const proposal = makeProposal({
    action: {
      id: "action_probe_http_missing_url",
      type: "probe_http",
      description: "Probe local HTTP endpoint without url.",
      params: {},
      estimatedCostUsd: 0.04
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "PROBE_MISSING_URL"));
});

test("blocks probe_http when url is not local", () => {
  const proposal = makeProposal({
    action: {
      id: "action_probe_http_remote_url",
      type: "probe_http",
      description: "Probe remote HTTP endpoint.",
      params: {
        url: "https://example.com/health"
      },
      estimatedCostUsd: 0.04
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "PROBE_URL_NOT_LOCAL"));
});

test("allows loopback probe actions with valid local payloads", () => {
  const portProposal = makeProposal({
    action: {
      id: "action_probe_port_valid",
      type: "probe_port",
      description: "Probe local TCP readiness.",
      params: {
        host: "127.0.0.1",
        port: 3000,
        timeoutMs: 2000
      },
      estimatedCostUsd: 0.03
    }
  });
  const httpProposal = makeProposal({
    action: {
      id: "action_probe_http_valid",
      type: "probe_http",
      description: "Probe local HTTP readiness.",
      params: {
        url: "http://127.0.0.1:3000/health",
        expectedStatus: 200,
        timeoutMs: 2000
      },
      estimatedCostUsd: 0.04
    }
  });

  const portViolations = evaluateHardConstraints(portProposal, DEFAULT_BRAIN_CONFIG);
  const httpViolations = evaluateHardConstraints(httpProposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    portViolations.some((violation) => violation.code.startsWith("PROBE_")),
    false
  );
  assert.equal(
    httpViolations.some((violation) => violation.code.startsWith("PROBE_")),
    false
  );
});

test("blocks verify_browser when url is missing", () => {
  const proposal = makeProposal({
    action: {
      id: "action_verify_browser_missing_url",
      type: "verify_browser",
      description: "Verify browser page without url.",
      params: {},
      estimatedCostUsd: 0.09
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(
    violations.some((violation) => violation.code === "BROWSER_VERIFY_MISSING_URL")
  );
});

test("blocks verify_browser when url is not local", () => {
  const proposal = makeProposal({
    action: {
      id: "action_verify_browser_remote_url",
      type: "verify_browser",
      description: "Verify remote browser page.",
      params: {
        url: "https://example.com/dashboard"
      },
      estimatedCostUsd: 0.09
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(
    violations.some((violation) => violation.code === "BROWSER_VERIFY_URL_NOT_LOCAL")
  );
});

test("allows verify_browser when loopback payload is valid", () => {
  const proposal = makeProposal({
    action: {
      id: "action_verify_browser_valid",
      type: "verify_browser",
      description: "Verify local browser page.",
      params: {
        url: "http://127.0.0.1:3000/",
        expectedTitle: "Robinhood",
        expectedText: "Portfolio",
        timeoutMs: 4000
      },
      estimatedCostUsd: 0.09
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code.startsWith("BROWSER_VERIFY_")),
    false
  );
});

test("allows open_browser when loopback payload is valid", () => {
  const proposal = makeProposal({
    action: {
      id: "action_open_browser_valid",
      type: "open_browser",
      description: "Open the verified local page in a visible browser.",
      params: {
        url: "http://127.0.0.1:3000/"
      },
      estimatedCostUsd: 0.03
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code.startsWith("BROWSER_")),
    false
  );
});

test("allows open_browser when a local file preview url is valid", () => {
  const proposal = makeProposal({
    action: {
      id: "action_open_browser_file_valid",
      type: "open_browser",
      description: "Open the built local file preview in a visible browser.",
      params: {
        url: "file:///C:/Users/testuser/Desktop/drone-company/index.html"
      },
      estimatedCostUsd: 0.03
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code.startsWith("BROWSER_")),
    false
  );
});

test("blocks close_browser when session id and url are both missing", () => {
  const proposal = makeProposal({
    action: {
      id: "action_close_browser_missing_target",
      type: "close_browser",
      description: "Close browser without a tracked target.",
      params: {},
      estimatedCostUsd: 0.02
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(
    violations.some((violation) => violation.code === "BROWSER_SESSION_MISSING_ID")
  );
});

test("blocks close_browser when url is not loopback local", () => {
  const proposal = makeProposal({
    action: {
      id: "action_close_browser_remote_url",
      type: "close_browser",
      description: "Close a remote browser page.",
      params: {
        url: "https://example.com/dashboard"
      },
      estimatedCostUsd: 0.02
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(
    violations.some((violation) => violation.code === "BROWSER_VERIFY_URL_NOT_LOCAL")
  );
});

test("allows close_browser when a tracked browser session id is present", () => {
  const proposal = makeProposal({
    action: {
      id: "action_close_browser_valid",
      type: "close_browser",
      description: "Close a tracked landing-page browser window.",
      params: {
        sessionId: "browser_session:landing-page"
      },
      estimatedCostUsd: 0.02
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code.startsWith("BROWSER_")),
    false
  );
});

test("allows close_browser when a tracked local file preview url is present", () => {
  const proposal = makeProposal({
    action: {
      id: "action_close_browser_file_valid",
      type: "close_browser",
      description: "Close a tracked local file preview window.",
      params: {
        url: "file:///C:/Users/testuser/Desktop/drone-company/index.html"
      },
      estimatedCostUsd: 0.02
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code.startsWith("BROWSER_")),
    false
  );
});

test("blocks shell command when requested shell profile mismatches resolved profile", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true",
    BRAIN_SHELL_PROFILE: "bash"
  });
  const proposal = makeProposal({
    action: {
      id: "action_shell_profile_mismatch",
      type: "shell_command",
      description: "Run command with mismatched requested shell kind.",
      params: { command: "echo hi", requestedShellKind: "pwsh" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.ok(violations.some((violation) => violation.code === "SHELL_PROFILE_MISMATCH"));
});

test("blocks shell commands that exceed configured deterministic length cap", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true",
    BRAIN_SHELL_COMMAND_MAX_CHARS: "512"
  });
  const proposal = makeProposal({
    action: {
      id: "action_shell_command_too_long",
      type: "shell_command",
      description: "Run shell command longer than deterministic cap.",
      params: { command: "x".repeat(513) },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.ok(violations.some((violation) => violation.code === "SHELL_COMMAND_TOO_LONG"));
});

test("blocks shell command when timeout is outside deterministic bounds", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const proposal = makeProposal({
    action: {
      id: "action_shell_timeout_invalid",
      type: "shell_command",
      description: "Run shell command with invalid timeout.",
      params: { command: "echo hi", timeoutMs: 10 },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.ok(violations.some((violation) => violation.code === "SHELL_TIMEOUT_INVALID"));
});

test("blocks shell command when cwd resolves outside sandbox under cwd policy", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true",
    BRAIN_SHELL_CWD_POLICY_DENY_OUTSIDE_SANDBOX: "true"
  });
  const proposal = makeProposal({
    action: {
      id: "action_shell_cwd_outside_sandbox",
      type: "shell_command",
      description: "Run shell command outside configured sandbox cwd boundary.",
      params: { command: "echo hi", cwd: HOST_TEST_DESKTOP_DIR_FORWARD },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.ok(violations.some((violation) => violation.code === "SHELL_CWD_OUTSIDE_SANDBOX"));
});

test("blocks dangerous shell commands even in full access mode", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const proposal = makeProposal({
    action: {
      id: "action_shell_dangerous",
      type: "shell_command",
      description: "Run dangerous shell command",
      params: { command: "rm -rf /" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.ok(violations.some((violation) => violation.code === "SHELL_DANGEROUS_COMMAND"));
});

test("blocks dangerous managed process commands even in full access mode", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const proposal = makeProposal({
    action: {
      id: "action_process_dangerous",
      type: "start_process",
      description: "Start dangerous managed process command",
      params: { command: "rm -rf /" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.ok(violations.some((violation) => violation.code === "PROCESS_DANGEROUS_COMMAND"));
});

test("blocks shell command when command targets protected path", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const proposal = makeProposal({
    action: {
      id: "action_shell_protected_target",
      type: "shell_command",
      description: "Read protected file via shell command",
      params: { command: "type memory/project_memory.md" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.ok(
    violations.some((violation) => violation.code === "SHELL_TARGETS_PROTECTED_PATH")
  );
});

test("blocks managed process command when command targets protected path", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const proposal = makeProposal({
    action: {
      id: "action_process_protected_target",
      type: "start_process",
      description: "Start managed process against protected file",
      params: { command: "type memory/project_memory.md" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.ok(
    violations.some((violation) => violation.code === "PROCESS_TARGETS_PROTECTED_PATH")
  );
});

test("blocks shell command traversal that resolves into protected path", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const proposal = makeProposal({
    action: {
      id: "action_shell_traversal_protected_target",
      type: "shell_command",
      description: "Read protected file via traversal in shell command",
      params: { command: "type runtime/sandbox/../../memory/project_memory.md" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.ok(
    violations.some((violation) => violation.code === "SHELL_TARGETS_PROTECTED_PATH")
  );
});

test("allows shell command when path targets stay outside protected prefixes", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const proposal = makeProposal({
    action: {
      id: "action_shell_unprotected_target",
      type: "shell_command",
      description: "Write to sandbox output via shell redirection",
      params: { command: "echo hello > runtime/sandbox/output.txt" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.equal(
    violations.some((violation) => violation.code === "SHELL_TARGETS_PROTECTED_PATH"),
    false
  );
});

test("allows managed process start when command and cwd stay inside allowed boundaries", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const proposal = makeProposal({
    action: {
      id: "action_process_allowed",
      type: "start_process",
      description: "Start managed process inside sandbox",
      params: {
        command: "npm run dev",
        cwd: "runtime/sandbox/app"
      },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.equal(violations.some((violation) => violation.code.startsWith("PROCESS_")), false);
});

test("blocks check_process when leaseId is missing", () => {
  const proposal = makeProposal({
    action: {
      id: "action_check_process_missing_lease",
      type: "check_process",
      description: "Check process without leaseId",
      params: {},
      estimatedCostUsd: 0.04
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "PROCESS_MISSING_LEASE_ID"));
});

test("blocks stop_process when leaseId is missing", () => {
  const proposal = makeProposal({
    action: {
      id: "action_stop_process_missing_lease",
      type: "stop_process",
      description: "Stop process without leaseId",
      params: {},
      estimatedCostUsd: 0.12
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "PROCESS_MISSING_LEASE_ID"));
});

test("allows stop_process when an exact recovered pid is provided", () => {
  const proposal = makeProposal({
    action: {
      id: "action_stop_process_recovered_pid",
      type: "stop_process",
      description: "Stop process by exact recovered pid",
      params: {
        pid: 31908
      },
      estimatedCostUsd: 0.02
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code === "PROCESS_MISSING_LEASE_ID"),
    false
  );
});

test("blocks actions that exceed cost limits", () => {
  const proposal = makeProposal({
    action: {
      id: "action_high_cost",
      type: "create_skill",
      description: "Expensive create skill by payload size",
      params: {
        name: "expensive_skill",
        code: `export const x = "${"a".repeat(20000)}";`
      },
      estimatedCostUsd: 0.01
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "COST_LIMIT_EXCEEDED"));
});

test("blocks actions that exceed cumulative cost limits", () => {
  const proposal = makeProposal({
    action: {
      id: "action_cumulative_cost",
      type: "create_skill",
      description: "Cumulative-cost create skill by payload size",
      params: {
        name: "cumulative_skill",
        code: `export const x = "${"b".repeat(14000)}";`
      },
      estimatedCostUsd: 0.01
    }
  });

  const violations = evaluateHardConstraints(
    proposal,
    DEFAULT_BRAIN_CONFIG,
    { cumulativeEstimatedCostUsd: 9.2 }
  );
  assert.ok(violations.some((violation) => violation.code === "CUMULATIVE_COST_LIMIT_EXCEEDED"));
});

test("allows actions when cumulative cost stays within limit", () => {
  const proposal = makeProposal({
    action: {
      id: "action_cumulative_within",
      type: "respond",
      description: "Within cumulative budget",
      params: {},
      estimatedCostUsd: 0.8
    }
  });

  const violations = evaluateHardConstraints(
    proposal,
    DEFAULT_BRAIN_CONFIG,
    { cumulativeEstimatedCostUsd: 9.1 }
  );
  assert.equal(
    violations.some((violation) => violation.code === "CUMULATIVE_COST_LIMIT_EXCEEDED"),
    false
  );
});

test("ignores model-reported estimatedCostUsd when deterministic cost is lower", () => {
  const proposal = makeProposal({
    action: {
      id: "action_model_reported_high_cost",
      type: "respond",
      description: "Respond with short output",
      params: { message: "ok" },
      estimatedCostUsd: 9
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code === "COST_LIMIT_EXCEEDED"),
    false
  );
});

test("blocks writes to protected budget-control files", () => {
  const proposal = makeProposal({
    action: {
      id: "action_write_config",
      type: "write_file",
      description: "Attempt to update config file",
      params: { path: "src/core/config.ts", content: "unsafe edit" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "WRITE_PROTECTED_PATH"));
});

test("blocks writes to protected governance-memory file", () => {
  const proposal = makeProposal({
    action: {
      id: "action_write_governance_memory",
      type: "write_file",
      description: "Attempt to alter governance memory file",
      params: { path: "runtime/governance_memory.json", content: "{}" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "WRITE_PROTECTED_PATH"));
});

test("blocks deletes to protected budget-control files even in full access mode", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const proposal = makeProposal({
    action: {
      id: "action_delete_config",
      type: "delete_file",
      description: "Attempt to delete config file",
      params: { path: "src/core/config.ts" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.ok(violations.some((violation) => violation.code === "DELETE_PROTECTED_PATH"));
});

test("blocks deletes to protected governance-memory file even in full access mode", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const proposal = makeProposal({
    action: {
      id: "action_delete_governance_memory",
      type: "delete_file",
      description: "Attempt to delete governance memory file",
      params: { path: "runtime/governance_memory.json" },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.ok(violations.some((violation) => violation.code === "DELETE_PROTECTED_PATH"));
});

test("allows network writes when full access policy enables them", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const proposal = makeProposal({
    action: {
      id: "action_network_full",
      type: "network_write",
      description: "Send network write",
      params: { endpoint: "https://example.com", payload: { ok: true } },
      estimatedCostUsd: 0.1
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.equal(
    violations.some((violation) => violation.code === "NETWORK_WRITE_DISABLED"),
    false
  );
});

test("detects immutable target keywords even when touchesImmutable is false", () => {
  const proposal = makeProposal({
    action: {
      id: "action_self_modify_keyword",
      type: "self_modify",
      description: "Try touching immutable keyword",
      params: { target: "dna_constraints.v1" },
      estimatedCostUsd: 0.1
    },
    touchesImmutable: false
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "IMMUTABLE_VIOLATION"));
});

test("detects immutable budget keywords even when touchesImmutable is false", () => {
  const proposal = makeProposal({
    action: {
      id: "action_self_modify_budget",
      type: "self_modify",
      description: "Try changing cumulative budget limit",
      params: { target: "maxCumulativeEstimatedCostUsd" },
      estimatedCostUsd: 0.1
    },
    touchesImmutable: false
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "IMMUTABLE_VIOLATION"));
});

test("blocks respond actions that attempt to impersonate a human", () => {
  const proposal = makeProposal({
    action: {
      id: "action_respond_impersonation",
      type: "respond",
      description: "Respond to user as if you are their spouse.",
      params: {
        impersonateHuman: true
      },
      estimatedCostUsd: 0.05
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "IDENTITY_IMPERSONATION_DENIED"));
});

test("blocks communication actions with non-agent declared identity", () => {
  const proposal = makeProposal({
    action: {
      id: "action_network_identity_human",
      type: "network_write",
      description: "Send scheduling update to another agent.",
      params: {
        endpoint: "https://example.com/agent",
        actorIdentity: "human"
      },
      estimatedCostUsd: 0.2
    }
  });

  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.ok(violations.some((violation) => violation.code === "IDENTITY_IMPERSONATION_DENIED"));
});

test("allows communication actions that explicitly keep agent identity", () => {
  const proposal = makeProposal({
    action: {
      id: "action_respond_agent_identity",
      type: "respond",
      description: "Send a normal agent response.",
      params: {
        actorIdentity: "agent"
      },
      estimatedCostUsd: 0.05
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code === "IDENTITY_IMPERSONATION_DENIED"),
    false
  );
});

test("does not overblock playbook fallback guidance as impersonation", () => {
  const proposal = makeProposal({
    rationale:
      "Current user request: explain when to fall back to normal planning instead of selecting a playbook.",
    action: {
      id: "action_respond_playbook_guidance",
      type: "respond",
      description: "Provide playbook fallback guidance to the user.",
      params: {
        message: "Use normal planning when no safe playbook matches with enough confidence."
      },
      estimatedCostUsd: 0.05
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code === "IDENTITY_IMPERSONATION_DENIED"),
    false
  );
});

test("does not overblock playbook and fallback prompts as impersonation", () => {
  const proposal = makeProposal({
    rationale:
      "User wants to know if they can use a playbook or if they should fallback to normal planning.",
    action: {
      id: "action_respond_playbook_and_fallback",
      type: "respond",
      description: "Respond to playbook and fallback prompt.",
      params: {
        message: "You can use a playbook or fallback to normal planning."
      },
      estimatedCostUsd: 0.05
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code === "IDENTITY_IMPERSONATION_DENIED"),
    false
  );
});

test("blocks communication actions that declare a human speaker role", () => {
  const proposal = makeProposal({
    action: {
      id: "action_respond_speaker_role_human",
      type: "respond",
      description: "Send message while claiming to be a human speaker.",
      params: {
        speakerRole: "human"
      },
      estimatedCostUsd: 0.05
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "IDENTITY_IMPERSONATION_DENIED"));
});

test("blocks communication actions with textual human-claim impersonation patterns", () => {
  const proposal = makeProposal({
    action: {
      id: "action_respond_textual_impersonation",
      type: "respond",
      description: "Respond with a human identity claim.",
      params: {
        message: "I am a human and this is Taylor."
      },
      estimatedCostUsd: 0.05
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "IDENTITY_IMPERSONATION_DENIED"));
});

test("blocks communication actions that claim a named human identity in first-person", () => {
  const proposal = makeProposal({
    action: {
      id: "action_respond_named_human_identity_claim",
      type: "respond",
      description: "Respond while claiming a specific human identity.",
      params: {
        message: "Hello, I'm Taylor. How can I help?"
      },
      estimatedCostUsd: 0.05
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "IDENTITY_IMPERSONATION_DENIED"));
});

test("blocks communication actions with paraphrased impersonation instructions", () => {
  const proposal = makeProposal({
    action: {
      id: "action_respond_paraphrased_impersonation",
      type: "respond",
      description: "Pass yourself off as a real person and speak on my behalf.",
      params: {
        message: "Please pass yourself off as Taylor and speak for me in this thread."
      },
      estimatedCostUsd: 0.05
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "IDENTITY_IMPERSONATION_DENIED"));
});

test("does not block respond action that recalls profile facts about the user", () => {
  const proposal = makeProposal({
    rationale:
      "The user asked 'who am I?' — recall stored profile memory facts and represent them to the user.",
    action: {
      id: "action_respond_profile_recall",
      type: "respond",
      description: "Respond with the user's profile information from memory.",
      params: {
        message: "You are Benny, and your main job is at AgentBigBrain."
      },
      estimatedCostUsd: 0.05
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code === "IDENTITY_IMPERSONATION_DENIED"),
    false,
    "Profile recall should not trigger impersonation when rationale indicates memory lookup"
  );
});

test("still blocks genuine impersonation even when profile recall stems appear", () => {
  const proposal = makeProposal({
    rationale: "I'll pretend to be a human and pass myself off as the owner.",
    action: {
      id: "action_respond_impersonation_with_profile_words",
      type: "respond",
      description: "Impersonate the user and pretend to be them.",
      params: {
        message: "Hello, I'm Taylor. How can I help?"
      },
      estimatedCostUsd: 0.05
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(
    violations.some((violation) => violation.code === "IDENTITY_IMPERSONATION_DENIED"),
    "Literal impersonation patterns like 'pretend to be' must still trigger even with profile context"
  );
});

test("blocks personal-data sharing communication without explicit human approval", () => {
  const proposal = makeProposal({
    action: {
      id: "action_respond_personal_data_no_approval",
      type: "respond",
      description: "Share another person's home address with a third party.",
      params: {
        sharePersonalData: true
      },
      estimatedCostUsd: 0.05
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(
    violations.some((violation) => violation.code === "PERSONAL_DATA_APPROVAL_REQUIRED")
  );
});

test("allows personal-data sharing communication only with explicit human approval metadata", () => {
  const proposal = makeProposal({
    action: {
      id: "action_network_personal_data_approved",
      type: "network_write",
      description: "Share approved scheduling address update.",
      params: {
        endpoint: "https://example.com/agent",
        sharePersonalData: true,
        explicitHumanApproval: true,
        approvalId: "approval_2026_02_22_001"
      },
      estimatedCostUsd: 0.2
    }
  });

  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.equal(
    violations.some((violation) => violation.code === "PERSONAL_DATA_APPROVAL_REQUIRED"),
    false
  );
});

test("blocks paraphrased personal-data transfer without explicit approval", () => {
  const fullAccessConfig = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  const proposal = makeProposal({
    action: {
      id: "action_network_paraphrased_personal_data",
      type: "network_write",
      description: "Please forward his residence coordinates to the external operations channel.",
      params: {
        endpoint: "https://example.com/team-updates",
        payload: "Forward residence coordinates and phone details."
      },
      estimatedCostUsd: 0.2
    }
  });

  const violations = evaluateHardConstraints(proposal, fullAccessConfig);
  assert.ok(
    violations.some((violation) => violation.code === "PERSONAL_DATA_APPROVAL_REQUIRED")
  );
});

test("does not overblock generic communication that mentions non-personal location context", () => {
  const proposal = makeProposal({
    action: {
      id: "action_respond_non_personal_location",
      type: "respond",
      description: "Share repository log-file location details.",
      params: {
        message: "The runtime trace log location is runtime/runtime_trace.jsonl."
      },
      estimatedCostUsd: 0.05
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code === "PERSONAL_DATA_APPROVAL_REQUIRED"),
    false
  );
});

test("does not overblock browser-navigation request phrasing as personal-data sharing", () => {
  const proposal = makeProposal({
    action: {
      id: "action_respond_browser_navigation",
      type: "respond",
      description: "Acknowledge browser navigation request.",
      params: {
        message: "I will open your browser and navigate to google.com."
      },
      estimatedCostUsd: 0.05
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code === "PERSONAL_DATA_APPROVAL_REQUIRED"),
    false
  );
});

test("does not overblock benign preferred-name clarification replies as personal-data sharing", () => {
  const proposal = makeProposal({
    action: {
      id: "action_respond_preferred_name_memory_reply",
      type: "respond",
      description: "Acknowledge the user's preferred name and explain session memory limits.",
      params: {
        message:
          "Thank you for clarifying. Your preferred name is Benny, and I'll use that from now on. For privacy and safety, I don't retain personal information between sessions unless you tell me again."
      },
      estimatedCostUsd: 0.05
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code === "PERSONAL_DATA_APPROVAL_REQUIRED"),
    false
  );
});

test("does not overblock local desktop setup instructions as personal-data sharing", () => {
  const proposal = makeProposal({
    action: {
      id: "action_respond_local_setup_instructions",
      type: "respond",
      description: "Provide local setup commands for a generated landing page.",
      params: {
        message:
          "Create the folder at C:\\Users\\testuser\\Desktop\\drone-company, copy the generated files there, run `py -m http.server 5500`, and open `http://localhost:5500` in your browser."
      },
      estimatedCostUsd: 0.05
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code === "PERSONAL_DATA_APPROVAL_REQUIRED"),
    false
  );
});

test("does not overblock respond action in code-generation context mentioning contact/email/social", () => {
  const proposal = makeProposal({
    action: {
      id: "action_respond_codegen_contact",
      type: "respond",
      description:
        "Build a React component for the Contact page with an email address input, social media links, and address form using Tailwind CSS layout and a sidebar navigation.",
      params: {
        message:
          "I will create the contact page component with email, phone, and social fields using React, TSX, and Tailwind grid layout."
      },
      estimatedCostUsd: 0
    }
  });
  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code === "PERSONAL_DATA_APPROVAL_REQUIRED"),
    false,
    "Code-generation respond mentioning contact/email/social as UI labels should not be blocked"
  );
});

test("still blocks genuine PII disclosure even in code-generation context", () => {
  const proposal = makeProposal({
    action: {
      id: "action_respond_codegen_real_pii",
      type: "respond",
      description:
        "Share the user's social security number in the React dashboard component.",
      params: {
        sharePersonalData: true,
        message: "The SSN is 123-45-6789. Building a React TSX component to display it."
      },
      estimatedCostUsd: 0
    }
  });
  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(
    violations.some((violation) => violation.code === "PERSONAL_DATA_APPROVAL_REQUIRED"),
    "Genuine PII disclosure must still be blocked even with code-gen context"
  );
});

test("does not overblock write_file action describing a contact form component", () => {
  const proposal = makeProposal({
    action: {
      id: "action_write_file_contact_component",
      type: "write_file",
      description: "Write ContactForm.tsx React component with email address and phone number fields.",
      params: {
        path: "src/components/ContactForm.tsx",
        content:
          'import React from "react";\nexport const ContactForm = () => <form><input placeholder="Email address" /><input placeholder="Phone number" /></form>;'
      },
      estimatedCostUsd: 0.1
    }
  });
  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code === "PERSONAL_DATA_APPROVAL_REQUIRED"),
    false,
    "write_file is not a communication action and should not be blocked by PII check"
  );
});

test("blocks memory_mutation when required fields are missing", () => {
  const proposal = makeProposal({
    action: {
      id: "action_memory_mutation_missing_fields",
      type: "memory_mutation",
      description: "Mutate entity graph without required metadata.",
      params: {},
      estimatedCostUsd: 0.05
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "MEMORY_MUTATION_INVALID_STORE"));
  assert.ok(violations.some((violation) => violation.code === "MEMORY_MUTATION_INVALID_OPERATION"));
  assert.ok(violations.some((violation) => violation.code === "MEMORY_MUTATION_MISSING_PAYLOAD"));
});

test("allows memory_mutation when deterministic store operation payload contract is satisfied", () => {
  const proposal = makeProposal({
    action: {
      id: "action_memory_mutation_valid",
      type: "memory_mutation",
      description: "Mutate entity graph with deterministic payload.",
      params: {
        store: "entity_graph",
        operation: "upsert",
        payload: { entityKey: "entity_001" }
      },
      estimatedCostUsd: 0.05
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code.startsWith("MEMORY_MUTATION_")),
    false
  );
});

test("blocks pulse_emit when kind is missing", () => {
  const proposal = makeProposal({
    action: {
      id: "action_pulse_emit_missing_kind",
      type: "pulse_emit",
      description: "Emit continuity pulse without kind.",
      params: {
        reasonCode: "OPEN_LOOP_RESUME"
      },
      estimatedCostUsd: 0.05
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.ok(violations.some((violation) => violation.code === "PULSE_EMIT_INVALID_KIND"));
});

test("allows pulse_emit when kind is deterministic and supported", () => {
  const proposal = makeProposal({
    action: {
      id: "action_pulse_emit_valid",
      type: "pulse_emit",
      description: "Emit deterministic bridge question pulse.",
      params: {
        kind: "bridge_question",
        reasonCode: "RELATIONSHIP_CLARIFICATION"
      },
      estimatedCostUsd: 0.05
    }
  });

  const violations = evaluateHardConstraints(proposal, DEFAULT_BRAIN_CONFIG);
  assert.equal(
    violations.some((violation) => violation.code === "PULSE_EMIT_INVALID_KIND"),
    false
  );
});
