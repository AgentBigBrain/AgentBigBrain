/**
 * @fileoverview Owns canonical queue-routing and execution-input assembly below the stable ingress coordinator.
 */

import { recordClassifierEvent } from "../conversationClassifierEvents";
import {
  buildConversationAwareExecutionInput,
  resolveFollowUpInput
} from "../conversationExecutionInputPolicy";
import type { FollowUpRuleContext } from "../conversationManagerHelpers";
import { recordUserTurn } from "../conversationSessionMutations";
import { classifyRoutingIntentV1 } from "../routingMap";
import type { ConversationSession } from "../sessionStore";
import type {
  QueryConversationContinuityEpisodes,
  QueryConversationContinuityFacts
} from "./managerContracts";

export interface ConversationEnqueueResult {
  reply: string;
  shouldStartWorker: boolean;
}

export interface ConversationRoutingDependencies {
  followUpRuleContext: FollowUpRuleContext;
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes;
  queryContinuityFacts?: QueryConversationContinuityFacts;
  config: {
    maxContextTurnsForExecution: number;
    maxConversationTurns: number;
  };
  enqueueJob(
    session: ConversationSession,
    input: string,
    receivedAt: string,
    executionInput?: string,
    isSystemJob?: boolean
  ): ConversationEnqueueResult;
}

/**
 * Routes explicit `/chat` requests through follow-up classification, routing-map hinting, and queue insertion.
 *
 * @param session - Mutable conversation session receiving queued work.
 * @param normalizedInput - Canonicalized `/chat` payload.
 * @param receivedAt - Message timestamp used for persisted turn metadata.
 * @param deps - Routing dependencies exposed by the stable ingress coordinator.
 * @returns Queue insertion result for the stable ingress coordinator.
 */
export async function routeConversationChatInput(
  session: ConversationSession,
  normalizedInput: string,
  receivedAt: string,
  deps: ConversationRoutingDependencies
): Promise<ConversationEnqueueResult> {
  const followUpResolution = resolveFollowUpInput(
    session,
    normalizedInput,
    deps.followUpRuleContext
  );
  const routingClassification = classifyRoutingIntentV1(normalizedInput);
  recordClassifierEvent(
    session,
    normalizedInput,
    receivedAt,
    followUpResolution.classification
  );
  const enqueueResult = deps.enqueueJob(
    session,
    normalizedInput,
    receivedAt,
    await buildConversationAwareExecutionInput(
      session,
      followUpResolution.executionInput,
      deps.config.maxContextTurnsForExecution,
      routingClassification,
      normalizedInput,
      deps.queryContinuityEpisodes,
      deps.queryContinuityFacts
    )
  );
  recordUserTurn(
    session,
    normalizedInput,
    receivedAt,
    deps.config.maxConversationTurns
  );
  return enqueueResult;
}

/**
 * Routes plain inbound conversation text through follow-up classification and queue insertion.
 *
 * @param session - Mutable conversation session receiving queued work.
 * @param input - Raw inbound user text after ingress-level trimming.
 * @param receivedAt - Message timestamp used for persisted turn metadata.
 * @param deps - Routing dependencies exposed by the stable ingress coordinator.
 * @returns Queue insertion result for the stable ingress coordinator.
 */
export async function routeConversationMessageInput(
  session: ConversationSession,
  input: string,
  receivedAt: string,
  deps: ConversationRoutingDependencies
): Promise<ConversationEnqueueResult> {
  const followUpResolution = resolveFollowUpInput(
    session,
    input,
    deps.followUpRuleContext
  );
  recordClassifierEvent(
    session,
    input,
    receivedAt,
    followUpResolution.classification
  );
  const enqueueResult = deps.enqueueJob(
    session,
    input,
    receivedAt,
    await buildConversationAwareExecutionInput(
      session,
      followUpResolution.executionInput,
      deps.config.maxContextTurnsForExecution,
      null,
      input,
      deps.queryContinuityEpisodes,
      deps.queryContinuityFacts
    )
  );
  recordUserTurn(session, input, receivedAt, deps.config.maxConversationTurns);
  return enqueueResult;
}
