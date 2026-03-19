/**
 * @fileoverview Covers Codex CLI path resolution across Windows and POSIX hosts.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";

import {
  ensureCodexProfileDirectories,
  resolveCodexCliPath,
  resolveCodexCliPathForPlatform
} from "../../src/models/codex/cli";

test("resolveCodexCliPath honors explicit CODEX_CLI_PATH override", () => {
  assert.equal(
    resolveCodexCliPath({ CODEX_CLI_PATH: "/custom/codex" }),
    "/custom/codex"
  );
});

test("resolveCodexCliPathForPlatform prefers the Windows sandbox binary when present", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-codex-cli-"));
  try {
    const sandboxDir = path.join(tempDir, ".codex", ".sandbox-bin");
    const binaryPath = path.join(sandboxDir, "codex.exe");
    await mkdir(sandboxDir, { recursive: true });
    await writeFile(binaryPath, "binary", "utf8");

    const resolved = resolveCodexCliPathForPlatform(
      { USERPROFILE: tempDir },
      "win32"
    );
    assert.equal(resolved, binaryPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveCodexCliPathForPlatform prefers the POSIX sandbox binary when present", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-codex-cli-"));
  try {
    const sandboxDir = path.join(tempDir, ".codex", ".sandbox-bin");
    const binaryPath = path.join(sandboxDir, "codex");
    await mkdir(sandboxDir, { recursive: true });
    await writeFile(binaryPath, "binary", "utf8");

    const resolved = resolveCodexCliPathForPlatform(
      { HOME: tempDir },
      "linux"
    );
    assert.equal(resolved, binaryPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("resolveCodexCliPathForPlatform falls back to PATH codex when the sandbox binary is missing", () => {
  const resolved = resolveCodexCliPathForPlatform(
    { HOME: "/tmp/does-not-exist" },
    "linux"
  );
  assert.equal(resolved, "codex");
});

test("ensureCodexProfileDirectories creates repo-owned profile roots before CLI login", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-codex-cli-"));
  try {
    const env = {
      CODEX_AUTH_STATE_DIR: path.join(tempDir, "profiles"),
      CODEX_HOME: path.join(tempDir, "profiles", "default")
    };

    await ensureCodexProfileDirectories(env);

    await access(env.CODEX_AUTH_STATE_DIR);
    await access(env.CODEX_HOME);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
