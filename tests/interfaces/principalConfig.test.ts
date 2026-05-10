/**
 * @fileoverview Tests owner/operator principal config parsing separate from interface ingress allowlists.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createOwnerOperatorPrincipalConfigFromEnv,
  redactProviderUserIdForPrincipalAudit,
  resolveOwnerOperatorPrincipalRole
} from "../../src/interfaces/principalRuntime/principalConfig";
import { createInterfaceRuntimeConfigFromEnv } from "../../src/interfaces/runtimeConfig";

const HMAC_KEY = "test-principal-hmac-key";

test("principal config defaults to no owner or operator principals", () => {
  const config = createOwnerOperatorPrincipalConfigFromEnv({});

  assert.deepEqual(config.ownerPrincipals, []);
  assert.deepEqual(config.operatorPrincipals, []);
  assert.equal(config.localOperatorTrustedMode, false);
  assert.equal(config.hmacKeyConfigured, false);
});

test("principal config resolves exact owner and operator provider ids", () => {
  const config = createOwnerOperatorPrincipalConfigFromEnv({
    BRAIN_PRINCIPAL_HMAC_KEY: HMAC_KEY,
    BRAIN_OWNER_TELEGRAM_USER_IDS: "owner-user-1",
    BRAIN_OPERATOR_DISCORD_USER_IDS: "operator-user-1"
  });

  assert.equal(
    resolveOwnerOperatorPrincipalRole(config, "telegram", "owner-user-1")?.role,
    "owner"
  );
  assert.equal(
    resolveOwnerOperatorPrincipalRole(config, "discord", "operator-user-1")?.role,
    "operator"
  );
  assert.equal(resolveOwnerOperatorPrincipalRole(config, "telegram", "operator-user-1"), null);
  assert.equal(resolveOwnerOperatorPrincipalRole(config, "discord", "owner-user-1"), null);
});

test("principal config does not treat usernames as owner ids", () => {
  const runtimeConfig = createInterfaceRuntimeConfigFromEnv({
    BRAIN_INTERFACE_PROVIDER: "telegram",
    BRAIN_INTERFACE_SHARED_SECRET: "secret",
    BRAIN_INTERFACE_ALLOWED_USERNAMES: "owner_handle",
    BRAIN_INTERFACE_ALLOWED_USER_IDS: "allowed-user-1",
    TELEGRAM_BOT_TOKEN: "telegram-token"
  });

  assert.equal(runtimeConfig.security.allowedUsernames[0], "owner_handle");
  assert.deepEqual(runtimeConfig.security.principalConfig?.ownerPrincipals, []);
  assert.equal(
    resolveOwnerOperatorPrincipalRole(
      runtimeConfig.security.principalConfig,
      "telegram",
      "allowed-user-1"
    ),
    null
  );
});

test("principal config requires HMAC key when owner or operator ids are configured", () => {
  assert.throws(
    () =>
      createOwnerOperatorPrincipalConfigFromEnv({
        BRAIN_OWNER_TELEGRAM_USER_IDS: "owner-user-1"
      }),
    /BRAIN_PRINCIPAL_HMAC_KEY/
  );
});

test("principal config rejects malformed ids without echoing raw id", () => {
  const rawUnsafeId = "owner user unsafe";
  assert.throws(
    () =>
      createOwnerOperatorPrincipalConfigFromEnv({
        BRAIN_PRINCIPAL_HMAC_KEY: HMAC_KEY,
        BRAIN_OWNER_DISCORD_USER_IDS: rawUnsafeId
      }),
    (error) =>
      error instanceof Error &&
      error.message.includes("safe identifier") &&
      !error.message.includes(rawUnsafeId)
  );
});

test("principal config redacts provider user ids with keyed HMAC", () => {
  const redacted = redactProviderUserIdForPrincipalAudit(
    HMAC_KEY,
    "telegram",
    "owner-user-1"
  );

  assert.match(redacted, /^telegram:/);
  assert.equal(redacted.includes("owner-user-1"), false);
  assert.equal(
    redacted,
    redactProviderUserIdForPrincipalAudit(HMAC_KEY, "telegram", "owner-user-1")
  );
  assert.notEqual(
    redacted,
    redactProviderUserIdForPrincipalAudit("different-principal-key", "telegram", "owner-user-1")
  );
});

test("principal config requires explicit local operator trusted mode latch", () => {
  assert.equal(
    createOwnerOperatorPrincipalConfigFromEnv({}).localOperatorTrustedMode,
    false
  );
  assert.equal(
    createOwnerOperatorPrincipalConfigFromEnv({
      BRAIN_LOCAL_OPERATOR_TRUSTED_MODE: "true"
    }).localOperatorTrustedMode,
    true
  );
});
