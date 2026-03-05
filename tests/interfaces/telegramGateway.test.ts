/**
 * @fileoverview Verifies Telegram gateway notifier wiring for native draft streaming and safe fallback modes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { TelegramAdapter } from "../../src/interfaces/telegramAdapter";
import { TelegramGateway } from "../../src/interfaces/telegramGateway";
import { TelegramInterfaceConfig } from "../../src/interfaces/runtimeConfig";

interface TelegramGatewayTestHarness {
  createConversationNotifier(
    chatId: string,
    options: { nativeDraftStreamingAllowed: boolean }
  ): {
    capabilities: {
      supportsEdit: boolean;
      supportsNativeStreaming: boolean;
    };
    stream?: (message: string) => Promise<{ ok: boolean; messageId: string | null; errorCode: string | null }>;
    edit?: (messageId: string, message: string) => Promise<{ ok: boolean; messageId: string | null; errorCode: string | null }>;
  };
}

/**
 * Implements `buildTelegramConfig` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildTelegramConfig(nativeDraftStreaming: boolean): TelegramInterfaceConfig {
  return {
    provider: "telegram",
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
    botToken: "telegram-token",
    apiBaseUrl: "https://api.telegram.org",
    pollTimeoutSeconds: 25,
    pollIntervalMs: 500,
    streamingTransportMode: nativeDraftStreaming ? "native_draft" : "edit",
    nativeDraftStreaming,
    allowedChatIds: []
  };
}

/**
 * Implements `buildGateway` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildGateway(nativeDraftStreaming: boolean): TelegramGateway {
  return new TelegramGateway({} as TelegramAdapter, buildTelegramConfig(nativeDraftStreaming));
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

test("telegram gateway notifier keeps edit transport when native draft streaming is disabled", () => {
  const gateway = buildGateway(false);
  const notifier = (gateway as unknown as TelegramGatewayTestHarness).createConversationNotifier(
    "12345",
    { nativeDraftStreamingAllowed: true }
  );

  assert.equal(notifier.capabilities.supportsEdit, true);
  assert.equal(notifier.capabilities.supportsNativeStreaming, false);
  assert.equal(typeof notifier.edit, "function");
  assert.equal(notifier.stream, undefined);
});

test("telegram gateway notifier keeps edit transport when native draft streaming is disallowed", () => {
  const gateway = buildGateway(true);
  const notifier = (gateway as unknown as TelegramGatewayTestHarness).createConversationNotifier(
    "12345",
    { nativeDraftStreamingAllowed: false }
  );

  assert.equal(notifier.capabilities.supportsEdit, true);
  assert.equal(notifier.capabilities.supportsNativeStreaming, false);
  assert.equal(typeof notifier.edit, "function");
  assert.equal(notifier.stream, undefined);
});

test("telegram gateway notifier uses sendMessageDraft transport when native draft streaming is enabled", async () => {
  const gateway = buildGateway(true);
  const notifier = (gateway as unknown as TelegramGatewayTestHarness).createConversationNotifier(
    "12345",
    { nativeDraftStreamingAllowed: true }
  );

  assert.equal(notifier.capabilities.supportsEdit, false);
  assert.equal(notifier.capabilities.supportsNativeStreaming, true);
  assert.equal(notifier.edit, undefined);
  assert.equal(typeof notifier.stream, "function");

  let capturedUrl = "";
  let capturedBody: Record<string, unknown> | null = null;
  await withMockFetch(
    (async (input, init) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true })
      } as Response;
    }) as typeof fetch,
    async () => {
      const result = await notifier.stream!("Still working...");
      assert.equal(result.ok, true);
      assert.equal(result.messageId, null);
      assert.equal(result.errorCode, null);
    }
  );

  assert.match(capturedUrl, /\/bottelegram-token\/sendMessageDraft$/);
  assert.equal(capturedBody?.chat_id, 12345);
  assert.equal(capturedBody?.draft_id, 1);
  assert.equal(capturedBody?.text, "Still working...");
});
