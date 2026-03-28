import {
  resolveShellEnvironment,
  type ShellEnvironmentResolution
} from "../../core/shellRuntimeProfile";
import type { ShellRuntimeProfileV1 } from "../../core/types";
import { ShellCommandActionParams } from "../../core/types";
import type { CappedTextBuffer, ShellExecutionDependencies } from "./contracts";
export {
  resolveShellSuccessWorkspaceRoot,
  resolveShellPostconditionFailure,
  type ShellPostconditionFailure
} from "./shellExecutionPostconditions";

const SHELL_OUTPUT_CAPTURE_MAX_BYTES = 64 * 1024;
const KNOWN_SHELL_PARTIAL_FAILURE_PATTERNS: readonly RegExp[] = [
  /the process cannot access the file because it is being used by another process\./i,
  /\bmove-item\b[\s\S]{0,120}\bioexception\b/i,
  /\bfullyqualifiederrorid\s*:\s*move(?:directory)?item/i,
  /\$last(exit)?code.+has not been set/i,
  /\bnpm\.ps1\b[\s\S]{0,240}\bvariableisundefined\b/i
] as const;
const WINDOWS_POWERSHELL_EMBEDDED_NODE_PACKAGE_MANAGER_PATTERN =
  /(^|[;{\r\n]\s*)(npm|npx)(?=\s)/gim;
const WINDOWS_POWERSHELL_PACKAGE_MANAGER_SEGMENT_PATTERN =
  /(^|[;{\r\n]\s*)((?:npm|npx)(?:\.cmd)?\b[^\r\n;}]*)/gim;
const WINDOWS_PACKAGE_MANAGER_COMMAND_PATTERN =
  /^\s*(?:npm|npx|pnpm|yarn|bun)(?:\.cmd)?\b/i;
const WINDOWS_PACKAGE_MANAGER_LAUNCHER_ENV_KEYS = [
  "ComSpec",
  "PATHEXT",
  "WINDIR"
] as const;
const SHELL_DEPENDENCY_MISSING_PATTERNS: readonly RegExp[] = [
  /\berr_module_not_found\b/i,
  /\bcannot find module\b/i,
  /\bcannot find package\b/i,
  /\bmodule not found\b/i,
  /\bmodulenotfounderror\b/i,
  /\bno module named\b/i
] as const;
const SHELL_VERSION_INCOMPATIBLE_PATTERNS: readonly RegExp[] = [
  /\beresolve\b/i,
  /\brequires a peer of\b/i,
  /\bpeer dep(?:endency)?\b/i,
  /\bunsupported engine\b/i,
  /\bconflicting peer dependency\b/i,
  /\bcould not resolve dependency\b/i
] as const;

/**
 * Returns whether the command contains a Windows package-manager invocation, either as the first
 * shell segment or later in a multi-statement PowerShell script.
 *
 * @param command - Raw shell command requested by the planner/runtime.
 * @returns `true` when the command includes an npm/npx/pnpm/yarn/bun launcher segment.
 */
function containsWindowsPackageManagerCommand(command: string): boolean {
  WINDOWS_POWERSHELL_PACKAGE_MANAGER_SEGMENT_PATTERN.lastIndex = 0;
  return (
    WINDOWS_PACKAGE_MANAGER_COMMAND_PATTERN.test(command) ||
    WINDOWS_POWERSHELL_PACKAGE_MANAGER_SEGMENT_PATTERN.test(command)
  );
}

export interface ShellRecoveryFailureClassification {
  recoveryClass: "DEPENDENCY_MISSING" | "VERSION_INCOMPATIBLE";
  provenance: "executor_mechanical";
  detail: string;
}

export type ShellRecoveryFailureMetadata = Record<string, string> & {
  recoveryFailureClass: string;
  recoveryFailureProvenance: "executor_mechanical";
  recoveryFailureDetail?: string;
};

/** Appends one stdout/stderr chunk into a bounded capture buffer. */
export function appendChunkToBuffer(
  buffer: CappedTextBuffer,
  chunk: Buffer
): CappedTextBuffer {
  if (chunk.length === 0) {
    return buffer;
  }

  if (buffer.truncated || buffer.bytes >= SHELL_OUTPUT_CAPTURE_MAX_BYTES) {
    return {
      ...buffer,
      truncated: true
    };
  }

  const remaining = SHELL_OUTPUT_CAPTURE_MAX_BYTES - buffer.bytes;
  const slice = chunk.subarray(0, remaining);
  return {
    text: buffer.text + slice.toString("utf8"),
    bytes: buffer.bytes + slice.length,
    truncated: buffer.truncated || chunk.length > remaining
  };
}

/** Creates an empty bounded text buffer for shell output capture. */
export function emptyCappedTextBuffer(): CappedTextBuffer {
  return {
    text: "",
    bytes: 0,
    truncated: false
  };
}

/** Treats known stderr signatures as hard failure even when the shell exits cleanly. */
export function hasKnownShellPartialFailure(stderrText: string): boolean {
  const normalized = stderrText.trim();
  if (normalized.length === 0) {
    return false;
  }
  return KNOWN_SHELL_PARTIAL_FAILURE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** Classifies deterministic dependency or version failures from shell output text when present. */
export function resolveShellRecoveryFailureClassification(
  shellOutputText: string
): ShellRecoveryFailureClassification | null {
  const normalized = shellOutputText.trim();
  if (normalized.length === 0) {
    return null;
  }
  if (SHELL_DEPENDENCY_MISSING_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      recoveryClass: "DEPENDENCY_MISSING",
      provenance: "executor_mechanical",
      detail: "Shell output showed a missing dependency or module import."
    };
  }
  if (SHELL_VERSION_INCOMPATIBLE_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      recoveryClass: "VERSION_INCOMPATIBLE",
      provenance: "executor_mechanical",
      detail: "Shell output showed an incompatible dependency or toolchain version."
    };
  }
  return null;
}

