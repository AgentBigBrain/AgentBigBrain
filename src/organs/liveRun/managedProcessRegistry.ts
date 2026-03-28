/**
 * @fileoverview Tracks managed long-running process leases and lifecycle snapshots for executor-owned process actions.
 */

import { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { makeId } from "../../core/ids";
import {
  DEFAULT_RUNTIME_ENTROPY_SOURCE,
  RuntimeEntropySource
} from "../../core/runtimeEntropy";
import { ManagedProcessLifecycleCode } from "../../core/types";
import { isProcessLikelyAlive } from "./processLiveness";

export interface ManagedProcessSnapshot {
  leaseId: string;
  taskId: string | null;
  actionId: string;
  pid: number | null;
  commandFingerprint: string;
  cwd: string;
  shellExecutable: string;
  shellKind: string;
  startedAt: string;
  statusCode: ManagedProcessLifecycleCode;
  requestedHost: string | null;
  requestedPort: number | null;
  requestedUrl: string | null;
  exitCode: number | null;
  signal: string | null;
  stopRequested: boolean;
}

interface ManagedProcessRuntimeRecord {
  child: ChildProcessWithoutNullStreams | null;
  snapshot: ManagedProcessSnapshot;
  closePromise: Promise<ManagedProcessSnapshot>;
  resolveClose: (snapshot: ManagedProcessSnapshot) => void;
}

interface ManagedProcessRegistryPersistedState {
  version: 1;
  snapshots: ManagedProcessSnapshot[];
}

export interface ManagedProcessRegistryOptions {
  entropySource?: RuntimeEntropySource;
  snapshotPath?: string | null;
  isProcessAlive?: (pid: number | null) => boolean;
}

/**
 * Returns whether one managed-process snapshot is still a current exact tracked runtime resource.
 *
 * @param snapshot - Managed-process snapshot to classify.
 * @returns `true` when the lease is still active.
 */
export function isCurrentTrackedManagedProcessSnapshot(
  snapshot: ManagedProcessSnapshot
): boolean {
  return snapshot.statusCode !== "PROCESS_STOPPED";
}

/**
 * Returns whether one managed-process snapshot represents stale earlier assistant work.
 *
 * @param snapshot - Managed-process snapshot to classify.
 * @returns `true` when the lease is already stopped.
 */
export function isStaleTrackedManagedProcessSnapshot(
  snapshot: ManagedProcessSnapshot
): boolean {
  return snapshot.statusCode === "PROCESS_STOPPED";
}

/**
 * Clones a process snapshot into an immutable caller-owned object.
 *
 * **Why it exists:**
 * Prevents callers from mutating registry-owned process state directly after reads or updates.
 *
 * **What it talks to:**
 * - Uses local helpers within this module.
 *
 * @param snapshot - Registry-owned snapshot value.
 * @returns Caller-owned snapshot copy.
 */
function cloneSnapshot(snapshot: ManagedProcessSnapshot): ManagedProcessSnapshot {
  return { ...snapshot };
}

/**
 * Stores executor-owned long-running process runtime records.
 */
export class ManagedProcessRegistry {
  private readonly records = new Map<string, ManagedProcessRuntimeRecord>();
  private readonly snapshotPath: string | null;
  private readonly entropySource: RuntimeEntropySource;
  private readonly isProcessAlive: (pid: number | null) => boolean;

  /**
   * Initializes `ManagedProcessRegistry` with injectable runtime entropy.
   *
   * **Why it exists:**
   * Keeps lease-id generation and started-at timestamps deterministic under test injection while
   * centralizing managed-process state in one runtime-owned registry.
   *
   * **What it talks to:**
   * - Uses `RuntimeEntropySource` from `../../core/runtimeEntropy`.
   * - Uses `DEFAULT_RUNTIME_ENTROPY_SOURCE` from `../../core/runtimeEntropy`.
   *
   * @param entropySource - Optional injected entropy or time boundary.
   */
  constructor(
    entropySourceOrOptions:
      | RuntimeEntropySource
      | ManagedProcessRegistryOptions = DEFAULT_RUNTIME_ENTROPY_SOURCE
  ) {
    const options = isManagedProcessRegistryOptions(entropySourceOrOptions)
      ? entropySourceOrOptions
      : {
          entropySource: entropySourceOrOptions
        };
    this.entropySource = options.entropySource ?? DEFAULT_RUNTIME_ENTROPY_SOURCE;
    this.snapshotPath = options.snapshotPath ?? null;
    this.isProcessAlive = options.isProcessAlive ?? isProcessLikelyAlive;
    this.hydratePersistedSnapshots();
  }

  /**
   * Registers a newly started managed process and attaches close-state tracking.
   *
   * **Why it exists:**
   * Centralizes lease allocation and lifecycle wiring so executor start, check, and stop actions
   * share one deterministic runtime view of long-running child processes.
   *
   * **What it talks to:**
   * - Uses `makeId` from `../../core/ids`.
   * - Uses local helpers within this module.
   *
   * @param input - Process metadata and child handle to store.
   * @returns Snapshot recorded for this managed-process lease.
   */
  registerStarted(input: {
    actionId: string;
    child: ChildProcessWithoutNullStreams;
    commandFingerprint: string;
    cwd: string;
    shellExecutable: string;
    shellKind: string;
    requestedHost?: string | null;
    requestedPort?: number | null;
    requestedUrl?: string | null;
    taskId?: string;
  }): ManagedProcessSnapshot {
    const leaseId = makeId("proc", this.entropySource);
    const startedAtMs = this.entropySource.nowMs();
    const snapshot: ManagedProcessSnapshot = {
      leaseId,
      taskId: input.taskId ?? null,
      actionId: input.actionId,
      pid: input.child.pid ?? null,
      commandFingerprint: input.commandFingerprint,
      cwd: input.cwd,
      shellExecutable: input.shellExecutable,
      shellKind: input.shellKind,
      startedAt: new Date(startedAtMs).toISOString(),
      statusCode: "PROCESS_STARTED",
      requestedHost: input.requestedHost ?? null,
      requestedPort: input.requestedPort ?? null,
      requestedUrl: input.requestedUrl ?? null,
      exitCode: null,
      signal: null,
      stopRequested: false
    };
    let resolveClose: ((result: ManagedProcessSnapshot) => void) | null = null;
    const closePromise = new Promise<ManagedProcessSnapshot>((resolve) => {
      resolveClose = resolve;
    });
    const record: ManagedProcessRuntimeRecord = {
      child: input.child,
      snapshot,
      closePromise,
      resolveClose: (result: ManagedProcessSnapshot) => {
        resolveClose?.(result);
      }
    };
    this.records.set(leaseId, record);
    this.persistSnapshots();
    input.child.once("close", (code, signal) => {
      this.markClosed(leaseId, code, signal);
    });
    return cloneSnapshot(snapshot);
  }

  /**
   * Marks a process as observed running when it has not exited yet.
   *
   * **Why it exists:**
   * Lets `check_process` upgrade initial start state to a stable running state without mutating
   * callers directly.
   *
   * **What it talks to:**
   * - Uses local helpers within this module.
   *
   * @param leaseId - Managed-process lease identifier.
   * @returns Updated snapshot, or `null` when the lease is unknown.
   */
  markObservedRunning(leaseId: string): ManagedProcessSnapshot | null {
    const record = this.records.get(leaseId);
    if (!record) {
      return null;
    }
    if (record.snapshot.statusCode === "PROCESS_STARTED") {
      record.snapshot = {
        ...record.snapshot,
        statusCode: "PROCESS_STILL_RUNNING"
      };
      this.persistSnapshots();
    }
    return cloneSnapshot(record.snapshot);
  }

  /**
   * Marks a process lease as stop-requested before the executor sends a signal.
   *
   * **Why it exists:**
   * Preserves a deterministic trace of operator or runtime stop intent even if the child exits
   * between request and kill handling.
   *
   * **What it talks to:**
   * - Uses local helpers within this module.
   *
   * @param leaseId - Managed-process lease identifier.
   * @returns Updated snapshot, or `null` when the lease is unknown.
   */
  markStopRequested(leaseId: string): ManagedProcessSnapshot | null {
    const record = this.records.get(leaseId);
    if (!record) {
      return null;
    }
    record.snapshot = {
      ...record.snapshot,
      stopRequested: true
    };
    this.persistSnapshots();
    return cloneSnapshot(record.snapshot);
  }

  /**
   * Reads the current managed-process snapshot for one lease.
   *
   * **Why it exists:**
   * Provides a safe read API for executor and tests without exposing mutable registry internals.
   *
   * **What it talks to:**
   * - Uses local helpers within this module.
   *
   * @param leaseId - Managed-process lease identifier.
   * @returns Snapshot copy, or `null` when the lease is unknown.
   */
  getSnapshot(leaseId: string): ManagedProcessSnapshot | null {
    const record = this.records.get(leaseId);
    if (!record) {
      return null;
    }
    if (this.reconcileManagedProcessRecord(record)) {
      this.persistSnapshots();
    }
    return cloneSnapshot(record.snapshot);
  }

  /**
   * Lists all tracked managed-process snapshots in caller-owned form.
   *
   * **Why it exists:**
   * Interface follow-up routing and recovery flows sometimes need a full view of runtime-owned
   * leases so they can stop only the previews that are still holding user-owned workspaces open.
   *
   * **What it talks to:**
   * - Uses local helpers within this module.
   *
   * @returns Snapshot copies for every tracked managed-process lease.
   */
  listSnapshots(): ManagedProcessSnapshot[] {
    this.reconcilePersistedSnapshots();
    return [...this.records.values()].map((record) => cloneSnapshot(record.snapshot));
  }

  /**
   * Reads the live child handle for a managed-process lease.
   *
   * **Why it exists:**
   * Keeps child-process access centralized so stop logic does not reach into registry internals.
   *
   * **What it talks to:**
   * - Uses local helpers within this module.
   *
   * @param leaseId - Managed-process lease identifier.
   * @returns Child handle, or `null` when the lease is unknown.
   */
  getChild(leaseId: string): ChildProcessWithoutNullStreams | null {
    const record = this.records.get(leaseId);
    return record?.child ?? null;
  }

  /**
   * Marks a lease as stopped when the runtime has to recover closure without a live child handle.
   *
   * **Why it exists:**
   * Runtime restarts can lose the original child-process object while the persisted lease still
   * carries a PID. This lets stop/check flows update the canonical snapshot once the PID-based
   * recovery path proves the process exited.
   *
   * **What it talks to:**
   * - Uses local helpers within this module.
   *
   * @param leaseId - Managed-process lease identifier.
   * @param exitCode - Best-known exit code, or `null` when unknown.
   * @param signal - Best-known termination signal, or `null` when unknown.
   * @returns Updated snapshot, or `null` when the lease is unknown.
   */
  markRecoveredStopped(
    leaseId: string,
    exitCode: number | null,
    signal: NodeJS.Signals | string | null
  ): ManagedProcessSnapshot | null {
    const record = this.records.get(leaseId);
    if (!record) {
      return null;
    }
    if (record.snapshot.statusCode === "PROCESS_STOPPED") {
      return cloneSnapshot(record.snapshot);
    }
    record.child = null;
    record.snapshot = {
      ...record.snapshot,
      statusCode: "PROCESS_STOPPED",
      exitCode,
      signal: signal ?? null
    };
    record.resolveClose(cloneSnapshot(record.snapshot));
    this.persistSnapshots();
    return cloneSnapshot(record.snapshot);
  }

  /**
   * Waits for a managed process to reach a closed state or times out deterministically.
   *
   * **Why it exists:**
   * Allows `stop_process` to provide truthful cleanup status without polling loops or exposing raw
   * child-process events to higher layers.
   *
   * **What it talks to:**
   * - Uses local helpers within this module.
   *
   * @param leaseId - Managed-process lease identifier.
   * @param timeoutMs - Maximum wait duration in milliseconds.
   * @returns Promise resolving to the closed snapshot, or `null` on timeout or unknown lease.
   */
  async waitForClosed(
    leaseId: string,
    timeoutMs: number
  ): Promise<ManagedProcessSnapshot | null> {
    const record = this.records.get(leaseId);
    if (!record) {
      return null;
    }
    if (record.snapshot.statusCode === "PROCESS_STOPPED") {
      return cloneSnapshot(record.snapshot);
    }

    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), timeoutMs);
    });
    const closed = await Promise.race([record.closePromise, timeoutPromise]);
    return closed ? cloneSnapshot(closed) : null;
  }

  /**
   * Marks a lease as closed from child-process lifecycle events.
   *
   * **Why it exists:**
   * Centralizes final status mutation so close events always produce one deterministic stopped
   * snapshot regardless of whether the process exited naturally or from a stop request.
   *
   * **What it talks to:**
   * - Uses local helpers within this module.
   *
   * @param leaseId - Managed-process lease identifier.
   * @param exitCode - Child-process exit code from the close event.
   * @param signal - Child-process termination signal from the close event.
   */
  private markClosed(
    leaseId: string,
    exitCode: number | null,
    signal: NodeJS.Signals | string | null
  ): void {
    const record = this.records.get(leaseId);
    if (!record || record.snapshot.statusCode === "PROCESS_STOPPED") {
      return;
    }
    record.snapshot = {
      ...record.snapshot,
      statusCode: "PROCESS_STOPPED",
      exitCode,
      signal: signal ?? null
    };
    record.child = null;
    record.resolveClose(cloneSnapshot(record.snapshot));
    this.persistSnapshots();
  }

  /**
   * Loads persisted managed-process snapshots when the runtime starts.
   *
   * **Why it exists:**
   * Follow-up conversation turns can arrive after interface restarts. Rehydrating lease snapshots
   * preserves enough continuity to stop or inspect the preview process by PID instead of losing
   * all control.
   *
   * **What it talks to:**
   * - Uses `node:fs` for local JSON persistence.
   * - Uses `node:path` for directory creation.
   */
  private hydratePersistedSnapshots(): void {
    const persistedState = readManagedProcessPersistedState(this.snapshotPath);
    for (const snapshot of persistedState.snapshots) {
      let resolveClose: ((result: ManagedProcessSnapshot) => void) | null = null;
      const closePromise = new Promise<ManagedProcessSnapshot>((resolve) => {
        resolveClose = resolve;
      });
      this.records.set(snapshot.leaseId, {
        child: null,
        snapshot,
        closePromise,
        resolveClose: (result: ManagedProcessSnapshot) => {
          resolveClose?.(result);
        }
      });
    }
    this.reconcilePersistedSnapshots();
  }

  /**
   * Reconciles persisted managed-process records against current local PID liveness.
   */
  private reconcilePersistedSnapshots(): void {
    let changed = false;
    for (const record of this.records.values()) {
      changed = this.reconcileManagedProcessRecord(record) || changed;
    }
    if (changed) {
      this.persistSnapshots();
    }
  }

  /**
   * Reconciles one persisted managed-process record against current local PID liveness.
   *
   * @param record - Internal managed-process runtime record.
   * @returns `true` when reconciliation changed persisted state.
   */
  private reconcileManagedProcessRecord(record: ManagedProcessRuntimeRecord): boolean {
    if (record.snapshot.statusCode === "PROCESS_STOPPED" || record.child !== null) {
      return false;
    }
    if (this.isProcessAlive(record.snapshot.pid)) {
      return false;
    }
    record.snapshot = {
      ...record.snapshot,
      statusCode: "PROCESS_STOPPED"
    };
    record.resolveClose(cloneSnapshot(record.snapshot));
    return true;
  }

  /**
   * Persists current managed-process snapshots for later runtime recovery.
   *
   * **Why it exists:**
   * The conversation layer remembers lease ids across turns. Persisting the registry keeps those
   * ids meaningful even when the interface process restarts.
   *
   * **What it talks to:**
   * - Uses `node:fs` for local JSON persistence.
   * - Uses `node:path` for directory creation.
   */
  private persistSnapshots(): void {
    if (!this.snapshotPath) {
      return;
    }
    const payload: ManagedProcessRegistryPersistedState = {
      version: 1,
      snapshots: [...this.records.values()].map((record) => cloneSnapshot(record.snapshot))
    };
    mkdirSync(path.dirname(this.snapshotPath), { recursive: true });
    writeFileSync(this.snapshotPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  }
}

/**
 * Evaluates whether one constructor input uses the options-object form.
 *
 * @param value - Constructor input candidate.
 * @returns `true` when the value is a registry-options object.
 */
function isManagedProcessRegistryOptions(
  value: RuntimeEntropySource | ManagedProcessRegistryOptions
): value is ManagedProcessRegistryOptions {
  return typeof (value as RuntimeEntropySource).nowMs !== "function";
}

/**
 * Reads persisted managed-process snapshots from disk.
 *
 * @param snapshotPath - Optional registry snapshot path.
 * @returns Parsed persisted state, or an empty default on missing/unreadable files.
 */
function readManagedProcessPersistedState(
  snapshotPath: string | null
): ManagedProcessRegistryPersistedState {
  if (!snapshotPath || !existsSync(snapshotPath)) {
    return {
      version: 1,
      snapshots: []
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(snapshotPath, "utf8")) as Partial<ManagedProcessRegistryPersistedState>;
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
