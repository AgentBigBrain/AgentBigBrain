/**
 * @fileoverview Shared direct-reply helpers for ordinary conversation and capability discovery.
 */

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
  QueryConversationContinuityEpisodes,
  QueryConversationContinuityFacts,
  RememberConversationProfileInput,
  RunDirectConversationTurn
} from "./managerContracts";
import type {
  ConversationIntentSemanticHint,
  ResolvedConversationIntentMode
} from "./intentModeContracts";
import { stripLabelStyleOpening } from "../userFacing/languageSurface";
import {
  buildCapabilityDiscoveryConversationInput,
  renderCapabilityDiscoveryResponse
} from "./capabilityIntrospectionRendering";
import {
  buildDeterministicSelfIdentityDeclarationReply,
  buildDeterministicSelfIdentityReply,
  buildModelAssistedSelfIdentityReply
} from "./selfIdentityPrompting";

export interface DirectCasualConversationReplyInput {
  session: ConversationSession;
  input: string;
  receivedAt: string;
  maxContextTurnsForExecution: number;
  routingClassification: RoutingMapClassificationV1 | null;
  queryContinuityEpisodes?: QueryConversationContinuityEpisodes;
  queryContinuityFacts?: QueryConversationContinuityFacts;
  rememberConversationProfileInput?: RememberConversationProfileInput;
  identityInterpretationResolver?: IdentityInterpretationResolver;
  contextualReferenceInterpretationResolver?: ContextualReferenceInterpretationResolver;
  entityReferenceInterpretationResolver?: EntityReferenceInterpretationResolver;
  getEntityGraph?: GetConversationEntityGraph;
  media: ConversationInboundMediaEnvelope | null;
  managedProcessSnapshots?: readonly ManagedProcessSnapshot[];
  semanticHint?: ConversationIntentSemanticHint | null;
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

const DIRECT_CONVERSATION_FORMAT_PATTERN = /\btwo short paragraphs\b/i;
const DIRECT_CONVERSATION_PAUSE_WORK_PATTERN =
  /\b(?:just chat|talk for a minute|do not start work|do not continue(?: the)?(?: [a-z-]+)? workflow|keep this as conversation|without doing new work)\b/i;

/** Adds direct-chat-only control lines to the model input when the user asked for them. */
function buildDirectConversationReplyInput(
  userInput: string,
  conversationAwareInput: string
): string {
  const controlLines: string[] = [];
  if (DIRECT_CONVERSATION_FORMAT_PATTERN.test(userInput)) {
    controlLines.push(
      "Direct reply format requirement: reply in exactly two short paragraphs separated by one blank line."
    );
  }
  if (DIRECT_CONVERSATION_PAUSE_WORK_PATTERN.test(userInput)) {
    controlLines.push(
      "Direct reply intent: answer this as conversation only. Do not continue, summarize, or paraphrase the latest workflow output unless the user explicitly asks for that."
    );
  }
  if (controlLines.length === 0) {
    return conversationAwareInput;
  }
  return `${controlLines.join("\n")}\n\n${conversationAwareInput}`;
}

/** Normalizes direct-chat replies to the requested paragraph format when needed. */
function enforceDirectConversationReplyFormat(
  userInput: string,
  reply: string
): string {
  const normalizedReply = reply.trim();
  if (
    !DIRECT_CONVERSATION_FORMAT_PATTERN.test(userInput) ||
    /\n\s*\n/.test(normalizedReply)
  ) {
    return normalizedReply;
  }
  const sentences = normalizedReply
    .match(/[^.!?]+(?:[.!?]+|$)/g)
    ?.map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0) ?? [];
  if (sentences.length < 2) {
    return normalizedReply;
  }
  const targetLength = normalizedReply.length / 2;
  let bestSplitIndex = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let currentLength = 0;
  for (let index = 0; index < sentences.length - 1; index += 1) {
    currentLength += sentences[index].length + 1;
    const distance = Math.abs(currentLength - targetLength);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestSplitIndex = index + 1;
    }
  }
  return [
    sentences.slice(0, bestSplitIndex).join(" "),
    sentences.slice(bestSplitIndex).join(" ")
  ].join("\n\n");
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
  const deterministicSelfIdentityDeclarationReply =
    await buildDeterministicSelfIdentityDeclarationReply(
      input.input,
      input.receivedAt,
      input.rememberConversationProfileInput
    );
  if (deterministicSelfIdentityDeclarationReply) {
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
      input.identityInterpretationResolver
    );
  if (modelAssistedSelfIdentityReply) {
    return modelAssistedSelfIdentityReply;
  }
  const deterministicSelfIdentityReply = await buildDeterministicSelfIdentityReply(
    input.session,
    input.input,
    input.queryContinuityFacts
  );
  if (deterministicSelfIdentityReply) {
    return deterministicSelfIdentityReply;
  }
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
    input.entityReferenceInterpretationResolver
  );
  const directConversationInput = buildDirectConversationReplyInput(
    input.input,
    conversationAwareInput
  );
  return enforceDirectConversationReplyFormat(
    input.input,
    stripLabelStyleOpening(
      (await input.runDirectConversationTurn(
        directConversationInput,
        input.receivedAt,
        input.session
      ))?.summary.trim() ?? ""
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
