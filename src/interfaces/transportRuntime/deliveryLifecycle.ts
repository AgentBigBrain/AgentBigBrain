/**
 * @fileoverview Canonical transport-facing autonomous progress and delivery bridges for gateways.
 */

import type { ConversationNotifierTransport } from "../conversationRuntime/managerContracts";

export interface RunAutonomousTransportTaskInput {
  conversationId: string;
  goal: string;
  receivedAt: string;
  notifier: ConversationNotifierTransport;
  abortControllers: Map<string, AbortController>;
  runAutonomousTask(
    goal: string,
    receivedAt: string,
    progressSender: (message: string) => Promise<void>,
    signal: AbortSignal
  ): Promise<string>;
}

/**
 * Creates the canonical progress sender used by gateway autonomous loops.
 *
 * @param notifier - Transport notifier bound to the active conversation.
 * @returns Best-effort progress sender that preserves existing send/edit/stream semantics.
 */
export function createAutonomousProgressSender(
  notifier: ConversationNotifierTransport
): (message: string) => Promise<void> {
  let progressMessageId: string | null = null;

  return async (message: string): Promise<void> => {
    if (
      notifier.capabilities.supportsNativeStreaming &&
      typeof notifier.stream === "function"
    ) {
      await notifier.stream(message).catch(() => undefined);
      return;
    }

    if (progressMessageId && typeof notifier.edit === "function") {
      const editResult = await notifier.edit(progressMessageId, message).catch(() => null);
      if (editResult?.ok) {
        return;
      }
    }

    const sendResult = await notifier.send(message).catch(() => null);
    if (sendResult?.ok && sendResult.messageId) {
      progressMessageId = sendResult.messageId;
    }
  };
}

/**
 * Runs one autonomous task with canonical abort-controller lifecycle and progress delivery wiring.
 *
 * @param input - Autonomous execution context for one conversation-scoped run.
 * @returns Final autonomous summary emitted by the adapter runtime.
 */
export async function runAutonomousTransportTask(
  input: RunAutonomousTransportTaskInput
): Promise<string> {
  const abortController = new AbortController();
  input.abortControllers.set(input.conversationId, abortController);
  const progressSender = createAutonomousProgressSender(input.notifier);

  try {
    return await input.runAutonomousTask(
      input.goal,
      input.receivedAt,
      progressSender,
      abortController.signal
    );
  } finally {
    input.abortControllers.delete(input.conversationId);
  }
}
