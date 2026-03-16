/**
 * @fileoverview Owns canonical queue-routing and execution-input assembly below the stable ingress coordinator.
 */

import { recordClassifierEvent } from "../conversationClassifierEvents";
import {
  buildConversationAwareExecutionInput,
  resolveFollowUpInput
} from "../conversationExecutionInputPolicy";
import type { FollowUpRuleContext } from "../conversationManagerHelpers";
import {
  setActiveClarification,
  setModeContinuity,
  setProgressState,
  recordAssistantTurn,
  clearActiveClarification,
  recordUserTurn
} from "../conversationSessionMutations";
import { buildRoutingExecutionHintV1, classifyRoutingIntentV1 } from "../routingMap";
import type { ConversationSession } from "../sessionStore";
import type { ConversationInboundMediaEnvelope } from "../mediaRuntime/contracts";
import type { LocalIntentModelResolver } from "../../organs/languageUnderstanding/localIntentModelContracts";
import type {
  ListBrowserSessionSnapshots,
  DescribeRuntimeCapabilities,
  ListManagedProcessSnapshots,
  ListAvailableSkills,
  QueryConversationContinuityEpisodes,
  QueryConversationContinuityFacts
} from "./managerContracts";
import { buildAutonomousExecutionInput } from "./managerContracts";
import {
  buildClarifiedExecutionInput,
  createActiveClarificationState,
  resolveClarificationAnswer
} from "./clarificationBroker";
import { resolveModeContinuityIntent } from "./modeContinuity";
import { resolveConversationIntentMode } from "./intentModeResolution";
import { renderConversationStatusOrRecall } from "./recentActionLedger";
import {
  applyActiveAutonomousPauseRequest,
  applyReturnHandoffPauseRequest
} from "./returnHandoffControl";
import {
  isReturnHandoffContinuationSemanticHint,
  resolveReturnHandoffContinuationIntent
} from "./returnHandoffContinuation";
import {
  buildAutonomousInitialExecutionInput,
  buildLocalIntentSessionHints,
  toContinuityConfidence
} from "./conversationRoutingSupport";
import { enqueueFollowUpLinkedToPriorAssistantPrompt } from "./conversationRoutingQueueSupport";
import { renderSkillInventory } from "../../organs/skillRegistry/skillInspection";
import { renderCapabilityDiscoveryResponse } from "./capabilityIntrospectionRendering";
export interface ConversationEnqueueResult {
  reply: string;
  shouldStartWorker: boolean;
}
export interface ConversationRoutingDependencies {
  followUpRuleContext: FollowUpRuleContext;
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes;
  queryContinuityFacts?: QueryConversationContinuityFacts;
  listAvailableSkills?: ListAvailableSkills;
  describeRuntimeCapabilities?: DescribeRuntimeCapabilities;
  listManagedProcessSnapshots?: ListManagedProcessSnapshots;
  listBrowserSessionSnapshots?: ListBrowserSessionSnapshots;
  localIntentModelResolver?: LocalIntentModelResolver;
  abortActiveAutonomousRun?(): boolean;
  config: {
    allowAutonomousViaInterface: boolean;
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
 * Resolves one canonical front-door routing decision for a user turn, including active
 * clarification handling, natural capability discovery, and safe execution-input assembly.
 *
 * @param session - Current mutable conversation session.
 * @param input - Current user input text.
 * @param receivedAt - ISO timestamp for the turn.
 * @param deps - Routing dependencies and enqueue hooks.
 * @param media - Optional normalized media envelope associated with the turn.
 * @returns Queue reply plus worker-start decision for the ingress coordinator.
 */
async function resolveCanonicalConversationRouting(
  session: ConversationSession,
  input: string,
  receivedAt: string,
  deps: ConversationRoutingDependencies,
  media: ConversationInboundMediaEnvelope | null = null
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
        recordUserTurn(session, input, receivedAt, deps.config.maxConversationTurns);
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
          browserSessionSnapshots
        )
      );
      recordUserTurn(session, input, receivedAt, deps.config.maxConversationTurns);
      return enqueueResult;
    }
    recordUserTurn(session, input, receivedAt, deps.config.maxConversationTurns);
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
  const activePauseReply = applyActiveAutonomousPauseRequest(
    session,
    input,
    receivedAt,
    deps.abortActiveAutonomousRun ?? null
  );
  if (activePauseReply) {
    recordUserTurn(session, input, receivedAt, deps.config.maxConversationTurns);
    recordAssistantTurn(session, activePauseReply, receivedAt, deps.config.maxConversationTurns);
    return { reply: activePauseReply, shouldStartWorker: false };
  }
  const pauseReply = applyReturnHandoffPauseRequest(session, input, receivedAt);
  if (pauseReply) {
    recordUserTurn(session, input, receivedAt, deps.config.maxConversationTurns);
    recordAssistantTurn(session, pauseReply, receivedAt, deps.config.maxConversationTurns);
    return { reply: pauseReply, shouldStartWorker: false };
  }
  const resolvedIntentMode = await resolveConversationIntentMode(
    input,
    routingClassification,
    deps.localIntentModelResolver,
    buildLocalIntentSessionHints(session)
  );
  const effectiveIntentMode =
    resolveReturnHandoffContinuationIntent(session, input, resolvedIntentMode) ??
    resolveModeContinuityIntent(session, input, resolvedIntentMode) ??
    resolvedIntentMode;
  const isReturnHandoffResumeIntent = effectiveIntentMode.matchedRuleId === "intent_mode_return_handoff_resume" || effectiveIntentMode.matchedRuleId === "intent_mode_return_handoff_resume_semantic" || isReturnHandoffContinuationSemanticHint(effectiveIntentMode.semanticHint);
  if (effectiveIntentMode.mode === "discover_available_capabilities") {
    recordUserTurn(session, input, receivedAt, deps.config.maxConversationTurns);
    const capabilitySummary = deps.describeRuntimeCapabilities
      ? await deps.describeRuntimeCapabilities()
      : null;
    const skillInventoryText = deps.listAvailableSkills
      ? renderSkillInventory(await deps.listAvailableSkills())
      : null;
    const reply = renderCapabilityDiscoveryResponse({
      capabilitySummary,
      skillInventoryText
    });
    recordAssistantTurn(
      session,
      reply,
      receivedAt,
      deps.config.maxConversationTurns
    );
    setModeContinuity(session, {
      activeMode: "discover_available_capabilities",
      source: "natural_intent",
      confidence: toContinuityConfidence(effectiveIntentMode.confidence),
      lastAffirmedAt: receivedAt,
      lastUserInput: input
    });
    return {
      reply,
      shouldStartWorker: false
    };
  }
  if (effectiveIntentMode.mode === "status_or_recall") {
    recordUserTurn(session, input, receivedAt, deps.config.maxConversationTurns);
    const reply = renderConversationStatusOrRecall(session, input, effectiveIntentMode.semanticHint ?? null);
    recordAssistantTurn(
      session,
      reply,
      receivedAt,
      deps.config.maxConversationTurns
    );
    setModeContinuity(session, {
      activeMode: "status_or_recall",
      source: "natural_intent",
      confidence: toContinuityConfidence(effectiveIntentMode.confidence),
      lastAffirmedAt: receivedAt,
      lastUserInput: input
    });
    return {
      reply,
      shouldStartWorker: false
    };
  }
  if (effectiveIntentMode.clarification) {
    const clarificationState = createActiveClarificationState(
      input,
      receivedAt,
      effectiveIntentMode.clarification
    );
    setActiveClarification(session, clarificationState);
    setProgressState(session, {
      status: "waiting_for_user",
      message: clarificationState.question,
      jobId: null,
      updatedAt: receivedAt
    });
    recordUserTurn(session, input, receivedAt, deps.config.maxConversationTurns);
    recordAssistantTurn(
      session,
      clarificationState.question,
      receivedAt,
      deps.config.maxConversationTurns
    );
    return {
      reply: clarificationState.question,
      shouldStartWorker: false
    };
  }
  if (effectiveIntentMode.mode === "autonomous") {
    if (!deps.config.allowAutonomousViaInterface) {
      const reply =
        "End-to-end autonomous runs are turned off in this environment right now. If you want, tell me to build it now and I'll do a normal run.";
      recordUserTurn(session, input, receivedAt, deps.config.maxConversationTurns);
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
        browserSessionSnapshots
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
    recordUserTurn(session, input, receivedAt, deps.config.maxConversationTurns);
    setModeContinuity(session, {
      activeMode: "autonomous",
      source: "natural_intent",
      confidence: toContinuityConfidence(effectiveIntentMode.confidence),
      lastAffirmedAt: receivedAt,
      lastUserInput: input
    });
    return {
      reply:
        isReturnHandoffResumeIntent
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
      browserSessionSnapshots
    )
  );
  recordUserTurn(session, input, receivedAt, deps.config.maxConversationTurns);
  if (effectiveIntentMode.mode !== "chat" && effectiveIntentMode.mode !== "unclear") {
    setModeContinuity(session, {
      activeMode: effectiveIntentMode.mode,
      source: "natural_intent",
      confidence: toContinuityConfidence(effectiveIntentMode.confidence),
      lastAffirmedAt: receivedAt,
      lastUserInput: input
    });
  }
  return isReturnHandoffResumeIntent
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
      deps
    );
  }
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

  const followUpLinkedToPriorAssistantPrompt =
    followUpResolution.classification.isShortFollowUp
    && followUpResolution.executionInput !== normalizedInput;

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
    deps
  );
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
  deps: ConversationRoutingDependencies,
  media: ConversationInboundMediaEnvelope | null = null
): Promise<ConversationEnqueueResult> {
  if (session.activeClarification) {
    return resolveCanonicalConversationRouting(
      session,
      input,
      receivedAt,
      deps,
      media
    );
  }

  const followUpResolution = resolveFollowUpInput(
    session,
    input,
    deps.followUpRuleContext
  );
  const routingClassification = classifyRoutingIntentV1(input);
  recordClassifierEvent(
    session,
    input,
    receivedAt,
    followUpResolution.classification
  );

  const followUpLinkedToPriorAssistantPrompt =
    followUpResolution.classification.isShortFollowUp
    && followUpResolution.executionInput !== input;

  if (followUpLinkedToPriorAssistantPrompt) {
    return enqueueFollowUpLinkedToPriorAssistantPrompt(
      session,
      input,
      followUpResolution.executionInput,
      receivedAt,
      routingClassification,
      deps,
      media
    );
  }

  return resolveCanonicalConversationRouting(
    session,
    input,
    receivedAt,
    deps,
    media
  );
}
