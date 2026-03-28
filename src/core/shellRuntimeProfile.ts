/**
 * @fileoverview Resolves deterministic host shell runtime profiles and spawn specs for cross-platform shell execution.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import {
  EnvModeV1,
  ShellKindV1,
  ShellRuntimeProfileV1,
  ShellSpawnSpecV1
} from "./types";
import { sha256HexFromCanonicalJson } from "./normalizers/canonicalizationRules";

export const SHELL_TIMEOUT_MS_BOUNDS = {
  min: 250,
  max: 120_000
} as const;

export const SHELL_COMMAND_MAX_CHARS_BOUNDS = {
  min: 256,
  max: 32_000
} as const;

export const DEFAULT_SHELL_TIMEOUT_MS = 10_000;
export const DEFAULT_SHELL_COMMAND_MAX_CHARS = 4_000;

export const DEFAULT_SHELL_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMP",
  "TEMP",
  "SYSTEMROOT",
  "ComSpec",
  "PATHEXT",
  "WINDIR",
  "SHELL",
  "PWD",
  "LANG",
  "TERM"
] as const;

export const DEFAULT_SHELL_ENV_DENYLIST = [
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASS",
  "AUTH",
  "COOKIE",
  "SESSION",
  "KEY",
  "PRIVATE"
] as const;

const KNOWN_SHELL_PROFILE_OPTIONS = new Set<string>([
  "auto",
  "powershell",
  "pwsh",
  "cmd",
  "bash",
  "zsh",
  "wsl_bash"
]);

const KNOWN_SHELL_ENV_MODES = new Set<string>(["allowlist", "passthrough"]);
const WINDOWS_PATHEXT_DEFAULT = [".COM", ".EXE", ".BAT", ".CMD"];
const ALLOWED_SHELL_EXECUTABLE_OVERRIDES = new Set<string>([
  "bash",
  "zsh",
  "cmd",
  "cmd.exe",
  "powershell",
  "powershell.exe",
  "pwsh",
  "wsl",
  "wsl.exe"
]);

export interface ResolveShellRuntimeProfileInput {
  requestedProfile: "auto" | ShellKindV1;
  executableOverride: string | null;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  allowRealShellExecution: boolean;
  timeoutMsDefault: number;
  commandMaxChars: number;
  envMode: EnvModeV1;
  envAllowlistKeys: readonly string[];
  envDenylistKeys: readonly string[];
  allowExecutionPolicyBypass: boolean;
  wslDistro: string | null;
  denyOutsideSandboxCwd: boolean;
  allowRelativeCwd: boolean;
}

export interface BuildShellSpawnSpecInput {
  profile: ShellRuntimeProfileV1;
  command: string;
  cwd: string;
  timeoutMs: number;
  envKeyNames: readonly string[];
}

export interface ShellEnvironmentResolution {
  env: NodeJS.ProcessEnv;
  envKeyNames: string[];
  redactedEnvKeyNames: string[];
}

/**
 * Normalizes shell profile option into a stable shape for `shellRuntimeProfile` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for shell profile option so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `ShellKindV1` (import `ShellKindV1`) from `./types`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `"auto" | ShellKindV1` result.
 */
export function normalizeShellProfileOption(value: string | undefined): "auto" | ShellKindV1 {
  const normalized = (value ?? "auto").trim().toLowerCase();
  if (!KNOWN_SHELL_PROFILE_OPTIONS.has(normalized)) {
    throw new Error(
      "SHELL_PROFILE_INVALID: BRAIN_SHELL_PROFILE must be one of auto|pwsh|powershell|cmd|bash|zsh|wsl_bash."
    );
  }
  return normalized as "auto" | ShellKindV1;
}

/**
 * Normalizes shell env mode into a stable shape for `shellRuntimeProfile` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for shell env mode so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses `EnvModeV1` (import `EnvModeV1`) from `./types`.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `EnvModeV1` result.
 */
