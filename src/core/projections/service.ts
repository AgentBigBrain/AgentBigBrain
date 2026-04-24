/**
 * @fileoverview Coordinates projection snapshots, sink fanout, and durable mirror sync state for external memory inspection targets.
 */

import { makeId } from "../ids";
import type {
  ProjectionChangeKind,
  ProjectionChangeSet,
  ProjectionServiceSnapshotProvider,
  ProjectionSink,
  ProjectionStateSnapshot,
  ProjectionSinkSyncState
} from "./contracts";
import type { ProjectionRuntimeConfig } from "./config";
import { ProjectionStateStore } from "./projectionStateStore";

interface ProjectionServiceOptions {
  stateStore: ProjectionStateStore;
  snapshotProvider: ProjectionServiceSnapshotProvider;
  sinks: readonly ProjectionSink[];
  onError?: (error: unknown) => void;
}

/**
 * Builds a normalized projection change-set from simple caller inputs.
 *
 * **Why it exists:**
 * Most runtime callers only know which domain changed and why; this helper keeps the shape of
 * projection notifications stable so stores do not each invent their own ad hoc event payloads.
 *
 * **What it talks to:**
 * - Uses `makeId` (import `makeId`) from `../ids`.
 *
 * @param kinds - Canonical change kinds affected by the mutation.
 * @param reasons - Human-readable reasons describing the change.
 * @param metadata - Optional machine-readable metadata.
 * @returns Canonical projection change-set.
 */
export function buildProjectionChangeSet(
  kinds: readonly ProjectionChangeKind[],
  reasons: readonly string[],
  metadata?: Record<string, string | number | boolean | null>
): ProjectionChangeSet {
  return {
    changeId: makeId("projection_change"),
    observedAt: new Date().toISOString(),
    kinds,
    reasons,
    metadata
  };
}

/**
 * Coordinates projection fanout across configured sinks.
 */
export class ProjectionService {
  private readonly sinks: readonly ProjectionSink[];
  private operationQueue: Promise<void> = Promise.resolve();

  /**
   * Initializes the projection service with sink fanout and snapshot dependencies.
   *
   * **Why it exists:**
   * Projection should stay an optional boundary around canonical runtime writes, and one service
   * keeps snapshot generation, sink fanout, and sync-state bookkeeping out of the individual
   * stores that publish projection changes.
   *
   * **What it talks to:**
   * - Uses `ProjectionStateStore` from `./projectionStateStore`.
   * - Uses sink contracts from `./contracts`.
   *
   * @param config - Projection runtime configuration.
   * @param options - Sink fanout and snapshot dependencies.
   */
  constructor(
    private readonly config: ProjectionRuntimeConfig,
    private readonly options: ProjectionServiceOptions
  ) {
    this.sinks = options.sinks;
  }

  /**
   * Returns whether any real projection sink is enabled.
   *
   * **Why it exists:**
   * Runtime callers should be able to publish projection changes without repeatedly checking raw
   * config flags or sink arrays.
   *
   * **What it talks to:**
   * - Uses local runtime config within this instance.
   *
   * @returns `true` when at least one non-noop sink is active.
   */
  isEnabled(): boolean {
    return this.config.enabled && this.sinks.length > 0;
  }

  /**
   * Performs a full rebuild across all configured sinks.
   *
   * **Why it exists:**
   * Manual export and recovery should share one snapshot fanout path instead of each sink being
   * invoked ad hoc by tools or startup code.
   *
   * **What it talks to:**
   * - Uses the injected snapshot provider and sink fanout.
   * - Uses `ProjectionStateStore` from `./projectionStateStore`.
   *
   * @param reason - Human-readable rebuild reason recorded in projection state.
   * @returns Promise resolving after sink fanout completes.
   */
  async rebuild(reason = "manual_rebuild"): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    await this.enqueueOperation(async () => {
      const snapshot = await this.options.snapshotProvider();
      const attemptedAt = new Date().toISOString();
      let state = await this.options.stateStore.load();

      for (const sink of this.sinks) {
        state = updateSinkAttempt(state, sink.id, attemptedAt);
        try {
          await sink.rebuild(snapshot);
          state = updateSinkSuccess(state, sink.id, attemptedAt, reason, true);
        } catch (error) {
          state = updateSinkFailure(state, sink.id, attemptedAt, error);
          this.reportError(error);
        }
      }

      await this.options.stateStore.save(state);
    });
  }

  /**
   * Publishes one canonical change-set to configured sinks.
   *
   * **Why it exists:**
   * Runtime stores should publish simple domain changes while this service decides whether to do a
   * real-time sync, record the last change only, or no-op because projection is disabled.
   *
   * **What it talks to:**
   * - Uses the injected snapshot provider and sink fanout.
   * - Uses `ProjectionStateStore` from `./projectionStateStore`.
   *
   * @param changeSet - Canonical projection change-set.
   * @returns Promise resolving after state bookkeeping and any sink fanout complete.
   */
  async notifyChange(changeSet: ProjectionChangeSet): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }
    await this.enqueueOperation(async () => {
      if (!this.config.realtime) {
        const state = await this.options.stateStore.load();
        await this.options.stateStore.save({
          ...state,
          updatedAt: changeSet.observedAt,
          lastChangeId: changeSet.changeId
        });
        return;
      }

      const snapshot = await this.options.snapshotProvider();
      const attemptedAt = new Date().toISOString();
      let state = await this.options.stateStore.load();

      for (const sink of this.sinks) {
        state = updateSinkAttempt(state, sink.id, attemptedAt);
        try {
          await sink.sync(changeSet, snapshot);
          state = updateSinkSuccess(state, sink.id, attemptedAt, changeSet.changeId, false);
        } catch (error) {
          state = updateSinkFailure(state, sink.id, attemptedAt, error);
          this.reportError(error);
        }
      }

      await this.options.stateStore.save(state);
    });
  }

  /**
   * Serializes projection operations so multiple rebuilds or syncs cannot mutate one sink at the same time.
   *
   * **Why it exists:**
   * Startup rebuilds, manual exports, and real-time sync notifications can overlap, and the vault
   * sink needs one-writer-at-a-time behavior to avoid filesystem races and partial mirror updates.
   *
   * **What it talks to:**
   * - Uses local queue state within this service.
   *
   * @param operation - Projection operation to run once earlier work completes.
   * @returns Promise resolving or rejecting with the operation result.
   */
  private async enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const runOperation = this.operationQueue.then(operation, operation);
    this.operationQueue = runOperation.then(
      () => undefined,
      () => undefined
    );
    return runOperation;
  }

  /**
   * Reports one sink or snapshot error through the configured handler.
   *
   * **Why it exists:**
   * Projection failures should be observable without turning optional mirrors into hard runtime
   * failures, and this keeps that reporting behavior centralized.
   *
   * **What it talks to:**
   * - Uses the optional `onError` callback injected into this service.
   *
   * @param error - Sink, snapshot, or persistence failure encountered during projection.
   */
  private reportError(error: unknown): void {
    this.options.onError?.(error);
  }
}

