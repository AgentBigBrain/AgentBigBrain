/**
 * @fileoverview Executes managed-process startup for live-run flows.
 */

import { ChildProcessWithoutNullStreams } from "node:child_process";

import { hashSha256 } from "../../core/cryptoUtils";
import { isAbortError, throwIfAborted } from "../../core/runtimeAbort";
import { buildShellSpawnSpec } from "../../core/shellRuntimeProfile";
import { ExecutorExecutionOutcome, StartProcessActionParams } from "../../core/types";
import {
  resolveCommandAwareShellEnvironment,
  resolveEffectiveShellProfile
} from "../executionRuntime/shellExecutionSupport";
import {
  buildExecutionOutcome,
  buildManagedProcessExecutionMetadata,
  buildManagedProcessStartFailureExecutionMetadata,
  findAvailableLoopbackPort,
  inferManagedProcessLoopbackTarget,
  LiveRunExecutorContext,
  MANAGED_PROCESS_PORT_PRECHECK_TIMEOUT_MS,
  normalizeOptionalString,
  performLocalPortProbe,
  waitForManagedProcessStart
} from "./contracts";

/**
 * Executes `start_process` with managed-process lease registration and loopback preflight checks.
 *
 * **Why it exists:**
 * Keeps long-running process startup separate from the generic executor so live-run lifecycle
 * policy, recovery hints, and cleanup semantics have one canonical home.
 *
 * **What it talks to:**
 * - Uses `resolveShellEnvironment` and `buildShellSpawnSpec` from `../../core/shellRuntimeProfile`.
 * - Uses `ManagedProcessRegistry` through `LiveRunExecutorContext` from `./contracts`.
 *
 * @param context - Shared executor dependencies for live-run capability handlers.
 * @param actionId - Stable action identifier for the new lease.
 * @param params - Structured planner params for this start request.
 * @param signal - Optional abort signal propagated from the runtime.
 * @param taskId - Optional owning task identifier for cleanup bookkeeping.
 * @returns Promise resolving to a typed executor outcome.
 */
export async function executeStartProcess(
  context: LiveRunExecutorContext,
  actionId: string,
  params: StartProcessActionParams,
  signal?: AbortSignal,
  taskId?: string
): Promise<ExecutorExecutionOutcome> {
  throwIfAborted(signal);
  if (!context.config.permissions.allowRealShellExecution) {
    return buildExecutionOutcome(
      "blocked",
      "Process start blocked: real shell execution is disabled by policy.",
      "PROCESS_DISABLED_BY_POLICY"
    );
  }

  const command = normalizeOptionalString(params.command);
  if (!command) {
    return buildExecutionOutcome(
      "blocked",
      "Process start blocked: missing command.",
      "PROCESS_MISSING_COMMAND"
    );
  }

  const resolvedCwd = context.resolveShellCommandCwd(params);
  if (!resolvedCwd) {
    return buildExecutionOutcome(
      "blocked",
      "Process start blocked: requested cwd is outside sandbox policy.",
      "PROCESS_CWD_OUTSIDE_SANDBOX"
    );
  }

  const effectiveShellProfile = resolveEffectiveShellProfile(
    context.config.shellRuntime.profile,
    command
  );
  const shellEnvironment = resolveCommandAwareShellEnvironment(
    effectiveShellProfile,
    command,
    process.env
  );
  const commandFingerprint = hashSha256(command);
  const spawnSpec = buildShellSpawnSpec({
    profile: effectiveShellProfile,
    command,
    cwd: resolvedCwd,
    timeoutMs: effectiveShellProfile.timeoutMsDefault,
    envKeyNames: shellEnvironment.envKeyNames
  });
  const loopbackTarget = inferManagedProcessLoopbackTarget(command);

  if (loopbackTarget) {
    const portAlreadyOccupied = await performLocalPortProbe(
      loopbackTarget.host,
      loopbackTarget.port,
      MANAGED_PROCESS_PORT_PRECHECK_TIMEOUT_MS,
      signal
    );
    if (portAlreadyOccupied) {
      const suggestedPort = await findAvailableLoopbackPort(signal);
      return buildExecutionOutcome(
        "failed",
        `Process start failed: ${loopbackTarget.url} was already occupied before startup.` +
          `${suggestedPort !== null ? ` Try a different free loopback port such as ${suggestedPort}.` : ""}`,
        "PROCESS_START_FAILED",
        buildManagedProcessStartFailureExecutionMetadata({
          commandFingerprint,
          cwd: spawnSpec.cwd,
          shellExecutable: spawnSpec.executable,
          shellKind: effectiveShellProfile.shellKind,
          failureKind: "PORT_IN_USE",
          requestedHost: loopbackTarget.host,
          requestedPort: loopbackTarget.port,
          requestedUrl: loopbackTarget.url,
          suggestedPort
        })
      );
    }
  }

  try {
    const child = context.shellSpawn(spawnSpec.executable, [...spawnSpec.args], {
      cwd: spawnSpec.cwd,
      detached: process.platform !== "win32",
      env: shellEnvironment.env,
      windowsHide: true,
      windowsVerbatimArguments: effectiveShellProfile.shellKind === "cmd",
      stdio: ["pipe", "pipe", "pipe"]
    });
    if (typeof child.stdout.resume === "function") {
      child.stdout.resume();
    }
    if (typeof child.stderr.resume === "function") {
      child.stderr.resume();
    }
    await waitForManagedProcessStart(child, context.terminateProcessTree, signal);
    const snapshot = context.managedProcessRegistry.registerStarted({
      actionId,
      child,
      commandFingerprint,
      cwd: spawnSpec.cwd,
      shellExecutable: spawnSpec.executable,
      shellKind: effectiveShellProfile.shellKind,
      taskId
    });
    bindAbortCleanupForManagedProcess(context, snapshot.leaseId, child, signal);
    return buildExecutionOutcome(
      "success",
      `Process started: lease ${snapshot.leaseId} (pid ${snapshot.pid ?? "unknown"}).`,
      undefined,
      buildManagedProcessExecutionMetadata(snapshot, "PROCESS_STARTED")
    );
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return buildExecutionOutcome(
      "failed",
      `Process start failed: ${(error as Error).message}`,
      "PROCESS_START_FAILED"
    );
  }
}

/**
 * Binds one managed-process lease to an abort signal for deterministic cleanup.
 *
 * **Why it exists:**
 * `start_process` can succeed before the owning task is cancelled. This helper ensures the lease
 * is still marked stop-requested and the child tree is torn down on later abort.
 *
 * **What it talks to:**
 * - Uses `ManagedProcessRegistry` and `terminateProcessTree` through `LiveRunExecutorContext`.
 *
 * @param context - Shared executor dependencies for live-run capability handlers.
 * @param leaseId - Managed-process lease identifier to clean up on abort.
 * @param child - Live child handle associated with the lease.
 * @param signal - Optional abort signal propagated from the runtime.
 * @returns Nothing; registers cleanup side effects when a signal exists.
 */
function bindAbortCleanupForManagedProcess(
  context: LiveRunExecutorContext,
  leaseId: string,
  child: ChildProcessWithoutNullStreams,
  signal?: AbortSignal
): void {
  if (!signal) {
    return;
  }

  const handleAbort = (): void => {
    context.managedProcessRegistry.markStopRequested(leaseId);
    void context.terminateProcessTree(child);
  };

  if (signal.aborted) {
    handleAbort();
    return;
  }

  signal.addEventListener("abort", handleAbort, { once: true });
  child.once("close", () => {
    signal.removeEventListener("abort", handleAbort);
  });
}
