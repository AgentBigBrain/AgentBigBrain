/**
 * @fileoverview Executes local HTTP readiness probes for live-run flows.
 */

import { ExecutorExecutionOutcome, ProbeHttpActionParams } from "../../core/types";
import { isAbortError, throwIfAborted } from "../../core/runtimeAbort";
import {
  buildExecutionOutcome,
  buildReadinessProbeExecutionMetadata,
  isReadyHttpStatus,
  LiveRunExecutorContext,
  normalizeOptionalString,
  resolveReadinessProbeTimeoutMs,
  resolveUrlPort,
  waitForLocalHttpReadiness
} from "./contracts";

/**
 * Executes `probe_http` for loopback readiness verification.
 *
 * **Why it exists:**
 * Keeps HTTP readiness proof separate from the generic executor so live-run completion gates and
 * retry behavior have one owned endpoint verification implementation.
 *
 * **What it talks to:**
 * - Uses HTTP probe and readiness metadata helpers from `./contracts`.
 *
 * @param context - Shared executor dependencies for live-run capability handlers.
 * @param params - Structured planner params for this probe request.
 * @param signal - Optional abort signal propagated from the runtime.
 * @returns Promise resolving to a typed executor outcome.
 */
export async function executeProbeHttp(
  context: LiveRunExecutorContext,
  params: ProbeHttpActionParams,
  signal?: AbortSignal
): Promise<ExecutorExecutionOutcome> {
  throwIfAborted(signal);
  const urlValue = normalizeOptionalString(params.url);
  if (!urlValue) {
    return buildExecutionOutcome(
      "blocked",
      "HTTP probe blocked: missing params.url.",
      "PROBE_MISSING_URL"
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(urlValue);
  } catch {
    return buildExecutionOutcome(
      "blocked",
      "HTTP probe blocked: params.url must be a valid absolute URL.",
      "PROBE_URL_INVALID"
    );
  }

  const expectedStatus =
    typeof params.expectedStatus === "number" && Number.isInteger(params.expectedStatus)
      ? params.expectedStatus
      : null;
  const timeoutMs = resolveReadinessProbeTimeoutMs(context.config, params.timeoutMs);

  try {
    const { ready, attempts, observedStatus } = await waitForLocalHttpReadiness(
      parsedUrl,
      timeoutMs,
      expectedStatus,
      signal
    );
    const port = resolveUrlPort(parsedUrl);
    if (ready && observedStatus !== null && isReadyHttpStatus(observedStatus, expectedStatus)) {
      return buildExecutionOutcome(
        "success",
        expectedStatus === null
          ? `HTTP ready: ${urlValue} responded with ${observedStatus}.`
          : `HTTP ready: ${urlValue} responded with expected status ${expectedStatus}.`,
        undefined,
        buildReadinessProbeExecutionMetadata({
          probeKind: "http",
          ready: true,
          lifecycleCode: "PROCESS_READY",
          host: parsedUrl.hostname,
          port,
          url: urlValue,
          timeoutMs,
          attempts,
          expectedStatus,
          observedStatus
        })
      );
    }

    const failureDetail =
      observedStatus === null
        ? `no HTTP response within ${timeoutMs}ms`
        : expectedStatus === null
          ? `status ${observedStatus}`
          : `status ${observedStatus} (expected ${expectedStatus})`;
    return buildExecutionOutcome(
      "failed",
      `HTTP probe not ready: ${urlValue} returned ${failureDetail}.`,
      "PROCESS_NOT_READY",
      buildReadinessProbeExecutionMetadata({
        probeKind: "http",
        ready: false,
        lifecycleCode: "PROCESS_NOT_READY",
        host: parsedUrl.hostname,
        port,
        url: urlValue,
        timeoutMs,
        attempts,
        expectedStatus,
        observedStatus
      })
    );
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return buildExecutionOutcome(
      "failed",
      `HTTP probe failed: ${(error as Error).message}`,
      "ACTION_EXECUTION_FAILED"
    );
  }
}
