/**
 * @fileoverview Builds bounded self-identity recall context and model-assisted identity replies for direct conversational turns.
 */

import { extractPreferredNameValuesFromUserInput } from "../../core/profileMemoryRuntime/profileMemoryExtraction";
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
  isSimpleDeterministicSelfIdentityDeclaration,
  resolveRecentAssistantTurn,
  validateInterpretedPreferredNameCandidate
} from "./selfIdentityInterpretationSupport";
import {
  buildConversationTransportIdentityRecord,
  selectConversationTransportIdentityNameHint
} from "./transportIdentity";

const SELF_IDENTITY_CONTINUITY_FACT_HINTS = [
  "identity",
  "preferred name",
  "name",
  "call me",
  "go by"
] as const;
const SELF_IDENTITY_FACT_KEY_PRIORITIES = new Map<string, number>([
  ["identity.preferred_name", 0],
  ["identity.display_name", 1],
  ["identity.legal_name", 2],
  ["identity.name", 3]
]);
interface ResolvedSelfIdentityRecallContext {
  identityFacts: Awaited<ReturnType<NonNullable<QueryConversationContinuityFacts>>>;
  transportHint: ReturnType<typeof selectConversationTransportIdentityNameHint>;
  hasFactLookup: boolean;
}

/**
 * Builds a low-confidence username-only transport identity fallback for older sessions that do not
 * yet carry the richer transport-identity record.
 *
 * @param session - Conversation session carrying persisted username metadata.
 * @returns Username-derived transport identity, or `null` when provider inference is unavailable.
 */
function resolveUsernameFallbackIdentity(
  session: ConversationSession
) {
  const providerCandidate = session.conversationId.split(":", 1)[0];
  if (providerCandidate !== "telegram" && providerCandidate !== "discord") {
    return null;
  }
  return buildConversationTransportIdentityRecord({
    provider: providerCandidate,
    username: session.username,
    displayName: null,
    givenName: null,
    familyName: null,
    observedAt: session.updatedAt
  });
}

/**
 * Resolves the conversation transport provider from persisted session metadata for user-facing
 * identity replies.
 *
 * @param session - Conversation session carrying transport/provider metadata.
 * @returns Canonical provider id, or `null` when unknown.
 */
function resolveConversationTransportProvider(session: ConversationSession): "telegram" | "discord" | null {
  if (session.transportIdentity?.provider === "telegram" || session.transportIdentity?.provider === "discord") {
    return session.transportIdentity.provider;
  }
  const providerCandidate = session.conversationId.split(":", 1)[0];
  return providerCandidate === "telegram" || providerCandidate === "discord"
    ? providerCandidate
    : null;
}

/**
 * Returns whether one continuity fact key is a direct user-identity fact suitable for self-recall.
 *
 * @param key - Fact key under evaluation.
 * @returns `true` when the key names the user's own identity rather than another topic.
 */
function isSelfIdentityFactKey(key: string): boolean {
  const normalized = key.replace(/\s+/g, " ").trim().toLowerCase();
  return (
    normalized === "identity.preferred_name" ||
    normalized === "identity.display_name" ||
    normalized === "identity.legal_name" ||
    normalized === "identity.name"
  );
}

/**
 * Sorts identity facts so preferred display names win before broader identity fields.
 *
 * @param left - Left fact candidate.
 * @param right - Right fact candidate.
 * @returns Stable priority comparison for direct self-identity answers.
 */
function compareSelfIdentityFacts(
  left: Awaited<ReturnType<NonNullable<QueryConversationContinuityFacts>>>[number],
  right: Awaited<ReturnType<NonNullable<QueryConversationContinuityFacts>>>[number]
): number {
  const leftPriority = SELF_IDENTITY_FACT_KEY_PRIORITIES.get(left.key.toLowerCase()) ?? 99;
  const rightPriority = SELF_IDENTITY_FACT_KEY_PRIORITIES.get(right.key.toLowerCase()) ?? 99;
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }
  return right.lastUpdatedAt.localeCompare(left.lastUpdatedAt);
}

/**
 * Resolves typed self-identity context from confirmed facts first, then transport metadata hints.
 *
 * @param session - Conversation session carrying continuity and transport metadata.
 * @param queryContinuityFacts - Optional bounded fact query helper.
 * @returns Resolved self-identity context for prompt or deterministic reply assembly.
 */
async function resolveSelfIdentityRecallContext(
  session: ConversationSession,
  queryContinuityFacts?: QueryConversationContinuityFacts
): Promise<ResolvedSelfIdentityRecallContext> {
  const stack = session.conversationStack;
  const hasFactLookup = Boolean(stack && queryContinuityFacts);
  const queriedFacts =
    stack && queryContinuityFacts
      ? await queryContinuityFacts({
          stack,
          entityHints: SELF_IDENTITY_CONTINUITY_FACT_HINTS,
          maxFacts: 6
        }).catch(() => [])
      : [];
  return {
    identityFacts: queriedFacts
      .filter((fact) => isSelfIdentityFactKey(fact.key))
      .sort(compareSelfIdentityFacts)
      .slice(0, 3),
    transportHint: selectConversationTransportIdentityNameHint(
      session.transportIdentity ?? resolveUsernameFallbackIdentity(session)
    ),
    hasFactLookup
  };
}

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
  identityInterpretationResolver?: IdentityInterpretationResolver
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
      queryContinuityFacts
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
    return buildIdentityInterpretationFallbackReply(eligibility.reason);
  }

  const remembered =
    typeof rememberConversationProfileInput === "function"
      ? await rememberConversationProfileInput(
          buildConversationProfileMemoryWriteRequest({
            session,
            receivedAt,
            validatedFactCandidates: [
              {
                key: "identity.preferred_name",
                candidateValue: preferredName,
                source: "conversation.identity_interpretation",
                confidence: interpretedIdentity.confidence === "high" ? 0.98 : 0.95
              }
            ]
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
  queryContinuityFacts?: QueryConversationContinuityFacts
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
    queryContinuityFacts
  );

  if (identityFacts.length > 0) {
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
  queryContinuityFacts?: QueryConversationContinuityFacts
): Promise<string | null> {
  const signals = analyzeConversationChatTurnSignals(userInput);
  if (signals.primaryKind !== "self_identity_query") {
    return null;
  }
  const { identityFacts, transportHint } = await resolveSelfIdentityRecallContext(
    session,
    queryContinuityFacts
  );
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
  session?: ConversationSession
): Promise<string | null> {
  if (!isSimpleDeterministicSelfIdentityDeclaration(userInput)) {
    return null;
  }
  const preferredName = extractSelfIdentityDeclarationValue(userInput);
  if (!preferredName) {
    return null;
  }

  const remembered =
    typeof rememberConversationProfileInput === "function"
      ? await rememberConversationProfileInput(
          session
            ? buildConversationProfileMemoryWriteRequest({
                session,
                userInput,
                receivedAt
              })
            : userInput,
          receivedAt
        ).catch(() => false)
      : false;
  return remembered
    ? `Okay, I'll remember that you're ${preferredName}.`
    : `Okay, I'll use ${preferredName}.`;
}
