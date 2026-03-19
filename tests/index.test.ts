/**
 * @fileoverview Validates CLI argument parsing and daemon contract safeguards for `src/index.ts`.
 */

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { test } from "node:test";

import { parseCliArgs, renderCodexAuthStatus, resolveDaemonContract } from "../src/index";

test("parseCliArgs fails closed with usage when goal text is missing", () => {
  const parsed = parseCliArgs([]);
  assert.equal(parsed.ok, false);
  if (parsed.ok) {
    return;
  }
  assert.equal(parsed.failure.exitCode, 1);
  assert.equal(parsed.failure.stream, "stderr");
  assert.match(parsed.failure.message, /^Usage:/);
});

test("parseCliArgs prints usage on --help", () => {
  const parsed = parseCliArgs(["--help"]);
  assert.equal(parsed.ok, false);
  if (parsed.ok) {
    return;
  }
  assert.equal(parsed.failure.exitCode, 0);
  assert.equal(parsed.failure.stream, "stdout");
  assert.match(parsed.failure.message, /^Usage:/);
});

test("parseCliArgs defaults to task mode", () => {
  const parsed = parseCliArgs(["Ship", "the", "release"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.command.mode, "task");
  assert.equal(parsed.command.goal, "Ship the release");
});

test("parseCliArgs supports --autonomous mode", () => {
  const parsed = parseCliArgs(["--autonomous", "Refactor", "module"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.command.mode, "autonomous");
  assert.equal(parsed.command.goal, "Refactor module");
});

test("parseCliArgs supports --daemon mode", () => {
  const parsed = parseCliArgs(["--daemon", "Run", "continuous", "improvements"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.command.mode, "daemon");
  assert.equal(parsed.command.goal, "Run continuous improvements");
});

test("parseCliArgs rejects conflicting loop flags", () => {
  const parsed = parseCliArgs(["--autonomous", "--daemon", "Conflicting"]);
  assert.equal(parsed.ok, false);
  if (parsed.ok) {
    return;
  }
  assert.equal(parsed.failure.exitCode, 1);
  assert.equal(parsed.failure.stream, "stderr");
  assert.match(parsed.failure.message, /Cannot combine --autonomous and --daemon/);
});

test("parseCliArgs rejects unknown flags", () => {
  const parsed = parseCliArgs(["--unknown", "goal"]);
  assert.equal(parsed.ok, false);
  if (parsed.ok) {
    return;
  }
  assert.equal(parsed.failure.exitCode, 1);
  assert.equal(parsed.failure.stream, "stderr");
  assert.match(parsed.failure.message, /Unknown flag/);
});

test("parseCliArgs supports Codex auth status commands", () => {
  const parsed = parseCliArgs(["auth", "codex", "status"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.command.mode, "auth");
  assert.equal(parsed.command.provider, "codex");
  assert.equal(parsed.command.action, "status");
});

test("parseCliArgs supports Codex auth login device-auth commands", () => {
  const parsed = parseCliArgs(["auth", "codex", "login", "--device-auth"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.command.mode, "auth");
  assert.equal(parsed.command.action, "login");
  assert.equal(parsed.command.deviceAuth, true);
});

test("parseCliArgs supports Codex auth logout profile commands", () => {
  const parsed = parseCliArgs(["auth", "codex", "logout", "--profile", "default"]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  assert.equal(parsed.command.mode, "auth");
  assert.equal(parsed.command.action, "logout");
  assert.equal(parsed.command.profileId, "default");
});

test("resolveDaemonContract requires explicit daemon acknowledgement latch", () => {
  assert.throws(
    () =>
      resolveDaemonContract({
        BRAIN_MAX_DAEMON_GOAL_ROLLOVERS: "2"
      }),
    /BRAIN_ALLOW_DAEMON_MODE=true/
  );
});

test("resolveDaemonContract requires bounded rollover count", () => {
  assert.throws(
    () =>
      resolveDaemonContract({
        BRAIN_ALLOW_DAEMON_MODE: "true"
      }),
    /BRAIN_MAX_DAEMON_GOAL_ROLLOVERS/
  );
});

test("resolveDaemonContract enforces positive integer rollover values", () => {
  assert.throws(
    () =>
      resolveDaemonContract({
        BRAIN_ALLOW_DAEMON_MODE: "true",
        BRAIN_MAX_DAEMON_GOAL_ROLLOVERS: "0"
      }),
    /integer > 0/
  );
});

test("resolveDaemonContract enforces bounded autonomous-iteration config in daemon mode", () => {
  assert.throws(
    () =>
      resolveDaemonContract({
        BRAIN_ALLOW_DAEMON_MODE: "true",
        BRAIN_MAX_DAEMON_GOAL_ROLLOVERS: "1",
        BRAIN_MAX_AUTONOMOUS_ITERATIONS: "0"
      }),
    /BRAIN_MAX_AUTONOMOUS_ITERATIONS > 0/
  );
});

test("resolveDaemonContract returns bounded rollover settings when contract is valid", () => {
  const contract = resolveDaemonContract({
    BRAIN_ALLOW_DAEMON_MODE: "true",
    BRAIN_MAX_DAEMON_GOAL_ROLLOVERS: "3",
    BRAIN_MAX_AUTONOMOUS_ITERATIONS: "5"
  });
  assert.deepEqual(contract, { maxGoalRollovers: 3 });
});

test("renderCodexAuthStatus includes backend and resolved role mappings without leaking token values", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-index-codex-"));
  const originalEnv = {
    BRAIN_MODEL_BACKEND: process.env.BRAIN_MODEL_BACKEND,
    CODEX_AUTH_STATE_DIR: process.env.CODEX_AUTH_STATE_DIR,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    CODEX_MODEL_SMALL_FAST: process.env.CODEX_MODEL_SMALL_FAST,
    CODEX_MODEL_LARGE_REASONING: process.env.CODEX_MODEL_LARGE_REASONING
  };

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
          account_id: "acct_123"
        }
      }),
      "utf8"
    );

    process.env.BRAIN_MODEL_BACKEND = "codex_oauth";
    process.env.CODEX_AUTH_STATE_DIR = tempDir;
    process.env.HOME = tempDir;
    process.env.USERPROFILE = tempDir;
    process.env.CODEX_MODEL_SMALL_FAST = "gpt-5.4-mini";
    process.env.CODEX_MODEL_LARGE_REASONING = "gpt-5.4";

    const rendered = await renderCodexAuthStatus();
    assert.match(rendered, /Active backend: codex_oauth/);
    assert.match(rendered, /Resolved role mappings:/);
    assert.match(rendered, /small-fast-model -> gpt-5\.4-mini/);
    assert.match(rendered, /large-reasoning-model -> gpt-5\.4/);
    assert.equal(rendered.includes("secret-access"), false);
    assert.equal(rendered.includes("secret-refresh"), false);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
