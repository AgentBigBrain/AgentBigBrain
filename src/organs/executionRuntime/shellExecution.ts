import { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";

import { hashSha256 } from "../../core/cryptoUtils";
import { createAbortError, isAbortError } from "../../core/runtimeAbort";
import {
  buildShellSpawnSpec,
  computeShellProfileFingerprint,
  computeShellSpawnSpecFingerprint,
} from "../../core/shellRuntimeProfile";
import type { ShellRuntimeProfileV1 } from "../../core/types";
import { ShellCommandActionParams } from "../../core/types";
import { buildExecutionOutcome, normalizeOptionalString } from "../liveRun/contracts";
import {
  CappedTextBuffer,
  ShellExecutionDependencies,
  ShellExecutionResult
} from "./contracts";
import { isPathWithinPrefix, resolveWorkspacePath } from "./pathRuntime";
import {
  appendChunkToBuffer,
  appendWindowsPowerShellPackageManagerFailureChecks,
  emptyCappedTextBuffer,
  hasKnownShellPartialFailure,
  normalizeWindowsPowerShellPackageManagerCommand,
  resolveCommandAwareShellEnvironment,
  resolveEffectiveShellProfile,
  resolveShellCommandTimeoutMs,
  resolveShellPostconditionFailure
} from "./shellExecutionSupport";

const PROCESS_TREE_TERMINATION_TIMEOUT_MS = 2_000;

/**
 * Resolves the effective cwd for a shell command and enforces sandbox policy.
 *
 * @param config - Active brain config with shell policy.
 * @param params - Shell action params.
 * @returns Absolute cwd or `null` when sandbox policy rejects it.
 */
export function resolveShellCommandCwd(
  config: ShellExecutionDependencies["config"],
  params: ShellCommandActionParams
): string | null {
  const requestedCwd =
    normalizeOptionalString(params.cwd) ?? normalizeOptionalString(params.workdir);
  const cwd = requestedCwd ? resolveWorkspacePath(requestedCwd) : process.cwd();
  if (
    config.shellRuntime.profile.cwdPolicy.denyOutsideSandbox &&
    !isPathWithinPrefix(cwd, config.dna.sandboxPathPrefix)
  ) {
    return null;
  }
  return cwd;
}

/**
 * Terminates a child process and, when possible, its full process tree.
 *
 * @param shellSpawn - Spawn helper used for platform-specific termination helpers.
 * @param child - Child process to terminate.
 * @returns `true` when termination succeeded or was already complete.
 */
export async function terminateProcessTree(
  shellSpawn: ShellExecutionDependencies["shellSpawn"],
  child: ChildProcess | ChildProcessWithoutNullStreams
): Promise<boolean> {
  if (child.killed) {
    return true;
  }
  const pid = child.pid;
  if (!pid) {
    try {
      return child.kill();
    } catch {
      return false;
    }
  }

  return terminateProcessTreeByPid(shellSpawn, pid, child);
}

/**
 * Terminates a process tree using a known PID when the original child handle is unavailable.
 *
 * @param shellSpawn - Spawn helper used for platform-specific termination helpers.
 * @param pid - Process id to terminate.
 * @param fallbackChild - Optional live child handle used as a final fallback.
 * @returns `true` when termination succeeded or the process was already complete.
 */
export async function terminateProcessTreeByPid(
  shellSpawn: ShellExecutionDependencies["shellSpawn"],
  pid: number,
  fallbackChild?: ChildProcess | ChildProcessWithoutNullStreams
): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  if (process.platform === "win32") {
    try {
      await new Promise<void>((resolve, reject) => {
        const killer = shellSpawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore"
        });
        const timeoutHandle = setTimeout(() => {
          killer.removeAllListeners();
          reject(
            new Error(
              `taskkill did not complete within ${PROCESS_TREE_TERMINATION_TIMEOUT_MS}ms.`
            )
          );
        }, PROCESS_TREE_TERMINATION_TIMEOUT_MS);
        killer.once("error", (error) => {
          clearTimeout(timeoutHandle);
          reject(error);
        });
        killer.once("close", (code) => {
          clearTimeout(timeoutHandle);
          if (code === 0 || code === 128 || code === 255) {
            resolve();
            return;
          }
          reject(new Error(`taskkill exited with code ${code ?? "unknown"}.`));
        });
      });
      return true;
    } catch {
      if (fallbackChild) {
        try {
          return fallbackChild.kill();
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  try {
    process.kill(-pid, "SIGTERM");
    return true;
  } catch {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      if (fallbackChild) {
        try {
          return fallbackChild.kill("SIGTERM");
        } catch {
          return false;
        }
      }
      return false;
    }
  }
}

/**
 * Checks whether a process id still appears alive from the current runtime.
 *
 * @param pid - Process id to inspect.
 * @returns `true` when the process appears alive or inaccessible but present.
 */
export function isProcessRunningByPid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Runs a shell process with bounded stdout/stderr capture, timeout enforcement, and abort handling.
 *
 * @param dependencies - Shell execution dependencies.
 * @param spawnSpec - Resolved shell spawn spec.
 * @param env - Effective shell environment.
 * @param shellKind - Resolved shell kind for spawn options.
 * @param signal - Optional abort signal.
 * @returns Process result including buffered output and timeout state.
 */
async function runShellProcess(
  dependencies: ShellExecutionDependencies,
  spawnSpec: ReturnType<typeof buildShellSpawnSpec>,
  env: NodeJS.ProcessEnv,
  shellKind: string,
  signal?: AbortSignal
): Promise<{
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: CappedTextBuffer;
  stderr: CappedTextBuffer;
}> {
  return new Promise((resolve, reject) => {
    const child = dependencies.shellSpawn(spawnSpec.executable, [...spawnSpec.args], {
      cwd: spawnSpec.cwd,
      detached: process.platform !== "win32",
      env,
      windowsHide: true,
      windowsVerbatimArguments: shellKind === "cmd",
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdoutBuffer = emptyCappedTextBuffer();
    let stderrBuffer = emptyCappedTextBuffer();
    let timedOut = false;
    let settled = false;

    const finalize = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", handleAbort);
      }
      callback();
    };

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      void terminateProcessTree(dependencies.shellSpawn, child);
    }, spawnSpec.timeoutMs);

    const handleAbort = (): void => {
      void terminateProcessTree(dependencies.shellSpawn, child);
      finalize(() => reject(createAbortError()));
    };
    if (signal) {
      if (signal.aborted) {
        handleAbort();
        return;
      }
      signal.addEventListener("abort", handleAbort, { once: true });
      if (signal.aborted) {
        handleAbort();
        return;
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer = appendChunkToBuffer(stdoutBuffer, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuffer = appendChunkToBuffer(stderrBuffer, chunk);
    });
    child.once("error", (error) => {
      finalize(() => reject(error));
    });
    child.once("close", (code, closeSignal) => {
      finalize(() =>
        resolve({
          exitCode: code,
          signal: closeSignal,
          timedOut,
          stdout: stdoutBuffer,
          stderr: stderrBuffer
        })
      );
    });
  });
}

