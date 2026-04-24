/**
 * @fileoverview Verifies canonical Discord and Telegram transport-runtime delivery helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { EntityGraphV1 } from "../../src/core/types";
import {
  createDiscordConversationNotifier,
  editDiscordChannelMessage,
  sendDiscordChannelMessage
} from "../../src/interfaces/transportRuntime/discordTransport";
import {
  prepareDiscordMessageCreate,
  sendDiscordGatewayMessage
} from "../../src/interfaces/transportRuntime/discordGatewayRuntime";
import {
  createAutonomousProgressSender,
  runAutonomousTransportTask
} from "../../src/interfaces/transportRuntime/deliveryLifecycle";
import {
  deliverPreparedTransportResponse,
  handleAcceptedTransportConversation
} from "../../src/interfaces/transportRuntime/inboundDispatch";
import {
  attachDiscordSocketLifecycle,
  abortAutonomousTransportTaskIfRequested,
  buildDiscordIdentifyPayload,
  handleDiscordHelloLifecycle,
  handleDiscordGatewaySocketMessage,
  isAutonomousStopIntent,
  pollTelegramUpdatesOnce,
  reconnectWithBackoffLoop,
  resolveDiscordGatewaySocketUrl,
  routeDiscordDispatchEvent,
  runTelegramPollingLoop,
  sendDiscordGatewayPayload,
  startDiscordHeartbeat
} from "../../src/interfaces/transportRuntime/gatewayLifecycle";
import { shouldNotifyRejectedInvocation } from "../../src/interfaces/transportRuntime/rateLimitPolicy";
import {
  createTelegramConversationNotifier,
  editTelegramReply,
  sendTelegramDraftUpdate,
  sendTelegramReply
} from "../../src/interfaces/transportRuntime/telegramTransport";
import {
  prepareTelegramUpdate,
} from "../../src/interfaces/transportRuntime/telegramGatewayRuntime";
import { enrichAcceptedTelegramUpdateWithMedia } from "../../src/interfaces/transportRuntime/telegramConversationDispatch";
import {
  allocateNextTelegramDraftId,
  sendTelegramGatewayReply
} from "../../src/interfaces/transportRuntime/telegramGatewayNotifier";
import { sendObservedTelegramGatewayReply } from "../../src/interfaces/transportRuntime/telegramGatewayObservation";
import type { ConversationInboundMessage } from "../../src/interfaces/conversationRuntime/managerContracts";
import { buildTelegramInterfaceConfigFixture } from "../helpers/conversationFixtures";

interface TestGatewaySocket {
  readyState: number;
  send: (data: string) => void;
  close: () => void;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
  onmessage: ((event: { data: string }) => void | Promise<void>) | null;
}

function buildEmptyEntityGraph(): EntityGraphV1 {
  return {
    schemaVersion: "v1",
    updatedAt: "2026-03-07T10:00:00.000Z",
    entities: [],
    edges: []
  };
}

/**
 * Temporarily replaces the global `fetch` implementation for one async callback.
 *
 * @param mockImplementation - Mock fetch implementation.
 * @param callback - Async callback executed while fetch is mocked.
 * @returns Promise that resolves after the callback and restoration complete.
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

test("createDiscordConversationNotifier renders outbound text for send and edit", async () => {
  const deliveries: Array<{ kind: "send" | "edit"; text: string; messageId?: string }> = [];
  const notifier = createDiscordConversationNotifier({
    renderOutboundText: (text: string) => `wrapped:${text}`,
    sendMessage: async (text: string) => {
      deliveries.push({ kind: "send", text });
      return { ok: true, messageId: "1", errorCode: null };
    },
    editMessage: async (messageId: string, text: string) => {
      deliveries.push({ kind: "edit", messageId, text });
      return { ok: true, messageId, errorCode: null };
    }
  });

  assert.equal(notifier.capabilities.supportsEdit, false);
  assert.equal(notifier.capabilities.supportsNativeStreaming, false);
  await notifier.send("hello");
  await notifier.edit?.("2", "progress");

  assert.deepEqual(deliveries, [
    { kind: "send", text: "wrapped:hello" },
    { kind: "edit", messageId: "2", text: "wrapped:progress" }
  ]);
});

test("sendDiscordChannelMessage retries once on rate limit and returns sent message id", async () => {
  let requestCount = 0;
  await withMockFetch(
    (async (_input, init) => {
      requestCount += 1;
      if (requestCount === 1) {
        return {
          ok: false,
          status: 429,
          json: async () => ({ retry_after: 0 }),
          text: async () => ""
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "999" })
      } as Response;
    }) as typeof fetch,
    async () => {
      const result = await sendDiscordChannelMessage({
        apiBaseUrl: "https://discord.com/api/v10",
        botToken: "discord-token",
        channelId: "12345",
        text: "hello world",
        sleepImpl: async () => undefined
      });
      assert.deepEqual(result, {
        ok: true,
        messageId: "999",
        errorCode: null
      });
    }
  );

  assert.equal(requestCount, 2);
});

test("sendDiscordGatewayMessage applies invocation hints before transport delivery", async () => {
  let capturedBody = "";
  await withMockFetch(
    (async (_input, init) => {
      capturedBody = String(init?.body ?? "");
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "321" })
      } as Response;
    }) as typeof fetch,
    async () => {
      const result = await sendDiscordGatewayMessage(
        {
          provider: "discord",
          security: {
            sharedSecret: "secret",
            allowedUsernames: [],
            allowedUserIds: [],
            rateLimitWindowMs: 1,
            maxEventsPerWindow: 1,
            replayCacheSize: 1,
            agentPulseTickIntervalMs: 1,
            ackDelayMs: 1,
            showTechnicalSummary: false,
            showSafetyCodes: false,
            showCompletionPrefix: false,
            followUpOverridePath: null,
            pulseLexicalOverridePath: null,
            allowAutonomousViaInterface: true,
            enableDynamicPulse: false,
            invocation: {
              requireNameCall: true,
              aliases: ["bigbrain"]
            }
          },
          botToken: "discord-token",
          apiBaseUrl: "https://discord.com/api/v10",
          gatewayUrl: "https://discord.com/api/v10/gateway/bot",
          intents: 1,
          allowedChannelIds: []
        },
        "12345",
        "Use /status for more detail."
      );
      assert.deepEqual(result, {
        ok: true,
        messageId: "321",
        errorCode: null
      });
    }
  );

  assert.match(capturedBody, /bigbrain/);
  assert.match(capturedBody, /bigbrain \/status/);
});

test("editDiscordChannelMessage uses patch endpoint and preserves message id", async () => {
  let capturedMethod = "";
  let capturedUrl = "";
  await withMockFetch(
    (async (input, init) => {
      capturedUrl = String(input);
      capturedMethod = String(init?.method ?? "GET");
      return {
        ok: true,
        status: 200,
        json: async () => ({})
      } as Response;
    }) as typeof fetch,
    async () => {
      const result = await editDiscordChannelMessage({
        apiBaseUrl: "https://discord.com/api/v10",
        botToken: "discord-token",
        channelId: "12345",
        messageId: "777",
        text: "updated"
      });
      assert.deepEqual(result, {
        ok: true,
        messageId: "777",
        errorCode: null
      });
    }
  );

  assert.equal(capturedMethod, "PATCH");
  assert.match(capturedUrl, /\/channels\/12345\/messages\/777$/);
});

test("prepareDiscordMessageCreate returns accepted payloads with normalized runtime metadata", () => {
  const result = prepareDiscordMessageCreate({
    data: {
      id: "m1",
      channel_id: "c1",
      guild_id: "g1",
      content: "BigBrain build status",
      author: {
        id: "u1",
        username: "tester",
        global_name: "Avery Brooks",
        bot: false
      },
      member: {
        nick: "Avery"
      },
      timestamp: "2026-03-07T10:00:00.000Z"
    },
    botUserId: "bot-1",
    sharedSecret: "shared-secret",
    invocationPolicy: {
      requireNameCall: true,
      aliases: ["bigbrain"]
    },
    validateMessage: () => ({
      accepted: true,
      code: "ACCEPTED",
      message: "ok"
    }),
    abortControllers: new Map<string, AbortController>()
  });

  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") {
    return;
  }
  assert.equal(result.channelId, "c1");
  assert.equal(result.conversationVisibility, "public");
  assert.equal(result.inbound.text, "build status");
  assert.deepEqual(result.transportIdentity, {
    provider: "discord",
    username: "tester",
    displayName: "Avery",
    givenName: null,
    familyName: null,
    observedAt: "2026-03-07T10:00:00.000Z"
  });
  assert.deepEqual(result.entityGraphEvent, {
    provider: "discord",
    conversationId: "c1",
    eventId: "m1",
    text: "build status",
    observedAt: "2026-03-07T10:00:00.000Z"
  });
});

test("prepareDiscordMessageCreate accepts greeting-plus-alias invocations", () => {
  const result = prepareDiscordMessageCreate({
    data: {
      id: "m1b",
      channel_id: "c1",
      guild_id: "g1",
      content: "Hi BigBrain what can you help me with",
      author: {
        id: "u1",
        username: "tester",
        bot: false
      },
      timestamp: "2026-03-07T10:00:00.000Z"
    },
    botUserId: "bot-1",
    sharedSecret: "shared-secret",
    invocationPolicy: {
      requireNameCall: true,
      aliases: ["bigbrain"]
    },
    validateMessage: () => ({
      accepted: true,
      code: "ACCEPTED",
      message: "ok"
    }),
    abortControllers: new Map<string, AbortController>()
  });

  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") {
    return;
  }
  assert.equal(result.inbound.text, "Hi what can you help me with");
});

test("prepareDiscordMessageCreate surfaces transport-facing rejections and stop intents", () => {
  const rejected = prepareDiscordMessageCreate({
    data: {
      id: "m2",
      channel_id: "c2",
      content: "status",
      author: {
        id: "u2",
        username: "tester"
      }
    },
    botUserId: "",
    sharedSecret: "shared-secret",
    invocationPolicy: {
      requireNameCall: false,
      aliases: []
    },
    validateMessage: () => ({
      accepted: false,
      code: "RATE_LIMITED",
      message: "too fast"
    }),
    abortControllers: new Map<string, AbortController>()
  });
  assert.deepEqual(rejected, {
    kind: "rejected",
    channelId: "c2",
    responseText: "too fast"
  });

  const controllers = new Map<string, AbortController>();
  controllers.set("c3", new AbortController());
  const stopped = prepareDiscordMessageCreate({
    data: {
      id: "m3",
      channel_id: "c3",
      content: "/stop",
      author: {
        id: "u3",
        username: "tester"
      }
    },
    botUserId: "",
    sharedSecret: "shared-secret",
    invocationPolicy: {
      requireNameCall: false,
      aliases: []
    },
    validateMessage: () => ({
      accepted: true,
      code: "ACCEPTED",
      message: "ok"
    }),
    abortControllers: controllers
  });
  assert.deepEqual(stopped, {
    kind: "stop",
    channelId: "c3",
    responseText: "Autonomous loop cancelled."
  });
  assert.equal(controllers.has("c3"), false);
});

test("deliverPreparedTransportResponse skips null responses and sends present ones", async () => {
  const delivered: string[] = [];
  const skipped = await deliverPreparedTransportResponse(
    null,
    async (text: string) => {
      delivered.push(text);
      return { ok: true, messageId: "x", errorCode: null };
    },
    "DISCORD_SEND_FAILED"
  );
  assert.equal(skipped, false);

  const deliveredResult = await deliverPreparedTransportResponse(
    "hello",
    async (text: string) => {
      delivered.push(text);
      return { ok: true, messageId: "x", errorCode: null };
    },
    "DISCORD_SEND_FAILED"
  );
  assert.equal(deliveredResult, true);
  assert.deepEqual(delivered, ["hello"]);
});

test("handleAcceptedTransportConversation routes text execution and final reply delivery", async () => {
  const inbound: ConversationInboundMessage = {
    provider: "discord",
    conversationId: "channel-1",
    userId: "user-1",
    username: "tester",
    conversationVisibility: "public",
    text: "status",
    receivedAt: "2026-03-07T10:00:00.000Z"
  };
  const deliveries: string[] = [];
  const entityGraphWrites: Array<{ evidenceRef: string; domainHint: string | null | undefined }> = [];

  await handleAcceptedTransportConversation({
    inbound,
    entityGraphEvent: {
      provider: "discord",
      conversationId: "channel-1",
      eventId: "event-1",
      text: "status",
      observedAt: "2026-03-07T10:00:00.000Z"
    },
    notifier: {
      capabilities: { supportsEdit: false, supportsNativeStreaming: false },
      send: async () => ({ ok: true, messageId: "progress-1", errorCode: null })
    },
    conversationManager: {
      handleMessage: async (message, executeTask) => {
        assert.deepEqual(message, inbound);
        const result = await executeTask("status", inbound.receivedAt);
        assert.equal(result.summary, "normalized summary");
        return "final reply";
      }
    },
    entityGraphStore: {
      getGraph: async () => buildEmptyEntityGraph(),
      upsertFromExtractionInput: async (input) => {
        entityGraphWrites.push({
          evidenceRef: input.evidenceRef,
          domainHint: input.domainHint
        });
      }
    },
    dynamicPulseEnabled: true,
    abortControllers: new Map<string, AbortController>(),
    resolveEntityGraphDomainHint: async () => "workflow",
    runTextTask: async () => "normalized summary",
    runAutonomousTask: async () => ({ summary: "autonomous summary" }),
    deliverReply: async (reply: string) => {
      deliveries.push(reply);
      return { ok: true, messageId: "final-1", errorCode: null };
    },
    deliveryFailureCode: "DISCORD_SEND_FAILED"
  });

  assert.deepEqual(deliveries, ["final reply"]);
  assert.deepEqual(entityGraphWrites, [
    {
      evidenceRef: "interface:discord:channel-1:event-1",
      domainHint: "workflow"
    }
  ]);
});

test("handleAcceptedTransportConversation routes autonomous execution through progress sender", async () => {
  const progressMessages: string[] = [];
  const finalMessages: string[] = [];
  const abortControllers = new Map<string, AbortController>();

  await handleAcceptedTransportConversation({
    inbound: {
      provider: "telegram",
      conversationId: "chat-1",
      userId: "user-2",
      username: "tester",
      conversationVisibility: "private",
      text: "/auto check",
      receivedAt: "2026-03-07T10:05:00.000Z"
    },
    entityGraphEvent: {
      provider: "telegram",
      conversationId: "chat-1",
      eventId: "update-1",
      text: "/auto check",
      observedAt: "2026-03-07T10:05:00.000Z"
    },
    notifier: {
      capabilities: { supportsEdit: false, supportsNativeStreaming: false },
      send: async (message: string) => {
        progressMessages.push(message);
        return { ok: true, messageId: `m-${progressMessages.length}`, errorCode: null };
      },
      edit: async (_messageId: string, message: string) => {
        progressMessages.push(message);
        return { ok: true, messageId: "m-1", errorCode: null };
      }
    },
    conversationManager: {
      handleMessage: async (_message, executeTask) => {
        const result = await executeTask("[AUTONOMOUS_LOOP_GOAL] verify ui", "2026-03-07T10:05:01.000Z");
        assert.equal(result.summary, "autonomous summary");
        return "done";
      }
    },
    entityGraphStore: {
      getGraph: async () => buildEmptyEntityGraph(),
      upsertFromExtractionInput: async () => undefined
    },
    dynamicPulseEnabled: false,
    abortControllers,
    runTextTask: async () => "unused",
    runAutonomousTask: async (_goal, _receivedAt, progressSender) => {
      await progressSender("step 1");
      return { summary: "autonomous summary" };
    },
    deliverReply: async (reply: string) => {
      finalMessages.push(reply);
      return { ok: true, messageId: "final-2", errorCode: null };
    },
    deliveryFailureCode: "TELEGRAM_SEND_FAILED"
  });

  assert.deepEqual(progressMessages, ["step 1"]);
  assert.deepEqual(finalMessages, ["done"]);
  assert.equal(abortControllers.size, 0);
});

test("createTelegramConversationNotifier enables native draft streaming when requested", async () => {
  const deliveries: Array<{ kind: "send" | "edit" | "stream"; text: string; messageId?: string; draftId?: number }> = [];
  const notifier = createTelegramConversationNotifier({
    renderOutboundText: (text: string) => `wrapped:${text}`,
    nativeDraftStreamingEnabled: true,
    allocateDraftId: () => 42,
    allocateDeliverySequence: () => 1,
    sendReply: async (text: string) => {
      deliveries.push({ kind: "send", text });
      return { ok: true, messageId: "1", errorCode: null };
    },
    editReply: async (messageId: string, text: string) => {
      deliveries.push({ kind: "edit", messageId, text });
      return { ok: true, messageId, errorCode: null };
    },
    sendDraftUpdate: async (draftId: number, text: string) => {
      deliveries.push({ kind: "stream", draftId, text });
      return { ok: true, messageId: null, errorCode: null };
    }
  });

  assert.equal(notifier.capabilities.supportsEdit, false);
  assert.equal(notifier.capabilities.supportsNativeStreaming, true);
  assert.equal(notifier.edit, undefined);
  await notifier.stream?.("progress");

  assert.deepEqual(deliveries, [
    { kind: "stream", draftId: 42, text: "wrapped:progress" }
  ]);
});

test("sendTelegramDraftUpdate uses draft endpoint and numeric chat id when possible", async () => {
  let capturedUrl = "";
  let capturedBody: { chat_id?: number; draft_id?: number; text?: string } | null = null;
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
      const result = await sendTelegramDraftUpdate({
        apiBaseUrl: "https://api.telegram.org",
        botToken: "telegram-token",
        chatId: "12345",
        draftId: 1,
        text: "Still working..."
      });
      assert.deepEqual(result, {
        ok: true,
        messageId: null,
        errorCode: null
      });
    }
  );

  assert.match(capturedUrl, /\/bottelegram-token\/sendMessageDraft$/);
  if (capturedBody === null) {
    assert.fail("Expected Telegram draft request body to be captured.");
  }
  const body = capturedBody as { chat_id?: number; draft_id?: number; text?: string };
  assert.equal(body.chat_id, 12345);
  assert.equal(body.draft_id, 1);
  assert.equal(body.text, "Still working...");
});

test("sendTelegramGatewayReply applies invocation hints before transport delivery", async () => {
  let capturedBody = "";
  await withMockFetch(
    (async (_input, init) => {
      capturedBody = String(init?.body ?? "");
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            message_id: 22
          }
        })
      } as Response;
    }) as typeof fetch,
    async () => {
      const result = await sendTelegramGatewayReply(
        buildTelegramInterfaceConfigFixture({
          security: {
            ...buildTelegramInterfaceConfigFixture().security,
            allowedUsernames: [],
            rateLimitWindowMs: 1,
            maxEventsPerWindow: 1,
            replayCacheSize: 1,
            agentPulseTickIntervalMs: 1,
            ackDelayMs: 1,
            showTechnicalSummary: false,
            showSafetyCodes: false,
            allowAutonomousViaInterface: true,
            invocation: {
              requireNameCall: true,
              aliases: ["bigbrain"]
            }
          },
          pollTimeoutSeconds: 1,
          pollIntervalMs: 1
        }),
        "12345",
        "Use /status for more detail."
      );
      assert.deepEqual(result, {
        ok: true,
        messageId: "22",
        errorCode: null
      });
    }
  );

  assert.match(capturedBody, /bigbrain/);
  assert.match(capturedBody, /bigbrain \/status/);
});

test("sendTelegramReply splits long outbound text into multiple Telegram-safe sends", async () => {
  const requestBodies: Array<{ chat_id?: number | string; text?: string }> = [];
  const longText = `${"A".repeat(3990)}\n\n${"B".repeat(320)}`;

  await withMockFetch(
    (async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body ?? "{}")) as { chat_id?: number | string; text?: string }
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: {
            message_id: requestBodies.length
          }
        })
      } as Response;
    }) as typeof fetch,
    async () => {
      const result = await sendTelegramReply({
        apiBaseUrl: "https://api.telegram.org",
        botToken: "telegram-token",
        chatId: "12345",
        text: longText
      });
      assert.deepEqual(result, {
        ok: true,
        messageId: "2",
        errorCode: null
      });
    }
  );

  assert.equal(requestBodies.length, 2);
  assert.equal(requestBodies[0]?.chat_id, 12345);
  assert.equal(requestBodies[0]?.text?.length, 3992);
  assert.equal(requestBodies[1]?.text, "B".repeat(320));
});

test("editTelegramReply fails closed with provider detail when the text exceeds Telegram edit limits", async () => {
  const result = await editTelegramReply({
    apiBaseUrl: "https://api.telegram.org",
    botToken: "telegram-token",
    chatId: "12345",
    messageId: "77",
    text: "x".repeat(4001)
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "TELEGRAM_EDIT_TOO_LONG");
  assert.match(result.errorDetail ?? "", /4000 characters/i);
});

test("deliverPreparedTransportResponse includes transport detail when delivery fails", async () => {
  await assert.rejects(
    () =>
      deliverPreparedTransportResponse(
        "hello",
        async () => ({
          ok: false,
          messageId: null,
          errorCode: "TELEGRAM_SEND_HTTP_400",
          errorDetail: "Bad Request: message is too long"
        }),
        "TELEGRAM_SEND_FAILED"
      ),
    /TELEGRAM_SEND_HTTP_400: Bad Request: message is too long/
  );
});

test("sendObservedTelegramGatewayReply records direct-reply trace metadata", async () => {
  const observed: Array<{
    kind: string;
    sequence: number;
    source: string | null;
    sessionKey: string | null;
    inboundEventId: string | null;
    inboundReceivedAt: string | null;
    chatId: string;
    text: string;
    messageId: string | null;
  }> = [];

  await withMockFetch(
    (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: {
          message_id: 55
        }
      })
    })) as unknown as typeof fetch,
    async () => {
      const result = await sendObservedTelegramGatewayReply(
        buildTelegramInterfaceConfigFixture(),
        "12345",
        "Hi there",
        async (event) => {
          observed.push({
            kind: event.kind,
            sequence: event.sequence,
            source: event.source,
            sessionKey: event.sessionKey,
            inboundEventId: event.inboundEventId,
            inboundReceivedAt: event.inboundReceivedAt,
            chatId: event.chatId,
            text: event.text,
            messageId: event.messageId ?? null
          });
        },
        {
          sequence: 7,
          source: "direct_reply",
          sessionKey: "telegram:12345:user-1",
          inboundEventId: "update-77",
          inboundReceivedAt: "2026-03-20T20:10:00.000Z"
        }
      );
      assert.deepEqual(result, {
        ok: true,
        messageId: "55",
        errorCode: null
      });
    }
  );

  assert.deepEqual(observed, [
    {
      kind: "send",
      sequence: 7,
      source: "direct_reply",
      sessionKey: "telegram:12345:user-1",
      inboundEventId: "update-77",
      inboundReceivedAt: "2026-03-20T20:10:00.000Z",
      chatId: "12345",
      text: "Hi there",
      messageId: "55"
    }
  ]);
});

test("prepareTelegramUpdate returns accepted payloads with normalized runtime metadata", () => {
  const result = prepareTelegramUpdate({
    update: {
      update_id: 44,
      message: {
        text: "BigBrain status",
        chat: {
          id: 100,
          type: "private"
        },
        from: {
          id: 200,
          username: "tester",
          first_name: "Avery",
          last_name: "Bena"
        },
        date: 1_700_000_000
      }
    },
    sharedSecret: "shared-secret",
    invocationPolicy: {
      requireNameCall: true,
      aliases: ["bigbrain"]
    },
    validateMessage: () => ({
      accepted: true,
      code: "ACCEPTED",
      message: "ok"
    }),
    abortControllers: new Map<string, AbortController>()
  });

  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") {
    return;
  }
  assert.equal(result.chatId, "100");
  assert.equal(result.userId, "200");
  assert.equal(result.conversationVisibility, "private");
  assert.equal(result.inbound.text, "status");
  assert.deepEqual(result.transportIdentity, {
    provider: "telegram",
    username: "tester",
    displayName: "Avery Bena",
    givenName: "Avery",
    familyName: "Bena",
    observedAt: "2023-11-14T22:13:20.000Z"
  });
  assert.equal(result.entityGraphEvent.eventId, "44");
});

test("prepareTelegramUpdate accepts greeting-plus-alias invocations", () => {
  const result = prepareTelegramUpdate({
    update: {
      update_id: 46,
      message: {
        text: "Hi BigBrain",
        chat: {
          id: 100,
          type: "private"
        },
        from: {
          id: 200,
          username: "tester",
          first_name: "Avery",
          last_name: "Bena"
        },
        date: 1_700_000_000
      }
    },
    sharedSecret: "shared-secret",
    invocationPolicy: {
      requireNameCall: true,
      aliases: ["bigbrain"]
    },
    validateMessage: () => ({
      accepted: true,
      code: "ACCEPTED",
      message: "ok"
    }),
    abortControllers: new Map<string, AbortController>()
  });

  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") {
    return;
  }
  assert.equal(result.inbound.text, "Hi");
  assert.deepEqual(result.transportIdentity, {
    provider: "telegram",
    username: "tester",
    displayName: "Avery Bena",
    givenName: "Avery",
    familyName: "Bena",
    observedAt: "2023-11-14T22:13:20.000Z"
  });
});

test("prepareTelegramUpdate accepts private plain-text messages without alias in one-to-one chats", () => {
  const result = prepareTelegramUpdate({
    update: {
      update_id: 46_1,
      message: {
        text: "what can you help me with",
        chat: {
          id: 100,
          type: "private"
        },
        from: {
          id: 200,
          username: "tester",
          first_name: "Avery",
          last_name: "Bena"
        },
        date: 1_700_000_000
      }
    },
    sharedSecret: "shared-secret",
    invocationPolicy: {
      requireNameCall: true,
      aliases: ["bigbrain"]
    },
    validateMessage: () => ({
      accepted: true,
      code: "ACCEPTED",
      message: "ok"
    }),
    abortControllers: new Map<string, AbortController>()
  });

  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") {
    return;
  }
  assert.equal(result.inbound.text, "what can you help me with");
});

test("prepareTelegramUpdate still requires alias in group chats", () => {
  const result = prepareTelegramUpdate({
    update: {
      update_id: 46_2,
      message: {
        text: "what can you help me with",
        chat: {
          id: 100,
          type: "group"
        },
        from: {
          id: 200,
          username: "tester",
          first_name: "Avery",
          last_name: "Bena"
        },
        date: 1_700_000_000
      }
    },
    sharedSecret: "shared-secret",
    invocationPolicy: {
      requireNameCall: true,
      aliases: ["bigbrain"]
    },
    validateMessage: () => ({
      accepted: true,
      code: "ACCEPTED",
      message: "ok"
    }),
    abortControllers: new Map<string, AbortController>()
  });

  assert.deepEqual(result, { kind: "ignored" });
});



test("prepareTelegramUpdate accepts private media-only messages and defers canonical text assembly", () => {
  const result = prepareTelegramUpdate({
    update: {
      update_id: 47,
      message: {
        chat: {
          id: 100,
          type: "private"
        },
        from: {
          id: 200,
          username: "tester"
        },
        caption: "",
        photo: [
          {
            file_id: "photo-1",
            file_unique_id: "photo-uniq-1",
            width: 1280,
            height: 720,
            file_size: 4096
          }
        ],
        date: 1_700_000_000
      }
    },
    sharedSecret: "shared-secret",
    invocationPolicy: {
      requireNameCall: true,
      aliases: ["bigbrain"]
    },
    mediaConfig: {
      enabled: true,
      maxAttachments: 4,
      maxAttachmentBytes: 12000000,
      maxDownloadBytes: 20000000,
      maxVoiceSeconds: 180,
      maxVideoSeconds: 90,
      allowImages: true,
      allowVoiceNotes: true,
      allowVideos: true,
      allowDocuments: false
    },
    validateMessage: () => ({
      accepted: true,
      code: "ACCEPTED",
      message: "ok"
    }),
    abortControllers: new Map<string, AbortController>()
  });

  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") {
    return;
  }
  assert.equal(result.inbound.text, "");
  assert.equal(result.inbound.media?.attachments.length, 1);
  assert.equal(result.inbound.media?.attachments[0]?.kind, "image");
  assert.equal(result.entityGraphEvent.text, "Please review the attached image and respond based on what it shows.");
});

test("enrichAcceptedTelegramUpdateWithMedia rejects media-only untranscribed voice notes", async () => {
  const prepared = prepareTelegramUpdate({
    update: {
      update_id: 48,
      message: {
        chat: {
          id: 100,
          type: "private"
        },
        from: {
          id: 200,
          username: "tester"
        },
        voice: {
          file_id: "voice-1",
          file_unique_id: "voice-uniq-1",
          duration: 4,
          mime_type: "audio/ogg",
          file_size: 2048
        },
        date: 1_700_000_000
      }
    },
    sharedSecret: "shared-secret",
    invocationPolicy: {
      requireNameCall: true,
      aliases: ["bigbrain"]
    },
    mediaConfig: {
      enabled: true,
      maxAttachments: 4,
      maxAttachmentBytes: 12000000,
      maxDownloadBytes: 20000000,
      maxVoiceSeconds: 180,
      maxVideoSeconds: 90,
      allowImages: true,
      allowVoiceNotes: true,
      allowVideos: true,
      allowDocuments: false
    },
    validateMessage: () => ({
      accepted: true,
      code: "ACCEPTED",
      message: "ok"
    }),
    abortControllers: new Map<string, AbortController>()
  });

  assert.equal(prepared.kind, "accepted");
  if (prepared.kind !== "accepted") {
    return;
  }

  const enriched = await enrichAcceptedTelegramUpdateWithMedia({
    prepared: {
      ...prepared,
      inbound: {
        ...prepared.inbound,
        media: {
          attachments: [
            {
              ...prepared.inbound.media!.attachments[0]!,
              interpretation: {
                summary: "The user attached a voice note, but transcription is unavailable in this environment.",
                transcript: null,
                ocrText: null,
                confidence: 0.10,
                provenance: "metadata fallback",
                source: "metadata_fallback",
                entityHints: []
              }
            }
          ]
        }
      }
    },
    config: buildTelegramInterfaceConfigFixture()
  });

  assert.deepEqual(enriched, {
    kind: "rejected",
    chatId: "100",
    responseText:
      "I received your voice note, but I couldn't transcribe it in this environment. Please resend it as text or try again where voice transcription is available."
  });
});

test("enrichAcceptedTelegramUpdateWithMedia preserves raw routing text while enriching canonical entity input", async () => {
  const prepared = prepareTelegramUpdate({
    update: {
      update_id: 49,
      message: {
        chat: {
          id: 100,
          type: "private"
        },
        from: {
          id: 200,
          username: "tester"
        },
        caption: "Please review the attached PDF and list the business names.",
        document: {
          file_id: "doc-1",
          file_unique_id: "doc-uniq-1",
          file_name: "filing.pdf",
          mime_type: "application/pdf",
          file_size: 4096
        },
        date: 1_700_000_000
      }
    },
    sharedSecret: "shared-secret",
    invocationPolicy: {
      requireNameCall: true,
      aliases: ["bigbrain"]
    },
    mediaConfig: {
      enabled: true,
      maxAttachments: 4,
      maxAttachmentBytes: 12000000,
      maxDownloadBytes: 20000000,
      maxVoiceSeconds: 180,
      maxVideoSeconds: 90,
      allowImages: true,
      allowVoiceNotes: true,
      allowVideos: true,
      allowDocuments: true
    },
    validateMessage: () => ({
      accepted: true,
      code: "ACCEPTED",
      message: "ok"
    }),
    abortControllers: new Map<string, AbortController>()
  });

  assert.equal(prepared.kind, "accepted");
  if (prepared.kind !== "accepted") {
    return;
  }

  const enriched = await enrichAcceptedTelegramUpdateWithMedia({
    prepared: {
      ...prepared,
      inbound: {
        ...prepared.inbound,
        media: {
          attachments: [
            {
              ...prepared.inbound.media!.attachments[0]!,
              interpretation: {
                summary: "business filing.",
                transcript: null,
                ocrText:
                  "Signed before a notary public in Wayne County. Present entity ACME SAMPLE DESIGN, LLC.",
                confidence: 0.92,
                provenance: "document extraction",
                source: "fixture_catalog",
                entityHints: ["ACME SAMPLE DESIGN, LLC", "Wayne County"]
              }
            }
          ]
        }
      },
      entityGraphEvent: {
        ...prepared.entityGraphEvent,
        text: prepared.inbound.text
      }
    },
    config: buildTelegramInterfaceConfigFixture()
  });

  assert.equal(enriched.kind, "accepted");
  if (enriched.kind !== "accepted") {
    return;
  }
  assert.equal(
    enriched.inbound.text,
    "Please review the attached PDF and list the business names."
  );
  assert.equal(
    enriched.inbound.commandRoutingText,
    "Please review the attached PDF and list the business names."
  );
  assert.match(enriched.entityGraphEvent.text, /Attached media context:/);
  assert.match(enriched.entityGraphEvent.text, /notary public/i);
  assert.match(enriched.entityGraphEvent.text, /ACME SAMPLE DESIGN, LLC/);
});

test("prepareTelegramUpdate surfaces transport-facing rejections and wrapped draft ids", () => {
  const rejected = prepareTelegramUpdate({
    update: {
      update_id: 45,
      message: {
        text: "status",
        chat: {
          id: 100
        },
        from: {
          id: 200,
          username: "tester"
        }
      }
    },
    sharedSecret: "shared-secret",
    invocationPolicy: {
      requireNameCall: false,
      aliases: []
    },
    validateMessage: () => ({
      accepted: false,
      code: "RATE_LIMITED",
      message: "too fast"
    }),
    abortControllers: new Map<string, AbortController>()
  });
  assert.deepEqual(rejected, {
    kind: "rejected",
    chatId: "100",
    responseText: "too fast"
  });

  assert.deepEqual(allocateNextTelegramDraftId(2_147_483_647), {
    draftId: 2_147_483_647,
    nextDraftId: 1
  });
});

test("isAutonomousStopIntent accepts explicit stop commands and rejects ordinary text", () => {
  assert.equal(isAutonomousStopIntent("/stop"), true);
  assert.equal(isAutonomousStopIntent("stop now"), true);
  assert.equal(isAutonomousStopIntent("/cancel"), true);
  assert.equal(isAutonomousStopIntent("please continue"), false);
});

test("abortAutonomousTransportTaskIfRequested aborts and clears matching controllers only for stop intent", () => {
  const controllers = new Map<string, AbortController>();
  const active = new AbortController();
  controllers.set("discord:123", active);

  assert.equal(
    abortAutonomousTransportTaskIfRequested("discord:123", "please continue", controllers),
    false
  );
  assert.equal(active.signal.aborted, false);
  assert.equal(controllers.has("discord:123"), true);

  assert.equal(
    abortAutonomousTransportTaskIfRequested("discord:123", "/stop", controllers),
    true
  );
  assert.equal(active.signal.aborted, true);
  assert.equal(controllers.has("discord:123"), false);
});

test("shouldNotifyRejectedInvocation only returns true for shared transport-facing rejection codes", () => {
  assert.equal(shouldNotifyRejectedInvocation("RATE_LIMITED"), true);
  assert.equal(shouldNotifyRejectedInvocation("EMPTY_MESSAGE"), true);
  assert.equal(shouldNotifyRejectedInvocation("BAD_SECRET"), false);
});

test("resolveDiscordGatewaySocketUrl appends version and encoding parameters", async () => {
  await withMockFetch(
    (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ url: "wss://gateway.discord.gg/" })
    })) as unknown as typeof fetch,
    async () => {
      const url = await resolveDiscordGatewaySocketUrl({
        gatewayUrl: "https://discord.com/api/v10/gateway/bot",
        botToken: "discord-token"
      });
      assert.match(url, /^wss:\/\/gateway\.discord\.gg\/\?v=10&encoding=json$/);
    }
  );
});

test("buildDiscordIdentifyPayload renders the canonical identify envelope", () => {
  assert.deepEqual(buildDiscordIdentifyPayload("discord-token", 37377), {
    op: 2,
    d: {
      token: "discord-token",
      intents: 37377,
      properties: {
        $os: "windows",
        $browser: "agentbigbrain",
        $device: "agentbigbrain"
      }
    }
  });
});

test("sendDiscordGatewayPayload only sends on open sockets", () => {
  const sent: string[] = [];
  const socket = {
    readyState: 1,
    send: (data: string) => {
      sent.push(data);
    },
    close: () => undefined,
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null
  };

  sendDiscordGatewayPayload(socket, { op: 1, d: 7 });
  sendDiscordGatewayPayload({ ...socket, readyState: 0 }, { op: 2 });

  assert.deepEqual(sent, [JSON.stringify({ op: 1, d: 7 })]);
});

test("attachDiscordSocketLifecycle wires open message error and close callbacks deterministically", async () => {
  const events: string[] = [];
  const socket: TestGatewaySocket = {
    readyState: 1,
    send: () => undefined,
    close: () => undefined,
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null
  };

  attachDiscordSocketLifecycle({
    socket,
    onOpen: () => {
      events.push("open");
    },
    onMessage: async (rawData) => {
      events.push(`message:${rawData}`);
      throw new Error("message boom");
    },
    onMessageError: (error) => {
      events.push(`message_error:${error.message}`);
    },
    onError: (error) => {
      events.push(`error:${String(error)}`);
    },
    onClose: () => {
      events.push("close");
    }
  });

  socket.onopen?.();
  await socket.onmessage?.({ data: "payload-1" });
  await new Promise((resolve) => setImmediate(resolve));
  socket.onerror?.("socket boom");
  socket.onclose?.();

  assert.deepEqual(events, [
    "open",
    "message:payload-1",
    "message_error:message boom",
    "error:socket boom",
    "close"
  ]);
});

test("handleDiscordHelloLifecycle resets heartbeat and sends the identify payload", () => {
  const sentPayloads: Array<Record<string, unknown>> = [];
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const clearedTimers: unknown[] = [];
  const fakeTimer = { label: "timer" } as unknown as NodeJS.Timeout;

  globalThis.setInterval = ((callback: TimerHandler) => {
    void callback;
    return fakeTimer;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((timer: unknown) => {
    clearedTimers.push(timer);
  }) as unknown as typeof clearInterval;

  try {
    const socket: TestGatewaySocket = {
      readyState: 1,
      send: (data: string) => {
        sentPayloads.push(JSON.parse(data) as Record<string, unknown>);
      },
      close: () => undefined,
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null
    };

    const timer = handleDiscordHelloLifecycle({
      data: { heartbeat_interval: 1000 },
      existingHeartbeatTimer: "old-timer" as unknown as NodeJS.Timeout,
      sequenceProvider: () => 9,
      socket,
      botToken: "discord-token",
      intents: 37377
    });

    assert.equal(timer, fakeTimer);
    assert.deepEqual(clearedTimers, ["old-timer"]);
    assert.deepEqual(sentPayloads, [
      { op: 1, d: 9 },
      buildDiscordIdentifyPayload("discord-token", 37377)
    ]);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("handleDiscordGatewaySocketMessage routes sequence, hello, and dispatch payloads", async () => {
  const sequences: number[] = [];
  const helloPayloads: Array<{ heartbeat_interval?: number } | undefined> = [];
  const dispatches: Array<{ eventType: string; data: unknown }> = [];

  await handleDiscordGatewaySocketMessage({
    rawData: JSON.stringify({
      op: 10,
      s: 42,
      d: { heartbeat_interval: 1000 }
    }),
    onSequence: (sequence) => sequences.push(sequence),
    onHello: async (data) => {
      helloPayloads.push(data);
    },
    onDispatch: async (eventType, data) => {
      dispatches.push({ eventType, data });
    }
  });

  await handleDiscordGatewaySocketMessage({
    rawData: JSON.stringify({
      op: 0,
      s: 43,
      t: "MESSAGE_CREATE",
      d: { id: "abc" }
    }),
    onSequence: (sequence) => sequences.push(sequence),
    onHello: async () => undefined,
    onDispatch: async (eventType, data) => {
      dispatches.push({ eventType, data });
    }
  });

  assert.deepEqual(sequences, [42, 43]);
  assert.deepEqual(helloPayloads, [{ heartbeat_interval: 1000 }]);
  assert.deepEqual(dispatches, [
    { eventType: "MESSAGE_CREATE", data: { id: "abc" } }
  ]);
});

test("routeDiscordDispatchEvent routes READY and MESSAGE_CREATE callbacks only", async () => {
  const seen: string[] = [];

  await routeDiscordDispatchEvent({
    eventType: "READY",
    data: { user: { id: "bot-user" } },
    onReady: async (ready) => {
      seen.push(`ready:${ready.user?.id ?? ""}`);
    },
    onMessageCreate: async () => {
      seen.push("message");
    }
  });

  await routeDiscordDispatchEvent({
    eventType: "MESSAGE_CREATE",
    data: { id: "message-1" },
    onReady: async () => {
      seen.push("unexpected-ready");
    },
    onMessageCreate: async (message) => {
      seen.push(`message:${(message as { id?: string }).id ?? ""}`);
    }
  });

  await routeDiscordDispatchEvent({
    eventType: "GUILD_CREATE",
    data: {},
    onReady: async () => {
      seen.push("unexpected-ready-2");
    },
    onMessageCreate: async () => {
      seen.push("unexpected-message-2");
    }
  });

  assert.deepEqual(seen, ["ready:bot-user", "message:message-1"]);
});

test("reconnectWithBackoffLoop retries while running and stops after a successful reconnect", async () => {
  const sleeps: number[] = [];
  const events: string[] = [];
  let attempts = 0;

  await reconnectWithBackoffLoop({
    delayMs: 2000,
    isRunning: () => true,
    reconnect: async () => {
      attempts += 1;
      events.push(`attempt:${attempts}`);
      if (attempts === 1) {
        throw new Error("first failure");
      }
    },
    onReconnectError: (error) => {
      events.push(`error:${error.message}`);
    },
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    }
  });

  assert.deepEqual(sleeps, [2000, 2000]);
  assert.deepEqual(events, ["attempt:1", "error:first failure", "attempt:2"]);
});

test("reconnectWithBackoffLoop stops cleanly when the owner is no longer running", async () => {
  const sleeps: number[] = [];
  let reconnectCalls = 0;

  await reconnectWithBackoffLoop({
    delayMs: 1500,
    isRunning: () => false,
    reconnect: async () => {
      reconnectCalls += 1;
    },
    onReconnectError: () => undefined,
    sleepImpl: async (ms) => {
      sleeps.push(ms);
    }
  });

  assert.deepEqual(sleeps, [1500]);
  assert.equal(reconnectCalls, 0);
});

test("startDiscordHeartbeat sends one immediate heartbeat before returning timer handle", () => {
  const payloads: Record<string, unknown>[] = [];
  const timer = startDiscordHeartbeat(60_000, () => 7, (payload) => {
    payloads.push(payload);
  });

  clearInterval(timer);
  assert.deepEqual(payloads, [{ op: 1, d: 7 }]);
});

test("createAutonomousProgressSender edits the first sent progress message when edit is available", async () => {
  const deliveries: Array<{ kind: "send" | "edit"; message: string; messageId?: string }> = [];
  const progressSender = createAutonomousProgressSender({
    capabilities: {
      supportsEdit: false,
      supportsNativeStreaming: false
    },
    send: async (message: string) => {
      deliveries.push({ kind: "send", message });
      return { ok: true, messageId: "msg-1", errorCode: null };
    },
    edit: async (messageId: string, message: string) => {
      deliveries.push({ kind: "edit", messageId, message });
      return { ok: true, messageId, errorCode: null };
    }
  });

  await progressSender("first");
  await progressSender("second");

  assert.deepEqual(deliveries, [
    { kind: "send", message: "first" },
    { kind: "edit", messageId: "msg-1", message: "second" }
  ]);
});

test("createAutonomousProgressSender prefers native streaming when supported", async () => {
  const streamed: string[] = [];
  const progressSender = createAutonomousProgressSender({
    capabilities: {
      supportsEdit: false,
      supportsNativeStreaming: true
    },
    send: async () => {
      throw new Error("send should not be used");
    },
    stream: async (message: string) => {
      streamed.push(message);
      return { ok: true, messageId: null, errorCode: null };
    }
  });

  await progressSender("chunk one");
  await progressSender("chunk two");

  assert.deepEqual(streamed, ["chunk one", "chunk two"]);
});

test("runAutonomousTransportTask wires abort-controller lifecycle and removes the controller after completion", async () => {
  const abortControllers = new Map<string, AbortController>();
  const progressMessages: string[] = [];
  const progressUpdates: Array<{ status: string; message: string }> = [];

  const result = await runAutonomousTransportTask({
    conversationId: "discord:123:user",
    goal: "verify app",
    receivedAt: "2026-03-07T12:00:00.000Z",
    notifier: {
      capabilities: {
        supportsEdit: false,
        supportsNativeStreaming: false
      },
      send: async (message: string) => {
        progressMessages.push(message);
        return { ok: true, messageId: "progress-1", errorCode: null };
      },
      edit: async (messageId: string, message: string) => {
        progressMessages.push(`${messageId}:${message}`);
        return { ok: true, messageId, errorCode: null };
      }
    },
    abortControllers,
    runAutonomousTask: async (goal, receivedAt, progressSender, signal, _initialExecutionInput, onProgressUpdate) => {
      assert.equal(goal, "verify app");
      assert.equal(receivedAt, "2026-03-07T12:00:00.000Z");
      assert.equal(signal.aborted, false);
      assert.equal(abortControllers.has("discord:123:user"), true);
      await onProgressUpdate?.({
        status: "retrying",
        message: "Retrying with exact tracked holders."
      });
      await progressSender("progress one");
      await progressSender("progress two");
      return { summary: "done" };
    },
    onProgressUpdate: async (update) => {
      progressUpdates.push(update);
    }
  });

  assert.equal(result.summary, "done");
  assert.equal(abortControllers.has("discord:123:user"), false);
  assert.deepEqual(progressMessages, [
    "progress one",
    "progress-1:progress two"
  ]);
  assert.deepEqual(progressUpdates, [
    {
      status: "retrying",
      message: "Retrying with exact tracked holders."
    }
  ]);
});

test("runAutonomousTransportTask suppresses transport progress chatter when an editable worker status panel owns progress delivery", async () => {
  const abortControllers = new Map<string, AbortController>();
  const deliveries: Array<{ kind: "send" | "edit"; message: string }> = [];
  const progressUpdates: Array<{ status: string; message: string }> = [];

  const result = await runAutonomousTransportTask({
    conversationId: "telegram:chat-1:user-1",
    goal: "verify app",
    receivedAt: "2026-03-07T12:00:00.000Z",
    notifier: {
      capabilities: {
        supportsEdit: true,
        supportsNativeStreaming: false
      },
      send: async (message: string) => {
        deliveries.push({ kind: "send", message });
        return { ok: true, messageId: "progress-1", errorCode: null };
      },
      edit: async (_messageId: string, message: string) => {
        deliveries.push({ kind: "edit", message });
        return { ok: true, messageId: "progress-1", errorCode: null };
      }
    },
    abortControllers,
    runAutonomousTask: async (_goal, _receivedAt, progressSender, signal, _initialExecutionInput, onProgressUpdate) => {
      assert.equal(signal.aborted, false);
      await onProgressUpdate?.({
        status: "working",
        message: "Still wiring the preview."
      });
      await progressSender("step one");
      await progressSender("step two");
      return { summary: "done" };
    },
    onProgressUpdate: async (update) => {
      progressUpdates.push(update);
    }
  });

  assert.equal(result.summary, "done");
  assert.equal(abortControllers.size, 0);
  assert.deepEqual(deliveries, []);
  assert.deepEqual(progressUpdates, [
    {
      status: "working",
      message: "Still wiring the preview."
    }
  ]);
});

test("pollTelegramUpdatesOnce returns the next offset and processes each update", async () => {
  const processedUpdates: Array<{ update_id?: number; payload?: string }> = [];

  await withMockFetch(
    (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        result: [
          { update_id: 10, payload: "first" },
          { update_id: 12, payload: "second" }
        ]
      })
    })) as unknown as typeof fetch,
    async () => {
      const nextOffset = await pollTelegramUpdatesOnce({
        apiBaseUrl: "https://api.telegram.org",
        botToken: "telegram-token",
        pollTimeoutSeconds: 25,
        nextOffset: 5,
        processUpdate: async (update: { update_id?: number; payload?: string }) => {
          processedUpdates.push(update);
        }
      });

      assert.equal(nextOffset, 13);
    }
  );

  assert.deepEqual(processedUpdates, [
    { update_id: 10, payload: "first" },
    { update_id: 12, payload: "second" }
  ]);
});

test("runTelegramPollingLoop keeps polling until running stops and preserves error handling", async () => {
  const events: string[] = [];
  let running = true;
  let polls = 0;

  await runTelegramPollingLoop({
    isRunning: () => running,
    pollOnce: async () => {
      polls += 1;
      events.push(`poll:${polls}`);
      if (polls === 1) {
        throw new Error("poll failed");
      }
      running = false;
    },
    pollIntervalMs: 500,
    onPollError: (error) => {
      events.push(`error:${error.message}`);
    },
    sleepImpl: async (ms) => {
      events.push(`sleep:${ms}`);
    }
  });

  assert.deepEqual(events, ["poll:1", "error:poll failed", "sleep:500", "poll:2"]);
});