/** Builds native recovery metadata for deterministic shell spawn failures. */
export function buildShellRecoveryFailureMetadata(
  recoveryClass: "EXECUTABLE_NOT_FOUND" | "COMMAND_TOO_LONG"
): ShellRecoveryFailureMetadata {
  return {
    recoveryFailureClass: recoveryClass,
    recoveryFailureProvenance: "executor_mechanical"
  };
}

/** Resolves native shell recovery metadata from one deterministic shell failure payload. */
export function resolveShellFailureRecoveryMetadata(
  shellOutputText: string
): ShellRecoveryFailureMetadata | undefined {
  const classification = resolveShellRecoveryFailureClassification(shellOutputText);
  if (!classification) {
    return undefined;
  }
  return {
    recoveryFailureClass: classification.recoveryClass,
    recoveryFailureProvenance: classification.provenance,
    recoveryFailureDetail: classification.detail
  };
}

/**
 * Returns the effective shell profile for this command.
 *
 * Windows package-manager commands now stay on the configured PowerShell profile and rely on
 * `.cmd` launcher normalization instead of forcing a `cmd.exe` shell hop. That keeps execution
 * working in stripped Windows environments where PowerShell is present but `cmd.exe` is not
 * available to the runtime.
 *
 * @param profile - Runtime shell profile selected from config.
 * @param command - Raw shell command requested by the planner/runtime.
 * @returns Profile used for actual process execution.
 */
export function resolveEffectiveShellProfile(
  profile: ShellRuntimeProfileV1,
  _command: string
): ShellRuntimeProfileV1 {
  return profile;
}

/**
 * Rewrites embedded Windows PowerShell npm/npx invocations to their `.cmd` launchers so local
 * package-manager steps do not trip over npm.ps1 wrapper behavior inside multi-statement scripts.
 *
 * @param profile - Runtime shell profile selected from config.
 * @param command - Raw shell command requested by the planner/runtime.
 * @returns Command text normalized for safe Windows PowerShell execution.
 */
