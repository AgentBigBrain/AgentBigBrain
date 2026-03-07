/**
 * @fileoverview Tracks managed long-running process leases and lifecycle snapshots for executor-owned process actions.
 */

import { ChildProcessWithoutNullStreams } from "node:child_process";

import { makeId } from "../../core/ids";
import {
  DEFAULT_RUNTIME_ENTROPY_SOURCE,
  RuntimeEntropySource
} from "../../core/runtimeEntropy";
import { ManagedProcessLifecycleCode } from "../../core/types";

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
  exitCode: number | null;
  signal: string | null;
  stopRequested: boolean;
}

interface ManagedProcessRuntimeRecord {
  child: ChildProcessWithoutNullStreams;
  snapshot: ManagedProcessSnapshot;
  closePromise: Promise<ManagedProcessSnapshot>;
  resolveClose: (snapshot: ManagedProcessSnapshot) => void;
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
    private readonly entropySource: RuntimeEntropySource = DEFAULT_RUNTIME_ENTROPY_SOURCE
  ) { }

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
    return cloneSnapshot(record.snapshot);
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
    record.resolveClose(cloneSnapshot(record.snapshot));
  }
}
