import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveShellRuntimeProfile } from "../../src/core/shellRuntimeProfile";
import {
  appendWindowsPowerShellPackageManagerFailureChecks,
  normalizeWindowsPowerShellPackageManagerCommand,
  resolveCommandAwareShellEnvironment,
  resolveEffectiveShellProfile,
  resolveShellPostconditionFailure,
  resolveShellSuccessWorkspaceRoot
} from "../../src/organs/executionRuntime/shellExecutionSupport";

function buildWindowsPowerShellProfile() {
  return resolveShellRuntimeProfile({
    requestedProfile: "powershell",
    executableOverride: null,
    platform: "win32",
    env: {
      PATH: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
      SYSTEMROOT: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      WINDIR: "C:\\Windows"
    },
    allowRealShellExecution: false,
    timeoutMsDefault: 10_000,
    commandMaxChars: 4_000,
    envMode: "allowlist",
    envAllowlistKeys: ["PATH", "SYSTEMROOT"],
    envDenylistKeys: ["TOKEN"],
    allowExecutionPolicyBypass: false,
    wslDistro: null,
    denyOutsideSandboxCwd: true,
    allowRelativeCwd: true
  });
}

test("resolveEffectiveShellProfile keeps Windows npm commands on PowerShell", () => {
  const profile = buildWindowsPowerShellProfile();

  const effectiveProfile = resolveEffectiveShellProfile(profile, "npm install");

  assert.equal(effectiveProfile.shellKind, "powershell");
  assert.equal(effectiveProfile.executable, "powershell");
  assert.deepEqual(effectiveProfile.wrapperArgs, ["-NoProfile", "-NonInteractive", "-Command"]);
});

test("Windows PowerShell package-manager commands normalize to .cmd launchers with exit checks", () => {
  const profile = buildWindowsPowerShellProfile();

  const normalized = normalizeWindowsPowerShellPackageManagerCommand(
    profile,
    "npm install react"
  );
  const guarded = appendWindowsPowerShellPackageManagerFailureChecks(profile, normalized);

  assert.equal(normalized, "npm.cmd install react");
  assert.match(
    guarded,
    /^npm\.cmd install react; if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}$/i
  );
});

