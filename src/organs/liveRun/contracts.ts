/**
 * @fileoverview Defines shared live-run execution contracts, metadata builders, and probe utilities.
 */

import { ChildProcess, ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";

import { BrainConfig } from "../../core/config";
import { createAbortError, throwIfAborted } from "../../core/runtimeAbort";
import {
  ConstraintViolationCode,
  ExecutorExecutionOutcome,
  ExecutorExecutionStatus,
  ManagedProcessLifecycleCode,
  RuntimeTraceDetailValue,
  StartProcessActionParams
} from "../../core/types";
import type { BrowserVerifier } from "./browserVerifier";
import { ManagedProcessRegistry } from "./managedProcessRegistry";
import type { ManagedProcessSnapshot } from "./managedProcessRegistry";

export const MANAGED_PROCESS_START_TIMEOUT_MS = 1_000;
export const MANAGED_PROCESS_STOP_TIMEOUT_MS = 2_000;
export const MANAGED_PROCESS_PORT_PRECHECK_TIMEOUT_MS = 250;
export const READINESS_PROBE_TIMEOUT_MS_DEFAULT = 2_000;
export const BROWSER_VERIFY_TIMEOUT_MS_DEFAULT = 10_000;

export interface ManagedProcessLoopbackTargetHint {
  host: string;
  port: number;
  url: string;
}

export interface LiveRunExecutorContext {
  config: BrainConfig;
  shellSpawn: typeof spawn;
  managedProcessRegistry: ManagedProcessRegistry;
  browserVerifier: BrowserVerifier;
  resolveShellCommandCwd(params: StartProcessActionParams): string | null;
  terminateProcessTree(
    child: ChildProcess | ChildProcessWithoutNullStreams
  ): Promise<boolean>;
}

/**
 * Normalizes optional string input into a stable nullable string.
 *
 * **Why it exists:**
 * Live-run handlers all accept planner-provided optional strings. Keeping trimming and empty-string
 * rejection in one helper avoids subtle drift in missing-input policy across handlers.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param value - Planner-provided value to normalize.
 * @returns Trimmed string when present, otherwise `null`.
 */
export function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Builds a typed executor outcome with deterministic defaults.
 *
 * **Why it exists:**
 * Centralizes typed outcome construction so executor dispatch and extracted live-run handlers
 * return one stable contract.
 *
 * **What it talks to:**
 * - Uses `ExecutorExecutionOutcome` (import `ExecutorExecutionOutcome`) from `../../core/types`.
 *
 * @param status - Typed executor status.
 * @param output - Human-readable execution output for logs and user-facing summaries.
 * @param failureCode - Optional typed failure or block code for fail-closed runtime mapping.
 * @param executionMetadata - Optional execution metadata bag for trace or receipt propagation.
 * @returns Typed executor outcome.
 */
export function buildExecutionOutcome(
  status: ExecutorExecutionStatus,
  output: string,
  failureCode?: ConstraintViolationCode,
  executionMetadata?: Record<string, RuntimeTraceDetailValue>
): ExecutorExecutionOutcome {
  return {
    status,
    output,
    failureCode,
    executionMetadata
  };
}

/**
 * Builds managed-process metadata for trace, receipts, and user-facing evidence checks.
 *
 * **Why it exists:**
 * Keeps managed-process result metadata stable across start, check, and stop actions so downstream
 * code can reason about process lifecycle without parsing free-form output text.
 *
 * **What it talks to:**
 * - Uses `ManagedProcessSnapshot` from `./managedProcessRegistry`.
 *
 * @param snapshot - Managed-process snapshot to serialize.
 * @param lifecycleCode - Optional lifecycle code override for the current action result.
 * @returns Metadata bag safe for runtime trace persistence.
 */
export function buildManagedProcessExecutionMetadata(
  snapshot: ManagedProcessSnapshot,
  lifecycleCode: ManagedProcessLifecycleCode = snapshot.statusCode
): Record<string, RuntimeTraceDetailValue> {
  return {
    managedProcess: true,
    processLeaseId: snapshot.leaseId,
    processTaskId: snapshot.taskId,
    processPid: snapshot.pid,
    processLifecycleStatus: lifecycleCode,
    processCommandFingerprint: snapshot.commandFingerprint,
    processCwd: snapshot.cwd,
    processShellExecutable: snapshot.shellExecutable,
    processShellKind: snapshot.shellKind,
    processStartedAt: snapshot.startedAt,
    processExitCode: snapshot.exitCode,
    processSignal: snapshot.signal,
    processStopRequested: snapshot.stopRequested
  };
}

/**
 * Builds managed-process start-failure metadata for deterministic recovery routing.
 *
 * **Why it exists:**
 * Startup preflight failures can still be actionable for the autonomous loop, so this helper keeps
 * typed port-conflict details machine-readable instead of forcing later recovery logic to scrape
 * free-form output text.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param details - Structured start-failure details for this outcome.
 * @returns Metadata bag safe for runtime trace persistence.
 */
export function buildManagedProcessStartFailureExecutionMetadata(details: {
  commandFingerprint: string;
  cwd: string;
  shellExecutable: string;
  shellKind: string;
  failureKind: "PORT_IN_USE";
  requestedHost: string;
  requestedPort: number;
  requestedUrl: string;
  suggestedPort: number | null;
}): Record<string, RuntimeTraceDetailValue> {
  return {
    managedProcess: true,
    processLifecycleStatus: "PROCESS_START_FAILED",
    processCommandFingerprint: details.commandFingerprint,
    processCwd: details.cwd,
    processShellExecutable: details.shellExecutable,
    processShellKind: details.shellKind,
    processStartupFailureKind: details.failureKind,
    processRequestedHost: details.requestedHost,
    processRequestedPort: details.requestedPort,
    processRequestedUrl: details.requestedUrl,
    processSuggestedHost: details.suggestedPort !== null ? "localhost" : null,
    processSuggestedPort: details.suggestedPort,
    processSuggestedUrl:
      details.suggestedPort !== null ? `http://localhost:${details.suggestedPort}` : null
  };
}

/**
 * Builds readiness-probe metadata for trace, receipts, and completion evidence checks.
 *
 * **Why it exists:**
 * Keeps port or HTTP probe outputs machine-readable so autonomous completion and user-facing
 * status rendering can reason about ready or not-ready state without parsing free-form text.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param details - Structured readiness-probe details for this outcome.
 * @returns Metadata bag safe for runtime trace persistence.
 */
export function buildReadinessProbeExecutionMetadata(details: {
  probeKind: "port" | "http";
  ready: boolean;
  lifecycleCode: ManagedProcessLifecycleCode;
  host?: string;
  port?: number;
  url?: string;
  timeoutMs: number;
  expectedStatus?: number | null;
  observedStatus?: number | null;
}): Record<string, RuntimeTraceDetailValue> {
  return {
    readinessProbe: true,
    probeKind: details.probeKind,
    probeReady: details.ready,
    processLifecycleStatus: details.lifecycleCode,
    probeHost: details.host ?? null,
    probePort: details.port ?? null,
    probeUrl: details.url ?? null,
    probeTimeoutMs: details.timeoutMs,
    probeExpectedStatus: details.expectedStatus ?? null,
    probeObservedStatus: details.observedStatus ?? null
  };
}

/**
 * Builds browser-verification metadata for trace, receipts, and mission-evidence checks.
 *
 * **Why it exists:**
 * Keeps browser verification outputs machine-readable so user-facing summaries and autonomous
 * mission gates can reason about verified UI or browser proof without parsing free-form text.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param details - Structured browser verification details for this outcome.
 * @returns Metadata bag safe for runtime trace persistence.
 */
export function buildBrowserVerificationExecutionMetadata(details: {
  url: string;
  passed: boolean;
  observedTitle: string | null;
  observedTextSample: string | null;
  matchedTitle: boolean | null;
  matchedText: boolean | null;
  expectedTitle: string | null;
  expectedText: string | null;
  timeoutMs: number;
  lifecycleCode?: ManagedProcessLifecycleCode;
}): Record<string, RuntimeTraceDetailValue> {
  return {
    browserVerification: true,
    browserVerifyPassed: details.passed,
    browserVerifyUrl: details.url,
    browserVerifyObservedTitle: details.observedTitle,
    browserVerifyObservedTextSample: details.observedTextSample,
    browserVerifyMatchedTitle: details.matchedTitle,
    browserVerifyMatchedText: details.matchedText,
    browserVerifyExpectedTitle: details.expectedTitle,
    browserVerifyExpectedText: details.expectedText,
    browserVerifyTimeoutMs: details.timeoutMs,
    processLifecycleStatus: details.lifecycleCode ?? null
  };
}

/**
 * Evaluates whether one hostname belongs to the loopback-only browser verification allowlist.
 *
 * **Why it exists:**
 * Provides a second fail-closed local-only check in the executor for direct runtime callers that
 * do not go through hard constraints first.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param hostname - Hostname extracted from a browser verification URL.
 * @returns `true` when the hostname is a permitted loopback target.
 */
export function isLoopbackBrowserVerificationHost(hostname: string): boolean {
  const normalizedHostname = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalizedHostname === "localhost" ||
    normalizedHostname === "127.0.0.1" ||
    normalizedHostname === "::1"
  );
}

