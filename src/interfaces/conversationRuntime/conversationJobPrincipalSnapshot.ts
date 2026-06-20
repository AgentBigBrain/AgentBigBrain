/**
 * @fileoverview Redacted job-origin principal snapshots for persisted conversation jobs.
 */

import type { TaskPrincipalAccessEnvelope } from "../../core/types";
import type {
  ConversationJob,
  ConversationVisibility
} from "./sessionStateContracts";
import type {
  ConversationJobPrincipalSnapshot,
  ConversationJobPrincipalSnapshotState
} from "./conversationJobPrincipalSnapshotContracts";
import type {
  IdentityAuthority,
  LegacyIdentityState,
  OwnerMatchSource,
  PrincipalAccessClass,
  PrincipalAccessEnvelope,
  PrincipalAccessOperation,
  PrincipalAccessReason,
  PrincipalRole
} from "../principalRuntime/principalAccess";

const PRINCIPAL_ROLES = new Set<PrincipalRole>([
  "owner",
  "operator",
  "allowed_user",
  "conversation_participant",
  "external_agent",
  "runtime_continuation",
  "local_operator",
  "legacy_unknown",
  "unknown"
]);

const CONVERSATION_VISIBILITIES = new Set<ConversationVisibility>([
  "private",
  "public",
  "unknown"
]);

const ACCESS_OPERATIONS = new Set<PrincipalAccessOperation>([
  "command_dispatch",
  "route_metadata_ingress",
  "direct_reply",
  "task_execution",
  "queued_job_ownership",
  "profile_read",
  "profile_write",
  "profile_continuity_query",
  "memory_review",
  "source_recall_capture",
  "source_recall_retrieve",
  "source_recall_project",
  "entity_graph_write",
  "projection_review_action",
  "proposal_control",
  "clarification_control",
  "active_prompt_state",
  "delivery_preview_render",
  "consent_approval_text",
  "approval",
  "governance_vote",
  "execution_receipt",
  "runtime_trace",
  "learning_write",
  "pulse_delivery",
  "skill_lifecycle",
  "backend_profile_override",
  "autonomous_abort",
  "media_file_download_or_cache",
  "timer_or_delayed_delivery",
  "workspace_recovery_control",
  "workspace_artifact_ownership",
  "browser_or_process_lease_ownership",
  "local_path_authority",
  "resource_close_or_cleanup",
  "provider_credential_or_cost_budget",
  "diagnostic_or_debug_surface",
  "model_prompt_egress"
]);

const ACCESS_CLASSES = new Set<PrincipalAccessClass>([
  "owner_private",
  "operator_private",
  "speaker_private",
  "shared_public",
  "session_only",
  "workspace_local",
  "agent_global_safe",
  "external_agent_limited",
  "runtime_continuation_limited",
  "review_only",
  "blocked"
]);

const ACCESS_REASONS = new Set<PrincipalAccessReason>([
  "owner_principal_matched",
  "operator_principal_matched",
  "speaker_scope_matched",
  "session_only_allowed",
  "public_safe",
  "external_agent_limited",
  "runtime_continuation_inherited",
  "same_name_collision",
  "non_owner_owner_private_blocked",
  "public_route_private_memory_blocked",
  "unknown_visibility_private_memory_blocked",
  "legacy_global_owner_only",
  "missing_principal_scope",
  "subject_unresolved",
  "blocked_by_policy"
]);

const IDENTITY_AUTHORITIES = new Set<IdentityAuthority>([
  "configured_owner_provider_user_id",
  "configured_operator_provider_user_id",
  "allowlisted_provider_user_id",
  "allowlisted_username",
  "external_agent_contract",
  "runtime_inherited",
  "transport_hint",
  "legacy_unknown"
]);

const OWNER_MATCH_SOURCES = new Set<OwnerMatchSource>([
  "provider_user_id",
  "local_operator_trusted_mode",
  "operator_provider_user_id",
  "none",
  "legacy_unknown"
]);