test("resolveCommandAwareShellEnvironment preserves launcher variables for PowerShell npm commands", () => {
  const profile = buildWindowsPowerShellProfile();

  const resolution = resolveCommandAwareShellEnvironment(profile, "npm install", {
    PATH: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    SYSTEMROOT: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    WINDIR: "C:\\Windows"
  });

  assert.equal(resolution.env.ComSpec, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(resolution.env.PATHEXT, ".COM;.EXE;.BAT;.CMD");
  assert.equal(resolution.env.WINDIR, "C:\\Windows");
  assert.deepEqual(
    resolution.envKeyNames,
    ["ComSpec", "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR"]
  );
});

test("resolveCommandAwareShellEnvironment preserves launcher variables for embedded PowerShell npm commands", () => {
  const profile = buildWindowsPowerShellProfile();

  const resolution = resolveCommandAwareShellEnvironment(
    profile,
    "$project = 'C:\\Users\\testuser\\Desktop\\Sample App'; Set-Location $project; npm.cmd create vite@latest . -- --template react",
    {
      PATH: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
      SYSTEMROOT: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      WINDIR: "C:\\Windows"
    }
  );

  assert.equal(resolution.env.ComSpec, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(resolution.env.PATHEXT, ".COM;.EXE;.BAT;.CMD");
  assert.equal(resolution.env.WINDIR, "C:\\Windows");
  assert.deepEqual(
    resolution.envKeyNames,
    ["ComSpec", "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR"]
  );
});

test("resolveCommandAwareShellEnvironment preserves Windows executable resolution variables for generic PowerShell commands", () => {
  const profile = buildWindowsPowerShellProfile();

  const resolution = resolveCommandAwareShellEnvironment(profile, "python -m http.server 4173", {
    PATH: "C:\\Python314;C:\\Windows\\System32\\WindowsPowerShell\\v1.0",
    SYSTEMROOT: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    WINDIR: "C:\\Windows"
  });

  assert.equal(resolution.env.ComSpec, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(resolution.env.PATHEXT, ".COM;.EXE;.BAT;.CMD");
  assert.equal(resolution.env.WINDIR, "C:\\Windows");
  assert.deepEqual(
    resolution.envKeyNames,
    ["ComSpec", "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR"]
  );
});

test("resolveShellSuccessWorkspaceRoot returns scaffold target for PowerShell Vite bootstrap commands", async () => {
  const workspaceRoot = await resolveShellSuccessWorkspaceRoot(
    "$project = 'Sample Preview App'; Set-Location 'C:\\Users\\testuser\\OneDrive\\Desktop'; npm.cmd create vite@latest $project -- --template react",
    "C:\\Users\\testuser\\OneDrive\\Desktop"
  );

  assert.equal(
    workspaceRoot,
    "C:\\Users\\testuser\\OneDrive\\Desktop\\Sample Preview App"
  );
});

test("resolveShellSuccessWorkspaceRoot returns scaffold target for option-first Vite bootstrap commands", async () => {
  const workspaceRoot = await resolveShellSuccessWorkspaceRoot(
    "Set-Location 'C:\\Users\\testuser\\OneDrive\\Desktop'; npx.cmd create-vite@latest --template react-ts --no-interactive 'Sample Preview App'",
    "C:\\Users\\testuser\\OneDrive\\Desktop"
  );

  assert.equal(
    workspaceRoot,
    "C:\\Users\\testuser\\OneDrive\\Desktop\\Sample Preview App"
  );
});

test("resolveShellSuccessWorkspaceRoot returns cwd for successful install inside a Vite workspace", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "abb-shell-workspace-"));
  try {
    await writeFile(
      path.join(workspaceRoot, "package.json"),
      JSON.stringify({
        name: "sample-preview-app",
        private: true,
        scripts: {
          dev: "vite",
          build: "vite build"
        },
        devDependencies: {
          vite: "^7.0.0"
        }
      }),
      "utf8"
    );

    const resolved = await resolveShellSuccessWorkspaceRoot("npm install", workspaceRoot);

    assert.equal(resolved, workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("resolveShellSuccessWorkspaceRoot returns final Desktop folder for bounded Next.js scaffold commands", async () => {
  const workspaceRoot = await resolveShellSuccessWorkspaceRoot(
    "$final = 'C:\\Users\\testuser\\OneDrive\\Desktop\\Sample City Showcase'; $tempRoot = Join-Path $env:TEMP 'framework-build-temp'; $temp = Join-Path $tempRoot 'sample-city-showcase'; Set-Location $tempRoot; npx.cmd create-next-app@latest 'sample-city-showcase' --yes; Get-ChildItem -Force $temp | ForEach-Object { Move-Item $_.FullName -Destination $final -Force }; Remove-Item $temp -Recurse -Force; Set-Location $final",
    "C:\\Users\\testuser\\OneDrive\\Desktop"
  );

  assert.equal(
    workspaceRoot,
    "C:\\Users\\testuser\\OneDrive\\Desktop\\Sample City Showcase"
  );
});

test("resolveShellSuccessWorkspaceRoot returns cwd for successful install inside a Next.js workspace", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "abb-next-shell-workspace-"));
  try {
    await writeFile(
      path.join(workspaceRoot, "package.json"),
      JSON.stringify({
        name: "sample-city-showcase",
        private: true,
        scripts: {
          dev: "next dev",
          build: "next build"
        },
        dependencies: {
          next: "^16.0.0",
          react: "^19.0.0",
          "react-dom": "^19.0.0"
        }
      }),
      "utf8"
    );

    const resolved = await resolveShellSuccessWorkspaceRoot("npm install", workspaceRoot);

    assert.equal(resolved, workspaceRoot);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("resolveShellPostconditionFailure validates Next.js build output", async () => {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "abb-next-build-workspace-"));
  try {
    await writeFile(
      path.join(workspaceRoot, "package.json"),
      JSON.stringify({
        name: "sample-city-showcase",
        private: true,
        scripts: {
          build: "next build"
        },
        dependencies: {
          next: "^16.0.0"
        }
      }),
      "utf8"
    );

    const missingBuildFailure = await resolveShellPostconditionFailure(
      "npm run build",
      workspaceRoot
    );
    assert.match(
      missingBuildFailure?.message ?? "",
      /\.next[\\/]+BUILD_ID/i
    );

    await mkdir(path.join(workspaceRoot, ".next"), { recursive: true });
    await writeFile(path.join(workspaceRoot, ".next", "BUILD_ID"), "build-123", "utf8");

    const noFailure = await resolveShellPostconditionFailure("npm run build", workspaceRoot);
    assert.equal(noFailure, null);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
});

test("resolveShellPostconditionFailure validates option-first Vite scaffold target instead of template flags", async () => {
  const failure = await resolveShellPostconditionFailure(
    "Set-Location 'C:\\Users\\testuser\\OneDrive\\Desktop'; npx.cmd create-vite@latest --template react-ts --no-interactive 'Sample Preview App'",
    "C:\\Users\\testuser\\OneDrive\\Desktop"
  );

  assert.match(failure?.message ?? "", /Sample Preview App[\\/]+package\.json/i);
  assert.doesNotMatch(failure?.message ?? "", /--template[\\/]+package\.json/i);
});
