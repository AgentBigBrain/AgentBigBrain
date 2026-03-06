/**
 * @fileoverview Verifies Discord gateway notifier wiring for edit-capable autonomous progress delivery.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DiscordAdapter } from "../../src/interfaces/discordAdapter";
import { DiscordGateway } from "../../src/interfaces/discordGateway";
import { DiscordInterfaceConfig } from "../../src/interfaces/runtimeConfig";

interface DiscordGatewayTestHarness {
  createConversationNotifier(
    channelId: string
  ): {
    capabilities: {
      supportsEdit: boolean;
      supportsNativeStreaming: boolean;
    };
    send: (message: string) => Promise<{ ok: boolean; messageId: string | null; errorCode: string | null }>;
    edit?: (messageId: string, message: string) => Promise<{ ok: boolean; messageId: string | null; errorCode: string | null }>;
  };
}

/**
 * Implements `buildDiscordConfig` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildDiscordConfig(): DiscordInterfaceConfig {
  return {
    provider: "discord",
    security: {
      sharedSecret: "secret",
      allowedUsernames: ["agentowner"],
      allowedUserIds: [],
      rateLimitWindowMs: 60_000,
      maxEventsPerWindow: 10,
      replayCacheSize: 500,
      agentPulseTickIntervalMs: 30_000,
      ackDelayMs: 800,
      showTechnicalSummary: true,
      showSafetyCodes: true,
      showCompletionPrefix: false,
      followUpOverridePath: null,
      pulseLexicalOverridePath: null,
      allowAutonomousViaInterface: false,
      enableDynamicPulse: false,
      invocation: {
        requireNameCall: false,
        aliases: ["BigBrain"]
      }
    },
    botToken: "discord-token",
    apiBaseUrl: "https://discord.com/api/v10",
    gatewayUrl: "https://discord.com/api/v10/gateway/bot",
    intents: 37377,
    allowedChannelIds: []
  };
}

/**
 * Implements `buildGateway` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildGateway(): DiscordGateway {
  return new DiscordGateway({} as DiscordAdapter, buildDiscordConfig());
}

/**
 * Implements `withMockFetch` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function withMockFetch(
  mockImplementation: typeof fetch,
  callback: () => Promise<void>
): Promise<void> {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = mockImplementation;
  try {
    await callback();
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("discord gateway notifier includes edit function for autonomous progress consolidation", () => {
  const gateway = buildGateway();
  const notifier = (gateway as unknown as DiscordGatewayTestHarness).createConversationNotifier(
    "12345"
  );

  assert.equal(notifier.capabilities.supportsEdit, false);
  assert.equal(notifier.capabilities.supportsNativeStreaming, false);
  assert.equal(typeof notifier.send, "function");
  assert.equal(typeof notifier.edit, "function");
});

test("discord gateway notifier edit uses message patch endpoint", async () => {
  const gateway = buildGateway();
  const notifier = (gateway as unknown as DiscordGatewayTestHarness).createConversationNotifier(
    "12345"
  );

  let capturedUrl = "";
  let capturedMethod = "";
  let capturedBody: Record<string, unknown> | null = null;
  await withMockFetch(
    (async (input, init) => {
      capturedUrl = String(input);
      capturedMethod = String(init?.method ?? "GET");
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "999" })
      } as Response;
    }) as typeof fetch,
    async () => {
      const result = await notifier.edit!("999", "updated progress");
      assert.equal(result.ok, true);
      assert.equal(result.messageId, "999");
      assert.equal(result.errorCode, null);
    }
  );

  assert.equal(capturedMethod, "PATCH");
  assert.match(capturedUrl, /\/channels\/12345\/messages\/999$/);
  assert.equal(capturedBody?.["content"], "updated progress");
});
