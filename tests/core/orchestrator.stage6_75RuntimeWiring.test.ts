/**
 * @fileoverview Tests Stage 6.75 runtime wiring in production orchestrator/task-runner paths.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { makeId } from "../../src/core/ids";
import { BrainOrchestrator } from "../../src/core/orchestrator";
import { PersonalityStore } from "../../src/core/personalityStore";
import { GovernanceMemoryStore } from "../../src/core/governanceMemory";
import { SemanticMemoryStore } from "../../src/core/semanticMemory";
import { StateStore } from "../../src/core/stateStore";
import { TaskRequest } from "../../src/core/types";
import { createDefaultGovernors } from "../../src/governors/defaultGovernors";
import { MasterGovernor } from "../../src/governors/masterGovernor";
import { MockModelClient } from "../../src/models/mockModelClient";
import {
  GovernorModelOutput,
  PlannerModelOutput,
  StructuredCompletionRequest
} from "../../src/models/types";
import { ToolExecutorOrgan } from "../../src/organs/executor";
import { PlannerOrgan } from "../../src/organs/planner";
import { ReflectionOrgan } from "../../src/organs/reflection";

class FixedPlannerActionsModelClient extends MockModelClient {
  /**
   * Initializes class FixedPlannerActionsModelClient dependencies and runtime state.
   */
  constructor(private readonly actions: PlannerModelOutput["actions"]) {
    super();
  }

  /**
   * Implements `completeJson` behavior within class FixedPlannerActionsModelClient.
   */
  override async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName === "planner_v1") {
      return {
        plannerNotes: "deterministic stage 6.75 runtime policy test plan",
        actions: this.actions
      } as T;
    }

    if (request.schemaName === "governor_v1") {
      const approveVote: GovernorModelOutput = {
        approve: true,
        reason: "allow for deterministic runtime policy coverage",
        confidence: 0.99
      };
      return approveVote as T;
    }

    return super.completeJson<T>(request);
  }
}

/**
 * Implements `buildTask` behavior within module scope.
 */
function buildTask(userInput: string): TaskRequest {
  return {
    id: makeId("task"),
    goal: "Run deterministic stage 6.75 runtime policy checks.",
    userInput,
    createdAt: new Date().toISOString()
  };
}

/**
 * Executes callback with a runtime brain configured for network-write policy-path tests.
 */
