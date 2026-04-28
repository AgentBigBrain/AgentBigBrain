/**
 * @fileoverview Shared direct-reply helpers for ordinary conversation and capability discovery.
 */

import { hasConversationalProfileUpdateSignal } from "../../core/profileMemoryRuntime/profileMemoryConversationalSignals";
import type { MemoryAccessAuditStore } from "../../core/memoryAccessAudit";
import type { ProfileMemoryRequestTelemetry } from "../../core/profileMemoryRuntime/contracts";
import {
  createProfileMemoryRequestTelemetry
} from "../../core/profileMemoryRuntime/profileMemoryRequestTelemetry";
import { appendMemoryAccessAudit } from "../../organs/memoryContext/auditEvents";
import { buildConversationAwareExecutionInput } from "../conversationExecutionInputPolicy";
import {
  recordAssistantTurn,
  recordUserTurn,
  setModeContinuity
} from "../conversationSessionMutations";
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
import { renderSkillInventory } from "../../organs/skillRegistry/skillInspection";
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
import type {
  ConversationSemanticRouteMetadata,
  ConversationSemanticRouteId,
  ConversationIntentSemanticHint,
  ResolvedConversationIntentMode
} from "./intentModeContracts";
import {
  normalizeOrdinaryMemoryAnswerSurface,
  stripLabelStyleOpening
} from "../userFacing/languageSurface";
import {
  buildCapabilityDiscoveryConversationInput,
  renderCapabilityDiscoveryResponse
} from "./capabilityIntrospectionRendering";
import {
  buildDirectConversationReplyInput,
  enforceDirectConversationReplyFormat
} from "./conversationRoutingDirectRepliesSupport";
import {
  buildDeterministicSelfIdentityDeclarationReply,
  buildDeterministicSelfIdentityReply,
  buildModelAssistedSelfIdentityReply
} from "./selfIdentityPrompting";
import { buildConversationProfileMemoryWriteRequest } from "./conversationProfileMemoryWrite";

export interface DirectCasualConversationReplyInput {
  session: ConversationSession;
  input: string;
  receivedAt: string;
  maxContextTurnsForExecution: number;
  routingClassification: RoutingMapClassificationV1 | null;
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes;
  queryContinuityFacts?: QueryConversationContinuityFacts;
  openContinuityReadSession?: OpenConversationContinuityReadSession;
  rememberConversationProfileInput?: RememberConversationProfileInput;
  identityInterpretationResolver?: IdentityInterpretationResolver;
  contextualReferenceInterpretationResolver?: ContextualReferenceInterpretationResolver;
  entityReferenceInterpretationResolver?: EntityReferenceInterpretationResolver;
  getEntityGraph?: GetConversationEntityGraph;
  memoryAccessAuditStore?: MemoryAccessAuditStore;
  media: ConversationInboundMediaEnvelope | null;
  managedProcessSnapshots?: readonly ManagedProcessSnapshot[];
  semanticHint?: ConversationIntentSemanticHint | null;
  semanticRouteId?: ConversationSemanticRouteId | null;
  semanticRoute?: ConversationSemanticRouteMetadata | null;
  browserSessionSnapshots?: readonly BrowserSessionSnapshot[];
  runDirectConversationTurn: RunDirectConversationTurn;
}

export interface CapabilityDiscoveryReplyInput {
  userInput: string;
  receivedAt: string;
  describeRuntimeCapabilities?: DescribeRuntimeCapabilities;
  listAvailableSkills?: ListAvailableSkills;
  runDirectConversationTurn?: RunDirectConversationTurn;
}

export interface RecordedReplyInput {
  session: ConversationSession;
  userInput: string;
  reply: string;
  receivedAt: string;
  maxConversationTurns: number;
  activeMode?:
    | "discover_available_capabilities"
    | "status_or_recall";
  confidence?: "LOW" | "MED" | "HIGH";
}

/**
 * Persists bounded conversational profile updates through the canonical profile-memory seam before
 * the generic direct-chat model path runs.
 *
 * @param userInput - Raw conversational user wording.
 * @param receivedAt - Observation timestamp for the current turn.
 * @param rememberConversationProfileInput - Optional canonical profile-memory write helper.
 */
async function rememberDirectConversationProfileInputIfNeeded(
  session: ConversationSession,
  userInput: string,
  receivedAt: string,
  rememberConversationProfileInput?: RememberConversationProfileInput
): Promise<void> {
  if (
    typeof rememberConversationProfileInput !== "function" ||
    !hasConversationalProfileUpdateSignal(userInput)
  ) {
    return;
  }
  await rememberConversationProfileInput(
    buildConversationProfileMemoryWriteRequest({
      session,
      userInput,
      receivedAt
    }),
    receivedAt
  ).catch(() => false);
}

/**
 * Persists one bounded self-identity telemetry snapshot when the direct chat path evaluated
 * identity safety or parity.
 *
 * @param input - Direct-reply dependencies and request metadata.
 * @param requestTelemetry - Request-scoped telemetry collected on the direct self-identity path.
 */
