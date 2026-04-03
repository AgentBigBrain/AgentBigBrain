/**
 * @fileoverview Shared queue-enqueue helpers for the stable conversation-routing entrypoint.
 */

import type { TopicKeyInterpretationSignalV1 } from "../../core/stage6_86ConversationStack";
import {
  buildConversationAwareExecutionInput
} from "../conversationExecutionInputPolicy";
import { applyConversationDomainSignalWindow, recordUserTurn } from "../conversationSessionMutations";
import type { ConversationSession } from "../sessionStore";
import type { ConversationInboundMediaEnvelope } from "../mediaRuntime/contracts";
import type { ContextualReferenceInterpretationResolver, EntityReferenceInterpretationResolver } from "../../organs/languageUnderstanding/localIntentModelContracts";
import type {
  GetConversationEntityGraph,
  ListBrowserSessionSnapshots,
  ListManagedProcessSnapshots,
  OpenConversationContinuityReadSession,
  QueryConversationContinuityEpisodes,
  QueryConversationContinuityFacts
} from "./managerContracts";
import { buildConversationDomainSignalWindowForTurn } from "./sessionDomainRouting";

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
  openContinuityReadSession?: OpenConversationContinuityReadSession;
  contextualReferenceInterpretationResolver?: ContextualReferenceInterpretationResolver;
  entityReferenceInterpretationResolver?: EntityReferenceInterpretationResolver;
  getEntityGraph?: GetConversationEntityGraph;
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
  media: ConversationInboundMediaEnvelope | null = null,
  topicKeyInterpretation: TopicKeyInterpretationSignalV1 | null = null
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
      browserSessionSnapshots,
      deps.contextualReferenceInterpretationResolver,
      deps.getEntityGraph,
      deps.entityReferenceInterpretationResolver,
      deps.openContinuityReadSession
    )
  );
  recordUserTurn(session, input, receivedAt, deps.config.maxConversationTurns, {
    topicKeyInterpretation
  });
  applyConversationDomainSignalWindow(
    session,
    buildConversationDomainSignalWindowForTurn(
      session,
      input,
      receivedAt,
      routingClassification ?? null,
      session.modeContinuity?.activeMode ??
        (routingClassification?.routeType === "execution_surface" ? "build" : null)
    )
  );
  return enqueueResult;
}
