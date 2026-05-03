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
  IdentityInterpretationResolver,
  RelationshipInterpretationResolver
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
  OpenConversationContinuityReadSession,
  QueryConversationContinuityEpisodes,
  QueryConversationContinuityFacts,
  RememberConversationProfileInput,
  RunDirectConversationTurn
} from "./managerContracts";
import { createActiveClarificationState } from "./clarificationBroker";
import {
  analyzeConversationChatTurnSignals,
  isMixedConversationMemoryStatusRecallTurn
} from "./chatTurnSignals";
import {
  renderClarificationQuestionText,
  toClarificationPromptDescriptor
} from "./clarificationPrompting";
import { toContinuityConfidence } from "./conversationRoutingSupport";
import type { ResolvedConversationIntentMode } from "./intentModeContracts";
import { renderMixedConversationMemoryStatusRecall } from "./mixedMemoryStatusRecall";
import { renderConversationStatusOrRecall } from "./recentActionLedger";
import { applyConversationDomainSignalWindowForTurn } from "./sessionDomainRouting";
import {
  extractExecutionPreferences,
  isNaturalAutonomousExecutionRequest
} from "./executionPreferenceExtraction";

/**
 * Renders natural clarification question.
 *
 * **Why it exists:**
 * Keeps this module's deterministic runtime behavior behind a named, reviewable boundary.
 *
 * **What it talks to:**
 * - Uses `analyzeConversationChatTurnSignals` (import `analyzeConversationChatTurnSignals`) from `./chatTurnSignals`.
 * - Uses `renderClarificationQuestionText` (import `renderClarificationQuestionText`) from `./clarificationPrompting`.
 * - Uses `toClarificationPromptDescriptor` (import `toClarificationPromptDescriptor`) from `./clarificationPrompting`.
 * - Uses `extractExecutionPreferences` (import `extractExecutionPreferences`) from `./executionPreferenceExtraction`.
 * - Uses `isNaturalAutonomousExecutionRequest` (import `isNaturalAutonomousExecutionRequest`) from `./executionPreferenceExtraction`.
 * @param input - Input consumed by this helper.
 * @returns Result produced by this helper.
 */
async function renderNaturalClarificationQuestion(
  input: ConversationRoutingInlineReplyInput
): Promise<string | null> {
  const clarification = input.effectiveIntentMode.clarification;
  if (
    !clarification ||
    typeof input.deps.runDirectConversationTurn !== "function"
  ) {
    return null;
  }
  const executionPreferences = extractExecutionPreferences(input.userInput);
  const chatSignals = analyzeConversationChatTurnSignals(input.userInput);
  if (
    executionPreferences.executeNow ||
    executionPreferences.autonomousExecution ||
    isNaturalAutonomousExecutionRequest(input.userInput) ||
    (chatSignals.containsWorkflowCue && chatSignals.containsRelationshipCue)
  ) {
    return null;
  }
  return renderClarificationQuestionText(
    toClarificationPromptDescriptor(input.userInput, clarification),
    input.receivedAt,
    input.deps.runDirectConversationTurn
  );
}

export interface ConversationRoutingInlineReplyDependencies {
  config: {
    maxConversationTurns: number;
    maxContextTurnsForExecution: number;
  };
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes;
  queryContinuityFacts?: QueryConversationContinuityFacts;
  openContinuityReadSession?: OpenConversationContinuityReadSession;
  rememberConversationProfileInput?: RememberConversationProfileInput;
  listAvailableSkills?: ListAvailableSkills;
  describeRuntimeCapabilities?: DescribeRuntimeCapabilities;
  getEntityGraph?: GetConversationEntityGraph;
  memoryAccessAuditStore?: import("../../core/memoryAccessAudit").MemoryAccessAuditStore;
  directCasualChatEnabled?: boolean;
  runDirectConversationTurn?: RunDirectConversationTurn;
  identityInterpretationResolver?: IdentityInterpretationResolver;
  relationshipInterpretationResolver?: RelationshipInterpretationResolver;
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
      input.effectiveIntentMode.mode,
      input.effectiveIntentMode.semanticRoute ?? null
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
      input.effectiveIntentMode.mode,
      input.effectiveIntentMode.semanticRoute ?? null
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