async function recordDirectSelfIdentityAuditIfNeeded(
  input: Pick<
    DirectCasualConversationReplyInput,
    "input" | "receivedAt" | "memoryAccessAuditStore"
  >,
  requestTelemetry: ProfileMemoryRequestTelemetry
): Promise<void> {
  if (
    !input.memoryAccessAuditStore ||
    (
      requestTelemetry.identitySafetyDecisionCount === 0 &&
      requestTelemetry.selfIdentityParityCheckCount === 0
    )
  ) {
    return;
  }
  await appendMemoryAccessAudit(
    input.memoryAccessAuditStore,
    `direct_self_identity:${input.receivedAt}`,
    input.input,
    0,
    0,
    0,
    ["profile"],
    {
      storeLoadCount: requestTelemetry.storeLoadCount,
      retrievalOperationCount: requestTelemetry.retrievalOperationCount,
      identitySafetyDecisionCount: requestTelemetry.identitySafetyDecisionCount,
      selfIdentityParityCheckCount: requestTelemetry.selfIdentityParityCheckCount,
      selfIdentityParityMismatchCount: requestTelemetry.selfIdentityParityMismatchCount
    }
  );
}

/**
 * Persists one bounded ordinary-chat memory prompt telemetry snapshot when direct recall context
 * exercised retrieval, synthesis, render, or prompt-surface cutover logic.
 *
 * @param input - Direct-reply dependencies and request metadata.
 * @param requestTelemetry - Request-scoped telemetry collected on the ordinary-chat prompt path.
 */
async function recordDirectPromptMemoryAuditIfNeeded(
  input: Pick<
    DirectCasualConversationReplyInput,
    "input" | "receivedAt" | "memoryAccessAuditStore"
  >,
  requestTelemetry: ProfileMemoryRequestTelemetry
): Promise<void> {
  if (
    !input.memoryAccessAuditStore ||
    (
      requestTelemetry.retrievalOperationCount === 0 &&
      requestTelemetry.synthesisOperationCount === 0 &&
      requestTelemetry.renderOperationCount === 0 &&
      requestTelemetry.promptMemorySurfaceCount === 0 &&
      requestTelemetry.identitySafetyDecisionCount === 0
    )
  ) {
    return;
  }
  await appendMemoryAccessAudit(
    input.memoryAccessAuditStore,
    `direct_memory_prompt:${input.receivedAt}`,
    input.input,
    0,
    0,
    0,
    ["profile"],
    {
      storeLoadCount: requestTelemetry.storeLoadCount,
      retrievalOperationCount: requestTelemetry.retrievalOperationCount,
      synthesisOperationCount: requestTelemetry.synthesisOperationCount,
      renderOperationCount: requestTelemetry.renderOperationCount,
      promptMemoryOwnerCount: requestTelemetry.promptMemoryOwnerCount,
      promptMemorySurfaceCount: requestTelemetry.promptMemorySurfaceCount,
      mixedMemoryOwnerDecisionCount: requestTelemetry.mixedMemoryOwnerDecisionCount,
      identitySafetyDecisionCount: requestTelemetry.identitySafetyDecisionCount,
      selfIdentityParityCheckCount: requestTelemetry.selfIdentityParityCheckCount,
      selfIdentityParityMismatchCount: requestTelemetry.selfIdentityParityMismatchCount
    }
  );
}

/**
 * Builds the direct conversation reply without queueing worker execution.
 *
 * @param input - Direct conversation reply dependencies.
 * @returns Model-authored conversational reply text.
 */
