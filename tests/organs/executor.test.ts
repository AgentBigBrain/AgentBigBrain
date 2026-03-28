/**
 * @fileoverview Tests executor behavior for sandboxed skill creation safeguards.
 */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as http from "node:http";
import * as net from "node:net";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { createBrainConfigFromEnv, BrainConfig } from "../../src/core/config";
import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { PlannedAction } from "../../src/core/types";
import {
  BrowserVerificationResult,
  BrowserVerifier,
  VerifyBrowserRequest
} from "../../src/organs/liveRun/browserVerifier";
import type { PlaywrightChromiumRuntime } from "../../src/organs/liveRun/playwrightRuntime";
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
function buildCreateSkillAction(
  name: string,
  code: string,
  overrides: Record<string, unknown> = {}
): PlannedAction {
  return {
    id: "action_create_skill",
    type: "create_skill",
    description: "create skill",
    params: { name, code, ...overrides },
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
 * Implements `buildWriteFileAction` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildWriteFileAction(pathValue: string, content?: string): PlannedAction {
  return {
    id: "action_write_file",
    type: "write_file",
    description: "write file",
    params: typeof content === "string" ? { path: pathValue, content } : { path: pathValue },
    estimatedCostUsd: 0.1
  };
}

/**
 * Implements `buildReadFileAction` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildReadFileAction(pathValue: string): PlannedAction {
  return {
    id: "action_read_file",
    type: "read_file",
    description: "read file",
    params: { path: pathValue },
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
      store: "entity_graph",
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

/**
 * Implements `buildStartProcessAction` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildStartProcessAction(
  command?: string,
  overrides: Record<string, unknown> = {}
): PlannedAction {
  return {
    id: "action_start_process",
    type: "start_process",
    description: "start managed process",
    params: {
      ...(typeof command === "string" ? { command } : {}),
      ...overrides
    },
    estimatedCostUsd: 0.1
  };
}

/**
 * Implements `buildCheckProcessAction` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildCheckProcessAction(leaseId?: string): PlannedAction {
  return {
    id: "action_check_process",
    type: "check_process",
    description: "check managed process",
    params: typeof leaseId === "string" ? { leaseId } : {},
    estimatedCostUsd: 0.04
  };
}

/**
 * Implements `buildStopProcessAction` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildStopProcessAction(leaseId?: string): PlannedAction {
  return {
    id: "action_stop_process",
    type: "stop_process",
    description: "stop managed process",
    params: typeof leaseId === "string" ? { leaseId } : {},
    estimatedCostUsd: 0.12
  };
}

/**
 * Implements `buildProbePortAction` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildProbePortAction(port?: number, host = "127.0.0.1"): PlannedAction {
  return {
    id: "action_probe_port",
    type: "probe_port",
    description: "probe local tcp port",
    params: {
      ...(typeof host === "string" ? { host } : {}),
      ...(typeof port === "number" ? { port } : {})
    },
    estimatedCostUsd: 0.03
  };
}

/**
 * Implements `buildProbeHttpAction` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildProbeHttpAction(
  url?: string,
  expectedStatus?: number
): PlannedAction {
  return {
    id: "action_probe_http",
    type: "probe_http",
    description: "probe local http endpoint",
    params: {
      ...(typeof url === "string" ? { url } : {}),
      ...(typeof expectedStatus === "number" ? { expectedStatus } : {})
    },
    estimatedCostUsd: 0.04
  };
}

/**
 * Implements `buildVerifyBrowserAction` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildVerifyBrowserAction(
  url?: string,
  overrides: Record<string, unknown> = {}
): PlannedAction {
  return {
    id: "action_verify_browser",
    type: "verify_browser",
    description: "verify loopback browser page",
    params: {
      ...(typeof url === "string" ? { url } : {}),
      ...overrides
    },
    estimatedCostUsd: 0.09
  };
}

/**
 * Implements `buildOpenBrowserAction` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildOpenBrowserAction(url?: string): PlannedAction {
  return {
    id: "action_open_browser",
    type: "open_browser",
    description: "open verified page in visible browser",
    params: {
      ...(typeof url === "string" ? { url } : {})
    },
    estimatedCostUsd: 0.03
  };
}

/**
 * Implements `buildCloseBrowserAction` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildCloseBrowserAction(
  overrides: Record<string, unknown> = {}
): PlannedAction {
  return {
    id: "action_close_browser",
    type: "close_browser",
    description: "close tracked browser window",
    params: {
      ...overrides
    },
    estimatedCostUsd: 0.02
  };
}

async function withLocalTcpServer(callback: (port: number) => Promise<void>): Promise<void> {
  const server = net.createServer((socket) => {
    socket.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await callback(address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function withUnusedTcpPort(callback: (port: number) => Promise<void>): Promise<void> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await callback(port);
}

async function withLocalHttpServer(
  statusCode: number,
  callback: (url: string) => Promise<void>
): Promise<void> {
  const server = http.createServer((_request, response) => {
    response.statusCode = statusCode;
    response.end("ok");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    await callback(`http://127.0.0.1:${address.port}/`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

interface MockShellSpawnResult {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  signal?: NodeJS.Signals | null;
  error?: Error;
  stdoutError?: Error;
  stderrError?: Error;
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
      if (result.stdoutError) {
        (child.stdout as EventEmitter).emit("error", result.stdoutError);
        return;
      }
      if (result.stderrError) {
        (child.stderr as EventEmitter).emit("error", result.stderrError);
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

function createManagedProcessShellSpawn(): {
  calls: MockShellSpawnCall[];
  getKillCount: () => number;
  spawn: typeof import("node:child_process").spawn;
} {
  const calls: MockShellSpawnCall[] = [];
  let killCount = 0;
  let latestManagedChild:
    | import("node:child_process").ChildProcessWithoutNullStreams
    | null = null;
  const spawn = ((
    executable: string,
    argsOrOptions?: unknown,
    maybeOptions?: unknown
  ) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const options = (
      Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions
    ) as Record<string, unknown> | undefined;
    if (executable.toLowerCase() === "taskkill") {
      killCount += 1;
      calls.push({
        executable,
        args,
        options: options ?? {}
      });

      const killer = new EventEmitter() as import("node:child_process").ChildProcessWithoutNullStreams;
      killer.stdout = new EventEmitter() as unknown as import("node:stream").Readable;
      killer.stderr = new EventEmitter() as unknown as import("node:stream").Readable;
      queueMicrotask(() => {
        latestManagedChild?.emit("close", 0, "SIGTERM");
        killer.emit("close", 0, null);
      });
      return killer;
    }
    calls.push({
      executable,
      args,
      options: options ?? {}
    });

    const child = new EventEmitter() as import("node:child_process").ChildProcessWithoutNullStreams;
    const stdout = new EventEmitter() as unknown as import("node:stream").Readable & {
      resume?: () => void;
    };
    const stderr = new EventEmitter() as unknown as import("node:stream").Readable & {
      resume?: () => void;
    };
    const stdin = new EventEmitter() as unknown as import("node:stream").Writable;
    stdout.resume = () => stdout;
    stderr.resume = () => stderr;
    child.stdin = stdin;
    child.stdout = stdout;
    child.stderr = stderr;
    Object.defineProperty(child, "pid", { value: 4242, writable: true });
    child.kill = (() => {
      killCount += 1;
      queueMicrotask(() => {
        child.emit("close", 0, "SIGTERM");
      });
      return true;
    }) as unknown as (signal?: NodeJS.Signals | number | undefined) => boolean;
    latestManagedChild = child;

    queueMicrotask(() => {
      child.emit("spawn");
    });

    return child;
  }) as unknown as typeof import("node:child_process").spawn;

  return {
    calls,
    getKillCount: () => killCount,
    spawn
  };
}

function createAbortableShellSpawn(): {
  calls: MockShellSpawnCall[];
  getKillCount: () => number;
  spawn: typeof import("node:child_process").spawn;
} {
  const calls: MockShellSpawnCall[] = [];
  let killCount = 0;
  const spawn = ((
    executable: string,
    argsOrOptions?: unknown,
    maybeOptions?: unknown
  ) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const options = (
      Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions
    ) as Record<string, unknown> | undefined;
    if (executable.toLowerCase() === "taskkill") {
      killCount += 1;
      calls.push({
        executable,
        args,
        options: options ?? {}
      });

      const killer = new EventEmitter() as import("node:child_process").ChildProcessWithoutNullStreams;
      killer.stdout = new EventEmitter() as unknown as import("node:stream").Readable;
      killer.stderr = new EventEmitter() as unknown as import("node:stream").Readable;
      queueMicrotask(() => {
        killer.emit("close", 0, null);
      });
      return killer;
    }
    calls.push({
      executable,
      args,
      options: options ?? {}
    });

    const child = new EventEmitter() as import("node:child_process").ChildProcessWithoutNullStreams;
    child.stdout = new EventEmitter() as unknown as import("node:stream").Readable;
    child.stderr = new EventEmitter() as unknown as import("node:stream").Readable;
    child.kill = (() => {
      killCount += 1;
      queueMicrotask(() => {
        child.emit("close", null, "SIGTERM");
      });
      return true;
    }) as unknown as (signal?: NodeJS.Signals | number | undefined) => boolean;

    return child;
  }) as unknown as typeof import("node:child_process").spawn;

  return {
    calls,
    getKillCount: () => killCount,
    spawn
  };
}

class MockBrowserVerifier implements BrowserVerifier {
  public readonly requests: VerifyBrowserRequest[] = [];

  /**
   * Initializes class MockBrowserVerifier dependencies and runtime state.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  constructor(private readonly result: BrowserVerificationResult) {}

  /**
   * Implements `verify` behavior within class MockBrowserVerifier.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  async verify(request: VerifyBrowserRequest): Promise<BrowserVerificationResult> {
    this.requests.push(request);
    return this.result;
  }
}

function createStubPlaywrightRuntime(): {
  runtime: PlaywrightChromiumRuntime;
  getPageCloseCount: () => number;
  getContextCloseCount: () => number;
  getBrowserCloseCount: () => number;
} {
  let pageCloseCount = 0;
  let contextCloseCount = 0;
  let browserCloseCount = 0;

  const page = {
    async goto(): Promise<void> {
      return;
    },
    async title(): Promise<string> {
      return "stub";
    },
    async textContent(): Promise<string> {
      return "stub";
    },
    async bringToFront(): Promise<void> {
      return;
    },
    async reload(): Promise<void> {
      return;
    },
    async close(): Promise<void> {
      pageCloseCount += 1;
    }
  };

  const context = {
    async newPage() {
      return page;
    },
    async close(): Promise<void> {
      contextCloseCount += 1;
    }
  };

  const browser = {
    async newContext() {
      return context;
    },
    async close(): Promise<void> {
      browserCloseCount += 1;
    }
  };

  return {
    runtime: {
      chromium: {
        async launch(): Promise<typeof browser> {
          return browser;
        }
      },
      sourceModule: "playwright"
    },
    getPageCloseCount: () => pageCloseCount,
    getContextCloseCount: () => contextCloseCount,
    getBrowserCloseCount: () => browserCloseCount
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

/**
 * Builds a shell-enabled config that deterministically exercises Windows PowerShell/npm behavior
 * regardless of the host platform running the tests.
 */
function buildWindowsPowerShellShellEnabledConfig(
  overrides: Partial<BrainConfig> = {}
): BrainConfig {
  return buildShellEnabledConfig({
    ...overrides,
    shellRuntime: {
      ...DEFAULT_BRAIN_CONFIG.shellRuntime,
      ...(overrides.shellRuntime ?? {}),
      profile: {
        ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile,
        platform: "win32",
        shellKind: "powershell",
        executable: "powershell.exe",
        wrapperArgs: ["-NoProfile", "-NonInteractive", "-Command"],
        cwdPolicy: {
          ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.cwdPolicy,
          denyOutsideSandbox: false,
          ...(overrides.shellRuntime?.profile?.cwdPolicy ?? {})
        },
        ...(overrides.shellRuntime?.profile ?? {})
      }
    }
  });
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
    assert.match(output, /safe_skill\.js/i);

    const primaryPath = path.join(tempDir, "runtime", "skills", "safe_skill.js");
    const compatibilityPath = path.join(tempDir, "runtime", "skills", "safe_skill.ts");
    const primaryContent = await readFile(primaryPath, "utf8");
    const compatibilityContent = await readFile(compatibilityPath, "utf8");
    assert.equal(primaryContent.includes("safeSkill"), true);
    assert.equal(compatibilityContent.includes("safeSkill"), true);
  });
});

