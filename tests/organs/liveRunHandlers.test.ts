/**
 * @fileoverview Tests extracted live-run handler modules directly.
 */

import assert from "node:assert/strict";
import { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import * as http from "node:http";
import * as net from "node:net";
import { test } from "node:test";

import { BrainConfig, createBrainConfigFromEnv } from "../../src/core/config";
import {
  BrowserVerificationResult,
  BrowserVerifier,
  VerifyBrowserRequest
} from "../../src/organs/liveRun/browserVerifier";
import { LiveRunExecutorContext } from "../../src/organs/liveRun/contracts";
import { executeBrowserVerification } from "../../src/organs/liveRun/browserVerificationHandler";
import { executeCheckProcess } from "../../src/organs/liveRun/checkProcessHandler";
import { ManagedProcessRegistry } from "../../src/organs/liveRun/managedProcessRegistry";
import { executeProbeHttp } from "../../src/organs/liveRun/probeHttpHandler";
import { executeProbePort } from "../../src/organs/liveRun/probePortHandler";
import { executeStartProcess } from "../../src/organs/liveRun/startProcessHandler";
import { executeStopProcess } from "../../src/organs/liveRun/stopProcessHandler";

interface MockShellSpawnCall {
  executable: string;
  args: readonly string[];
  options: Record<string, unknown>;
}

class StubBrowserVerifier implements BrowserVerifier {
  readonly requests: VerifyBrowserRequest[] = [];

  constructor(private readonly result: BrowserVerificationResult) {}

  async verify(request: VerifyBrowserRequest): Promise<BrowserVerificationResult> {
    this.requests.push(request);
    return this.result;
  }
}

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

function createManagedProcessChild(pid = 4242): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  const stdout = new EventEmitter() as ChildProcessWithoutNullStreams["stdout"] & {
    resume?: () => void;
  };
  const stderr = new EventEmitter() as ChildProcessWithoutNullStreams["stderr"] & {
    resume?: () => void;
  };
  stdout.resume = () => stdout;
  stderr.resume = () => stderr;
  child.stdin = new EventEmitter() as ChildProcessWithoutNullStreams["stdin"];
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = (() => true) as ChildProcessWithoutNullStreams["kill"];
  Object.defineProperty(child, "pid", { value: pid, writable: true });
  return child;
}

function createManagedProcessShellSpawn(): {
  calls: MockShellSpawnCall[];
  spawn: typeof import("node:child_process").spawn;
} {
  const calls: MockShellSpawnCall[] = [];
  const spawn = ((executable: string, argsOrOptions?: unknown, maybeOptions?: unknown) => {
    const args = Array.isArray(argsOrOptions) ? argsOrOptions : [];
    const options = (
      Array.isArray(argsOrOptions) ? maybeOptions : argsOrOptions
    ) as Record<string, unknown> | undefined;
    calls.push({
      executable,
      args,
      options: options ?? {}
    });

    const child = createManagedProcessChild();
    queueMicrotask(() => {
      child.emit("spawn");
    });
    return child;
  }) as unknown as typeof import("node:child_process").spawn;

  return {
    calls,
    spawn
  };
}

function buildLiveRunContext(
  overrides: Partial<LiveRunExecutorContext> = {}
): LiveRunExecutorContext {
  return {
    config: buildShellEnabledConfig(),
    shellSpawn: createManagedProcessShellSpawn().spawn,
    managedProcessRegistry: new ManagedProcessRegistry(),
    browserVerifier: new StubBrowserVerifier({
      status: "verified",
      detail: "verified",
      observedTitle: "ok",
      observedTextSample: "ok",
      matchedTitle: true,
      matchedText: true
    }),
    resolveShellCommandCwd: () => process.cwd(),
    terminateProcessTree: async () => true,
    ...overrides
  };
}

