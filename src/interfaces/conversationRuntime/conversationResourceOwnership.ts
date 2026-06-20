/**
 * @fileoverview Redacted principal ownership helpers for runtime workspace resources.
 */

import type {
  ConversationJob
} from "./sessionStateContracts";
import type { ConversationResourceOwnerMetadata } from "./conversationResourceOwnershipContracts";
import type { PrincipalContext } from "../principalRuntime/principalAccess";

/**
 * Builds redacted resource-owner metadata from a verified source job snapshot.
 */
export function buildConversationResourceOwnerFromJob(
  job: Pick<ConversationJob, "id" | "principalSnapshot">
): ConversationResourceOwnerMetadata | null {
  const snapshot = job.principalSnapshot;
  if (
    snapshot?.snapshotState !== "verified" ||
    snapshot.accessAllowed !== true ||
    snapshot.accessClass === "blocked"
  ) {
    return null;
  }
  return {
    principalRole: snapshot.principalRole,
    routeVisibility: snapshot.routeVisibility,
    accessClass: snapshot.accessClass,
    legacyIdentityState: snapshot.legacyIdentityState,
    providerUserIdHash: snapshot.providerUserIdHash,
    sourceJobId: job.id
  };
}

/**
 * Normalizes persisted resource-owner metadata without minting ownership from malformed records.
 */
export function normalizeConversationResourceOwnerMetadata(
  candidate: unknown
): ConversationResourceOwnerMetadata | null {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const value = candidate as Partial<ConversationResourceOwnerMetadata>;
  if (
    !isPrincipalRole(value.principalRole) ||
    !isRouteVisibility(value.routeVisibility) ||
    !isAccessClass(value.accessClass) ||
    !isLegacyIdentityState(value.legacyIdentityState)
  ) {
    return null;
  }
  return {
    principalRole: value.principalRole,
    routeVisibility: value.routeVisibility,
    accessClass: value.accessClass,
    legacyIdentityState: value.legacyIdentityState,
    providerUserIdHash:
      typeof value.providerUserIdHash === "string" && value.providerUserIdHash.trim().length > 0
        ? value.providerUserIdHash.trim()
        : null,
    sourceJobId:
      typeof value.sourceJobId === "string" && value.sourceJobId.trim().length > 0
        ? value.sourceJobId.trim()
        : null
  };
}

/**
 * Returns whether the current principal can use one protected runtime resource.
 */
export function canCurrentPrincipalAccessConversationResource(
  principalContext: PrincipalContext | null | undefined,
  resourceOwner: ConversationResourceOwnerMetadata | null | undefined
): boolean {
  if (!principalContext || !resourceOwner) {
    return false;
  }
  const actor = principalContext.actor;
  if (actor.principalRole === "owner" || actor.principalRole === "operator") {
    return principalContext.route.visibility !== "public";
  }
  if (!actor.providerUserIdHash || !resourceOwner.providerUserIdHash) {
    return false;
  }
  return actor.providerUserIdHash === resourceOwner.providerUserIdHash &&
    principalContext.route.visibility !== "public";
}

/**
 * Returns whether two resource-owner labels represent the same initiating principal.
 */
export function resourceOwnersMatch(
  left: ConversationResourceOwnerMetadata | null | undefined,
  right: ConversationResourceOwnerMetadata | null | undefined
): boolean {
  if (!left || !right) {
    return false;
  }
  if (left.providerUserIdHash && right.providerUserIdHash) {
    return left.providerUserIdHash === right.providerUserIdHash;
  }
  return left.principalRole === right.principalRole &&
    left.sourceJobId !== null &&
    left.sourceJobId === right.sourceJobId;
}

/**
 * Implements `isPrincipalRole` behavior within this module.
 */
function isPrincipalRole(value: unknown): value is ConversationResourceOwnerMetadata["principalRole"] {
  return value === "owner" ||
    value === "operator" ||
    value === "allowed_user" ||
    value === "conversation_participant" ||
    value === "external_agent" ||
    value === "runtime_continuation" ||
    value === "local_operator" ||
    value === "legacy_unknown" ||
    value === "unknown";
}

/**
 * Implements `isRouteVisibility` behavior within this module.
 */
function isRouteVisibility(value: unknown): value is ConversationResourceOwnerMetadata["routeVisibility"] {
  return value === "private" || value === "public" || value === "unknown";
}

/**
 * Implements `isAccessClass` behavior within this module.
 */
function isAccessClass(value: unknown): value is ConversationResourceOwnerMetadata["accessClass"] {
  return value === "owner_private" ||
    value === "operator_private" ||
    value === "speaker_private" ||
    value === "shared_public" ||
    value === "session_only" ||
    value === "workspace_local" ||
    value === "agent_global_safe" ||
    value === "external_agent_limited" ||
    value === "runtime_continuation_limited" ||
    value === "review_only" ||
    value === "blocked";
}

/**
 * Implements `isLegacyIdentityState` behavior within this module.
 */
function isLegacyIdentityState(value: unknown): value is ConversationResourceOwnerMetadata["legacyIdentityState"] {
  return value === "principal_verified" ||
    value === "legacy_actor_unknown" ||
    value === "legacy_global_memory" ||
    value === "runtime_continuation_missing_origin" ||
    value === "external_agent_limited" ||
    value === "test_override";
}
