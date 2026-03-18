/**
 * @fileoverview Tests extracted live-run handler modules directly.
 */

import assert from "node:assert/strict";
import { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

import { BrainConfig, createBrainConfigFromEnv } from "../../src/core/config";
import {
  BrowserVerificationResult,
  BrowserVerifier,
  VerifyBrowserRequest
} from "../../src/organs/liveRun/browserVerifier";
import { BrowserSessionRegistry } from "../../src/organs/liveRun/browserSessionRegistry";
import { executeCloseBrowser } from "../../src/organs/liveRun/closeBrowserHandler";
import { LiveRunExecutorContext } from "../../src/organs/liveRun/contracts";
import { executeBrowserVerification } from "../../src/organs/liveRun/browserVerificationHandler";
import { executeCheckProcess } from "../../src/organs/liveRun/checkProcessHandler";
import {
  executeInspectPathHolders,
  executeInspectWorkspaceResources
} from "../../src/organs/liveRun/inspectWorkspaceResourcesHandler";
import { ManagedProcessRegistry } from "../../src/organs/liveRun/managedProcessRegistry";
import { executeOpenBrowser } from "../../src/organs/liveRun/openBrowserHandler";
import type { PlaywrightChromiumRuntime } from "../../src/organs/liveRun/playwrightRuntime";
import { executeProbeHttp } from "../../src/organs/liveRun/probeHttpHandler";
import { executeProbePort } from "../../src/organs/liveRun/probePortHandler";
import { executeStartProcess } from "../../src/organs/liveRun/startProcessHandler";
import { executeStopProcess } from "../../src/organs/liveRun/stopProcessHandler";
import {
  buildTrackedPidArrayLiteral,
  isLikelyLoopbackPreviewCandidate,
  UntrackedHolderCandidate
} from "../../src/organs/liveRun/untrackedPreviewCandidateInspection";

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

function createStubPlaywrightRuntime(): {
  runtime: PlaywrightChromiumRuntime;
  getLaunchCount: () => number;
  getGotoCount: () => number;
  getReloadCount: () => number;
  getPageCloseCount: () => number;
  getContextCloseCount: () => number;
  getBrowserCloseCount: () => number;
} {
  let launchCount = 0;
  let gotoCount = 0;
  let reloadCount = 0;
  let pageCloseCount = 0;
  let contextCloseCount = 0;
  let browserCloseCount = 0;

  const page = {
    async goto(): Promise<void> {
      gotoCount += 1;
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
      reloadCount += 1;
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
          launchCount += 1;
          return browser;
        }
      },
      sourceModule: "playwright"
    },
    getLaunchCount: () => launchCount,
    getGotoCount: () => gotoCount,
    getReloadCount: () => reloadCount,
    getPageCloseCount: () => pageCloseCount,
    getContextCloseCount: () => contextCloseCount,
    getBrowserCloseCount: () => browserCloseCount
  };
}

test("buildTrackedPidArrayLiteral renders PowerShell-safe tracked pid arrays", () => {
  assert.equal(buildTrackedPidArrayLiteral([]), "@()");
  assert.equal(buildTrackedPidArrayLiteral([5724]), "@(5724)");
  assert.equal(buildTrackedPidArrayLiteral([5724, 31908]), "@(5724, 31908)");
});

test("isLikelyLoopbackPreviewCandidate filters unrelated loopback services after command-line inspection", () => {
  assert.equal(isLikelyLoopbackPreviewCandidate("python.exe", "python -m http.server 5500"), true);
  assert.equal(
    isLikelyLoopbackPreviewCandidate(
      "node.exe",
      "\"C:\\Program Files\\Adobe\\libs\\node.exe\" \"C:\\Program Files\\Adobe\\server.js\""
    ),
    false
  );
  assert.equal(isLikelyLoopbackPreviewCandidate("node.exe", "node vite dev"), true);
  assert.equal(isLikelyLoopbackPreviewCandidate("python.exe", null), true);
});

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

async function reserveUnusedTcpPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
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
    browserSessionRegistry: new BrowserSessionRegistry(),
    browserVerifier: new StubBrowserVerifier({
      status: "verified",
      detail: "verified",
      observedTitle: "ok",
      observedTextSample: "ok",
      matchedTitle: true,
      matchedText: true
    }),
    inspectSystemPreviewCandidates: async () => [],
    resolveShellCommandCwd: () => process.cwd(),
    terminateProcessTree: async () => true,
    terminateProcessTreeByPid: async () => true,
    isProcessRunning: () => true,
    ...overrides
  };
}