/**
 * Parses one probable loopback-local port from a managed-process command string.
 *
 * **Why it exists:**
 * `start_process` preflight can only detect deterministic local port conflicts when the runtime
 * can recover the intended loopback port from trusted command params, so this helper centralizes
 * the bounded parsing rules.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param command - Shell or process command text emitted by the planner.
 * @returns Loopback-local target hint, or `null` when no supported port pattern is present.
 */
export function inferManagedProcessLoopbackTarget(
  command: string
): ManagedProcessLoopbackTargetHint | null {
  const normalizedCommand = command.trim().toLowerCase();
  const patterns = [
    /\bhttp\.server\s+(\d{2,5})\b/,
    /\b--port\s+(\d{2,5})\b/,
    /\b-p\s+(\d{2,5})\b/,
    /\blocalhost:(\d{2,5})\b/,
    /\b127\.0\.0\.1:(\d{2,5})\b/
  ];
  for (const pattern of patterns) {
    const match = normalizedCommand.match(pattern);
    if (!match) {
      continue;
    }
    const port = Number.parseInt(match[1] ?? "", 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      continue;
    }
    return {
      host: "localhost",
      port,
      url: `http://localhost:${port}`
    };
  }
  return null;
}

/**
 * Resolves readiness-probe timeout from available runtime context.
 *
 * **Why it exists:**
 * Keeps probe-timeout selection deterministic so readiness checks stay bounded even when planner
 * payloads omit timeout metadata or provide out-of-bounds values.
 *
 * **What it talks to:**
 * - Uses `BrainConfig` from `../../core/config`.
 *
 * @param config - Runtime brain configuration.
 * @param timeoutMs - Optional timeout candidate from planner params.
 * @returns Computed numeric value.
 */
