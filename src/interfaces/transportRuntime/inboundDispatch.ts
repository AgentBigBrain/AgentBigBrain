/**
 * @fileoverview Canonical inbound conversation-dispatch helpers shared by Discord and Telegram gateways.
 */

import type {
  ConversationDeliveryResult,
  ConversationInboundMessage,
  ConversationNotifierTransport,
  ExecuteConversationTask
} from "../conversationRuntime/managerContracts";
import { parseAutonomousExecutionInput } from "../conversationRuntime/managerContracts";
import type {
  EntityGraphStoreLike,
  InboundEntityGraphMutationInput
} from "../entityGraphRuntime";
import { maybeRecordInboundEntityGraphMutation } from "../entityGraphRuntime";
import { runAutonomousTransportTask } from "./deliveryLifecycle";

export interface ConversationManagerLike {
  handleMessage(
    inbound: ConversationInboundMessage,
    executeTask: ExecuteConversationTask,
    notify: ConversationNotifierTransport
  ): Promise<string>;
}

export interface HandleAcceptedTransportConversationInput {
  inbound: ConversationInboundMessage;
  entityGraphEvent: InboundEntityGraphMutationInput;
  notifier: ConversationNotifierTransport;
  conversationManager: ConversationManagerLike;
  entityGraphStore: EntityGraphStoreLike;
  dynamicPulseEnabled: boolean;
  abortControllers: Map<string, AbortController>;
  runTextTask(input: string, receivedAt: string): Promise<string>;
  runAutonomousTask(
    goal: string,
    receivedAt: string,
    progressSender: (message: string) => Promise<void>,
    signal: AbortSignal
  ): Promise<string>;
  deliverReply(reply: string): Promise<ConversationDeliveryResult>;
  deliveryFailureCode: string;
  onEntityGraphMutationFailure?(error: Error): void;
  onEmptyReply?(): void;
}

/**
 * Delivers a transport-facing reject/stop response when text is available.
 *
 * @param responseText - User-facing response text, or `null` when nothing should be sent.
 * @param deliverResponse - Gateway-bound response delivery callback.
 * @param fallbackFailureCode - Stable fallback error code when delivery fails without one.
 * @returns `true` when a response was delivered, otherwise `false`.
 */
export async function deliverPreparedTransportResponse(
  responseText: string | null,
  deliverResponse: (text: string) => Promise<ConversationDeliveryResult>,
  fallbackFailureCode: string
): Promise<boolean> {
  if (!responseText) {
    return false;
  }
  const sendResult = await deliverResponse(responseText);
  if (!sendResult.ok) {
    throw new Error(sendResult.errorCode ?? fallbackFailureCode);
  }
  return true;
}

/**
 * Executes the accepted inbound conversation path shared by Discord and Telegram gateways.
 *
 * @param input - Gateway-scoped dependencies for one accepted inbound event.
 */
export async function handleAcceptedTransportConversation(
  input: HandleAcceptedTransportConversationInput
): Promise<void> {
  await maybeRecordInboundEntityGraphMutation(
    input.entityGraphStore,
    input.dynamicPulseEnabled,
    input.entityGraphEvent,
    input.onEntityGraphMutationFailure
  );

  const reply = await input.conversationManager.handleMessage(
    input.inbound,
    buildTransportExecutionTask(input),
    input.notifier
  );

  if (!reply.trim()) {
    input.onEmptyReply?.();
    return;
  }

  const sendResult = await input.deliverReply(reply);
  if (!sendResult.ok) {
    throw new Error(sendResult.errorCode ?? input.deliveryFailureCode);
  }
}

/**
 * Builds the canonical execution callback used by transport-managed conversations.
 *
 * @param input - Accepted inbound transport context.
 * @returns Execution callback passed into `ConversationManager.handleMessage(...)`.
 */
function buildTransportExecutionTask(
  input: HandleAcceptedTransportConversationInput
): ExecuteConversationTask {
  return async (taskInput: string, receivedAt: string) => {
    const autonomousGoal = parseAutonomousExecutionInput(taskInput);
    if (autonomousGoal) {
      const summary = await runAutonomousTransportTask({
        conversationId: input.inbound.conversationId,
        goal: autonomousGoal,
        receivedAt,
        notifier: input.notifier,
        abortControllers: input.abortControllers,
        runAutonomousTask: input.runAutonomousTask
      });
      return { summary };
    }

    return {
      summary: await input.runTextTask(taskInput, receivedAt)
    };
  };
}
