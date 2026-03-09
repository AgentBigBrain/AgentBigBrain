/**
 * @fileoverview Owns managed-process lease tracking and bounded cleanup for autonomy.
 */

import { MAIN_AGENT_ID } from "../agentIdentity";
import { makeId } from "../ids";
import { BrainOrchestrator } from "../orchestrator";
import type { TaskRequest, TaskRunResult } from "../types";

export interface ApprovedManagedProcessCheckResult {
  leaseId: string;
  lifecycleStatus: string;
}

type ActionResultEntry = TaskRunResult["actionResults"][number];

/**
 * Reads the managed-process lease id recorded on one action result when available.
 *
 * **Why it exists:**
 * Lease tracking and cleanup should share one deterministic metadata read path instead of
 * duplicating unsafe casts.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param entry - Action result entry from task execution.
 * @returns Managed-process lease id, or `null` when unavailable.
 */
function readManagedProcessLeaseId(entry: ActionResultEntry): string | null {
  const leaseId = entry.executionMetadata?.processLeaseId;
  return typeof leaseId === "string" && leaseId.trim().length > 0 ? leaseId : null;
}

/**
 * Reads the managed-process lifecycle status recorded on one action result when available.
 *
 * **Why it exists:**
 * Lease tracking needs one stable lifecycle-status extraction path so start, check, and stop
 * actions stay aligned without repeating unsafe metadata casts.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param entry - Action result entry from task execution.
 * @returns Managed-process lifecycle status, or `null` when unavailable.
 */
function readManagedProcessLifecycleStatus(entry: ActionResultEntry): string | null {
  const lifecycleStatus = entry.executionMetadata?.processLifecycleStatus;
  return typeof lifecycleStatus === "string" && lifecycleStatus.trim().length > 0
    ? lifecycleStatus
    : null;
}

/**
 * Finds the managed-process lease started during the current iteration.
 *
 * **Why it exists:**
 * A successful `start_process` plus a failed readiness probe should deterministically hand off to
 * `check_process`, and that requires recovering the just-created lease id from typed metadata.
 *
 * **What it talks to:**
 * - Uses local lease readers within this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @returns Managed-process lease id, or `null` when no approved start action was recorded.
 */
export function findApprovedManagedProcessStartLeaseId(result: TaskRunResult): string | null {
  for (const entry of result.actionResults) {
    if (!entry.approved || entry.action.type !== "start_process") {
      continue;
    }
    const leaseId = readManagedProcessLeaseId(entry);
    if (leaseId) {
      return leaseId;
    }
  }
  return null;
}

/**
 * Finds the latest approved managed-process check result with lease metadata.
 *
 * **Why it exists:**
 * Readiness recovery after `check_process` depends on whether the managed process is still running
 * or already stopped, so the loop needs one deterministic extractor for that status.
 *
 * **What it talks to:**
 * - Uses local lease readers within this module.
 *
 * @param result - Task result from one autonomous-loop iteration.
 * @returns Managed-process check metadata, or `null` when unavailable.
 */
export function findApprovedManagedProcessCheckResult(
  result: TaskRunResult
): ApprovedManagedProcessCheckResult | null {
  for (const entry of result.actionResults) {
    if (!entry.approved || entry.action.type !== "check_process") {
      continue;
    }
    const leaseId = readManagedProcessLeaseId(entry);
    const lifecycleStatus = readManagedProcessLifecycleStatus(entry);
    if (leaseId && lifecycleStatus) {
      return {
        leaseId,
        lifecycleStatus
      };
    }
  }
  return null;
}

/**
 * Updates the tracked managed-process lease after one autonomous-loop iteration.
 *
 * **Why it exists:**
 * Later readiness failures may happen several iterations after the original `start_process`, so
 * the loop needs one deterministic place to remember which managed process should be rechecked.
 *
 * **What it talks to:**
 * - Uses local lease and lifecycle helpers within this module.
 *
 * @param previousLeaseId - Lease id tracked before this iteration, if any.
 * @param result - Task result from one autonomous-loop iteration.
 * @returns Lease id that should remain tracked for later recovery, or `null`.
 */
export function resolveTrackedManagedProcessLeaseId(
  previousLeaseId: string | null,
  result: TaskRunResult
): string | null {
  let trackedLeaseId = previousLeaseId;
  for (const entry of result.actionResults) {
    if (!entry.approved) {
      continue;
    }
    const leaseId = readManagedProcessLeaseId(entry);
    if (!leaseId) {
      continue;
    }
    const lifecycleStatus = readManagedProcessLifecycleStatus(entry);
    if (entry.action.type === "start_process" || entry.action.type === "check_process") {
      trackedLeaseId = leaseId;
    }
    if (entry.action.type === "stop_process" || lifecycleStatus === "PROCESS_STOPPED") {
      if (trackedLeaseId === leaseId) {
        trackedLeaseId = null;
      }
    }
  }
  return trackedLeaseId;
}

/**
 * Attempts one governed cleanup stop for a tracked managed-process lease.
 *
 * **Why it exists:**
 * Live-run failures can otherwise leave local dev servers behind after the loop aborts. This
 * helper keeps cleanup bounded and explicit without relying on the model to remember cleanup after
 * the loop has already decided to stop.
 *
 * **What it talks to:**
 * - Uses `BrainOrchestrator` (import `BrainOrchestrator`) from `../orchestrator`.
 * - Uses `TaskRequest` (import `TaskRequest`) from `../types`.
 * - Uses `makeId` (import `makeId`) from `../ids`.
 * - Uses `MAIN_AGENT_ID` (import `MAIN_AGENT_ID`) from `../agentIdentity`.
 *
 * @param orchestrator - Brain orchestrator used to run the bounded cleanup task.
 * @param overarchingGoal - Goal the loop was working on when cleanup became necessary.
 * @param leaseId - Managed-process lease id to stop.
 * @returns Cleanup task result when execution completed, or `null` when cleanup failed before a
 * result could be produced.
 */
export async function cleanupManagedProcessLease(
  orchestrator: BrainOrchestrator,
  overarchingGoal: string,
  leaseId: string
): Promise<TaskRunResult | null> {
  const cleanupTask: TaskRequest = {
    id: makeId("task"),
    agentId: MAIN_AGENT_ID,
    goal: overarchingGoal,
    userInput: `stop_process leaseId="${leaseId}". Stop this managed process now for cleanup and do not start a replacement.`,
    createdAt: new Date().toISOString()
  };
  try {
    console.log(`\n[Autonomous Loop Cleanup] Stopping managed process lease ${leaseId}.\n`);
    const cleanupResult = await orchestrator.runTask(cleanupTask);
    console.log(`[Autonomous Loop Cleanup] ${cleanupResult.summary}`);
    return cleanupResult;
  } catch (error) {
    console.error(
      `[Autonomous Loop Cleanup] Failed to stop managed process lease ${leaseId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return null;
  }
}
