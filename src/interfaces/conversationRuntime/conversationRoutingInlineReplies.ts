/**
 * @fileoverview Owns inline reply handling for direct conversation, status, capability, and clarification turns.
 */

import { recordAssistantTurn, recordUserTurn, setActiveClarification, setProgressState } from "../conversationSessionMutations";
import type { ConversationSession } from "../sessionStore";
import type { ConversationInboundMediaEnvelope } from "../mediaRuntime/contracts";
import type { RoutingMapClassificationV1 } from "../routingMap";
import type { ManagedProcessSnapshot } from "../../organs/liveRun/managedProcessRegistry";
import type { BrowserSessionSnapshot } from "../../organs/liveRun/browserSessionRegistry";
import type {
  ContextualReferenceInterpretationResolver,
  EntityReferenceInterpretationResolver,
  IdentityInterpretationResolver
} from "../../organs/languageUnderstanding/localIntentModelContracts";
import { buildExplicitBrowserOwnershipNoOpReply } from "../conversationExecutionInputPolicy";
import {
  buildCapabilityDiscoveryReply,
  buildDirectCasualConversationReply,
  buildRecordedReply
} from "./conversationRoutingDirectReplies";
import type {
  DescribeRuntimeCapabilities,
  GetConversationEntityGraph,
  ListAvailableSkills,
  QueryConversationContinuityEpisodes,
  QueryConversationContinuityFacts,
  RememberConversationProfileInput,
  RunDirectConversationTurn
} from "./managerContracts";
import { createActiveClarificationState } from "./clarificationBroker";
import { toContinuityConfidence } from "./conversationRoutingSupport";
import type { ResolvedConversationIntentMode } from "./intentModeContracts";
import { renderConversationStatusOrRecall } from "./recentActionLedger";
import { applyConversationDomainSignalWindowForTurn } from "./sessionDomainRouting";

export interface ConversationRoutingInlineReplyDependencies {
  config: {
    maxConversationTurns: number;
    maxContextTurnsForExecution: number;
  };
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes;
  queryContinuityFacts?: QueryConversationContinuityFacts;
  rememberConversationProfileInput?: RememberConversationProfileInput;
  listAvailableSkills?: ListAvailableSkills;
  describeRuntimeCapabilities?: DescribeRuntimeCapabilities;
  getEntityGraph?: GetConversationEntityGraph;
  directCasualChatEnabled?: boolean;
  runDirectConversationTurn?: RunDirectConversationTurn;
  identityInterpretationResolver?: IdentityInterpretationResolver;
  contextualReferenceInterpretationResolver?: ContextualReferenceInterpretationResolver;
  entityReferenceInterpretationResolver?: EntityReferenceInterpretationResolver;
}

export interface ConversationRoutingInlineReplyInput {
  session: ConversationSession;
  userInput: string;
  receivedAt: string;
  deps: ConversationRoutingInlineReplyDependencies;
  media?: ConversationInboundMediaEnvelope | null;
  routingClassification: RoutingMapClassificationV1 | null;
  effectiveIntentMode: ResolvedConversationIntentMode;
  managedProcessSnapshots?: readonly ManagedProcessSnapshot[];
  browserSessionSnapshots?: readonly BrowserSessionSnapshot[];
}

/**
 * Resolves the canonical no-worker reply modes for one conversation turn when applicable.
 *
 * @param input - Inline-reply dependencies and routing state for the current turn.
 * @returns Inline reply result when the turn stays off the worker path, otherwise `null`.
 */