export function resolveReadinessProbeTimeoutMs(
  config: BrainConfig,
  timeoutMs: number | undefined
): number {
  if (timeoutMs === undefined || !Number.isInteger(timeoutMs)) {
    return READINESS_PROBE_TIMEOUT_MS_DEFAULT;
  }
  if (
    timeoutMs < config.shellRuntime.timeoutBoundsMs.min ||
    timeoutMs > config.shellRuntime.timeoutBoundsMs.max
  ) {
    return READINESS_PROBE_TIMEOUT_MS_DEFAULT;
  }
  return timeoutMs;
}

/**
 * Resolves browser-verification timeout from available runtime context.
 *
 * **Why it exists:**
 * Keeps browser-verification timeouts bounded and deterministic even when planner payloads omit
 * timeout metadata or direct executor callers provide invalid values.
 *
 * **What it talks to:**
 * - Uses `BrainConfig` from `../../core/config`.
 *
 * @param config - Runtime brain configuration.
 * @param timeoutMs - Optional timeout candidate from planner params.
 * @returns Computed numeric value.
 */
export function resolveBrowserVerificationTimeoutMs(
  config: BrainConfig,
  timeoutMs: number | undefined
): number {
  if (timeoutMs === undefined || !Number.isInteger(timeoutMs)) {
    return BROWSER_VERIFY_TIMEOUT_MS_DEFAULT;
  }
  if (
    timeoutMs < config.shellRuntime.timeoutBoundsMs.min ||
    timeoutMs > config.shellRuntime.timeoutBoundsMs.max
  ) {
    return BROWSER_VERIFY_TIMEOUT_MS_DEFAULT;
  }
  return timeoutMs;
}

