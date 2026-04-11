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
  isReadyHttpStatus,
  LiveRunExecutorContext,
  MANAGED_PROCESS_PORT_PRECHECK_TIMEOUT_MS,
  normalizeOptionalString,
  performLocalPortProbe,
  performLocalHttpProbe,
  withRecoveryFailureMetadata,
  waitForManagedProcessStart
} from "./contracts";
import { resolveManagedProcessLoopbackTarget } from "./managedProcessTargetResolution";
import type { UntrackedHolderCandidate } from "./untrackedPreviewCandidateInspection";

const MANAGED_PROCESS_WRAPPER_PROMOTION_GRACE_MS = 400;

/** Normalizes a filesystem-ish path for same-workspace preview-holder comparisons. */
function normalizeComparablePath(value: string | null): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const normalized = trimmed.replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** Rebuilds a canonical loopback URL for a recovered or promoted preview holder. */
function buildLoopbackRequestedUrl(host: string, port: number): string {
  return `http://${host === "::1" ? "[::1]" : host}:${port}`;
}

/** Evaluates whether an inspected untracked holder serves the requested workspace preview. */
function candidateMatchesRecoveredWorkspacePreview(
  resolvedCwd: string,
  candidate: UntrackedHolderCandidate,
  expectedPort: number | null = null
): boolean {
  if (candidate.holderKind !== "preview_server" || candidate.port === null) {
    return false;
  }
  if (expectedPort !== null && candidate.port !== expectedPort) {
    return false;
  }
  if (candidate.reason === "served_index_matches_target_workspace") {
    return true;
  }
  const normalizedCwd = normalizeComparablePath(resolvedCwd);
  if (!normalizedCwd) {
    return false;
  }
  const normalizedCommandLine = normalizeComparablePath(candidate.commandLine);
  return normalizedCommandLine?.includes(normalizedCwd) ?? false;
}

/** Detects framework dev commands that may hand off serving to a child preview process. */
function isLikelyFrameworkDevCommand(command: string): boolean {
  return (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|preview)\b/i.test(command) ||
    /\bnext\s+dev\b/i.test(command) ||
    /\bvite\b/i.test(command)
  );
}

/** Waits briefly for wrapper-based dev commands to promote their real preview child process. */
async function waitForWrapperPromotionGrace(signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, MANAGED_PROCESS_WRAPPER_PROMOTION_GRACE_MS);
  });
  throwIfAborted(signal);
}

/** Attempts to adopt an already-running same-workspace preview holder before spawning again. */
async function tryAdoptExistingWorkspacePreviewHolder(input: {
  context: LiveRunExecutorContext;
  actionId: string;
  commandFingerprint: string;
  cwd: string;
  shellExecutable: string;
  shellKind: string;
  loopbackTarget: { host: string; port: number; url: string };
  taskId?: string;
}): Promise<ExecutorExecutionOutcome | null> {
  if (!input.context.inspectSystemPreviewCandidates) {
    return null;
  }
  const candidates = await input.context.inspectSystemPreviewCandidates({
    targetPath: null,
    rootPath: input.cwd,
    previewUrl: input.loopbackTarget.url,
    trackedPids: []
  });
  const recoveredCandidate = candidates.find((candidate) =>
    candidateMatchesRecoveredWorkspacePreview(
      input.cwd,
      candidate,
      input.loopbackTarget.port
    )
  );
  const recoveredPort = recoveredCandidate?.port ?? null;
  if (!recoveredCandidate || recoveredPort === null) {
    return null;
  }
  const recoveredUrl = buildLoopbackRequestedUrl(input.loopbackTarget.host, recoveredPort);
  const recoveredReadyStatus = await performLocalHttpProbe(
    new URL(recoveredUrl),
    Math.max(MANAGED_PROCESS_PORT_PRECHECK_TIMEOUT_MS, 800),
    undefined
  );
  if (!isReadyHttpStatus(recoveredReadyStatus ?? 0, null)) {
    return null;
  }
  const adoptedSnapshot = input.context.managedProcessRegistry.registerRecoveredRunningLease({
    actionId: input.actionId,
    pid: recoveredCandidate.pid,
    commandFingerprint: input.commandFingerprint,
    cwd: input.cwd,
    shellExecutable: input.shellExecutable,
    shellKind: input.shellKind,
    requestedHost: input.loopbackTarget.host,
    requestedPort: recoveredPort,
    requestedUrl: recoveredUrl,
    taskId: input.taskId
  });
  return buildExecutionOutcome(
    "success",
    `Process already running: adopted same-workspace preview holder for lease ${adoptedSnapshot.leaseId} (pid ${adoptedSnapshot.pid}, port ${adoptedSnapshot.requestedPort ?? "unknown"}).`,
    undefined,
    {
      ...buildManagedProcessExecutionMetadata(adoptedSnapshot, "PROCESS_STILL_RUNNING"),
      processRecoveredFromUntrackedPreview: true,
      processRecoveredReason: "same_workspace_preview_holder"
    }
  );
}

