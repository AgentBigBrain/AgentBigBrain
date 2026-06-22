/**
 * @fileoverview Principal/access classification helpers for workflow-learning patterns.
 */

import type {
  TaskPrincipalAccessEnvelope,
  WorkflowLearningAccessClassification,
  WorkflowLearningAccessMetadataV1,
  WorkflowPattern
} from "../types";

export interface WorkflowPatternRetrievalAccessOptions {
  principalAccess?: TaskPrincipalAccessEnvelope | null;
  includeTestFixtures?: boolean;
}

/**
 * Implements `classifyWorkflowLearningAccess` behavior within this module.
 */
export function classifyWorkflowLearningAccess(
  principalAccess: TaskPrincipalAccessEnvelope | null | undefined
): WorkflowLearningAccessMetadataV1 {
  if (!principalAccess?.principalContext || !principalAccess.accessDecision) {
    return {
      schemaVersion: 1,
      classification: "legacy_unclassified",
      principalRole: null,
      principalIdHash: null,
      accessClass: null,
      accessAllowed: null,
      routeVisibility: null,
      legacyIdentityState: "legacy_actor_unknown",
      source: "legacy_unclassified"
    };
  }
  const actor = readRecord(principalAccess.principalContext.actor);
  const route = readRecord(principalAccess.principalContext.route);
  const principalRole = readOptionalString(actor, "principalRole");
  const principalIdHash =
    readOptionalString(actor, "principalIdHash") ?? readOptionalString(actor, "providerUserIdHash");
  const accessClass = principalAccess.accessDecision.accessClass;
  return {
    schemaVersion: 1,
    classification: classifyWorkflowAccess({
      accessAllowed: principalAccess.accessDecision.allowed,
      accessClass,
      principalRole,
      routeVisibility: readOptionalString(route, "visibility")
    }),
    principalRole,
    principalIdHash,
    accessClass,
    accessAllowed: principalAccess.accessDecision.allowed,
    routeVisibility: readOptionalString(route, "visibility"),
    legacyIdentityState: readOptionalString(actor, "legacyIdentityState"),
    source: "principal_access"
  };
}

/**
 * Implements `normalizeWorkflowLearningAccessMetadata` behavior within this module.
 */
export function normalizeWorkflowLearningAccessMetadata(
  input: unknown
): WorkflowLearningAccessMetadataV1 | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const candidate = input as Partial<WorkflowLearningAccessMetadataV1>;
  const classification = normalizeWorkflowLearningAccessClassification(candidate.classification);
  if (candidate.schemaVersion !== 1 || !classification) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    classification,
    principalRole: typeof candidate.principalRole === "string" ? candidate.principalRole : null,
    principalIdHash:
      typeof candidate.principalIdHash === "string" ? candidate.principalIdHash : null,
    accessClass: typeof candidate.accessClass === "string" ? candidate.accessClass : null,
    accessAllowed:
      typeof candidate.accessAllowed === "boolean" ? candidate.accessAllowed : null,
    routeVisibility:
      typeof candidate.routeVisibility === "string" ? candidate.routeVisibility : null,
    legacyIdentityState:
      typeof candidate.legacyIdentityState === "string" ? candidate.legacyIdentityState : null,
    source:
      candidate.source === "principal_access" ||
        candidate.source === "legacy_unclassified" ||
        candidate.source === "test_fixture"
        ? candidate.source
        : "legacy_unclassified"
  };
}

/**
 * Implements `buildWorkflowAccessScopeSuffix` behavior within this module.
 */
export function buildWorkflowAccessScopeSuffix(
  metadata: WorkflowLearningAccessMetadataV1 | undefined
): string {
  if (!metadata || metadata.classification === "agent_global_safe") {
    return "";
  }
  return [
    "scope",
    metadata.classification,
    metadata.principalRole ?? "none",
    metadata.principalIdHash ?? "none",
    metadata.accessClass ?? "none"
  ].join(":");
}

/**
 * Implements `isWorkflowPatternVisibleForPrincipal` behavior within this module.
 */
