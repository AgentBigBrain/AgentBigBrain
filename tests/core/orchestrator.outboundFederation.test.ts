/**
 * @fileoverview Tests orchestrator outbound federation delegation wiring and deterministic fallback behavior.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { BrainOrchestrator } from "../../src/core/orchestrator";
import { FederatedOutboundRuntimeConfig } from "../../src/core/federatedOutboundDelegation";
import { GovernanceMemoryStore } from "../../src/core/governanceMemory";
import { StateStore } from "../../src/core/stateStore";
import { TaskRequest } from "../../src/core/types";
import { FederatedDelegationGateway } from "../../src/core/federatedDelegation";
import { createDefaultGovernors } from "../../src/governors/defaultGovernors";
import { MasterGovernor } from "../../src/governors/masterGovernor";
import { MockModelClient } from "../../src/models/mockModelClient";
import { ModelClient, StructuredCompletionRequest } from "../../src/models/types";
import { PlannerOrgan } from "../../src/organs/planner";
import { ReflectionOrgan } from "../../src/organs/reflection";
import { ToolExecutorOrgan } from "../../src/organs/executor";
import { FederatedHttpServer } from "../../src/interfaces/federatedServer";
import { PersonalityStore } from "../../src/core/personalityStore";
import { SemanticMemoryStore } from "../../src/core/semanticMemory";

const OUTBOUND_AGENT_ID = "outbound_remote_agent";
const OUTBOUND_SHARED_SECRET = "outbound_remote_shared_secret";

/**
 * Implements SHA-256 digest derivation for deterministic federation contract fixtures.
 */
function hashSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * Builds deterministic task fixture for outbound delegation tests.
 */
function buildTask(userInput: string): TaskRequest {
  return {
    id: "task_outbound_runtime_001",
    goal: "Coordinate a delegated response safely.",
    userInput,
    createdAt: "2026-03-03T00:00:00.000Z"
  };
}

/**
 * Executes callback with a temporary runtime directory and deterministic cleanup.
 */
