/**
 * @fileoverview Tests Phase 4 runtime wiring for workflow and judgment learning in orchestrator paths.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { makeId } from "../../src/core/ids";
import { JudgmentPatternStore } from "../../src/core/judgmentPatterns";
import { BrainOrchestrator } from "../../src/core/orchestrator";
import { StateStore } from "../../src/core/stateStore";
import { TaskRequest } from "../../src/core/types";
import { WorkflowLearningStore } from "../../src/core/workflowLearningStore";
import { createDefaultGovernors } from "../../src/governors/defaultGovernors";
import { MasterGovernor } from "../../src/governors/masterGovernor";
import { MockModelClient } from "../../src/models/mockModelClient";
import { ToolExecutorOrgan } from "../../src/organs/executor";
import { PlannerOrgan } from "../../src/organs/planner";
import { ReflectionOrgan } from "../../src/organs/reflection";
import { GovernanceMemoryStore } from "../../src/core/governanceMemory";
import { PersonalityStore } from "../../src/core/personalityStore";
import { SemanticMemoryStore } from "../../src/core/semanticMemory";

/**
 * Builds deterministic task fixtures for learning-runtime tests.
 */
function buildTask(userInput: string): TaskRequest {
  return {
    id: makeId("task"),
    goal: "Handle user request safely and efficiently.",
    userInput,
    createdAt: new Date().toISOString()
  };
}

/**
 * Executes callback with an isolated orchestrator runtime wired to workflow/judgment stores.
 */
async function withLearningRuntimeBrain(
  callback: (input: {
    brain: BrainOrchestrator;
    workflowStore: WorkflowLearningStore;
    judgmentStore: JudgmentPatternStore;
  }) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbb-orchestrator-learning-"));
  const sqlitePath = path.join(tempDir, "ledgers.sqlite");
  try {
    const modelClient = new MockModelClient();
    const memoryStore = new SemanticMemoryStore(path.join(tempDir, "semantic_memory.json"));
    const workflowStore = new WorkflowLearningStore(path.join(tempDir, "workflow_learning.json"), {
      backend: "sqlite",
      sqlitePath,
      exportJsonOnWrite: true
    });
    const judgmentStore = new JudgmentPatternStore(path.join(tempDir, "judgment_patterns.json"), {
      backend: "sqlite",
      sqlitePath,
      exportJsonOnWrite: true
    });
    const brain = new BrainOrchestrator(
      DEFAULT_BRAIN_CONFIG,
      new PlannerOrgan(modelClient, memoryStore),
      new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG),
      createDefaultGovernors(),
      new MasterGovernor(DEFAULT_BRAIN_CONFIG.governance.supermajorityThreshold),
      new StateStore(path.join(tempDir, "state.json")),
      modelClient,
      new ReflectionOrgan(memoryStore, modelClient),
      new PersonalityStore(path.join(tempDir, "personality.json")),
      new GovernanceMemoryStore(path.join(tempDir, "governance_memory.json")),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      workflowStore,
      judgmentStore
    );

    await callback({
      brain,
      workflowStore,
      judgmentStore
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("orchestrator writes learning signals and reuses them in subsequent planning", async () => {
  await withLearningRuntimeBrain(async ({ brain, workflowStore, judgmentStore }) => {
    const firstResult = await brain.runTask(
      buildTask("Please provide a concise deterministic release readiness summary.")
    );
    assert.equal(firstResult.actionResults.length > 0, true);

    const storedWorkflowPatterns = await workflowStore.load();
    const storedJudgmentPatterns = await judgmentStore.load();
    assert.equal(storedWorkflowPatterns.patterns.length >= 1, true);
    assert.equal(storedJudgmentPatterns.patterns.length >= 1, true);

    const secondResult = await brain.runTask(
      buildTask("Please provide a concise deterministic release readiness summary.")
    );
    assert.equal(secondResult.actionResults.length > 0, true);
    assert.equal((secondResult.plan.learningHints?.workflowHintCount ?? 0) >= 1, true);
    assert.equal((secondResult.plan.learningHints?.judgmentHintCount ?? 0) >= 1, true);
  });
});
