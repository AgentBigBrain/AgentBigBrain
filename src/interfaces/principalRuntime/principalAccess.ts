/**
 * @fileoverview Principal, subject, and operation-specific access contracts for interface ingress.
 */

import type { ConversationTransportIdentityRecord } from "../conversationRuntime/sessionStateContracts";
import type { ConversationVisibility } from "../sessionStore";
import type {
  ConfiguredPrincipalProvider,
  OwnerOperatorPrincipalConfig
} from "./principalConfig";
import { resolveOwnerOperatorPrincipalRole } from "./principalConfig";

export type PrincipalProvider =
  | "telegram"
  | "discord"
  | "cli"
  | "federated"
  | "runtime"
  | "local_operator"
  | "legacy";

export type PrincipalRole =
  | "owner"
  | "operator"
  | "allowed_user"
  | "conversation_participant"
  | "external_agent"
  | "runtime_continuation"
  | "local_operator"
  | "legacy_unknown"
  | "unknown";

export type LegacyIdentityState =
  | "principal_verified"
  | "legacy_actor_unknown"
  | "legacy_global_memory"
  | "runtime_continuation_missing_origin"
  | "external_agent_limited"
  | "test_override";

export type OwnerMatchSource =
  | "provider_user_id"
  | "local_operator_trusted_mode"
  | "operator_provider_user_id"
  | "none"
  | "legacy_unknown";

export type IdentityAuthority =
  | "configured_owner_provider_user_id"
  | "configured_operator_provider_user_id"
  | "allowlisted_provider_user_id"
  | "allowlisted_username"
  | "external_agent_contract"
  | "runtime_inherited"
  | "transport_hint"
  | "legacy_unknown";

export type MemorySubjectKind =
  | "owner_profile"
  | "principal_profile"
  | "conversation_participant"
  | "contact"
  | "organization"
  | "project"
  | "document_subject"
  | "legacy_global_profile"
  | "agent_global_learning"
  | "workspace_local"
  | "unknown";

export interface MemorySubjectRef {
  subjectKind: MemorySubjectKind;
  subjectId: string;
  ownerPrincipalIdHash?: string | null;
  principalIdHash?: string | null;
  legacyIdentityState?: LegacyIdentityState;
}

export interface ConversationPrincipal {
  principalId: string;
  principalRole: PrincipalRole;
  provider: PrincipalProvider;
  providerUserIdHash: string | null;
  providerConversationIdHash: string | null;
  providerEventIdHash?: string | null;
  conversationId: string | null;
  conversationVisibility: ConversationVisibility;
  usernameHint: string | null;
  displayNameHint: string | null;
  transportObservedAt: string | null;
  ownerMatchSource: OwnerMatchSource;
  identityAuthority: IdentityAuthority;
  legacyIdentityState: LegacyIdentityState;
}

export type PrincipalAccessOperation =
  | "direct_reply"
  | "task_execution"
  | "profile_read"
  | "profile_write"
  | "profile_continuity_query"
  | "memory_review"
  | "source_recall_capture"
  | "source_recall_retrieve"
  | "source_recall_project"
  | "entity_graph_write"
  | "projection_review_action"
  | "approval"
  | "governance_vote"
  | "execution_receipt"
  | "runtime_trace"
  | "learning_write"
  | "pulse_delivery"
  | "skill_lifecycle"
  | "backend_profile_override"
  | "autonomous_abort";

export type PrincipalAccessClass =
  | "owner_private"
  | "operator_private"
  | "speaker_private"
  | "shared_public"
  | "session_only"
  | "workspace_local"
  | "agent_global_safe"
  | "external_agent_limited"
  | "runtime_continuation_limited"
  | "review_only"
  | "blocked";

export interface PrincipalContext {
  requestId: string;
  actor: ConversationPrincipal;
  route: {
    conversationId: string | null;
    providerConversationIdHash: string | null;
    visibility: ConversationVisibility;
    source: PrincipalProvider;
  };
  subject: {
    speakerSubjectRef: MemorySubjectRef | null;
    requestedSubjectRef: MemorySubjectRef | null;
    ownerSubjectRef: MemorySubjectRef | null;
  };
}

