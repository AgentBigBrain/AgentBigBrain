/**
 * @fileoverview Canonical shell-profile and runtime-mode config builders extracted from the shared config entrypoint.
 */

import type { ShellRuntimeProfileV1 } from "../types";
import type { BrainConfig, RuntimeMode } from "./envContracts";
import {
  parseBoolean,
  parseBoundedPositiveInteger,
} from "./configParsing";
import {
  DEFAULT_SHELL_COMMAND_MAX_CHARS,
  DEFAULT_SHELL_ENV_ALLOWLIST,
  DEFAULT_SHELL_ENV_DENYLIST,
  DEFAULT_SHELL_TIMEOUT_MS,
  normalizeShellCsvList,
  normalizeShellEnvMode,
  normalizeShellProfileOption,
  resolveShellRuntimeProfile,
} from "../shellRuntimeProfile";

/**
 * Builds the default shell runtime profile for this config-runtime subsystem.
 *
 * **Why it exists:**
 * Keeps the default shell-profile construction canonical once `config.ts` stops owning it inline.
 *
 * **What it talks to:**
 * - Uses shell-profile resolution helpers from `../shellRuntimeProfile`.
 *
 * @returns Canonical default `ShellRuntimeProfileV1`.
 */
export function buildDefaultShellRuntimeProfile(): ShellRuntimeProfileV1 {
  return resolveShellRuntimeProfile({
    requestedProfile: "auto",
    executableOverride: null,
    platform: process.platform,
    env: process.env,
    allowRealShellExecution: false,
    timeoutMsDefault: DEFAULT_SHELL_TIMEOUT_MS,
    commandMaxChars: DEFAULT_SHELL_COMMAND_MAX_CHARS,
    envMode: "allowlist",
    envAllowlistKeys: DEFAULT_SHELL_ENV_ALLOWLIST,
    envDenylistKeys: DEFAULT_SHELL_ENV_DENYLIST,
    allowExecutionPolicyBypass: false,
    wslDistro: null,
    denyOutsideSandboxCwd: true,
    allowRelativeCwd: true
  });
}

/**
 * Builds a mutable config copy for the requested runtime mode.
 *
 * **Why it exists:**
 * Keeps `config.ts` from owning both runtime-mode overlay rules and the deep-ish clone required
 * before env overrides mutate nested config state.
 *
 * **What it talks to:**
 * - Uses local cloning helpers in this module.
 *
 * @param defaultConfig - Stable baseline config.
 * @param runtimeMode - Requested runtime mode for this config build.
 * @returns Mutable config copy ready for env overrides.
 */
export function buildMutableConfigForRuntimeMode(
  defaultConfig: BrainConfig,
  runtimeMode: RuntimeMode
): BrainConfig {
  const base =
    runtimeMode === "full_access"
      ? withFullAccessOverrides(defaultConfig)
      : {
        ...defaultConfig,
        permissions: { ...defaultConfig.permissions },
        runtime: { ...defaultConfig.runtime },
        agentPulse: { ...defaultConfig.agentPulse },
        reflection: { ...defaultConfig.reflection },
        embeddings: { ...defaultConfig.embeddings },
        persistence: { ...defaultConfig.persistence },
        observability: { ...defaultConfig.observability },
        browserVerification: { ...defaultConfig.browserVerification },
        shellRuntime: cloneShellRuntimeConfig(defaultConfig.shellRuntime),
        dna: { ...defaultConfig.dna },
        governance: { ...defaultConfig.governance },
        limits: { ...defaultConfig.limits },
        routing: { ...defaultConfig.routing },
        governorRouting: { ...defaultConfig.governorRouting }
      };

  return {
    ...base,
    browserVerification: { ...base.browserVerification },
    dna: {
      ...base.dna,
      immutableKeywords: [...base.dna.immutableKeywords],
      protectedPathPrefixes: [...base.dna.protectedPathPrefixes]
    },
    shellRuntime: cloneShellRuntimeConfig(base.shellRuntime)
  };
}

export interface ResolveConfiguredShellRuntimeProfileInput {
  env: NodeJS.ProcessEnv;
  shellRuntime: BrainConfig["shellRuntime"];
  allowRealShellExecution: boolean;
  platform?: NodeJS.Platform;
}

/**
 * Resolves the configured shell runtime profile from env and current config bounds.
 *
 * **Why it exists:**
 * Keeps shell-profile env assembly and fail-closed resolution out of the shared `config.ts`
 * entrypoint while preserving the exact same runtime semantics.
 *
 * **What it talks to:**
 * - Uses parsing helpers from `./configParsing`.
 * - Uses shell-profile resolution helpers from `../shellRuntimeProfile`.
 *
 * @param input - Runtime context for shell-profile resolution.
 * @returns Resolved `ShellRuntimeProfileV1` for the current config build.
 */
