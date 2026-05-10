/**
 * @fileoverview Tests principal-aware profile-memory access policy decisions.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { evaluateProfileMemoryAccessPolicy } from "../../src/core/profileMemoryRuntime/profileMemoryAccessPolicy";
import {
  buildExternalAgentTaskPrincipalAccess,
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