export type PrincipalAccessReason =
  | "owner_principal_matched"
  | "operator_principal_matched"
  | "speaker_scope_matched"
  | "session_only_allowed"
  | "public_safe"
  | "external_agent_limited"
  | "runtime_continuation_inherited"
  | "same_name_collision"
  | "non_owner_owner_private_blocked"
  | "public_route_private_memory_blocked"
  | "unknown_visibility_private_memory_blocked"
  | "legacy_global_owner_only"
  | "missing_principal_scope"
  | "subject_unresolved"
  | "blocked_by_policy";

export interface PrincipalAccessDecision {
  decisionId: string;
  requestId: string;
  operation: PrincipalAccessOperation;
  accessClass: PrincipalAccessClass;
  allowed: boolean;
  reason: PrincipalAccessReason;
}

export interface PrincipalAccessEnvelope {
  principalContext: PrincipalContext;
  accessDecision: PrincipalAccessDecision;
}

export interface IngressPrincipalInput {
  provider: ConfiguredPrincipalProvider;
  conversationId: string;
  userId: string;
  username: string;
  conversationVisibility: ConversationVisibility;
  transportIdentity?: ConversationTransportIdentityRecord | null;
  receivedAt: string;
  principalConfig?: OwnerOperatorPrincipalConfig | null;
  allowedUserIds?: readonly string[];
  allowedUsernames?: readonly string[];
}

/**
 * Builds principal context from verified transport ingress fields.
 */
export function derivePrincipalContextFromIngress(input: IngressPrincipalInput): PrincipalContext {
  const actor = deriveConversationPrincipalFromIngress(input);
  const speakerSubjectRef = buildSpeakerSubjectRef(actor);
  const ownerSubjectRef =
    actor.principalRole === "owner" && actor.providerUserIdHash
      ? {
          subjectKind: "owner_profile" as const,
          subjectId: actor.providerUserIdHash,
          ownerPrincipalIdHash: actor.providerUserIdHash,
          principalIdHash: actor.providerUserIdHash,
          legacyIdentityState: actor.legacyIdentityState
        }
      : null;

  return {
    requestId: `ingress:${input.provider}:${input.receivedAt}`,
    actor,
    route: {
      conversationId: input.conversationId,
      providerConversationIdHash: null,
      visibility: input.conversationVisibility,
      source: input.provider
    },
    subject: {
      speakerSubjectRef,
      requestedSubjectRef: null,
      ownerSubjectRef
    }
  };
}

/**
 * Builds a fail-closed principal context for legacy or recovered records.
 */
export function buildLegacyUnknownPrincipalContext(input: {
  requestId: string;
  conversationId?: string | null;
  conversationVisibility?: ConversationVisibility;
  source?: PrincipalProvider;
}): PrincipalContext {
  const visibility = input.conversationVisibility ?? "unknown";
  return {
    requestId: input.requestId,
    actor: {
      principalId: "legacy:unknown",
      principalRole: "legacy_unknown",
      provider: input.source ?? "legacy",
      providerUserIdHash: null,
      providerConversationIdHash: null,
      conversationId: input.conversationId ?? null,
      conversationVisibility: visibility,
      usernameHint: null,
      displayNameHint: null,
      transportObservedAt: null,
      ownerMatchSource: "legacy_unknown",
      identityAuthority: "legacy_unknown",
      legacyIdentityState: "legacy_actor_unknown"
    },
    route: {
      conversationId: input.conversationId ?? null,
      providerConversationIdHash: null,
      visibility,
      source: input.source ?? "legacy"
    },
    subject: {
      speakerSubjectRef: null,
      requestedSubjectRef: null,
      ownerSubjectRef: null
    }
  };
}

/**
 * Normalizes persisted principal context without upgrading malformed records.
 */
