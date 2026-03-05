/**
 * @fileoverview Emits deterministic shell runtime profile evidence matrix for cross-platform wrapper and fingerprint contracts.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";

import {
  buildShellSpawnSpec,
  computeShellProfileFingerprint,
  computeShellSpawnSpecFingerprint,
  resolveShellEnvironment,
  resolveShellRuntimeProfile
} from "../../src/core/shellRuntimeProfile";
import { writeFileAtomic } from "../../src/core/fileLock";

interface ShellProfileEvidenceEntry {
  scenarioId: string;
  profile: ReturnType<typeof resolveShellRuntimeProfile>;
  profileFingerprint: string;
  spawnSpecExample: ReturnType<typeof buildShellSpawnSpec>;
  spawnSpecFingerprint: string;
  envKeyNames: string[];
  redactedEnvKeyNames: string[];
  expectedBlockCodes: string[];
}

interface ShellProfileEvidenceReport {
  generatedAt: string;
  schemaVersion: "v1";
  command: string;
  entries: ShellProfileEvidenceEntry[];
}

/**
 * Implements `buildScenarioEntries` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
function buildScenarioEntries(): ShellProfileEvidenceEntry[] {
  const scenarios = [
    {
      scenarioId: "win32_pwsh_auto",
      requestedProfile: "auto" as const,
      platform: "win32" as const
    },
    {
      scenarioId: "win32_cmd_explicit",
      requestedProfile: "cmd" as const,
      platform: "win32" as const
    },
    {
      scenarioId: "win32_wsl_explicit",
      requestedProfile: "wsl_bash" as const,
      platform: "win32" as const
    },
    {
      scenarioId: "linux_bash_auto",
      requestedProfile: "auto" as const,
      platform: "linux" as const
    },
    {
      scenarioId: "darwin_bash_auto",
      requestedProfile: "auto" as const,
      platform: "darwin" as const
    }
  ];

  const entries: ShellProfileEvidenceEntry[] = [];
  for (const scenario of scenarios) {
    const profile = resolveShellRuntimeProfile({
      requestedProfile: scenario.requestedProfile,
      executableOverride: null,
      platform: scenario.platform,
      env: process.env,
      allowRealShellExecution: false,
      timeoutMsDefault: 10000,
      commandMaxChars: 4000,
      envMode: "allowlist",
      envAllowlistKeys: ["PATH", "HOME", "USERPROFILE"],
      envDenylistKeys: ["TOKEN", "SECRET", "PASSWORD"],
      allowExecutionPolicyBypass: false,
      wslDistro: null,
      denyOutsideSandboxCwd: true,
      allowRelativeCwd: true
    });
    const shellEnv = resolveShellEnvironment(profile, process.env);
    const spawnSpecExample = buildShellSpawnSpec({
      profile,
      command: "echo shell-profile-evidence",
      cwd: process.cwd(),
      timeoutMs: profile.timeoutMsDefault,
      envKeyNames: shellEnv.envKeyNames
    });
    const profileFingerprint = computeShellProfileFingerprint(profile);
    const spawnSpecFingerprint = computeShellSpawnSpecFingerprint(spawnSpecExample);

    entries.push({
      scenarioId: scenario.scenarioId,
      profile,
      profileFingerprint,
      spawnSpecExample,
      spawnSpecFingerprint,
      envKeyNames: shellEnv.envKeyNames,
      redactedEnvKeyNames: shellEnv.redactedEnvKeyNames,
      expectedBlockCodes: [
        "SHELL_PROFILE_MISMATCH",
        "SHELL_COMMAND_TOO_LONG",
        "SHELL_TIMEOUT_INVALID",
        "SHELL_CWD_OUTSIDE_SANDBOX"
      ]
    });
  }

  return entries;
}

/**
 * Implements `main` behavior within module scope.
 * Interacts with local collaborators through imported modules and typed inputs/outputs.
 */
async function main(): Promise<void> {
  const reportPath = path.join(
    process.cwd(),
    "runtime/evidence/shell_runtime_profile_v1_report.json"
  );
  const entries = buildScenarioEntries();
  const report: ShellProfileEvidenceReport = {
    generatedAt: new Date().toISOString(),
    schemaVersion: "v1",
    command: "npm run test:stage6_x:shell_profile_evidence",
    entries
  };

  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFileAtomic(reportPath, JSON.stringify(report, null, 2));
  console.log(
    `[stage6_xShellProfileEvidence] Wrote evidence report with ${entries.length} scenarios to ${reportPath}`
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[stage6_xShellProfileEvidence] Failed: ${message}`);
  process.exitCode = 1;
});