test("ToolExecutorOrgan records skill manifests and marks verified skills as trusted for reuse", async () => {
  await withTempCwd(async (tempDir) => {
    const executor = new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG);
    const outcome = await executor.executeWithOutcome(
      buildCreateSkillAction(
        "verified_skill",
        "export function verifiedSkill(input: string): string { return `Hello ${input.trim()}`; }",
        {
          description: "Return a greeting for the provided input.",
          purpose: "Reusable greeting helper for deterministic text workflows.",
          userSummary: "Reusable tool for simple greeting generation.",
          invocationHints: ["Ask me to run skill verified_skill."],
          riskLevel: "low",
          tags: ["greeting", "text"],
          testInput: "Benny",
          expectedOutputContains: "Hello Benny"
        }
      )
    );

    assert.equal(outcome.status, "success");
    assert.equal(outcome.executionMetadata?.skillName, "verified_skill");
    assert.equal(outcome.executionMetadata?.skillVerificationStatus, "verified");
    assert.equal(outcome.executionMetadata?.skillTrustedForReuse, true);
    assert.equal(typeof outcome.executionMetadata?.skillManifestPath, "string");

    const manifestPath = path.join(tempDir, "runtime", "skills", "verified_skill.manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    assert.equal(manifest.name, "verified_skill");
    assert.equal(manifest.verificationStatus, "verified");
    assert.equal(manifest.userSummary, "Reusable tool for simple greeting generation.");
    assert.deepEqual(manifest.invocationHints, ["Ask me to run skill verified_skill."]);
    assert.equal(manifest.verificationFailureReason, null);

    const runOutcome = await executor.executeWithOutcome(
      buildRunSkillAction("verified_skill", "Benny")
    );
    assert.equal(runOutcome.status, "success");
    assert.equal(runOutcome.executionMetadata?.skillVerificationStatus, "verified");
    assert.equal(runOutcome.executionMetadata?.skillTrustedForReuse, true);
  });
});