export function normalizePrincipalContext(input: unknown): PrincipalContext | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const candidate = input as Partial<PrincipalContext>;
  const actor = normalizeConversationPrincipal(candidate.actor);
  if (!actor || !candidate.route || typeof candidate.route !== "object") {
    return null;
  }
  const route = candidate.route as Partial<PrincipalContext["route"]>;
  const visibility = normalizeConversationVisibility(route.visibility);
  if (!visibility) {
    return null;
  }
  const source = normalizePrincipalProvider(route.source);
  if (!source || typeof candidate.requestId !== "string") {
    return null;
  }
  return {
    requestId: candidate.requestId,
    actor,
    route: {
      conversationId: typeof route.conversationId === "string" ? route.conversationId : null,
      providerConversationIdHash:
        typeof route.providerConversationIdHash === "string" ? route.providerConversationIdHash : null,
      visibility,
      source
    },
    subject: {
      speakerSubjectRef: normalizeMemorySubjectRef(candidate.subject?.speakerSubjectRef),
      requestedSubjectRef: normalizeMemorySubjectRef(candidate.subject?.requestedSubjectRef),
      ownerSubjectRef: normalizeMemorySubjectRef(candidate.subject?.ownerSubjectRef)
    }
  };
}

/**
 * Creates an operation-specific decision. It does not inspect business policy yet.
 */
export function requirePrincipalAccessForOperation(input: {
  principalContext: PrincipalContext | null | undefined;
  operation: PrincipalAccessOperation;
  accessClass: PrincipalAccessClass;
  allowed: boolean;
  reason: PrincipalAccessReason;
}): PrincipalAccessEnvelope {
  const principalContext =
    input.principalContext ??
    buildLegacyUnknownPrincipalContext({
      requestId: `missing:${input.operation}`,
      conversationVisibility: "unknown"
    });
  return {
    principalContext,
    accessDecision: {
      decisionId: `${principalContext.requestId}:${input.operation}`,
      requestId: principalContext.requestId,
      operation: input.operation,
      accessClass: input.accessClass,
      allowed: input.allowed,
      reason: input.reason
    }
  };
}

/**
 * Builds the task-execution access envelope carried by governed task requests.
 */
export function buildTaskExecutionPrincipalAccess(
  principalContext: PrincipalContext | null | undefined
): PrincipalAccessEnvelope {
  const context =
    principalContext ??
    buildLegacyUnknownPrincipalContext({
      requestId: "task_execution:legacy_unknown",
      conversationVisibility: "unknown"
    });
  const classification = classifyTaskExecutionAccess(context);
  return requirePrincipalAccessForOperation({
    principalContext: context,
    operation: "task_execution",
    accessClass: classification.accessClass,
    allowed: classification.allowed,
    reason: classification.reason
  });
}

/**
 * Builds the direct-reply access envelope carried into model prompt rendering.
 */
export function buildDirectReplyPrincipalAccess(
  principalContext: PrincipalContext | null | undefined
): PrincipalAccessEnvelope {
  const context =
    principalContext ??
    buildLegacyUnknownPrincipalContext({
      requestId: "direct_reply:legacy_unknown",
      conversationVisibility: "unknown"
    });
  const classification = classifyTaskExecutionAccess(context);
  return requirePrincipalAccessForOperation({
    principalContext: context,
    operation: "direct_reply",
    accessClass: classification.accessClass,
    allowed: classification.allowed,
    reason: classification.reason
  });
}

/**
 * Builds a federated external-agent context without treating the external agent as an owner.
 */
export function buildExternalAgentPrincipalContext(input: {
  externalAgentId: string;
  contractId: string;
  requestedAt: string;
}): PrincipalContext {
  const normalizedAgentId = input.externalAgentId.trim() || "unknown";
  const requestId = `federated:${input.contractId.trim() || "unknown"}`;
  return {
    requestId,
    actor: {
      principalId: `external_agent:${normalizedAgentId}`,
      principalRole: "external_agent",
      provider: "federated",
      providerUserIdHash: null,
      providerConversationIdHash: null,
      conversationId: null,
      conversationVisibility: "unknown",
      usernameHint: null,
      displayNameHint: normalizedAgentId,
      transportObservedAt: input.requestedAt,
      ownerMatchSource: "none",
      identityAuthority: "external_agent_contract",
      legacyIdentityState: "external_agent_limited"
    },
    route: {
      conversationId: null,
      providerConversationIdHash: null,
      visibility: "unknown",
      source: "federated"
    },
    subject: {
      speakerSubjectRef: null,
      requestedSubjectRef: null,
      ownerSubjectRef: null
    }
  };
}

/**
 * Builds an external-agent-limited task envelope for inbound federation.
 */
