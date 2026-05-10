/**
 * @fileoverview Redacted principal/access metadata helpers for receipts and runtime traces.
 */

import type {
  PrincipalAccessAuditMetadata,
  RuntimeTraceDetailValue,
  TaskPrincipalAccessEnvelope
} from "./types";

export type RedactedPrincipalAccessMetadata = PrincipalAccessAuditMetadata;

/**
 * Builds redacted principal/access metadata without raw provider ids or stable hashes.
 */
export function buildRedactedPrincipalAccessMetadata(
  envelope: TaskPrincipalAccessEnvelope | null | undefined
): RedactedPrincipalAccessMetadata | null {
  if (!envelope || !envelope.principalContext || !envelope.accessDecision) {
    return null;
  }
  const actor = readRecord(envelope.principalContext.actor);
  const route = readRecord(envelope.principalContext.route);
  return {
    principalRole: readString(actor, "principalRole"),
    accessOperation: readString(envelope.accessDecision, "operation"),
    accessClass: readString(envelope.accessDecision, "accessClass"),
    accessAllowed:
      typeof envelope.accessDecision.allowed === "boolean"
        ? envelope.accessDecision.allowed
        : null,
    accessReason: readString(envelope.accessDecision, "reason"),
    routeVisibility: readString(route, "visibility"),
    identityAuthority: readString(actor, "identityAuthority"),
    legacyIdentityState: readString(actor, "legacyIdentityState"),
    ownerMatchSource: readString(actor, "ownerMatchSource")
  };
}

/**
 * Renders redacted principal metadata into flat trace-safe detail fields.
 */
export function renderPrincipalAccessTraceDetails(
  metadata: RedactedPrincipalAccessMetadata | null | undefined
): Record<string, RuntimeTraceDetailValue> {
  if (!metadata) {
    return {};
  }
  return {
    principalRole: metadata.principalRole,
    principalAccessOperation: metadata.accessOperation,
    principalAccessClass: metadata.accessClass,
    principalAccessAllowed: metadata.accessAllowed,
    principalAccessReason: metadata.accessReason,
    principalRouteVisibility: metadata.routeVisibility,
    principalIdentityAuthority: metadata.identityAuthority,
    principalLegacyIdentityState: metadata.legacyIdentityState,
    principalOwnerMatchSource: metadata.ownerMatchSource
  };
}

/**
 * Coerces unknown data into redacted principal/access audit metadata.
 */
export function coerceRedactedPrincipalAccessMetadata(
  input: unknown
): RedactedPrincipalAccessMetadata | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const candidate = input as Partial<RedactedPrincipalAccessMetadata>;
  return {
    principalRole: typeof candidate.principalRole === "string" ? candidate.principalRole : null,
    accessOperation:
      typeof candidate.accessOperation === "string" ? candidate.accessOperation : null,
    accessClass: typeof candidate.accessClass === "string" ? candidate.accessClass : null,
    accessAllowed:
      typeof candidate.accessAllowed === "boolean" ? candidate.accessAllowed : null,
    accessReason: typeof candidate.accessReason === "string" ? candidate.accessReason : null,
    routeVisibility:
      typeof candidate.routeVisibility === "string" ? candidate.routeVisibility : null,
    identityAuthority:
      typeof candidate.identityAuthority === "string" ? candidate.identityAuthority : null,
    legacyIdentityState:
      typeof candidate.legacyIdentityState === "string" ? candidate.legacyIdentityState : null,
    ownerMatchSource:
      typeof candidate.ownerMatchSource === "string" ? candidate.ownerMatchSource : null
  };
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
