/**
 * @fileoverview Tests Telegram adapter auth/allowlist/rate-limit/replay controls and real orchestrator governance-path routing.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { BrainOrchestrator } from "../../src/core/orchestrator";
import { PersonalityStore } from "../../src/core/personalityStore";
import { SemanticMemoryStore } from "../../src/core/semanticMemory";
import { StateStore } from "../../src/core/stateStore";
import { createDefaultGovernors } from "../../src/governors/defaultGovernors";
import { MasterGovernor } from "../../src/governors/masterGovernor";
import { MockModelClient } from "../../src/models/mockModelClient";
import { PlannerOrgan } from "../../src/organs/planner";
import { ReflectionOrgan } from "../../src/organs/reflection";
import { ToolExecutorOrgan } from "../../src/organs/executor";
import { TelegramAdapter, TelegramAdapterConfig, TelegramInboundMessage } from "../../src/interfaces/telegramAdapter";
import { GovernanceMemoryStore } from "../../src/core/governanceMemory";

/**
 * Implements `buildAdapterConfig` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildAdapterConfig(): TelegramAdapterConfig {
  return {
    auth: {
      requiredToken: "stage5-secret"
    },
    allowlist: {
      allowedUsernames: ["agentowner"],
      allowedUserIds: ["user-1"],
      allowedChatIds: ["chat-1"]
    },
    rateLimit: {
      windowMs: 60_000,
      maxEventsPerWindow: 2
    },
    replay: {
      maxTrackedUpdateIds: 200
    }
  };
}

/**
 * Implements `buildMessage` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildMessage(overrides: Partial<TelegramInboundMessage> = {}): TelegramInboundMessage {
  return {
    updateId: 1,
    chatId: "chat-1",
    userId: "user-1",
    username: "agentowner",
    text: "Give me a concise status update.",
    authToken: "stage5-secret",
    receivedAt: new Date().toISOString(),
    ...overrides
  };
}

/**
 * Implements `withAdapterHarness` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withAdapterHarness(
  callback: (adapter: TelegramAdapter) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage5-"));
  const statePath = path.join(tempDir, "state.json");
  const memoryPath = path.join(tempDir, "memory.json");
  const personalityPath = path.join(tempDir, "personality_profile.json");
  const governanceMemoryPath = path.join(tempDir, "governance_memory.json");
  const modelClient = new MockModelClient();
  const memoryStore = new SemanticMemoryStore(memoryPath);
  const brain = new BrainOrchestrator(
    {
      ...DEFAULT_BRAIN_CONFIG,
      limits: { ...DEFAULT_BRAIN_CONFIG.limits },
      governance: { ...DEFAULT_BRAIN_CONFIG.governance },
      permissions: { ...DEFAULT_BRAIN_CONFIG.permissions },
      dna: { ...DEFAULT_BRAIN_CONFIG.dna },
      routing: { ...DEFAULT_BRAIN_CONFIG.routing },
      governorRouting: { ...DEFAULT_BRAIN_CONFIG.governorRouting },
      runtime: { ...DEFAULT_BRAIN_CONFIG.runtime }
    },
    new PlannerOrgan(modelClient, memoryStore),
    new ToolExecutorOrgan(DEFAULT_BRAIN_CONFIG),
    createDefaultGovernors(),
    new MasterGovernor(DEFAULT_BRAIN_CONFIG.governance.supermajorityThreshold),
    new StateStore(statePath),
    modelClient,
    new ReflectionOrgan(memoryStore, modelClient),
    new PersonalityStore(personalityPath),
    new GovernanceMemoryStore(governanceMemoryPath)
  );
  const adapter = new TelegramAdapter(brain, buildAdapterConfig());

  try {
    await callback(adapter);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("telegram adapter rejects unauthorized token requests", async () => {
  await withAdapterHarness(async (adapter) => {
    const result = await adapter.handleMessage(buildMessage({ authToken: "bad-token" }));
    assert.equal(result.accepted, false);
    assert.equal(result.code, "UNAUTHORIZED");
  });
});

test("telegram adapter enforces username, user, and chat allowlist", async () => {
  await withAdapterHarness(async (adapter) => {
    const deniedByUsername = await adapter.handleMessage(
      buildMessage({
        updateId: 2,
        username: "intruder_user"
      })
    );
    const deniedByUserId = await adapter.handleMessage(
      buildMessage({
        updateId: 3,
        userId: "intruder-user"
      })
    );
    const deniedByChat = await adapter.handleMessage(
      buildMessage({
        updateId: 4,
        chatId: "intruder-chat"
      })
    );

    assert.equal(deniedByUsername.accepted, false);
    assert.equal(deniedByUsername.code, "ALLOWLIST_DENIED");
    assert.equal(deniedByUserId.accepted, false);
    assert.equal(deniedByUserId.code, "ALLOWLIST_DENIED");
    assert.equal(deniedByChat.accepted, false);
    assert.equal(deniedByChat.code, "ALLOWLIST_DENIED");
  });
});

test("telegram adapter applies rate-limit controls for burst traffic", async () => {
  await withAdapterHarness(async (adapter) => {
    const first = await adapter.handleMessage(buildMessage({ updateId: 10 }));
    const second = await adapter.handleMessage(buildMessage({ updateId: 11 }));
    const third = await adapter.handleMessage(buildMessage({ updateId: 12 }));

    assert.equal(first.accepted, true);
    assert.equal(second.accepted, true);
    assert.equal(third.accepted, false);
    assert.equal(third.code, "RATE_LIMITED");
  });
});

test("telegram adapter rejects duplicate update replay attempts", async () => {
  await withAdapterHarness(async (adapter) => {
    const first = await adapter.handleMessage(buildMessage({ updateId: 22 }));
    const replay = await adapter.handleMessage(buildMessage({ updateId: 22 }));

    assert.equal(first.accepted, true);
    assert.equal(replay.accepted, false);
    assert.equal(replay.code, "DUPLICATE_EVENT");
  });
});

test("telegram adapter routes accepted events through orchestrator governance path", async () => {
  await withAdapterHarness(async (adapter) => {
    const result = await adapter.handleMessage(
      buildMessage({
        updateId: 31,
        text: "Delete C:/Users/benac/important.txt"
      })
    );

    assert.equal(result.accepted, true);
    assert.ok(result.runResult);
    assert.equal(result.runResult?.actionResults.length, 1);
    assert.equal(result.runResult?.actionResults[0].approved, false);
    assert.ok(result.runResult?.actionResults[0].blockedBy.includes("DELETE_OUTSIDE_SANDBOX"));
  });
});

test("telegram adapter autonomous summary reports stopped state when loop aborts", async () => {
  await withAdapterHarness(async (adapter) => {
    const progressMessages: string[] = [];
    const controller = new AbortController();
    controller.abort();
    const summary = await adapter.runAutonomousTask(
      "Build a frontend and execute now.",
      new Date().toISOString(),
      async (message) => {
        progressMessages.push(message);
      },
      controller.signal
    );

    assert.match(summary, /Autonomous task stopped after 0 iteration\(s\)/i);
    assert.match(summary, /reason: cancelled by user\./i);
    assert.equal(
      progressMessages.some((message) => /Stopped after 0 iteration\(s\): Cancelled by user\./i.test(message)),
      true
    );
  });
});