export function buildExternalAgentTaskPrincipalAccess(input: {
  externalAgentId: string;
  contractId: string;
  requestedAt: string;
}): PrincipalAccessEnvelope {
  return requirePrincipalAccessForOperation({
    principalContext: buildExternalAgentPrincipalContext(input),
    operation: "task_execution",
    accessClass: "external_agent_limited",
    allowed: true,
    reason: "external_agent_limited"
  });
}

export interface ModelPromptPrincipalAccessView {
  actorRole: PrincipalRole;
  routeVisibility: ConversationVisibility;
  accessClass: PrincipalAccessClass;
  accessAllowed: boolean;
  accessReason: PrincipalAccessReason;
  identityAuthority: IdentityAuthority;
  legacyIdentityState: LegacyIdentityState;
  ownerMatchSource: OwnerMatchSource;
}

/**
 * Returns a model-facing principal view without raw provider ids or stable principal hashes.
 */
export function renderPrincipalAccessForModelPrompt(
  envelope: PrincipalAccessEnvelope | null | undefined
): ModelPromptPrincipalAccessView | null {
  if (!envelope) {
    return null;
  }
  return {
    actorRole: envelope.principalContext.actor.principalRole,
    routeVisibility: envelope.principalContext.route.visibility,
    accessClass: envelope.accessDecision.accessClass,
    accessAllowed: envelope.accessDecision.allowed,
    accessReason: envelope.accessDecision.reason,
    identityAuthority: envelope.principalContext.actor.identityAuthority,
    legacyIdentityState: envelope.principalContext.actor.legacyIdentityState,
    ownerMatchSource: envelope.principalContext.actor.ownerMatchSource
  };
}

/**
 * Implements `deriveConversationPrincipalFromIngress` behavior within this module.
 */
function deriveConversationPrincipalFromIngress(input: IngressPrincipalInput): ConversationPrincipal {
  const normalizedProviderUserId = input.userId.trim();
  const configuredRole = resolveOwnerOperatorPrincipalRole(
    input.principalConfig,
    input.provider,
    normalizedProviderUserId
  );
  const providerUserIdHash =
    configuredRole?.principal.providerUserIdHash ??
    (
      normalizedProviderUserId
        ? input.principalConfig?.redactProviderUserId(input.provider, normalizedProviderUserId)
        : null
    ) ??
    null;
  const usernameHint = input.username.trim() || null;
  const displayNameHint =
    input.transportIdentity?.displayName ??
    input.transportIdentity?.givenName ??
    input.transportIdentity?.username ??
    usernameHint;
  const allowedByUserId = Boolean(input.allowedUserIds?.includes(input.userId));
  const allowedByUsername = usernameHint
    ? Boolean(
        input.allowedUsernames?.some(
          (allowed) => allowed.trim().toLowerCase() === usernameHint.toLowerCase()
        )
      )
    : false;
  const identityAuthority = resolveIdentityAuthority({
    configuredRole: configuredRole?.role ?? null,
    allowedByUserId,
    allowedByUsername,
    providerUserIdHash
  });
  const principalRole =
    configuredRole?.role ??
    (allowedByUserId || allowedByUsername
      ? "allowed_user"
      : providerUserIdHash
        ? "conversation_participant"
        : "legacy_unknown");

  return {
    principalId: providerUserIdHash ?? `legacy:${input.provider}:unknown`,
    principalRole,
    provider: input.provider,
    providerUserIdHash,
    providerConversationIdHash: null,
    conversationId: input.conversationId,
    conversationVisibility: input.conversationVisibility,
    usernameHint,
    displayNameHint,
    transportObservedAt: input.transportIdentity?.observedAt ?? input.receivedAt,
    ownerMatchSource:
      configuredRole?.role === "owner"
        ? "provider_user_id"
        : configuredRole?.role === "operator"
          ? "operator_provider_user_id"
          : "none",
    identityAuthority,
    legacyIdentityState: providerUserIdHash ? "principal_verified" : "legacy_actor_unknown"
  };
}

/**
 * Implements `classifyTaskExecutionAccess` behavior within this module.
 */