/**
 * Evaluates whether one observed HTTP status satisfies ready-state expectations.
 *
 * **Why it exists:**
 * Keeps HTTP readiness semantics consistent so probe success does not depend on duplicated
 * caller-side status handling.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param observedStatus - HTTP status observed from the local probe request.
 * @param expectedStatus - Optional exact status required by the planner payload.
 * @returns `true` when the observed status proves readiness.
 */
export function isReadyHttpStatus(
  observedStatus: number,
  expectedStatus: number | null
): boolean {
  if (expectedStatus !== null) {
    return observedStatus === expectedStatus;
  }
  return observedStatus >= 200 && observedStatus < 300;
}

/**
 * Resolves URL port from a parsed local HTTP endpoint.
 *
 * **Why it exists:**
 * Keeps trace metadata and readiness summaries consistent when the URL omits an explicit port.
 *
 * **What it talks to:**
 * - Uses `URL` global available in Node runtime.
 *
 * @param parsedUrl - Parsed local endpoint URL.
 * @returns Deterministic numeric port value.
 */
export function resolveUrlPort(parsedUrl: URL): number {
  if (parsedUrl.port.trim().length > 0) {
    return Number(parsedUrl.port);
  }
  return parsedUrl.protocol === "https:" ? 443 : 80;
}

/**
 * Finds one currently free loopback TCP port for deterministic recovery hints.
 *
 * **Why it exists:**
 * When a managed-process start is blocked by a pre-existing local listener, the runtime can
 * recover much faster if it provides a concrete alternate loopback port instead of forcing the
 * model to guess one.
 *
 * **What it talks to:**
 * - Uses `net` from `node:net`.
 * - Uses `createAbortError` and `throwIfAborted` from `../../core/runtimeAbort`.
 *
 * @param signal - Optional abort signal propagated from caller or runtime surface.
 * @returns Promise resolving to a free loopback port, or `null` when discovery fails.
 */
export async function findAvailableLoopbackPort(
  signal?: AbortSignal
): Promise<number | null> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    let settled = false;

    const finalize = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      server.removeAllListeners();
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", handleAbort);
      }
      callback();
    };

    const handleAbort = (): void => {
      server.close(() => {
        finalize(() => reject(createAbortError()));
      });
    };

    if (signal) {
      signal.addEventListener("abort", handleAbort, { once: true });
    }

    server.once("error", () => {
      finalize(() => resolve(null));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port =
        address && typeof address !== "string" && Number.isInteger(address.port)
          ? address.port
          : null;
      server.close(() => {
        finalize(() => resolve(port));
      });
    });
  });
}

/**
 * Performs one local TCP connection attempt for readiness proof.
 *
 * **Why it exists:**
 * Encapsulates socket lifecycle and abort handling so readiness probes stay finite, cancellable,
 * and free of duplicated event-cleanup logic.
 *
 * **What it talks to:**
 * - Uses `net` from `node:net`.
 * - Uses `createAbortError` and `throwIfAborted` from `../../core/runtimeAbort`.
 *
 * @param host - Loopback host to probe.
 * @param port - Local TCP port to probe.
 * @param timeoutMs - Maximum wait before declaring not-ready.
 * @param signal - Optional abort signal propagated from caller or runtime surface.
 * @returns Promise resolving to `true` when the port accepts a connection.
 */
