/**
 * @fileoverview Collects live browser/process runtime snapshots for worker persistence.
 */

import type {
  ListBrowserSessionSnapshots,
  ListManagedProcessSnapshots
} from "./managerContracts";

export interface WorkerRuntimeSnapshotCollection {
  managedProcessSnapshots: Awaited<ReturnType<ListManagedProcessSnapshots>> | undefined;
  browserSessionSnapshots: Awaited<ReturnType<ListBrowserSessionSnapshots>> | undefined;
}

/**
 * Collects the latest live runtime snapshots used to reconcile worker-owned session state before
 * the completed outcome is persisted.
 *
 * **Why it exists:**
 * Worker persistence should reuse the same runtime ownership truth as the conversation front door,
 * but snapshot collection must never turn a completed job into a failure when introspection is
 * temporarily unavailable.
 *
 * **What it talks to:**
 * - Calls optional managed-process and browser-session snapshot readers from the interface runtime.
 *
 * @param input - Optional runtime-owned snapshot readers.
 * @returns Best-effort snapshot collection for worker persistence reconciliation.
 */
export async function collectWorkerRuntimeSnapshots(input: {
  listManagedProcessSnapshots?: ListManagedProcessSnapshots;
  listBrowserSessionSnapshots?: ListBrowserSessionSnapshots;
}): Promise<WorkerRuntimeSnapshotCollection> {
  const {
    listManagedProcessSnapshots,
    listBrowserSessionSnapshots
  } = input;
  const [managedProcessSnapshots, browserSessionSnapshots] = await Promise.all([
    listManagedProcessSnapshots?.().catch(() => undefined),
    listBrowserSessionSnapshots?.().catch(() => undefined)
  ]);
  return {
    managedProcessSnapshots,
    browserSessionSnapshots
  };
}