function classifyTaskExecutionAccess(context: PrincipalContext): {
  accessClass: PrincipalAccessClass;
  allowed: boolean;
  reason: PrincipalAccessReason;
} {
  if (context.actor.principalRole === "legacy_unknown") {
    return {
      accessClass: "blocked",
      allowed: false,
      reason: "missing_principal_scope"
    };
  }
  if (context.actor.principalRole === "external_agent") {
    return {
      accessClass: "external_agent_limited",
      allowed: true,
      reason: "external_agent_limited"
    };
  }
  if (context.actor.principalRole === "runtime_continuation") {
    return {
      accessClass: "runtime_continuation_limited",
      allowed: true,
      reason: "runtime_continuation_inherited"
    };
  }
  if (context.route.visibility === "public") {
    return {
      accessClass: "shared_public",
      allowed: true,
      reason: "public_safe"
    };
  }
  if (context.actor.principalRole === "owner") {
    return {
      accessClass: "owner_private",
      allowed: true,
      reason: "owner_principal_matched"
    };
  }
  if (context.actor.principalRole === "operator") {
    return {
      accessClass: "operator_private",
      allowed: true,
      reason: "operator_principal_matched"
    };
  }
  return {
    accessClass: "speaker_private",
    allowed: true,
    reason: "speaker_scope_matched"
  };
}

/**
 * Implements `resolveIdentityAuthority` behavior within this module.
 */
function resolveIdentityAuthority(input: {
  configuredRole: "owner" | "operator" | null;
  allowedByUserId: boolean;
  allowedByUsername: boolean;
  providerUserIdHash: string | null;
}): IdentityAuthority {
  if (input.configuredRole === "owner") {
    return "configured_owner_provider_user_id";
  }
  if (input.configuredRole === "operator") {
    return "configured_operator_provider_user_id";
  }
  if (input.allowedByUserId) {
    return "allowlisted_provider_user_id";
  }
  if (input.allowedByUsername) {
    return "allowlisted_username";
  }
  return input.providerUserIdHash ? "transport_hint" : "legacy_unknown";
}

/**
 * Implements `buildSpeakerSubjectRef` behavior within this module.
 */
function buildSpeakerSubjectRef(actor: ConversationPrincipal): MemorySubjectRef | null {
  if (!actor.providerUserIdHash) {
    return null;
  }
  return {
    subjectKind: actor.principalRole === "owner" ? "owner_profile" : "principal_profile",
    subjectId: actor.providerUserIdHash,
    ownerPrincipalIdHash:
      actor.principalRole === "owner" ? actor.providerUserIdHash : null,
    principalIdHash: actor.providerUserIdHash,
    legacyIdentityState: actor.legacyIdentityState
  };
}

/**
 * Implements `normalizeConversationPrincipal` behavior within this module.
 */
function normalizeConversationPrincipal(input: unknown): ConversationPrincipal | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const candidate = input as Partial<ConversationPrincipal>;
  const provider = normalizePrincipalProvider(candidate.provider);
  const principalRole = normalizePrincipalRole(candidate.principalRole);
  const visibility = normalizeConversationVisibility(candidate.conversationVisibility);
  const ownerMatchSource = normalizeOwnerMatchSource(candidate.ownerMatchSource);
  const identityAuthority = normalizeIdentityAuthority(candidate.identityAuthority);
  const legacyIdentityState = normalizeLegacyIdentityState(candidate.legacyIdentityState);
  if (
    !provider ||
    !principalRole ||
    !visibility ||
    !ownerMatchSource ||
    !identityAuthority ||
    !legacyIdentityState ||
    typeof candidate.principalId !== "string"
  ) {
    return null;
  }
  return {
    principalId: candidate.principalId,
    principalRole,
    provider,
    providerUserIdHash:
      typeof candidate.providerUserIdHash === "string" ? candidate.providerUserIdHash : null,
    providerConversationIdHash:
      typeof candidate.providerConversationIdHash === "string"
        ? candidate.providerConversationIdHash
        : null,
    providerEventIdHash:
      typeof candidate.providerEventIdHash === "string" ? candidate.providerEventIdHash : null,
    conversationId: typeof candidate.conversationId === "string" ? candidate.conversationId : null,
    conversationVisibility: visibility,
    usernameHint: typeof candidate.usernameHint === "string" ? candidate.usernameHint : null,
    displayNameHint:
      typeof candidate.displayNameHint === "string" ? candidate.displayNameHint : null,
    transportObservedAt:
      typeof candidate.transportObservedAt === "string" ? candidate.transportObservedAt : null,
    ownerMatchSource,
    identityAuthority,
    legacyIdentityState
  };
}

