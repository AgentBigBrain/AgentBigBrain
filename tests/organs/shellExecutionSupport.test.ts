import assert from "node:assert/strict";
import { test } from "node:test";

import type { ShellRuntimeProfileV1 } from "../../src/core/types";
import {
  resolveCommandAwareShellEnvironment,
  resolveEffectiveShellProfile
} from "../../src/organs/executionRuntime/shellExecutionSupport";

function buildWindowsPowerShellProfile(): ShellRuntimeProfileV1 {
  return {
    profileVersion: "v1",
    platform: "win32",
    shellKind: "powershell",
    executable: "powershell.exe",
    invocationMode: "inline_command",
    wrapperArgs: ["-NoProfile", "-NonInteractive", "-Command"],
    encoding: "utf8",
    commandMaxChars: 4000,
    timeoutMsDefault: 10_000,
    envPolicy: {
      mode: "allowlist",
      allowlist: ["PATH", "HOME", "USERPROFILE", "TEMP", "SYSTEMROOT"],
      denylist: ["TOKEN", "SECRET", "PASSWORD", "AUTH", "COOKIE"]
    },
    cwdPolicy: {
      allowRelative: true,
      normalize: "native",
      denyOutsideSandbox: false
    }
  };
}

test("resolveEffectiveShellProfile routes simple Windows npm commands through cmd.exe", () => {
  const effectiveProfile = resolveEffectiveShellProfile(
    buildWindowsPowerShellProfile(),
    "npm run preview -- --host 127.0.0.1 --port 4173"
  );

  assert.equal(effectiveProfile.shellKind, "cmd");
  assert.equal(effectiveProfile.executable, "cmd.exe");
  assert.deepEqual(effectiveProfile.wrapperArgs, ["/d", "/c"]);
});

test("resolveCommandAwareShellEnvironment adds launcher vars for Windows package-manager commands", () => {
  const sourceEnv: NodeJS.ProcessEnv = {
    PATH: "C:\\Windows\\System32",
    HOME: "C:\\Users\\testuser",
    USERPROFILE: "C:\\Users\\testuser",
    TEMP: "C:\\Temp",
    SYSTEMROOT: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    WINDIR: "C:\\Windows"
  };

  const resolution = resolveCommandAwareShellEnvironment(
    buildWindowsPowerShellProfile(),
    "npm run preview -- --host 127.0.0.1 --port 4173",
    sourceEnv
  );

  assert.equal(resolution.env.ComSpec, sourceEnv.ComSpec);
  assert.equal(resolution.env.PATHEXT, sourceEnv.PATHEXT);
  assert.equal(resolution.env.WINDIR, sourceEnv.WINDIR);
  assert.deepEqual(resolution.envKeyNames, [
    "ComSpec",
    "HOME",
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "TEMP",
    "USERPROFILE",
    "WINDIR"
  ]);
});

test("resolveCommandAwareShellEnvironment leaves non-package-manager commands unchanged", () => {
  const sourceEnv: NodeJS.ProcessEnv = {
    PATH: "C:\\Windows\\System32",
    HOME: "C:\\Users\\testuser",
    USERPROFILE: "C:\\Users\\testuser",
    TEMP: "C:\\Temp",
    SYSTEMROOT: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    WINDIR: "C:\\Windows"
  };

  const resolution = resolveCommandAwareShellEnvironment(
    buildWindowsPowerShellProfile(),
    "python -m http.server 4173",
    sourceEnv
  );

  assert.deepEqual(resolution.envKeyNames, [
    "HOME",
    "PATH",
    "SYSTEMROOT",
    "TEMP",
    "USERPROFILE"
  ]);
  assert.equal("ComSpec" in resolution.env, false);
  assert.equal("PATHEXT" in resolution.env, false);
  assert.equal("WINDIR" in resolution.env, false);
});
