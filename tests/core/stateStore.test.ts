/**
 * @fileoverview Tests state-store durability, recovery, and metric updates across process boundaries.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { StateStore } from "../../src/core/stateStore";
import { TaskRunResult } from "../../src/core/types";

/**
 * Implements `buildRunResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildRunResult(id: string): TaskRunResult {
  return {
    task: {
      id: `task_${id}`,
      goal: "Persist state",
      userInput: "Status",
      createdAt: new Date().toISOString()
    },
    plan: {
      taskId: `task_${id}`,
      plannerNotes: "state test",
      actions: [
        {
          id: `action_${id}`,
          type: "respond",
          description: "respond",
          params: {},
          estimatedCostUsd: 0.01
        }
      ]
    },
    actionResults: [
      {
        action: {
          id: `action_${id}`,
          type: "respond",
          description: "respond",
          params: {},
          estimatedCostUsd: 0.01
        },
        mode: "fast_path",
        approved: true,
        blockedBy: [],
        violations: [],
        votes: [],
        output: "ok"
      }
    ],
    summary: "ok",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  };
}

/**
 * Implements `withStateStore` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withStateStore(callback: (store: StateStore, filePath: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-state-"));
  const statePath = path.join(tempDir, "state.json");
  const store = new StateStore(statePath);
  try {
    await callback(store, statePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("StateStore persists runs and metrics across reload", async () => {
  await withStateStore(async (store, statePath) => {
    await store.appendRun(buildRunResult("a"));

    const newStoreInstance = new StateStore(statePath);
    const loaded = await newStoreInstance.load();
    assert.equal(loaded.runs.length, 1);
    assert.equal(loaded.metrics.totalTasks, 1);
    assert.equal(loaded.metrics.approvedActions, 1);
    assert.equal(typeof loaded.lastRunAt, "string");

    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as { runs: unknown[] };
    assert.equal(Array.isArray(parsed.runs), true);
    assert.equal(parsed.runs.length, 1);
  });
});

test("StateStore recovers from corrupted JSON by returning initial state", async () => {
  await withStateStore(async (store, statePath) => {
    await writeFile(statePath, "{not-valid-json", "utf8");
    const state = await store.load();
    assert.equal(state.runs.length, 0);
    assert.equal(state.metrics.totalTasks, 0);
  });
});

test("StateStore preserves all concurrent appends across separate store instances", async () => {
  await withStateStore(async (_store, statePath) => {
    const first = new StateStore(statePath);
    const second = new StateStore(statePath);
    const runCount = 16;
    const runs = Array.from({ length: runCount }, (_value, index) =>
      buildRunResult(`concurrent_${index}`)
    );

    await Promise.all(
      runs.map((run, index) => (index % 2 === 0 ? first.appendRun(run) : second.appendRun(run)))
    );

    const loaded = await new StateStore(statePath).load();
    assert.equal(loaded.runs.length, runCount);
    assert.equal(loaded.metrics.totalTasks, runCount);
    assert.equal(loaded.metrics.approvedActions, runCount);
  });
});

test("StateStore default constructor honors BRAIN_STATE_JSON_PATH for isolated runtime state", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-state-env-"));
  const statePath = path.join(tempDir, "isolated-state.json");
  const previousStatePath = process.env.BRAIN_STATE_JSON_PATH;
  process.env.BRAIN_STATE_JSON_PATH = statePath;

  try {
    const store = new StateStore();
    await store.appendRun(buildRunResult("env_default"));

    const raw = await readFile(statePath, "utf8");
    const parsed = JSON.parse(raw) as { runs: unknown[] };
    assert.equal(parsed.runs.length, 1);
  } finally {
    if (previousStatePath === undefined) {
      delete process.env.BRAIN_STATE_JSON_PATH;
    } else {
      process.env.BRAIN_STATE_JSON_PATH = previousStatePath;
    }
    await rm(tempDir, { recursive: true, force: true });
  }
});