export function normalizeShellEnvMode(value: string | undefined): EnvModeV1 {
  const normalized = (value ?? "allowlist").trim().toLowerCase();
  if (!KNOWN_SHELL_ENV_MODES.has(normalized)) {
    throw new Error(
      "SHELL_PROFILE_INVALID: BRAIN_SHELL_ENV_MODE must be one of allowlist|passthrough."
    );
  }
  return normalized as EnvModeV1;
}

/**
 * Normalizes shell csv list into a stable shape for `shellRuntimeProfile` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for shell csv list so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Ordered collection produced by this step.
 */
export function normalizeShellCsvList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Resolves shell runtime profile from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of shell runtime profile by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `ShellRuntimeProfileV1` (import `ShellRuntimeProfileV1`) from `./types`.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `ShellRuntimeProfileV1` result.
 */
export function resolveShellRuntimeProfile(
  input: ResolveShellRuntimeProfileInput
): ShellRuntimeProfileV1 {
  const platform = normalizeSupportedPlatform(input.platform);
  const shellKind = resolveShellKind(input.requestedProfile, platform, input.env, input.allowRealShellExecution);
  if (!isShellKindSupportedOnPlatform(shellKind, platform)) {
    throw new Error(
      `SHELL_PROFILE_NOT_SUPPORTED_ON_PLATFORM: shell profile '${shellKind}' is not supported on platform '${platform}'.`
    );
  }

  const executable = resolveShellExecutable({
    shellKind,
    executableOverride: input.executableOverride,
    platform,
    env: input.env,
    allowRealShellExecution: input.allowRealShellExecution
  });
  const wrapperArgs = buildShellWrapperArgs({
    shellKind,
    allowExecutionPolicyBypass: input.allowExecutionPolicyBypass,
    wslDistro: input.wslDistro
  });

  return {
    profileVersion: "v1",
    platform,
    shellKind,
    executable,
    invocationMode: "inline_command",
    wrapperArgs,
    encoding: "utf8",
    commandMaxChars: input.commandMaxChars,
    timeoutMsDefault: input.timeoutMsDefault,
    envPolicy: {
      mode: input.envMode,
      allowlist: input.envAllowlistKeys,
      denylist: input.envDenylistKeys
    },
    cwdPolicy: {
      allowRelative: input.allowRelativeCwd,
      normalize: "native",
      denyOutsideSandbox: input.denyOutsideSandboxCwd
    },
    wslPolicy:
      shellKind === "wsl_bash"
        ? {
          enabled: true,
          windowsOnly: true,
          ...(input.wslDistro ? { distro: input.wslDistro } : {})
        }
        : undefined
  };
}

/**
 * Builds shell spawn spec for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of shell spawn spec consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `ShellSpawnSpecV1` (import `ShellSpawnSpecV1`) from `./types`.
 *
 * @param input - Structured input object for this operation.
 * @returns Computed `ShellSpawnSpecV1` result.
 */
export function buildShellSpawnSpec(input: BuildShellSpawnSpecInput): ShellSpawnSpecV1 {
  return {
    executable: input.profile.executable,
    args: [...input.profile.wrapperArgs, input.command],
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    envMode: input.profile.envPolicy.mode,
    envKeyNames: [...input.envKeyNames]
  };
}

/**
 * Derives shell profile fingerprint from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for shell profile fingerprint in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `./normalizers/canonicalizationRules`.
 * - Uses `ShellRuntimeProfileV1` (import `ShellRuntimeProfileV1`) from `./types`.
 *
 * @param profile - Filesystem location used by this operation.
 * @returns Resulting string value.
 */
export function computeShellProfileFingerprint(profile: ShellRuntimeProfileV1): string {
  return sha256HexFromCanonicalJson({
    profileVersion: profile.profileVersion,
    platform: profile.platform,
    shellKind: profile.shellKind,
    executable: profile.executable,
    invocationMode: profile.invocationMode,
    wrapperArgs: profile.wrapperArgs,
    commandMaxChars: profile.commandMaxChars,
    timeoutMsDefault: profile.timeoutMsDefault,
    envPolicy: profile.envPolicy,
    cwdPolicy: profile.cwdPolicy,
    wslPolicy: profile.wslPolicy ?? null
  });
}