test("executeStartProcess registers a managed-process lease after spawn", async () => {
  const { calls, spawn } = createManagedProcessShellSpawn();
  const registry = new ManagedProcessRegistry();
  const context = buildLiveRunContext({
    shellSpawn: spawn,
    managedProcessRegistry: registry
  });

  const outcome = await executeStartProcess(context, "action_start_live_run", {
    command: "python -m http.server 8125",
    cwd: process.cwd()
  });

  assert.equal(outcome.status, "success");
  assert.equal(calls.length, 1);
  assert.equal(outcome.executionMetadata?.processLifecycleStatus, "PROCESS_STARTED");
  const leaseId = String(outcome.executionMetadata?.processLeaseId ?? "");
  assert.ok(leaseId.length > 0);
  assert.equal(registry.getSnapshot(leaseId)?.statusCode, "PROCESS_STARTED");
});

test("executeStartProcess fails early when the requested loopback port is already occupied", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    let spawnCalls = 0;
    const context = buildLiveRunContext({
      shellSpawn: ((() => {
        spawnCalls += 1;
        return createManagedProcessChild();
      }) as unknown) as typeof import("node:child_process").spawn
    });

    const outcome = await executeStartProcess(context, "action_conflict_live_run", {
      command: `python -m http.server ${address.port}`,
      cwd: process.cwd()
    });

    assert.equal(outcome.status, "failed");
    assert.equal(outcome.failureCode, "PROCESS_START_FAILED");
    assert.equal(outcome.executionMetadata?.processStartupFailureKind, "PORT_IN_USE");
    assert.equal(outcome.executionMetadata?.processRequestedPort, address.port);
    assert.equal(spawnCalls, 0);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("executeCheckProcess and executeStopProcess use the managed-process registry contract", async () => {
  const registry = new ManagedProcessRegistry();
  const child = createManagedProcessChild(9333);
  const snapshot = registry.registerStarted({
    actionId: "action_registry_live_run",
    child,
    commandFingerprint: "fingerprint",
    cwd: process.cwd(),
    shellExecutable: "python",
    shellKind: "bash"
  });
  const context = buildLiveRunContext({
    managedProcessRegistry: registry,
    terminateProcessTree: async (processChild) => {
      processChild.emit("close", 0, "SIGTERM");
      return true;
    }
  });

  const checkOutcome = await executeCheckProcess(context, { leaseId: snapshot.leaseId });
  assert.equal(checkOutcome.status, "success");
  assert.equal(checkOutcome.executionMetadata?.processLifecycleStatus, "PROCESS_STILL_RUNNING");

  const stopOutcome = await executeStopProcess(context, { leaseId: snapshot.leaseId });
  assert.equal(stopOutcome.status, "success");
  assert.equal(stopOutcome.executionMetadata?.processLifecycleStatus, "PROCESS_STOPPED");
});

test("executeProbePort returns PROCESS_READY metadata when a local port is open", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const outcome = await executeProbePort(buildLiveRunContext(), {
      host: "127.0.0.1",
      port: address.port
    });

    assert.equal(outcome.status, "success");
    assert.equal(outcome.executionMetadata?.processLifecycleStatus, "PROCESS_READY");
    assert.equal(outcome.executionMetadata?.probePort, address.port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("executeProbeHttp returns PROCESS_READY metadata when a local endpoint responds", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}`;
    const outcome = await executeProbeHttp(buildLiveRunContext(), { url });

    assert.equal(outcome.status, "success");
    assert.equal(outcome.executionMetadata?.processLifecycleStatus, "PROCESS_READY");
    assert.equal(outcome.executionMetadata?.probeUrl, url);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("executeBrowserVerification maps runtime-unavailable verifier results to typed failures", async () => {
  const browserVerifier = new StubBrowserVerifier({
    status: "runtime_unavailable",
    detail: "Playwright browser runtime is unavailable locally.",
    observedTitle: null,
    observedTextSample: null,
    matchedTitle: null,
    matchedText: null
  });
  const outcome = await executeBrowserVerification(
    buildLiveRunContext({ browserVerifier }),
    {
      url: "http://localhost:8125",
      expectedTitle: "Playwright Proof Smoke",
      expectedText: "Browser proof works"
    }
  );

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failureCode, "BROWSER_VERIFY_RUNTIME_UNAVAILABLE");
  assert.equal(outcome.executionMetadata?.browserVerification, true);
  assert.equal(browserVerifier.requests.length, 1);
});
