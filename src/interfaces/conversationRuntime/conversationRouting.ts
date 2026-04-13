/** @fileoverview Owns canonical queue-routing and execution-input assembly below the stable ingress coordinator. */
import { recordClassifierEvent } from "../conversationClassifierEvents";
import { buildConversationAwareExecutionInput, resolveFollowUpInput } from "../conversationExecutionInputPolicy";
import type { FollowUpRuleContext } from "../conversationManagerHelpers";
import { setModeContinuity, clearActiveClarification, recordAssistantTurn, recordUserTurn } from "../conversationSessionMutations";
import { buildRoutingExecutionHintV1, classifyRoutingIntentV1 } from "../routingMap";
import type { ConversationSession } from "../sessionStore";
import type { ConversationInboundMediaEnvelope } from "../mediaRuntime/contracts";
import type { AutonomyBoundaryInterpretationResolver, ContinuationInterpretationResolver, ContextualFollowupInterpretationResolver, ContextualReferenceInterpretationResolver, EntityReferenceInterpretationResolver, HandoffControlInterpretationResolver, IdentityInterpretationResolver, LocalIntentModelResolver, StatusRecallBoundaryInterpretationResolver, TopicKeyInterpretationResolver } from "../../organs/languageUnderstanding/localIntentModelContracts";
import type { TopicKeyInterpretationSignalV1 } from "../../core/stage6_86ConversationStack";
import type { GetConversationEntityGraph, ListBrowserSessionSnapshots, DescribeRuntimeCapabilities, ListManagedProcessSnapshots, ListAvailableSkills, OpenConversationContinuityReadSession, QueryConversationContinuityEpisodes, QueryConversationContinuityFacts, RememberConversationProfileInput, RunDirectConversationTurn } from "./managerContracts";
import { buildAutonomousExecutionInput } from "./managerContracts";
import {
  buildClarifiedExecutionInput,
  isClarificationExpired,
  resolveClarificationAnswer
} from "./clarificationBroker";
import { resolveModeContinuityIntent } from "./modeContinuity";
import { resolveConversationIntentMode } from "./intentModeResolution";
import type { ResolvedConversationIntentMode } from "./intentModeContracts";
import { applyActiveAutonomousPauseRequest, applyReturnHandoffPauseRequest, applyValidatedActiveAutonomousPause, applyValidatedReturnHandoffPause } from "./returnHandoffControl";
import { buildHandoffControlInterpretationResolution, resolveInterpretedHandoffControlSignal } from "./returnHandoffControlInterpretationSupport";
import { resolveReturnHandoffContinuationIntent } from "./returnHandoffContinuation";
import { buildAutonomousInitialExecutionInput, buildLocalIntentSessionHints, resolveConversationContinuationInterpretationIntent, toContinuityConfidence } from "./conversationRoutingSupport";
import { isReturnHandoffResumeIntent } from "./conversationRoutingDirectReplies";
import { enqueueFollowUpLinkedToPriorAssistantPrompt } from "./conversationRoutingQueueSupport";
import { applyConversationDomainSignalWindowForTurn } from "./sessionDomainRouting";
import { maybeResolveConversationRoutingInlineReply } from "./conversationRoutingInlineReplies";
import { buildDeterministicDirectChatFallbackReply, buildRecentIdentityInterpretationContext, shouldPreserveDeterministicDirectChatTurn } from "./chatTurnSignals";
import { resolveConversationTopicKeyInterpretationSignal } from "./conversationTopicKeyInterpretation";
export interface ConversationEnqueueResult { reply: string; shouldStartWorker: boolean; }
export interface ConversationRoutingDependencies {
  followUpRuleContext: FollowUpRuleContext;
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes;
  queryContinuityFacts?: QueryConversationContinuityFacts;
  openContinuityReadSession?: OpenConversationContinuityReadSession;
  rememberConversationProfileInput?: RememberConversationProfileInput;
  listAvailableSkills?: ListAvailableSkills;
  describeRuntimeCapabilities?: DescribeRuntimeCapabilities;
  listManagedProcessSnapshots?: ListManagedProcessSnapshots;
  listBrowserSessionSnapshots?: ListBrowserSessionSnapshots;
  localIntentModelResolver?: LocalIntentModelResolver;
  autonomyBoundaryInterpretationResolver?: AutonomyBoundaryInterpretationResolver;
  statusRecallBoundaryInterpretationResolver?: StatusRecallBoundaryInterpretationResolver;
  continuationInterpretationResolver?: ContinuationInterpretationResolver;
  contextualFollowupInterpretationResolver?: ContextualFollowupInterpretationResolver;
  contextualReferenceInterpretationResolver?: ContextualReferenceInterpretationResolver;
  entityReferenceInterpretationResolver?: EntityReferenceInterpretationResolver;
  handoffControlInterpretationResolver?: HandoffControlInterpretationResolver;
  identityInterpretationResolver?: IdentityInterpretationResolver;
  topicKeyInterpretationResolver?: TopicKeyInterpretationResolver;
  getEntityGraph?: GetConversationEntityGraph;
  abortActiveAutonomousRun?(): boolean;
  config: {
    allowAutonomousViaInterface: boolean;
    maxContextTurnsForExecution: number;
    maxConversationTurns: number;
  };
  directCasualChatEnabled?: boolean;
  runDirectConversationTurn?: RunDirectConversationTurn;
  enqueueJob(
    session: ConversationSession,
    input: string,
    receivedAt: string,
    executionInput?: string,
    isSystemJob?: boolean
  ): ConversationEnqueueResult;
}
/** Records one user turn while attaching any precomputed topic-key interpretation signal. */
function recordTopicAwareUserTurn(
  session: ConversationSession,
  input: string,
  receivedAt: string,
  maxConversationTurns: number,
  topicKeyInterpretation: TopicKeyInterpretationSignalV1 | null
): void {
  recordUserTurn(session, input, receivedAt, maxConversationTurns, {
    topicKeyInterpretation
  });
}
/** Resolves one canonical front-door routing decision for a user turn. */
async function resolveCanonicalConversationRouting(
  session: ConversationSession,
  input: string,
  receivedAt: string,
  deps: ConversationRoutingDependencies,
  media: ConversationInboundMediaEnvelope | null = null,
  preResolvedIntentMode: ResolvedConversationIntentMode | null = null,
  topicKeyInterpretation: TopicKeyInterpretationSignalV1 | null = null
): Promise<ConversationEnqueueResult> {
  const routingClassification = classifyRoutingIntentV1(input);
  const managedProcessSnapshots = deps.listManagedProcessSnapshots
    ? await deps.listManagedProcessSnapshots()
    : undefined;
  const browserSessionSnapshots = deps.listBrowserSessionSnapshots
    ? await deps.listBrowserSessionSnapshots()
    : undefined;

  if (session.activeClarification) {
    const clarificationAnswer = resolveClarificationAnswer(
      session.activeClarification,
      input
    );
    if (clarificationAnswer) {
      const activeClarification = session.activeClarification;
      clearActiveClarification(session);
      if (
        activeClarification.kind === "task_recovery" &&
        clarificationAnswer.selectedOptionId === "cancel"
      ) {
        const reply =
          "Okay. I will leave those folders and preview holders alone for now.";
        recordTopicAwareUserTurn(session, input, receivedAt, deps.config.maxConversationTurns, topicKeyInterpretation);
        recordAssistantTurn(
          session,
          reply,
          receivedAt,
          deps.config.maxConversationTurns
        );
        return {
          reply,
          shouldStartWorker: false
        };
      }
      setModeContinuity(session, {
        activeMode:
          activeClarification.kind === "execution_mode" &&
          clarificationAnswer.selectedOptionId === "plan"
            ? "plan"
            : "build",
        source: "clarification_answer",
        confidence: "HIGH",
        lastAffirmedAt: receivedAt,
        lastUserInput: input,
        lastClarificationId: activeClarification.id
      });
      applyConversationDomainSignalWindowForTurn(
        session,
        input,
        receivedAt,
        classifyRoutingIntentV1(activeClarification.sourceInput),
        activeClarification.kind === "execution_mode" &&
          clarificationAnswer.selectedOptionId === "plan"
          ? "plan"
          : "build"
      );
      const enqueueResult = deps.enqueueJob(
        session,
        activeClarification.sourceInput,
        receivedAt,
        await buildConversationAwareExecutionInput(
          session,
          buildClarifiedExecutionInput(
            activeClarification.sourceInput,
            activeClarification,
            clarificationAnswer.selectedOptionId
          ),
          deps.config.maxContextTurnsForExecution,
          classifyRoutingIntentV1(activeClarification.sourceInput),
          activeClarification.sourceInput,
          deps.queryContinuityEpisodes,
          deps.queryContinuityFacts,
          media,
          managedProcessSnapshots,
          undefined,
          browserSessionSnapshots,
          deps.contextualReferenceInterpretationResolver,
          deps.getEntityGraph,
          deps.entityReferenceInterpretationResolver,
          deps.openContinuityReadSession
        )
      );
      recordTopicAwareUserTurn(session, input, receivedAt, deps.config.maxConversationTurns, topicKeyInterpretation);
      return enqueueResult;
    }
    if (isClarificationExpired(session.activeClarification, receivedAt)) {
      clearActiveClarification(session);
    } else {
      recordTopicAwareUserTurn(session, input, receivedAt, deps.config.maxConversationTurns, topicKeyInterpretation);
      recordAssistantTurn(
        session,
        session.activeClarification.question,
        receivedAt,
        deps.config.maxConversationTurns
      );
      return {
        reply: session.activeClarification.question,
        shouldStartWorker: false
      };
    }
  }
  const activePauseReply = applyActiveAutonomousPauseRequest(
    session,
    input,
    receivedAt,
    deps.abortActiveAutonomousRun ?? null
  );
  if (activePauseReply) {
    recordTopicAwareUserTurn(session, input, receivedAt, deps.config.maxConversationTurns, topicKeyInterpretation);
    recordAssistantTurn(session, activePauseReply, receivedAt, deps.config.maxConversationTurns);
    return { reply: activePauseReply, shouldStartWorker: false };
  }
  const pauseReply = applyReturnHandoffPauseRequest(session, input, receivedAt);
  if (pauseReply) {
    recordTopicAwareUserTurn(session, input, receivedAt, deps.config.maxConversationTurns, topicKeyInterpretation);
    recordAssistantTurn(session, pauseReply, receivedAt, deps.config.maxConversationTurns);
    return { reply: pauseReply, shouldStartWorker: false };
  }
  const resolvedIntentMode =
    preResolvedIntentMode ??
    (await resolveConversationIntentMode(
      input,
      routingClassification,
      deps.localIntentModelResolver,
      buildLocalIntentSessionHints(session),
      deps.contextualFollowupInterpretationResolver,
      deps.autonomyBoundaryInterpretationResolver,
      deps.statusRecallBoundaryInterpretationResolver
    ));
  const interpretedHandoffControl = await resolveInterpretedHandoffControlSignal(
    session,
    input,
    resolvedIntentMode,
    deps.handoffControlInterpretationResolver,
    routingClassification
  );
  if (interpretedHandoffControl?.kind === "pause_request") {
    const interpretedActivePauseReply = applyValidatedActiveAutonomousPause(
      session,
      receivedAt,
      deps.abortActiveAutonomousRun ?? null
    );
    if (interpretedActivePauseReply) {
      recordTopicAwareUserTurn(session, input, receivedAt, deps.config.maxConversationTurns, topicKeyInterpretation);
      recordAssistantTurn(session, interpretedActivePauseReply, receivedAt, deps.config.maxConversationTurns);
      return { reply: interpretedActivePauseReply, shouldStartWorker: false };
    }
    const interpretedPauseReply = applyValidatedReturnHandoffPause(session, receivedAt);
    if (interpretedPauseReply) {
      recordTopicAwareUserTurn(session, input, receivedAt, deps.config.maxConversationTurns, topicKeyInterpretation);
      recordAssistantTurn(session, interpretedPauseReply, receivedAt, deps.config.maxConversationTurns);
      return { reply: interpretedPauseReply, shouldStartWorker: false };
    }
  }
  const effectiveIntentMode =
    buildHandoffControlInterpretationResolution(interpretedHandoffControl) ??
    resolveReturnHandoffContinuationIntent(session, input, resolvedIntentMode) ??
    resolveModeContinuityIntent(session, input, resolvedIntentMode) ??
    await resolveConversationContinuationInterpretationIntent(
      session,
      input,
      resolvedIntentMode,
      deps.continuationInterpretationResolver,
      routingClassification
    ) ??
    resolvedIntentMode;
  const shouldResumeReturnHandoff = isReturnHandoffResumeIntent(effectiveIntentMode);
  const inlineReply = await maybeResolveConversationRoutingInlineReply({
    session,
    userInput: input,
    receivedAt,
    deps,
    media,
    routingClassification,
    effectiveIntentMode,
    managedProcessSnapshots,
    browserSessionSnapshots
  });
  if (inlineReply) {
    return inlineReply;
  }
  if (
    effectiveIntentMode.mode === "chat" &&
    deps.directCasualChatEnabled !== false &&
    typeof deps.runDirectConversationTurn !== "function"
  ) {
    const recentIdentityContext = buildRecentIdentityInterpretationContext(session.conversationTurns.slice(-4));
    if (shouldPreserveDeterministicDirectChatTurn(input, recentIdentityContext)) {
      const reply = buildDeterministicDirectChatFallbackReply(input);
      recordTopicAwareUserTurn(session, input, receivedAt, deps.config.maxConversationTurns, topicKeyInterpretation);
      recordAssistantTurn(session, reply, receivedAt, deps.config.maxConversationTurns);
      applyConversationDomainSignalWindowForTurn(
        session,
        input,
        receivedAt,
        routingClassification,
        effectiveIntentMode.mode
      );
      return { reply, shouldStartWorker: false };
    }
  }
  if (effectiveIntentMode.mode === "autonomous") {
    if (!deps.config.allowAutonomousViaInterface) {
      const reply =
        "End-to-end autonomous runs are turned off in this environment right now. If you want, tell me to build it now and I'll do a normal run.";
      recordTopicAwareUserTurn(session, input, receivedAt, deps.config.maxConversationTurns, topicKeyInterpretation);
      recordAssistantTurn(
        session,
        reply,
        receivedAt,
        deps.config.maxConversationTurns
      );
      applyConversationDomainSignalWindowForTurn(
        session,
        input,
        receivedAt,
        routingClassification,
        effectiveIntentMode.mode
      );
      return {
        reply,
        shouldStartWorker: false
      };
    }
    const autonomousExecutionInput = buildAutonomousInitialExecutionInput(
      input,
      await buildConversationAwareExecutionInput(
        session,
        input,
        deps.config.maxContextTurnsForExecution,
        routingClassification,
        input,
        deps.queryContinuityEpisodes,
        deps.queryContinuityFacts,
        media,
        managedProcessSnapshots,
        effectiveIntentMode.semanticHint ?? null,
        browserSessionSnapshots,
        deps.contextualReferenceInterpretationResolver,
        deps.getEntityGraph,
        deps.entityReferenceInterpretationResolver,
        deps.openContinuityReadSession
      ),
      routingClassification
        ? buildRoutingExecutionHintV1(routingClassification)
        : null
    );
    const enqueueResult = deps.enqueueJob(
      session,
      input,
      receivedAt,
      buildAutonomousExecutionInput(input, autonomousExecutionInput)
    );
    recordTopicAwareUserTurn(session, input, receivedAt, deps.config.maxConversationTurns, topicKeyInterpretation);
    setModeContinuity(session, {
      activeMode: "autonomous",
      source: "natural_intent",
      confidence: toContinuityConfidence(effectiveIntentMode.confidence),
      lastAffirmedAt: receivedAt,
      lastUserInput: input
    });
    applyConversationDomainSignalWindowForTurn(
      session,
      input,
      receivedAt,
      routingClassification,
      effectiveIntentMode.mode
    );
    return {
      reply:
        shouldResumeReturnHandoff
          ? "I'm picking that back up from the last checkpoint now. I'll keep going until it's done or I hit a real blocker."
          : enqueueResult.reply.trim().length > 0
            ? enqueueResult.reply
            : "I'm taking this end to end now. I'll keep going until it's done or I hit a real blocker.",
      shouldStartWorker: enqueueResult.shouldStartWorker
    };
  }
  const enqueueResult = deps.enqueueJob(
    session,
    input,
    receivedAt,
    await buildConversationAwareExecutionInput(
      session,
      input,
      deps.config.maxContextTurnsForExecution,
      routingClassification,
      input,
      deps.queryContinuityEpisodes,
      deps.queryContinuityFacts,
      media,
      managedProcessSnapshots,
      effectiveIntentMode.semanticHint ?? null,
      browserSessionSnapshots,
      deps.contextualReferenceInterpretationResolver,
      deps.getEntityGraph,
      deps.entityReferenceInterpretationResolver,
      deps.openContinuityReadSession
    )
  );
  recordTopicAwareUserTurn(session, input, receivedAt, deps.config.maxConversationTurns, topicKeyInterpretation);
  if (effectiveIntentMode.mode !== "unclear" && effectiveIntentMode.mode !== "chat") {
    setModeContinuity(session, {
      activeMode: effectiveIntentMode.mode,
      source: "natural_intent",
      confidence: toContinuityConfidence(effectiveIntentMode.confidence),
      lastAffirmedAt: receivedAt,
      lastUserInput: input
    });
  }
  applyConversationDomainSignalWindowForTurn(
    session,
    input,
    receivedAt,
    routingClassification,
    effectiveIntentMode.mode
  );
  return shouldResumeReturnHandoff
    ? {
        reply: "I'm picking that back up from the last checkpoint now.",
        shouldStartWorker: enqueueResult.shouldStartWorker
      }
    : enqueueResult;
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
  if (session.activeClarification) {
    return resolveCanonicalConversationRouting(
      session,
      normalizedInput,
      receivedAt,
      {
        ...deps,
        directCasualChatEnabled: false
      }
    );
  }
  const routingClassification = classifyRoutingIntentV1(normalizedInput);
  const followUpResolution = await resolveFollowUpInput(
    session,
    normalizedInput,
    deps.followUpRuleContext,
    deps.continuationInterpretationResolver,
    routingClassification
  );
  recordClassifierEvent(
    session,
    normalizedInput,
    receivedAt,
    followUpResolution.classification
  );

  const followUpLinkedToPriorAssistantPrompt =
    followUpResolution.linkedToPriorAssistantPrompt;
  if (followUpLinkedToPriorAssistantPrompt) {
    return enqueueFollowUpLinkedToPriorAssistantPrompt(
      session,
      normalizedInput,
      followUpResolution.executionInput,
      receivedAt,
      routingClassification,
      deps,
      null
    );
  }
  return resolveCanonicalConversationRouting(
    session,
    normalizedInput,
    receivedAt,
    {
      ...deps,
      directCasualChatEnabled: false
    }
  );
}
/** Routes plain inbound conversation text through follow-up classification and queue insertion. */
export async function routeConversationMessageInput(
  session: ConversationSession,
  input: string,
  receivedAt: string,
  deps: ConversationRoutingDependencies,
  media: ConversationInboundMediaEnvelope | null = null
): Promise<ConversationEnqueueResult> {
  if (session.activeClarification) {
    return resolveCanonicalConversationRouting(session, input, receivedAt, deps, media);
  }

  const routingClassification = classifyRoutingIntentV1(input);
  const followUpResolution = await resolveFollowUpInput(
    session,
    input,
    deps.followUpRuleContext,
    deps.continuationInterpretationResolver,
    routingClassification
  );
  const preResolvedIntentMode = await resolveConversationIntentMode(
    input,
    routingClassification,
    deps.localIntentModelResolver,
    buildLocalIntentSessionHints(session),
    deps.contextualFollowupInterpretationResolver,
    deps.autonomyBoundaryInterpretationResolver,
    deps.statusRecallBoundaryInterpretationResolver
  );
  const topicKeyInterpretation = await resolveConversationTopicKeyInterpretationSignal(session, input, receivedAt, routingClassification, preResolvedIntentMode, deps.topicKeyInterpretationResolver);
  recordClassifierEvent(session, input, receivedAt, followUpResolution.classification);
  const followUpLinkedToPriorAssistantPrompt =
    followUpResolution.linkedToPriorAssistantPrompt;
  const recentIdentityContext = buildRecentIdentityInterpretationContext(session.conversationTurns.slice(-4));
  const preserveDirectConversationChatTurn =
    preResolvedIntentMode.mode === "chat" &&
    shouldPreserveDeterministicDirectChatTurn(input, recentIdentityContext);
  if (followUpLinkedToPriorAssistantPrompt) {
    if (preserveDirectConversationChatTurn) {
      return resolveCanonicalConversationRouting(session, input, receivedAt, deps, media, preResolvedIntentMode, topicKeyInterpretation);
    }
    return enqueueFollowUpLinkedToPriorAssistantPrompt(
      session,
      input,
      followUpResolution.executionInput,
      receivedAt,
      routingClassification,
      deps,
      media,
      topicKeyInterpretation
    );
  }
  return resolveCanonicalConversationRouting(session, input, receivedAt, deps, media, preResolvedIntentMode, topicKeyInterpretation);
}
