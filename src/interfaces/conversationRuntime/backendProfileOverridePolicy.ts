/**
 * @fileoverview Principal/access policy for session model-backend and Codex profile overrides.
 */

import type { ModelBackend } from "../../models/types";
import {
  requirePrincipalAccessForOperation,
  type PrincipalAccessEnvelope,
  type PrincipalContext
} from "../principalRuntime/principalAccess";

export type BackendProfileOverrideCommand = "backend" | "profile";

export interface BackendProfileOverrideAccessRecord {
  updatedAt: string;
  command: BackendProfileOverrideCommand;
  target: "model_backend" | "codex_profile";
  requestedValue: string | null;
  protectedResource: boolean;
  principalRole: string;
  accessClass: string;
  accessAllowed: boolean;
  accessReason: string;
  routeVisibility: string;
}

export interface BackendProfileOverrideAccessResult {
  allowed: boolean;
  protectedResource: boolean;
  principalAccess: PrincipalAccessEnvelope;
  record: BackendProfileOverrideAccessRecord;
  denialMessage: string | null;
}

/**
 * Implements `isProtectedModelBackendOverride` behavior within this module.
 */
export function isProtectedModelBackendOverride(backend: ModelBackend): boolean {
  return backend === "codex_oauth";
}

/**
 * Implements `isProtectedCodexProfileOverride` behavior within this module.
 */
export function isProtectedCodexProfileOverride(profileId: string | null | undefined): boolean {
  return typeof profileId === "string" && profileId.trim().length > 0;
}

/**
 * Implements `canUseProtectedModelSelection` behavior within this module.
 */
export function canUseProtectedModelSelection(
  principalContext: PrincipalContext | null | undefined
): boolean {
  const role = principalContext?.actor.principalRole;
  return role === "owner" || role === "operator";
}

/**
 * Implements `evaluateBackendProfileOverrideAccess` behavior within this module.
 */
export function evaluateBackendProfileOverrideAccess(input: {
  command: BackendProfileOverrideCommand;
  target: "model_backend" | "codex_profile";
  requestedValue: string | null;
  protectedResource: boolean;
  principalContext: PrincipalContext | null | undefined;
  nowIso?: string;
}): BackendProfileOverrideAccessResult {
  const role = input.principalContext?.actor.principalRole ?? "legacy_unknown";
  const protectedAllowed =
    !input.protectedResource || role === "owner" || role === "operator";
  const principalAccess = requirePrincipalAccessForOperation({
    principalContext: input.principalContext,
    operation: "backend_profile_override",
    accessClass: resolveAccessClass(role, protectedAllowed, input.protectedResource),
    allowed: protectedAllowed,
    reason: protectedAllowed
      ? role === "operator"
        ? "operator_principal_matched"
        : role === "owner"
          ? "owner_principal_matched"
          : "session_only_allowed"
      : "non_owner_owner_private_blocked"
  });
  const record = {
    updatedAt: input.nowIso ?? new Date().toISOString(),
    command: input.command,
    target: input.target,
    requestedValue: input.requestedValue,
    protectedResource: input.protectedResource,
    principalRole: principalAccess.principalContext.actor.principalRole,
    accessClass: principalAccess.accessDecision.accessClass,
    accessAllowed: principalAccess.accessDecision.allowed,
    accessReason: principalAccess.accessDecision.reason,
    routeVisibility: principalAccess.principalContext.route.visibility
  } satisfies BackendProfileOverrideAccessRecord;
  return {
    allowed: protectedAllowed,
    protectedResource: input.protectedResource,
    principalAccess,
    record,
    denialMessage: protectedAllowed
      ? null
      : "This backend/profile override requires owner or operator authorization."
  };
}

/**
 * Implements `normalizeBackendProfileOverrideAccessRecord` behavior within this module.
 */
export function normalizeBackendProfileOverrideAccessRecord(
  input: unknown
): BackendProfileOverrideAccessRecord | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Partial<BackendProfileOverrideAccessRecord>;
  if (
    typeof candidate.updatedAt !== "string" ||
    (candidate.command !== "backend" && candidate.command !== "profile") ||
    (candidate.target !== "model_backend" && candidate.target !== "codex_profile") ||
    typeof candidate.protectedResource !== "boolean" ||
    typeof candidate.principalRole !== "string" ||
    typeof candidate.accessClass !== "string" ||
    typeof candidate.accessAllowed !== "boolean" ||
    typeof candidate.accessReason !== "string" ||
    typeof candidate.routeVisibility !== "string"
  ) {
    return null;
  }
  return {
    updatedAt: candidate.updatedAt,
    command: candidate.command,
    target: candidate.target,
    requestedValue: typeof candidate.requestedValue === "string" ? candidate.requestedValue : null,
    protectedResource: candidate.protectedResource,
    principalRole: candidate.principalRole,
    accessClass: candidate.accessClass,
    accessAllowed: candidate.accessAllowed,
    accessReason: candidate.accessReason,
    routeVisibility: candidate.routeVisibility
  };
}

/**
 * Implements `resolveAccessClass` behavior within this module.
 */
function resolveAccessClass(
  role: string,
  allowed: boolean,
  protectedResource: boolean
): "owner_private" | "operator_private" | "session_only" | "blocked" {
  if (!allowed) {
    return "blocked";
  }
  if (role === "owner") {
    return "owner_private";
  }
  if (role === "operator") {
    return "operator_private";
  }
  return protectedResource ? "blocked" : "session_only";
}