async function withTempRuntimeDir(callback: (tempDir: string) => Promise<void>): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbb-outbound-orchestrator-"));
  try {
    await callback(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Creates a test orchestrator with injectable outbound federation runtime config resolver.
 */
function createTestBrain(
  tempDir: string,
  modelClient: ModelClient,
  resolveOutboundConfig: () => FederatedOutboundRuntimeConfig
): BrainOrchestrator {
  const stateStore = new StateStore(path.join(tempDir, "state.json"));
  const memoryStore = new SemanticMemoryStore(path.join(tempDir, "memory.json"));
  const governanceMemoryStore = new GovernanceMemoryStore(path.join(tempDir, "governance_memory.json"));
  const personalityStore = new PersonalityStore(path.join(tempDir, "personality_profile.json"));
  return new BrainOrchestrator(
    DEFAULT_BRAIN_CONFIG,
    new PlannerOrgan(modelClient, memoryStore),
    new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG),
    createDefaultGovernors(),
    new MasterGovernor(DEFAULT_BRAIN_CONFIG.governance.supermajorityThreshold),
    stateStore,
    modelClient,
    new ReflectionOrgan(memoryStore, modelClient),
    personalityStore,
    governanceMemoryStore,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => resolveOutboundConfig()
  );
}

class PlannerMustNotRunModelClient extends MockModelClient {
  /**
   * Implements `completeJson` behavior within class PlannerMustNotRunModelClient.
   * Interacts with local collaborators through imported modules and typed inputs/outputs.
   */
  async completeJson<T>(request: StructuredCompletionRequest): Promise<T> {
    if (request.schemaName === "planner_v1") {
      throw new Error("planner_v1 should not execute when outbound federation delegation succeeds.");
    }
    return super.completeJson<T>(request);
  }
}

test("orchestrator routes explicit federated outbound intent through remote agent and returns delegated result", async () => {
  await withTempRuntimeDir(async (tempDir) => {
    let server: FederatedHttpServer | null = null;
    try {
      const gateway = new FederatedDelegationGateway([
        {
          externalAgentId: OUTBOUND_AGENT_ID,
          sharedSecretHash: hashSha256(OUTBOUND_SHARED_SECRET),
          maxQuotedCostUsd: 5
        }
      ]);
      server = new FederatedHttpServer({
        port: 0,
        host: "127.0.0.1",
        gateway,
        resultStorePath: path.join(tempDir, "federated_results.json"),
        onTaskAccepted: async (decision) => {
          const taskId = decision.taskRequest?.id;
          if (!taskId) {
            throw new Error("Accepted decision missing taskRequest.");
          }
          server?.submitResult(taskId, "Delegated summary from remote agent.", null);
        }
      });
      await server.start();
      const address = server.getAddress();
      assert.ok(address, "Federated server should expose a runtime address after start.");

      const brain = createTestBrain(
        tempDir,
        new PlannerMustNotRunModelClient(),
        () => ({
          enabled: true,
          targets: [
            {
              externalAgentId: OUTBOUND_AGENT_ID,
              baseUrl: `http://${address.host}:${address.port}`,
              sharedSecret: OUTBOUND_SHARED_SECRET,
              maxQuotedCostUsd: 5,
              awaitTimeoutMs: 5000,
              pollIntervalMs: 25
            }
          ]
        })
      );

      const result = await brain.runTask(
        buildTask("[federate:outbound_remote_agent quote=1.25] Please summarize this release report.")
      );

      assert.match(result.summary, /Delegated outbound task to "outbound_remote_agent"/i);
      assert.equal(result.plan.actions.length, 1);
      assert.equal(result.plan.actions[0].type, "network_write");
      assert.equal(result.actionResults.length, 1);
      assert.equal(result.actionResults[0].approved, true);
      assert.match(result.actionResults[0].output ?? "", /Delegated summary from remote agent/i);
      assert.equal(result.actionResults[0].executionMetadata?.outboundFederation, true);
      assert.equal(result.failureTaxonomy, undefined);
    } finally {
      if (server) {
        await server.stop();
      }
    }
  });
});

test("orchestrator falls back to local planning path when outbound delegation is disabled", async () => {
  await withTempRuntimeDir(async (tempDir) => {
    const brain = createTestBrain(
      tempDir,
      new MockModelClient(),
      () => ({
        enabled: false,
        targets: []
      })
    );

    const result = await brain.runTask(
      buildTask("[federate:outbound_remote_agent quote=1.25] Please summarize this release report.")
    );

    assert.match(result.summary, /Completed task with/i);
    assert.equal(result.plan.actions.length > 0, true);
    assert.equal(result.plan.actions.some((action) => action.type === "respond"), true);
  });
});

test("orchestrator persists typed failure taxonomy when outbound delegated execution fails", async () => {
  await withTempRuntimeDir(async (tempDir) => {
    let server: FederatedHttpServer | null = null;
    try {
      const gateway = new FederatedDelegationGateway([
        {
          externalAgentId: OUTBOUND_AGENT_ID,
          sharedSecretHash: hashSha256(OUTBOUND_SHARED_SECRET),
          maxQuotedCostUsd: 5
        }
      ]);
      server = new FederatedHttpServer({
        port: 0,
        host: "127.0.0.1",
        gateway,
        resultStorePath: path.join(tempDir, "federated_results_failure.json"),
        onTaskAccepted: async (decision) => {
          const taskId = decision.taskRequest?.id;
          if (!taskId) {
            throw new Error("Accepted decision missing taskRequest.");
          }
          server?.submitResult(taskId, null, "Remote execution failed deterministic integration check.");
        }
      });
      await server.start();
      const address = server.getAddress();
      assert.ok(address, "Federated server should expose a runtime address after start.");

      const brain = createTestBrain(
        tempDir,
        new PlannerMustNotRunModelClient(),
        () => ({
          enabled: true,
          targets: [
            {
              externalAgentId: OUTBOUND_AGENT_ID,
              baseUrl: `http://${address.host}:${address.port}`,
              sharedSecret: OUTBOUND_SHARED_SECRET,
              maxQuotedCostUsd: 5,
              awaitTimeoutMs: 5000,
              pollIntervalMs: 25
            }
          ]
        })
      );

      const result = await brain.runTask(
        buildTask("[federate:outbound_remote_agent quote=1.25] Please summarize this release report.")
      );

      assert.equal(result.actionResults.length, 1);
      assert.equal(result.actionResults[0].approved, false);
      assert.ok(result.actionResults[0].blockedBy.includes("ACTION_EXECUTION_FAILED"));
      assert.equal(result.failureTaxonomy?.failureCategory, "constraint");
      assert.equal(result.failureTaxonomy?.failureCode, "constraint_blocked");
      assert.match(result.summary, /remote execution failed/i);
    } finally {
      if (server) {
        await server.stop();
      }
    }
  });
});