test("ToolExecutorOrgan keeps failing skill verification explicit and untrusted", async () => {
  await withTempCwd(async (tempDir) => {
    const executor = new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG);
    const outcome = await executor.executeWithOutcome(
      buildCreateSkillAction(
        "failing_skill",
        "export function failingSkill(input: string): string { return input.trim().toUpperCase(); }",
        {
          testInput: "benny",
          expectedOutputContains: "hello"
        }
      )
    );

    assert.equal(outcome.status, "success");
    assert.equal(outcome.executionMetadata?.skillVerificationStatus, "failed");
    assert.equal(outcome.executionMetadata?.skillTrustedForReuse, false);
    assert.match(outcome.output, /Verification failed:/i);

    const manifestPath = path.join(tempDir, "runtime", "skills", "failing_skill.manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    assert.equal(manifest.verificationStatus, "failed");
    assert.equal(typeof manifest.verificationFailureReason, "string");

    const runOutcome = await executor.executeWithOutcome(
      buildRunSkillAction("failing_skill", "benny")
    );
    assert.equal(runOutcome.status, "success");
    assert.equal(runOutcome.executionMetadata?.skillVerificationStatus, "failed");
    assert.equal(runOutcome.executionMetadata?.skillTrustedForReuse, false);
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

test("ToolExecutorOrgan executeWithOutcome fails closed for write_file missing content", async () => {
  await withTempCwd(async () => {
    const executor = new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG);
    const outcome = await executor.executeWithOutcome(
      buildWriteFileAction("runtime/generated/missing-content.txt")
    );
    assert.equal(outcome.status, "blocked");
    assert.equal(outcome.failureCode, "ACTION_EXECUTION_FAILED");
    assert.match(outcome.output, /missing params\.content/i);
  });
});

test("ToolExecutorOrgan returns typed missing-artifact failure for run_skill", async () => {
  await withTempCwd(async () => {
    const executor = new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG);
    const outcome = await executor.executeWithOutcome(
      buildRunSkillAction("missing_skill", "hello world")
    );
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failureCode, "RUN_SKILL_ARTIFACT_MISSING");
    assert.match(outcome.output, /no skill artifact found/i);
  });
});

test("ToolExecutorOrgan executeWithOutcome returns bounded read_file preview with metadata", async () => {
  await withTempCwd(async () => {
    const executor = new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG);
    const readTarget = "runtime/read_target.txt";
    const readContent = `${"A".repeat(3995)}END`;
    const writeOutcome = await executor.executeWithOutcome(
      buildWriteFileAction(readTarget, readContent)
    );
    assert.equal(writeOutcome.status, "success");

    const outcome = await executor.executeWithOutcome(buildReadFileAction(readTarget));
    assert.equal(outcome.status, "success");
    assert.match(outcome.output, /Read success: runtime\/read_target\.txt \(\d+ chars\)\./i);
    assert.match(outcome.output, /Read preview:/i);
    assert.match(outcome.output, /A{20}/);
    assert.equal(outcome.executionMetadata?.readFileTotalChars, readContent.length);
    assert.equal(outcome.executionMetadata?.readFileReturnedChars, readContent.length);
    assert.equal(outcome.executionMetadata?.readFileTruncated, false);
  });
});

test("ToolExecutorOrgan executeWithOutcome marks read_file preview truncation deterministically", async () => {
  await withTempCwd(async () => {
    const executor = new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG);
    const readTarget = "runtime/read_target_large.txt";
    const readContent = "B".repeat(4500);
    const writeOutcome = await executor.executeWithOutcome(
      buildWriteFileAction(readTarget, readContent)
    );
    assert.equal(writeOutcome.status, "success");

    const outcome = await executor.executeWithOutcome(buildReadFileAction(readTarget));
    assert.equal(outcome.status, "success");
    assert.match(outcome.output, /truncated to 4000/i);
    assert.match(outcome.output, /\[\.\.\.truncated\]/i);
    assert.equal(outcome.executionMetadata?.readFileTotalChars, readContent.length);
    assert.equal(outcome.executionMetadata?.readFileReturnedChars, 4000);
    assert.equal(outcome.executionMetadata?.readFileTruncated, true);
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
    assert.equal(mockSpawn.calls[0].options.windowsVerbatimArguments, false);

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
          wrapperArgs: ["/d", "/c"],
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
    assert.deepEqual(mockSpawn.calls[0].args, ["/d", "/c", "echo hello"]);
    assert.equal(mockSpawn.calls[0].options.windowsVerbatimArguments, true);
    const telemetry = executor.consumeShellExecutionTelemetry(action.id);
    assert.equal(telemetry?.shellExitCode, 2);
    assert.equal(telemetry?.shellTimedOut, false);
    assert.equal(telemetry?.shellTimeoutMs, config.shellRuntime.profile.timeoutMsDefault);
  });
});

test("ToolExecutorOrgan treats known Move-Item file-lock stderr as a shell failure even when exit code is zero", async () => {
  await withTempCwd(async () => {
    const mockSpawn = createMockShellSpawn({
      stdout: "drone-company\r\n",
      stderr:
        "Move-Item : The process cannot access the file because it is being used by another process.\r\n" +
        "FullyQualifiedErrorId : MoveDirectoryItemIOError,Microsoft.PowerShell.Commands.MoveItemCommand\r\n",
      exitCode: 0
    });
    const config = buildShellEnabledConfig({
      shellRuntime: {
        ...DEFAULT_BRAIN_CONFIG.shellRuntime,
        profile: {
          ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile,
          shellKind: "powershell",
          executable: "powershell.exe",
          wrapperArgs: ["-NoProfile", "-NonInteractive", "-Command"],
          cwdPolicy: {
            ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.cwdPolicy,
            denyOutsideSandbox: false
          }
        }
      }
    });
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const output = await executor.execute(
      buildShellAction("Move-Item -Path source -Destination dest")
    );

    assert.match(output, /Shell failed:/i);
    assert.match(output, /used by another process/i);
    const telemetry = executor.consumeShellExecutionTelemetry("action_shell_command");
    assert.equal(telemetry?.shellExitCode, 0);
    assert.equal(telemetry?.shellKind, "powershell");
  });
});

test("ToolExecutorOrgan routes Windows npm commands through cmd and fails closed when Vite scaffold artifacts are missing", async () => {
  await withTempCwd(async () => {
    const mockSpawn = createMockShellSpawn({
      exitCode: 0
    });
    const config = buildWindowsPowerShellShellEnabledConfig();
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const outcome = await executor.executeWithOutcome(
      buildShellAction('npm create vite@latest "AI Drone City" -- --template react')
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failureCode, "ACTION_EXECUTION_FAILED");
    assert.match(outcome.output, /did not create the expected package\.json/i);
    assert.equal(mockSpawn.calls.length, 1);
    assert.equal(mockSpawn.calls[0].executable, "powershell.exe");
    assert.deepEqual(mockSpawn.calls[0].args, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      'npm.cmd create vite@latest "AI Drone City" -- --template react; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }'
    ]);
    assert.equal(mockSpawn.calls[0].options.windowsVerbatimArguments, false);
    const telemetry = executor.consumeShellExecutionTelemetry("action_shell_command");
    assert.equal(telemetry?.shellKind, "powershell");
  });
});