/**
 * Executes a shell command action under the resolved runtime shell profile.
 *
 * @param actionId - Planned action id for trace linkage.
 * @param params - Shell action params.
 * @param signal - Optional abort signal.
 * @param dependencies - Shell execution dependencies.
 * @returns Execution result with outcome and telemetry.
 */
export async function executeShellCommandAction(
  actionId: string,
  params: ShellCommandActionParams,
  signal: AbortSignal | undefined,
  dependencies: ShellExecutionDependencies
): Promise<ShellExecutionResult> {
  const command = normalizeOptionalString(params.command);
  if (!command) {
    return {
      outcome: buildExecutionOutcome(
        "blocked",
        "Shell execution skipped: missing command.",
        "SHELL_MISSING_COMMAND"
      )
    };
  }

  const resolvedCwd = resolveShellCommandCwd(dependencies.config, params);
  if (!resolvedCwd) {
    return {
      outcome: buildExecutionOutcome(
        "blocked",
        "Shell execution blocked: requested cwd is outside sandbox policy.",
        "SHELL_CWD_OUTSIDE_SANDBOX"
      )
    };
  }

  const timeoutMs = resolveShellCommandTimeoutMs(dependencies.config, params);
  const windowsNormalizedCommand = normalizeWindowsPowerShellPackageManagerCommand(
    dependencies.config.shellRuntime.profile,
    command
  );
  const effectiveShellProfile = resolveEffectiveShellProfile(
    dependencies.config.shellRuntime.profile,
    windowsNormalizedCommand
  );
  const shellEnvironment = resolveCommandAwareShellEnvironment(
    effectiveShellProfile,
    windowsNormalizedCommand,
    process.env
  );
  const normalizedCommand = appendWindowsPowerShellPackageManagerFailureChecks(
    effectiveShellProfile,
    windowsNormalizedCommand
  );
  const spawnSpec = buildShellSpawnSpec({
    profile: effectiveShellProfile,
    command: normalizedCommand,
    cwd: resolvedCwd,
    timeoutMs,
    envKeyNames: shellEnvironment.envKeyNames
  });
  const shellProfileFingerprint = computeShellProfileFingerprint(effectiveShellProfile);
  const shellSpawnSpecFingerprint = computeShellSpawnSpecFingerprint(spawnSpec);

  try {
    const result = await runShellProcess(
      dependencies,
      spawnSpec,
      shellEnvironment.env,
      effectiveShellProfile.shellKind,
      signal
    );
    const telemetry = {
      shellProfileFingerprint,
      shellSpawnSpecFingerprint,
      shellKind: effectiveShellProfile.shellKind,
      shellExecutable: spawnSpec.executable,
      shellTimeoutMs: spawnSpec.timeoutMs,
      shellEnvMode: dependencies.config.shellRuntime.profile.envPolicy.mode,
      shellEnvKeyCount: shellEnvironment.envKeyNames.length,
      shellEnvRedactedKeyCount: shellEnvironment.redactedEnvKeyNames.length,
      shellExitCode: result.exitCode,
      shellSignal: result.signal,
      shellTimedOut: result.timedOut,
      shellStdoutDigest: hashSha256(result.stdout.text),
      shellStderrDigest: hashSha256(result.stderr.text),
      shellStdoutBytes: result.stdout.bytes,
      shellStderrBytes: result.stderr.bytes,
      shellStdoutTruncated: result.stdout.truncated,
      shellStderrTruncated: result.stderr.truncated
    };

    if (result.timedOut) {
      return {
        outcome: buildExecutionOutcome(
          "failed",
          `Shell failed: command timed out after ${spawnSpec.timeoutMs}ms.`,
          "ACTION_EXECUTION_FAILED"
        ),
        telemetry
      };
    }

    const combinedOutput = [result.stdout.text, result.stderr.text]
      .filter((value) => value.trim().length > 0)
      .join("\n")
      .trim();
    if (hasKnownShellPartialFailure(result.stderr.text)) {
      return {
        outcome: buildExecutionOutcome(
          "failed",
          `Shell failed:\n${combinedOutput}`,
          "ACTION_EXECUTION_FAILED"
        ),
        telemetry
      };
    }
    if ((result.exitCode ?? 0) !== 0) {
      if (combinedOutput.length > 0) {
        return {
          outcome: buildExecutionOutcome(
            "failed",
            `Shell failed (exit code ${result.exitCode ?? "unknown"}):\n${combinedOutput}`,
            "ACTION_EXECUTION_FAILED"
          ),
          telemetry
        };
      }
      return {
        outcome: buildExecutionOutcome(
          "failed",
          `Shell failed (exit code ${result.exitCode ?? "unknown"}).`,
          "ACTION_EXECUTION_FAILED"
        ),
        telemetry
      };
    }
    const postconditionFailure = await resolveShellPostconditionFailure(
      normalizedCommand,
      resolvedCwd
    );
    if (postconditionFailure) {
      return {
        outcome: buildExecutionOutcome(
          "failed",
          postconditionFailure.message,
          "ACTION_EXECUTION_FAILED"
        ),
        telemetry
      };
    }
    return {
      outcome: buildExecutionOutcome(
        "success",
        combinedOutput.length > 0
          ? `Shell success:\n${combinedOutput}`
          : "Shell success: command returned no output."
      ),
      telemetry
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return {
      outcome: buildExecutionOutcome(
        "failed",
        `Shell failed: ${(error as Error).message}`,
        "ACTION_EXECUTION_FAILED"
      )
    };
  }
}