const LEGACY_IDENTITY_STATES = new Set<LegacyIdentityState>([
  "principal_verified",
  "legacy_actor_unknown",
  "legacy_global_memory",
  "runtime_continuation_missing_origin",
  "external_agent_limited",
  "test_override"
]);

const SNAPSHOT_STATES = new Set<ConversationJobPrincipalSnapshotState>([
  "verified",
  "legacy_actor_unknown",
  "malformed_blocked"
]);

/**
 * Builds a fail-closed legacy snapshot for actorless or malformed persisted jobs.
 */
export function buildLegacyConversationJobPrincipalSnapshot(
  state: Extract<ConversationJobPrincipalSnapshotState, "legacy_actor_unknown" | "malformed_blocked"> =
    "legacy_actor_unknown"
): ConversationJobPrincipalSnapshot {
  return {
    snapshotState: state,
    principalRole: "legacy_unknown",
    routeVisibility: "unknown",
    accessOperation: "queued_job_ownership",
    accessClass: "blocked",
    accessAllowed: false,
    accessReason: "missing_principal_scope",
    identityAuthority: "legacy_unknown",
    ownerMatchSource: "legacy_unknown",
    legacyIdentityState: "legacy_actor_unknown",
    principalIdHash: null,
    providerUserIdHash: null,
    decisionId: null
  };
}

/**
 * Captures the redacted job-origin authority labels from one operation-specific envelope.
 */
export function buildConversationJobPrincipalSnapshotFromAccess(
  principalAccess: PrincipalAccessEnvelope | null | undefined
): ConversationJobPrincipalSnapshot {
  if (!principalAccess) {
    return buildLegacyConversationJobPrincipalSnapshot();
  }

  const actor = principalAccess.principalContext.actor;
  const access = principalAccess.accessDecision;
  const snapshotState: ConversationJobPrincipalSnapshotState =
    access.allowed === true && actor.principalRole !== "legacy_unknown"
      ? "verified"
      : "legacy_actor_unknown";
  const providerUserIdHash = actor.providerUserIdHash ?? null;

  return {
    snapshotState,
    principalRole: actor.principalRole,
    routeVisibility: principalAccess.principalContext.route.visibility,
    accessOperation: access.operation,
    accessClass: access.accessClass,
    accessAllowed: access.allowed,
    accessReason: access.reason,
    identityAuthority: actor.identityAuthority,
    ownerMatchSource: actor.ownerMatchSource,
    legacyIdentityState: actor.legacyIdentityState,
    principalIdHash: providerUserIdHash,
    providerUserIdHash,
    decisionId: access.decisionId
  };
}

/**
 * Normalizes persisted job-origin principal snapshots without upgrading malformed records.
 */
export function normalizeConversationJobPrincipalSnapshot(
  candidate: unknown
): ConversationJobPrincipalSnapshot {
  if (!candidate || typeof candidate !== "object") {
    return buildLegacyConversationJobPrincipalSnapshot();
  }

  const value = candidate as Partial<ConversationJobPrincipalSnapshot>;
  if (
    !isOneOf(value.snapshotState, SNAPSHOT_STATES) ||
    !isOneOf(value.principalRole, PRINCIPAL_ROLES) ||
    !isOneOf(value.routeVisibility, CONVERSATION_VISIBILITIES) ||
    !isOneOf(value.accessOperation, ACCESS_OPERATIONS) ||
    !isOneOf(value.accessClass, ACCESS_CLASSES) ||
    typeof value.accessAllowed !== "boolean" ||
    !isOneOf(value.accessReason, ACCESS_REASONS) ||
    !isOneOf(value.identityAuthority, IDENTITY_AUTHORITIES) ||
    !isOneOf(value.ownerMatchSource, OWNER_MATCH_SOURCES) ||
    !isOneOf(value.legacyIdentityState, LEGACY_IDENTITY_STATES)
  ) {
    return buildLegacyConversationJobPrincipalSnapshot("malformed_blocked");
  }

  if (
    value.snapshotState !== "verified" &&
    (value.accessAllowed || value.accessClass !== "blocked")
  ) {
    return buildLegacyConversationJobPrincipalSnapshot("malformed_blocked");
  }

  return {
    snapshotState: value.snapshotState,
    principalRole: value.principalRole,
    routeVisibility: value.routeVisibility,
    accessOperation: value.accessOperation,
    accessClass: value.accessClass,
    accessAllowed: value.accessAllowed,
    accessReason: value.accessReason,
    identityAuthority: value.identityAuthority,
    ownerMatchSource: value.ownerMatchSource,
    legacyIdentityState: value.legacyIdentityState,
    principalIdHash: normalizeHash(value.principalIdHash),
    providerUserIdHash: normalizeHash(value.providerUserIdHash),
    decisionId: normalizeDecisionId(value.decisionId)
  };
}

