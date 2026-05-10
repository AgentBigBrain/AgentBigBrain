/**
 * @fileoverview Redacted principal/access metadata helpers for receipts and runtime traces.
 */

import type { RuntimeTraceDetailValue, TaskPrincipalAccessEnvelope } from "./types";

export interface RedactedPrincipalAccessMetadata {
  principalRole: string | null;
  accessOperation: string | null;
  accessClass: string | null;
  accessAllowed: boolean | null;
  accessReason: string | null;
  routeVisibility: string | null;
  identityAuthority: string | null;
  legacyIdentityState: string | null;
  ownerMatchSource: string | null;
}

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

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
