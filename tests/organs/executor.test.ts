/**
 * @fileoverview Tests executor behavior for sandboxed skill creation safeguards.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createBrainConfigFromEnv, BrainConfig } from "../../src/core/config";
import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { PlannedAction } from "../../src/core/types";
import { ToolExecutorOrgan } from "../../src/organs/executor";

/**
 * Implements `withTempCwd` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withTempCwd(callback: (tempDir: string) => Promise<void>): Promise<void> {
  const originalCwd = process.cwd();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-executor-"));
  process.chdir(tempDir);
  try {
    await callback(tempDir);
  } finally {
    process.chdir(originalCwd);
    await removeTempDirWithRetry(tempDir);
  }
}

/**
 * Implements `removeTempDirWithRetry` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function removeTempDirWithRetry(tempDir: string): Promise<void> {
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await rm(tempDir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY") {
        throw error;
      }
      if (attempt === maxAttempts) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 75));
    }
  }
}

/**
 * Implements `buildCreateSkillAction` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildCreateSkillAction(name: string, code: string): PlannedAction {
  return {
    id: "action_create_skill",
    type: "create_skill",
    description: "create skill",
    params: { name, code },
    estimatedCostUsd: 0.1
  };
}

/**
 * Implements `buildRunSkillAction` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildRunSkillAction(name: string, input: string): PlannedAction {
  return {
    id: "action_run_skill",
    type: "run_skill",
    description: "run skill",
    params: { name, input },
    estimatedCostUsd: 0.1
  };
}

/**
 * Implements `buildMemoryMutationAction` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildMemoryMutationAction(): PlannedAction {
  return {
    id: "action_memory_mutation",
    type: "memory_mutation",
    description: "stage 6.86 memory mutation action",
    params: {
      store: "semantic_memory",
      operation: "upsert",
      payload: { lesson: "keep governance deterministic" },
      evidenceRefs: ["trace:test:memory_mutation"]
    },
    estimatedCostUsd: 0.1
  };
}

/**
 * Implements `buildPulseEmitAction` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildPulseEmitAction(): PlannedAction {
  return {
    id: "action_pulse_emit",
    type: "pulse_emit",
    description: "stage 6.86 pulse emit action",
    params: {
      kind: "topic_resume",
      topic: "runtime wiring progress",
      reasonCode: "contextual_followup",
      evidenceRefs: ["trace:test:pulse_emit"]
    },
    estimatedCostUsd: 0.1
  };
}

/**
 * Implements `buildShellAction` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildShellAction(
  command: string,
  overrides: Record<string, unknown> = {}
): PlannedAction {
  return {
    id: "action_shell_command",
    type: "shell_command",
    description: "run deterministic shell command",
    params: {
      command,
      ...overrides
    },
    estimatedCostUsd: 0.1
  };
}

interface MockShellSpawnResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  signal?: NodeJS.Signals | null;
  error?: Error;
}

interface MockShellSpawnCall {
  executable: string;
  args: readonly string[];
  options: Record<string, unknown>;
}

/**
 * Implements `createMockShellSpawn` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function createMockShellSpawn(result: MockShellSpawnResult): {
  calls: MockShellSpawnCall[];
  spawn: typeof import("node:child_process").spawn;
} {
  const calls: MockShellSpawnCall[] = [];
  const spawn = ((
    executable: string,
    argsOrOptions?: unknown,
    maybeOptions?: unknown
  ) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const options = (
      Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions
    ) as Record<string, unknown> | undefined;
    calls.push({
      executable,
      args,
      options: options ?? {}
    });

    const child = new EventEmitter() as import("node:child_process").ChildProcessWithoutNullStreams;
    child.stdout = new EventEmitter() as unknown as import("node:stream").Readable;
    child.stderr = new EventEmitter() as unknown as import("node:stream").Readable;
    child.kill = (() => true) as unknown as (
      signal?: NodeJS.Signals | number | undefined
    ) => boolean;

    queueMicrotask(() => {
      if (result.error) {
        child.emit("error", result.error);
        return;
      }
      if (result.stdout) {
        (child.stdout as EventEmitter).emit("data", Buffer.from(result.stdout, "utf8"));
      }
      if (result.stderr) {
        (child.stderr as EventEmitter).emit("data", Buffer.from(result.stderr, "utf8"));
      }
      child.emit("close", result.exitCode ?? 0, result.signal ?? null);
    });

    return child;
  }) as unknown as typeof import("node:child_process").spawn;

  return {
    calls,
    spawn
  };
}

/**
 * Implements `buildShellEnabledConfig` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildShellEnabledConfig(overrides: Partial<BrainConfig> = {}): BrainConfig {
  const fullAccess = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });
  return {
    ...fullAccess,
    ...overrides,
    permissions: {
      ...fullAccess.permissions,
      allowRealShellExecution: true,
      ...(overrides.permissions ?? {})
    },
    shellRuntime: {
      ...fullAccess.shellRuntime,
      ...(overrides.shellRuntime ?? {}),
      profile: {
        ...fullAccess.shellRuntime.profile,
        ...(overrides.shellRuntime?.profile ?? {})
      }
    }
  };
}

test("ToolExecutorOrgan blocks invalid skill name", async () => {
  await withTempCwd(async () => {
    const executor = new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG);
    const output = await executor.execute(
      buildCreateSkillAction("../escape", "export const skill = true;")
    );
    assert.match(output, /invalid skill name/i);
  });
});

test("ToolExecutorOrgan writes valid skill into runtime/skills", async () => {
  await withTempCwd(async (tempDir) => {
    const executor = new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG);
    const output = await executor.execute(
      buildCreateSkillAction("safe_skill", "export const safeSkill = true;")
    );
    assert.match(output, /Skill created successfully/i);

    const createdPath = path.join(tempDir, "runtime", "skills", "safe_skill.ts");
    const content = await readFile(createdPath, "utf8");
    assert.equal(content.includes("safeSkill"), true);
  });
});

test("ToolExecutorOrgan runs previously created skill", async () => {
  await withTempCwd(async () => {
    const executor = new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG);
    await executor.execute(
      buildCreateSkillAction(
        "safe_skill",
        "export function safeSkill(input: string): string { return input.trim().toUpperCase(); }"
      )
    );

    const output = await executor.execute(buildRunSkillAction("safe_skill", "  hello world  "));
    assert.match(output, /Run skill success:/i);
    assert.match(output, /HELLO WORLD/);
  });
});

test("ToolExecutorOrgan fails closed for direct memory_mutation execution", async () => {
  await withTempCwd(async () => {
    const executor = new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG);
    const output = await executor.execute(buildMemoryMutationAction());
    assert.match(output, /must execute through TaskRunner runtime action engine/i);
  });
});

test("ToolExecutorOrgan fails closed for direct pulse_emit execution", async () => {
  await withTempCwd(async () => {
    const executor = new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG);
    const output = await executor.execute(buildPulseEmitAction());
    assert.match(output, /must execute through TaskRunner runtime action engine/i);
  });
});

test("ToolExecutorOrgan runs shell command through deterministic bash wrapper and records telemetry", async () => {
  await withTempCwd(async () => {
    const mockSpawn = createMockShellSpawn({
      stdout: "hello\n",
      exitCode: 0
    });
    const config = buildShellEnabledConfig({
      shellRuntime: {
        ...DEFAULT_BRAIN_CONFIG.shellRuntime,
        profile: {
          ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile,
          shellKind: "bash",
          executable: "bash",
          wrapperArgs: ["-lc"],
          cwdPolicy: {
            ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.cwdPolicy,
            denyOutsideSandbox: false
          }
        }
      }
    });
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const action = buildShellAction("echo hello");
    const output = await executor.execute(action);

    assert.match(output, /Shell success/i);
    assert.equal(mockSpawn.calls.length, 1);
    assert.equal(mockSpawn.calls[0].executable, "bash");
    assert.deepEqual(mockSpawn.calls[0].args, ["-lc", "echo hello"]);

    const telemetry = executor.consumeShellExecutionTelemetry(action.id);
    assert.ok(telemetry);
    assert.equal(telemetry?.shellKind, "bash");
    assert.equal(typeof telemetry?.shellProfileFingerprint, "string");
    assert.equal(typeof telemetry?.shellSpawnSpecFingerprint, "string");
    assert.equal(telemetry?.shellExitCode, 0);
    assert.equal(telemetry?.shellTimedOut, false);
  });
});

test("ToolExecutorOrgan enforces timeout fallback and reports shell failure exit code", async () => {
  await withTempCwd(async () => {
    const mockSpawn = createMockShellSpawn({
      stderr: "boom\n",
      exitCode: 2
    });
    const config = buildShellEnabledConfig({
      shellRuntime: {
        ...DEFAULT_BRAIN_CONFIG.shellRuntime,
        profile: {
          ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile,
          shellKind: "cmd",
          executable: "cmd.exe",
          wrapperArgs: ["/d", "/s", "/c"],
          cwdPolicy: {
            ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.cwdPolicy,
            denyOutsideSandbox: false
          }
        }
      }
    });
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const action = buildShellAction("echo hello", { timeoutMs: 9999999 });
    const output = await executor.execute(action);

    assert.match(output, /Shell failed \(exit code 2\)/i);
    assert.equal(mockSpawn.calls.length, 1);
    assert.deepEqual(mockSpawn.calls[0].args, ["/d", "/s", "/c", "echo hello"]);
    const telemetry = executor.consumeShellExecutionTelemetry(action.id);
    assert.equal(telemetry?.shellExitCode, 2);
    assert.equal(telemetry?.shellTimedOut, false);
    assert.equal(telemetry?.shellTimeoutMs, config.shellRuntime.profile.timeoutMsDefault);
  });
});