export function isWorkflowPatternVisibleForPrincipal(
  pattern: WorkflowPattern,
  options: WorkflowPatternRetrievalAccessOptions | null | undefined
): boolean {
  const metadata = pattern.accessMetadata;
  const hasPrincipalAccess = Boolean(options?.principalAccess);
  if (!metadata || metadata.classification === "legacy_unclassified") {
    return !hasPrincipalAccess;
  }
  if (metadata.classification === "agent_global_safe") {
    return true;
  }
  const context = buildWorkflowRetrievalContext(options);
  if (metadata.classification === "test_fixture") {
    return context.includeTestFixtures;
  }
  if (metadata.classification === "owner_private") {
    return context.ownerPrivateAllowed;
  }
  if (metadata.classification === "principal_private") {
    return Boolean(
      context.principalIdHash &&
      metadata.principalIdHash &&
      context.principalIdHash === metadata.principalIdHash
    );
  }
  if (metadata.classification === "external_agent_limited") {
    return Boolean(
      context.principalRole === "external_agent" &&
      context.principalIdHash &&
      metadata.principalIdHash &&
      context.principalIdHash === metadata.principalIdHash
    );
  }
  return false;
}

/**
 * Implements `classifyWorkflowAccess` behavior within this module.
 */
function classifyWorkflowAccess(input: {
  accessAllowed: boolean;
  accessClass: string;
  principalRole: string | null;
  routeVisibility: string | null;
}): WorkflowLearningAccessClassification {
  if (input.principalRole === "external_agent") {
    return "external_agent_limited";
  }
  if (input.accessAllowed !== true) {
    return "external_agent_limited";
  }
  if (input.accessClass === "owner_private") {
    return "owner_private";
  }
  if (input.accessClass === "speaker_private" || input.accessClass === "session_only") {
    return "principal_private";
  }
  if (input.accessClass === "shared_public" || input.routeVisibility === "public") {
    return "agent_global_safe";
  }
  if (input.accessClass === "external_agent_limited" || input.accessClass === "runtime_continuation_limited") {
    return "external_agent_limited";
  }
  return "workspace_local";
}

/**
 * Implements `buildWorkflowRetrievalContext` behavior within this module.
 */
function buildWorkflowRetrievalContext(
  options: WorkflowPatternRetrievalAccessOptions | null | undefined
): {
  includeTestFixtures: boolean;
  ownerPrivateAllowed: boolean;
  principalRole: string | null;
  principalIdHash: string | null;
} {
  const principalAccess = options?.principalAccess;
  if (!principalAccess?.principalContext || !principalAccess.accessDecision) {
    return {
      includeTestFixtures: options?.includeTestFixtures === true,
      ownerPrivateAllowed: false,
      principalRole: null,
      principalIdHash: null
    };
  }
  const actor = readRecord(principalAccess.principalContext.actor);
  const principalRole = readOptionalString(actor, "principalRole");
  const principalIdHash =
    readOptionalString(actor, "principalIdHash") ?? readOptionalString(actor, "providerUserIdHash");
  return {
    includeTestFixtures: options?.includeTestFixtures === true,
    ownerPrivateAllowed:
      principalAccess.accessDecision.allowed === true &&
      principalAccess.accessDecision.accessClass === "owner_private" &&
      (principalRole === "owner" || principalRole === "operator"),
    principalRole,
    principalIdHash
  };
}

/**
 * Implements `normalizeWorkflowLearningAccessClassification` behavior within this module.
 */
function normalizeWorkflowLearningAccessClassification(
  value: unknown
): WorkflowLearningAccessClassification | null {
  return value === "agent_global_safe" ||
    value === "legacy_unclassified" ||
    value === "owner_private" ||
    value === "principal_private" ||
    value === "workspace_local" ||
    value === "external_agent_limited" ||
    value === "test_fixture"
    ? value
    : null;
}

/**
 * Implements `readRecord` behavior within this module.
 */
function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/**
 * Implements `readOptionalString` behavior within this module.
 */
function readOptionalString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
