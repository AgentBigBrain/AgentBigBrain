/**
 * @fileoverview Tests Phase 5 runtime wiring for distiller merge ledger + clone-attributed memory commit through orchestrator runTask paths.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { DistillerMergeLedgerStore } from "../../src/core/distillerLedger";
import { makeId } from "../../src/core/ids";
import { BrainOrchestrator } from "../../src/core/orchestrator";
import { StateStore } from "../../src/core/stateStore";
import { SatelliteCloneCoordinator } from "../../src/core/satelliteClone";
import { SemanticMemoryStore } from "../../src/core/semanticMemory";
import { TaskRequest } from "../../src/core/types";
import { createDefaultGovernors } from "../../src/governors/defaultGovernors";
import { MasterGovernor } from "../../src/governors/masterGovernor";
import { MockModelClient } from "../../src/models/mockModelClient";
import { ToolExecutorOrgan } from "../../src/organs/executor";
import { PlannerOrgan } from "../../src/organs/planner";
import { ReflectionOrgan } from "../../src/organs/reflection";
import { GovernanceMemoryStore } from "../../src/core/governanceMemory";
import { PersonalityStore } from "../../src/core/personalityStore";

/**
 * Builds deterministic task fixtures for distiller-runtime tests.
 *
 * **Why it exists:**
 * Keeps task construction stable so assertions focus on distiller wiring outcomes.
 *
 * **What it talks to:**
 * - Uses `TaskRequest` (import `TaskRequest`) from `../../src/core/types`.
 *
 * @param userInput - User-facing task input passed to planner.
 * @param agentId - Clone identity used to test distiller routing behavior.
 * @returns Computed `TaskRequest` result.
 */
function buildTask(userInput: string, agentId: string): TaskRequest {
  return {
    id: makeId("task"),
    agentId,
    goal: "Handle user request safely and efficiently.",
    userInput,
    createdAt: new Date().toISOString()
  };
}

/**
 * Executes callback with an isolated orchestrator runtime wired to distiller dependencies.
 *
 * **Why it exists:**
 * Distiller runtime tests need real orchestrator control flow with isolated persistence artifacts.
 *
 * **What it talks to:**
 * - Uses `BrainOrchestrator` and production organs/governance dependencies.
 * - Uses `DistillerMergeLedgerStore` and `SatelliteCloneCoordinator` for Phase 5 runtime wiring.
 *
 * @param callback - Test callback receiving wired runtime handles.
 * @returns Promise resolving to void.
 */
async function withDistillerRuntimeBrain(
  callback: (input: {
    brain: BrainOrchestrator;
    memoryStore: SemanticMemoryStore;
    distillerLedgerStore: DistillerMergeLedgerStore;
  }) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbb-orchestrator-distiller-"));
  const sqlitePath = path.join(tempDir, "ledgers.sqlite");
  try {
    const modelClient = new MockModelClient();
    const memoryStore = new SemanticMemoryStore(path.join(tempDir, "semantic_memory.json"));
    const distillerLedgerStore = new DistillerMergeLedgerStore(
      path.join(tempDir, "distiller_rejection_ledger.json"),
      {
        backend: "sqlite",
        sqlitePath,
        exportJsonOnWrite: true
      }
    );
    const reflection = new ReflectionOrgan(
      memoryStore,
      modelClient,
      { reflectOnSuccess: true },
      {
        distillerLedgerStore,
        satelliteCloneCoordinator: new SatelliteCloneCoordinator({
          maxClonesPerTask: DEFAULT_BRAIN_CONFIG.limits.maxSubagentsPerTask,
          maxDepth: DEFAULT_BRAIN_CONFIG.limits.maxSubagentDepth,
          maxBudgetUsd: 1
        })
      }
    );
    const brain = new BrainOrchestrator(
      DEFAULT_BRAIN_CONFIG,
      new PlannerOrgan(modelClient, memoryStore),
      new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG),
      createDefaultGovernors(),
      new MasterGovernor(DEFAULT_BRAIN_CONFIG.governance.supermajorityThreshold),
      new StateStore(path.join(tempDir, "state.json")),
      modelClient,
      reflection,
      new PersonalityStore(path.join(tempDir, "personality.json")),
      new GovernanceMemoryStore(path.join(tempDir, "governance_memory.json"))
    );

    await callback({
      brain,
      memoryStore,
      distillerLedgerStore
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("orchestrator runTask routes clone-attributed reflection lesson through distiller merge ledger", async () => {
  await withDistillerRuntimeBrain(async ({ brain, memoryStore, distillerLedgerStore }) => {
    const runResult = await brain.runTask(
      buildTask("Provide a concise deterministic summary update.", "atlas-1001")
    );
    assert.equal(runResult.actionResults.length > 0, true);

    const memory = await memoryStore.load();
    const ledger = await distillerLedgerStore.load();
    assert.equal(memory.lessons.length >= 1, true);
    assert.equal(memory.lessons[0]?.committedByAgentId, "atlas-1001");
    assert.equal(ledger.entries.length >= 1, true);
    assert.equal(ledger.entries[0]?.cloneId, "atlas-1001");
    assert.equal(ledger.entries[0]?.merged, true);
  });
});