async function withStage675RuntimeBrain(
  plannerActions: PlannerModelOutput["actions"],
  callback: (brain: BrainOrchestrator) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbb-stage675-runtime-"));
  try {
    const config = {
      ...DEFAULT_BRAIN_CONFIG,
      permissions: {
        ...DEFAULT_BRAIN_CONFIG.permissions,
        allowNetworkWriteAction: true
      }
    };
    const modelClient = new FixedPlannerActionsModelClient(plannerActions);
    const memoryStore = new SemanticMemoryStore(path.join(tempDir, "semantic_memory.json"));
    const brain = new BrainOrchestrator(
      config,
      new PlannerOrgan(modelClient, memoryStore),
      new ToolExecutorOrgan(config),
      createDefaultGovernors(),
      new MasterGovernor(config.governance.supermajorityThreshold),
      new StateStore(path.join(tempDir, "state.json")),
      modelClient,
      new ReflectionOrgan(memoryStore, modelClient),
      new PersonalityStore(path.join(tempDir, "personality.json")),
      new GovernanceMemoryStore(path.join(tempDir, "governance_memory.json"))
    );
    await callback(brain);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("stage 6.75 connector policy blocks unsupported update/delete operations in runtime path", async () => {
  await withStage675RuntimeBrain(
    [
      {
        type: "network_write",
        description: "Attempt unsupported calendar update operation.",
        params: {
          endpoint: "https://example.com/calendar",
          connector: "calendar",
          operation: "update",
          approvalId: "approval_connector_blocked"
        }
      }
    ],
    async (brain) => {
      const result = await brain.runTask(buildTask("attempt unsupported connector operation"));
      assert.equal(result.actionResults.length, 1);
      assert.equal(result.actionResults[0]?.approved, false);
      assert.equal(
        result.actionResults[0]?.blockedBy.includes("CONNECTOR_OPERATION_NOT_SUPPORTED_IN_STAGE_6_75"),
        true
      );
    }
  );
});

test("stage 6.75 consistency preflight blocks stale connector writes in runtime path", async () => {
  await withStage675RuntimeBrain(
    [
      {
        type: "network_write",
        description: "Attempt stale calendar write with expired read watermark.",
        params: {
          endpoint: "https://example.com/calendar",
          connector: "calendar",
          operation: "write",
          approvalId: "approval_stale_blocked",
          lastReadAtIso: "2020-01-01T00:00:00.000Z"
        }
      }
    ],
    async (brain) => {
      const result = await brain.runTask(buildTask("attempt stale calendar write"));
      assert.equal(result.actionResults.length, 1);
      assert.equal(result.actionResults[0]?.approved, false);
      assert.equal(result.actionResults[0]?.blockedBy.includes("STATE_STALE_REPLAN_REQUIRED"), true);
    }
  );
});

test("stage 6.75 approval policy blocks max-use exceeded grants in runtime path", async () => {
  await withStage675RuntimeBrain(
    [
      {
        type: "network_write",
        description: "Attempt calendar write with exhausted approval grant.",
        params: {
          endpoint: "https://example.com/calendar",
          connector: "calendar",
          operation: "write",
          approvalId: "approval_exhausted_001",
          lastReadAtIso: new Date().toISOString(),
          freshnessWindowMs: 60_000,
          approvalMaxUses: 1,
          approvalUses: 1,
          freshnessValid: true,
          diffHashMatches: true
        }
      }
    ],
    async (brain) => {
      const result = await brain.runTask(buildTask("attempt exhausted approval grant"));
      assert.equal(result.actionResults.length, 1);
      assert.equal(result.actionResults[0]?.approved, false);
      assert.equal(
        result.actionResults[0]?.blockedBy.includes("APPROVAL_MAX_USES_EXCEEDED"),
        true,
        JSON.stringify(result.actionResults, null, 2)
      );
    }
  );
});

test("stage 6.75 runtime path blocks unknown approval ids before any network write is approved", async () => {
  const replayKey = "idem_replay_001";
  await withStage675RuntimeBrain(
    [
      {
        type: "network_write",
        description: "First connector write.",
        params: {
          endpoint: "https://example.com/calendar",
          connector: "calendar",
          operation: "write",
          approvalId: "approval_replay_001",
          lastReadAtIso: new Date().toISOString(),
          freshnessWindowMs: 60_000,
          idempotencyKey: replayKey
        }
      },
      {
        type: "network_write",
        description: "Replay connector write with duplicate idempotency key.",
        params: {
          endpoint: "https://example.com/calendar",
          connector: "calendar",
          operation: "write",
          approvalId: "approval_replay_001",
          lastReadAtIso: new Date().toISOString(),
          freshnessWindowMs: 60_000,
          idempotencyKey: replayKey
        }
      }
    ],
    async (brain) => {
      const result = await brain.runTask(buildTask("attempt idempotency replay"));
      assert.equal(result.actionResults.length, 2);
      assert.equal(result.actionResults[0]?.approved, false);
      assert.equal(result.actionResults[1]?.approved, false);
      assert.equal(
        result.actionResults[0]?.blockedBy.includes("APPROVAL_SCOPE_MISMATCH"),
        true,
        JSON.stringify(result.actionResults, null, 2)
      );
      assert.equal(
        result.actionResults[1]?.blockedBy.includes("IDEMPOTENCY_KEY_REPLAY_DETECTED"),
        true,
        JSON.stringify(result.actionResults, null, 2)
      );
    }
  );
});
