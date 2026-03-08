/**
 * @fileoverview Tests canonical Stage 6.86 runtime-action entrypoints after subsystem extraction.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { Stage686RuntimeActionEngine as CompatStage686RuntimeActionEngine } from "../../src/core/stage6_86RuntimeActions";
import { Stage686RuntimeActionEngine } from "../../src/core/stage6_86/runtimeActions";
import type { TaskRunResult } from "../../src/core/types";

test("Stage686RuntimeActionEngine compatibility entrypoint matches the canonical runtime module", () => {
  assert.equal(CompatStage686RuntimeActionEngine, Stage686RuntimeActionEngine);
});

test("Stage686RuntimeActionEngine returns null for non-Stage 6.86 actions", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-stage686-actions-"));
  try {
    const engine = new Stage686RuntimeActionEngine({
      backend: "json",
      sqlitePath: path.join(tempDir, "runtime.sqlite"),
      exportJsonOnWrite: false
    });

    const result = await engine.execute({
      taskId: "task_stage686_runtime_action_1",
      proposalId: "proposal_stage686_runtime_action_1",
      missionId: "mission_stage686_runtime_action_1",
      missionAttemptId: 1,
      action: {
        id: "action_stage686_runtime_action_1",
        type: "respond",
        description: "reply to the user",
        params: {
          message: "done"
        },
        estimatedCostUsd: 0.01
      } as TaskRunResult["plan"]["actions"][number]
    });

    assert.equal(result, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
