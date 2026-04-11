/**
 * @fileoverview Executes managed-process inspection for live-run flows.
 */

import { ExecutorExecutionOutcome, CheckProcessActionParams } from "../../core/types";
import {
  buildExecutionOutcome,
  buildManagedProcessExecutionMetadata,
  isReadyHttpStatus,
  LiveRunExecutorContext,
  normalizeOptionalString,
  performLocalHttpProbe,
  withRecoveryFailureMetadata
} from "./contracts";
import type { ManagedProcessSnapshot } from "./managedProcessRegistry";
import type { UntrackedHolderCandidate } from "./untrackedPreviewCandidateInspection";

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

/** Rebuilds a canonical loopback URL for a recovered preview holder. */
function buildLoopbackRequestedUrl(host: string, port: number): string {
  return `http://${host === "::1" ? "[::1]" : host}:${port}`;
}

/** Evaluates whether an inspected untracked holder still serves the exact tracked workspace. */
function candidateMatchesExactWorkspacePreview(
  snapshot: ManagedProcessSnapshot,
  candidate: UntrackedHolderCandidate
): boolean {
  if (candidate.holderKind !== "preview_server" || candidate.port === null) {
    return false;
  }
  if (candidate.reason === "served_index_matches_target_workspace") {
    return true;
  }
  const normalizedCwd = normalizeComparablePath(snapshot.cwd);
  if (!normalizedCwd) {
    return false;
  }
  const normalizedCommandLine = normalizeComparablePath(candidate.commandLine);
  if (normalizedCommandLine?.includes(normalizedCwd)) {
    return true;
  }
  return false;
}

/** Attempts to reclaim a same-workspace preview holder when the tracked wrapper pid went stale. */
async function tryRecoverExactWorkspacePreviewHolder(
  context: LiveRunExecutorContext,
  snapshot: ManagedProcessSnapshot
): Promise<ManagedProcessSnapshot | null> {
  if (!context.inspectSystemPreviewCandidates) {
    return null;
  }
  const candidates = await context.inspectSystemPreviewCandidates({
    targetPath: null,
    rootPath: snapshot.cwd,
    previewUrl: null,
    trackedPids: typeof snapshot.pid === "number" ? [snapshot.pid] : []
  });
  const recoveredCandidate = candidates.find((candidate) =>
    candidateMatchesExactWorkspacePreview(snapshot, candidate)
  );
  if (!recoveredCandidate || recoveredCandidate.port === null) {
    return null;
  }
  const recoveredHost = snapshot.requestedHost ?? "127.0.0.1";
  const recoveredUrl = buildLoopbackRequestedUrl(recoveredHost, recoveredCandidate.port);
  const recoveredReadyStatus = await performLocalHttpProbe(
    new URL(recoveredUrl),
    800,
    undefined
  );
  if (!isReadyHttpStatus(recoveredReadyStatus ?? 0, null)) {
    return null;
  }
  return context.managedProcessRegistry.markRecoveredRunning(snapshot.leaseId, {
    pid: recoveredCandidate.pid,
    requestedHost: recoveredHost,
    requestedPort: recoveredCandidate.port,
    requestedUrl: recoveredUrl
  });
}

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

  const persistedSnapshot = context.managedProcessRegistry.peekSnapshot(leaseId);
  if (!persistedSnapshot) {
    return buildExecutionOutcome(
      "blocked",
      `Process check blocked: unknown lease ${leaseId}.`,
      "PROCESS_LEASE_NOT_FOUND"
    );
  }

  const canAttemptRecoveredPreviewHold =
    !context.managedProcessRegistry.getChild(leaseId) &&
    (typeof persistedSnapshot.pid !== "number" || !context.isProcessRunning(persistedSnapshot.pid));
  if (canAttemptRecoveredPreviewHold) {
    const recoveredSnapshot = await tryRecoverExactWorkspacePreviewHolder(
      context,
      persistedSnapshot
    );
    if (recoveredSnapshot) {
      return buildExecutionOutcome(
        "success",
        `Process still running: recovered same-workspace preview holder for lease ${recoveredSnapshot.leaseId} (pid ${recoveredSnapshot.pid}, port ${recoveredSnapshot.requestedPort ?? "unknown"}).`,
        undefined,
        {
          ...buildManagedProcessExecutionMetadata(recoveredSnapshot, "PROCESS_STILL_RUNNING"),
          processRecoveredFromUntrackedPreview: true,
          processRecoveredReason: "same_workspace_preview_holder"
        }
      );
    }
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
      withRecoveryFailureMetadata(
        buildManagedProcessExecutionMetadata(snapshot, "PROCESS_STOPPED"),
        "TARGET_NOT_RUNNING",
        "runtime_live_run"
      )
    );
  }

  return buildExecutionOutcome(
    "success",
    `Process still running: lease ${snapshot.leaseId} (pid ${snapshot.pid ?? "unknown"}).`,
    undefined,
    buildManagedProcessExecutionMetadata(snapshot, "PROCESS_STILL_RUNNING")
  );
}