test("ToolExecutorOrgan fails closed when embedded PowerShell Vite scaffold leaves package.json missing", async () => {
  await withTempCwd(async (tempDir) => {
    const mockSpawn = createMockShellSpawn({
      exitCode: 0
    });
    const config = buildWindowsPowerShellShellEnabledConfig();
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const outcome = await executor.executeWithOutcome(
      buildShellAction(
        `$desktop='${tempDir.replace(/\\/g, "\\\\")}'; ` +
        `Set-Location $desktop; npm create vite@latest 'AI Drone City' -- --template react`
      )
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failureCode, "ACTION_EXECUTION_FAILED");
    assert.match(outcome.output, /did not create the expected package\.json/i);
    assert.equal(mockSpawn.calls.length, 1);
    assert.equal(mockSpawn.calls[0].executable, "powershell.exe");
  });
});

test("ToolExecutorOrgan resolves Set-Location before validating in-place PowerShell Vite scaffold artifacts", async () => {
  await withTempCwd(async (tempDir) => {
    const projectDir = path.join(tempDir, "AI Drone City");
    await mkdir(projectDir, { recursive: true });
    const mockSpawn = createMockShellSpawn({
      exitCode: 0
    });
    const config = buildWindowsPowerShellShellEnabledConfig();
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const outcome = await executor.executeWithOutcome(
      buildShellAction(
        `$p='${projectDir.replace(/\\/g, "\\\\")}'; ` +
        "Set-Location $p; npm create vite@latest . -- --template react"
      )
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failureCode, "ACTION_EXECUTION_FAILED");
    assert.match(outcome.output, /expected package\.json at /i);
    assert.match(outcome.output, /AI Drone City[\\/]package\.json/i);
  });
});

test("ToolExecutorOrgan treats npm.ps1 LASTEXITCODE wrapper errors as shell failure even when exit code is zero", async () => {
  await withTempCwd(async () => {
    const mockSpawn = createMockShellSpawn({
      stderr:
        "The variable '$LASTEXITCODE' cannot be retrieved because it has not been set.\r\n" +
        "At C:\\Program Files\\nodejs\\npm.ps1:17 char:5\r\n" +
        "FullyQualifiedErrorId : VariableIsUndefined\r\n",
      exitCode: 0
    });
    const config = buildWindowsPowerShellShellEnabledConfig();
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const outcome = await executor.executeWithOutcome(buildShellAction("$env:FOO='bar'; npm install"));

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failureCode, "ACTION_EXECUTION_FAILED");
    assert.match(outcome.output, /Shell failed:/i);
    assert.match(outcome.output, /LASTEXITCODE/i);
  });
});

test("ToolExecutorOrgan rewrites embedded Windows PowerShell npm invocations to npm.cmd", async () => {
  await withTempCwd(async () => {
    const mockSpawn = createMockShellSpawn({
      stdout: "installed\n",
      exitCode: 0
    });
    const config = buildWindowsPowerShellShellEnabledConfig();
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const outcome = await executor.executeWithOutcome(
      buildShellAction("$target='C:\\\\Temp\\\\AI Drone City'; npm install --prefix \"$target\"")
    );

    assert.equal(outcome.status, "success");
    assert.equal(mockSpawn.calls.length, 1);
    assert.equal(mockSpawn.calls[0].executable, "powershell.exe");
    assert.match(
      String(mockSpawn.calls[0].args[3]),
      /\$target='C:\\\\Temp\\\\AI Drone City'; npm\.cmd install --prefix \"\$target\"; if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/i
    );
  });
});

test("ToolExecutorOrgan keeps PowerShell multi-step npm scripts on PowerShell while rewriting npm to npm.cmd", async () => {
  await withTempCwd(async (tempDir) => {
    await writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        name: "ai-drone-city",
        private: true,
        scripts: {
          build: "vite build"
        },
        devDependencies: {
          vite: "^7.0.0"
        }
      })
    );
    await mkdir(path.join(tempDir, "dist"), { recursive: true });
    await writeFile(path.join(tempDir, "dist", "index.html"), "<!doctype html><title>AI Drone City</title>");
    const mockSpawn = createMockShellSpawn({
      stdout: "installed\nbuilt\n",
      exitCode: 0
    });
    const config = buildWindowsPowerShellShellEnabledConfig();
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const outcome = await executor.executeWithOutcome(
      buildShellAction("npm install; npm run build; Write-Output 'done'")
    );

    assert.equal(outcome.status, "success");
    assert.equal(mockSpawn.calls.length, 1);
    assert.equal(mockSpawn.calls[0].executable, "powershell.exe");
    assert.match(
      String(mockSpawn.calls[0].args[3]),
      /npm\.cmd install;\s*if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \};\s*npm\.cmd run build;\s*if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \};\s*write-output 'done'/i
    );
  });
});

test("ToolExecutorOrgan emits native recovery metadata when shell spawn cannot resolve the executable", async () => {
  await withTempCwd(async () => {
    const spawnError = Object.assign(new Error("spawn ENOENT"), {
      code: "ENOENT"
    });
    const mockSpawn = createMockShellSpawn({
      error: spawnError
    });
    const config = buildShellEnabledConfig({
      shellRuntime: {
        ...DEFAULT_BRAIN_CONFIG.shellRuntime,
        profile: {
          ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile,
          shellKind: "cmd",
          executable: "cmd.exe",
          wrapperArgs: ["/d", "/c"],
          cwdPolicy: {
            ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.cwdPolicy,
            denyOutsideSandbox: false
          }
        }
      }
    });
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const outcome = await executor.executeWithOutcome(buildShellAction("npm run dev"));

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failureCode, "ACTION_EXECUTION_FAILED");
    assert.equal(outcome.executionMetadata?.recoveryFailureClass, "EXECUTABLE_NOT_FOUND");
    assert.equal(outcome.executionMetadata?.recoveryFailureProvenance, "executor_mechanical");
  });
});

test("ToolExecutorOrgan fails cleanly when shell stdout emits a socket error", async () => {
  await withTempCwd(async () => {
    const stdoutError = Object.assign(new Error("read ENOTCONN"), {
      code: "ENOTCONN"
    });
    const mockSpawn = createMockShellSpawn({
      stdoutError
    });
    const config = buildShellEnabledConfig({
      shellRuntime: {
        ...DEFAULT_BRAIN_CONFIG.shellRuntime,
        profile: {
          ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile,
          cwdPolicy: {
            ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.cwdPolicy,
            denyOutsideSandbox: false
          }
        }
      }
    });
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const outcome = await executor.executeWithOutcome(buildShellAction("npm run dev"));

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failureCode, "ACTION_EXECUTION_FAILED");
    assert.match(outcome.output, /ENOTCONN/i);
  });
});

