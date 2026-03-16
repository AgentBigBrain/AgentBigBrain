/**
 * @fileoverview Shared queue-enqueue helpers for the stable conversation-routing entrypoint.
 */

import {
  buildConversationAwareExecutionInput
} from "../conversationExecutionInputPolicy";
import { recordUserTurn } from "../conversationSessionMutations";
import type { ConversationSession } from "../sessionStore";
import type { ConversationInboundMediaEnvelope } from "../mediaRuntime/contracts";
import type {
  ListBrowserSessionSnapshots,
  ListManagedProcessSnapshots,
  QueryConversationContinuityEpisodes,
  QueryConversationContinuityFacts
} from "./managerContracts";

export interface ConversationRoutingQueueResult {
  reply: string;
  shouldStartWorker: boolean;
}

export interface ConversationRoutingQueueDependencies {
  config: {
    maxContextTurnsForExecution: number;
    maxConversationTurns: number;
  };
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes;
  queryContinuityFacts?: QueryConversationContinuityFacts;
  listManagedProcessSnapshots?: ListManagedProcessSnapshots;
  listBrowserSessionSnapshots?: ListBrowserSessionSnapshots;
  enqueueJob(
    session: ConversationSession,
    input: string,
    receivedAt: string,
    executionInput?: string,
    isSystemJob?: boolean
  ): ConversationRoutingQueueResult;
}

/**
 * Enqueues one short follow-up that should stay anchored to the prior assistant prompt instead of
 * being reinterpreted as a fresh request.
 *
 * @param session - Mutable conversation session receiving queued work.
 * @param input - Raw follow-up text from the user.
 * @param followUpExecutionInput - Expanded follow-up execution input tied to the prior prompt.
 * @param receivedAt - Message timestamp used for persisted turn metadata.
 * @param routingClassification - Deterministic routing classification for the follow-up text.
 * @param deps - Queue and continuity dependencies from the stable routing entrypoint.
 * @param media - Optional media envelope tied to the user turn.
 * @returns Queue insertion result after the user turn is recorded.
 */
export async function enqueueFollowUpLinkedToPriorAssistantPrompt(
  session: ConversationSession,
  input: string,
  followUpExecutionInput: string,
  receivedAt: string,
  routingClassification: Parameters<typeof buildConversationAwareExecutionInput>[3],
  deps: ConversationRoutingQueueDependencies,
  media: ConversationInboundMediaEnvelope | null = null
): Promise<ConversationRoutingQueueResult> {
  const managedProcessSnapshots = deps.listManagedProcessSnapshots
    ? await deps.listManagedProcessSnapshots()
    : undefined;
  const browserSessionSnapshots = deps.listBrowserSessionSnapshots
    ? await deps.listBrowserSessionSnapshots()
    : undefined;
  const enqueueResult = deps.enqueueJob(
    session,
    input,
    receivedAt,
    await buildConversationAwareExecutionInput(
      session,
      followUpExecutionInput,
      deps.config.maxContextTurnsForExecution,
      routingClassification,
      input,
      deps.queryContinuityEpisodes,
      deps.queryContinuityFacts,
      media,
      managedProcessSnapshots,
      null,
      browserSessionSnapshots
    )
  );
  recordUserTurn(session, input, receivedAt, deps.config.maxConversationTurns);
  return enqueueResult;
}
