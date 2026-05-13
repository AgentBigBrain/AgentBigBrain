/**
 * @fileoverview Normalizes actor/source metadata attached to persisted conversation turns.
 */

import type { ConversationTurnActorMetadata } from "./sessionStateContracts";

/**
 * Normalizes turn actor metadata without allowing malformed legacy records to grant identity
 * authority.
 */
export function normalizeConversationTurnActorMetadata(
  value: unknown
): ConversationTurnActorMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const candidate = value as Partial<ConversationTurnActorMetadata>;
  const source =
    candidate.source === "session_principal_context" ||
    candidate.source === "assistant_runtime" ||
    candidate.source === "legacy_recovery"
      ? candidate.source
      : null;
  const principalRole =
    candidate.principalRole === "owner" ||
    candidate.principalRole === "operator" ||
    candidate.principalRole === "allowed_user" ||
    candidate.principalRole === "conversation_participant" ||
    candidate.principalRole === "external_agent" ||
    candidate.principalRole === "runtime_continuation" ||
    candidate.principalRole === "local_operator" ||
    candidate.principalRole === "legacy_unknown" ||
    candidate.principalRole === "unknown"
      ? candidate.principalRole
      : null;
  const routeVisibility =
    candidate.routeVisibility === "private" ||
    candidate.routeVisibility === "public" ||
    candidate.routeVisibility === "unknown"
      ? candidate.routeVisibility
      : null;
  const identityAuthority =
    candidate.identityAuthority === "configured_owner_provider_user_id" ||
    candidate.identityAuthority === "configured_operator_provider_user_id" ||
    candidate.identityAuthority === "allowlisted_provider_user_id" ||
    candidate.identityAuthority === "allowlisted_username" ||
    candidate.identityAuthority === "external_agent_contract" ||
    candidate.identityAuthority === "runtime_inherited" ||
    candidate.identityAuthority === "transport_hint" ||
    candidate.identityAuthority === "legacy_unknown"
      ? candidate.identityAuthority
      : null;
  const legacyIdentityState =
    candidate.legacyIdentityState === "principal_verified" ||
    candidate.legacyIdentityState === "legacy_actor_unknown" ||
    candidate.legacyIdentityState === "legacy_global_memory" ||
    candidate.legacyIdentityState === "runtime_continuation_missing_origin" ||
    candidate.legacyIdentityState === "external_agent_limited" ||
    candidate.legacyIdentityState === "test_override"
      ? candidate.legacyIdentityState
      : null;
  const ownerMatchSource =
    candidate.ownerMatchSource === "provider_user_id" ||
    candidate.ownerMatchSource === "local_operator_trusted_mode" ||
    candidate.ownerMatchSource === "operator_provider_user_id" ||
    candidate.ownerMatchSource === "none" ||
    candidate.ownerMatchSource === "legacy_unknown"
      ? candidate.ownerMatchSource
      : null;

  if (
    !source ||
    !principalRole ||
    !routeVisibility ||
    !identityAuthority ||
    !legacyIdentityState ||
    !ownerMatchSource
  ) {
    return null;
  }

  return {
    source,
    principalRole,
    principalIdHash:
      typeof candidate.principalIdHash === "string" ? candidate.principalIdHash : null,
    providerUserIdHash:
      typeof candidate.providerUserIdHash === "string" ? candidate.providerUserIdHash : null,
    routeVisibility,
    identityAuthority,
    legacyIdentityState,
    ownerMatchSource,
    displayNameHint:
      typeof candidate.displayNameHint === "string" ? candidate.displayNameHint : null,
    sourceEventIdHash:
      typeof candidate.sourceEventIdHash === "string" ? candidate.sourceEventIdHash : null
  };
}