/**
 * Derives shell spawn spec fingerprint from available runtime inputs.
 *
 * **Why it exists:**
 * Keeps derivation logic for shell spawn spec fingerprint in one place so downstream policy uses the same signal.
 *
 * **What it talks to:**
 * - Uses `sha256HexFromCanonicalJson` (import `sha256HexFromCanonicalJson`) from `./normalizers/canonicalizationRules`.
 * - Uses `ShellSpawnSpecV1` (import `ShellSpawnSpecV1`) from `./types`.
 *
 * @param spec - Value for spec.
 * @returns Resulting string value.
 */
export function computeShellSpawnSpecFingerprint(spec: ShellSpawnSpecV1): string {
  return sha256HexFromCanonicalJson(spec);
}

/**
 * Resolves shell environment from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of shell environment by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `ShellRuntimeProfileV1` (import `ShellRuntimeProfileV1`) from `./types`.
 *
 * @param profile - Filesystem location used by this operation.
 * @param sourceEnv - Value for source env.
 * @returns Computed `ShellEnvironmentResolution` result.
 */
export function resolveShellEnvironment(
  profile: ShellRuntimeProfileV1,
  sourceEnv: NodeJS.ProcessEnv
): ShellEnvironmentResolution {
  const denylist = new Set(
    (profile.envPolicy.denylist ?? [])
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0)
  );
  /**
   * Checks whether an environment key is blocked by denylist token matching.
   *
   * **Why it exists:**
   * Secret-shaped keys vary by naming convention. Token-based matching lets policy block both exact
   * and embedded variants (for example `GITHUB_TOKEN`, `API_SECRET_KEY`).
   *
   * **What it talks to:**
   * - Reads local `denylist` set prepared from profile policy.
   *
   * @param key - Environment key name being evaluated.
   * @returns `true` when the key should be redacted.
   */
  const includesDeniedKey = (key: string): boolean => {
    const normalized = key.toLowerCase();
    return Array.from(denylist).some((token) => normalized.includes(token));
  };

  const env: NodeJS.ProcessEnv = {};
  const redactedEnvKeyNames = new Set<string>();
  if (profile.envPolicy.mode === "allowlist") {
    const allowlist = (profile.envPolicy.allowlist ?? [])
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    for (const key of allowlist) {
      if (!(key in sourceEnv)) {
        continue;
      }
      if (includesDeniedKey(key)) {
        redactedEnvKeyNames.add(key);
        continue;
      }
      env[key] = sourceEnv[key];
    }
  } else {
    for (const [key, value] of Object.entries(sourceEnv)) {
      if (includesDeniedKey(key)) {
        redactedEnvKeyNames.add(key);
        continue;
      }
      env[key] = value;
    }
  }

  const envKeyNames = Object.keys(env).sort((left, right) => left.localeCompare(right));
  return {
    env,
    envKeyNames,
    redactedEnvKeyNames: Array.from(redactedEnvKeyNames).sort((left, right) =>
      left.localeCompare(right)
    )
  };
}

/**
 * Normalizes supported platform into a stable shape for `shellRuntimeProfile` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for supported platform so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param platform - Value for platform.
 * @returns Computed `"win32" | "darwin" | "linux"` result.
 */
function normalizeSupportedPlatform(platform: NodeJS.Platform): "win32" | "darwin" | "linux" {
  if (platform === "win32" || platform === "darwin" || platform === "linux") {
    return platform;
  }
  throw new Error(
    `SHELL_PROFILE_NOT_SUPPORTED_ON_PLATFORM: unsupported host platform '${platform}'.`
  );
}

/**
 * Resolves shell kind from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of shell kind by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `ShellKindV1` (import `ShellKindV1`) from `./types`.
 *
 * @param requestedProfile - Filesystem location used by this operation.
 * @param platform - Value for platform.
 * @param env - Value for env.
 * @param allowRealShellExecution - Value for allow real shell execution.
 * @returns Computed `ShellKindV1` result.
 */
