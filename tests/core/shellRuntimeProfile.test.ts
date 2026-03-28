/**
 * @fileoverview Tests deterministic shell runtime profile resolution, env filtering, and spawn-spec fingerprinting.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildShellSpawnSpec,
  computeShellProfileFingerprint,
  computeShellSpawnSpecFingerprint,
  normalizeShellEnvMode,
  normalizeShellProfileOption,
  resolveShellEnvironment,
  resolveShellRuntimeProfile
} from "../../src/core/shellRuntimeProfile";

test("normalize shell profile option accepts known values and rejects invalid values", () => {
  assert.equal(normalizeShellProfileOption(undefined), "auto");
  assert.equal(normalizeShellProfileOption("pwsh"), "pwsh");
  assert.equal(normalizeShellProfileOption("bash"), "bash");
  assert.equal(normalizeShellProfileOption("zsh"), "zsh");
  assert.throws(() => normalizeShellProfileOption("fish"), /SHELL_PROFILE_INVALID/);
});

test("normalize shell env mode accepts known values and rejects invalid values", () => {
  assert.equal(normalizeShellEnvMode(undefined), "allowlist");
  assert.equal(normalizeShellEnvMode("passthrough"), "passthrough");
  assert.throws(() => normalizeShellEnvMode("all"), /SHELL_PROFILE_INVALID/);
});

test("resolve shell runtime profile deterministically for explicit bash profile", () => {
  const profile = resolveShellRuntimeProfile({
    requestedProfile: "bash",
    executableOverride: null,
    platform: "linux",
    env: process.env,
    allowRealShellExecution: false,
    timeoutMsDefault: 12000,
    commandMaxChars: 3000,
    envMode: "allowlist",
    envAllowlistKeys: ["PATH", "HOME"],
    envDenylistKeys: ["TOKEN"],
    allowExecutionPolicyBypass: false,
    wslDistro: null,
    denyOutsideSandboxCwd: true,
    allowRelativeCwd: true
  });

  assert.equal(profile.shellKind, "bash");
  assert.equal(profile.executable, "bash");
  assert.deepEqual(profile.wrapperArgs, ["-lc"]);
  assert.equal(profile.timeoutMsDefault, 12000);
  assert.equal(profile.commandMaxChars, 3000);
});

test("resolve shell runtime profile deterministically for explicit zsh profile", () => {
  const profile = resolveShellRuntimeProfile({
    requestedProfile: "zsh",
    executableOverride: null,
    platform: "darwin",
    env: process.env,
    allowRealShellExecution: false,
    timeoutMsDefault: 12000,
    commandMaxChars: 3000,
    envMode: "allowlist",
    envAllowlistKeys: ["PATH", "HOME"],
    envDenylistKeys: ["TOKEN"],
    allowExecutionPolicyBypass: false,
    wslDistro: null,
    denyOutsideSandboxCwd: true,
    allowRelativeCwd: true
  });

  assert.equal(profile.shellKind, "zsh");
  assert.equal(profile.executable, "zsh");
  assert.deepEqual(profile.wrapperArgs, ["-lc"]);
  assert.equal(profile.timeoutMsDefault, 12000);
  assert.equal(profile.commandMaxChars, 3000);
});

test("resolve shell runtime profile uses cmd wrapper args without /s quoting mode", () => {
  const profile = resolveShellRuntimeProfile({
    requestedProfile: "cmd",
    executableOverride: null,
    platform: "win32",
    env: process.env,
    allowRealShellExecution: false,
    timeoutMsDefault: 12000,
    commandMaxChars: 3000,
    envMode: "allowlist",
    envAllowlistKeys: ["PATH", "SYSTEMROOT"],
    envDenylistKeys: ["TOKEN"],
    allowExecutionPolicyBypass: false,
    wslDistro: null,
    denyOutsideSandboxCwd: true,
    allowRelativeCwd: true
  });

  assert.equal(profile.shellKind, "cmd");
  assert.deepEqual(profile.wrapperArgs, ["/d", "/c"]);
});

test("resolve shell runtime profile keeps logical executable name when real shell is disabled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-shell-runtime-"));
  const fakeBash = path.join(tempDir, "bash");
  await writeFile(fakeBash, "echo", "utf8");

  const profile = resolveShellRuntimeProfile({
    requestedProfile: "bash",
    executableOverride: null,
    platform: "linux",
    env: { PATH: tempDir },
    allowRealShellExecution: false,
    timeoutMsDefault: 12000,
    commandMaxChars: 3000,
    envMode: "allowlist",
    envAllowlistKeys: ["PATH", "HOME"],
    envDenylistKeys: ["TOKEN"],
    allowExecutionPolicyBypass: false,
    wslDistro: null,
    denyOutsideSandboxCwd: true,
    allowRelativeCwd: true
  });

  assert.equal(profile.executable, "bash");
});

test("resolve shell runtime profile enforces wsl profile windows-only guard", () => {
  assert.throws(
    () =>
      resolveShellRuntimeProfile({
        requestedProfile: "wsl_bash",
        executableOverride: null,
        platform: "linux",
        env: process.env,
        allowRealShellExecution: false,
        timeoutMsDefault: 10000,
        commandMaxChars: 4000,
        envMode: "allowlist",
        envAllowlistKeys: ["PATH"],
        envDenylistKeys: ["TOKEN"],
        allowExecutionPolicyBypass: false,
        wslDistro: null,
        denyOutsideSandboxCwd: true,
        allowRelativeCwd: true
      }),
    /SHELL_PROFILE_NOT_SUPPORTED_ON_PLATFORM/
  );
});

test("resolve shell runtime profile enforces executable override allowlist", () => {
  assert.throws(
    () =>
      resolveShellRuntimeProfile({
        requestedProfile: "bash",
        executableOverride: "python",
        platform: "linux",
        env: process.env,
        allowRealShellExecution: false,
        timeoutMsDefault: 10000,
        commandMaxChars: 4000,
        envMode: "allowlist",
        envAllowlistKeys: ["PATH"],
        envDenylistKeys: ["TOKEN"],
        allowExecutionPolicyBypass: false,
        wslDistro: null,
        denyOutsideSandboxCwd: true,
        allowRelativeCwd: true
      }),
    /SHELL_PROFILE_INVALID/
  );
});

test("resolve shell runtime profile fail-closes executable detection when real shell enabled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-shell-runtime-"));
  const fakeExecutablePath = path.join(tempDir, "does-not-exist-shell");
  assert.throws(
    () =>
      resolveShellRuntimeProfile({
        requestedProfile: "bash",
        executableOverride: fakeExecutablePath,
        platform: "linux",
        env: { PATH: tempDir },
        allowRealShellExecution: true,
        timeoutMsDefault: 10000,
        commandMaxChars: 4000,
        envMode: "allowlist",
        envAllowlistKeys: ["PATH"],
        envDenylistKeys: ["TOKEN"],
        allowExecutionPolicyBypass: false,
        wslDistro: null,
        denyOutsideSandboxCwd: true,
        allowRelativeCwd: true
      }),
    /SHELL_EXECUTABLE_NOT_FOUND/
  );
});

test("resolve shell runtime profile detects explicit executable when real shell is enabled", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-shell-runtime-"));
  const executablePath = path.join(tempDir, "custom-bash");
  await writeFile(executablePath, "echo", "utf8");
  const profile = resolveShellRuntimeProfile({
    requestedProfile: "bash",
    executableOverride: executablePath,
    platform: "linux",
    env: { PATH: tempDir },
    allowRealShellExecution: true,
    timeoutMsDefault: 10000,
    commandMaxChars: 4000,
    envMode: "allowlist",
    envAllowlistKeys: ["PATH"],
    envDenylistKeys: ["TOKEN"],
    allowExecutionPolicyBypass: false,
    wslDistro: null,
    denyOutsideSandboxCwd: true,
    allowRelativeCwd: true
  });

  assert.equal(profile.executable, executablePath);
});

test("resolve shell runtime profile falls back to known Windows PowerShell location when PATH is stripped", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agentbigbrain-shell-runtime-win-"));
  const windowsPowerShellPath = path.join(
    tempDir,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  await mkdir(path.dirname(windowsPowerShellPath), { recursive: true });
  await writeFile(windowsPowerShellPath, "echo", "utf8");

  const profile = resolveShellRuntimeProfile({
    requestedProfile: "auto",
    executableOverride: null,
    platform: "win32",
    env: {
      PATH: "",
      PATHEXT: ".EXE;.CMD",
      SYSTEMROOT: tempDir
    },
    allowRealShellExecution: true,
    timeoutMsDefault: 10000,
    commandMaxChars: 4000,
    envMode: "allowlist",
    envAllowlistKeys: ["PATH", "SYSTEMROOT"],
    envDenylistKeys: ["TOKEN"],
    allowExecutionPolicyBypass: false,
    wslDistro: null,
    denyOutsideSandboxCwd: true,
    allowRelativeCwd: true
  });

  assert.equal(profile.shellKind, "powershell");
  assert.equal(profile.executable, windowsPowerShellPath);
});

test("resolve shell environment allowlist mode includes allowed keys and redacts denylist keys", () => {
  const profile = resolveShellRuntimeProfile({
    requestedProfile: "bash",
    executableOverride: null,
    platform: "linux",
    env: process.env,
    allowRealShellExecution: false,
    timeoutMsDefault: 10000,
    commandMaxChars: 4000,
    envMode: "allowlist",
    envAllowlistKeys: ["PATH", "TOKEN_VALUE", "HOME"],
    envDenylistKeys: ["TOKEN"],
    allowExecutionPolicyBypass: false,
    wslDistro: null,
    denyOutsideSandboxCwd: true,
    allowRelativeCwd: true
  });
  const environment = resolveShellEnvironment(profile, {
    PATH: "/tmp/bin",
    HOME: "/tmp/home",
    TOKEN_VALUE: "secret-token"
  });
  assert.deepEqual(environment.envKeyNames, ["HOME", "PATH"]);
  assert.deepEqual(environment.redactedEnvKeyNames, ["TOKEN_VALUE"]);
});

test("build shell spawn spec and fingerprints remain deterministic", () => {
  const profile = resolveShellRuntimeProfile({
    requestedProfile: "bash",
    executableOverride: null,
    platform: "linux",
    env: process.env,
    allowRealShellExecution: false,
    timeoutMsDefault: 10000,
    commandMaxChars: 4000,
    envMode: "allowlist",
    envAllowlistKeys: ["PATH"],
    envDenylistKeys: ["TOKEN"],
    allowExecutionPolicyBypass: false,
    wslDistro: null,
    denyOutsideSandboxCwd: true,
    allowRelativeCwd: true
  });

  const spawnSpec = buildShellSpawnSpec({
    profile,
    command: "echo hi",
    cwd: process.cwd(),
    timeoutMs: 10000,
    envKeyNames: ["PATH"]
  });
  assert.deepEqual(spawnSpec.args, ["-lc", "echo hi"]);

  const profileFingerprintA = computeShellProfileFingerprint(profile);
  const profileFingerprintB = computeShellProfileFingerprint(profile);
  assert.equal(profileFingerprintA, profileFingerprintB);

  const spawnFingerprintA = computeShellSpawnSpecFingerprint(spawnSpec);
  const spawnFingerprintB = computeShellSpawnSpecFingerprint(spawnSpec);
  assert.equal(spawnFingerprintA, spawnFingerprintB);
});
