/**
 * @fileoverview Executes local TCP readiness probes for live-run flows.
 */

import { ExecutorExecutionOutcome, ProbePortActionParams } from "../../core/types";
import { isAbortError, throwIfAborted } from "../../core/runtimeAbort";
import {
  buildExecutionOutcome,
  buildReadinessProbeExecutionMetadata,
  LiveRunExecutorContext,
  normalizeOptionalString,
  performLocalPortProbe,
  resolveReadinessProbeTimeoutMs
} from "./contracts";

/**
 * Executes `probe_port` for loopback readiness verification.
 *
 * **Why it exists:**
 * Keeps TCP readiness proof separate from the generic executor so live-run completion gates and
 * retry behavior have one owned probe implementation.
 *
 * **What it talks to:**
 * - Uses `performLocalPortProbe` and readiness metadata helpers from `./contracts`.
 *
 * @param context - Shared executor dependencies for live-run capability handlers.
 * @param params - Structured planner params for this probe request.
 * @param signal - Optional abort signal propagated from the runtime.
 * @returns Promise resolving to a typed executor outcome.
 */
export async function executeProbePort(
  context: LiveRunExecutorContext,
  params: ProbePortActionParams,
  signal?: AbortSignal
): Promise<ExecutorExecutionOutcome> {
  throwIfAborted(signal);
  const host = normalizeOptionalString(params.host) ?? "127.0.0.1";
  if (params.port === undefined) {
    return buildExecutionOutcome(
      "blocked",
      "Port probe blocked: missing params.port.",
      "PROBE_MISSING_PORT"
    );
  }
  if (!Number.isInteger(params.port) || params.port < 1 || params.port > 65_535) {
    return buildExecutionOutcome(
      "blocked",
      "Port probe blocked: params.port must be an integer within 1..65535.",
      "PROBE_PORT_INVALID"
    );
  }

  const timeoutMs = resolveReadinessProbeTimeoutMs(context.config, params.timeoutMs);

  try {
    const ready = await performLocalPortProbe(host, params.port, timeoutMs, signal);
    if (ready) {
      return buildExecutionOutcome(
        "success",
        `Port ready: ${host}:${params.port} accepted a TCP connection.`,
        undefined,
        buildReadinessProbeExecutionMetadata({
          probeKind: "port",
          ready: true,
          lifecycleCode: "PROCESS_READY",
          host,
          port: params.port,
          timeoutMs
        })
      );
    }
    return buildExecutionOutcome(
      "failed",
      `Port not ready: ${host}:${params.port} did not accept a TCP connection within ${timeoutMs}ms.`,
      "PROCESS_NOT_READY",
      buildReadinessProbeExecutionMetadata({
        probeKind: "port",
        ready: false,
        lifecycleCode: "PROCESS_NOT_READY",
        host,
        port: params.port,
        timeoutMs
      })
    );
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return buildExecutionOutcome(
      "failed",
      `Port probe failed: ${(error as Error).message}`,
      "ACTION_EXECUTION_FAILED"
    );
  }
}
