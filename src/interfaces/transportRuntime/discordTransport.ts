/**
 * @fileoverview Canonical Discord outbound transport helpers for gateway delivery and notifier wiring.
 */

import type {
  ConversationDeliveryResult,
  ConversationNotifierTransport
} from "../conversationRuntime/managerContracts";
import { buildDiscordApiUrl } from "../discordApiUrl";
import { parseDiscordRetryAfterMs } from "../discordRateLimit";
import type {
  DiscordChannelMessageInput,
  DiscordMessageEditInput,
  DiscordNotifierFactoryInput
} from "./contracts";

/**
 * Pauses execution for a bounded interval used by retry/backoff flows.
 *
 * @param ms - Duration value in milliseconds.
 * @returns Promise resolving after the delay.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds a Discord conversation notifier that applies final outbound text rendering consistently.
 *
 * @param input - Render and delivery callbacks bound to one Discord channel.
 * @returns Conversation notifier transport for Discord delivery.
 */
export function createDiscordConversationNotifier(
  input: DiscordNotifierFactoryInput
): ConversationNotifierTransport {
  return {
    capabilities: {
      supportsEdit: false,
      supportsNativeStreaming: false
    },
    send: async (messageText: string) =>
      input.sendMessage(input.renderOutboundText(messageText)),
    edit: async (messageId: string, messageText: string) =>
      input.editMessage(messageId, input.renderOutboundText(messageText))
  };
}

/**
 * Sends one outbound Discord channel message with deterministic retry handling for rate limits.
 *
 * @param input - Discord REST delivery context.
 * @returns Delivery result describing the outbound send attempt.
 */
export async function sendDiscordChannelMessage(
  input: DiscordChannelMessageInput
): Promise<ConversationDeliveryResult> {
  const url = buildDiscordApiUrl(input.apiBaseUrl, `/channels/${input.channelId}/messages`);
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleepImpl = input.sleepImpl ?? sleep;
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await fetchImpl(url.toString(), {
        method: "POST",
        headers: {
          Authorization: `Bot ${input.botToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          content: input.text
        })
      });

      if (response.ok) {
        input.logDebug?.(
          `Sent message to channel=${input.channelId} textLength=${input.text.length}.`
        );
        const payload = (await response.json().catch(() => null)) as
          | { id?: string | number }
          | null;
        const messageIdRaw = payload?.id;
        const messageId =
          typeof messageIdRaw === "string" || typeof messageIdRaw === "number"
            ? String(messageIdRaw)
            : null;
        return {
          ok: true,
          messageId,
          errorCode: null
        };
      }

      if (response.status === 429 && attempt === 1) {
        const payload = (await response.json().catch(() => null)) as unknown;
        const retryAfterMs = parseDiscordRetryAfterMs(payload);
        input.logDebug?.(
          `Discord rate-limited outbound send for channel=${input.channelId}; retrying in ${retryAfterMs}ms.`
        );
        await sleepImpl(retryAfterMs);
        continue;
      }

      const responseText = await response.text().catch(() => "");
      return {
        ok: false,
        messageId: null,
        errorCode:
          response.status === 429
            ? "DISCORD_RATE_LIMITED"
            : `DISCORD_SEND_HTTP_${response.status}${responseText ? "_WITH_BODY" : ""}`
      };
    }
  } catch {
    return {
      ok: false,
      messageId: null,
      errorCode: "DISCORD_SEND_FAILED"
    };
  }

  return {
    ok: false,
    messageId: null,
    errorCode: "DISCORD_SEND_FAILED"
  };
}

/**
 * Edits one outbound Discord channel message with deterministic retry handling for rate limits.
 *
 * @param input - Discord REST edit context.
 * @returns Delivery result describing the outbound edit attempt.
 */
export async function editDiscordChannelMessage(
  input: DiscordMessageEditInput
): Promise<ConversationDeliveryResult> {
  const url = buildDiscordApiUrl(
    input.apiBaseUrl,
    `/channels/${input.channelId}/messages/${input.messageId}`
  );
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleepImpl = input.sleepImpl ?? sleep;
  try {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const response = await fetchImpl(url.toString(), {
        method: "PATCH",
        headers: {
          Authorization: `Bot ${input.botToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          content: input.text
        })
      });

      if (response.ok) {
        return {
          ok: true,
          messageId: input.messageId,
          errorCode: null
        };
      }

      if (response.status === 429 && attempt === 1) {
        const payload = (await response.json().catch(() => null)) as unknown;
        const retryAfterMs = parseDiscordRetryAfterMs(payload);
        await sleepImpl(retryAfterMs);
        continue;
      }

      return {
        ok: false,
        messageId: null,
        errorCode:
          response.status === 429
            ? "DISCORD_RATE_LIMITED"
            : `DISCORD_EDIT_HTTP_${response.status}`
      };
    }
  } catch {
    return {
      ok: false,
      messageId: null,
      errorCode: "DISCORD_EDIT_FAILED"
    };
  }

  return {
    ok: false,
    messageId: null,
    errorCode: "DISCORD_EDIT_FAILED"
  };
}
