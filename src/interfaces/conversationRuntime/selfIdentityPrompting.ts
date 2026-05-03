/**
 * @fileoverview Builds bounded self-identity recall context and model-assisted identity replies for direct conversational turns.
 */

import { extractPreferredNameValuesFromUserInput } from "../../core/profileMemoryRuntime/profileMemoryExtraction";
import type {
  ProfileMemoryRequestTelemetry,
  ProfileValidatedFactCandidateInput
} from "../../core/profileMemoryRuntime/contracts";
import {
  recordProfileMemoryIdentitySafetyDecision,
  recordProfileMemoryRenderOperation,
  recordProfileMemorySelfIdentityParity
} from "../../core/profileMemoryRuntime/profileMemoryRequestTelemetry";
import type { IdentityInterpretationResolver } from "../../organs/languageUnderstanding/localIntentModelContracts";
import { routeIdentityInterpretationModel } from "../../organs/languageUnderstanding/localIntentModelRouter";
import {
  analyzeConversationChatTurnSignals,
  assessIdentityInterpretationEligibility
} from "./chatTurnSignals";
import type {
  QueryConversationContinuityFacts,
  RememberConversationProfileInput
} from "./managerContracts";
import type { ConversationSession } from "../sessionStore";
import type { RoutingMapClassificationV1 } from "../routingMap";
import { buildConversationProfileMemoryWriteRequest } from "./conversationProfileMemoryWrite";
import { buildLocalIntentSessionHints } from "./conversationRoutingSupport";
import {
  buildIdentityInterpretationFallbackReply,
  buildPreferredNameValidatedFactCandidate,
  isSimpleDeterministicSelfIdentityDeclaration,
  resolveRecentAssistantTurn,
  validateInterpretedPreferredNameCandidate
} from "./selfIdentityInterpretationSupport";
import {
  hasSelfIdentityParity,
  resolveConversationTransportProvider,
  resolveSelfIdentityRecallContext
} from "./selfIdentityPromptingSupport";

/**
 * Returns the strongest canonical preferred-name declaration present in raw user wording.
 *
 * @param userInput - Raw current user wording.
 * @returns Preferred-name declaration value, or `null` when none is present.
 */
export function extractSelfIdentityDeclarationValue(
  userInput: string
): string | null {
  return extractPreferredNameValuesFromUserInput(userInput)[0] ?? null;
}

/**
 * Builds a model-assisted direct-chat reply for ambiguous or unsupported self-identity turns while
 * keeping deterministic validation and canonical persistence in control.
 *
 * @param session - Conversation session carrying continuity and recent-turn context.
 * @param userInput - Raw current user wording.
 * @param receivedAt - Current turn timestamp.
 * @param routingClassification - Optional deterministic routing hint for the same turn.
 * @param queryContinuityFacts - Optional bounded fact lookup helper for self-identity recall.
 * @param rememberConversationProfileInput - Optional canonical profile-memory write helper.
 * @param identityInterpretationResolver - Optional bounded local identity interpreter.
 * @returns Stable direct reply when the turn was handled on the identity path, otherwise `null`.
 */
