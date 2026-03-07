/**
 * @fileoverview Executes managed-process shutdown for live-run flows.
 */

import { ExecutorExecutionOutcome, StopProcessActionParams } from "../../core/types";
import {
  buildExecutionOutcome,
  buildManagedProcessExecutionMetadata,
  LiveRunExecutorContext,
  MANAGED_PROCESS_STOP_TIMEOUT_MS,
  normalizeOptionalString
} from "./contracts";

/**
 * Executes `stop_process` and waits for deterministic close confirmation.
 *
 * **Why it exists:**
 * Keeps managed-process stop semantics out of the generic executor so cleanup behavior stays
 * truthful and locally testable.
 *
 * **What it talks to:**
 * - Uses `ManagedProcessRegistry` and `terminateProcessTree` through `LiveRunExecutorContext`.
 *
 * @param context - Shared executor dependencies for live-run capability handlers.
 * @param params - Structured planner params for this stop request.
 * @returns Promise resolving to a typed executor outcome.
 */
export async function executeStopProcess(
  context: LiveRunExecutorContext,
  params: StopProcessActionParams
): Promise<ExecutorExecutionOutcome> {
  const leaseId = normalizeOptionalString(params.leaseId);
  if (!leaseId) {
    return buildExecutionOutcome(
      "blocked",
      "Process stop blocked: missing leaseId.",
      "PROCESS_MISSING_LEASE_ID"
    );
  }

  const snapshot = context.managedProcessRegistry.markStopRequested(leaseId);
  if (!snapshot) {
    return buildExecutionOutcome(
      "blocked",
      `Process stop blocked: unknown lease ${leaseId}.`,
      "PROCESS_LEASE_NOT_FOUND"
    );
  }
  if (snapshot.statusCode === "PROCESS_STOPPED") {
    return buildExecutionOutcome(
      "success",
      `Process already stopped: lease ${snapshot.leaseId}.`,
      undefined,
      buildManagedProcessExecutionMetadata(snapshot, "PROCESS_STOPPED")
    );
  }

  const child = context.managedProcessRegistry.getChild(leaseId);
  if (!child) {
    return buildExecutionOutcome(
      "failed",
      `Process stop failed: live child handle is unavailable for lease ${leaseId}.`,
      "PROCESS_STOP_FAILED"
    );
  }

  try {
    const killAccepted = await context.terminateProcessTree(child);
    if (!killAccepted) {
      return buildExecutionOutcome(
        "failed",
        `Process stop failed: kill signal was not accepted for lease ${leaseId}.`,
        "PROCESS_STOP_FAILED"
      );
    }
    const closedSnapshot = await context.managedProcessRegistry.waitForClosed(
      leaseId,
      MANAGED_PROCESS_STOP_TIMEOUT_MS
    );
    if (!closedSnapshot) {
      return buildExecutionOutcome(
        "failed",
        `Process stop failed: lease ${leaseId} did not exit within ${MANAGED_PROCESS_STOP_TIMEOUT_MS}ms.`,
        "PROCESS_STOP_FAILED"
      );
    }
    return buildExecutionOutcome(
      "success",
      `Process stopped: lease ${closedSnapshot.leaseId}.`,
      undefined,
      buildManagedProcessExecutionMetadata(closedSnapshot, "PROCESS_STOPPED")
    );
  } catch (error) {
    return buildExecutionOutcome(
      "failed",
      `Process stop failed: ${(error as Error).message}`,
      "PROCESS_STOP_FAILED"
    );
  }
}
