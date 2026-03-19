/**
 * @fileoverview Tests bounded Codex auth-state inspection without exposing token material.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";

import {
  readCodexBearerToken,
  readCodexAuthStatus,
  resolveCodexAuthFilePath,
  resolveCodexAuthStateDir
} from "../../src/models/codex/authStore";

test("resolveCodexAuthStateDir uses default user codex directory", () => {
  assert.equal(
    resolveCodexAuthStateDir({}),
    path.join(os.homedir(), ".agentbigbrain", "codex", "profiles", "default")
  );
});

test("resolveCodexAuthFilePath appends auth.json inside the state dir", () => {
  assert.equal(
    resolveCodexAuthFilePath({
      CODEX_AUTH_STATE_DIR: "/tmp/codex-state",
      HOME: "/tmp/isolated-home",
      USERPROFILE: "/tmp/isolated-home"
    }),
    path.resolve("/tmp/codex-state", "default", "auth.json")
  );
});

test("readCodexAuthStatus returns unavailable when no auth file exists", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-codex-auth-"));
  try {
    const status = await readCodexAuthStatus({
      CODEX_AUTH_STATE_DIR: tempDir,
      HOME: tempDir,
      USERPROFILE: tempDir
    });
    assert.equal(status.available, false);
    assert.equal(status.auth, null);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readCodexAuthStatus returns redacted metadata when auth exists", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-codex-auth-"));
  try {
    const profileDir = path.join(tempDir, "default");
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      path.join(profileDir, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        last_refresh: "2026-03-18T01:02:03.000Z",
        tokens: {
          access_token: "secret-access",
          refresh_token: "secret-refresh",
          id_token: "secret-id",
          account_id: "acct_123"
        }
      }),
      "utf8"
    );
    const status = await readCodexAuthStatus({
      CODEX_AUTH_STATE_DIR: tempDir,
      HOME: tempDir,
      USERPROFILE: tempDir
    });
    assert.equal(status.available, true);
    assert.deepEqual(status.auth, {
      authMode: "chatgpt",
      accessTokenPresent: true,
      refreshTokenPresent: true,
      idTokenPresent: true,
      accountId: "acct_123",
      lastRefreshAt: "2026-03-18T01:02:03.000Z"
    });
    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes("secret-access"), false);
    assert.equal(serialized.includes("secret-refresh"), false);
    assert.equal(serialized.includes("secret-id"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readCodexBearerToken prefers the Codex access token without exposing it through status", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-codex-auth-"));
  try {
    const profileDir = path.join(tempDir, "default");
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      path.join(profileDir, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: "secret-access",
          refresh_token: "secret-refresh",
          account_id: "acct_123"
        }
      }),
      "utf8"
    );
    const token = await readCodexBearerToken({
      CODEX_AUTH_STATE_DIR: tempDir,
      HOME: tempDir,
      USERPROFILE: tempDir
    });
    assert.equal(token, "secret-access");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("readCodexBearerToken falls back to OPENAI_API_KEY when no access token exists", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-codex-auth-"));
  try {
    const profileDir = path.join(tempDir, "default");
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      path.join(profileDir, "auth.json"),
      JSON.stringify({
        auth_mode: "api_key",
        OPENAI_API_KEY: "sk-example"
      }),
      "utf8"
    );
    const token = await readCodexBearerToken({
      CODEX_AUTH_STATE_DIR: tempDir,
      HOME: tempDir,
      USERPROFILE: tempDir
    });
    assert.equal(token, "sk-example");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