export async function buildModelAssistedSelfIdentityReply(
  session: ConversationSession,
  userInput: string,
  receivedAt: string,
  routingClassification: RoutingMapClassificationV1 | null,
  queryContinuityFacts?: QueryConversationContinuityFacts,
  rememberConversationProfileInput?: RememberConversationProfileInput,
  identityInterpretationResolver?: IdentityInterpretationResolver,
  requestTelemetry?: ProfileMemoryRequestTelemetry
): Promise<string | null> {
  const sessionHints = buildLocalIntentSessionHints(session);
  const eligibility = assessIdentityInterpretationEligibility(userInput, {
    recentAssistantIdentityPrompt: sessionHints?.hasRecentAssistantIdentityPrompt,
    recentAssistantIdentityAnswer: sessionHints?.hasRecentAssistantIdentityAnswer,
    recentIdentityConversationActive: sessionHints?.recentIdentityConversationActive
  });
  if (
    !eligibility.eligible ||
    !eligibility.reason ||
    eligibility.reason === "self_identity_query" ||
    eligibility.reason === "assistant_identity_query"
  ) {
    return null;
  }
  recordProfileMemoryIdentitySafetyDecision(requestTelemetry);
  const interpretedIdentity = await routeIdentityInterpretationModel(
    {
      userInput,
      routingClassification,
      sessionHints,
      recentAssistantTurn: resolveRecentAssistantTurn(session)
    },
    identityInterpretationResolver
  );
  if (
    !interpretedIdentity ||
    interpretedIdentity.confidence === "low"
  ) {
    return buildIdentityInterpretationFallbackReply(eligibility.reason);
  }

  if (interpretedIdentity.kind === "self_identity_query") {
    return buildDeterministicSelfIdentityReply(
      session,
      userInput,
      queryContinuityFacts,
      requestTelemetry
    );
  }
  if (interpretedIdentity.kind === "assistant_identity_query") {
    return "I'm BigBrain.";
  }
  if (
    interpretedIdentity.kind !== "self_identity_declaration" ||
    interpretedIdentity.shouldPersist !== true
  ) {
    return buildIdentityInterpretationFallbackReply(eligibility.reason);
  }

  const preferredName = validateInterpretedPreferredNameCandidate(
    interpretedIdentity.candidateValue
  );
  if (!preferredName) {
    const deterministicCandidate = validateInterpretedPreferredNameCandidate(
      extractSelfIdentityDeclarationValue(userInput)
    );
    if (deterministicCandidate) {
      recordProfileMemorySelfIdentityParity(requestTelemetry, false);
    }
    return buildIdentityInterpretationFallbackReply(eligibility.reason);
  }
  const deterministicCandidate = validateInterpretedPreferredNameCandidate(
    extractSelfIdentityDeclarationValue(userInput)
  );
  if (deterministicCandidate) {
    recordProfileMemorySelfIdentityParity(
      requestTelemetry,
      hasSelfIdentityParity(deterministicCandidate, preferredName)
    );
  }

  const remembered =
    typeof rememberConversationProfileInput === "function"
      ? await rememberConversationProfileInput(
          buildConversationProfileMemoryWriteRequest({
            session,
            receivedAt,
            memoryIntent: "profile_update",
            validatedFactCandidates: [
              buildPreferredNameValidatedFactCandidate(
                preferredName,
                interpretedIdentity.confidence === "high" ? 0.98 : 0.95
              )
            ].filter((candidate): candidate is ProfileValidatedFactCandidateInput => Boolean(candidate))
          }),
          receivedAt
        ).catch(() => false)
      : false;
  return remembered
    ? `Okay, I'll remember that you're ${preferredName}.`
    : `Okay, I'll use ${preferredName}.`;
}

/**
 * Builds a bounded identity-recall block for direct conversational self-identity turns.
 *
 * @param session - Conversation session providing continuity state and transport hints.
 * @param userInput - Raw current user wording.
 * @param queryContinuityFacts - Optional bounded continuity-fact query capability.
 * @returns Identity guidance block, or `null` when the turn is not self-identity recall.
 */
export async function buildSelfIdentityRecallBlock(
  session: ConversationSession,
  userInput: string,
  queryContinuityFacts?: QueryConversationContinuityFacts,
  requestTelemetry?: ProfileMemoryRequestTelemetry
): Promise<string | null> {
  const signals = analyzeConversationChatTurnSignals(userInput);
  if (signals.primaryKind !== "self_identity_query") {
    return null;
  }

  const identityFactGuardLines = [
    "Direct self-identity recall context:",
    "- The user is asking about their own name or identity.",
    "- Prefer confirmed identity facts over transport metadata.",
    "- Do not guess from filesystem paths, workspace names, or stale workflow artifacts."
  ];
  const { identityFacts, transportHint, hasFactLookup } = await resolveSelfIdentityRecallContext(
    session,
    queryContinuityFacts,
    requestTelemetry
  );

  if (identityFacts.length > 0) {
    recordProfileMemoryRenderOperation(requestTelemetry);
    return [
      ...identityFactGuardLines,
      "- Known non-sensitive identity facts for this user:",
      ...identityFacts.map(
        (fact) =>
          `- ${fact.key}: ${fact.value} (confidence ${fact.confidence.toFixed(2)}; updated ${fact.lastUpdatedAt})`
      ),
      "- Response rule: answer from these facts when they directly resolve the user's self-identity question.",
      "- Do not say you only know their name 'from this chat' when these facts are present."
    ].join("\n");
  }

  if (transportHint) {
    const transportSource =
      transportHint.source === "display_name"
        ? "transport display name"
        : transportHint.source === "given_name"
          ? "transport given name"
          : "transport username";
    recordProfileMemoryRenderOperation(requestTelemetry);
    return [
      ...identityFactGuardLines,
      "- No confirmed non-sensitive identity facts were found for this user yet.",
      "- Low-confidence transport identity hint:",
      `- Provider: ${resolveConversationTransportProvider(session) ?? "unknown"}`,
      `- Source: ${transportSource}`,
      `- Candidate display name: ${transportHint.value}`,
      `- Raw transport value: ${transportHint.rawValue}`,
      `- Confidence: ${transportHint.confidence}`,
      "- Trust rule: this hint came from transport metadata and is not a stored profile fact.",
      "- Response rule: if you answer from this hint, say it comes from their transport profile/handle and avoid claiming it is confirmed memory."
    ].join("\n");
  }

  const unavailableFactLookupLine =
    hasFactLookup
      ? "- No bounded non-sensitive identity facts were found for this user yet."
      : "- No bounded identity-fact lookup is available in this execution path.";
  recordProfileMemoryRenderOperation(requestTelemetry);
  return [
    ...identityFactGuardLines,
    unavailableFactLookupLine,
    "- Response rule: say you do not know yet instead of inventing or inferring a name."
  ].join("\n");
}