test("ToolExecutorOrgan emits native dependency-missing recovery metadata from deterministic shell output", async () => {
  await withTempCwd(async () => {
    const mockSpawn = createMockShellSpawn({
      stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@vitejs/plugin-react' imported from vite.config.js\n",
      exitCode: 1
    });
    const config = buildShellEnabledConfig({
      shellRuntime: {
        ...DEFAULT_BRAIN_CONFIG.shellRuntime,
        profile: {
          ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile,
          shellKind: "cmd",
          executable: "cmd.exe",
          wrapperArgs: ["/d", "/c"],
          cwdPolicy: {
            ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.cwdPolicy,
            denyOutsideSandbox: false
          }
        }
      }
    });
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const outcome = await executor.executeWithOutcome(buildShellAction("npm run build"));

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.executionMetadata?.recoveryFailureClass, "DEPENDENCY_MISSING");
    assert.equal(outcome.executionMetadata?.recoveryFailureProvenance, "executor_mechanical");
  });
});

test("ToolExecutorOrgan emits native version-incompatible recovery metadata from deterministic shell output", async () => {
  await withTempCwd(async () => {
    const mockSpawn = createMockShellSpawn({
      stderr: "npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE could not resolve dependency tree\n",
      exitCode: 1
    });
    const config = buildShellEnabledConfig({
      shellRuntime: {
        ...DEFAULT_BRAIN_CONFIG.shellRuntime,
        profile: {
          ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile,
          shellKind: "cmd",
          executable: "cmd.exe",
          wrapperArgs: ["/d", "/c"],
          cwdPolicy: {
            ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.cwdPolicy,
            denyOutsideSandbox: false
          }
        }
      }
    });
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const outcome = await executor.executeWithOutcome(buildShellAction("npm install"));

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.executionMetadata?.recoveryFailureClass, "VERSION_INCOMPATIBLE");
    assert.equal(outcome.executionMetadata?.recoveryFailureProvenance, "executor_mechanical");
  });
});

test("ToolExecutorOrgan stages oversized Windows PowerShell commands through a temp script file", async () => {
  await withTempCwd(async () => {
    const mockSpawn = createMockShellSpawn({
      stdout: "done\n",
      exitCode: 0
    });
    const config = buildWindowsPowerShellShellEnabledConfig();
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const oversizedCommand = `Write-Output '${"A".repeat(
      config.shellRuntime.profile.commandMaxChars + 128
    )}'`;

    const outcome = await executor.executeWithOutcome(buildShellAction(oversizedCommand));

    assert.equal(outcome.status, "success");
    assert.equal(mockSpawn.calls.length, 1);
    assert.equal(mockSpawn.calls[0].executable, "powershell.exe");
    assert.deepEqual(mockSpawn.calls[0].args.slice(0, 3), [
      "-NoProfile",
      "-NonInteractive",
      "-File"
    ]);
    assert.match(String(mockSpawn.calls[0].args[3]), /agentbigbrain-shell-command-.*\.ps1$/i);
    assert.equal(
      mockSpawn.calls[0].args.some(
        (entry) => typeof entry === "string" && entry.includes(oversizedCommand)
      ),
      false
    );
  });
});

test("ToolExecutorOrgan fails closed when Vite build succeeds without creating dist/index.html", async () => {
  await withTempCwd(async (tempDir) => {
    await writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        name: "ai-drone-city",
        private: true,
        scripts: {
          build: "vite build"
        },
        devDependencies: {
          vite: "^7.0.0"
        }
      })
    );
    const mockSpawn = createMockShellSpawn({
      stdout: "vite build complete\n",
      exitCode: 0
    });
    const config = buildShellEnabledConfig({
      shellRuntime: {
        ...DEFAULT_BRAIN_CONFIG.shellRuntime,
        profile: {
          ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile,
          shellKind: "cmd",
          executable: "cmd.exe",
          wrapperArgs: ["/d", "/c"],
          cwdPolicy: {
            ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.cwdPolicy,
            denyOutsideSandbox: false
          }
        }
      }
    });
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const outcome = await executor.executeWithOutcome(
      buildShellAction("npm run build", {
        cwd: tempDir,
        workdir: tempDir
      })
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failureCode, "ACTION_EXECUTION_FAILED");
    assert.match(outcome.output, /did not produce the expected dist[\\/]index\.html/i);
  });
});

test("ToolExecutorOrgan accepts Vite build success only after dist/index.html exists", async () => {
  await withTempCwd(async (tempDir) => {
    await writeFile(
      path.join(tempDir, "package.json"),
      JSON.stringify({
        name: "ai-drone-city",
        private: true,
        scripts: {
          build: "vite build"
        },
        devDependencies: {
          vite: "^7.0.0"
        }
      })
    );
    await mkdir(path.join(tempDir, "dist"), { recursive: true });
    await writeFile(path.join(tempDir, "dist", "index.html"), "<!doctype html><title>AI Drone City</title>");
    const mockSpawn = createMockShellSpawn({
      stdout: "vite build complete\n",
      exitCode: 0
    });
    const config = buildShellEnabledConfig({
      shellRuntime: {
        ...DEFAULT_BRAIN_CONFIG.shellRuntime,
        profile: {
          ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile,
          shellKind: "cmd",
          executable: "cmd.exe",
          wrapperArgs: ["/d", "/c"],
          cwdPolicy: {
            ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.cwdPolicy,
            denyOutsideSandbox: false
          }
        }
      }
    });
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const outcome = await executor.executeWithOutcome(
      buildShellAction("npm run build", {
        cwd: tempDir,
        workdir: tempDir
      })
    );

    assert.equal(outcome.status, "success");
    assert.match(outcome.output, /Shell success/i);
  });
});

test("ToolExecutorOrgan cancels active shell command when abort signal fires", async () => {
  await withTempCwd(async () => {
    const mockSpawn = createAbortableShellSpawn();
    const config = buildShellEnabledConfig({
      shellRuntime: {
        ...DEFAULT_BRAIN_CONFIG.shellRuntime,
        profile: {
          ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile,
          shellKind: "cmd",
          executable: "cmd.exe",
          wrapperArgs: ["/d", "/c"],
          cwdPolicy: {
            ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.cwdPolicy,
            denyOutsideSandbox: false
          }
        }
      }
    });
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const abortController = new AbortController();
    const executionPromise = executor.executeWithOutcome(
      buildShellAction("npm start"),
      abortController.signal
    );

    abortController.abort();

    await assert.rejects(
      executionPromise,
      (error: unknown) => error instanceof Error && error.name === "AbortError"
    );
    assert.ok(mockSpawn.calls.length >= 1);
    assert.equal(mockSpawn.getKillCount(), 1);
  });
});