/**
 * Implements `normalizeMemorySubjectRef` behavior within this module.
 */
function normalizeMemorySubjectRef(input: unknown): MemorySubjectRef | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const candidate = input as Partial<MemorySubjectRef>;
  const subjectKind = normalizeMemorySubjectKind(candidate.subjectKind);
  if (!subjectKind || typeof candidate.subjectId !== "string") {
    return null;
  }
  return {
    subjectKind,
    subjectId: candidate.subjectId,
    ownerPrincipalIdHash:
      typeof candidate.ownerPrincipalIdHash === "string" ? candidate.ownerPrincipalIdHash : null,
    principalIdHash:
      typeof candidate.principalIdHash === "string" ? candidate.principalIdHash : null,
    legacyIdentityState: normalizeLegacyIdentityState(candidate.legacyIdentityState) ?? undefined
  };
}

/**
 * Implements `normalizeConversationVisibility` behavior within this module.
 */
function normalizeConversationVisibility(value: unknown): ConversationVisibility | null {
  return value === "private" || value === "public" || value === "unknown" ? value : null;
}

/**
 * Implements `normalizePrincipalProvider` behavior within this module.
 */
function normalizePrincipalProvider(value: unknown): PrincipalProvider | null {
  return value === "telegram" ||
    value === "discord" ||
    value === "cli" ||
    value === "federated" ||
    value === "runtime" ||
    value === "local_operator" ||
    value === "legacy"
    ? value
    : null;
}

/**
 * Implements `normalizePrincipalRole` behavior within this module.
 */
function normalizePrincipalRole(value: unknown): PrincipalRole | null {
  return value === "owner" ||
    value === "operator" ||
    value === "allowed_user" ||
    value === "conversation_participant" ||
    value === "external_agent" ||
    value === "runtime_continuation" ||
    value === "local_operator" ||
    value === "legacy_unknown" ||
    value === "unknown"
    ? value
    : null;
}

/**
 * Implements `normalizeOwnerMatchSource` behavior within this module.
 */
function normalizeOwnerMatchSource(value: unknown): OwnerMatchSource | null {
  return value === "provider_user_id" ||
    value === "local_operator_trusted_mode" ||
    value === "operator_provider_user_id" ||
    value === "none" ||
    value === "legacy_unknown"
    ? value
    : null;
}

/**
 * Implements `normalizeIdentityAuthority` behavior within this module.
 */
function normalizeIdentityAuthority(value: unknown): IdentityAuthority | null {
  return value === "configured_owner_provider_user_id" ||
    value === "configured_operator_provider_user_id" ||
    value === "allowlisted_provider_user_id" ||
    value === "allowlisted_username" ||
    value === "external_agent_contract" ||
    value === "runtime_inherited" ||
    value === "transport_hint" ||
    value === "legacy_unknown"
    ? value
    : null;
}

/**
 * Implements `normalizeLegacyIdentityState` behavior within this module.
 */
function normalizeLegacyIdentityState(value: unknown): LegacyIdentityState | null {
  return value === "principal_verified" ||
    value === "legacy_actor_unknown" ||
    value === "legacy_global_memory" ||
    value === "runtime_continuation_missing_origin" ||
    value === "external_agent_limited" ||
    value === "test_override"
    ? value
    : null;
}

/**
 * Implements `normalizeMemorySubjectKind` behavior within this module.
 */
function normalizeMemorySubjectKind(value: unknown): MemorySubjectKind | null {
  return value === "owner_profile" ||
    value === "principal_profile" ||
    value === "conversation_participant" ||
    value === "contact" ||
    value === "organization" ||
    value === "project" ||
    value === "document_subject" ||
    value === "legacy_global_profile" ||
    value === "agent_global_learning" ||
    value === "workspace_local" ||
    value === "unknown"
    ? value
    : null;
}
