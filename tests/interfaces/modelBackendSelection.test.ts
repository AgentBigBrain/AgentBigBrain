/**
 * @fileoverview Covers per-session backend/profile selection helpers for interface runtime.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildConversationModelEnvironment,
  resolveConversationModelSelection
} from "../../src/interfaces/conversationRuntime/modelBackendSelection";
import { createOwnerOperatorPrincipalConfigFromEnv } from "../../src/interfaces/principalRuntime/principalConfig";
import {
  derivePrincipalContextFromIngress,
  type PrincipalContext
} from "../../src/interfaces/principalRuntime/principalAccess";

function buildPrincipalContext(role: "owner" | "allowed_user"): PrincipalContext {
  const principalConfig = createOwnerOperatorPrincipalConfigFromEnv({
    BRAIN_PRINCIPAL_HMAC_KEY: "test-principal-hmac-key",
    BRAIN_OWNER_TELEGRAM_USER_IDS: role === "owner" ? "user-1" : undefined
  });
  return derivePrincipalContextFromIngress({
    provider: "telegram",
    conversationId: "chat-1",
    userId: "user-1",
    username: "agentowner",
    conversationVisibility: "private",
    receivedAt: "2026-03-07T12:00:00.000Z",
    principalConfig,
    allowedUserIds: role === "allowed_user" ? ["user-1"] : []
  });
}

test("resolveConversationModelSelection uses the process default backend when no override exists", () => {
  const selection = resolveConversationModelSelection(null, {
    BRAIN_MODEL_BACKEND: "openai_api"
  });

  assert.deepEqual(selection, {
    backend: "openai_api",
    codexProfileId: null
  });
});

test("resolveConversationModelSelection keeps the selected Codex profile for codex_oauth sessions", () => {
  const selection = resolveConversationModelSelection(
    {
      modelBackendOverride: "codex_oauth",
      codexAuthProfileId: "work",
      principalContext: buildPrincipalContext("owner")
    },
    {
      BRAIN_MODEL_BACKEND: "openai_api",
      CODEX_AUTH_PROFILE: "default"
    }
  );

  assert.deepEqual(selection, {
    backend: "codex_oauth",
    codexProfileId: "work"
  });
});

test("resolveConversationModelSelection ignores protected session Codex backend for non-owner principals", () => {
  const selection = resolveConversationModelSelection(
    {
      modelBackendOverride: "codex_oauth",
      codexAuthProfileId: "work",
      principalContext: buildPrincipalContext("allowed_user")
    },
    {
      BRAIN_MODEL_BACKEND: "openai_api",
      CODEX_AUTH_PROFILE: "default"
    }
  );

  assert.deepEqual(selection, {
    backend: "openai_api",
    codexProfileId: null
  });
});

test("resolveConversationModelSelection falls back to the env profile for codex_oauth without a session profile", () => {
  const selection = resolveConversationModelSelection(
    {
      modelBackendOverride: "codex_oauth",
      codexAuthProfileId: null
    },
    {
      BRAIN_MODEL_BACKEND: "codex_oauth",
      CODEX_AUTH_PROFILE: "team-shared"
    }
  );

  assert.deepEqual(selection, {
    backend: "codex_oauth",
    codexProfileId: "team-shared"
  });
});

test("buildConversationModelEnvironment clears Codex profile env when a non-Codex backend is selected", () => {
  const env = buildConversationModelEnvironment(
    {
      modelBackendOverride: "openai_api",
      codexAuthProfileId: "work"
    },
    {
      BRAIN_MODEL_BACKEND: "codex_oauth",
      CODEX_AUTH_PROFILE: "default",
      CODEX_HOME: "/tmp/codex-home"
    }
  );

  assert.equal(env.BRAIN_MODEL_BACKEND, "openai_api");
  assert.equal(env.CODEX_AUTH_PROFILE, undefined);
  assert.equal(env.CODEX_HOME, undefined);
});

test("buildConversationModelEnvironment pins CODEX_HOME to the selected profile for codex_oauth sessions", () => {
  const env = buildConversationModelEnvironment(
    {
      modelBackendOverride: "codex_oauth",
      codexAuthProfileId: "ops",
      principalContext: buildPrincipalContext("owner")
    },
    {
      BRAIN_MODEL_BACKEND: "openai_api",
      HOME: "/tmp/agentbigbrain-home"
    }
  );

  assert.equal(env.BRAIN_MODEL_BACKEND, "codex_oauth");
  assert.equal(env.CODEX_AUTH_PROFILE, "ops");
  assert.equal(
    (env.CODEX_HOME ?? "").replace(/[\\/]+/g, "/").toLowerCase(),
    "/tmp/agentbigbrain-home/.agentbigbrain/codex/profiles/ops"
  );
});
