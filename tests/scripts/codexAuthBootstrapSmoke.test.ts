/**
 * @fileoverview Covers bounded Codex auth/bootstrap evidence generation.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";

import { runCodexAuthBootstrapSmoke } from "../../scripts/evidence/codexAuthBootstrapSmoke";

test("codex auth bootstrap smoke emits PASS when backend, auth, and mappings are available", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-codex-smoke-"));
  try {
    const sandboxDir = path.join(tempDir, ".codex", ".sandbox-bin");
    await mkdir(sandboxDir, { recursive: true });
    await writeFile(path.join(sandboxDir, "codex"), "binary", "utf8");
    await writeFile(
      path.join(tempDir, ".codex", "auth.json"),
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

    const artifact = await runCodexAuthBootstrapSmoke({
      BRAIN_MODEL_BACKEND: "codex_oauth",
      HOME: tempDir
    });

    assert.equal(artifact.status, "PASS");
    assert.equal(artifact.backend, "codex_oauth");
    assert.equal(artifact.authAvailable, true);
    assert.equal(artifact.roleMappings["small-fast-model"], "gpt-5.4-mini");
    assert.equal(artifact.roleMappings["large-reasoning-model"], "gpt-5.4");
    assert.equal(JSON.stringify(artifact).includes("secret-access"), false);
    assert.equal(JSON.stringify(artifact).includes("secret-refresh"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