test("ToolExecutorOrgan starts managed process and returns lease metadata", async () => {
  await withTempCwd(async () => {
    const mockSpawn = createManagedProcessShellSpawn();
    const config = buildShellEnabledConfig({
      shellRuntime: {
        ...DEFAULT_BRAIN_CONFIG.shellRuntime,
        profile: {
          ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile,
          shellKind: "cmd",
          executable: "cmd.exe",
          wrapperArgs: ["/d", "/c"],
          cwdPolicy: {
            ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.cwdPolicy,
            denyOutsideSandbox: false
          }
        }
      }
    });
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const outcome = await executor.executeWithOutcome(
      buildStartProcessAction("npm start", { cwd: "runtime/sandbox/app" }),
      undefined,
      "task_managed_process_1"
    );

    assert.equal(outcome.status, "success");
    assert.match(outcome.output, /Process started: lease /i);
    assert.equal(outcome.executionMetadata?.processLifecycleStatus, "PROCESS_STARTED");
    assert.equal(outcome.executionMetadata?.processPid, 4242);
    assert.equal(outcome.executionMetadata?.processTaskId, "task_managed_process_1");
    assert.equal(typeof outcome.executionMetadata?.processLeaseId, "string");
    assert.equal(mockSpawn.calls.length, 1);
    assert.deepEqual(mockSpawn.calls[0].args, ["/d", "/c", "npm start"]);
  });
});

test("ToolExecutorOrgan fails managed process start early when the requested loopback port is already occupied", async () => {
  await withTempCwd(async () => {
    await withLocalTcpServer(async (port) => {
      const mockSpawn = createManagedProcessShellSpawn();
      const config = buildShellEnabledConfig({
        shellRuntime: {
          ...DEFAULT_BRAIN_CONFIG.shellRuntime,
          profile: {
            ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile,
            shellKind: "cmd",
            executable: "cmd.exe",
            wrapperArgs: ["/d", "/c"],
            cwdPolicy: {
              ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.cwdPolicy,
              denyOutsideSandbox: false
            }
          }
        }
      });
      const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
      const outcome = await executor.executeWithOutcome(
        buildStartProcessAction(`python -m http.server ${port}`, {
          cwd: "runtime/sandbox/app"
        })
      );

      assert.equal(outcome.status, "failed");
      assert.equal(outcome.failureCode, "PROCESS_START_FAILED");
      assert.match(outcome.output, /already occupied before startup/i);
      assert.equal(outcome.executionMetadata?.processLifecycleStatus, "PROCESS_START_FAILED");
      assert.equal(outcome.executionMetadata?.processStartupFailureKind, "PORT_IN_USE");
      assert.equal(outcome.executionMetadata?.recoveryFailureClass, "PROCESS_PORT_IN_USE");
      assert.equal(outcome.executionMetadata?.recoveryFailureProvenance, "runtime_live_run");
      assert.equal(outcome.executionMetadata?.processRequestedPort, port);
      assert.equal(outcome.executionMetadata?.processRequestedUrl, `http://localhost:${port}`);
      assert.equal(typeof outcome.executionMetadata?.processSuggestedPort, "number");
      assert.equal(mockSpawn.calls.length, 0);
    });
  });
});

test("ToolExecutorOrgan emits native recovery metadata when managed process startup hits command length limits", async () => {
  await withTempCwd(async () => {
    const spawnError = Object.assign(new Error("spawn ENAMETOOLONG"), {
      code: "ENAMETOOLONG"
    });
    const mockSpawn = createMockShellSpawn({
      error: spawnError
    });
    const config = buildShellEnabledConfig({
      shellRuntime: {
        ...DEFAULT_BRAIN_CONFIG.shellRuntime,
        profile: {
          ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile,
          shellKind: "cmd",
          executable: "cmd.exe",
          wrapperArgs: ["/d", "/c"],
          cwdPolicy: {
            ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.cwdPolicy,
            denyOutsideSandbox: false
          }
        }
      }
    });
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const outcome = await executor.executeWithOutcome(
      buildStartProcessAction("npm run dev", { cwd: "runtime/sandbox/app" })
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failureCode, "PROCESS_START_FAILED");
    assert.equal(outcome.executionMetadata?.recoveryFailureClass, "COMMAND_TOO_LONG");
    assert.equal(outcome.executionMetadata?.recoveryFailureProvenance, "executor_mechanical");
  });
});

test("ToolExecutorOrgan tears down managed process lease when the owning signal aborts after start", async () => {
  await withTempCwd(async () => {
    const mockSpawn = createManagedProcessShellSpawn();
    const config = buildShellEnabledConfig({
      shellRuntime: {
        ...DEFAULT_BRAIN_CONFIG.shellRuntime,
        profile: {
          ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile,
          shellKind: "cmd",
          executable: "cmd.exe",
          wrapperArgs: ["/d", "/c"],
          cwdPolicy: {
            ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.cwdPolicy,
            denyOutsideSandbox: false
          }
        }
      }
    });
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const abortController = new AbortController();
    const startOutcome = await executor.executeWithOutcome(
      buildStartProcessAction("npm start", { cwd: "runtime/sandbox/app" }),
      abortController.signal,
      "task_managed_process_abort_1"
    );
    const leaseId = startOutcome.executionMetadata?.processLeaseId;

    assert.equal(startOutcome.status, "success");
    assert.equal(typeof leaseId, "string");

    abortController.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(mockSpawn.getKillCount(), 1);
    const checkOutcome = await executor.executeWithOutcome(
      buildCheckProcessAction(typeof leaseId === "string" ? leaseId : undefined)
    );
    assert.equal(checkOutcome.status, "success");
    assert.match(checkOutcome.output, /Process stopped: lease /i);
    assert.equal(checkOutcome.executionMetadata?.processLifecycleStatus, "PROCESS_STOPPED");
    assert.equal(checkOutcome.executionMetadata?.processStopRequested, true);
    assert.equal(checkOutcome.executionMetadata?.recoveryFailureClass, "TARGET_NOT_RUNNING");
    assert.equal(checkOutcome.executionMetadata?.recoveryFailureProvenance, "runtime_live_run");
  });
});

test("ToolExecutorOrgan reports managed process as still running when lease is active", async () => {
  await withTempCwd(async () => {
    const mockSpawn = createManagedProcessShellSpawn();
    const config = buildShellEnabledConfig({
      shellRuntime: {
        ...DEFAULT_BRAIN_CONFIG.shellRuntime,
        profile: {
          ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile,
          shellKind: "cmd",
          executable: "cmd.exe",
          wrapperArgs: ["/d", "/c"],
          cwdPolicy: {
            ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.cwdPolicy,
            denyOutsideSandbox: false
          }
        }
      }
    });
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const startOutcome = await executor.executeWithOutcome(
      buildStartProcessAction("npm start", { cwd: "runtime/sandbox/app" })
    );
    const leaseId = startOutcome.executionMetadata?.processLeaseId;

    assert.equal(typeof leaseId, "string");
    const checkOutcome = await executor.executeWithOutcome(
      buildCheckProcessAction(typeof leaseId === "string" ? leaseId : undefined)
    );
    assert.equal(checkOutcome.status, "success");
    assert.match(checkOutcome.output, /Process still running: lease /i);
    assert.equal(checkOutcome.executionMetadata?.processLifecycleStatus, "PROCESS_STILL_RUNNING");
    assert.equal(checkOutcome.executionMetadata?.processLeaseId, leaseId);
  });
});

