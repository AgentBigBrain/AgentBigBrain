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
import { Stage686RuntimeStateStore } from "../../src/core/stage6_86/runtimeState";
import type { TaskRunResult } from "../../src/core/types";
import type { BridgeQuestionTimingInterpretationResolver } from "../../src/organs/languageUnderstanding/localIntentModelContracts";

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

test("Stage686RuntimeActionEngine soft-defers bridge emission when bridge timing interpretation says context is awkward", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "abb-stage686-actions-"));
  try {
    const bridgeQuestionTimingInterpretationResolver: BridgeQuestionTimingInterpretationResolver = async () => ({
      source: "local_intent_model",
      kind: "defer_for_context",
      confidence: "high",
      explanation: "The user is actively focused on workflow execution."
    });
    const engine = new Stage686RuntimeActionEngine({
      backend: "json",
      sqlitePath: path.join(tempDir, "runtime.sqlite"),
      exportJsonOnWrite: false,
      bridgeQuestionTimingInterpretationResolver
    });

    const result = await engine.execute({
      taskId: "task_stage686_runtime_action_bridge",
      proposalId: "proposal_stage686_runtime_action_bridge",
      missionId: "mission_stage686_runtime_action_bridge",
      missionAttemptId: 1,
      userInput: "Please finish the CSS deployment fix first.",
      action: {
        id: "action_stage686_runtime_action_bridge",
        type: "pulse_emit",
        description: "emit bridge question",
        params: {
          kind: "bridge_question",
          reasonCode: "RELATIONSHIP_CLARIFICATION",
          threadKey: "thread_relationship",
          entityRefs: ["entity_alpha", "entity_beta"],
          evidenceRefs: ["trace:stage686:bridge_emit"]
        },
        estimatedCostUsd: 0.01
      } as TaskRunResult["plan"]["actions"][number]
    });

    assert.equal(result?.approved, true);
    assert.match(result?.output ?? "", /Bridge question deferred for context/i);
    assert.equal(result?.executionMetadata.stage686BridgeTimingDeferred, true);
    assert.equal(result?.executionMetadata.stage686BridgeTimingDecision, "defer_for_context");

    const runtimeStateStore = new Stage686RuntimeStateStore(undefined, {
      backend: "json",
      sqlitePath: path.join(tempDir, "runtime.sqlite"),
      exportJsonOnWrite: false
    });
    const snapshot = await runtimeStateStore.load();
    assert.deepEqual(snapshot.pendingBridgeQuestions, []);
    assert.equal(snapshot.pulseState.emittedTodayCount, 0);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