/**
 * Updates sink state for the start of one sync or rebuild attempt.
 *
 * **Why it exists:**
 * Projection state updates should stay deterministic and reusable across change-driven syncs and
 * full rebuilds instead of mutating the state shape inline in multiple places.
 *
 * **What it talks to:**
 * - Uses local sink-state helpers within this module.
 *
 * @param state - Current projection-state snapshot.
 * @param sinkId - Sink identifier being updated.
 * @param attemptedAt - Attempt timestamp.
 * @returns Updated projection-state snapshot.
 */
function updateSinkAttempt(
  state: ProjectionStateSnapshot,
  sinkId: string,
  attemptedAt: string
): ProjectionStateSnapshot {
  return {
    ...state,
    updatedAt: attemptedAt,
    sinkStates: {
      ...state.sinkStates,
      [sinkId]: {
        ...ensureSinkState(state.sinkStates[sinkId]),
        lastAttemptedAt: attemptedAt,
        lastError: null
      }
    }
  };
}

/**
 * Updates sink state for a successful sync or rebuild.
 *
 * **Why it exists:**
 * Success bookkeeping should keep the latest change id and rebuild timestamp aligned across all
 * sinks without each caller rebuilding the state object by hand.
 *
 * **What it talks to:**
 * - Uses local sink-state helpers within this module.
 *
 * @param state - Current projection-state snapshot.
 * @param sinkId - Sink identifier being updated.
 * @param succeededAt - Success timestamp.
 * @param marker - Change id or rebuild marker.
 * @param isRebuild - `true` when the success came from a full rebuild.
 * @returns Updated projection-state snapshot.
 */
function updateSinkSuccess(
  state: ProjectionStateSnapshot,
  sinkId: string,
  succeededAt: string,
  marker: string,
  isRebuild: boolean
): ProjectionStateSnapshot {
  return {
    ...state,
    updatedAt: succeededAt,
    lastChangeId: marker,
    lastRebuildAt: isRebuild ? succeededAt : state.lastRebuildAt,
    sinkStates: {
      ...state.sinkStates,
      [sinkId]: {
        ...ensureSinkState(state.sinkStates[sinkId]),
        lastAttemptedAt: succeededAt,
        lastSucceededAt: succeededAt,
        lastError: null
      }
    }
  };
}

/**
 * Updates sink state for one failed sync or rebuild attempt.
 *
 * **Why it exists:**
 * Optional sinks should record failure details durably without crashing the runtime, and this
 * helper keeps the failure-shape consistent across all projection call sites.
 *
 * **What it talks to:**
 * - Uses local sink-state helpers within this module.
 *
 * @param state - Current projection-state snapshot.
 * @param sinkId - Sink identifier being updated.
 * @param attemptedAt - Failure timestamp.
 * @param error - Projection error encountered by the sink.
 * @returns Updated projection-state snapshot.
 */
function updateSinkFailure(
  state: ProjectionStateSnapshot,
  sinkId: string,
  attemptedAt: string,
  error: unknown
): ProjectionStateSnapshot {
  return {
    ...state,
    updatedAt: attemptedAt,
    sinkStates: {
      ...state.sinkStates,
      [sinkId]: {
        ...ensureSinkState(state.sinkStates[sinkId]),
        lastAttemptedAt: attemptedAt,
        lastError: error instanceof Error ? error.message : String(error)
      }
    }
  };
}

/**
 * Normalizes one maybe-missing sink state into the canonical sync-state shape.
 *
 * **Why it exists:**
 * Projection state updates should not branch around undefined sink entries every time a new sink
 * is added or a mirror starts for the first time.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param state - Existing per-sink state, if any.
 * @returns Canonical per-sink sync state.
 */
function ensureSinkState(state: ProjectionSinkSyncState | undefined): ProjectionSinkSyncState {
  return state ?? {
    lastAttemptedAt: null,
    lastSucceededAt: null,
    lastError: null
  };
}