export function resolveConfiguredShellRuntimeProfile(
  input: ResolveConfiguredShellRuntimeProfileInput
): ShellRuntimeProfileV1 {
  const requestedShellProfile = normalizeShellProfileOption(input.env.BRAIN_SHELL_PROFILE);
  const shellExecutableOverride = input.env.BRAIN_SHELL_EXECUTABLE?.trim() || null;
  const shellTimeoutMs = parseBoundedPositiveInteger(
    input.env.BRAIN_SHELL_TIMEOUT_MS,
    input.shellRuntime.profile.timeoutMsDefault,
    input.shellRuntime.timeoutBoundsMs,
    "BRAIN_SHELL_TIMEOUT_MS"
  );
  const shellCommandMaxChars = parseBoundedPositiveInteger(
    input.env.BRAIN_SHELL_COMMAND_MAX_CHARS,
    input.shellRuntime.profile.commandMaxChars,
    input.shellRuntime.commandMaxCharsBounds,
    "BRAIN_SHELL_COMMAND_MAX_CHARS"
  );
  const shellEnvMode = normalizeShellEnvMode(input.env.BRAIN_SHELL_ENV_MODE);
  const configuredAllowlist = normalizeShellCsvList(input.env.BRAIN_SHELL_ENV_ALLOWLIST);
  const configuredDenylist = normalizeShellCsvList(input.env.BRAIN_SHELL_ENV_DENYLIST);
  const shellEnvAllowlist =
    configuredAllowlist.length > 0
      ? configuredAllowlist
      : [...DEFAULT_SHELL_ENV_ALLOWLIST];
  const shellEnvDenylist =
    configuredDenylist.length > 0
      ? configuredDenylist
      : [...DEFAULT_SHELL_ENV_DENYLIST];
  const allowExecutionPolicyBypass = parseBoolean(
    input.env.BRAIN_SHELL_ALLOW_EXECUTION_POLICY_BYPASS,
    false
  );
  const shellWslDistro = input.env.BRAIN_SHELL_WSL_DISTRO?.trim() || null;
  const shellDenyOutsideSandbox = parseBoolean(
    input.env.BRAIN_SHELL_CWD_POLICY_DENY_OUTSIDE_SANDBOX,
    true
  );
  const shellAllowRelativeCwd = parseBoolean(
    input.env.BRAIN_SHELL_CWD_POLICY_ALLOW_RELATIVE,
    true
  );

  return resolveShellRuntimeProfile({
    requestedProfile: requestedShellProfile,
    executableOverride: shellExecutableOverride,
    platform: input.platform ?? process.platform,
    env: input.env,
    allowRealShellExecution: input.allowRealShellExecution,
    timeoutMsDefault: shellTimeoutMs,
    commandMaxChars: shellCommandMaxChars,
    envMode: shellEnvMode,
    envAllowlistKeys: shellEnvAllowlist,
    envDenylistKeys: shellEnvDenylist,
    allowExecutionPolicyBypass,
    wslDistro: shellWslDistro,
    denyOutsideSandboxCwd: shellDenyOutsideSandbox,
    allowRelativeCwd: shellAllowRelativeCwd
  });
}

/**
 * Clones shell runtime profile for this config-runtime subsystem.
 *
 * **Why it exists:**
 * Keeps deep-ish profile cloning canonical once shell-profile builders move out of `config.ts`.
 *
 * **What it talks to:**
 * - Uses local cloning logic within this module.
 *
 * @param profile - Stable shell profile to clone.
 * @returns Cloned `ShellRuntimeProfileV1`.
 */
function cloneShellRuntimeProfile(profile: ShellRuntimeProfileV1): ShellRuntimeProfileV1 {
  return {
    ...profile,
    wrapperArgs: [...profile.wrapperArgs],
    envPolicy: {
      ...profile.envPolicy,
      allowlist: [...(profile.envPolicy.allowlist ?? [])],
      denylist: [...(profile.envPolicy.denylist ?? [])]
    },
    cwdPolicy: { ...profile.cwdPolicy },
    wslPolicy: profile.wslPolicy
      ? { ...profile.wslPolicy }
      : undefined
  };
}

/**
 * Clones shell runtime config for this config-runtime subsystem.
 *
 * **Why it exists:**
 * Keeps shell runtime profile and bound cloning aligned across isolated and full-access config
 * assembly paths.
 *
 * **What it talks to:**
 * - Uses `cloneShellRuntimeProfile` within this module.
 *
 * @param shellRuntime - Stable shell runtime config to clone.
 * @returns Cloned shell-runtime config record.
 */
function cloneShellRuntimeConfig(
  shellRuntime: BrainConfig["shellRuntime"]
): BrainConfig["shellRuntime"] {
  return {
    profile: cloneShellRuntimeProfile(shellRuntime.profile),
    timeoutBoundsMs: { ...shellRuntime.timeoutBoundsMs },
    commandMaxCharsBounds: { ...shellRuntime.commandMaxCharsBounds }
  };
}

/**
 * Applies full-access runtime overrides to a stable brain-config baseline.
 *
 * **Why it exists:**
 * Keeps the runtime-mode overlay canonical once `config.ts` stops owning it inline.
 *
 * **What it talks to:**
 * - Uses local config-cloning logic within this module.
 *
 * @param base - Stable baseline config to overlay.
 * @returns Full-access overlay result.
 */
function withFullAccessOverrides(base: BrainConfig): BrainConfig {
  return {
    ...base,
    permissions: {
      ...base.permissions,
      allowShellCommandAction: true,
      allowNetworkWriteAction: true,
      allowCreateSkillAction: true,
      enforceSandboxDelete: false,
      enforceSandboxListDirectory: false
    },
    runtime: {
      mode: "full_access",
      requireContainerIsolation: false,
      requireDedicatedHost: true,
      isDaemonMode: base.runtime.isDaemonMode
    }
  };
}