test("ToolExecutorOrgan stops managed process and returns closed lifecycle metadata", async () => {
  await withTempCwd(async () => {
    const mockSpawn = createManagedProcessShellSpawn();
    const config = buildShellEnabledConfig({
      shellRuntime: {
        ...DEFAULT_BRAIN_CONFIG.shellRuntime,
        profile: {
          ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile,
          shellKind: "cmd",
          executable: "cmd.exe",
          wrapperArgs: ["/d", "/c"],
          cwdPolicy: {
            ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.cwdPolicy,
            denyOutsideSandbox: false
          }
        }
      }
    });
    const executor = new ToolExecutorOrgan(config, mockSpawn.spawn);
    const startOutcome = await executor.executeWithOutcome(
      buildStartProcessAction("npm start", { cwd: "runtime/sandbox/app" })
    );
    const leaseId = startOutcome.executionMetadata?.processLeaseId;

    assert.equal(typeof leaseId, "string");
    const stopOutcome = await executor.executeWithOutcome(
      buildStopProcessAction(typeof leaseId === "string" ? leaseId : undefined)
    );
    assert.equal(stopOutcome.status, "success");
    assert.match(stopOutcome.output, /Process stopped: lease /i);
    assert.equal(stopOutcome.executionMetadata?.processLifecycleStatus, "PROCESS_STOPPED");
    assert.equal(stopOutcome.executionMetadata?.processLeaseId, leaseId);
    assert.equal(mockSpawn.getKillCount(), 1);
    if (process.platform === "win32") {
      assert.ok(mockSpawn.calls.some((call) => call.executable.toLowerCase() === "taskkill"));
    } else {
      assert.equal(stopOutcome.executionMetadata?.processSignal, "SIGTERM");
    }
  });
});

test("ToolExecutorOrgan probes local TCP port and returns PROCESS_READY metadata", async () => {
  await withTempCwd(async () => {
    await withLocalTcpServer(async (port) => {
      const executor = new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG);
      const outcome = await executor.executeWithOutcome(buildProbePortAction(port));

      assert.equal(outcome.status, "success");
      assert.match(outcome.output, /Port ready:/i);
      assert.equal(outcome.executionMetadata?.processLifecycleStatus, "PROCESS_READY");
      assert.equal(outcome.executionMetadata?.probeKind, "port");
      assert.equal(outcome.executionMetadata?.probeReady, true);
      assert.equal(outcome.executionMetadata?.probePort, port);
    });
  });
});

test("ToolExecutorOrgan reports PROCESS_NOT_READY when local TCP port is closed", async () => {
  await withTempCwd(async () => {
    await withUnusedTcpPort(async (port) => {
      const executor = new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG);
      const outcome = await executor.executeWithOutcome(buildProbePortAction(port));

      assert.equal(outcome.status, "failed");
      assert.match(outcome.output, /Port not ready:/i);
      assert.equal(outcome.failureCode, "PROCESS_NOT_READY");
      assert.equal(outcome.executionMetadata?.processLifecycleStatus, "PROCESS_NOT_READY");
      assert.equal(outcome.executionMetadata?.probeKind, "port");
      assert.equal(outcome.executionMetadata?.probeReady, false);
      assert.equal(outcome.executionMetadata?.recoveryFailureClass, "PROCESS_NOT_READY");
      assert.equal(outcome.executionMetadata?.recoveryFailureProvenance, "runtime_live_run");
    });
  });
});

test("ToolExecutorOrgan probes local HTTP endpoint and returns PROCESS_READY metadata", async () => {
  await withTempCwd(async () => {
    await withLocalHttpServer(200, async (url) => {
      const executor = new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG);
      const outcome = await executor.executeWithOutcome(buildProbeHttpAction(url, 200));

      assert.equal(outcome.status, "success");
      assert.match(outcome.output, /HTTP ready:/i);
      assert.equal(outcome.executionMetadata?.processLifecycleStatus, "PROCESS_READY");
      assert.equal(outcome.executionMetadata?.probeKind, "http");
      assert.equal(outcome.executionMetadata?.probeReady, true);
      assert.equal(outcome.executionMetadata?.probeUrl, url);
      assert.equal(outcome.executionMetadata?.probeObservedStatus, 200);
    });
  });
});

test("ToolExecutorOrgan reports PROCESS_NOT_READY when local HTTP status mismatches", async () => {
  await withTempCwd(async () => {
    await withLocalHttpServer(503, async (url) => {
      const executor = new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG);
      const outcome = await executor.executeWithOutcome(buildProbeHttpAction(url, 200));

      assert.equal(outcome.status, "failed");
      assert.match(outcome.output, /HTTP probe not ready:/i);
      assert.equal(outcome.failureCode, "PROCESS_NOT_READY");
      assert.equal(outcome.executionMetadata?.processLifecycleStatus, "PROCESS_NOT_READY");
      assert.equal(outcome.executionMetadata?.probeKind, "http");
      assert.equal(outcome.executionMetadata?.probeReady, false);
      assert.equal(outcome.executionMetadata?.probeObservedStatus, 503);
      assert.equal(outcome.executionMetadata?.recoveryFailureClass, "PROCESS_NOT_READY");
      assert.equal(outcome.executionMetadata?.recoveryFailureProvenance, "runtime_live_run");
    });
  });
});

test("ToolExecutorOrgan verifies loopback pages through browser verifier and records proof metadata", async () => {
  await withTempCwd(async () => {
    const browserVerifier = new MockBrowserVerifier({
      status: "verified",
      detail: "Browser verification passed: observed title \"Robinhood Mock\"; expected title matched.",
      observedTitle: "Robinhood Mock",
      observedTextSample: "Portfolio $12,340",
      matchedTitle: true,
      matchedText: true
    });
    const executor = new ToolExecutorOrgan(
      DEFAULT_BRAIN_CONFIG,
      undefined,
      undefined,
      browserVerifier
    );
    const outcome = await executor.executeWithOutcome(
      buildVerifyBrowserAction("http://127.0.0.1:3000/", {
        expectedTitle: "Robinhood",
        expectedText: "Portfolio",
        timeoutMs: 4000
      })
    );

    assert.equal(outcome.status, "success");
    assert.match(outcome.output, /Browser verification passed/i);
    assert.equal(browserVerifier.requests.length, 1);
    assert.equal(browserVerifier.requests[0].url, "http://127.0.0.1:3000/");
    assert.equal(outcome.executionMetadata?.browserVerification, true);
    assert.equal(outcome.executionMetadata?.browserVerifyPassed, true);
    assert.equal(outcome.executionMetadata?.browserVerifyObservedTitle, "Robinhood Mock");
    assert.equal(outcome.executionMetadata?.browserVerifyExpectedTitle, "Robinhood");
    assert.equal(outcome.executionMetadata?.processLifecycleStatus, "PROCESS_READY");
  });
});

