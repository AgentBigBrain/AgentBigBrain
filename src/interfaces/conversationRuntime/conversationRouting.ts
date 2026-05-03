/** @fileoverview Owns canonical queue-routing and execution-input assembly below the stable ingress coordinator. */
import { recordClassifierEvent } from "../conversationClassifierEvents";
import { buildConversationAwareExecutionInput, resolveFollowUpInput } from "../conversationExecutionInputPolicy";
import { setModeContinuity, clearActiveClarification } from "../conversationSessionMutations";
import { buildRoutingExecutionHintV1, classifyRoutingIntentV1 } from "../routingMap";
import type { ConversationSession } from "../sessionStore";
import type { ConversationInboundMediaEnvelope } from "../mediaRuntime/contracts";
import type { TopicKeyInterpretationSignalV1 } from "../../core/stage6_86ConversationStack";
import { buildAutonomousExecutionInput } from "./managerContracts";
import {
  buildClarifiedExecutionInput,
  isClarificationExpired,
  resolveClarifiedBuildFormatMetadata,
  resolveClarifiedIntentMode,
  resolveClarificationAnswer
} from "./clarificationBroker";
import { resolveModeContinuityIntent } from "./modeContinuity";
import { resolveConversationIntentMode } from "./intentModeResolution";
import {
  buildConversationSemanticRouteMetadata,
  inferSemanticRouteIdFromIntentMode,
  type ResolvedConversationIntentMode,
  withSemanticRouteId
} from "./intentModeContracts";
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
import { isMediaAnalysisConversationTurn } from "./mediaAnalysisIntent";
import { recordTopicAwareUserTurn } from "./conversationRoutingTurnSupport";
import { recordRoutingAssistantTurn } from "./conversationRoutingAssistantTurnSupport";
import type { ConversationEnqueueResult, ConversationRoutingDependencies } from "./conversationRoutingContracts";
export type { ConversationEnqueueResult, ConversationRoutingDependencies } from "./conversationRoutingContracts";
/**
 * Resolves canonical conversation routing.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `TopicKeyInterpretationSignalV1` (import `TopicKeyInterpretationSignalV1`) from `../../core/stage6_86ConversationStack`.
 * - Uses `buildConversationAwareExecutionInput` (import `buildConversationAwareExecutionInput`) from `../conversationExecutionInputPolicy`.
 * - Uses `clearActiveClarification` (import `clearActiveClarification`) from `../conversationSessionMutations`.
 * - Uses `recordRoutingAssistantTurn` (import `recordRoutingAssistantTurn`) from `./conversationRoutingAssistantTurnSupport`.
 * - Uses `setModeContinuity` (import `setModeContinuity`) from `../conversationSessionMutations`.
 * - Uses `ConversationInboundMediaEnvelope` (import `ConversationInboundMediaEnvelope`) from `../mediaRuntime/contracts`.
 * - Uses `buildRoutingExecutionHintV1` (import `buildRoutingExecutionHintV1`) from `../routingMap`.
 * - Uses `classifyRoutingIntentV1` (import `classifyRoutingIntentV1`) from `../routingMap`.
 * - Uses `ConversationSession` (import `ConversationSession`) from `../sessionStore`.
 * - Uses `buildDeterministicDirectChatFallbackReply` (import `buildDeterministicDirectChatFallbackReply`) from `./chatTurnSignals`.
 * - Uses `buildRecentIdentityInterpretationContext` (import `buildRecentIdentityInterpretationContext`) from `./chatTurnSignals`.
 * - Uses `shouldPreserveDeterministicDirectChatTurn` (import `shouldPreserveDeterministicDirectChatTurn`) from `./chatTurnSignals`.
 * - Uses `buildClarifiedExecutionInput` (import `buildClarifiedExecutionInput`) from `./clarificationBroker`.
 * - Uses `isClarificationExpired` (import `isClarificationExpired`) from `./clarificationBroker`.
 * - Uses `resolveClarificationAnswer` (import `resolveClarificationAnswer`) from `./clarificationBroker`.
 * - Uses `resolveClarifiedIntentMode` (import `resolveClarifiedIntentMode`) from `./clarificationBroker`.
 * - Uses `isReturnHandoffResumeIntent` (import `isReturnHandoffResumeIntent`) from `./conversationRoutingDirectReplies`.
 * - Uses `maybeResolveConversationRoutingInlineReply` (import `maybeResolveConversationRoutingInlineReply`) from `./conversationRoutingInlineReplies`.
 * - Uses `buildAutonomousInitialExecutionInput` (import `buildAutonomousInitialExecutionInput`) from `./conversationRoutingSupport`.
 * - Uses `buildLocalIntentSessionHints` (import `buildLocalIntentSessionHints`) from `./conversationRoutingSupport`.
 * - Uses `resolveConversationContinuationInterpretationIntent` (import `resolveConversationContinuationInterpretationIntent`) from `./conversationRoutingSupport`.
 * - Uses `toContinuityConfidence` (import `toContinuityConfidence`) from `./conversationRoutingSupport`.
 * - Uses `recordTopicAwareUserTurn` (import `recordTopicAwareUserTurn`) from `./conversationRoutingTurnSupport`.
 * - Uses `inferSemanticRouteIdFromIntentMode` (import `inferSemanticRouteIdFromIntentMode`) from `./intentModeContracts`.
 * - Uses `ResolvedConversationIntentMode` (import `ResolvedConversationIntentMode`) from `./intentModeContracts`.
 * - Uses `resolveConversationIntentMode` (import `resolveConversationIntentMode`) from `./intentModeResolution`.
 * - Uses `buildAutonomousExecutionInput` (import `buildAutonomousExecutionInput`) from `./managerContracts`.
 * - Uses `resolveModeContinuityIntent` (import `resolveModeContinuityIntent`) from `./modeContinuity`.
 * - Uses `resolveReturnHandoffContinuationIntent` (import `resolveReturnHandoffContinuationIntent`) from `./returnHandoffContinuation`.
 * - Uses `applyActiveAutonomousPauseRequest` (import `applyActiveAutonomousPauseRequest`) from `./returnHandoffControl`.
 * - Uses `applyReturnHandoffPauseRequest` (import `applyReturnHandoffPauseRequest`) from `./returnHandoffControl`.
 * - Uses `applyValidatedActiveAutonomousPause` (import `applyValidatedActiveAutonomousPause`) from `./returnHandoffControl`.
 * - Uses `applyValidatedReturnHandoffPause` (import `applyValidatedReturnHandoffPause`) from `./returnHandoffControl`.
 * - Uses `buildHandoffControlInterpretationResolution` (import `buildHandoffControlInterpretationResolution`) from `./returnHandoffControlInterpretationSupport`.
 * - Uses `resolveInterpretedHandoffControlSignal` (import `resolveInterpretedHandoffControlSignal`) from `./returnHandoffControlInterpretationSupport`.
 * - Uses `applyConversationDomainSignalWindowForTurn` (import `applyConversationDomainSignalWindowForTurn`) from `./sessionDomainRouting`.
 * @param session - Input consumed by this helper.
 * @param input - Input consumed by this helper.
 * @param receivedAt - Input consumed by this helper.
 * @param deps - Input consumed by this helper.
 * @param media - Input consumed by this helper.
 * @param preResolvedIntentMode - Input consumed by this helper.
 * @param topicKeyInterpretation - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
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
        recordRoutingAssistantTurn(session, reply, receivedAt, deps.config.maxConversationTurns, "informational_answer");
        return {
          reply,
          shouldStartWorker: false
        };
      }
      const clarifiedIntentMode = resolveClarifiedIntentMode(
        activeClarification.sourceInput,
        activeClarification,
        clarificationAnswer.selectedOptionId
      );
      const clarifiedBuildFormat = resolveClarifiedBuildFormatMetadata(
        activeClarification,
        clarificationAnswer.selectedOptionId
      );
      const clarifiedSemanticRouteId = inferSemanticRouteIdFromIntentMode(clarifiedIntentMode);
      const clarifiedSemanticRoute = buildConversationSemanticRouteMetadata(
        {
          mode: clarifiedIntentMode,
          confidence: "high",
          matchedRuleId: "conversation_clarification_answer",
          explanation: "The user answered an active clarification prompt.",
          clarification: null,
          semanticRouteId: clarifiedSemanticRouteId,
          buildFormat: clarifiedBuildFormat
        },
        {
          source: "clarification",
          buildFormat: clarifiedBuildFormat
        }
      );
      setModeContinuity(session, {
        activeMode: clarifiedIntentMode,
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
        clarifiedIntentMode,
        clarifiedSemanticRoute
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
          deps.openContinuityReadSession,
          undefined,
          clarifiedSemanticRouteId,
          clarifiedBuildFormat,
          clarifiedSemanticRoute
        )
      );
      recordTopicAwareUserTurn(session, input, receivedAt, deps.config.maxConversationTurns, topicKeyInterpretation);
      return enqueueResult;
    }
    if (isClarificationExpired(session.activeClarification, receivedAt)) {
      clearActiveClarification(session);
    } else {
      recordTopicAwareUserTurn(session, input, receivedAt, deps.config.maxConversationTurns, topicKeyInterpretation);
      recordRoutingAssistantTurn(session, session.activeClarification.question, receivedAt, deps.config.maxConversationTurns, "clarification");
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
    recordRoutingAssistantTurn(session, activePauseReply, receivedAt, deps.config.maxConversationTurns, "workflow_progress");
    return { reply: activePauseReply, shouldStartWorker: false };
  }
  const pauseReply = applyReturnHandoffPauseRequest(session, input, receivedAt);
  if (pauseReply) {
    recordTopicAwareUserTurn(session, input, receivedAt, deps.config.maxConversationTurns, topicKeyInterpretation);
    recordRoutingAssistantTurn(session, pauseReply, receivedAt, deps.config.maxConversationTurns, "workflow_progress");
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
      recordRoutingAssistantTurn(session, interpretedActivePauseReply, receivedAt, deps.config.maxConversationTurns, "workflow_progress");
      return { reply: interpretedActivePauseReply, shouldStartWorker: false };
    }
    const interpretedPauseReply = applyValidatedReturnHandoffPause(session, receivedAt);
    if (interpretedPauseReply) {
      recordTopicAwareUserTurn(session, input, receivedAt, deps.config.maxConversationTurns, topicKeyInterpretation);
      recordRoutingAssistantTurn(session, interpretedPauseReply, receivedAt, deps.config.maxConversationTurns, "workflow_progress");
      return { reply: interpretedPauseReply, shouldStartWorker: false };
    }
  }
  const effectiveIntentMode = withSemanticRouteId(
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
    resolvedIntentMode
  );
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
      recordRoutingAssistantTurn(session, reply, receivedAt, deps.config.maxConversationTurns, "informational_answer");
      applyConversationDomainSignalWindowForTurn(
        session,
        input,
        receivedAt,
        routingClassification,
        effectiveIntentMode.mode,
        effectiveIntentMode.semanticRoute ?? null
      );
      return { reply, shouldStartWorker: false };
    }
  }
  if (effectiveIntentMode.mode === "autonomous") {
    if (!deps.config.allowAutonomousViaInterface) {
      const reply =
        "End-to-end autonomous runs are turned off in this environment right now. If you want, tell me to build it now and I'll do a normal run.";
      recordTopicAwareUserTurn(session, input, receivedAt, deps.config.maxConversationTurns, topicKeyInterpretation);
      recordRoutingAssistantTurn(session, reply, receivedAt, deps.config.maxConversationTurns, "workflow_progress");
      applyConversationDomainSignalWindowForTurn(
        session,
        input,
        receivedAt,
        routingClassification,
        effectiveIntentMode.mode,
        effectiveIntentMode.semanticRoute ?? null
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
        deps.openContinuityReadSession,
        undefined,
        effectiveIntentMode.semanticRouteId ?? null,
        effectiveIntentMode.buildFormat ?? null,
        effectiveIntentMode.semanticRoute ?? null
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
      effectiveIntentMode.mode,
      effectiveIntentMode.semanticRoute ?? null
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
      deps.openContinuityReadSession,
      undefined,
      effectiveIntentMode.semanticRouteId ?? null,
      effectiveIntentMode.buildFormat ?? null,
      effectiveIntentMode.semanticRoute ?? null
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
    effectiveIntentMode.mode,
    effectiveIntentMode.semanticRoute ?? null
  );
  return shouldResumeReturnHandoff
    ? {
        reply: "I'm picking that back up from the last checkpoint now.",
        shouldStartWorker: enqueueResult.shouldStartWorker
      }
    : enqueueResult;
}
/**
 * Routes conversation chat input.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `recordClassifierEvent` (import `recordClassifierEvent`) from `../conversationClassifierEvents`.
 * - Uses `resolveFollowUpInput` (import `resolveFollowUpInput`) from `../conversationExecutionInputPolicy`.
 * - Uses `classifyRoutingIntentV1` (import `classifyRoutingIntentV1`) from `../routingMap`.
 * - Uses `ConversationSession` (import `ConversationSession`) from `../sessionStore`.
 * - Uses `enqueueFollowUpLinkedToPriorAssistantPrompt` (import `enqueueFollowUpLinkedToPriorAssistantPrompt`) from `./conversationRoutingQueueSupport`.
 * @param session - Input consumed by this helper.
 * @param normalizedInput - Input consumed by this helper.
 * @param receivedAt - Input consumed by this helper.
 * @param deps - Input consumed by this helper.
 * @returns Result produced by this helper.
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
  const followUpLinkedToPriorAssistantPrompt = followUpResolution.linkedToPriorAssistantPrompt;
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
/**
 * Routes conversation message input.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `recordClassifierEvent` (import `recordClassifierEvent`) from `../conversationClassifierEvents`.
 * - Uses `resolveFollowUpInput` (import `resolveFollowUpInput`) from `../conversationExecutionInputPolicy`.
 * - Uses `ConversationInboundMediaEnvelope` (import `ConversationInboundMediaEnvelope`) from `../mediaRuntime/contracts`.
 * - Uses `classifyRoutingIntentV1` (import `classifyRoutingIntentV1`) from `../routingMap`.
 * - Uses `ConversationSession` (import `ConversationSession`) from `../sessionStore`.
 * - Uses `buildRecentIdentityInterpretationContext` (import `buildRecentIdentityInterpretationContext`) from `./chatTurnSignals`.
 * - Uses `shouldPreserveDeterministicDirectChatTurn` (import `shouldPreserveDeterministicDirectChatTurn`) from `./chatTurnSignals`.
 * - Uses `enqueueFollowUpLinkedToPriorAssistantPrompt` (import `enqueueFollowUpLinkedToPriorAssistantPrompt`) from `./conversationRoutingQueueSupport`.
 * - Uses `buildLocalIntentSessionHints` (import `buildLocalIntentSessionHints`) from `./conversationRoutingSupport`.
 * - Uses `resolveConversationTopicKeyInterpretationSignal` (import `resolveConversationTopicKeyInterpretationSignal`) from `./conversationTopicKeyInterpretation`.
 * - Uses `resolveConversationIntentMode` (import `resolveConversationIntentMode`) from `./intentModeResolution`.
 * - Uses `isMediaAnalysisConversationTurn` (import `isMediaAnalysisConversationTurn`) from `./mediaAnalysisIntent`.
 * @param session - Input consumed by this helper.
 * @param input - Input consumed by this helper.
 * @param receivedAt - Input consumed by this helper.
 * @param deps - Input consumed by this helper.
 * @param media - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
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
  const preResolvedIntentMode = isMediaAnalysisConversationTurn(input, media)
    ? {
        mode: "chat" as const,
        confidence: "high" as const,
        matchedRuleId: "intent_mode_media_analysis_chat",
        explanation:
          "The turn asks for grounded understanding of an attached media artifact, so it should stay on the conversational analysis path instead of entering workflow execution.",
        clarification: null
      }
    : await resolveConversationIntentMode(
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
  const followUpLinkedToPriorAssistantPrompt = followUpResolution.linkedToPriorAssistantPrompt;
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