function resolveShellKind(
  requestedProfile: "auto" | ShellKindV1,
  platform: "win32" | "darwin" | "linux",
  env: NodeJS.ProcessEnv,
  allowRealShellExecution: boolean
): ShellKindV1 {
  if (requestedProfile !== "auto") {
    return requestedProfile;
  }

  if (platform === "win32") {
    if (!allowRealShellExecution) {
      return "pwsh";
    }
    const hasPwsh = resolveExecutableFromPath(["pwsh"], platform, env) !== null;
    if (hasPwsh) {
      return "pwsh";
    }
    const hasWindowsPowerShell =
      resolveExecutableFromPath(["powershell", "powershell.exe"], platform, env) !== null;
    if (hasWindowsPowerShell) {
      return "powershell";
    }
    throw new Error(
      "SHELL_EXECUTABLE_NOT_FOUND: unable to resolve pwsh or powershell executable for win32 host."
    );
  }

  if (allowRealShellExecution && resolveExecutableFromPath(["bash"], platform, env) === null) {
    throw new Error(
      `SHELL_EXECUTABLE_NOT_FOUND: unable to resolve bash executable for ${platform} host.`
    );
  }

  return "bash";
}

/**
 * Evaluates shell kind supported on platform and returns a deterministic policy signal.
 *
 * **Why it exists:**
 * Keeps the shell kind supported on platform policy check explicit and testable before side effects.
 *
 * **What it talks to:**
 * - Uses `ShellKindV1` (import `ShellKindV1`) from `./types`.
 *
 * @param shellKind - Value for shell kind.
 * @param platform - Value for platform.
 * @returns `true` when this check passes.
 */
function isShellKindSupportedOnPlatform(
  shellKind: ShellKindV1,
  platform: "win32" | "darwin" | "linux"
): boolean {
  if (shellKind === "wsl_bash") {
    return platform === "win32";
  }
  return true;
}

interface ResolveShellExecutableInput {
  shellKind: ShellKindV1;
  executableOverride: string | null;
  platform: "win32" | "darwin" | "linux";
  env: NodeJS.ProcessEnv;
  allowRealShellExecution: boolean;
}

/**
 * Resolves shell executable from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of shell executable by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 * @returns Resulting string value.
 */
function resolveShellExecutable(input: ResolveShellExecutableInput): string {
  if (!input.allowRealShellExecution) {
    if (input.executableOverride) {
      validateExecutableOverride(input.executableOverride);
      return input.executableOverride;
    }
    return defaultExecutableCandidates(input.shellKind)[0];
  }

  if (input.executableOverride) {
    validateExecutableOverride(input.executableOverride);
    const resolvedOverride = resolveExecutableFromPath(
      [input.executableOverride],
      input.platform,
      input.env
    );
    if (input.allowRealShellExecution && !resolvedOverride) {
      throw new Error(
        `SHELL_EXECUTABLE_NOT_FOUND: override executable '${input.executableOverride}' could not be resolved.`
      );
    }
    return resolvedOverride ?? input.executableOverride;
  }

  const candidates = defaultExecutableCandidates(input.shellKind);
  const resolved = resolveExecutableFromPath(candidates, input.platform, input.env);
  if (input.allowRealShellExecution && !resolved) {
    throw new Error(
      `SHELL_EXECUTABLE_NOT_FOUND: no executable resolved for shell profile '${input.shellKind}'.`
    );
  }

  return resolved ?? candidates[0];
}

/**
 * Applies deterministic validity checks for executable override.
 *
 * **Why it exists:**
 * Fails fast when executable override is invalid so later control flow stays safe and predictable.
 *
 * **What it talks to:**
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param overrideValue - Stable identifier used to reference an entity or record.
 */
function validateExecutableOverride(overrideValue: string): void {
  const trimmed = overrideValue.trim();
  if (trimmed.length === 0) {
    throw new Error("SHELL_PROFILE_INVALID: BRAIN_SHELL_EXECUTABLE cannot be empty.");
  }

  if (path.isAbsolute(trimmed)) {
    return;
  }

  const normalized = trimmed.toLowerCase();
  if (!ALLOWED_SHELL_EXECUTABLE_OVERRIDES.has(normalized)) {
    throw new Error(
      "SHELL_PROFILE_INVALID: BRAIN_SHELL_EXECUTABLE must be absolute or a known shell executable."
    );
  }
}

