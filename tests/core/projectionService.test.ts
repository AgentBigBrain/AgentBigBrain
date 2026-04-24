/**
 * @fileoverview Tests projection-service fanout, rebuild bookkeeping, and realtime gating behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type {
  ProjectionChangeSet,
  ProjectionHealth,
  ProjectionSink,
  ProjectionSnapshot
} from "../../src/core/projections/contracts";
import { ProjectionService, buildProjectionChangeSet } from "../../src/core/projections/service";
import { ProjectionStateStore } from "../../src/core/projections/projectionStateStore";
import type { ProjectionRuntimeConfig } from "../../src/core/projections/config";
import { buildProjectionSnapshotFixture } from "./projectionTestSupport";

class RecordingProjectionSink implements ProjectionSink {
  readonly id = "recording_sink";
  readonly syncCalls: Array<{ changeSet: ProjectionChangeSet; snapshot: ProjectionSnapshot }> = [];
  readonly rebuildCalls: ProjectionSnapshot[] = [];

  async sync(changeSet: ProjectionChangeSet, snapshot: ProjectionSnapshot): Promise<void> {
    this.syncCalls.push({ changeSet, snapshot });
  }

  async rebuild(snapshot: ProjectionSnapshot): Promise<void> {
    this.rebuildCalls.push(snapshot);
  }

  async healthCheck(): Promise<ProjectionHealth> {
    return {
      healthy: true,
      detail: "recording sink ready"
    };
  }
}

/**
 * Creates one deterministic projection runtime config for tests.
 *
 * **Why it exists:**
 * Projection-service tests need a stable config shape without depending on env parsing.
 *
 * **What it talks to:**
 * - Uses `ProjectionRuntimeConfig` from the projection config module.
 *
 * @param overrides - Targeted config overrides for the test case.
 * @returns Deterministic projection runtime config.
 */
function buildProjectionRuntimeConfigFixture(
  overrides: Partial<ProjectionRuntimeConfig> = {}
): ProjectionRuntimeConfig {
  return {
    enabled: true,
    realtime: true,
    mode: "review_safe",
    sinkIds: ["recording_sink"],
    obsidian: {
      enabled: false,
      vaultPath: path.resolve("vault"),
      rootDirectoryName: "AgentBigBrain",
      mirrorAssets: false
    },
    jsonMirror: {
      enabled: false,
      outputPath: path.resolve("runtime/projections/mirror.json")
    },
    ...overrides
  };
}

test("ProjectionService rebuild records sink success and last rebuild marker", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-projection-service-"));
  try {
    const sink = new RecordingProjectionSink();
    const service = new ProjectionService(
      buildProjectionRuntimeConfigFixture(),
      {
        stateStore: new ProjectionStateStore(path.join(tempDir, "projection_state.json")),
        snapshotProvider: async () => buildProjectionSnapshotFixture(),
        sinks: [sink]
      }
    );

    await service.rebuild("manual_export");

    assert.equal(sink.rebuildCalls.length, 1);
    const state = await new ProjectionStateStore(path.join(tempDir, "projection_state.json")).load();
    assert.equal(typeof state.lastRebuildAt, "string");
    assert.equal(state.lastChangeId, "manual_export");
    assert.equal(state.sinkStates.recording_sink?.lastError, null);
    assert.equal(typeof state.sinkStates.recording_sink?.lastSucceededAt, "string");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ProjectionService notifyChange skips live sink fanout when realtime projection is disabled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-projection-service-no-realtime-"));
  try {
    const sink = new RecordingProjectionSink();
    const service = new ProjectionService(
      buildProjectionRuntimeConfigFixture({
        realtime: false
      }),
      {
        stateStore: new ProjectionStateStore(path.join(tempDir, "projection_state.json")),
        snapshotProvider: async () => buildProjectionSnapshotFixture(),
        sinks: [sink]
      }
    );

    const changeSet = buildProjectionChangeSet(
      ["profile_memory_changed"],
      ["profile_memory:test"]
    );
    await service.notifyChange(changeSet);

    assert.equal(sink.syncCalls.length, 0);
    const state = await new ProjectionStateStore(path.join(tempDir, "projection_state.json")).load();
    assert.equal(state.lastChangeId, changeSet.changeId);
    assert.equal(state.lastRebuildAt, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