export async function performLocalPortProbe(
  host: string,
  port: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<boolean> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let settled = false;

    const finalize = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", handleAbort);
      }
      callback();
    };

    const handleAbort = (): void => {
      finalize(() => reject(createAbortError()));
    };

    if (signal) {
      signal.addEventListener("abort", handleAbort, { once: true });
    }

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      finalize(() => resolve(true));
    });
    socket.once("timeout", () => {
      finalize(() => resolve(false));
    });
    socket.once("error", () => {
      finalize(() => resolve(false));
    });
    socket.connect(port, host);
  });
}

/**
 * Performs one local HTTP request for readiness proof.
 *
 * **Why it exists:**
 * Encapsulates request lifecycle and abort handling so local endpoint verification stays finite
 * and deterministic across both HTTP and HTTPS loopback targets.
 *
 * **What it talks to:**
 * - Uses `http` from `node:http`.
 * - Uses `https` from `node:https`.
 * - Uses `createAbortError` and `throwIfAborted` from `../../core/runtimeAbort`.
 *
 * @param parsedUrl - Parsed loopback endpoint URL.
 * @param timeoutMs - Maximum wait before declaring not-ready.
 * @param signal - Optional abort signal propagated from caller or runtime surface.
 * @returns Promise resolving to observed HTTP status code, or `null` when no ready response arrived.
 */
export async function performLocalHttpProbe(
  parsedUrl: URL,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<number | null> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const requestModule = parsedUrl.protocol === "https:" ? https : http;
    const request = requestModule.request(
      parsedUrl,
      {
        method: "GET",
        timeout: timeoutMs
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          finalize(() => resolve(response.statusCode ?? null));
        });
      }
    );
    let settled = false;

    const finalize = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      request.removeAllListeners();
      request.destroy();
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", handleAbort);
      }
      callback();
    };

    const handleAbort = (): void => {
      finalize(() => reject(createAbortError()));
    };

    if (signal) {
      signal.addEventListener("abort", handleAbort, { once: true });
    }

    request.once("timeout", () => {
      finalize(() => resolve(null));
    });
    request.once("error", () => {
      finalize(() => resolve(null));
    });
    request.end();
  });
}

/**
 * Waits for a managed process to emit a successful spawn event.
 *
 * **Why it exists:**
 * `start_process` must not register a lease until the child has actually spawned. Centralizing the
 * startup wait keeps abort, timeout, and early-exit handling consistent across live-run callers.
 *
 * **What it talks to:**
 * - Uses `createAbortError` and `throwIfAborted` from `../../core/runtimeAbort`.
 *
 * @param child - Live child handle returned from spawn.
 * @param terminateProcessTree - Process-tree terminator used when startup is aborted.
 * @param signal - Optional abort signal propagated from caller or runtime surface.
 * @returns Promise resolving when the process successfully spawns.
 */
export async function waitForManagedProcessStart(
  child: ChildProcessWithoutNullStreams,
  terminateProcessTree: (
    child: ChildProcess | ChildProcessWithoutNullStreams
  ) => Promise<boolean>,
  signal?: AbortSignal
): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
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
      finalize(() =>
        reject(
          new Error(
            `Process did not emit a spawn event within ${MANAGED_PROCESS_START_TIMEOUT_MS}ms.`
          )
        )
      );
    }, MANAGED_PROCESS_START_TIMEOUT_MS);
    const handleAbort = (): void => {
      void terminateProcessTree(child);
      finalize(() => reject(createAbortError()));
    };

    if (signal) {
      signal.addEventListener("abort", handleAbort, { once: true });
    }

    child.once("spawn", () => {
      finalize(() => resolve());
    });
    child.once("error", (error) => {
      finalize(() => reject(error));
    });
    child.once("close", (code, closeSignal) => {
      finalize(() =>
        reject(
          new Error(
            `Process exited before startup completed (${code ?? "no-exit-code"}${closeSignal ? `, signal ${closeSignal}` : ""}).`
          )
        )
      );
    });
  });
}
