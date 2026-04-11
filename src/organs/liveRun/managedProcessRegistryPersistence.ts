/**
 * @fileoverview Persistence and snapshot helpers for managed-process registry state.
 */

import { existsSync, readFileSync } from "node:fs";

import type { ManagedProcessSnapshot } from "./managedProcessRegistry";

export interface ManagedProcessRegistryPersistedState {
  version: 1;
  snapshots: ManagedProcessSnapshot[];
}

/**
 * Clones one managed-process snapshot into an immutable caller-owned object.
 *
 * @param snapshot - Registry-owned snapshot value.
 * @returns Caller-owned snapshot copy.
 */
export function cloneManagedProcessSnapshot(
  snapshot: ManagedProcessSnapshot
): ManagedProcessSnapshot {
  return { ...snapshot };
}

/**
 * Reads persisted managed-process snapshots from disk.
 *
 * @param snapshotPath - Optional registry snapshot path.
 * @returns Parsed persisted state, or an empty default on missing or unreadable files.
 */
export function readManagedProcessPersistedState(
  snapshotPath: string | null
): ManagedProcessRegistryPersistedState {
  if (!snapshotPath || !existsSync(snapshotPath)) {
    return {
      version: 1,
      snapshots: []
    };
  }
  try {
    const parsed = JSON.parse(
      readFileSync(snapshotPath, "utf8")
    ) as Partial<ManagedProcessRegistryPersistedState>;
    return {
      version: 1,
      snapshots: Array.isArray(parsed.snapshots)
        ? parsed.snapshots
            .map((candidate) => normalizeManagedProcessSnapshot(candidate))
            .filter((candidate): candidate is ManagedProcessSnapshot => candidate !== null)
        : []
    };
  } catch (error) {
    console.warn(
      `[ManagedProcessRegistry] Failed to read persisted snapshots from "${snapshotPath}": ${(error as Error).message}`
    );
    return {
      version: 1,
      snapshots: []
    };
  }
}

/**
 * Normalizes one unknown persisted snapshot into the current registry contract.
 *
 * @param value - Persisted snapshot candidate.
 * @returns Valid snapshot, or `null` when the payload is not usable.
 */
function normalizeManagedProcessSnapshot(value: unknown): ManagedProcessSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<ManagedProcessSnapshot>;
  if (
    typeof candidate.leaseId !== "string" ||
    typeof candidate.actionId !== "string" ||
    typeof candidate.commandFingerprint !== "string" ||
    typeof candidate.cwd !== "string" ||
    typeof candidate.shellExecutable !== "string" ||
    typeof candidate.shellKind !== "string" ||
    typeof candidate.startedAt !== "string" ||
    typeof candidate.statusCode !== "string"
  ) {
    return null;
  }
  return {
    leaseId: candidate.leaseId,
    taskId: typeof candidate.taskId === "string" ? candidate.taskId : null,
    actionId: candidate.actionId,
    pid: typeof candidate.pid === "number" && Number.isInteger(candidate.pid) ? candidate.pid : null,
    commandFingerprint: candidate.commandFingerprint,
    cwd: candidate.cwd,
    shellExecutable: candidate.shellExecutable,
    shellKind: candidate.shellKind,
    startedAt: candidate.startedAt,
    statusCode:
      candidate.statusCode === "PROCESS_STARTED" ||
      candidate.statusCode === "PROCESS_STILL_RUNNING" ||
      candidate.statusCode === "PROCESS_READY" ||
      candidate.statusCode === "PROCESS_NOT_READY" ||
      candidate.statusCode === "PROCESS_STOPPED" ||
      candidate.statusCode === "PROCESS_START_FAILED"
        ? candidate.statusCode
        : "PROCESS_STARTED",
    requestedHost:
      typeof candidate.requestedHost === "string" ? candidate.requestedHost : null,
    requestedPort:
      typeof candidate.requestedPort === "number" && Number.isInteger(candidate.requestedPort)
        ? candidate.requestedPort
        : null,
    requestedUrl:
      typeof candidate.requestedUrl === "string" ? candidate.requestedUrl : null,
    exitCode:
      typeof candidate.exitCode === "number" && Number.isInteger(candidate.exitCode)
        ? candidate.exitCode
        : null,
    signal: typeof candidate.signal === "string" ? candidate.signal : null,
    stopRequested: candidate.stopRequested === true
  };
}
