/**
 * @fileoverview Tests principal-aware profile-memory access policy decisions.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { createEmptyProfileMemoryState } from "../../src/core/profileMemory";
import { evaluateProfileMemoryAccessPolicy } from "../../src/core/profileMemoryRuntime/profileMemoryAccessPolicy";
import { readProfileFacts } from "../../src/core/profileMemoryRuntime/profileMemoryQueries";
import {
  buildExternalAgentTaskPrincipalAccess,
  buildProjectionReviewActionPrincipalAccess,
  buildTaskExecutionPrincipalAccess,
  derivePrincipalContextFromIngress
} from "../../src/interfaces/principalRuntime/principalAccess";
import { createOwnerOperatorPrincipalConfigFromEnv } from "../../src/interfaces/principalRuntime/principalConfig";

const PRINCIPAL_KEY = "test-principal-hmac-key";

function buildOwnerAccess() {
  const principalConfig = createOwnerOperatorPrincipalConfigFromEnv({
    BRAIN_PRINCIPAL_HMAC_KEY: PRINCIPAL_KEY,
    BRAIN_OWNER_TELEGRAM_USER_IDS: "owner-user-1"
  });
  const context = derivePrincipalContextFromIngress({
    provider: "telegram",
    conversationId: "chat-1",
    userId: "owner-user-1",
    username: "owner",
    conversationVisibility: "private",
    receivedAt: "2026-05-10T12:00:00.000Z",
    principalConfig
  });
  return buildTaskExecutionPrincipalAccess(context);
}

function buildAllowedUserAccess(route: "private" | "public" = "private") {
  const context = derivePrincipalContextFromIngress({
    provider: "discord",
    conversationId: "channel-1",
    userId: "participant-user-1",
    username: "participant",
    conversationVisibility: route,
    receivedAt: "2026-05-10T12:00:00.000Z",
    allowedUsernames: ["participant"]
  });
  return buildTaskExecutionPrincipalAccess(context);
}

function buildOperatorAccess(route: "private" | "public" = "private") {
  const principalConfig = createOwnerOperatorPrincipalConfigFromEnv({
    BRAIN_PRINCIPAL_HMAC_KEY: PRINCIPAL_KEY,
    BRAIN_OPERATOR_TELEGRAM_USER_IDS: "operator-user-1"
  });
  const context = derivePrincipalContextFromIngress({
    provider: "telegram",
    conversationId: "chat-1",
    userId: "operator-user-1",
    username: "operator",
    conversationVisibility: route,
    receivedAt: "2026-05-10T12:00:00.000Z",
    principalConfig
  });
  return buildTaskExecutionPrincipalAccess(context);
}

test("profile-memory policy allows owner-private access only for owner private route", () => {
  const decision = evaluateProfileMemoryAccessPolicy({
    principalAccess: buildOwnerAccess(),
    operation: "profile_read",
    requestedSubjectKind: "owner_profile"
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, "owner_private_allowed");
});

test("profile-memory policy blocks non-owner owner-private memory", () => {
  const decision = evaluateProfileMemoryAccessPolicy({
    principalAccess: buildAllowedUserAccess(),
    operation: "profile_read",
    requestedSubjectKind: "owner_profile"
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "non_owner_owner_private_blocked");
});

test("profile-memory policy treats legacy global profile as owner-only", () => {
  const nonOwner = evaluateProfileMemoryAccessPolicy({
    principalAccess: buildAllowedUserAccess(),
    operation: "profile_read",
    requestedSubjectKind: "legacy_global_profile"
  });
  const owner = evaluateProfileMemoryAccessPolicy({
    principalAccess: buildOwnerAccess(),
    operation: "profile_read",
    requestedSubjectKind: "legacy_global_profile"
  });

  assert.equal(nonOwner.allowed, false);
  assert.equal(nonOwner.reason, "legacy_global_owner_only");
  assert.equal(owner.allowed, true);
});

test("profile-memory policy blocks public routes from private memory", () => {
  const decision = evaluateProfileMemoryAccessPolicy({
    principalAccess: buildAllowedUserAccess("public"),
    operation: "profile_read",
    requestedSubjectKind: "owner_profile"
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "public_route_private_memory_blocked");
});

test("profile-memory policy blocks missing principal and external owner-private access", () => {
  const missing = evaluateProfileMemoryAccessPolicy({
    operation: "profile_read",
    requestedSubjectKind: "owner_profile"
  });
  const external = evaluateProfileMemoryAccessPolicy({
    principalAccess: buildExternalAgentTaskPrincipalAccess({
      externalAgentId: "partner-agent",
      contractId: "partner-agent:quote-1",
      requestedAt: "2026-05-10T12:00:00.000Z"
    }),
    operation: "profile_write",
    requestedSubjectKind: "owner_profile"
  });

  assert.equal(missing.allowed, false);
  assert.equal(missing.reason, "missing_principal_scope");
  assert.equal(external.allowed, false);
  assert.equal(external.reason, "external_agent_owner_private_blocked");
});

test("sensitivity approval does not become principal authority", () => {
  const decision = evaluateProfileMemoryAccessPolicy({
    principalAccess: buildAllowedUserAccess(),
    operation: "profile_read",
    requestedSubjectKind: "owner_profile",
    includeSensitive: true,
    explicitHumanApproval: true
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, "sensitivity_approval_is_not_principal_authority");
});

test("profile-memory policy allows private operator memory review only", () => {
  const allowed = evaluateProfileMemoryAccessPolicy({
    principalAccess: buildOperatorAccess(),
    operation: "memory_review",
    requestedSubjectKind: "owner_profile",
    includeSensitive: true,
    explicitHumanApproval: true
  });
  const publicBlocked = evaluateProfileMemoryAccessPolicy({
    principalAccess: buildOperatorAccess("public"),
    operation: "memory_review",
    requestedSubjectKind: "owner_profile",
    includeSensitive: true,
    explicitHumanApproval: true
  });

  assert.equal(allowed.allowed, true);
  assert.equal(allowed.reason, "operator_review_allowed");
  assert.equal(publicBlocked.allowed, false);
  assert.equal(publicBlocked.reason, "public_route_private_memory_blocked");
});

test("profile-memory policy allows only typed local-operator projection review access", () => {
  const principalAccess = buildProjectionReviewActionPrincipalAccess({
    localOperatorTrustedMode: true,
    requestedAt: "2026-05-10T12:00:00.000Z"
  });
  const allowedWrite = evaluateProfileMemoryAccessPolicy({
    principalAccess,
    operation: "profile_write",
    requestedSubjectKind: "owner_profile"
  });
  const allowedReadback = evaluateProfileMemoryAccessPolicy({
    principalAccess,
    operation: "profile_read",
    requestedSubjectKind: "owner_profile"
  });
  const blocked = evaluateProfileMemoryAccessPolicy({
    principalAccess: buildProjectionReviewActionPrincipalAccess({
      localOperatorTrustedMode: false,
      requestedAt: "2026-05-10T12:00:00.000Z"
    }),
    operation: "profile_write",
    requestedSubjectKind: "owner_profile"
  });

  assert.equal(allowedWrite.allowed, true);
  assert.equal(allowedWrite.reason, "local_operator_review_action_allowed");
  assert.equal(allowedReadback.allowed, true);
  assert.equal(allowedReadback.reason, "local_operator_review_action_allowed");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "missing_principal_scope");
});

test("profile fact reads enforce principal policy when subject scope is requested", () => {
  const state = createEmptyProfileMemoryState();
  state.facts.push({
    id: "fact_owner_name",
    key: "identity.preferred_name",
    value: "Configured Owner",
    sensitive: false,
    status: "confirmed",
    confidence: 0.98,
    sourceTaskId: "task_seed",
    source: "test_fixture",
    observedAt: "2026-05-10T12:00:00.000Z",
    confirmedAt: "2026-05-10T12:00:00.000Z",
    supersededAt: null,
    lastUpdatedAt: "2026-05-10T12:00:00.000Z"
  });

  const blocked = readProfileFacts(state, {
    purpose: "planning_context",
    includeSensitive: false,
    requestedSubjectKind: "owner_profile",
    principalAccess: buildAllowedUserAccess()
  });
  const allowed = readProfileFacts(state, {
    purpose: "planning_context",
    includeSensitive: false,
    requestedSubjectKind: "owner_profile",
    principalAccess: buildOwnerAccess()
  });

  assert.equal(blocked.length, 0);
  assert.equal(allowed.length, 1);
  assert.equal(allowed[0]?.key, "identity.preferred_name");
});

test("profile fact reads fail closed when principal metadata is missing", () => {
  const state = createEmptyProfileMemoryState();
  state.facts.push({
    id: "fact_owner_identity_without_principal",
    key: "identity.preferred_name",
    value: "Configured Owner",
    sensitive: false,
    status: "confirmed",
    confidence: 0.98,
    sourceTaskId: "task_seed",
    source: "test_fixture",
    observedAt: "2026-05-10T12:00:00.000Z",
    confirmedAt: "2026-05-10T12:00:00.000Z",
    supersededAt: null,
    lastUpdatedAt: "2026-05-10T12:00:00.000Z"
  });

  const readable = readProfileFacts(state, {
    purpose: "planning_context",
    includeSensitive: false
  });

  assert.equal(readable.length, 0);
});
