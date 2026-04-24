/**
 * @fileoverview Canonical Telegram outbound transport helpers for gateway delivery and notifier wiring.
 */

import type {
  ConversationOutboundDeliveryTrace,
  ConversationDeliveryResult,
  ConversationNotifierTransport
} from "../conversationRuntime/managerContracts";
import type {
  TelegramDraftUpdateInput,
  TelegramEditReplyInput,
  TelegramNotifierFactoryInput,
  TelegramSendReplyInput
} from "./contracts";

const TELEGRAM_SAFE_MESSAGE_CHAR_LIMIT = 4000;

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
 * Builds a stable failed-delivery result and only attaches detail when the upstream platform
 * returned something meaningful.
 *
 * @param errorCode - Stable transport error code.
 * @param errorDetail - Optional provider detail text.
 * @returns Failed conversation delivery result.
 */
function buildTelegramFailureResult(
  errorCode: string,
  errorDetail: string | null = null
): ConversationDeliveryResult {
  return errorDetail
    ? {
        ok: false,
        messageId: null,
        errorCode,
        errorDetail
      }
    : {
        ok: false,
        messageId: null,
        errorCode
      };
}

/**
 * Parses the most useful Telegram error detail from a non-OK HTTP response.
 *
 * @param response - Non-success Telegram API response.
 * @returns Human-readable provider detail, or `null` when nothing useful exists.
 */
async function readTelegramErrorDetail(response: Response): Promise<string | null> {
  const rawText = await response.text().catch(() => "");
  const normalized = rawText.trim();
  if (!normalized) {
    return null;
  }
  try {
    const payload = JSON.parse(normalized) as { description?: unknown };
    if (typeof payload.description === "string" && payload.description.trim()) {
      return payload.description.trim();
    }
  } catch {
    // Preserve the raw provider body when it is not JSON.
  }
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

/**
 * Picks a stable split boundary for Telegram text so long messages break on natural separators
 * when possible instead of splitting purely by raw length.
 *
 * @param text - Full outbound message text.
 * @param start - Current chunk start offset.
 * @param maxEnd - Maximum allowed chunk end offset.
 * @returns Chosen chunk end offset.
 */
function resolveTelegramChunkBoundary(
  text: string,
  start: number,
  maxEnd: number
): number {
  const minPreferredEnd = start + Math.floor((maxEnd - start) * 0.6);
  const separators = ["\n\n", "\n", ". ", "! ", "? ", "; ", ", ", " "] as const;
  for (const separator of separators) {
    const index = text.lastIndexOf(separator, maxEnd - 1);
    if (index >= minPreferredEnd && index >= start) {
      return index + separator.length;
    }
  }
  return maxEnd;
}

/**
 * Splits long outbound Telegram text into bounded chunks that fit under the platform send limit.
 *
 * @param text - Full outbound text after any invocation-hint rendering.
 * @returns One or more Telegram-safe chunks.
 */
function splitTelegramOutboundText(text: string): string[] {
  if (text.length <= TELEGRAM_SAFE_MESSAGE_CHAR_LIMIT) {
    return [text];
  }
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const maxEnd = Math.min(start + TELEGRAM_SAFE_MESSAGE_CHAR_LIMIT, text.length);
    const end =
      maxEnd < text.length
        ? resolveTelegramChunkBoundary(text, start, maxEnd)
        : maxEnd;
    if (end <= start) {
      chunks.push(text.slice(start, maxEnd));
      start = maxEnd;
      continue;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

/**
 * Sends one already-sized Telegram reply chunk.
 *
 * @param input - Telegram send context.
 * @param text - Outbound chunk that already fits within the Telegram send bound.
 * @returns Delivery result for the specific chunk.
 */
async function sendTelegramReplyChunk(
  input: TelegramSendReplyInput,
  text: string
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
        text
      })
    });

    if (!response.ok) {
      const errorDetail = await readTelegramErrorDetail(response);
      const errorCode = response.status === 429
        ? "TELEGRAM_RATE_LIMITED"
        : `TELEGRAM_SEND_HTTP_${response.status}`;
      return buildTelegramFailureResult(errorCode, errorDetail);
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
    return buildTelegramFailureResult("TELEGRAM_SEND_FAILED");
  }
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
    send: async (
      messageText: string,
      trace?: ConversationOutboundDeliveryTrace
    ) =>
      input.sendReply(input.renderOutboundText(messageText), trace),
    edit: useNativeDraftStreaming
      ? undefined
      : async (
        messageId: string,
        messageText: string,
        trace?: ConversationOutboundDeliveryTrace
      ) =>
        input.editReply(messageId, input.renderOutboundText(messageText), trace),
    stream: useNativeDraftStreaming && draftId !== null
      ? async (
        messageText: string,
        trace?: ConversationOutboundDeliveryTrace
      ) =>
        input.sendDraftUpdate(draftId, input.renderOutboundText(messageText), trace)
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
  const chunks = splitTelegramOutboundText(input.text);
  let lastMessageId: string | null = null;
  for (const chunk of chunks) {
    const result = await sendTelegramReplyChunk(input, chunk);
    if (!result.ok) {
      return result;
    }
    lastMessageId = result.messageId;
  }
  return {
    ok: true,
    messageId: lastMessageId,
    errorCode: null
  };
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
  if (input.text.length > TELEGRAM_SAFE_MESSAGE_CHAR_LIMIT) {
    return buildTelegramFailureResult(
      "TELEGRAM_EDIT_TOO_LONG",
      `Outbound text length ${input.text.length} exceeds the Telegram edit limit of ${TELEGRAM_SAFE_MESSAGE_CHAR_LIMIT} characters.`
    );
  }
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
      const errorDetail = await readTelegramErrorDetail(response);
      const errorCode = response.status === 429
        ? "TELEGRAM_RATE_LIMITED"
        : `TELEGRAM_EDIT_HTTP_${response.status}`;
      return buildTelegramFailureResult(errorCode, errorDetail);
    }
    return {
      ok: true,
      messageId: input.messageId,
      errorCode: null
    };
  } catch {
    return buildTelegramFailureResult("TELEGRAM_EDIT_FAILED");
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
      const errorDetail = await readTelegramErrorDetail(response);
      const errorCode = response.status === 429
        ? "TELEGRAM_RATE_LIMITED"
        : `TELEGRAM_DRAFT_HTTP_${response.status}`;
      return buildTelegramFailureResult(errorCode, errorDetail);
    }

    return {
      ok: true,
      messageId: null,
      errorCode: null
    };
  } catch {
    return buildTelegramFailureResult("TELEGRAM_DRAFT_FAILED");
  }
}