/**
 * Returns true only when a job-origin snapshot may support protected job-owned behavior.
 */
export function canUseConversationJobPrincipalSnapshotForProtectedBehavior(
  job: Pick<ConversationJob, "principalSnapshot">
): boolean {
  return job.principalSnapshot?.snapshotState === "verified" &&
    job.principalSnapshot.accessAllowed === true &&
    job.principalSnapshot.accessClass !== "blocked" &&
    job.principalSnapshot.principalRole !== "legacy_unknown";
}

/**
 * Builds a minimal operation-scoped principal envelope from a verified job-origin snapshot.
 */
export function buildConversationJobPrincipalAccessForOperation(
  job: Pick<ConversationJob, "id" | "principalSnapshot">,
  operation: PrincipalAccessOperation
): TaskPrincipalAccessEnvelope | undefined {
  if (!canUseConversationJobPrincipalSnapshotForProtectedBehavior(job) || !job.principalSnapshot) {
    return undefined;
  }
  const snapshot = job.principalSnapshot;
  const requestId = `conversation_job:${job.id}:${operation}`;
  return {
    principalContext: {
      requestId,
      actor: {
        principalRole: snapshot.principalRole,
        providerUserIdHash: snapshot.providerUserIdHash,
        identityAuthority: snapshot.identityAuthority,
        ownerMatchSource: snapshot.ownerMatchSource,
        legacyIdentityState: snapshot.legacyIdentityState
      },
      route: {
        visibility: snapshot.routeVisibility
      },
      subject: {}
    },
    accessDecision: {
      decisionId: `${snapshot.decisionId ?? job.id}:${operation}`,
      requestId,
      operation,
      accessClass: snapshot.accessClass,
      allowed: true,
      reason: snapshot.accessReason
    }
  };
}

/**
 * Preserves verified job-origin snapshots when merge candidates disagree.
 */
export function selectPreferredConversationJobPrincipalSnapshot(
  existing: ConversationJobPrincipalSnapshot | undefined,
  incoming: ConversationJobPrincipalSnapshot | undefined,
  preferred: ConversationJobPrincipalSnapshot | undefined
): ConversationJobPrincipalSnapshot | undefined {
  if (existing?.snapshotState === "verified" && incoming?.snapshotState !== "verified") {
    return existing;
  }
  if (incoming?.snapshotState === "verified" && existing?.snapshotState !== "verified") {
    return incoming;
  }
  return preferred;
}

/**
 * Implements `isOneOf` behavior within this module.
 */
function isOneOf<T extends string>(value: unknown, allowed: ReadonlySet<T>): value is T {
  return typeof value === "string" && allowed.has(value as T);
}

/**
 * Implements `normalizeHash` behavior within this module.
 */
function normalizeHash(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Implements `normalizeDecisionId` behavior within this module.
 */
function normalizeDecisionId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