function createManagedBrowserSessionHandles(browserProcessPid = 7555): {
  browser: import("../../src/organs/liveRun/playwrightRuntime").BrowserVerifierBrowser;
  context: import("../../src/organs/liveRun/playwrightRuntime").BrowserVerifierContext;
  page: import("../../src/organs/liveRun/playwrightRuntime").BrowserVerifierPage;
  browserProcessPid: number;
} {
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
      return;
    }
  } as unknown as import("../../src/organs/liveRun/playwrightRuntime").BrowserVerifierPage;
  const context = {
    async newPage() {
      return page;
    },
    async close(): Promise<void> {
      return;
    }
  } as unknown as import("../../src/organs/liveRun/playwrightRuntime").BrowserVerifierContext;
  const browser = {
    async newContext() {
      return context;
    },
    async close(): Promise<void> {
      return;
    },
    process() {
      return { pid: browserProcessPid } as unknown as import("node:child_process").ChildProcess;
    }
  } as unknown as import("../../src/organs/liveRun/playwrightRuntime").BrowserVerifierBrowser;
  return {
    browser,
    context,
    page,
    browserProcessPid
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

test("executeStartProcess routes simple Windows npm preview commands through cmd.exe with launcher env keys", async () => {
  const { calls, spawn } = createManagedProcessShellSpawn();
  const registry = new ManagedProcessRegistry();
  const originalComSpec = process.env.ComSpec;
  const originalPathExt = process.env.PATHEXT;
  const originalWindir = process.env.WINDIR;
  process.env.ComSpec = originalComSpec ?? "C:\\Windows\\System32\\cmd.exe";
  process.env.PATHEXT = originalPathExt ?? ".COM;.EXE;.BAT;.CMD";
  process.env.WINDIR = originalWindir ?? "C:\\Windows";

  try {
    const context = buildLiveRunContext({
      config: buildShellEnabledConfig({
        shellRuntime: {
          profile: {
            ...buildShellEnabledConfig().shellRuntime.profile,
            platform: "win32",
            shellKind: "powershell",
            executable: "powershell.exe",
            wrapperArgs: ["-NoProfile", "-NonInteractive", "-Command"],
            envPolicy: {
              mode: "allowlist",
              allowlist: ["PATH", "HOME", "USERPROFILE", "TEMP", "SYSTEMROOT"],
              denylist: ["TOKEN", "SECRET", "PASSWORD", "AUTH", "COOKIE"]
            }
          }
        }
      }),
      shellSpawn: spawn,
      managedProcessRegistry: registry
    });

    const outcome = await executeStartProcess(context, "action_start_windows_preview", {
      command: "npm run preview -- --host 127.0.0.1 --port 4173",
      cwd: process.cwd()
    });

    assert.equal(outcome.status, "success");
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.executable, "cmd.exe");
    assert.deepEqual(calls[0]?.args, [
      "/d",
      "/c",
      "npm run preview -- --host 127.0.0.1 --port 4173"
    ]);
    const spawnedEnv = (calls[0]?.options.env ?? {}) as NodeJS.ProcessEnv;
    assert.equal(spawnedEnv.ComSpec, process.env.ComSpec);
    assert.equal(spawnedEnv.PATHEXT, process.env.PATHEXT);
    assert.equal(spawnedEnv.WINDIR, process.env.WINDIR);
  } finally {
    if (originalComSpec === undefined) {
      delete process.env.ComSpec;
    } else {
      process.env.ComSpec = originalComSpec;
    }
    if (originalPathExt === undefined) {
      delete process.env.PATHEXT;
    } else {
      process.env.PATHEXT = originalPathExt;
    }
    if (originalWindir === undefined) {
      delete process.env.WINDIR;
    } else {
      process.env.WINDIR = originalWindir;
    }
  }
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

test("executeStopProcess recovers a persisted managed-process lease by pid after runtime churn", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "abb-live-run-process-"));
  try {
    const snapshotPath = path.join(tempDir, "managed_processes.json");
    const seedRegistry = new ManagedProcessRegistry({ snapshotPath });
    const snapshot = seedRegistry.registerStarted({
      actionId: "action_registry_rehydrate_stop",
      child: createManagedProcessChild(9333),
      commandFingerprint: "fingerprint",
      cwd: process.cwd(),
      shellExecutable: "python",
      shellKind: "bash"
    });
    const recoveredRegistry = new ManagedProcessRegistry({
      snapshotPath,
      isProcessAlive: () => true
    });
    let terminatedPid: number | null = null;
    const context = buildLiveRunContext({
      managedProcessRegistry: recoveredRegistry,
      terminateProcessTreeByPid: async (pid) => {
        terminatedPid = pid;
        return true;
      }
    });

    const stopOutcome = await executeStopProcess(context, { leaseId: snapshot.leaseId });

    assert.equal(stopOutcome.status, "success");
    assert.equal(terminatedPid, 9333);
    assert.equal(
      recoveredRegistry.getSnapshot(snapshot.leaseId)?.statusCode,
      "PROCESS_STOPPED"
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("executeStopProcess can stop an exact recovered holder by pid when no live lease remains", async () => {
  let terminatedPid: number | null = null;
  const context = buildLiveRunContext({
    terminateProcessTreeByPid: async (pid) => {
      terminatedPid = pid;
      return true;
    }
  });

  const outcome = await executeStopProcess(context, { pid: 5724 });

  assert.equal(outcome.status, "success");
  assert.equal(terminatedPid, 5724);
  assert.equal(outcome.executionMetadata?.processLifecycleStatus, "PROCESS_STOPPED");
  assert.equal(outcome.executionMetadata?.processPid, 5724);
});

test("executeStopProcess closes linked tracked browser sessions for the same preview lease", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "abb-live-run-stop-linked-browser-"));
  const indexPath = path.join(tempDir, "index.html");
  writeFileSync(indexPath, "<!doctype html><title>Drone Company</title>", "utf8");
  const managedProcessRegistry = new ManagedProcessRegistry();
  const processSnapshot = managedProcessRegistry.registerStarted({
    actionId: "action_stop_process_linked_preview",
    child: createManagedProcessChild(9334),
    commandFingerprint: "linked-preview-fingerprint",
    cwd: tempDir,
    shellExecutable: "python",
    shellKind: "powershell"
  });
  const stubRuntime = createStubPlaywrightRuntime();

  try {
    const context = buildLiveRunContext({
      managedProcessRegistry,
      playwrightChromiumLoader: async () => stubRuntime.runtime,
      terminateProcessTree: async (processChild) => {
        processChild.emit("close", 0, "SIGTERM");
        return true;
      }
    });

    const openOutcome = await executeOpenBrowser(context, "action_open_browser_stop_linked", {
      url: pathToFileURL(indexPath).toString(),
      rootPath: tempDir,
      previewProcessLeaseId: processSnapshot.leaseId
    });
    assert.equal(openOutcome.status, "success");

    const stopOutcome = await executeStopProcess(context, { leaseId: processSnapshot.leaseId });

    assert.equal(stopOutcome.status, "success");
    assert.equal(stopOutcome.executionMetadata?.processLifecycleStatus, "PROCESS_STOPPED");
    assert.equal(stopOutcome.executionMetadata?.linkedBrowserSessionCleanupCount, 1);
    assert.match(
      String(stopOutcome.executionMetadata?.linkedBrowserSessionCleanupRecordsJson ?? ""),
      /browser_session:action_open_browser_stop_linked/
    );
    const closedSnapshot = context.browserSessionRegistry.getSnapshot(
      "browser_session:action_open_browser_stop_linked"
    );
    assert.equal(closedSnapshot?.status, "closed");
    assert.equal(closedSnapshot?.controlAvailable, false);
    assert.equal(stubRuntime.getPageCloseCount(), 1);
    assert.equal(stubRuntime.getContextCloseCount(), 1);
    assert.equal(stubRuntime.getBrowserCloseCount(), 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("executeStopProcess marks reloaded linked managed browser sessions stale when restart churn removed direct browser control", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "abb-live-run-stop-linked-stale-"));
  const browserSnapshotPath = path.join(tempDir, "browser_sessions.json");
  const managedProcessRegistry = new ManagedProcessRegistry();
  const processSnapshot = managedProcessRegistry.registerStarted({
    actionId: "action_stop_process_linked_stale_preview",
    child: createManagedProcessChild(9444),
    commandFingerprint: "linked-stale-preview-fingerprint",
    cwd: tempDir,
    shellExecutable: "python",
    shellKind: "powershell"
  });

  writeFileSync(
    browserSnapshotPath,
    `${JSON.stringify(
      {
        version: 1,
        sessions: [
          {
            sessionId: "browser_session:reloaded_linked_preview",
            url: "http://127.0.0.1:60123/index.html",
            status: "open",
            openedAt: "2026-03-14T12:00:00.000Z",
            closedAt: null,
            visibility: "visible",
            controllerKind: "playwright_managed",
            controlAvailable: false,
            browserProcessPid: null,
            workspaceRootPath: tempDir,
            linkedProcessLeaseId: processSnapshot.leaseId,
            linkedProcessCwd: tempDir,
            linkedProcessPid: processSnapshot.pid
          }
        ]
      },
      null,
      2
    )}\n`,
    "utf8"
  );

  try {
    const browserSessionRegistry = new BrowserSessionRegistry({
      snapshotPath: browserSnapshotPath,
      isProcessAlive: (pid) => pid === processSnapshot.pid
    });
    const context = buildLiveRunContext({
      managedProcessRegistry,
      browserSessionRegistry,
      terminateProcessTree: async (processChild) => {
        processChild.emit("close", 0, "SIGTERM");
        return true;
      }
    });

    const stopOutcome = await executeStopProcess(context, { leaseId: processSnapshot.leaseId });

    assert.equal(stopOutcome.status, "success");
    assert.match(
      stopOutcome.output,
      /Marked 1 linked browser session stale after shutting down the preview process\./
    );
    assert.equal(stopOutcome.executionMetadata?.linkedBrowserSessionCleanupCount, 1);
    assert.match(
      String(stopOutcome.executionMetadata?.linkedBrowserSessionCleanupRecordsJson ?? ""),
      /"status":"closed"/
    );
    const closedSnapshot = context.browserSessionRegistry.getSnapshot(
      "browser_session:reloaded_linked_preview"
    );
    assert.equal(closedSnapshot?.status, "closed");
    assert.equal(closedSnapshot?.controlAvailable, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("executeCheckProcess reports persisted leases as stopped when the recovered pid is no longer running", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "abb-live-run-check-"));
  try {
    const snapshotPath = path.join(tempDir, "managed_processes.json");
    const seedRegistry = new ManagedProcessRegistry({ snapshotPath });
    const snapshot = seedRegistry.registerStarted({
      actionId: "action_registry_rehydrate_check",
      child: createManagedProcessChild(8444),
      commandFingerprint: "fingerprint",
      cwd: process.cwd(),
      shellExecutable: "python",
      shellKind: "bash"
    });
    const recoveredRegistry = new ManagedProcessRegistry({ snapshotPath });
    const context = buildLiveRunContext({
      managedProcessRegistry: recoveredRegistry,
      isProcessRunning: () => false
    });

    const outcome = await executeCheckProcess(context, { leaseId: snapshot.leaseId });

    assert.equal(outcome.status, "success");
    assert.equal(outcome.executionMetadata?.processLifecycleStatus, "PROCESS_STOPPED");
    assert.equal(
      recoveredRegistry.getSnapshot(snapshot.leaseId)?.statusCode,
      "PROCESS_STOPPED"
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
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

test("executeProbeHttp retries until a delayed local endpoint becomes ready", async () => {
  const port = await reserveUnusedTcpPort();
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
  });
  const url = `http://127.0.0.1:${port}/`;

  const delayedStart = setTimeout(() => {
    void server.listen(port, "127.0.0.1");
  }, 250);

  try {
    const outcome = await executeProbeHttp(
      buildLiveRunContext(),
      {
        url,
        timeoutMs: 1200
      }
    );

    assert.equal(outcome.status, "success");
    assert.equal(outcome.executionMetadata?.processLifecycleStatus, "PROCESS_READY");
    assert.equal(outcome.executionMetadata?.probeUrl, url);
    assert.equal(
      Number(outcome.executionMetadata?.probeAttempts ?? 0) >= 2,
      true
    );
  } finally {
    clearTimeout(delayedStart);
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
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

test("executeOpenBrowser launches a visible browser session and records session metadata", async () => {
  const { calls, spawn } = createManagedProcessShellSpawn();
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
    const outcome = await executeOpenBrowser(
      buildLiveRunContext({
        shellSpawn: spawn,
        playwrightChromiumLoader: async () => null
      }),
      "action_open_browser",
      {
        url: `http://localhost:${address.port}`
      }
    );

    assert.equal(outcome.status, "success");
    assert.equal(outcome.executionMetadata?.browserSession, true);
    assert.equal(outcome.executionMetadata?.browserSessionStatus, "open");
    assert.equal(
      outcome.executionMetadata?.browserSessionUrl,
      `http://localhost:${address.port}/`
    );
    assert.equal(outcome.executionMetadata?.browserSessionId, "browser_session:action_open_browser");
    assert.equal(outcome.executionMetadata?.browserSessionControlAvailable, false);
    assert.equal(calls.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("executeOpenBrowser reuses an existing managed browser session for the same local URL", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const stubRuntime = createStubPlaywrightRuntime();
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/`;
    const context = buildLiveRunContext({
      playwrightChromiumLoader: async () => stubRuntime.runtime
    });

    const firstOutcome = await executeOpenBrowser(context, "action_open_browser_first", {
      url
    });
    const secondOutcome = await executeOpenBrowser(context, "action_open_browser_second", {
      url
    });

    assert.equal(firstOutcome.status, "success");
    assert.equal(secondOutcome.status, "success");
    assert.equal(stubRuntime.getLaunchCount(), 1);
    assert.equal(stubRuntime.getGotoCount(), 1);
    assert.equal(stubRuntime.getReloadCount(), 1);
    assert.equal(
      secondOutcome.executionMetadata?.browserSessionId,
      firstOutcome.executionMetadata?.browserSessionId
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("executeOpenBrowser allows local file preview urls without localhost readiness", async () => {
  const { calls, spawn } = createManagedProcessShellSpawn();
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "abb-live-run-file-preview-"));
  const indexPath = path.join(tempDir, "index.html");
  writeFileSync(indexPath, "<!doctype html><title>Drone Company</title>", "utf8");

  try {
    const outcome = await executeOpenBrowser(
      buildLiveRunContext({
        shellSpawn: spawn,
        playwrightChromiumLoader: async () => null
      }),
      "action_open_browser_file_preview",
      {
        url: `file:///${indexPath.replace(/\\/g, "/")}`
      }
    );

    assert.equal(outcome.status, "success");
    assert.equal(outcome.executionMetadata?.browserSession, true);
    assert.equal(outcome.executionMetadata?.browserSessionStatus, "open");
    assert.match(String(outcome.executionMetadata?.browserSessionUrl ?? ""), /^file:\/\//i);
    assert.equal(calls.length, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("executeOpenBrowser persists workspace ownership metadata for later preview follow-ups", async () => {
  const { calls, spawn } = createManagedProcessShellSpawn();
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "abb-live-run-owned-preview-"));
  const indexPath = path.join(tempDir, "index.html");
  writeFileSync(indexPath, "<!doctype html><title>Drone Company</title>", "utf8");
  const managedProcessRegistry = new ManagedProcessRegistry();
  const processSnapshot = managedProcessRegistry.registerStarted({
    actionId: "action_owned_preview_process",
    child: createManagedProcessChild(6123),
    commandFingerprint: "owned-preview-fingerprint",
    cwd: tempDir,
    shellExecutable: "python",
    shellKind: "powershell"
  });

  try {
    const context = buildLiveRunContext({
      shellSpawn: spawn,
      playwrightChromiumLoader: async () => null,
      managedProcessRegistry
    });
    const outcome = await executeOpenBrowser(
      context,
      "action_open_owned_preview",
      {
        url: `file:///${indexPath.replace(/\\/g, "/")}`,
        rootPath: tempDir,
        previewProcessLeaseId: processSnapshot.leaseId
      }
    );

    assert.equal(outcome.status, "success");
    assert.equal(outcome.executionMetadata?.browserSessionLinkedProcessLeaseId, processSnapshot.leaseId);
    assert.equal(outcome.executionMetadata?.browserSessionLinkedProcessCwd, tempDir);
    assert.equal(outcome.executionMetadata?.browserSessionLinkedProcessPid, 6123);
    assert.equal(outcome.executionMetadata?.browserSessionWorkspaceRootPath, tempDir);
    const snapshot = context.browserSessionRegistry.getSnapshot("browser_session:action_open_owned_preview");
    assert.equal(snapshot?.linkedProcessLeaseId, processSnapshot.leaseId);
    assert.equal(snapshot?.linkedProcessCwd, tempDir);
    assert.equal(snapshot?.linkedProcessPid, 6123);
    assert.equal(snapshot?.workspaceRootPath, tempDir);
    assert.equal(calls.length, 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("executeOpenBrowser reuses an existing managed browser session and infers the latest linked preview lease from the same task workspace", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "abb-live-run-reused-owned-preview-"));
  const indexPath = path.join(tempDir, "index.html");
  writeFileSync(indexPath, "<!doctype html><title>Drone Company</title>", "utf8");
  const stubRuntime = createStubPlaywrightRuntime();
  const managedProcessRegistry = new ManagedProcessRegistry({
    entropySource: {
      nowMs: (() => {
        let current = 1_000;
        return () => current++;
      })(),
      randomBase36: (length) => "a".repeat(length),
      randomHex: (length) => "b".repeat(length)
    }
  });
  managedProcessRegistry.registerStarted({
    actionId: "action_preview_process_old",
    child: createManagedProcessChild(6123),
    commandFingerprint: "preview-fingerprint-old",
    cwd: tempDir,
    shellExecutable: "node",
    shellKind: "powershell",
    taskId: "task_reused_preview"
  });
  const newestProcessSnapshot = managedProcessRegistry.registerStarted({
    actionId: "action_preview_process_new",
    child: createManagedProcessChild(6124),
    commandFingerprint: "preview-fingerprint-new",
    cwd: tempDir,
    shellExecutable: "node",
    shellKind: "powershell",
    taskId: "task_reused_preview"
  });

  try {
    const context = buildLiveRunContext({
      playwrightChromiumLoader: async () => stubRuntime.runtime,
      managedProcessRegistry
    });
    const fileUrl = `file:///${indexPath.replace(/\\/g, "/")}`;

    const firstOutcome = await executeOpenBrowser(
      context,
      "action_open_browser_first",
      {
        url: fileUrl
      },
      undefined,
      "task_reused_preview"
    );
    const secondOutcome = await executeOpenBrowser(
      context,
      "action_open_browser_second",
      {
        url: fileUrl,
        rootPath: tempDir
      },
      undefined,
      "task_reused_preview"
    );

    assert.equal(firstOutcome.status, "success");
    assert.equal(secondOutcome.status, "success");
    assert.equal(stubRuntime.getLaunchCount(), 1);
    assert.equal(
      secondOutcome.executionMetadata?.browserSessionId,
      firstOutcome.executionMetadata?.browserSessionId
    );
    assert.equal(
      secondOutcome.executionMetadata?.browserSessionLinkedProcessLeaseId,
      newestProcessSnapshot.leaseId
    );
    assert.equal(secondOutcome.executionMetadata?.browserSessionLinkedProcessCwd, tempDir);
    assert.equal(secondOutcome.executionMetadata?.browserSessionLinkedProcessPid, 6124);
    const reusedSnapshot = context.browserSessionRegistry.getSnapshot(
      String(secondOutcome.executionMetadata?.browserSessionId ?? "")
    );
    assert.equal(reusedSnapshot?.linkedProcessLeaseId, newestProcessSnapshot.leaseId);
    assert.equal(reusedSnapshot?.linkedProcessCwd, tempDir);
    assert.equal(reusedSnapshot?.linkedProcessPid, 6124);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("executeCloseBrowser closes a tracked managed browser session by session id", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const stubRuntime = createStubPlaywrightRuntime();
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const context = buildLiveRunContext({
      playwrightChromiumLoader: async () => stubRuntime.runtime
    });

    const openOutcome = await executeOpenBrowser(context, "action_open_browser_close_me", {
      url: `http://127.0.0.1:${address.port}/`
    });
    const closeOutcome = await executeCloseBrowser(context, {
      sessionId: String(openOutcome.executionMetadata?.browserSessionId ?? "")
    });

    assert.equal(closeOutcome.status, "success");
    assert.equal(closeOutcome.executionMetadata?.browserSessionStatus, "closed");
    assert.equal(stubRuntime.getPageCloseCount(), 1);
    assert.equal(stubRuntime.getContextCloseCount(), 1);
    assert.equal(stubRuntime.getBrowserCloseCount(), 1);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("executeCloseBrowser resolves a tracked local file preview by url", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "abb-live-run-file-close-"));
  const indexPath = path.join(tempDir, "index.html");
  writeFileSync(indexPath, "<!doctype html><title>Drone Company</title>", "utf8");
  const stubRuntime = createStubPlaywrightRuntime();
  const fileUrl = `file:///${indexPath.replace(/\\/g, "/")}`;

  try {
    const context = buildLiveRunContext({
      playwrightChromiumLoader: async () => stubRuntime.runtime
    });

    const openOutcome = await executeOpenBrowser(context, "action_open_browser_file_close", {
      url: fileUrl
    });
    assert.equal(openOutcome.status, "success");

    const closeOutcome = await executeCloseBrowser(context, {
      url: fileUrl
    });

    assert.equal(closeOutcome.status, "success");
    assert.equal(closeOutcome.executionMetadata?.browserSessionStatus, "closed");
    assert.equal(stubRuntime.getPageCloseCount(), 1);
    assert.equal(stubRuntime.getContextCloseCount(), 1);
    assert.equal(stubRuntime.getBrowserCloseCount(), 1);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("executeCloseBrowser recovers a persisted managed browser session by pid after runtime churn", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "abb-live-run-browser-"));
  try {
    const snapshotPath = path.join(tempDir, "browser_sessions.json");
    const seedRegistry = new BrowserSessionRegistry({ snapshotPath });
    const browser = {
      async newContext() {
        return {
          async newPage() {
            return {
              async goto(): Promise<void> {
                return;
              },
              async title(): Promise<string> {
                return "stub";
              },
              async textContent(): Promise<string> {
                return "stub";
              },
              async close(): Promise<void> {
                return;
              }
            };
          },
          async close(): Promise<void> {
            return;
          }
        };
      },
      async close(): Promise<void> {
        return;
      },
      process() {
        return { pid: 7555 } as unknown as import("node:child_process").ChildProcess;
      }
    };
    seedRegistry.registerManagedSession({
      sessionId: "browser_session:rehydrated_close",
      url: "http://127.0.0.1:4177/index.html",
      visibility: "visible",
      openedAt: new Date().toISOString(),
      browser,
      context: await browser.newContext(),
      page: await (await browser.newContext()).newPage(),
      browserProcessPid: 7555
    });
    const recoveredRegistry = new BrowserSessionRegistry({
      snapshotPath,
      isProcessAlive: () => true
    });
    let terminatedPid: number | null = null;
    const context = buildLiveRunContext({
      browserSessionRegistry: recoveredRegistry,
      terminateProcessTreeByPid: async (pid) => {
        terminatedPid = pid;
        return true;
      }
    });

    const outcome = await executeCloseBrowser(context, {
      sessionId: "browser_session:rehydrated_close"
    });

    assert.equal(outcome.status, "success");
    assert.equal(terminatedPid, 7555);
    assert.equal(
      recoveredRegistry.getSnapshot("browser_session:rehydrated_close")?.status,
      "closed"
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("executeCloseBrowser marks a restart-orphaned managed browser session closed after its linked preview stops", async () => {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "abb-live-run-browser-restart-close-"));
  try {
    const browserSnapshotPath = path.join(tempDir, "browser_sessions.json");
    const managedSnapshotPath = path.join(tempDir, "managed_processes.json");
    const managedProcessRegistry = new ManagedProcessRegistry({ snapshotPath: managedSnapshotPath });
    const processSnapshot = managedProcessRegistry.registerStarted({
      actionId: "action_restart_orphaned_preview",
      child: createManagedProcessChild(9555),
      commandFingerprint: "restart-orphaned-preview",
      cwd: tempDir,
      shellExecutable: "python",
      shellKind: "powershell"
    });
    managedProcessRegistry.markRecoveredStopped(processSnapshot.leaseId, 0, "SIGTERM");

    writeFileSync(
      browserSnapshotPath,
      `${JSON.stringify(
        {
          version: 1,
          sessions: [
            {
              sessionId: "browser_session:restart_orphaned_preview",
              url: "http://127.0.0.1:61234/index.html",
              status: "open",
              openedAt: "2026-03-15T12:00:00.000Z",
              closedAt: null,
              visibility: "visible",
              controllerKind: "playwright_managed",
              controlAvailable: false,
              browserProcessPid: null,
              workspaceRootPath: tempDir,
              linkedProcessLeaseId: processSnapshot.leaseId,
              linkedProcessCwd: tempDir,
              linkedProcessPid: processSnapshot.pid
            }
          ]
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    const browserSessionRegistry = new BrowserSessionRegistry({
      snapshotPath: browserSnapshotPath
    });
    const context = buildLiveRunContext({
      managedProcessRegistry,
      browserSessionRegistry,
      isProcessRunning: () => false
    });

    const outcome = await executeCloseBrowser(context, {
      sessionId: "browser_session:restart_orphaned_preview"
    });

    assert.equal(outcome.status, "success");
    assert.match(
      outcome.output,
      /linked preview process was already stopped, so I marked the tracked browser session .* closed\./i
    );
    const closedSnapshot = browserSessionRegistry.getSnapshot(
      "browser_session:restart_orphaned_preview"
    );
    assert.equal(closedSnapshot?.status, "closed");
    assert.equal(closedSnapshot?.controlAvailable, false);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("executeInspectPathHolders returns runtime-owned browser and preview holders for one local workspace path", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "abb-live-run-inspect-path-"));
  const indexPath = path.join(workspaceDir, "index.html");
  writeFileSync(indexPath, "<!doctype html><title>inspect path</title>", "utf8");

  try {
    const managedProcessRegistry = new ManagedProcessRegistry();
    const browserSessionRegistry = new BrowserSessionRegistry();
    const processSnapshot = managedProcessRegistry.registerStarted({
      actionId: "action_inspect_path_process",
      child: createManagedProcessChild(5111),
      commandFingerprint: "inspect-path-fingerprint",
      cwd: workspaceDir,
      shellExecutable: "python",
      shellKind: "powershell"
    });
    const handles = createManagedBrowserSessionHandles(6222);
    const browserSnapshot = browserSessionRegistry.registerManagedSession({
      sessionId: "browser_session:inspect_path",
      url: pathToFileURL(indexPath).toString(),
      visibility: "visible",
      openedAt: new Date().toISOString(),
      browser: handles.browser,
      context: handles.context,
      page: handles.page,
      browserProcessPid: handles.browserProcessPid
    });
    const context = buildLiveRunContext({
      managedProcessRegistry,
      browserSessionRegistry
    });

    const outcome = await executeInspectPathHolders(context, {
      path: workspaceDir
    });

    assert.equal(outcome.status, "success");
    assert.equal(outcome.executionMetadata?.runtimeOwnershipInspection, true);
    assert.equal(outcome.executionMetadata?.runtimeOwnershipInspectionKind, "path_holders");
    assert.equal(outcome.executionMetadata?.inspectionTargetPath, workspaceDir);
    assert.equal(outcome.executionMetadata?.inspectionBrowserSessionCount, 1);
    assert.equal(outcome.executionMetadata?.inspectionPreviewProcessCount, 1);
    assert.equal(
      outcome.executionMetadata?.inspectionBrowserSessionIds,
      browserSnapshot.sessionId
    );
    assert.equal(
      outcome.executionMetadata?.inspectionPreviewProcessLeaseIds,
      processSnapshot.leaseId
    );
    assert.equal(outcome.executionMetadata?.inspectionFoundTrackedHolder, true);
    assert.match(outcome.output, /Inspection results for/i);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("executeInspectWorkspaceResources returns exact runtime-owned workspace resources from precise selectors", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "abb-live-run-inspect-workspace-"));
  const previewUrl = "http://127.0.0.1:4177/index.html";

  try {
    const managedProcessRegistry = new ManagedProcessRegistry();
    const browserSessionRegistry = new BrowserSessionRegistry();
    const processSnapshot = managedProcessRegistry.registerStarted({
      actionId: "action_inspect_workspace_process",
      child: createManagedProcessChild(7333),
      commandFingerprint: "inspect-workspace-fingerprint",
      cwd: workspaceDir,
      shellExecutable: "python",
      shellKind: "powershell"
    });
    const handles = createManagedBrowserSessionHandles(8444);
    const browserSnapshot = browserSessionRegistry.registerManagedSession({
      sessionId: "browser_session:inspect_workspace",
      url: previewUrl,
      visibility: "visible",
      openedAt: new Date().toISOString(),
      browser: handles.browser,
      context: handles.context,
      page: handles.page,
      browserProcessPid: handles.browserProcessPid
    });
    const context = buildLiveRunContext({
      managedProcessRegistry,
      browserSessionRegistry
    });

    const outcome = await executeInspectWorkspaceResources(context, {
      rootPath: workspaceDir,
      previewUrl,
      browserSessionId: browserSnapshot.sessionId,
      previewProcessLeaseId: processSnapshot.leaseId
    });

    assert.equal(outcome.status, "success");
    assert.equal(outcome.executionMetadata?.runtimeOwnershipInspection, true);
    assert.equal(outcome.executionMetadata?.runtimeOwnershipInspectionKind, "workspace_resources");
    assert.equal(outcome.executionMetadata?.inspectionRootPath, workspaceDir);
    assert.equal(outcome.executionMetadata?.inspectionPreviewUrl, previewUrl);
    assert.equal(outcome.executionMetadata?.inspectionBrowserSessionCount, 1);
    assert.equal(outcome.executionMetadata?.inspectionPreviewProcessCount, 1);
    assert.equal(outcome.executionMetadata?.inspectionRecommendedNextAction, "stop_exact_tracked_holders");
    assert.equal(
      outcome.executionMetadata?.inspectionBrowserSessionIds,
      browserSnapshot.sessionId
    );
    assert.equal(
      outcome.executionMetadata?.inspectionPreviewProcessLeaseIds,
      processSnapshot.leaseId
    );
    assert.equal(outcome.executionMetadata?.inspectionFoundTrackedWorkspaceResource, true);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("executeInspectWorkspaceResources blocks when no selectors are provided", async () => {
  const outcome = await executeInspectWorkspaceResources(buildLiveRunContext(), {});

  assert.equal(outcome.status, "blocked");
  assert.equal(outcome.failureCode, "READ_MISSING_PATH");
  assert.match(outcome.output, /provide params\.rootPath/i);
});

test("executeInspectPathHolders reports no runtime-owned holders for an unrelated local path", async () => {
  const ownedWorkspaceDir = mkdtempSync(path.join(os.tmpdir(), "abb-live-run-inspect-owned-"));
  const unrelatedWorkspaceDir = mkdtempSync(
    path.join(os.tmpdir(), "abb-live-run-inspect-unrelated-")
  );
  try {
    const managedProcessRegistry = new ManagedProcessRegistry();
    managedProcessRegistry.registerStarted({
      actionId: "action_inspect_unrelated_process",
      child: createManagedProcessChild(9555),
      commandFingerprint: "inspect-unrelated-fingerprint",
      cwd: ownedWorkspaceDir,
      shellExecutable: "python",
      shellKind: "powershell"
    });
    const context = buildLiveRunContext({
      managedProcessRegistry
    });

    const outcome = await executeInspectPathHolders(context, {
      path: unrelatedWorkspaceDir
    });

    assert.equal(outcome.status, "success");
    assert.equal(outcome.executionMetadata?.inspectionBrowserSessionCount, 0);
  assert.equal(outcome.executionMetadata?.inspectionPreviewProcessCount, 0);
  assert.equal(outcome.executionMetadata?.inspectionFoundTrackedHolder, false);
  assert.equal(outcome.executionMetadata?.inspectionFoundTrackedWorkspaceResource, false);
  assert.equal(outcome.executionMetadata?.inspectionOwnershipClassification, "unknown");
  assert.equal(outcome.executionMetadata?.inspectionRecommendedNextAction, "collect_more_evidence");
  assert.match(outcome.output, /No current, stale, or attributable runtime-owned browser or preview resources/i);
  } finally {
    rmSync(ownedWorkspaceDir, { recursive: true, force: true });
    rmSync(unrelatedWorkspaceDir, { recursive: true, force: true });
  }
});

test("executeInspectWorkspaceResources separates stale tracked resources from current tracked holders", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "abb-live-run-inspect-stale-"));

  try {
    const managedProcessRegistry = new ManagedProcessRegistry();
    const browserSessionRegistry = new BrowserSessionRegistry();
    const processSnapshot = managedProcessRegistry.registerStarted({
      actionId: "action_inspect_stale_process",
      child: createManagedProcessChild(6444),
      commandFingerprint: "inspect-stale-fingerprint",
      cwd: workspaceDir,
      shellExecutable: "python",
      shellKind: "powershell"
    });
    managedProcessRegistry.markRecoveredStopped(processSnapshot.leaseId, 0, "SIGTERM");
    const handles = createManagedBrowserSessionHandles(7555);
    browserSessionRegistry.registerManagedSession({
      sessionId: "browser_session:inspect_stale_workspace",
      url: "http://127.0.0.1:4189/index.html",
      visibility: "visible",
      openedAt: new Date().toISOString(),
      browser: handles.browser,
      context: handles.context,
      page: handles.page,
      browserProcessPid: handles.browserProcessPid
    });
    await browserSessionRegistry.closeSession(
      "browser_session:inspect_stale_workspace"
    );
    const context = buildLiveRunContext({
      managedProcessRegistry,
      browserSessionRegistry
    });

    const outcome = await executeInspectWorkspaceResources(context, {
      rootPath: workspaceDir,
      previewUrl: "http://127.0.0.1:4189/index.html"
    });

    assert.equal(outcome.status, "success");
    assert.equal(outcome.executionMetadata?.inspectionBrowserSessionCount, 0);
    assert.equal(outcome.executionMetadata?.inspectionPreviewProcessCount, 0);
    assert.equal(outcome.executionMetadata?.inspectionStaleBrowserSessionCount, 1);
    assert.equal(outcome.executionMetadata?.inspectionStalePreviewProcessCount, 1);
    assert.equal(outcome.executionMetadata?.inspectionFoundTrackedWorkspaceResource, false);
    assert.equal(outcome.executionMetadata?.inspectionFoundStaleTrackedResource, true);
    assert.equal(outcome.executionMetadata?.inspectionOwnershipClassification, "stale_tracked");
    assert.equal(outcome.executionMetadata?.inspectionRecommendedNextAction, "collect_more_evidence");
    assert.match(outcome.output, /stale tracked browser sessions/i);
    assert.match(outcome.output, /stale tracked preview processes/i);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("executeInspectWorkspaceResources reports likely untracked preview holders separately from tracked resources", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8801,
      port: 4177,
      processName: "python.exe",
      commandLine: "python -m http.server 4177",
      confidence: "high",
      reason: "listening_on_preview_port",
      holderKind: "preview_server"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    previewUrl: "http://127.0.0.1:4177/index.html"
  });

  assert.equal(outcome.status, "success");
  assert.equal(outcome.executionMetadata?.inspectionPreviewProcessCount, 0);
  assert.equal(outcome.executionMetadata?.inspectionBrowserSessionCount, 0);
  assert.equal(outcome.executionMetadata?.inspectionUntrackedCandidateCount, 1);
  assert.equal(outcome.executionMetadata?.inspectionUntrackedCandidatePids, "8801");
  assert.equal(outcome.executionMetadata?.inspectionUntrackedCandidateNames, "python.exe");
  assert.equal(outcome.executionMetadata?.inspectionUntrackedCandidateConfidences, "high");
  assert.equal(outcome.executionMetadata?.inspectionUntrackedCandidateKinds, "preview_server");
  assert.equal(outcome.executionMetadata?.inspectionUntrackedCandidateReasons, "listening_on_preview_port");
  assert.equal(outcome.executionMetadata?.inspectionFoundOrphanedAttributableResource, true);
  assert.equal(outcome.executionMetadata?.inspectionOwnershipClassification, "orphaned_attributable");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "clarify_before_untracked_shutdown"
  );
  assert.match(outcome.output, /likely orphaned attributable preview holders/i);
});

test("executeInspectPathHolders promotes exact content-matched preview holders into recovered exact holders", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "abb-live-run-inspect-exact-match-"));
  try {
    writeFileSync(
      path.join(workspaceDir, "index.html"),
      "<!doctype html><title>Drone</title><main>same content</main>",
      "utf8"
    );
    const context = buildLiveRunContext({
      inspectSystemPreviewCandidates: async () => [
        {
          pid: 9901,
          port: 4173,
          processName: "python.exe",
          commandLine: "python -m http.server 4173",
          confidence: "high",
          reason: "served_index_matches_target_workspace",
          holderKind: "preview_server"
        }
      ]
    });

    const outcome = await executeInspectPathHolders(context, {
      path: workspaceDir
    });

    assert.equal(outcome.status, "success");
    assert.equal(outcome.executionMetadata?.inspectionRecoveredExactPreviewHolderCount, 1);
    assert.equal(outcome.executionMetadata?.inspectionRecoveredExactPreviewHolderPids, "9901");
    assert.equal(outcome.executionMetadata?.inspectionRecommendedNextAction, "stop_exact_tracked_holders");
    assert.match(outcome.output, /recovered exact preview holders/i);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("executeInspectWorkspaceResources keeps weaker editor holder matches in the manual cleanup lane", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8810,
      port: null,
      processName: "Code.exe",
      commandLine: "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(outcome.executionMetadata?.inspectionUntrackedCandidateCount, 1);
  assert.equal(outcome.executionMetadata?.inspectionUntrackedCandidateKinds, "editor_workspace");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "manual_non_preview_holder_cleanup"
  );
  assert.match(outcome.output, /likely non-preview local holders/i);
  assert.match(outcome.output, /editor_workspace/i);
  assert.match(outcome.output, /manual_non_preview_holder_cleanup/i);
  assert.match(outcome.output, /Close Code if that project is still open there/i);
});

test("executeInspectWorkspaceResources asks for confirmation on a small likely editor and shell holder set", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8810,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --reuse-window drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8811,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "clarify_before_likely_non_preview_shutdown"
  );
  assert.equal(outcome.executionMetadata?.inspectionUntrackedCandidatePids, "8810,8811");
  assert.match(
    outcome.output,
    /Recommended next safe action: clarify_before_likely_non_preview_shutdown/i
  );
  assert.match(outcome.output, /2 likely local editor or shell holders/i);
});

test("executeInspectWorkspaceResources keeps contextual clarification for a still-bounded four-holder local editor and shell set", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8810,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --reuse-window drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8811,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8812,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company*",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8813,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --folder-uri file:///C:/Users/testuser/Desktop/drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "clarify_before_likely_non_preview_shutdown"
  );
  assert.equal(outcome.executionMetadata?.inspectionUntrackedCandidatePids, "8810,8811,8812,8813");
  assert.match(
    outcome.output,
    /Recommended next safe action: clarify_before_likely_non_preview_shutdown/i
  );
  assert.match(outcome.output, /4 likely local editor or shell holders/i);
});

test("executeInspectWorkspaceResources keeps contextual clarification for a broader five-holder local editor and shell set", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8820,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --reuse-window drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8821,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8822,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company*",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8823,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --folder-uri file:///C:/Users/testuser/Desktop/drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8824,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "clarify_before_likely_non_preview_shutdown"
  );
  assert.equal(
    outcome.executionMetadata?.inspectionUntrackedCandidatePids,
    "8820,8821,8822,8823,8824"
  );
  assert.match(
    outcome.output,
    /Recommended next safe action: clarify_before_likely_non_preview_shutdown/i
  );
  assert.match(outcome.output, /5 likely local editor or shell holders/i);
});

test("executeInspectWorkspaceResources keeps contextual clarification for a broader seven-holder local editor and shell set", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8820,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --reuse-window drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8821,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8822,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company*",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8823,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --folder-uri file:///C:/Users/testuser/Desktop/drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8824,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8825,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Get-Item C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8826,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --reuse-window --goto drone-company\\index.html",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "clarify_before_likely_non_preview_shutdown"
  );
  assert.equal(
    outcome.executionMetadata?.inspectionUntrackedCandidatePids,
    "8820,8821,8822,8823,8824,8825,8826"
  );
  assert.match(
    outcome.output,
    /Recommended next safe action: clarify_before_likely_non_preview_shutdown/i
  );
  assert.match(outcome.output, /7 likely local editor or shell holders/i);
});

test("executeInspectWorkspaceResources keeps contextual clarification for a bounded mixed editor shell and sync holder set", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8830,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --reuse-window drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8831,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8832,
      port: null,
      processName: "OneDrive.exe",
      commandLine:
        "\"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe\" /background drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "sync_client"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "clarify_before_likely_non_preview_shutdown"
  );
  assert.equal(
    outcome.executionMetadata?.inspectionUntrackedCandidatePids,
    "8830,8831,8832"
  );
  assert.match(
    outcome.output,
    /3 likely local non-preview holders across editor, shell, or sync processes/i
  );
});

test("executeInspectWorkspaceResources keeps contextual clarification for a bounded mixed holder set with a nearby exact-path local process", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8830,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --reuse-window drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8831,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8832,
      port: null,
      processName: "AcmeDesktopHelper.exe",
      commandLine:
        "\"C:\\Program Files\\Acme\\AcmeDesktopHelper.exe\" --watch C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_matches_target_path",
      holderKind: "unknown_local_process"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "clarify_before_likely_non_preview_shutdown"
  );
  assert.equal(
    outcome.executionMetadata?.inspectionUntrackedCandidatePids,
    "8830,8831,8832"
  );
  assert.match(
    outcome.output,
    /3 likely local non-preview holders across editor, shell, or nearby local processes/i
  );
});

test("executeInspectWorkspaceResources keeps contextual clarification for a broader five-holder mixed set with one nearby exact-path local process", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8840,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --reuse-window drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8841,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8842,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company*",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8843,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --folder-uri file:///C:/Users/testuser/Desktop/drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8844,
      port: null,
      processName: "AcmeDesktopHelper.exe",
      commandLine:
        "\"C:\\Program Files\\Acme\\AcmeDesktopHelper.exe\" --watch C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_matches_target_path",
      holderKind: "unknown_local_process"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "clarify_before_likely_non_preview_shutdown"
  );
  assert.equal(
    outcome.executionMetadata?.inspectionUntrackedCandidatePids,
    "8840,8841,8842,8843,8844"
  );
  assert.match(
    outcome.output,
    /5 likely local non-preview holders across editor, shell, or nearby local processes/i
  );
});

test("executeInspectWorkspaceResources keeps contextual clarification for a broader six-holder mixed set with sync and one nearby exact-path local process", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8850,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --reuse-window drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8851,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8852,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company*",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8853,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --folder-uri file:///C:/Users/testuser/Desktop/drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8854,
      port: null,
      processName: "OneDrive.exe",
      commandLine:
        "\"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe\" /background drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "sync_client"
    },
    {
      pid: 8855,
      port: null,
      processName: "AcmeDesktopHelper.exe",
      commandLine:
        "\"C:\\Program Files\\Acme\\AcmeDesktopHelper.exe\" --watch C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_matches_target_path",
      holderKind: "unknown_local_process"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "clarify_before_likely_non_preview_shutdown"
  );
  assert.equal(
    outcome.executionMetadata?.inspectionUntrackedCandidatePids,
    "8850,8851,8852,8853,8854,8855"
  );
  assert.match(
    outcome.output,
    /6 likely local non-preview holders across editor, shell, sync, or nearby local processes/i
  );
});

test("executeInspectWorkspaceResources keeps contextual clarification for a broader seven-holder mixed set with sync and one nearby exact-path local process", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8860,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --reuse-window drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8861,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8862,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company*",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8863,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --folder-uri file:///C:/Users/testuser/Desktop/drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8864,
      port: null,
      processName: "OneDrive.exe",
      commandLine:
        "\"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe\" /background drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "sync_client"
    },
    {
      pid: 8865,
      port: null,
      processName: "cmd.exe",
      commandLine: "cmd.exe /c dir C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8866,
      port: null,
      processName: "AcmeDesktopHelper.exe",
      commandLine:
        "\"C:\\Program Files\\Acme\\AcmeDesktopHelper.exe\" --watch C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_matches_target_path",
      holderKind: "unknown_local_process"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "clarify_before_likely_non_preview_shutdown"
  );
  assert.equal(
    outcome.executionMetadata?.inspectionUntrackedCandidatePids,
    "8860,8861,8862,8863,8864,8865,8866"
  );
  assert.match(
    outcome.output,
    /7 likely local non-preview holders across editor, shell, sync, or nearby local processes/i
  );
});

test("executeInspectWorkspaceResources keeps contextual clarification for a broader eight-holder mixed set with sync and one nearby exact-path local process", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8870,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --reuse-window drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8871,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8872,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company*",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8873,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --folder-uri file:///C:/Users/testuser/Desktop/drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8874,
      port: null,
      processName: "OneDrive.exe",
      commandLine:
        "\"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe\" /background drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "sync_client"
    },
    {
      pid: 8875,
      port: null,
      processName: "cmd.exe",
      commandLine: "cmd.exe /c dir C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8876,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --goto C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8877,
      port: null,
      processName: "AcmeDesktopHelper.exe",
      commandLine:
        "\"C:\\Program Files\\Acme\\AcmeDesktopHelper.exe\" --watch C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_matches_target_path",
      holderKind: "unknown_local_process"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "clarify_before_likely_non_preview_shutdown"
  );
  assert.equal(
    outcome.executionMetadata?.inspectionUntrackedCandidatePids,
    "8870,8871,8872,8873,8874,8875,8876,8877"
  );
  assert.match(
    outcome.output,
    /8 likely local non-preview holders across editor, shell, sync, or nearby local processes/i
  );
});

test("executeInspectWorkspaceResources keeps broader noisy local holder groups in manual cleanup", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8830,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --reuse-window drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8831,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8832,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company*",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8833,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --folder-uri file:///C:/Users/testuser/Desktop/drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8834,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "manual_non_preview_holder_cleanup"
  );
  assert.match(outcome.output, /manual_non_preview_holder_cleanup/i);
});

test("executeInspectWorkspaceResources keeps broader still-local holder families on contextual manual cleanup wording", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8880,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8881,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company*",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8882,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8883,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-Item C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8884,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe C:\\Users\\testuser\\Desktop\\drone-company\\assets",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8885,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop\\drone-company; Get-ChildItem",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8886,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8887,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company\\*",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8888,
      port: null,
      processName: "AcmeDesktopHelper.exe",
      commandLine:
        "\"C:\\Program Files\\Acme\\AcmeDesktopHelper.exe\" --watch C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_matches_target_path",
      holderKind: "unknown_local_process"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "manual_non_preview_holder_cleanup"
  );
  assert.match(
    outcome.output,
    /9 likely local non-preview holders across editor, shell, or nearby local processes/i
  );
  assert.match(outcome.output, /outside the confirmation lane/i);
});

test("executeInspectWorkspaceResources keeps grouped thirteen-holder local families on contextual manual cleanup wording", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8890,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --folder-uri file:///C:/Users/testuser/Desktop/drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8891,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8892,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company*",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8893,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8894,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8895,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop\\drone-company; Get-ChildItem",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8896,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --reuse-window drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8897,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe C:\\Users\\testuser\\Desktop\\drone-company\\assets",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8898,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-Item C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8899,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --diff drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8900,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8901,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company\\*",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8902,
      port: null,
      processName: "AcmeDesktopHelper.exe",
      commandLine:
        "\"C:\\Program Files\\Acme\\AcmeDesktopHelper.exe\" --watch C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_matches_target_path",
      holderKind: "unknown_local_process"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "manual_non_preview_holder_cleanup"
  );
  assert.match(
    outcome.output,
    /13 likely local non-preview holders across editor, shell, or nearby local processes/i
  );
  assert.match(outcome.output, /outside the confirmation lane/i);
});

test("executeInspectWorkspaceResources keeps grouped fifteen-holder local families with two nearby local processes on contextual manual cleanup wording", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8910,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --folder-uri file:///C:/Users/testuser/Desktop/drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8911,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8912,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company*",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8913,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8914,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8915,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop\\drone-company; Get-ChildItem",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8916,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --reuse-window drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8917,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe C:\\Users\\testuser\\Desktop\\drone-company\\assets",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8918,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-Item C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8919,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --diff drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8920,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8921,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company\\*",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8922,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --file-write C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8923,
      port: null,
      processName: "AcmeDesktopHelper.exe",
      commandLine:
        "\"C:\\Program Files\\Acme\\AcmeDesktopHelper.exe\" --watch C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_matches_target_path",
      holderKind: "unknown_local_process"
    },
    {
      pid: 8924,
      port: null,
      processName: "WatchBridgeService.exe",
      commandLine:
        "\"C:\\Program Files\\WatchBridge\\WatchBridgeService.exe\" --workspace C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_matches_target_path",
      holderKind: "unknown_local_process"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "manual_non_preview_holder_cleanup"
  );
  assert.match(
    outcome.output,
    /15 likely local non-preview holders across editor, shell, or nearby local processes/i
  );
  assert.match(outcome.output, /outside the confirmation lane/i);
});

test("executeInspectWorkspaceResources keeps grouped eighteen-holder mixed local families with two nearby local processes on contextual manual cleanup wording", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8930,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --folder-uri file:///C:/Users/testuser/Desktop/drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8931,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8932,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company*",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8933,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8934,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8935,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop\\drone-company; Get-ChildItem",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8936,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --reuse-window drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8937,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe C:\\Users\\testuser\\Desktop\\drone-company\\assets",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8938,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-Item C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8939,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --diff drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8940,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8941,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company\\*",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8942,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --file-write C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8943,
      port: null,
      processName: "AcmeDesktopHelper.exe",
      commandLine:
        "\"C:\\Program Files\\Acme\\AcmeDesktopHelper.exe\" --watch C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_matches_target_path",
      holderKind: "unknown_local_process"
    },
    {
      pid: 8944,
      port: null,
      processName: "WatchBridgeService.exe",
      commandLine:
        "\"C:\\Program Files\\WatchBridge\\WatchBridgeService.exe\" --workspace C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_matches_target_path",
      holderKind: "unknown_local_process"
    },
    {
      pid: 8945,
      port: null,
      processName: "OneDrive.exe",
      commandLine:
        "\"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe\" /background C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "sync_client"
    },
    {
      pid: 8946,
      port: null,
      processName: "OneDrive.exe",
      commandLine:
        "\"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe\" /background /monitor drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "sync_client"
    },
    {
      pid: 8947,
      port: null,
      processName: "OneDrive.exe",
      commandLine:
        "\"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe\" /background /touch C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "sync_client"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "manual_non_preview_holder_cleanup"
  );
  assert.match(
    outcome.output,
    /18 likely local non-preview holders across editor, shell, sync, or nearby local processes/i
  );
  assert.match(outcome.output, /outside the confirmation lane/i);
  assert.match(
    outcome.output,
    /Close or pause Code, explorer, powershell, AcmeDesktopHelper, WatchBridgeService, and OneDrive if they are still tied to that project/i
  );
});

test("executeInspectWorkspaceResources keeps repeated-family twenty-four-holder mixed local families on contextual manual cleanup wording", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8950,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --folder-uri file:///C:/Users/testuser/Desktop/drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8951,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8952,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company*",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8953,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8954,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8955,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop\\drone-company; Get-ChildItem",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8956,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --reuse-window drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8957,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe C:\\Users\\testuser\\Desktop\\drone-company\\assets",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8958,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-Item C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8959,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --diff drone-company",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8960,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8961,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company\\*",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8962,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --file-write C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8963,
      port: null,
      processName: "AcmeDesktopHelper.exe",
      commandLine:
        "\"C:\\Program Files\\Acme\\AcmeDesktopHelper.exe\" --watch C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_matches_target_path",
      holderKind: "unknown_local_process"
    },
    {
      pid: 8964,
      port: null,
      processName: "WatchBridgeService.exe",
      commandLine:
        "\"C:\\Program Files\\WatchBridge\\WatchBridgeService.exe\" --workspace C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_matches_target_path",
      holderKind: "unknown_local_process"
    },
    {
      pid: 8965,
      port: null,
      processName: "OneDrive.exe",
      commandLine:
        "\"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe\" /background C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "sync_client"
    },
    {
      pid: 8966,
      port: null,
      processName: "OneDrive.exe",
      commandLine:
        "\"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe\" /background /monitor drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "sync_client"
    },
    {
      pid: 8967,
      port: null,
      processName: "OneDrive.exe",
      commandLine:
        "\"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe\" /background /touch C:\\Users\\testuser\\Desktop\\drone-company\\index.html",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "sync_client"
    },
    {
      pid: 8968,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --goto C:\\Users\\testuser\\Desktop\\drone-company\\README.md",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8969,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe C:\\Users\\testuser\\Desktop\\drone-company\\docs",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8970,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Get-Content C:\\Users\\testuser\\Desktop\\drone-company\\README.md",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8971,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" --wait C:\\Users\\testuser\\Desktop\\drone-company\\README.md",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "editor_workspace"
    },
    {
      pid: 8972,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe /select,C:\\Users\\testuser\\Desktop\\drone-company\\README.md",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    },
    {
      pid: 8973,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop\\drone-company\\docs; Get-ChildItem",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "manual_non_preview_holder_cleanup"
  );
  assert.match(
    outcome.output,
    /24 likely local non-preview holders across editor, shell, sync, or nearby local processes/i
  );
  assert.match(outcome.output, /outside the confirmation lane/i);
  assert.match(
    outcome.output,
    /Close or pause Code, explorer, powershell, AcmeDesktopHelper, WatchBridgeService, and OneDrive if they are still tied to that project/i
  );
});

test("executeInspectWorkspaceResources upgrades one exact-path editor holder into targeted confirmation", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8810,
      port: null,
      processName: "Code.exe",
      commandLine: "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_matches_target_path",
      holderKind: "editor_workspace"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "clarify_before_exact_non_preview_shutdown"
  );
  assert.equal(outcome.executionMetadata?.inspectionUntrackedCandidateConfidences, "high");
  assert.match(outcome.output, /Recommended next safe action: clarify_before_exact_non_preview_shutdown/i);
  assert.match(outcome.output, /Code\.exe/i);
});

test("executeInspectWorkspaceResources upgrades one exact-path shell holder into targeted confirmation", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8820,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_matches_target_path",
      holderKind: "shell_workspace"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "clarify_before_exact_non_preview_shutdown"
  );
  assert.equal(outcome.executionMetadata?.inspectionUntrackedCandidateConfidences, "high");
  assert.match(outcome.output, /shell_workspace/i);
  assert.match(outcome.output, /clarify_before_exact_non_preview_shutdown/i);
  assert.match(outcome.output, /explorer\.exe/i);
});

test("executeInspectWorkspaceResources upgrades one exact-path sync holder into targeted confirmation", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8830,
      port: null,
      processName: "OneDrive.exe",
      commandLine:
        "\"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe\" /background C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "medium",
      reason: "command_line_matches_target_path",
      holderKind: "sync_client"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "clarify_before_exact_non_preview_shutdown"
  );
  assert.equal(outcome.executionMetadata?.inspectionUntrackedCandidateConfidences, "high");
  assert.match(outcome.output, /clarify_before_exact_non_preview_shutdown/i);
  assert.match(outcome.output, /OneDrive\.exe/i);
});

test("executeInspectWorkspaceResources asks for targeted confirmation on one high-confidence non-preview holder", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8840,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "high",
      reason: "command_line_matches_target_path",
      holderKind: "editor_workspace"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "clarify_before_exact_non_preview_shutdown"
  );
  assert.equal(outcome.executionMetadata?.inspectionUntrackedCandidatePids, "8840");
  assert.equal(outcome.executionMetadata?.inspectionUntrackedCandidateConfidences, "high");
  assert.match(outcome.output, /Recommended next safe action: clarify_before_exact_non_preview_shutdown/i);
  assert.match(outcome.output, /Code\.exe/i);
});

test("executeInspectWorkspaceResources keeps targeted confirmation when one exact-path holder dominates weaker local matches", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8840,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "high",
      reason: "command_line_matches_target_path",
      holderKind: "editor_workspace"
    },
    {
      pid: 8841,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company*",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "clarify_before_exact_non_preview_shutdown"
  );
  assert.equal(outcome.executionMetadata?.inspectionUntrackedCandidatePids, "8840,8841");
  assert.equal(outcome.executionMetadata?.inspectionUntrackedCandidateConfidences, "high,low");
  assert.match(
    outcome.output,
    /I also found weaker non-preview matches, but this exact path match is still the strongest shutdown-safe candidate/i
  );
});

test("executeInspectWorkspaceResources keeps targeted confirmation when two exact-path holders dominate weaker local matches", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8840,
      port: null,
      processName: "Code.exe",
      commandLine:
        "\"C:\\Users\\testuser\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\" C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "high",
      reason: "command_line_matches_target_path",
      holderKind: "editor_workspace"
    },
    {
      pid: 8841,
      port: null,
      processName: "explorer.exe",
      commandLine: "explorer.exe C:\\Users\\testuser\\Desktop\\drone-company",
      confidence: "high",
      reason: "command_line_matches_target_path",
      holderKind: "shell_workspace"
    },
    {
      pid: 8842,
      port: null,
      processName: "powershell.exe",
      commandLine:
        "powershell.exe -NoProfile -Command Set-Location C:\\Users\\testuser\\Desktop; Get-ChildItem drone-company*",
      confidence: "low",
      reason: "command_line_mentions_target_name",
      holderKind: "shell_workspace"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "clarify_before_exact_non_preview_shutdown"
  );
  assert.equal(outcome.executionMetadata?.inspectionUntrackedCandidatePids, "8840,8841,8842");
  assert.equal(outcome.executionMetadata?.inspectionUntrackedCandidateConfidences, "high,high,low");
  assert.match(
    outcome.output,
    /2 high-confidence exact local holders look tied to this workspace/i
  );
  assert.match(
    outcome.output,
    /I also found weaker non-preview matches, but these exact path matches are still the strongest shutdown-safe candidates/i
  );
});

test("executeInspectWorkspaceResources gives sync-specific manual cleanup guidance for non-preview holders", async () => {
  const untrackedCandidates: readonly UntrackedHolderCandidate[] = [
    {
      pid: 8830,
      port: null,
      processName: "OneDrive.exe",
      commandLine:
        "\"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe\" /background drone-company",
      confidence: "medium",
      reason: "command_line_mentions_target_name",
      holderKind: "sync_client"
    }
  ];
  const context = buildLiveRunContext({
    inspectSystemPreviewCandidates: async () => untrackedCandidates
  });

  const outcome = await executeInspectWorkspaceResources(context, {
    rootPath: "C:\\Users\\testuser\\Desktop\\drone-company"
  });

  assert.equal(outcome.status, "success");
  assert.equal(
    outcome.executionMetadata?.inspectionRecommendedNextAction,
    "manual_non_preview_holder_cleanup"
  );
  assert.match(outcome.output, /sync_client/i);
  assert.match(outcome.output, /Pause or let OneDrive finish with that folder/i);
});

test("executeInspectWorkspaceResources recovers an exact preview holder from stale runtime lineage", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "abb-live-run-inspect-recovered-lineage-"));

  try {
    const managedProcessRegistry = new ManagedProcessRegistry();
    const browserSessionRegistry = new BrowserSessionRegistry();
    const processSnapshot = managedProcessRegistry.registerStarted({
      actionId: "action_recovered_lineage_a1b2",
      child: createManagedProcessChild(6444),
      commandFingerprint: "inspect-recovered-lineage",
      cwd: workspaceDir,
      shellExecutable: "python",
      shellKind: "powershell"
    });
    managedProcessRegistry.markRecoveredStopped(processSnapshot.leaseId, 0, "SIGTERM");
    browserSessionRegistry.registerDetachedSession({
      sessionId: "browser_session:action_recovered_lineage_c3d4",
      url: "http://127.0.0.1:4171/index.html",
      visibility: "visible",
      openedAt: new Date().toISOString()
    });
    const context = buildLiveRunContext({
      managedProcessRegistry,
      browserSessionRegistry,
      inspectSystemPreviewCandidates: async (request) =>
        request.previewUrl === "http://127.0.0.1:4171/index.html"
          ? [
              {
                pid: 5724,
                port: 4171,
                holderKind: "preview_server",
                processName: "python.exe",
                commandLine: "python -m http.server 4171",
                confidence: "high",
                reason: "listening_on_preview_port"
              }
            ]
          : []
    });

    const outcome = await executeInspectWorkspaceResources(context, {
      rootPath: workspaceDir
    });

    assert.equal(outcome.status, "success");
    assert.equal(outcome.executionMetadata?.inspectionPreviewProcessCount, 0);
    assert.equal(outcome.executionMetadata?.inspectionStalePreviewProcessCount, 1);
    assert.equal(outcome.executionMetadata?.inspectionRecoveredExactPreviewHolderCount, 1);
    assert.equal(outcome.executionMetadata?.inspectionRecoveredExactPreviewHolderPids, "5724");
    assert.equal(outcome.executionMetadata?.inspectionRecoveredExactPreviewHolderLeaseIds, processSnapshot.leaseId);
    assert.equal(outcome.executionMetadata?.inspectionRecommendedNextAction, "stop_exact_tracked_holders");
    assert.match(outcome.output, /recovered exact preview holders/i);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

test("executeInspectWorkspaceResources finds orphaned browser sessions by workspace root even when the preview URL is localhost", async () => {
  const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "abb-live-run-inspect-orphaned-root-"));

  try {
    const browserSessionRegistry = new BrowserSessionRegistry();
    browserSessionRegistry.registerDetachedSession({
      sessionId: "browser_session:orphaned_workspace_root",
      url: "http://127.0.0.1:4177/index.html",
      visibility: "visible",
      openedAt: new Date().toISOString(),
      workspaceRootPath: workspaceDir
    });
    const context = buildLiveRunContext({
      browserSessionRegistry
    });

    const outcome = await executeInspectWorkspaceResources(context, {
      rootPath: workspaceDir
    });

    assert.equal(outcome.status, "success");
    assert.equal(outcome.executionMetadata?.inspectionBrowserSessionCount, 0);
    assert.equal(outcome.executionMetadata?.inspectionOrphanedBrowserSessionCount, 1);
    assert.equal(
      outcome.executionMetadata?.inspectionOrphanedBrowserSessionIds,
      "browser_session:orphaned_workspace_root"
    );
    assert.equal(outcome.executionMetadata?.inspectionOwnershipClassification, "orphaned_attributable");
    assert.equal(
      outcome.executionMetadata?.inspectionRecommendedNextAction,
      "manual_orphaned_browser_cleanup"
    );
    assert.match(outcome.output, /orphaned attributable browser sessions/i);
    assert.match(outcome.output, /manual_orphaned_browser_cleanup/i);
    assert.match(outcome.output, /older assistant browser windows still tied to the workspace/i);
  } finally {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});
