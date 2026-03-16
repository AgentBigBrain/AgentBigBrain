/**
 * @fileoverview Tests extracted config-runtime platform-profile helpers while preserving the stable config entrypoint behavior.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import {
  buildDefaultShellRuntimeProfile,
  buildMutableConfigForRuntimeMode,
  resolveConfiguredShellRuntimeProfile
} from "../../src/core/configRuntime/platformProfiles";

test("buildDefaultShellRuntimeProfile matches the stable default shell expectations", () => {
  const profile = buildDefaultShellRuntimeProfile();
  const expectedExecutable = process.platform === "win32" ? "pwsh" : "bash";

  assert.equal(profile.profileVersion, "v1");
  assert.equal(profile.invocationMode, "inline_command");
  assert.equal(profile.executable, expectedExecutable);
  assert.equal(profile.commandMaxChars, 4000);
  assert.equal(profile.timeoutMsDefault, 10000);
});

test("buildMutableConfigForRuntimeMode clones mutable config branches for isolated mode", () => {
  const config = buildMutableConfigForRuntimeMode(DEFAULT_BRAIN_CONFIG, "isolated");

  config.dna.protectedPathPrefixes.push("runtime/test_path.json");
  config.shellRuntime.profile.wrapperArgs = [...config.shellRuntime.profile.wrapperArgs, "--test"];

  assert.equal(config.runtime.mode, "isolated");
  assert.equal(
    DEFAULT_BRAIN_CONFIG.dna.protectedPathPrefixes.includes("runtime/test_path.json"),
    false
  );
  assert.equal(
    DEFAULT_BRAIN_CONFIG.shellRuntime.profile.wrapperArgs.includes("--test"),
    false
  );
});

test("buildMutableConfigForRuntimeMode applies full-access overrides before env customization", () => {
  const config = buildMutableConfigForRuntimeMode(DEFAULT_BRAIN_CONFIG, "full_access");

  assert.equal(config.runtime.mode, "full_access");
  assert.equal(config.permissions.allowShellCommandAction, true);
  assert.equal(config.permissions.allowNetworkWriteAction, true);
  assert.equal(config.permissions.enforceSandboxDelete, false);
  assert.equal(config.permissions.enforceSandboxListDirectory, false);
});

test("resolveConfiguredShellRuntimeProfile applies deterministic zsh env overrides", () => {
  const config = buildMutableConfigForRuntimeMode(DEFAULT_BRAIN_CONFIG, "isolated");
  const profile = resolveConfiguredShellRuntimeProfile({
    env: {
      BRAIN_SHELL_PROFILE: "zsh",
      BRAIN_SHELL_TIMEOUT_MS: "20000",
      BRAIN_SHELL_COMMAND_MAX_CHARS: "6000"
    },
    shellRuntime: config.shellRuntime,
    allowRealShellExecution: false,
    platform: process.platform
  });

  assert.equal(profile.shellKind, "zsh");
  assert.equal(profile.executable, "zsh");
  assert.deepEqual(profile.wrapperArgs, ["-lc"]);
  assert.equal(profile.timeoutMsDefault, 20000);
  assert.equal(profile.commandMaxChars, 6000);
});