/**
 * Returns the default executable candidates used when explicit config is absent.
 *
 * **Why it exists:**
 * Keeps fallback defaults for executable candidates centralized so unset-config behavior is predictable.
 *
 * **What it talks to:**
 * - Uses `ShellKindV1` (import `ShellKindV1`) from `./types`.
 *
 * @param shellKind - Value for shell kind.
 * @returns Ordered collection produced by this step.
 */
function defaultExecutableCandidates(shellKind: ShellKindV1): readonly string[] {
  switch (shellKind) {
    case "pwsh":
      return ["pwsh"];
    case "powershell":
      return ["powershell", "powershell.exe"];
    case "cmd":
      return ["cmd.exe", "cmd"];
    case "bash":
      return ["bash"];
    case "zsh":
      return ["zsh"];
    case "wsl_bash":
      return ["wsl.exe", "wsl"];
    default:
      return ["bash"];
  }
}

interface BuildShellWrapperArgsInput {
  shellKind: ShellKindV1;
  allowExecutionPolicyBypass: boolean;
  wslDistro: string | null;
}

/**
 * Builds shell wrapper args for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of shell wrapper args consistent across call sites.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param input - Structured input object for this operation.
 * @returns Ordered collection produced by this step.
 */
function buildShellWrapperArgs(input: BuildShellWrapperArgsInput): readonly string[] {
  switch (input.shellKind) {
    case "pwsh":
    case "powershell": {
      const args = ["-NoProfile", "-NonInteractive"];
      if (input.allowExecutionPolicyBypass) {
        args.push("-ExecutionPolicy", "Bypass");
      }
      args.push("-Command");
      return args;
    }
    case "cmd":
      // `/s` changes quoting semantics and can break quoted drive paths under child-process spawn.
      return ["/d", "/c"];
    case "bash":
      return ["-lc"];
    case "zsh":
      return ["-lc"];
    case "wsl_bash": {
      const args: string[] = [];
      if (input.wslDistro) {
        args.push("-d", input.wslDistro);
      }
      args.push("bash", "-lc");
      return args;
    }
    default:
      return ["-lc"];
  }
}

/**
 * Resolves executable from path from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of executable from path by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param candidates - Timestamp used for ordering, timeout, or recency decisions.
 * @param platform - Value for platform.
 * @param env - Value for env.
 * @returns Computed `string | null` result.
 */
