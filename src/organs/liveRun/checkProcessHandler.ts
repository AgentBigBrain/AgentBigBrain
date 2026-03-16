/**
 * @fileoverview Executes managed-process inspection for live-run flows.
 */

import { ExecutorExecutionOutcome, CheckProcessActionParams } from "../../core/types";
import {
  buildExecutionOutcome,
  buildManagedProcessExecutionMetadata,
  LiveRunExecutorContext,
  normalizeOptionalString
} from "./contracts";

/**
 * Executes `check_process` against the managed-process registry.
 *
 * **Why it exists:**
 * Keeps lease inspection behavior out of the generic executor so live-run lifecycle status stays
 * owned by one subsystem.
 *
 * **What it talks to:**
 * - Uses `ManagedProcessRegistry` through `LiveRunExecutorContext` from `./contracts`.
 *
 * @param context - Shared executor dependencies for live-run capability handlers.
 * @param params - Structured planner params for this check request.
 * @returns Promise resolving to a typed executor outcome.
 */
export async function executeCheckProcess(
  context: LiveRunExecutorContext,
  params: CheckProcessActionParams
): Promise<ExecutorExecutionOutcome> {
  const leaseId = normalizeOptionalString(params.leaseId);
  if (!leaseId) {
    return buildExecutionOutcome(
      "blocked",
      "Process check blocked: missing leaseId.",
      "PROCESS_MISSING_LEASE_ID"
    );
  }

  const persistedSnapshot = context.managedProcessRegistry.getSnapshot(leaseId);
  if (!persistedSnapshot) {
    return buildExecutionOutcome(
      "blocked",
      `Process check blocked: unknown lease ${leaseId}.`,
      "PROCESS_LEASE_NOT_FOUND"
    );
  }

  if (
    persistedSnapshot.statusCode !== "PROCESS_STOPPED" &&
    !context.managedProcessRegistry.getChild(leaseId) &&
    typeof persistedSnapshot.pid === "number" &&
    !context.isProcessRunning(persistedSnapshot.pid)
  ) {
    context.managedProcessRegistry.markRecoveredStopped(leaseId, null, null);
  }

  const snapshot = context.managedProcessRegistry.markObservedRunning(leaseId);
  if (!snapshot) {
    return buildExecutionOutcome(
      "blocked",
      `Process check blocked: unknown lease ${leaseId}.`,
      "PROCESS_LEASE_NOT_FOUND"
    );
  }

  if (snapshot.statusCode === "PROCESS_STOPPED") {
    const exitDetail =
      snapshot.exitCode !== null
        ? `exit code ${snapshot.exitCode}`
        : snapshot.signal
          ? `signal ${snapshot.signal}`
          : "unknown exit";
    return buildExecutionOutcome(
      "success",
      `Process stopped: lease ${snapshot.leaseId} (${exitDetail}).`,
      undefined,
      buildManagedProcessExecutionMetadata(snapshot, "PROCESS_STOPPED")
    );
  }

  return buildExecutionOutcome(
    "success",
    `Process still running: lease ${snapshot.leaseId} (pid ${snapshot.pid ?? "unknown"}).`,
    undefined,
    buildManagedProcessExecutionMetadata(snapshot, "PROCESS_STILL_RUNNING")
  );
}
