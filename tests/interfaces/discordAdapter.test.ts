/**
 * @fileoverview Tests Discord adapter auth/username-allowlist/rate-limit/replay controls and real orchestrator governance-path routing.
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
import { DiscordAdapter, DiscordAdapterConfig, DiscordInboundMessage } from "../../src/interfaces/discordAdapter";
import { GovernanceMemoryStore } from "../../src/core/governanceMemory";

/**
 * Implements `buildAdapterConfig` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildAdapterConfig(): DiscordAdapterConfig {
  return {
    auth: {
      requiredToken: "stage5-secret"
    },
    allowlist: {
      allowedUsernames: ["agentowner"],
      allowedUserIds: ["discord-user-1"],
      allowedChannelIds: ["discord-channel-1"]
    },
    rateLimit: {
      windowMs: 60_000,
      maxEventsPerWindow: 2
    },
    replay: {
      maxTrackedMessageIds: 200
    }
  };
}

/**
 * Implements `buildMessage` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildMessage(overrides: Partial<DiscordInboundMessage> = {}): DiscordInboundMessage {
  return {
    messageId: "m-1",
    channelId: "discord-channel-1",
    userId: "discord-user-1",
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
  callback: (adapter: DiscordAdapter) => Promise<void>
): Promise<void> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-stage5-discord-"));
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
  const adapter = new DiscordAdapter(brain, buildAdapterConfig());

  try {
    await callback(adapter);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("discord adapter rejects unauthorized token requests", async () => {
  await withAdapterHarness(async (adapter) => {
    const result = await adapter.handleMessage(buildMessage({ authToken: "bad-token" }));
    assert.equal(result.accepted, false);
    assert.equal(result.code, "UNAUTHORIZED");
  });
});

test("discord adapter enforces username allowlist", async () => {
  await withAdapterHarness(async (adapter) => {
    const result = await adapter.handleMessage(
      buildMessage({
        username: "intruder_user"
      })
    );
    assert.equal(result.accepted, false);
    assert.equal(result.code, "ALLOWLIST_DENIED");
  });
});

test("discord adapter applies rate-limit controls for burst traffic", async () => {
  await withAdapterHarness(async (adapter) => {
    const first = await adapter.handleMessage(buildMessage({ messageId: "m-10" }));
    const second = await adapter.handleMessage(buildMessage({ messageId: "m-11" }));
    const third = await adapter.handleMessage(buildMessage({ messageId: "m-12" }));

    assert.equal(first.accepted, true);
    assert.equal(second.accepted, true);
    assert.equal(third.accepted, false);
    assert.equal(third.code, "RATE_LIMITED");
  });
});

test("discord adapter rejects duplicate message replay attempts", async () => {
  await withAdapterHarness(async (adapter) => {
    const first = await adapter.handleMessage(buildMessage({ messageId: "m-22" }));
    const replay = await adapter.handleMessage(buildMessage({ messageId: "m-22" }));

    assert.equal(first.accepted, true);
    assert.equal(replay.accepted, false);
    assert.equal(replay.code, "DUPLICATE_EVENT");
  });
});

test("discord adapter routes accepted events through orchestrator governance path", async () => {
  await withAdapterHarness(async (adapter) => {
    const result = await adapter.handleMessage(
      buildMessage({
        messageId: "m-31",
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

test("discord adapter autonomous summary reports stopped state when loop aborts", async () => {
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
