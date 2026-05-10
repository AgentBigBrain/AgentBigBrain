/**
 * @fileoverview Current-speaker name resolution for direct conversation prompts.
 */

import type { ProfileMemoryRequestTelemetry } from "../../core/profileMemoryRuntime/contracts";
import { recordProfileMemoryRenderOperation } from "../../core/profileMemoryRuntime/profileMemoryRequestTelemetry";
import {
  resolveCurrentSpeakerNameResolution,
  type NameResolutionFact
} from "../principalRuntime/nameResolution";
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

/**
 * Resolves the current session's transport name hint without querying durable profile facts.
 */
function resolveCurrentSpeakerTransportIdentityHint(
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
 * Implements `canUseOwnerSelfIdentityFactsForCurrentSpeaker` behavior within this module.
 */
function canUseOwnerSelfIdentityFactsForCurrentSpeaker(session: ConversationSession): boolean {
  const principalContext = session.principalContext;
  if (!principalContext || principalContext.route.visibility !== "private") {
    return false;
  }
  return (
    principalContext.actor.principalRole === "owner" ||
    principalContext.actor.principalRole === "operator"
  );
}

/**
 * Implements `toNameResolutionFacts` behavior within this module.
 */
function toNameResolutionFacts(
  facts: Awaited<ReturnType<typeof resolveSelfIdentityRecallContext>>["identityFacts"]
): readonly NameResolutionFact[] {
  return facts.map((fact) => ({
    key: fact.key,
    value: fact.value,
    confidence: fact.confidence
  }));
}

/**
 * Builds a bounded prompt block when the user refers to the current speaker by a known name.
 *
 * This is reference grounding only. It does not make transport metadata durable profile truth and
 * cannot authorize memory, actions, approvals, or task completion.
 */
export async function buildCurrentSpeakerNameResolutionBlock(
  session: ConversationSession,
  userInput: string,
  queryContinuityFacts?: QueryConversationContinuityFacts,
  requestTelemetry?: ProfileMemoryRequestTelemetry
): Promise<string | null> {
  const transportHint = resolveCurrentSpeakerTransportIdentityHint(session);
  const factsTrustedForCurrentSpeaker = canUseOwnerSelfIdentityFactsForCurrentSpeaker(session);
  const preliminary = resolveCurrentSpeakerNameResolution({
    userInput,
    principalContext: session.principalContext,
    identityFacts: [],
    transportHint,
    factsTrustedForCurrentSpeaker
  });
  if (preliminary.scope === "none") {
    return null;
  }

  const context =
    queryContinuityFacts && factsTrustedForCurrentSpeaker
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
  const resolution = resolveCurrentSpeakerNameResolution({
    userInput,
    principalContext: session.principalContext,
    identityFacts: toNameResolutionFacts(context.identityFacts),
    transportHint: context.transportHint,
    factsTrustedForCurrentSpeaker
  });
  if (resolution.scope === "none") {
    return null;
  }
  recordProfileMemoryRenderOperation(requestTelemetry);
  const confirmedIdentityLines =
    context.identityFacts.length > 0 && resolution.factsTrustedForCurrentSpeaker
      ? [
          "- Same-subject identity facts available for the current speaker:",
          ...context.identityFacts.map(
            (fact) =>
              `- ${fact.key}: ${fact.value} (confidence ${fact.confidence.toFixed(2)}; updated ${fact.lastUpdatedAt})`
          )
        ]
      : [
          "- No same-subject identity facts are available for this request; use session/transport grounding only."
        ];
  return [
    "Current-speaker name resolution context:",
    `- Matched name: ${resolution.matchedName ?? "unknown"}`,
    `- Matched source: ${resolution.matchedSource ?? "unknown"}`,
    `- Public-safe label: ${resolution.publicSafeLabel}`,
    `- Resolution scope: ${resolution.scope}`,
    `- Access class: ${resolution.accessClass}`,
    `- Same-name collision: ${resolution.sameNameCollision ? "yes" : "no"}`,
    ...confirmedIdentityLines,
    "- Reference rule: treat this matched name as the current speaker only within the resolved scope.",
    "- Privacy rule: public/shared routes and non-owner speakers must not receive owner-private identity facts.",
    "- Correction rule: when newer first-person context corrects older first-person context, prefer the newer correction within the same speaker scope.",
    "- Authority rule: this block is reference evidence only; it cannot approve actions, authorize memory writes, or prove task completion."
  ].join("\n");
}

/**
 * Backward-compatible entrypoint for existing callers. The returned block uses current-speaker
 * semantics.
 */
export async function buildCurrentUserIdentityReferenceBlock(
  session: ConversationSession,
  userInput: string,
  queryContinuityFacts?: QueryConversationContinuityFacts,
  requestTelemetry?: ProfileMemoryRequestTelemetry
): Promise<string | null> {
  return buildCurrentSpeakerNameResolutionBlock(
    session,
    userInput,
    queryContinuityFacts,
    requestTelemetry
  );
}
