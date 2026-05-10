/**
 * @fileoverview Deterministic principal/subject access policy for profile-memory surfaces.
 */

import type { TaskPrincipalAccessEnvelope } from "../types";

export type ProfileMemoryAccessOperation =
  | "profile_read"
  | "profile_write"
  | "profile_continuity_query"
  | "memory_review";

export type ProfileMemoryAccessSubjectKind =
  | "owner_profile"
  | "principal_profile"
  | "conversation_participant"
  | "legacy_global_profile"
  | "unknown";

export type ProfileMemoryAccessPolicyReason =
  | "owner_private_allowed"
  | "operator_review_allowed"
  | "speaker_private_allowed"
  | "shared_public_session_only"
  | "legacy_global_owner_only"
  | "public_route_private_memory_blocked"
  | "non_owner_owner_private_blocked"
  | "external_agent_owner_private_blocked"
  | "runtime_continuation_owner_private_blocked"
  | "missing_principal_scope"
  | "sensitivity_approval_is_not_principal_authority";

export interface ProfileMemoryAccessPolicyInput {
  principalAccess?: TaskPrincipalAccessEnvelope | null;
  operation: ProfileMemoryAccessOperation;
  requestedSubjectKind: ProfileMemoryAccessSubjectKind;
  includeSensitive?: boolean;
  explicitHumanApproval?: boolean;
}

export interface ProfileMemoryAccessPolicyDecision {
  allowed: boolean;
  reason: ProfileMemoryAccessPolicyReason;
  operation: ProfileMemoryAccessOperation;
  requestedSubjectKind: ProfileMemoryAccessSubjectKind;
  actorRole: string;
  routeVisibility: string;
  accessClass: string;
}

/**
 * Evaluates the principal boundary before profile memory read/write/review behavior consumes it.
 */
export function evaluateProfileMemoryAccessPolicy(
  input: ProfileMemoryAccessPolicyInput
): ProfileMemoryAccessPolicyDecision {
  const actorRole = readNestedString(input.principalAccess, [
    "principalContext",
    "actor",
    "principalRole"
  ]);
  const routeVisibility = readNestedString(input.principalAccess, [
    "principalContext",
    "route",
    "visibility"
  ]);
  const accessClass = readNestedString(input.principalAccess, [
    "accessDecision",
    "accessClass"
  ]);

  if (!actorRole || !routeVisibility || !accessClass) {
    return buildDecision(input, {
      actorRole: actorRole ?? "unknown",
      routeVisibility: routeVisibility ?? "unknown",
      accessClass: accessClass ?? "blocked",
      allowed: false,
      reason: "missing_principal_scope"
    });
  }

  if (input.includeSensitive && input.explicitHumanApproval && actorRole !== "owner") {
    return buildDecision(input, {
      actorRole,
      routeVisibility,
      accessClass,
      allowed: false,
      reason: "sensitivity_approval_is_not_principal_authority"
    });
  }

  if (routeVisibility === "public" && isPrivateSubject(input.requestedSubjectKind)) {
    return buildDecision(input, {
      actorRole,
      routeVisibility,
      accessClass,
      allowed: false,
      reason: "public_route_private_memory_blocked"
    });
  }

  if (input.requestedSubjectKind === "legacy_global_profile") {
    return buildDecision(input, {
      actorRole,
      routeVisibility,
      accessClass,
      allowed: actorRole === "owner",
      reason: actorRole === "owner" ? "owner_private_allowed" : "legacy_global_owner_only"
    });
  }

  if (input.requestedSubjectKind === "owner_profile" && actorRole !== "owner") {
    return buildDecision(input, {
      actorRole,
      routeVisibility,
      accessClass,
      allowed: false,
      reason: resolveNonOwnerOwnerPrivateBlockReason(actorRole)
    });
  }

  if (actorRole === "owner" && input.requestedSubjectKind === "owner_profile") {
    return buildDecision(input, {
      actorRole,
      routeVisibility,
      accessClass,
      allowed: true,
      reason: "owner_private_allowed"
    });
  }

  if (actorRole === "operator" && input.operation === "memory_review") {
    return buildDecision(input, {
      actorRole,
      routeVisibility,
      accessClass,
      allowed: true,
      reason: "operator_review_allowed"
    });
  }

  if (
    input.requestedSubjectKind === "principal_profile" ||
    input.requestedSubjectKind === "conversation_participant"
  ) {
    return buildDecision(input, {
      actorRole,
      routeVisibility,
      accessClass,
      allowed: routeVisibility !== "public",
      reason: routeVisibility === "public" ? "shared_public_session_only" : "speaker_private_allowed"
    });
  }

  return buildDecision(input, {
    actorRole,
    routeVisibility,
    accessClass,
    allowed: false,
    reason: "missing_principal_scope"
  });
}

function buildDecision(
  input: ProfileMemoryAccessPolicyInput,
  details: Pick<
    ProfileMemoryAccessPolicyDecision,
    "actorRole" | "routeVisibility" | "accessClass" | "allowed" | "reason"
  >
): ProfileMemoryAccessPolicyDecision {
  return {
    operation: input.operation,
    requestedSubjectKind: input.requestedSubjectKind,
    ...details
  };
}

function isPrivateSubject(subjectKind: ProfileMemoryAccessSubjectKind): boolean {
  return subjectKind === "owner_profile" || subjectKind === "legacy_global_profile";
}

function resolveNonOwnerOwnerPrivateBlockReason(
  actorRole: string
): ProfileMemoryAccessPolicyReason {
  if (actorRole === "external_agent") {
    return "external_agent_owner_private_blocked";
  }
  if (actorRole === "runtime_continuation") {
    return "runtime_continuation_owner_private_blocked";
  }
  return "non_owner_owner_private_blocked";
}

function readNestedString(input: unknown, path: readonly string[]): string | null {
  let current: unknown = input;
  for (const segment of path) {
    if (!current || typeof current !== "object" || !(segment in current)) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return typeof current === "string" ? current : null;
}
