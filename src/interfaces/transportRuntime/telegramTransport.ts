/**
 * @fileoverview Canonical Telegram outbound transport helpers for gateway delivery and notifier wiring.
 */

import type {
  ConversationDeliveryResult,
  ConversationNotifierTransport
} from "../conversationRuntime/managerContracts";
import type {
  TelegramDraftUpdateInput,
  TelegramEditReplyInput,
  TelegramNotifierFactoryInput,
  TelegramSendReplyInput
} from "./contracts";

/**
 * Converts a normalized chat identifier into Telegram API-compatible chat-id payload.
 *
 * @param chatId - Normalized chat identifier from inbound update processing.
 * @returns Numeric chat ID when safely parseable, otherwise the original string.
 */
function toTelegramChatIdValue(chatId: string): number | string {
  const parsed = Number(chatId);
  if (Number.isSafeInteger(parsed)) {
    return parsed;
  }
  return chatId;
}

/**
 * Builds a Telegram conversation notifier that applies final outbound text rendering consistently.
 *
 * @param input - Render and delivery callbacks bound to one Telegram chat.
 * @returns Conversation notifier transport for Telegram delivery.
 */
export function createTelegramConversationNotifier(
  input: TelegramNotifierFactoryInput
): ConversationNotifierTransport {
  const useNativeDraftStreaming = input.nativeDraftStreamingEnabled;
  const draftId = useNativeDraftStreaming ? input.allocateDraftId() : null;

  return {
    capabilities: {
      supportsEdit: !useNativeDraftStreaming,
      supportsNativeStreaming: useNativeDraftStreaming
    },
    send: async (messageText: string) =>
      input.sendReply(input.renderOutboundText(messageText)),
    edit: useNativeDraftStreaming
      ? undefined
      : async (messageId: string, messageText: string) =>
        input.editReply(messageId, input.renderOutboundText(messageText)),
    stream: useNativeDraftStreaming && draftId !== null
      ? async (messageText: string) =>
        input.sendDraftUpdate(draftId, input.renderOutboundText(messageText))
      : undefined
  };
}

/**
 * Sends one outbound Telegram reply message.
 *
 * @param input - Telegram send context.
 * @returns Delivery result describing the outbound send attempt.
 */
export async function sendTelegramReply(
  input: TelegramSendReplyInput
): Promise<ConversationDeliveryResult> {
  const url = new URL(`/bot${input.botToken}/sendMessage`, input.apiBaseUrl);
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: toTelegramChatIdValue(input.chatId),
        text: input.text
      })
    });

    if (!response.ok) {
      const errorCode = response.status === 429
        ? "TELEGRAM_RATE_LIMITED"
        : `TELEGRAM_SEND_HTTP_${response.status}`;
      return {
        ok: false,
        messageId: null,
        errorCode
      };
    }

    const payload = (await response.json().catch(() => null)) as
      | { result?: { message_id?: string | number } }
      | null;
    const messageIdRaw = payload?.result?.message_id;
    const messageId = typeof messageIdRaw === "number" || typeof messageIdRaw === "string"
      ? String(messageIdRaw)
      : null;
    return {
      ok: true,
      messageId,
      errorCode: null
    };
  } catch {
    return {
      ok: false,
      messageId: null,
      errorCode: "TELEGRAM_SEND_FAILED"
    };
  }
}

/**
 * Edits one outbound Telegram reply message.
 *
 * @param input - Telegram edit context.
 * @returns Delivery result describing the outbound edit attempt.
 */
export async function editTelegramReply(
  input: TelegramEditReplyInput
): Promise<ConversationDeliveryResult> {
  const url = new URL(`/bot${input.botToken}/editMessageText`, input.apiBaseUrl);
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: toTelegramChatIdValue(input.chatId),
        message_id: input.messageId,
        text: input.text
      })
    });
    if (!response.ok) {
      const errorCode = response.status === 429
        ? "TELEGRAM_RATE_LIMITED"
        : `TELEGRAM_EDIT_HTTP_${response.status}`;
      return {
        ok: false,
        messageId: null,
        errorCode
      };
    }
    return {
      ok: true,
      messageId: input.messageId,
      errorCode: null
    };
  } catch {
    return {
      ok: false,
      messageId: null,
      errorCode: "TELEGRAM_EDIT_FAILED"
    };
  }
}

/**
 * Streams one native Telegram draft update for in-progress progress rendering.
 *
 * @param input - Telegram draft-send context.
 * @returns Delivery result describing the outbound draft attempt.
 */
export async function sendTelegramDraftUpdate(
  input: TelegramDraftUpdateInput
): Promise<ConversationDeliveryResult> {
  const normalizedText = input.text.trim();
  if (!normalizedText) {
    return {
      ok: false,
      messageId: null,
      errorCode: "EMPTY_MESSAGE"
    };
  }

  const url = new URL(`/bot${input.botToken}/sendMessageDraft`, input.apiBaseUrl);
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: toTelegramChatIdValue(input.chatId),
        draft_id: input.draftId,
        text: normalizedText
      })
    });

    if (!response.ok) {
      const errorCode = response.status === 429
        ? "TELEGRAM_RATE_LIMITED"
        : `TELEGRAM_DRAFT_HTTP_${response.status}`;
      return {
        ok: false,
        messageId: null,
        errorCode
      };
    }

    return {
      ok: true,
      messageId: null,
      errorCode: null
    };
  } catch {
    return {
      ok: false,
      messageId: null,
      errorCode: "TELEGRAM_DRAFT_FAILED"
    };
  }
}