export async function maybeResolveConversationRoutingInlineReply(
  input: ConversationRoutingInlineReplyInput
): Promise<{ reply: string; shouldStartWorker: boolean } | null> {
  const explicitBrowserOwnershipNoOpReply = buildExplicitBrowserOwnershipNoOpReply(
    input.session,
    input.userInput
  );
  if (explicitBrowserOwnershipNoOpReply) {
    applyConversationDomainSignalWindowForTurn(
      input.session,
      input.userInput,
      input.receivedAt,
      input.routingClassification,
      input.effectiveIntentMode.mode
    );
    return buildRecordedReply({
      session: input.session,
      userInput: input.userInput,
      reply: explicitBrowserOwnershipNoOpReply,
      receivedAt: input.receivedAt,
      maxConversationTurns: input.deps.config.maxConversationTurns,
      activeMode: "status_or_recall",
      confidence: toContinuityConfidence(input.effectiveIntentMode.confidence)
    });
  }

  if (input.effectiveIntentMode.mode === "discover_available_capabilities") {
    const reply = await buildCapabilityDiscoveryReply({
      userInput: input.userInput,
      receivedAt: input.receivedAt,
      describeRuntimeCapabilities: input.deps.describeRuntimeCapabilities,
      listAvailableSkills: input.deps.listAvailableSkills,
      runDirectConversationTurn: input.deps.runDirectConversationTurn
    });
    applyConversationDomainSignalWindowForTurn(
      input.session,
      input.userInput,
      input.receivedAt,
      input.routingClassification,
      input.effectiveIntentMode.mode
    );
    return buildRecordedReply({
      session: input.session,
      userInput: input.userInput,
      reply,
      receivedAt: input.receivedAt,
      maxConversationTurns: input.deps.config.maxConversationTurns,
      activeMode: "discover_available_capabilities",
      confidence: toContinuityConfidence(input.effectiveIntentMode.confidence)
    });
  }

  if (input.effectiveIntentMode.mode === "status_or_recall") {
    const reply = renderConversationStatusOrRecall(
      input.session,
      input.userInput,
      input.effectiveIntentMode.semanticHint ?? null
    );
    applyConversationDomainSignalWindowForTurn(
      input.session,
      input.userInput,
      input.receivedAt,
      input.routingClassification,
      input.effectiveIntentMode.mode
    );
    return buildRecordedReply({
      session: input.session,
      userInput: input.userInput,
      reply,
      receivedAt: input.receivedAt,
      maxConversationTurns: input.deps.config.maxConversationTurns,
      activeMode: "status_or_recall",
      confidence: toContinuityConfidence(input.effectiveIntentMode.confidence)
    });
  }

  if (input.effectiveIntentMode.clarification) {
    const clarificationState = createActiveClarificationState(
      input.userInput,
      input.receivedAt,
      input.effectiveIntentMode.clarification
    );
    setActiveClarification(input.session, clarificationState);
    setProgressState(input.session, {
      status: "waiting_for_user",
      message: clarificationState.question,
      jobId: null,
      updatedAt: input.receivedAt
    });
    recordUserTurn(
      input.session,
      input.userInput,
      input.receivedAt,
      input.deps.config.maxConversationTurns
    );
    recordAssistantTurn(
      input.session,
      clarificationState.question,
      input.receivedAt,
      input.deps.config.maxConversationTurns
    );
    applyConversationDomainSignalWindowForTurn(
      input.session,
      input.userInput,
      input.receivedAt,
      input.routingClassification,
      input.effectiveIntentMode.mode
    );
    return {
      reply: clarificationState.question,
      shouldStartWorker: false
    };
  }

  const shouldDirectCasualConversation =
    input.deps.directCasualChatEnabled !== false &&
    input.effectiveIntentMode.mode === "chat" &&
    typeof input.deps.runDirectConversationTurn === "function";
  if (!shouldDirectCasualConversation) {
    return null;
  }

  const reply = await buildDirectCasualConversationReply({
    session: input.session,
    input: input.userInput,
    media: input.media ?? null,
    receivedAt: input.receivedAt,
    maxContextTurnsForExecution: input.deps.config.maxContextTurnsForExecution,
    routingClassification: input.routingClassification,
    queryContinuityEpisodes: input.deps.queryContinuityEpisodes,
    queryContinuityFacts: input.deps.queryContinuityFacts,
    rememberConversationProfileInput: input.deps.rememberConversationProfileInput,
    identityInterpretationResolver: input.deps.identityInterpretationResolver,
    contextualReferenceInterpretationResolver: input.deps.contextualReferenceInterpretationResolver,
    entityReferenceInterpretationResolver: input.deps.entityReferenceInterpretationResolver,
    getEntityGraph: input.deps.getEntityGraph,
    managedProcessSnapshots: input.managedProcessSnapshots,
    semanticHint: input.effectiveIntentMode.semanticHint ?? null,
    browserSessionSnapshots: input.browserSessionSnapshots,
    runDirectConversationTurn: input.deps.runDirectConversationTurn!
  });
  if (!reply) {
    return {
      reply: "",
      shouldStartWorker: false
    };
  }
  recordUserTurn(
    input.session,
    input.userInput,
    input.receivedAt,
    input.deps.config.maxConversationTurns
  );
  recordAssistantTurn(
    input.session,
    reply,
    input.receivedAt,
    input.deps.config.maxConversationTurns
  );
  applyConversationDomainSignalWindowForTurn(
    input.session,
    input.userInput,
    input.receivedAt,
    input.routingClassification,
    input.effectiveIntentMode.mode
  );
  return {
    reply,
    shouldStartWorker: false
  };
}
