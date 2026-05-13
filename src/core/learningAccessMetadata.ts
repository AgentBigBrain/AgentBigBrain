/**
 * @fileoverview Shared principal/access classification helpers for agent learning surfaces.
 */

import type { TaskPrincipalAccessEnvelope } from "./runtimeTypes/taskPlanningTypes";

export type AgentLearningAccessClassification =
  | "agent_global_safe"
  | "owner_private"
  | "principal_private"
  | "workspace_local"
  | "external_agent_limited"
  | "test_fixture";

export interface AgentLearningAccessMetadataV1 {
  schemaVersion: 1;
  classification: AgentLearningAccessClassification;
  principalRole: string | null;
  principalIdHash: string | null;
  accessClass: string | null;
  accessAllowed: boolean | null;
  routeVisibility: string | null;
  legacyIdentityState: string | null;
  source: "principal_access" | "legacy_unclassified" | "test_fixture";
}

export interface AgentLearningRetrievalAccessOptions {
  principalAccess?: TaskPrincipalAccessEnvelope | null;
  includeTestFixtures?: boolean;
}

/**
 * Implements `classifyAgentLearningAccess` behavior within this module.
 */
export function classifyAgentLearningAccess(
  principalAccess: TaskPrincipalAccessEnvelope | null | undefined
): AgentLearningAccessMetadataV1 {
  if (!principalAccess?.principalContext || !principalAccess.accessDecision) {
    return {
      schemaVersion: 1,
      classification: "agent_global_safe",
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
    classification: classifyAccess({
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
 * Implements `normalizeAgentLearningAccessMetadata` behavior within this module.
 */
export function normalizeAgentLearningAccessMetadata(
  input: unknown
): AgentLearningAccessMetadataV1 | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const candidate = input as Partial<AgentLearningAccessMetadataV1>;
  const classification = normalizeAgentLearningAccessClassification(candidate.classification);
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
    accessAllowed: typeof candidate.accessAllowed === "boolean" ? candidate.accessAllowed : null,
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
 * Implements `isAgentLearningVisibleForPrincipal` behavior within this module.
 */
export function isAgentLearningVisibleForPrincipal(
  metadata: AgentLearningAccessMetadataV1 | undefined,
  options: AgentLearningRetrievalAccessOptions | null | undefined
): boolean {
  if (!metadata || metadata.classification === "agent_global_safe") {
    return true;
  }
  const context = buildRetrievalContext(options);
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
 * Implements `shouldApplyGlobalPersonalityLearning` behavior within this module.
 */
export function shouldApplyGlobalPersonalityLearning(
  metadata: AgentLearningAccessMetadataV1
): boolean {
  if (metadata.classification === "agent_global_safe") {
    return true;
  }
  return Boolean(
    metadata.classification === "owner_private" &&
    metadata.accessAllowed === true &&
    metadata.accessClass === "owner_private" &&
    (metadata.principalRole === "owner" || metadata.principalRole === "operator")
  );
}

/**
 * Implements `renderLearningAccessScopeLabel` behavior within this module.
 */
export function renderLearningAccessScopeLabel(
  metadata: AgentLearningAccessMetadataV1 | undefined
): string {
  if (!metadata) {
    return "legacy_unclassified";
  }
  if (metadata.classification === "agent_global_safe") {
    return "agent_global_safe";
  }
  return metadata.classification;
}

/**
 * Implements `stripLearningAccessScopeSuffix` behavior within this module.
 */
export function stripLearningAccessScopeSuffix(value: string): string {
  const pipeIndex = value.indexOf("|scope:");
  if (pipeIndex >= 0) {
    return value.slice(0, pipeIndex);
  }
  const colonIndex = value.indexOf(":scope:");
  if (colonIndex >= 0) {
    return value.slice(0, colonIndex);
  }
  return value;
}

/**
 * Implements `redactLearningAccessScopeSuffixes` behavior within this module.
 */
export function redactLearningAccessScopeSuffixes(value: string): string {
  let output = "";
  for (let index = 0; index < value.length;) {
    if (value.startsWith("|scope:", index) || value.startsWith(":scope:", index)) {
      index += 7;
      while (index < value.length && !isScopeDelimiter(value[index] ?? "")) {
        index += 1;
      }
      continue;
    }
    output += value[index];
    index += 1;
  }
  return output;
}

/**
 * Implements `buildRetrievalContext` behavior within this module.
 */
function buildRetrievalContext(
  options: AgentLearningRetrievalAccessOptions | null | undefined
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
 * Implements `classifyAccess` behavior within this module.
 */
function classifyAccess(input: {
  accessAllowed: boolean;
  accessClass: string;
  principalRole: string | null;
  routeVisibility: string | null;
}): AgentLearningAccessClassification {
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
 * Implements `normalizeAgentLearningAccessClassification` behavior within this module.
 */
function normalizeAgentLearningAccessClassification(
  value: unknown
): AgentLearningAccessClassification | null {
  return value === "agent_global_safe" ||
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

/**
 * Implements `isScopeDelimiter` behavior within this module.
 */
function isScopeDelimiter(value: string): boolean {
  return value === "" ||
    value === " " ||
    value === "\n" ||
    value === "\r" ||
    value === "\t" ||
    value === ")" ||
    value === ";" ||
    value === "," ||
    value === "]";
}
