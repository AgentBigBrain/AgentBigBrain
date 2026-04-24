/**
 * @fileoverview Provides a no-op projection sink used when projection is disabled or no real target is configured.
 */

import type {
  ProjectionChangeSet,
  ProjectionHealth,
  ProjectionSink,
  ProjectionSnapshot
} from "./contracts";

export class NoOpProjectionSink implements ProjectionSink {
  readonly id = "noop";

  /**
   * Accepts one projection change-set without producing side effects.
   *
   * **Why it exists:**
   * The projection service can stay enabled in code paths and tests even when no real mirror target
   * is configured, which avoids special-casing every caller.
   *
   * **What it talks to:**
   * - Uses `ProjectionChangeSet` from `./contracts`.
   * - Uses `ProjectionSnapshot` from `./contracts`.
   *
   * @param changeSet - Canonical projection change-set.
   * @param snapshot - Projection snapshot associated with the change.
   * @returns Promise resolving after the no-op completes.
   */
  async sync(
    changeSet: ProjectionChangeSet,
    snapshot: ProjectionSnapshot
  ): Promise<void> {
    void changeSet;
    void snapshot;
  }

  /**
   * Accepts one full projection rebuild request without producing side effects.
   *
   * **Why it exists:**
   * Rebuild callers should not need to branch around disabled mirrors when they just want a
   * sink-shaped dependency.
   *
   * **What it talks to:**
   * - Uses `ProjectionSnapshot` from `./contracts`.
   *
   * @param snapshot - Full projection snapshot.
   * @returns Promise resolving after the no-op completes.
   */
  async rebuild(snapshot: ProjectionSnapshot): Promise<void> {
    void snapshot;
  }

  /**
   * Reports healthy no-op sink state.
   *
   * **Why it exists:**
   * Health checks should stay sink-shaped even when projection is intentionally disabled.
   *
   * **What it talks to:**
   * - Uses `ProjectionHealth` from `./contracts`.
   *
   * @returns Healthy no-op sink status.
   */
  async healthCheck(): Promise<ProjectionHealth> {
    return {
      healthy: true,
      detail: "Projection disabled or no real sink configured."
    };
  }
}
