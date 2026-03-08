/**
 * @fileoverview Verifies canonical Discord and Telegram transport-runtime delivery helpers.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

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
  sendTelegramDraftUpdate
} from "../../src/interfaces/transportRuntime/telegramTransport";
import {
  allocateNextTelegramDraftId,
  prepareTelegramUpdate,
  sendTelegramGatewayReply
} from "../../src/interfaces/transportRuntime/telegramGatewayRuntime";
import type { ConversationInboundMessage } from "../../src/interfaces/conversationRuntime/managerContracts";

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
  assert.equal(result.channelId, "c1");
  assert.equal(result.conversationVisibility, "public");
  assert.equal(result.inbound.text, "build status");
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
  const entityGraphWrites: string[] = [];

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
      getGraph: async () => ({ version: "v1", entities: [], links: [] }),
      upsertFromExtractionInput: async (input) => {
        entityGraphWrites.push(input.evidenceRef);
      }
    },
    dynamicPulseEnabled: true,
    abortControllers: new Map<string, AbortController>(),
    runTextTask: async () => "normalized summary",
    runAutonomousTask: async () => "autonomous summary",
    deliverReply: async (reply: string) => {
      deliveries.push(reply);
      return { ok: true, messageId: "final-1", errorCode: null };
    },
    deliveryFailureCode: "DISCORD_SEND_FAILED"
  });

  assert.deepEqual(deliveries, ["final reply"]);
  assert.deepEqual(entityGraphWrites, ["interface:discord:channel-1:event-1"]);
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
      getGraph: async () => ({ version: "v1", entities: [], links: [] }),
      upsertFromExtractionInput: async () => undefined
    },
    dynamicPulseEnabled: false,
    abortControllers,
    runTextTask: async () => "unused",
    runAutonomousTask: async (_goal, _receivedAt, progressSender) => {
      await progressSender("step 1");
      return "autonomous summary";
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
  assert.equal(capturedBody?.chat_id, 12345);
  assert.equal(capturedBody?.draft_id, 1);
  assert.equal(capturedBody?.text, "Still working...");
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
        {
          provider: "telegram",
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
          botToken: "telegram-token",
          apiBaseUrl: "https://api.telegram.org",
          pollTimeoutSeconds: 1,
          pollIntervalMs: 1,
          streamingTransportMode: "edit",
          nativeDraftStreaming: false,
          allowedChatIds: []
        },
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
          username: "tester"
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
          username: "tester"
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
    })) as typeof fetch,
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
  const socket = {
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
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: unknown) => {
    clearedTimers.push(timer);
  }) as typeof clearInterval;

  try {
    const socket = {
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

  const summary = await runAutonomousTransportTask({
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
    runAutonomousTask: async (goal, receivedAt, progressSender, signal) => {
      assert.equal(goal, "verify app");
      assert.equal(receivedAt, "2026-03-07T12:00:00.000Z");
      assert.equal(signal.aborted, false);
      assert.equal(abortControllers.has("discord:123:user"), true);
      await progressSender("progress one");
      await progressSender("progress two");
      return "done";
    }
  });

  assert.equal(summary, "done");
  assert.equal(abortControllers.has("discord:123:user"), false);
  assert.deepEqual(progressMessages, [
    "progress one",
    "progress-1:progress two"
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
    })) as typeof fetch,
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
