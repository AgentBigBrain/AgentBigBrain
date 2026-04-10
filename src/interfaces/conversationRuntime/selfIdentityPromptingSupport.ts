/**
 * @fileoverview Shared self-identity recall and parity helpers for direct conversational replies.
 */

import type { ProfileMemoryRequestTelemetry } from "../../core/profileMemoryRuntime/contracts";
import { recordProfileMemoryRetrievalOperation } from "../../core/profileMemoryRuntime/profileMemoryRequestTelemetry";
import type { ConversationSession } from "../sessionStore";
import type { QueryConversationContinuityFacts } from "./managerContracts";
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

export interface ResolvedSelfIdentityRecallContext {
  identityFacts: Awaited<ReturnType<NonNullable<QueryConversationContinuityFacts>>>;
  transportHint: ReturnType<typeof selectConversationTransportIdentityNameHint>;
  hasFactLookup: boolean;
}

/**
 * Normalizes one self-identity candidate string for bounded parity checks.
 *
 * @param value - Candidate identity wording to normalize.
 * @returns Canonical token string used for parity comparison.
 */
function normalizeSelfIdentityParityValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Returns whether two self-identity candidates remain meaningfully aligned for parity checks.
 *
 * @param primary - Primary deterministic identity candidate.
 * @param shadow - Shadow or fallback identity candidate.
 * @returns `true` when the two candidates still point to the same human-readable identity.
 */
export function hasSelfIdentityParity(primary: string, shadow: string): boolean {
  const normalizedPrimary = normalizeSelfIdentityParityValue(primary);
  const normalizedShadow = normalizeSelfIdentityParityValue(shadow);
  if (!normalizedPrimary || !normalizedShadow) {
    return false;
  }
  return (
    normalizedPrimary === normalizedShadow ||
    normalizedPrimary.includes(normalizedShadow) ||
    normalizedShadow.includes(normalizedPrimary)
  );
}

/**
 * Builds a low-confidence username-only transport identity fallback for older sessions that do not
 * yet carry the richer transport-identity record.
 *
 * @param session - Conversation session carrying persisted username metadata.
 * @returns Username-derived transport identity, or `null` when provider inference is unavailable.
 */
function resolveUsernameFallbackIdentity(session: ConversationSession) {
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
export function resolveConversationTransportProvider(
  session: ConversationSession
): "telegram" | "discord" | null {
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
 * @param requestTelemetry - Optional request-scoped telemetry bag.
 * @returns Resolved self-identity context for prompt or deterministic reply assembly.
 */
export async function resolveSelfIdentityRecallContext(
  session: ConversationSession,
  queryContinuityFacts?: QueryConversationContinuityFacts,
  requestTelemetry?: ProfileMemoryRequestTelemetry
): Promise<ResolvedSelfIdentityRecallContext> {
  const stack = session.conversationStack;
  const hasFactLookup = Boolean(stack && queryContinuityFacts);
  if (hasFactLookup) {
    recordProfileMemoryRetrievalOperation(requestTelemetry);
  }
  const queriedFacts =
    stack && queryContinuityFacts
      ? await queryContinuityFacts({
          stack,
          entityHints: SELF_IDENTITY_CONTINUITY_FACT_HINTS,
          semanticMode: "identity",
          relevanceScope: "global_profile",
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
