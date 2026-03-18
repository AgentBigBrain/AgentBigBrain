/**
 * @fileoverview Owns conversation-worker notifier/executor bindings shared across the manager runtime.
 */

import type { ConversationNotifierTransport } from "../conversationWorkerLifecycle";
import type { ConversationNotifier, ExecuteConversationTask } from "./managerContracts";
import { toConversationNotifierTransport } from "./conversationNotifierTransport";

export interface SessionWorkerBinding {
  executeTask: ExecuteConversationTask;
  notifier: ConversationNotifierTransport;
}

/**
 * Stores the latest worker dependencies for one session key.
 *
 * @param workerBindings - Shared worker-binding map owned by the stable conversation manager.
 * @param sessionKey - Provider-scoped conversation/session key.
 * @param executeTask - Current governed execution callback for the session.
 * @param notify - Current notifier callback/object for the session.
 */
export function setConversationWorkerBinding(
  workerBindings: Map<string, SessionWorkerBinding>,
  sessionKey: string,
  executeTask: ExecuteConversationTask,
  notify: ConversationNotifier
): void {
  workerBindings.set(sessionKey, {
    executeTask,
    notifier: toConversationNotifierTransport(notify)
  });
}
