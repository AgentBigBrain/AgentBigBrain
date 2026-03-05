/**
 * @fileoverview Tests personality-state persistence and deterministic reward update behavior.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { PersonalityStore } from "../../src/core/personalityStore";
import { TaskRunResult } from "../../src/core/types";

/**
 * Implements `buildRunResult` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildRunResult(overrides: Partial<TaskRunResult> = {}): TaskRunResult {
  return {
    task: {
      id: "task_personality",
      goal: "personality evolution test",
      userInput: "status",
      createdAt: new Date().toISOString()
    },
    plan: {
      taskId: "task_personality",
      plannerNotes: "test",
      actions: [
        {
          id: "action_personality",
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
          id: "action_personality",
          type: "respond",
          description: "respond",
          params: {},
          estimatedCostUsd: 0.01
        },
        mode: "fast_path",
        approved: true,
        blockedBy: [],
        violations: [],
        votes: []
      }
    ],
    summary: "ok",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    ...overrides
  };
}

/**
 * Implements `withPersonalityStore` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withPersonalityStore(
  callback: (store: PersonalityStore, filePath: string) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-personality-"));
  const personalityPath = path.join(tempDir, "personality_profile.json");
  const store = new PersonalityStore(personalityPath);
  try {
    await callback(store, personalityPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("PersonalityStore returns initial state when file is missing", async () => {
  await withPersonalityStore(async (store) => {
    const state = await store.load();
    assert.equal(state.history.length, 0);
    assert.equal(state.profile.tone, "balanced");
    assert.equal(typeof state.profile.traits.clarity, "number");
  });
});

test("PersonalityStore applies run reward and persists history", async () => {
  await withPersonalityStore(async (store, filePath) => {
    const updated = await store.applyRunReward(buildRunResult());
    assert.equal(updated.history.length, 1);
    assert.equal(updated.history[0].taskId, "task_personality");
    assert.ok(updated.history[0].rewardedTraits.includes("clarity"));

    const reloaded = await new PersonalityStore(filePath).load();
    assert.equal(reloaded.history.length, 1);
    assert.equal(reloaded.profile.updatedAt.length > 0, true);
  });
});

test("PersonalityStore recovers from corrupted JSON by returning initial state", async () => {
  await withPersonalityStore(async (store, filePath) => {
    await writeFile(filePath, "{not-valid-json", "utf8");
    const state = await store.load();
    assert.equal(state.history.length, 0);
    assert.equal(state.profile.tone, "balanced");
  });
});
