/**
 * @fileoverview Bounded current-user name-reference grounding for direct conversation prompts.
 */

import type { ProfileMemoryRequestTelemetry } from "../../core/profileMemoryRuntime/contracts";
import { recordProfileMemoryRenderOperation } from "../../core/profileMemoryRuntime/profileMemoryRequestTelemetry";
import type { ConversationSession } from "../sessionStore";
import type { QueryConversationContinuityFacts } from "./managerContracts";
import {
  resolveConversationTransportProvider,
  resolveSelfIdentityRecallContext
} from "./selfIdentityPromptingSupport";
import {
  buildConversationTransportIdentityRecord,
  selectConversationTransportIdentityNameHint
} from "./transportIdentity";

interface CurrentUserIdentityReferenceCandidate {
  value: string;
  source: string;
  confidence: string;
}

/**
 * Normalizes one identity surface into comparison tokens for exact current-speaker alias checks.
 *
 * @param value - Identity surface from profile facts, transport display names, or user wording.
 * @returns Stable lower-case token sequence.
 */
function tokenizeCurrentUserIdentityReference(value: string): readonly string[] {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * Returns whether `candidateTokens` appears as a contiguous token sequence in `inputTokens`.
 *
 * @param inputTokens - Current user-request tokens.
 * @param candidateTokens - Current-speaker identity candidate tokens.
 * @returns `true` when the candidate is explicitly present in the current request.
 */
function hasCurrentUserIdentityTokenSequence(
  inputTokens: readonly string[],
  candidateTokens: readonly string[]
): boolean {
  if (candidateTokens.length === 0 || candidateTokens.length > inputTokens.length) {
    return false;
  }
  for (let index = 0; index <= inputTokens.length - candidateTokens.length; index += 1) {
    if (candidateTokens.every((token, offset) => inputTokens[index + offset] === token)) {
      return true;
    }
  }
  return false;
}

/**
 * Adds a candidate once, preserving insertion order for stronger identity sources.
 *
 * @param target - Candidate list under construction.
 * @param seen - Normalized candidate values already added.
 * @param candidate - Candidate to add.
 */
function pushCurrentUserIdentityReferenceCandidate(
  target: CurrentUserIdentityReferenceCandidate[],
  seen: Set<string>,
  candidate: CurrentUserIdentityReferenceCandidate | null
): void {
  if (!candidate) {
    return;
  }
  const normalizedValue = candidate.value.replace(/\s+/g, " ").trim();
  if (!normalizedValue) {
    return;
  }
  const signature = tokenizeCurrentUserIdentityReference(normalizedValue).join(" ");
  if (!signature || seen.has(signature)) {
    return;
  }
  seen.add(signature);
  target.push({
    ...candidate,
    value: normalizedValue
  });
}

/**
 * Collects bounded current-speaker identity aliases from confirmed facts and transport metadata.
 *
 * @param context - Resolved direct-chat identity context.
 * @returns Ordered current-user identity reference candidates.
 */
function collectCurrentUserIdentityReferenceCandidates(
  context: Pick<
    Awaited<ReturnType<typeof resolveSelfIdentityRecallContext>>,
    "identityFacts" | "transportHint"
  >
): readonly CurrentUserIdentityReferenceCandidate[] {
  const candidates: CurrentUserIdentityReferenceCandidate[] = [];
  const seen = new Set<string>();
  for (const fact of context.identityFacts) {
    pushCurrentUserIdentityReferenceCandidate(candidates, seen, {
      value: fact.value,
      source: `confirmed profile fact ${fact.key}`,
      confidence: fact.confidence.toFixed(2)
    });
  }
  if (context.transportHint) {
    const transportSource =
      context.transportHint.source === "display_name"
        ? "transport display name"
        : context.transportHint.source === "given_name"
          ? "transport given name"
          : "transport username";
    pushCurrentUserIdentityReferenceCandidate(candidates, seen, {
      value: context.transportHint.value,
      source: transportSource,
      confidence: context.transportHint.confidence
    });
    const firstNameToken = tokenizeCurrentUserIdentityReference(context.transportHint.value)[0];
    if (firstNameToken && firstNameToken.length >= 2) {
      pushCurrentUserIdentityReferenceCandidate(candidates, seen, {
        value: firstNameToken,
        source: `${transportSource} first token`,
        confidence: context.transportHint.confidence
      });
    }
  }
  return candidates.slice(0, 6);
}

/**
 * Resolves the current session's transport name hint without querying durable profile facts.
 *
 * @param session - Conversation session carrying transport/provider identity metadata.
 * @returns Transport identity hint, or `null` when no usable name-like hint exists.
 */
function resolveCurrentUserTransportIdentityHint(
  session: ConversationSession
): Awaited<ReturnType<typeof resolveSelfIdentityRecallContext>>["transportHint"] {
  const provider = resolveConversationTransportProvider(session);
  const fallbackIdentity =
    provider
      ? buildConversationTransportIdentityRecord({
          provider,
          username: session.username,
          displayName: null,
          givenName: null,
          familyName: null,
          observedAt: session.updatedAt
        })
      : null;
  return selectConversationTransportIdentityNameHint(
    session.transportIdentity ?? fallbackIdentity
  );
}

/**
 * Selects the current-speaker identity alias explicitly mentioned in the current request.
 *
 * @param userInput - Raw current user wording.
 * @param candidates - Current-speaker identity candidates.
 * @returns Best matching candidate, or `null` when no current-speaker alias appears.
 */
function selectMentionedCurrentUserIdentityReference(
  userInput: string,
  candidates: readonly CurrentUserIdentityReferenceCandidate[]
): CurrentUserIdentityReferenceCandidate | null {
  const inputTokens = tokenizeCurrentUserIdentityReference(userInput);
  if (inputTokens.length === 0) {
    return null;
  }
  return candidates.find((candidate) =>
    hasCurrentUserIdentityTokenSequence(
      inputTokens,
      tokenizeCurrentUserIdentityReference(candidate.value)
    )
  ) ?? null;
}

/**
 * Builds a bounded prompt block when the user refers to the current speaker by a known name.
 *
 * This is reference grounding only: transport/profile names can help resolve a name versus "I",
 * but they do not make unrelated profile claims true and cannot authorize memory or actions.
 *
 * @param session - Conversation session carrying transport identity and continuity state.
 * @param userInput - Raw current user wording.
 * @param queryContinuityFacts - Optional bounded identity-fact lookup helper.
 * @param requestTelemetry - Optional request-scoped telemetry bag.
 * @returns Current-user reference block, or `null` when the request does not name the speaker.
 */
export async function buildCurrentUserIdentityReferenceBlock(
  session: ConversationSession,
  userInput: string,
  queryContinuityFacts?: QueryConversationContinuityFacts,
  requestTelemetry?: ProfileMemoryRequestTelemetry
): Promise<string | null> {
  const transportHint = resolveCurrentUserTransportIdentityHint(session);
  const transportCandidates = collectCurrentUserIdentityReferenceCandidates({
    identityFacts: [],
    transportHint
  });
  const matchedTransportCandidate = selectMentionedCurrentUserIdentityReference(
    userInput,
    transportCandidates
  );
  if (!matchedTransportCandidate) {
    return null;
  }

  const context =
    queryContinuityFacts
      ? await resolveSelfIdentityRecallContext(
          session,
          queryContinuityFacts,
          requestTelemetry
        )
      : {
          identityFacts: [],
          transportHint,
          hasFactLookup: false
        };
  const candidates = collectCurrentUserIdentityReferenceCandidates(context);
  const matchedCandidate =
    selectMentionedCurrentUserIdentityReference(userInput, candidates) ??
    matchedTransportCandidate;
  recordProfileMemoryRenderOperation(requestTelemetry);
  const confirmedIdentityLines = context.identityFacts.length > 0
    ? [
        "- Confirmed identity facts for the current user:",
        ...context.identityFacts.map(
          (fact) =>
            `- ${fact.key}: ${fact.value} (confidence ${fact.confidence.toFixed(2)}; updated ${fact.lastUpdatedAt})`
        )
      ]
    : [
        "- No confirmed identity fact matched this name yet; the match may come from transport metadata."
      ];
  return [
    "Current-user identity reference context:",
    `- The current request mentions '${matchedCandidate.value}', which matches the current speaker's ${matchedCandidate.source} (confidence ${matchedCandidate.confidence}).`,
    ...confirmedIdentityLines,
    "- Reference rule: if the recent context does not establish a distinct different person with this same name, treat this name as the current user, not as a separate third party.",
    "- First-person statements in recent conversation context ('I', 'my', 'me') belong to this same current user.",
    "- Response rule: when answering about this name, combine the bounded recent context with confirmed profile facts; do not say this name is unrelated to the current speaker.",
    "- Authority rule: this block only resolves references. It does not make transport metadata durable profile truth, approve actions, authorize memory writes, or prove task completion."
  ].join("\n");
}