/**
 * Builds a deterministic direct-chat reply for self-identity turns from typed facts or transport hints.
 *
 * @param session - Conversation session carrying continuity facts and transport identity.
 * @param userInput - Raw user wording.
 * @param queryContinuityFacts - Optional bounded fact query helper.
 * @returns Stable direct reply, or `null` when the turn is not self-identity recall.
 */
export async function buildDeterministicSelfIdentityReply(
  session: ConversationSession,
  userInput: string,
  queryContinuityFacts?: QueryConversationContinuityFacts,
  requestTelemetry?: ProfileMemoryRequestTelemetry
): Promise<string | null> {
  const signals = analyzeConversationChatTurnSignals(userInput);
  if (signals.primaryKind !== "self_identity_query") {
    return null;
  }
  recordProfileMemoryIdentitySafetyDecision(requestTelemetry);
  const { identityFacts, transportHint } = await resolveSelfIdentityRecallContext(
    session,
    queryContinuityFacts,
    requestTelemetry
  );
  if (identityFacts.length > 0 && transportHint) {
    recordProfileMemorySelfIdentityParity(
      requestTelemetry,
      hasSelfIdentityParity(identityFacts[0]!.value, transportHint.value)
    );
  }
  if (identityFacts.length > 0) {
    return `You're ${identityFacts[0]!.value}.`;
  }
  if (transportHint) {
    const providerLabel = resolveConversationTransportProvider(session) === "discord"
      ? "Discord"
      : resolveConversationTransportProvider(session) === "telegram"
        ? "Telegram"
        : "profile";
    if (transportHint.source === "username") {
      return `Your ${providerLabel} username looks like ${transportHint.value}, but I don't have that saved as a confirmed name fact yet.`;
    }
    return `Your ${providerLabel} profile shows ${transportHint.value}, but I don't have that saved as a confirmed name fact yet.`;
  }
  return "I don't know your name yet.";
}

/**
 * Builds a deterministic direct-chat reply for self-identity declaration turns and persists the
 * declaration through the canonical profile-memory write seam when available.
 *
 * @param userInput - Raw user wording.
 * @param receivedAt - Current turn timestamp.
 * @param rememberConversationProfileInput - Optional canonical profile-memory write helper.
 * @returns Stable direct reply, or `null` when the turn is not a self-identity declaration.
 */
export async function buildDeterministicSelfIdentityDeclarationReply(
  userInput: string,
  receivedAt: string,
  rememberConversationProfileInput?: RememberConversationProfileInput,
  session?: ConversationSession,
  requestTelemetry?: ProfileMemoryRequestTelemetry
): Promise<string | null> {
  if (!isSimpleDeterministicSelfIdentityDeclaration(userInput)) {
    return null;
  }
  const preferredName = extractSelfIdentityDeclarationValue(userInput);
  if (!preferredName) {
    return null;
  }
  recordProfileMemoryIdentitySafetyDecision(requestTelemetry);

  const remembered =
    typeof rememberConversationProfileInput === "function"
      ? await rememberConversationProfileInput(
          session
            ? buildConversationProfileMemoryWriteRequest({
                session,
                userInput,
                receivedAt,
                memoryIntent: "profile_update",
                validatedFactCandidates: [
                  buildPreferredNameValidatedFactCandidate(preferredName, 0.98)
                ].filter((candidate): candidate is ProfileValidatedFactCandidateInput => Boolean(candidate))
              })
            : userInput,
          receivedAt
        ).catch(() => false)
      : false;
  return remembered
    ? `Okay, I'll remember that you're ${preferredName}.`
    : `Okay, I'll use ${preferredName}.`;
}