/** Attempts to promote a started wrapper lease onto the real same-workspace preview holder. */
async function tryPromoteStartedWorkspacePreviewHolder(input: {
  context: LiveRunExecutorContext;
  leaseId: string;
  cwd: string;
  loopbackTarget: { host: string; port: number; url: string };
  command: string;
  signal?: AbortSignal;
}): Promise<ExecutorExecutionOutcome | null> {
  if (
    !input.context.inspectSystemPreviewCandidates ||
    !isLikelyFrameworkDevCommand(input.command)
  ) {
    return null;
  }

  await waitForWrapperPromotionGrace(input.signal);
  const currentSnapshot = input.context.managedProcessRegistry.peekSnapshot(input.leaseId);
  if (!currentSnapshot) {
    return null;
  }

  const candidates = await input.context.inspectSystemPreviewCandidates({
    targetPath: null,
    rootPath: input.cwd,
    previewUrl: input.loopbackTarget.url,
    trackedPids: typeof currentSnapshot.pid === "number" ? [currentSnapshot.pid] : []
  });
  const recoveredCandidate = candidates.find((candidate) =>
    candidateMatchesRecoveredWorkspacePreview(
      input.cwd,
      candidate,
      input.loopbackTarget.port
    )
  );
  if (!recoveredCandidate) {
    return null;
  }
  const promotedPort = recoveredCandidate.port;
  if (promotedPort === null) {
    return null;
  }
  if (typeof currentSnapshot.pid === "number" && recoveredCandidate.pid === currentSnapshot.pid) {
    return null;
  }

  const promotedSnapshot = input.context.managedProcessRegistry.markRecoveredRunning(
    input.leaseId,
    {
      pid: recoveredCandidate.pid,
      requestedHost: input.loopbackTarget.host,
      requestedPort: promotedPort,
      requestedUrl: buildLoopbackRequestedUrl(
        input.loopbackTarget.host,
        promotedPort
      )
    }
  );
  if (!promotedSnapshot) {
    return null;
  }

  return buildExecutionOutcome(
    "success",
    `Process started: promoted same-workspace preview holder for lease ${promotedSnapshot.leaseId} (pid ${promotedSnapshot.pid}, port ${promotedSnapshot.requestedPort ?? "unknown"}).`,
    undefined,
    {
      ...buildManagedProcessExecutionMetadata(
        promotedSnapshot,
        "PROCESS_STILL_RUNNING"
      ),
      processRecoveredFromUntrackedPreview: true,
      processRecoveredReason: "same_workspace_preview_holder"
    }
  );
}

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
  const loopbackTarget = await resolveManagedProcessLoopbackTarget(command, resolvedCwd);

  if (loopbackTarget) {
    const portAlreadyOccupied = await performLocalPortProbe(
      loopbackTarget.host,
      loopbackTarget.port,
      MANAGED_PROCESS_PORT_PRECHECK_TIMEOUT_MS,
      signal
    );
    if (portAlreadyOccupied) {
      const recoveredOutcome = await tryAdoptExistingWorkspacePreviewHolder({
        context,
        actionId,
        commandFingerprint,
        cwd: spawnSpec.cwd,
        shellExecutable: spawnSpec.executable,
        shellKind: effectiveShellProfile.shellKind,
        loopbackTarget,
        taskId
      });
      if (recoveredOutcome) {
        return recoveredOutcome;
      }
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
      requestedHost: loopbackTarget?.host ?? null,
      requestedPort: loopbackTarget?.port ?? null,
      requestedUrl: loopbackTarget?.url ?? null,
      taskId
    });
    bindAbortCleanupForManagedProcess(context, snapshot.leaseId, child, signal);
    const promotedOutcome =
      loopbackTarget
        ? await tryPromoteStartedWorkspacePreviewHolder({
            context,
            leaseId: snapshot.leaseId,
            cwd: spawnSpec.cwd,
            loopbackTarget,
            command,
            signal
          })
        : null;
    if (promotedOutcome) {
      return promotedOutcome;
    }
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
    const runtimeError = error as NodeJS.ErrnoException;
    const recoveryMetadata =
      runtimeError.code === "ENOENT"
        ? withRecoveryFailureMetadata(
          {
            managedProcess: true,
            processLifecycleStatus: "PROCESS_START_FAILED",
            processCommandFingerprint: commandFingerprint,
            processCwd: spawnSpec.cwd,
            processShellExecutable: spawnSpec.executable,
            processShellKind: effectiveShellProfile.shellKind,
            processRequestedHost: loopbackTarget?.host ?? null,
            processRequestedPort: loopbackTarget?.port ?? null,
            processRequestedUrl: loopbackTarget?.url ?? null
          },
          "EXECUTABLE_NOT_FOUND",
          "executor_mechanical"
        )
        : runtimeError.code === "ENAMETOOLONG"
          ? withRecoveryFailureMetadata(
            {
              managedProcess: true,
              processLifecycleStatus: "PROCESS_START_FAILED",
              processCommandFingerprint: commandFingerprint,
              processCwd: spawnSpec.cwd,
              processShellExecutable: spawnSpec.executable,
              processShellKind: effectiveShellProfile.shellKind,
              processRequestedHost: loopbackTarget?.host ?? null,
              processRequestedPort: loopbackTarget?.port ?? null,
              processRequestedUrl: loopbackTarget?.url ?? null
            },
            "COMMAND_TOO_LONG",
            "executor_mechanical"
          )
          : undefined;
    return buildExecutionOutcome(
      "failed",
      `Process start failed: ${runtimeError.message}`,
      "PROCESS_START_FAILED",
      recoveryMetadata
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