function resolveExecutableFromPath(
  candidates: readonly string[],
  platform: "win32" | "darwin" | "linux",
  env: NodeJS.ProcessEnv
): string | null {
  for (const candidate of candidates) {
    const resolved = resolveSingleExecutable(candidate, platform, env);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

/**
 * Resolves single executable from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of single executable by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses `existsSync` (import `existsSync`) from `node:fs`.
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param executable - Value for executable.
 * @param platform - Value for platform.
 * @param env - Value for env.
 * @returns Computed `string | null` result.
 */
function resolveSingleExecutable(
  executable: string,
  platform: "win32" | "darwin" | "linux",
  env: NodeJS.ProcessEnv
): string | null {
  const trimmed = executable.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (path.isAbsolute(trimmed)) {
    return existsSync(trimmed) ? trimmed : null;
  }

  const hasPathSeparator = trimmed.includes("/") || trimmed.includes("\\");
  if (hasPathSeparator) {
    const resolvedRelative = path.resolve(process.cwd(), trimmed);
    return existsSync(resolvedRelative) ? resolvedRelative : null;
  }

  const pathEntries = splitPathEntries(env.PATH, platform);
  const pathextEntries = resolvePathExtEntries(env.PATHEXT, platform);
  const hasKnownExtension = path.extname(trimmed).length > 0;
  for (const entry of pathEntries) {
    if (!entry) {
      continue;
    }
    if (platform === "win32" && !hasKnownExtension) {
      for (const extension of pathextEntries) {
        const candidatePath = path.join(entry, `${trimmed}${extension}`);
        if (existsSync(candidatePath)) {
          return candidatePath;
        }
      }
      continue;
    }

    const candidatePath = path.join(entry, trimmed);
    if (existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  if (platform === "win32") {
    return resolveKnownWindowsExecutable(trimmed, env);
  }

  return null;
}

/**
 * Resolves known Windows shell executable locations when PATH-based resolution is unavailable.
 *
 * **Why it exists:**
 * Interface and service hosts can start with a reduced PATH while still having built-in Windows shells
 * installed in deterministic system locations. This keeps real-shell execution fail-closed without
 * requiring PATH to be complete.
 *
 * **What it talks to:**
 * - Uses `existsSync` (import `existsSync`) from `node:fs`.
 * - Uses `path` (import `default`) from `node:path`.
 *
 * @param executable - Stable identifier used to reference an entity or record.
 * @param env - Value for env.
 * @returns Computed `string | null` result.
 */
function resolveKnownWindowsExecutable(
  executable: string,
  env: NodeJS.ProcessEnv
): string | null {
  const normalized = executable.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  const systemRoot = firstDefinedNonEmpty(env.SYSTEMROOT, env.SystemRoot, env.WINDIR, env.windir);
  const comSpec = firstDefinedNonEmpty(env.ComSpec, env.COMSPEC);
  const programFiles = firstDefinedNonEmpty(
    env.ProgramW6432,
    env.PROGRAMW6432,
    env["ProgramFiles"],
    env.PROGRAMFILES
  );
  const programFilesX86 = firstDefinedNonEmpty(
    env["ProgramFiles(x86)"],
    env.PROGRAMFILES_X86
  );

  const candidatePaths: string[] = [];
  if (normalized === "powershell" || normalized === "powershell.exe") {
    if (systemRoot) {
      candidatePaths.push(
        path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
      );
    }
  } else if (normalized === "cmd" || normalized === "cmd.exe") {
    if (comSpec) {
      candidatePaths.push(comSpec);
    }
    if (systemRoot) {
      candidatePaths.push(path.join(systemRoot, "System32", "cmd.exe"));
    }
  } else if (normalized === "pwsh" || normalized === "pwsh.exe") {
    if (programFiles) {
      candidatePaths.push(path.join(programFiles, "PowerShell", "7", "pwsh.exe"));
    }
    if (programFilesX86) {
      candidatePaths.push(path.join(programFilesX86, "PowerShell", "7", "pwsh.exe"));
    }
  }

  for (const candidatePath of candidatePaths) {
    if (candidatePath && existsSync(candidatePath)) {
      return candidatePath;
    }
  }

  return null;
}

/**
 * Returns the first defined non-empty string from a list of environment-like values.
 *
 * **Why it exists:**
 * Windows exposes some environment keys with inconsistent casing between hosts. This helper keeps
 * fallback resolution deterministic without repeating trimming logic.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param values - Primary value processed by this function.
 * @returns Resulting string value.
 */
function firstDefinedNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

/**
 * Splits path entries into normalized segments for downstream parsing.
 *
 * **Why it exists:**
 * Maintains one token/segment boundary policy for path entries so lexical decisions stay stable.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param pathValue - Filesystem location used by this operation.
 * @param platform - Value for platform.
 * @returns Ordered collection produced by this step.
 */
function splitPathEntries(
  pathValue: string | undefined,
  platform: "win32" | "darwin" | "linux"
): string[] {
  if (!pathValue || pathValue.trim().length === 0) {
    return [];
  }
  const separator = platform === "win32" ? ";" : ":";
  return pathValue
    .split(separator)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Resolves path ext entries from available runtime context.
 *
 * **Why it exists:**
 * Prevents divergent selection of path ext entries by keeping rules in one function.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param pathextValue - Filesystem location used by this operation.
 * @param platform - Value for platform.
 * @returns Ordered collection produced by this step.
 */
function resolvePathExtEntries(
  pathextValue: string | undefined,
  platform: "win32" | "darwin" | "linux"
): string[] {
  if (platform !== "win32") {
    return [""];
  }
  const entries = (pathextValue ?? WINDOWS_PATHEXT_DEFAULT.join(";"))
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return WINDOWS_PATHEXT_DEFAULT;
  }
  return entries;
}