  if (isMixedConversationMemoryStatusRecallTurn(input.userInput)) {
    const deterministicMixedRecallReply = await renderMixedConversationMemoryStatusRecall({
      session: input.session,
      userInput: input.userInput,
      queryContinuityFacts: input.deps.queryContinuityFacts,
      queryContinuityEpisodes: input.deps.queryContinuityEpisodes
    });
    if (deterministicMixedRecallReply) {
      applyConversationDomainSignalWindowForTurn(
        input.session,
        input.userInput,
        input.receivedAt,
        input.routingClassification,
        "status_or_recall",
        input.effectiveIntentMode.semanticRoute ?? null
      );
      return buildRecordedReply({
        session: input.session,
        userInput: input.userInput,
        reply: deterministicMixedRecallReply,
        receivedAt: input.receivedAt,
        maxConversationTurns: input.deps.config.maxConversationTurns,
        activeMode: "status_or_recall",
        confidence: toContinuityConfidence(input.effectiveIntentMode.confidence)
      });
    }
    if (typeof input.deps.runDirectConversationTurn !== "function") {
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
        "status_or_recall",
        input.effectiveIntentMode.semanticRoute ?? null
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
  }

  if (input.effectiveIntentMode.mode === "status_or_recall") {
    const directConversationRunner = input.deps.runDirectConversationTurn;
    const shouldDirectMixedStatusRecallConversation =
      input.deps.directCasualChatEnabled !== false &&
      typeof directConversationRunner === "function" &&
      isMixedConversationMemoryStatusRecallTurn(input.userInput);
    if (shouldDirectMixedStatusRecallConversation) {
      const reply = await buildDirectCasualConversationReply({
        session: input.session,
        input: input.userInput,
        media: input.media ?? null,
        receivedAt: input.receivedAt,
        maxContextTurnsForExecution: input.deps.config.maxContextTurnsForExecution,
        routingClassification: input.routingClassification,
        queryContinuityEpisodes: input.deps.queryContinuityEpisodes,
        queryContinuityFacts: input.deps.queryContinuityFacts,
        openContinuityReadSession: input.deps.openContinuityReadSession,
        rememberConversationProfileInput: input.deps.rememberConversationProfileInput,
        identityInterpretationResolver: input.deps.identityInterpretationResolver,
        relationshipInterpretationResolver: input.deps.relationshipInterpretationResolver,
        contextualReferenceInterpretationResolver:
          input.deps.contextualReferenceInterpretationResolver,
        entityReferenceInterpretationResolver:
          input.deps.entityReferenceInterpretationResolver,
        getEntityGraph: input.deps.getEntityGraph,
        memoryAccessAuditStore: input.deps.memoryAccessAuditStore,
        managedProcessSnapshots: input.managedProcessSnapshots,
        semanticHint: input.effectiveIntentMode.semanticHint ?? null,
        browserSessionSnapshots: input.browserSessionSnapshots,
        runDirectConversationTurn: directConversationRunner
      });
      applyConversationDomainSignalWindowForTurn(
        input.session,
        input.userInput,
        input.receivedAt,
        input.routingClassification,
        input.effectiveIntentMode.mode,
        input.effectiveIntentMode.semanticRoute ?? null
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
      input.effectiveIntentMode.mode,
      input.effectiveIntentMode.semanticRoute ?? null
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
    const renderedClarificationQuestion =
      await renderNaturalClarificationQuestion(input);
    const clarificationState = createActiveClarificationState(
      input.userInput,
      input.receivedAt,
      {
        ...input.effectiveIntentMode.clarification,
        question:
          renderedClarificationQuestion ??
          input.effectiveIntentMode.clarification.question
      }
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
      input.effectiveIntentMode.mode,
      input.effectiveIntentMode.semanticRoute ?? null
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
    openContinuityReadSession: input.deps.openContinuityReadSession,
    rememberConversationProfileInput: input.deps.rememberConversationProfileInput,
    identityInterpretationResolver: input.deps.identityInterpretationResolver,
    relationshipInterpretationResolver: input.deps.relationshipInterpretationResolver,
    contextualReferenceInterpretationResolver: input.deps.contextualReferenceInterpretationResolver,
    entityReferenceInterpretationResolver: input.deps.entityReferenceInterpretationResolver,
    getEntityGraph: input.deps.getEntityGraph,
    memoryAccessAuditStore: input.deps.memoryAccessAuditStore,
    managedProcessSnapshots: input.managedProcessSnapshots,
    semanticHint: input.effectiveIntentMode.semanticHint ?? null,
    semanticRouteId: input.effectiveIntentMode.semanticRouteId ?? null,
    semanticRoute: input.effectiveIntentMode.semanticRoute ?? null,
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
    input.effectiveIntentMode.mode,
    input.effectiveIntentMode.semanticRoute ?? null
  );
  return {
    reply,
    shouldStartWorker: false
  };
}
