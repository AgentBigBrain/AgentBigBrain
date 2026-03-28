/**
 * @fileoverview Shared Telegram outbound-delivery trace helpers for gateway replies and notifier sends.
 */

import type {
  ConversationOutboundDeliveryTrace
} from "../conversationRuntime/managerContracts";
import type {
  TelegramOutboundDeliveryObservation,
  TelegramOutboundDeliveryObserver
} from "./contracts";

/**
 * Observes one outbound Telegram delivery without letting telemetry failures affect runtime flow.
 *
 * @param observer - Optional observer for outbound delivery events.
 * @param event - Canonical outbound delivery event to record.
 */
export async function observeTelegramOutboundDeliverySafely(
  observer: TelegramOutboundDeliveryObserver | undefined,
  event: TelegramOutboundDeliveryObservation
): Promise<void> {
  if (!observer) {
    return;
  }
  try {
    await observer(event);
  } catch (error) {
    console.warn(
      `[TelegramGateway] outbound delivery observer failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Merges one gateway-bound base trace with a per-send trace and delivery sequence.
 *
 * @param sequence - Monotonic delivery sequence for the gateway instance.
 * @param baseTrace - Stable notifier-bound trace fields for the active inbound turn.
 * @param trace - Per-send trace fields such as worker phase and job ids.
 * @returns Normalized observation metadata safe for Telegram outbound observers.
 */
export function mergeTelegramOutboundDeliveryTrace(
  sequence: number,
  baseTrace: {
    sessionKey?: string | null;
    inboundEventId?: string | null;
    inboundReceivedAt?: string | null;
  } | undefined,
  trace?: ConversationOutboundDeliveryTrace
): Pick<
  TelegramOutboundDeliveryObservation,
  | "sequence"
  | "source"
  | "sessionKey"
  | "jobId"
  | "jobCreatedAt"
  | "inboundEventId"
  | "inboundReceivedAt"
> {
  return {
    sequence,
    source: trace?.source ?? null,
    sessionKey: trace?.sessionKey ?? baseTrace?.sessionKey ?? null,
    jobId: trace?.jobId ?? null,
    jobCreatedAt: trace?.jobCreatedAt ?? null,
    inboundEventId: trace?.inboundEventId ?? baseTrace?.inboundEventId ?? null,
    inboundReceivedAt: trace?.inboundReceivedAt ?? baseTrace?.inboundReceivedAt ?? null
  };
}

/**
 * Builds the notifier-bound trace that tags later worker deliveries with their latest inbound turn.
 *
 * @param sessionKey - Stable provider-scoped session key.
 * @param inboundEventId - Provider event id that installed the notifier binding.
 * @param inboundReceivedAt - Timestamp for the inbound turn that installed the notifier binding.
 * @returns Stable base trace for a notifier instance.
 */
export function buildTelegramNotifierBaseTrace(
  sessionKey: string,
  inboundEventId: string,
  inboundReceivedAt: string | null
): {
  sessionKey: string;
  inboundEventId: string;
  inboundReceivedAt: string | null;
} {
  return {
    sessionKey,
    inboundEventId,
    inboundReceivedAt
  };
}

/**
 * Builds direct-reply observation metadata for one accepted inbound turn.
 *
 * @param sequence - Monotonic delivery sequence for the gateway instance.
 * @param sessionKey - Stable provider-scoped session key.
 * @param inboundEventId - Provider event id for the direct turn.
 * @param inboundReceivedAt - Timestamp for the direct turn.
 * @returns Partial observation metadata for a direct reply send.
 */
export function buildTelegramDirectReplyObservation(
  sequence: number,
  sessionKey: string,
  inboundEventId: string,
  inboundReceivedAt: string | null
): Partial<
  Omit<TelegramOutboundDeliveryObservation, "kind" | "chatId" | "text" | "at" | "messageId" | "draftId">
> {
  return {
    sequence,
    source: "direct_reply",
    sessionKey,
    jobId: null,
    jobCreatedAt: null,
    inboundEventId,
    inboundReceivedAt
  };
}

/**
 * Builds transport-response observation metadata for reject/stop replies sent before session routing.
 *
 * @param sequence - Monotonic delivery sequence for the gateway instance.
 * @param inboundEventId - Provider event id for the rejected or stopped turn.
 * @returns Partial observation metadata for a transport response send.
 */
export function buildTelegramTransportResponseObservation(
  sequence: number,
  inboundEventId: string
): Partial<
  Omit<TelegramOutboundDeliveryObservation, "kind" | "chatId" | "text" | "at" | "messageId" | "draftId">
> {
  return {
    sequence,
    source: "transport_response",
    sessionKey: null,
    jobId: null,
    jobCreatedAt: null,
    inboundEventId,
    inboundReceivedAt: null
  };
}