export async function buildDirectCasualConversationReply(
  input: DirectCasualConversationReplyInput
): Promise<string> {
  const requestTelemetry = createProfileMemoryRequestTelemetry();
  const deterministicSelfIdentityDeclarationReply =
    await buildDeterministicSelfIdentityDeclarationReply(
      input.input,
      input.receivedAt,
      input.rememberConversationProfileInput,
      input.session,
      requestTelemetry
    );
  if (deterministicSelfIdentityDeclarationReply) {
    await recordDirectSelfIdentityAuditIfNeeded(input, requestTelemetry);
    return deterministicSelfIdentityDeclarationReply;
  }
  const modelAssistedSelfIdentityReply =
    await buildModelAssistedSelfIdentityReply(
      input.session,
      input.input,
      input.receivedAt,
      input.routingClassification,
      input.queryContinuityFacts,
      input.rememberConversationProfileInput,
      input.identityInterpretationResolver,
      requestTelemetry
    );
  if (modelAssistedSelfIdentityReply) {
    await recordDirectSelfIdentityAuditIfNeeded(input, requestTelemetry);
    return modelAssistedSelfIdentityReply;
  }
  const deterministicSelfIdentityReply = await buildDeterministicSelfIdentityReply(
    input.session,
    input.input,
    input.queryContinuityFacts,
    requestTelemetry
  );
  if (deterministicSelfIdentityReply) {
    await recordDirectSelfIdentityAuditIfNeeded(input, requestTelemetry);
    return deterministicSelfIdentityReply;
  }
  await rememberDirectConversationProfileInputIfNeeded(
    input.session,
    input.input,
    input.receivedAt,
    input.rememberConversationProfileInput
  );
  const profileUpdateSignal =
    hasConversationalProfileUpdateSignal(input.input) &&
    !/[?]/.test(input.input);
  const baseSemanticRoute = input.semanticRoute ?? null;
  const semanticRouteForMemory =
    profileUpdateSignal && baseSemanticRoute
      ? {
        ...baseSemanticRoute,
        memoryIntent: "profile_update" as const,
        continuationKind: "relationship_memory" as const
      }
      : baseSemanticRoute?.memoryIntent === "none"
        ? null
        : baseSemanticRoute;
  const semanticRouteIdForMemory =
    semanticRouteForMemory?.routeId ??
    (baseSemanticRoute ? null : input.semanticRouteId ?? null);
  const conversationAwareInput = await buildConversationAwareExecutionInput(
    input.session,
    input.input,
    input.maxContextTurnsForExecution,
    input.routingClassification,
    input.input,
    input.queryContinuityEpisodes,
    input.queryContinuityFacts,
    input.media,
    input.managedProcessSnapshots,
    input.semanticHint ?? null,
    input.browserSessionSnapshots,
    input.contextualReferenceInterpretationResolver,
    input.getEntityGraph,
    input.entityReferenceInterpretationResolver,
    input.openContinuityReadSession,
    requestTelemetry,
    semanticRouteIdForMemory,
    null,
    semanticRouteForMemory,
    profileUpdateSignal
  );
  await recordDirectPromptMemoryAuditIfNeeded(input, requestTelemetry);
  const directConversationInput = buildDirectConversationReplyInput(
    input.input,
    conversationAwareInput
  );
  return enforceDirectConversationReplyFormat(
    input.input,
    normalizeOrdinaryMemoryAnswerSurface(
      stripLabelStyleOpening(
        (await input.runDirectConversationTurn(
          directConversationInput,
          input.receivedAt,
          input.session
        ))?.summary.trim() ?? ""
      )
    )
  );
}

/**
 * Builds a natural capability-discovery reply, preferring the direct conversation synthesizer.
 *
 * @param input - Capability discovery dependencies.
 * @returns Capability discovery reply text.
 */
export async function buildCapabilityDiscoveryReply(
  input: CapabilityDiscoveryReplyInput
): Promise<string> {
  const capabilitySummary = input.describeRuntimeCapabilities
    ? await input.describeRuntimeCapabilities()
    : null;
  const skillInventoryText = input.listAvailableSkills
    ? renderSkillInventory(await input.listAvailableSkills())
    : null;
  const capabilityDiscoveryInput = {
    capabilitySummary,
    skillInventoryText
  };
  const directReply = input.runDirectConversationTurn
    ? stripLabelStyleOpening((
        await input.runDirectConversationTurn(
          buildCapabilityDiscoveryConversationInput(
            input.userInput,
            capabilityDiscoveryInput
          ),
          input.receivedAt
        )
      )?.summary.trim() ?? "")
    : "";
  return directReply || renderCapabilityDiscoveryResponse(capabilityDiscoveryInput);
}

/**
 * Returns `true` when the resolved intent signal means "pick that back up from the saved handoff".
 *
 * @param intentMode - Final resolved intent mode for this user turn.
 * @returns `true` when the turn should reuse the saved return-handoff checkpoint.
 */
export function isReturnHandoffResumeIntent(
  intentMode: ResolvedConversationIntentMode
): boolean {
  return (
    intentMode.matchedRuleId === "intent_mode_return_handoff_resume" ||
    intentMode.matchedRuleId === "intent_mode_return_handoff_resume_semantic" ||
    intentMode.semanticHint === "resume_handoff"
  );
}

/**
 * Records a synchronous reply turn and optional mode continuity update.
 *
 * @param input - Reply text plus session mutation metadata.
 * @returns Stable no-worker reply result for routing call sites.
 */
export function buildRecordedReply(
  input: RecordedReplyInput
): { reply: string; shouldStartWorker: false } {
  recordUserTurn(
    input.session,
    input.userInput,
    input.receivedAt,
    input.maxConversationTurns
  );
  recordAssistantTurn(
    input.session,
    input.reply,
    input.receivedAt,
    input.maxConversationTurns
  );
  if (input.activeMode && input.confidence) {
    setModeContinuity(input.session, {
      activeMode: input.activeMode,
      source: "natural_intent",
      confidence: input.confidence,
      lastAffirmedAt: input.receivedAt,
      lastUserInput: input.userInput
    });
  }
  return {
    reply: input.reply,
    shouldStartWorker: false
  };
}