test("ToolExecutorOrgan returns typed expectation failure for browser verification mismatches", async () => {
  await withTempCwd(async () => {
    const browserVerifier = new MockBrowserVerifier({
      status: "expectation_failed",
      detail: "Browser verification failed: page loaded, but expected text containing \"Portfolio\" was not found.",
      observedTitle: "Robinhood Mock",
      observedTextSample: "Watchlist only",
      matchedTitle: true,
      matchedText: false
    });
    const executor = new ToolExecutorOrgan(
      DEFAULT_BRAIN_CONFIG,
      undefined,
      undefined,
      browserVerifier
    );
    const outcome = await executor.executeWithOutcome(
      buildVerifyBrowserAction("http://127.0.0.1:3000/", {
        expectedTitle: "Robinhood",
        expectedText: "Portfolio"
      })
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failureCode, "BROWSER_VERIFY_EXPECTATION_FAILED");
    assert.equal(outcome.executionMetadata?.browserVerifyPassed, false);
    assert.equal(outcome.executionMetadata?.browserVerifyMatchedText, false);
    assert.equal(outcome.executionMetadata?.processLifecycleStatus, "PROCESS_READY");
  });
});

test("ToolExecutorOrgan returns typed runtime-unavailable failure for browser verification", async () => {
  await withTempCwd(async () => {
    const browserVerifier = new MockBrowserVerifier({
      status: "runtime_unavailable",
      detail: "Browser verification is unavailable in this runtime because Playwright is not installed locally.",
      observedTitle: null,
      observedTextSample: null,
      matchedTitle: null,
      matchedText: null
    });
    const executor = new ToolExecutorOrgan(
      DEFAULT_BRAIN_CONFIG,
      undefined,
      undefined,
      browserVerifier
    );
    const outcome = await executor.executeWithOutcome(
      buildVerifyBrowserAction("http://127.0.0.1:3000/")
    );

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failureCode, "BROWSER_VERIFY_RUNTIME_UNAVAILABLE");
    assert.equal(outcome.executionMetadata?.browserVerification, true);
    assert.equal(outcome.executionMetadata?.browserVerifyPassed, false);
    assert.equal(outcome.executionMetadata?.recoveryFailureClass, "DEPENDENCY_MISSING");
    assert.equal(outcome.executionMetadata?.recoveryFailureProvenance, "runtime_live_run");
  });
});

test("ToolExecutorOrgan opens a visible browser window and records persistent browser-session metadata", async () => {
  await withTempCwd(async () => {
    const mockSpawn = createManagedProcessShellSpawn();
    await withLocalHttpServer(200, async (url) => {
      const executor = new ToolExecutorOrgan(
        DEFAULT_BRAIN_CONFIG,
        mockSpawn.spawn,
        undefined,
        undefined,
        undefined,
        async () => null
      );
      const outcome = await executor.executeWithOutcome(buildOpenBrowserAction(url));

      assert.equal(outcome.status, "success");
      assert.match(outcome.output, /left it open/i);
      assert.equal(outcome.executionMetadata?.browserSession, true);
      assert.equal(outcome.executionMetadata?.browserSessionStatus, "open");
      assert.equal(outcome.executionMetadata?.browserSessionUrl, url);
      assert.equal(outcome.executionMetadata?.browserSessionVisibility, "visible");
      assert.equal(typeof outcome.executionMetadata?.browserSessionId, "string");
      assert.equal(outcome.executionMetadata?.browserSessionControlAvailable, false);
      assert.equal(mockSpawn.calls.length, 1);
    });
  });
});

test("ToolExecutorOrgan reports missing local file targets before attempting browser open", async () => {
  await withTempCwd(async () => {
    const executor = new ToolExecutorOrgan(
      DEFAULT_BRAIN_CONFIG,
      undefined,
      undefined,
      undefined,
      undefined,
      async () => createStubPlaywrightRuntime().runtime
    );
    const missingFileUrl = pathToFileURL(
      path.join(process.cwd(), "AI Drone City", "dist", "index.html")
    ).toString();
    const outcome = await executor.executeWithOutcome(buildOpenBrowserAction(missingFileUrl));

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failureCode, "ACTION_EXECUTION_FAILED");
    assert.match(outcome.output, /local file does not exist/i);
  });
});

test("ToolExecutorOrgan closes a tracked managed browser window by session id", async () => {
  await withTempCwd(async () => {
    await withLocalHttpServer(200, async (url) => {
      const stubRuntime = createStubPlaywrightRuntime();
      const executor = new ToolExecutorOrgan(
        DEFAULT_BRAIN_CONFIG,
        undefined,
        undefined,
        undefined,
        undefined,
        async () => stubRuntime.runtime
      );

      const openOutcome = await executor.executeWithOutcome(buildOpenBrowserAction(url));
      const closeOutcome = await executor.executeWithOutcome(
        buildCloseBrowserAction({
          sessionId: openOutcome.executionMetadata?.browserSessionId
        })
      );

      assert.equal(openOutcome.status, "success");
      assert.equal(closeOutcome.status, "success");
      assert.equal(closeOutcome.executionMetadata?.browserSessionStatus, "closed");
      assert.equal(stubRuntime.getPageCloseCount(), 1);
      assert.equal(stubRuntime.getContextCloseCount(), 1);
      assert.equal(stubRuntime.getBrowserCloseCount(), 1);
    });
  });
});

test("ToolExecutorOrgan blocks managed process check and stop for unknown leases", async () => {
  await withTempCwd(async () => {
    const executor = new ToolExecutorOrgan(buildShellEnabledConfig());
    const checkOutcome = await executor.executeWithOutcome(buildCheckProcessAction("proc_missing"));
    const stopOutcome = await executor.executeWithOutcome(buildStopProcessAction("proc_missing"));

    assert.equal(checkOutcome.status, "blocked");
    assert.equal(checkOutcome.failureCode, "PROCESS_LEASE_NOT_FOUND");
    assert.equal(stopOutcome.status, "blocked");
    assert.equal(stopOutcome.failureCode, "PROCESS_LEASE_NOT_FOUND");
  });
});

test("ToolExecutorOrgan tags simulated shell execution with deterministic metadata", async () => {
  await withTempCwd(async () => {
    const executor = new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG);
    const outcome = await executor.executeWithOutcome(buildShellAction("echo hello"));
    assert.equal(outcome.status, "success");
    assert.match(outcome.output, /Shell execution simulated/i);
    assert.equal(outcome.executionMetadata?.simulatedExecution, true);
    assert.equal(outcome.executionMetadata?.simulatedExecutionReason, "SHELL_POLICY_DISABLED");
  });
});

test("ToolExecutorOrgan runs quoted cmd path commands with real shell on Windows", async () => {
  if (process.platform !== "win32") {
    return;
  }

  const quotedTempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain cmd quoted path "));
  try {
    const config = buildShellEnabledConfig({
      shellRuntime: {
        ...DEFAULT_BRAIN_CONFIG.shellRuntime,
        profile: {
          ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile,
          shellKind: "cmd",
          executable: "cmd.exe",
          wrapperArgs: ["/d", "/c"],
          cwdPolicy: {
            ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.cwdPolicy,
            denyOutsideSandbox: false
          }
        }
      }
    });
    const executor = new ToolExecutorOrgan(config);
    const output = await executor.execute(
      buildShellAction(`cd "${quotedTempDir}" && echo quoted-path-ok`)
    );

    assert.match(output, /Shell success/i);
    assert.match(output, /quoted-path-ok/i);
  } finally {
    await rm(quotedTempDir, { recursive: true, force: true });
  }
});