export function normalizeWindowsPowerShellPackageManagerCommand(
  profile: ShellRuntimeProfileV1,
  command: string
): string {
  if (
    profile.platform !== "win32" ||
    (profile.shellKind !== "powershell" && profile.shellKind !== "pwsh")
  ) {
    return command;
  }
  return command.replace(
    WINDOWS_POWERSHELL_EMBEDDED_NODE_PACKAGE_MANAGER_PATTERN,
    (_match, prefix: string, executable: string) => `${prefix}${executable}.cmd`
  );
}

/**
 * Resolves shell environment and augments Windows package-manager launches with the small set of
 * launcher variables needed for reliable child-process startup under allowlist mode.
 *
 * @param profile - Effective shell profile selected for execution.
 * @param command - Raw shell command requested by the planner/runtime.
 * @param sourceEnv - Source environment from the current Node.js runtime.
 * @returns Resolved environment payload used for process execution.
 */
export function resolveCommandAwareShellEnvironment(
  profile: ShellRuntimeProfileV1,
  command: string,
  sourceEnv: NodeJS.ProcessEnv
): ShellEnvironmentResolution {
  const resolution = resolveShellEnvironment(profile, sourceEnv);
  if (
    profile.platform !== "win32" ||
    profile.envPolicy.mode !== "allowlist" ||
    !containsWindowsPackageManagerCommand(command)
  ) {
    return resolution;
  }

  const env = { ...resolution.env };
  const envKeyNames = new Set<string>(resolution.envKeyNames);
  for (const key of WINDOWS_PACKAGE_MANAGER_LAUNCHER_ENV_KEYS) {
    const value = sourceEnv[key];
    if (typeof value !== "string" || value.length === 0) {
      continue;
    }
    env[key] = value;
    envKeyNames.add(key);
  }

  return {
    env,
    envKeyNames: Array.from(envKeyNames).sort((left, right) => left.localeCompare(right)),
    redactedEnvKeyNames: [...resolution.redactedEnvKeyNames]
  };
}

/**
 * Appends explicit `$LASTEXITCODE` checks after embedded Windows PowerShell package-manager
 * commands so native command failures do not get masked by later script statements.
 *
 * @param profile - Effective shell profile selected for execution.
 * @param command - Raw shell command after Windows npm/npx normalization.
 * @returns Command text that preserves native package-manager failures on PowerShell.
 */
export function appendWindowsPowerShellPackageManagerFailureChecks(
  profile: ShellRuntimeProfileV1,
  command: string
): string {
  if (
    profile.platform !== "win32" ||
    (profile.shellKind !== "powershell" && profile.shellKind !== "pwsh")
  ) {
    return command;
  }
  return command.replace(
    WINDOWS_POWERSHELL_PACKAGE_MANAGER_SEGMENT_PATTERN,
    (_match, prefix: string, segment: string) => {
      const trimmedSegment = segment.trimEnd();
      if (/\$LASTEXITCODE\b/i.test(trimmedSegment)) {
        return `${prefix}${trimmedSegment}`;
      }
      return `${prefix}${trimmedSegment}; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
    }
  );
}


/**
 * Resolves the bounded timeout applied to the shell command.
 *
 * @param config - Active brain config with shell policy.
 * @param params - Shell action params.
 * @returns Timeout in milliseconds.
 */
export function resolveShellCommandTimeoutMs(
  config: ShellExecutionDependencies["config"],
  params: ShellCommandActionParams
): number {
  if (typeof params.timeoutMs !== "number" || !Number.isInteger(params.timeoutMs)) {
    return config.shellRuntime.profile.timeoutMsDefault;
  }
  if (
    params.timeoutMs < config.shellRuntime.timeoutBoundsMs.min ||
    params.timeoutMs > config.shellRuntime.timeoutBoundsMs.max
  ) {
    return config.shellRuntime.profile.timeoutMsDefault;
  }
  return params.timeoutMs;
}
