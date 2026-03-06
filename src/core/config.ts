/**
 * @fileoverview Defines runtime configuration for governance, safety limits, DNA constraints, and model routing policies.
 */

import { ActionType, GovernorId } from "./types";
import { ensureEnvLoaded } from "./envLoader";
import { ShellRuntimeProfileV1 } from "./types";
import {
  DEFAULT_SHELL_COMMAND_MAX_CHARS,
  DEFAULT_SHELL_ENV_ALLOWLIST,
  DEFAULT_SHELL_ENV_DENYLIST,
  DEFAULT_SHELL_TIMEOUT_MS,
  normalizeShellCsvList,
  normalizeShellEnvMode,
  normalizeShellProfileOption,
  resolveShellRuntimeProfile,
  SHELL_COMMAND_MAX_CHARS_BOUNDS,
  SHELL_TIMEOUT_MS_BOUNDS
} from "./shellRuntimeProfile";

export type OrganRole = "planner" | "executor" | "governor" | "memory" | "synthesizer";
export type RuntimeMode = "isolated" | "full_access";
export type LedgerBackend = "json" | "sqlite";

export interface ModelPolicy {
  primary: string;
  fallback: string;
}

export interface BrainConfig {
  governance: {
    councilSize: number;
    supermajorityThreshold: number;
    fastPathGovernorIds: GovernorId[];
    escalationActionTypes: ActionType[];
  };
  limits: {
    maxEstimatedCostUsd: number;
    maxCumulativeEstimatedCostUsd: number;
    maxCumulativeModelSpendUsd: number;
    maxSubagentsPerTask: number;
    maxSubagentDepth: number;
    maxActionsPerTask: number;
    maxPlanAttemptsPerTask: number;
    maxAutonomousIterations: number;
    maxAutonomousConsecutiveNoProgressIterations: number;
    maxDaemonGoalRollovers: number;
    perGovernorTimeoutMs: number;
    perTurnDeadlineMs: number;
  };
  dna: {
    sandboxPathPrefix: string;
    immutableKeywords: string[];
    protectedPathPrefixes: string[];
  };
  permissions: {
    allowShellCommandAction: boolean;
    allowNetworkWriteAction: boolean;
    allowCreateSkillAction: boolean;
    enforceSandboxDelete: boolean;
    enforceSandboxListDirectory: boolean;
    enforceProtectedPathWrites: boolean;
    allowRealShellExecution: boolean;
    allowRealNetworkWrite: boolean;
  };
  runtime: {
    mode: RuntimeMode;
    requireContainerIsolation: boolean;
    requireDedicatedHost: boolean;
    isDaemonMode: boolean;
  };
  agentPulse: {
    enabled: boolean;
    enableDynamicPulse: boolean;
    timezoneOffsetMinutes: number;
    quietHoursStartHourLocal: number;
    quietHoursEndHourLocal: number;
    minIntervalMinutes: number;
  };
  reflection: {
    reflectOnSuccess: boolean;
  };
  embeddings: {
    enabled: boolean;
    modelDir: string;
    vectorSqlitePath: string;
  };
  persistence: {
    ledgerBackend: LedgerBackend;
    ledgerSqlitePath: string;
    exportJsonOnWrite: boolean;
  };
  observability: {
    traceEnabled: boolean;
    traceLogPath: string;
  };
  shellRuntime: {
    profile: ShellRuntimeProfileV1;
    timeoutBoundsMs: {
      min: number;
      max: number;
    };
    commandMaxCharsBounds: {
      min: number;
      max: number;
    };
  };
  routing: Record<OrganRole, ModelPolicy>;
  governorRouting: Partial<Record<GovernorId, ModelPolicy>>;
}

const INVALID_USER_PROTECTED_PATH_PATTERN = /[\u0000*?<>|]/;

/**
 * Parses boolean and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for boolean so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns `true` when this check passes.
 */
function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

/**
 * Parses runtime mode and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for runtime mode so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `RuntimeMode` result.
 */
function parseRuntimeMode(value: string | undefined): RuntimeMode {
  const normalized = (value ?? "isolated").trim().toLowerCase();
  return normalized === "full_access" ? "full_access" : "isolated";
}

/**
 * Parses ledger backend and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for ledger backend so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Computed `LedgerBackend` result.
 */
function parseLedgerBackend(value: string | undefined): LedgerBackend {
  const normalized = (value ?? "json").trim().toLowerCase();
  return normalized === "sqlite" ? "sqlite" : "json";
}

/**
 * Parses positive number and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for positive number so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns Computed numeric value.
 */
function parsePositiveNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

/**
 * Parses positive integer and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for positive integer so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns Computed numeric value.
 */
function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = parsePositiveNumber(value, fallback);
  return Number.isInteger(parsed) ? parsed : fallback;
}

/**
 * Parses bounded positive integer and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for bounded positive integer so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @param bounds - Value for bounds.
 * @param envKey - Lookup key or map field identifier.
 * @returns Computed numeric value.
 */
function parseBoundedPositiveInteger(
  value: string | undefined,
  fallback: number,
  bounds: { min: number; max: number },
  envKey: string
): number {
  const parsed = parsePositiveInteger(value, fallback);
  if (parsed < bounds.min || parsed > bounds.max) {
    throw new Error(
      `${envKey} out of range: ${parsed}. Expected ${bounds.min}..${bounds.max}.`
    );
  }
  return parsed;
}

/**
 * Parses integer and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for integer so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns Computed numeric value.
 */
function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    return fallback;
  }

  return parsed;
}

/**
 * Parses non negative integer and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for non negative integer so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns Computed numeric value.
 */
function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  const parsed = parseInteger(value, fallback);
  if (parsed < 0) {
    return fallback;
  }
  return parsed;
}

/**
 * Parses hour of day and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for hour of day so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @param fallback - Value for fallback.
 * @returns Computed numeric value.
 */
function parseHourOfDay(value: string | undefined, fallback: number): number {
  const parsed = parseInteger(value, fallback);
  if (parsed < 0 || parsed > 23) {
    return fallback;
  }
  return parsed;
}

/**
 * Constrains and sanitizes wrapping quotes to safe deterministic bounds.
 *
 * **Why it exists:**
 * Enforces consistent bounds/sanitization for wrapping quotes before data flows to policy checks.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }

  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === "\"" || first === "'") && first === last) {
    return trimmed.slice(1, -1).trim();
  }

  return trimmed;
}

/**
 * Normalizes protected path prefix into a stable shape for `config` logic.
 *
 * **Why it exists:**
 * Centralizes normalization rules for protected path prefix so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Resulting string value.
 */
function normalizeProtectedPathPrefix(value: string): string {
  return value
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Persists protected path prefix with deterministic state semantics.
 *
 * **Why it exists:**
 * Centralizes protected path prefix mutations for auditability and replay.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param prefixes - Value for prefixes.
 * @param candidate - Timestamp used for ordering, timeout, or recency decisions.
 */
function appendProtectedPathPrefix(prefixes: string[], candidate: string): void {
  const normalizedCandidate = normalizeProtectedPathPrefix(candidate);
  if (
    prefixes.some((existing) =>
      normalizeProtectedPathPrefix(existing) === normalizedCandidate
    )
  ) {
    return;
  }
  prefixes.push(candidate);
}

/**
 * Parses user protected path prefixes and validates expected structure.
 *
 * **Why it exists:**
 * Centralizes normalization rules for user protected path prefixes so call sites stay aligned.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param value - Primary value processed by this function.
 * @returns Ordered collection produced by this step.
 */
function parseUserProtectedPathPrefixes(value: string | undefined): string[] {
  if (!value || value.trim().length === 0) {
    return [];
  }

  const entries = value.split(";");
  if (entries.some((entry) => entry.trim().length === 0)) {
    throw new Error(
      "BRAIN_USER_PROTECTED_PATHS contains an empty path entry. " +
      "Use ';' separated non-empty paths."
    );
  }

  const parsed: string[] = [];
  for (const rawEntry of entries) {
    const pathEntry = stripWrappingQuotes(rawEntry);
    if (!pathEntry) {
      throw new Error(
        "BRAIN_USER_PROTECTED_PATHS contains an empty path entry after trimming quotes."
      );
    }

    if (INVALID_USER_PROTECTED_PATH_PATTERN.test(pathEntry)) {
      throw new Error(
        `BRAIN_USER_PROTECTED_PATHS contains invalid path entry "${pathEntry}". ` +
        "Wildcards and shell-reserved path characters are not allowed."
      );
    }

    parsed.push(pathEntry);
  }

  return parsed;
}

/**
 * Builds default shell runtime profile for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of default shell runtime profile consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `DEFAULT_SHELL_COMMAND_MAX_CHARS` (import `DEFAULT_SHELL_COMMAND_MAX_CHARS`) from `./shellRuntimeProfile`.
 * - Uses `DEFAULT_SHELL_ENV_ALLOWLIST` (import `DEFAULT_SHELL_ENV_ALLOWLIST`) from `./shellRuntimeProfile`.
 * - Uses `DEFAULT_SHELL_ENV_DENYLIST` (import `DEFAULT_SHELL_ENV_DENYLIST`) from `./shellRuntimeProfile`.
 * - Uses `DEFAULT_SHELL_TIMEOUT_MS` (import `DEFAULT_SHELL_TIMEOUT_MS`) from `./shellRuntimeProfile`.
 * - Uses `resolveShellRuntimeProfile` (import `resolveShellRuntimeProfile`) from `./shellRuntimeProfile`.
 * - Uses `ShellRuntimeProfileV1` (import `ShellRuntimeProfileV1`) from `./types`.
 * @returns Computed `ShellRuntimeProfileV1` result.
 */
function buildDefaultShellRuntimeProfile(): ShellRuntimeProfileV1 {
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

export const DEFAULT_BRAIN_CONFIG: BrainConfig = {
  governance: {
    councilSize: 7,
    supermajorityThreshold: 6,
    fastPathGovernorIds: ["security"],
    escalationActionTypes: [
      "delete_file",
      "self_modify",
      "network_write",
      "shell_command",
      "create_skill",
      "memory_mutation",
      "pulse_emit"
    ]
  },
  limits: {
    maxEstimatedCostUsd: 1.25,
    maxCumulativeEstimatedCostUsd: 10,
    maxCumulativeModelSpendUsd: 10,
    maxSubagentsPerTask: 2,
    maxSubagentDepth: 1,
    maxActionsPerTask: 8,
    maxPlanAttemptsPerTask: 2,
    maxAutonomousIterations: 15,
    maxAutonomousConsecutiveNoProgressIterations: 3,
    maxDaemonGoalRollovers: 0,
    perGovernorTimeoutMs: 3_000,
    perTurnDeadlineMs: 20_000
  },
  dna: {
    sandboxPathPrefix: "runtime/sandbox/",
    immutableKeywords: [
      "constitution",
      "dna_constraints",
      "kill_switch",
      "hard_budget",
      "maxestimatedcostusd",
      "maxcumulativeestimatedcostusd",
      "maxcumulativemodelspendusd",
      "maxsubagentspertask",
      "maxsubagentdepth",
      "brain_max_action_cost_usd",
      "brain_max_cumulative_cost_usd",
      "brain_max_model_spend_usd",
      "brain_max_subagents_per_task",
      "brain_max_subagent_depth",
      "brain_autonomous_max_consecutive_no_progress",
      "maxdaemongoalrollovers",
      "brain_max_daemon_goal_rollovers"
    ],
    protectedPathPrefixes: [
      "memory/",
      "src/core/config.ts",
      ".env",
      ".env.local",
      "runtime/governance_memory.json",
      "runtime/memory_access_log.json",
      "runtime/profile_memory.secure.json",
      "runtime/runtime_trace.jsonl",
      "runtime/ledgers.sqlite"
    ]
  },
  permissions: {
    allowShellCommandAction: false,
    allowNetworkWriteAction: false,
    allowCreateSkillAction: true,
    enforceSandboxDelete: true,
    enforceSandboxListDirectory: true,
    enforceProtectedPathWrites: true,
    allowRealShellExecution: false,
    allowRealNetworkWrite: false
  },
  runtime: {
    mode: "isolated",
    requireContainerIsolation: true,
    requireDedicatedHost: false,
    isDaemonMode: false
  },
  agentPulse: {
    enabled: false,
    enableDynamicPulse: false,
    timezoneOffsetMinutes: 0,
    quietHoursStartHourLocal: 22,
    quietHoursEndHourLocal: 8,
    minIntervalMinutes: 240
  },
  reflection: {
    reflectOnSuccess: false
  },
  embeddings: {
    enabled: true,
    modelDir: "models/all-MiniLM-L6-v2",
    vectorSqlitePath: "runtime/vectors.sqlite"
  },
  persistence: {
    ledgerBackend: "json",
    ledgerSqlitePath: "runtime/ledgers.sqlite",
    exportJsonOnWrite: true
  },
  observability: {
    traceEnabled: false,
    traceLogPath: "runtime/runtime_trace.jsonl"
  },
  shellRuntime: {
    profile: buildDefaultShellRuntimeProfile(),
    timeoutBoundsMs: {
      min: SHELL_TIMEOUT_MS_BOUNDS.min,
      max: SHELL_TIMEOUT_MS_BOUNDS.max
    },
    commandMaxCharsBounds: {
      min: SHELL_COMMAND_MAX_CHARS_BOUNDS.min,
      max: SHELL_COMMAND_MAX_CHARS_BOUNDS.max
    }
  },
  routing: {
    planner: {
      primary: "large-reasoning-model",
      fallback: "medium-general-model"
    },
    executor: {
      primary: "small-fast-model",
      fallback: "medium-general-model"
    },
    governor: {
      primary: "small-policy-model",
      fallback: "medium-general-model"
    },
    memory: {
      primary: "small-fast-model",
      fallback: "small-policy-model"
    },
    synthesizer: {
      primary: "medium-general-model",
      fallback: "large-reasoning-model"
    }
  },
  governorRouting: {
    ethics: {
      primary: "medium-policy-model",
      fallback: "small-policy-model"
    },
    logic: {
      primary: "medium-policy-model",
      fallback: "small-policy-model"
    },
    resource: {
      primary: "small-policy-model",
      fallback: "medium-general-model"
    },
    security: {
      primary: "medium-policy-model",
      fallback: "small-policy-model"
    },
    continuity: {
      primary: "small-policy-model",
      fallback: "medium-general-model"
    },
    utility: {
      primary: "small-policy-model",
      fallback: "medium-general-model"
    },
    compliance: {
      primary: "medium-policy-model",
      fallback: "small-policy-model"
    },
    codeReview: {
      primary: "medium-policy-model",
      fallback: "small-policy-model"
    }
  }
};

/**
 * Implements with full access overrides behavior used by `config`.
 *
 * **Why it exists:**
 * Keeps `with full access overrides` logic in one place to reduce behavior drift.
 *
 * **What it talks to:**
 * - Uses local constants/helpers within this module.
 *
 * @param base - Value for base.
 * @returns Computed `BrainConfig` result.
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

/**
 * Builds brain config from env for this module's runtime flow.
 *
 * **Why it exists:**
 * Keeps construction of brain config from env consistent across call sites.
 *
 * **What it talks to:**
 * - Uses `ensureEnvLoaded` (import `ensureEnvLoaded`) from `./envLoader`.
 * - Uses `DEFAULT_SHELL_ENV_ALLOWLIST` (import `DEFAULT_SHELL_ENV_ALLOWLIST`) from `./shellRuntimeProfile`.
 * - Uses `DEFAULT_SHELL_ENV_DENYLIST` (import `DEFAULT_SHELL_ENV_DENYLIST`) from `./shellRuntimeProfile`.
 * - Uses `normalizeShellCsvList` (import `normalizeShellCsvList`) from `./shellRuntimeProfile`.
 * - Uses `normalizeShellEnvMode` (import `normalizeShellEnvMode`) from `./shellRuntimeProfile`.
 * - Uses `normalizeShellProfileOption` (import `normalizeShellProfileOption`) from `./shellRuntimeProfile`.
 * - Additional imported collaborators are also used in this function body.
 *
 * @param env - Value for env.
 * @returns Computed `BrainConfig` result.
 */
export function createBrainConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BrainConfig {
  if (env === process.env) {
    ensureEnvLoaded();
  }
  const runtimeMode = parseRuntimeMode(env.BRAIN_RUNTIME_MODE);
  let config: BrainConfig =
    runtimeMode === "full_access"
      ? withFullAccessOverrides(DEFAULT_BRAIN_CONFIG)
      : {
        ...DEFAULT_BRAIN_CONFIG,
        permissions: { ...DEFAULT_BRAIN_CONFIG.permissions },
        runtime: { ...DEFAULT_BRAIN_CONFIG.runtime },
        agentPulse: { ...DEFAULT_BRAIN_CONFIG.agentPulse },
        reflection: { ...DEFAULT_BRAIN_CONFIG.reflection },
        embeddings: { ...DEFAULT_BRAIN_CONFIG.embeddings },
        persistence: { ...DEFAULT_BRAIN_CONFIG.persistence },
        observability: { ...DEFAULT_BRAIN_CONFIG.observability },
        shellRuntime: {
          profile: {
            ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile,
            wrapperArgs: [...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.wrapperArgs],
            envPolicy: {
              ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.envPolicy,
              allowlist: [...(DEFAULT_BRAIN_CONFIG.shellRuntime.profile.envPolicy.allowlist ?? [])],
              denylist: [...(DEFAULT_BRAIN_CONFIG.shellRuntime.profile.envPolicy.denylist ?? [])]
            },
            cwdPolicy: { ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.cwdPolicy },
            wslPolicy: DEFAULT_BRAIN_CONFIG.shellRuntime.profile.wslPolicy
              ? { ...DEFAULT_BRAIN_CONFIG.shellRuntime.profile.wslPolicy }
              : undefined
          },
          timeoutBoundsMs: { ...DEFAULT_BRAIN_CONFIG.shellRuntime.timeoutBoundsMs },
          commandMaxCharsBounds: { ...DEFAULT_BRAIN_CONFIG.shellRuntime.commandMaxCharsBounds }
        },
        dna: { ...DEFAULT_BRAIN_CONFIG.dna },
        governance: { ...DEFAULT_BRAIN_CONFIG.governance },
        limits: { ...DEFAULT_BRAIN_CONFIG.limits },
        routing: { ...DEFAULT_BRAIN_CONFIG.routing },
        governorRouting: { ...DEFAULT_BRAIN_CONFIG.governorRouting }
      };

  // Arrays are cloned per-config so runtime customization cannot mutate shared defaults.
  config = {
    ...config,
    dna: {
      ...config.dna,
      immutableKeywords: [...config.dna.immutableKeywords],
      protectedPathPrefixes: [...config.dna.protectedPathPrefixes]
    },
    shellRuntime: {
      ...config.shellRuntime,
      profile: {
        ...config.shellRuntime.profile,
        wrapperArgs: [...config.shellRuntime.profile.wrapperArgs],
        envPolicy: {
          ...config.shellRuntime.profile.envPolicy,
          allowlist: [...(config.shellRuntime.profile.envPolicy.allowlist ?? [])],
          denylist: [...(config.shellRuntime.profile.envPolicy.denylist ?? [])]
        },
        cwdPolicy: { ...config.shellRuntime.profile.cwdPolicy },
        wslPolicy: config.shellRuntime.profile.wslPolicy
          ? { ...config.shellRuntime.profile.wslPolicy }
          : undefined
      },
      timeoutBoundsMs: { ...config.shellRuntime.timeoutBoundsMs },
      commandMaxCharsBounds: { ...config.shellRuntime.commandMaxCharsBounds }
    }
  };

  const userProtectedPathPrefixes = parseUserProtectedPathPrefixes(
    env.BRAIN_USER_PROTECTED_PATHS
  );
  for (const protectedPrefix of userProtectedPathPrefixes) {
    appendProtectedPathPrefix(config.dna.protectedPathPrefixes, protectedPrefix);
  }

  if (runtimeMode === "full_access" && !parseBoolean(env.BRAIN_ALLOW_FULL_ACCESS, false)) {
    throw new Error(
      "Full access mode requested but BRAIN_ALLOW_FULL_ACCESS is not enabled. " +
      "Set BRAIN_ALLOW_FULL_ACCESS=true to acknowledge elevated risk."
    );
  }

  config.permissions.allowRealShellExecution = parseBoolean(
    env.BRAIN_ENABLE_REAL_SHELL,
    config.permissions.allowRealShellExecution
  );
  config.permissions.allowRealNetworkWrite = parseBoolean(
    env.BRAIN_ENABLE_REAL_NETWORK_WRITE,
    config.permissions.allowRealNetworkWrite
  );

  const requestedShellProfile = normalizeShellProfileOption(env.BRAIN_SHELL_PROFILE);
  const shellExecutableOverride = env.BRAIN_SHELL_EXECUTABLE?.trim() || null;
  const shellTimeoutMs = parseBoundedPositiveInteger(
    env.BRAIN_SHELL_TIMEOUT_MS,
    config.shellRuntime.profile.timeoutMsDefault,
    config.shellRuntime.timeoutBoundsMs,
    "BRAIN_SHELL_TIMEOUT_MS"
  );
  const shellCommandMaxChars = parseBoundedPositiveInteger(
    env.BRAIN_SHELL_COMMAND_MAX_CHARS,
    config.shellRuntime.profile.commandMaxChars,
    config.shellRuntime.commandMaxCharsBounds,
    "BRAIN_SHELL_COMMAND_MAX_CHARS"
  );
  const shellEnvMode = normalizeShellEnvMode(env.BRAIN_SHELL_ENV_MODE);
  const configuredAllowlist = normalizeShellCsvList(env.BRAIN_SHELL_ENV_ALLOWLIST);
  const configuredDenylist = normalizeShellCsvList(env.BRAIN_SHELL_ENV_DENYLIST);
  const shellEnvAllowlist =
    configuredAllowlist.length > 0
      ? configuredAllowlist
      : [...DEFAULT_SHELL_ENV_ALLOWLIST];
  const shellEnvDenylist =
    configuredDenylist.length > 0
      ? configuredDenylist
      : [...DEFAULT_SHELL_ENV_DENYLIST];
  const allowExecutionPolicyBypass = parseBoolean(
    env.BRAIN_SHELL_ALLOW_EXECUTION_POLICY_BYPASS,
    false
  );
  const shellWslDistro = env.BRAIN_SHELL_WSL_DISTRO?.trim() || null;
  const shellDenyOutsideSandbox = parseBoolean(
    env.BRAIN_SHELL_CWD_POLICY_DENY_OUTSIDE_SANDBOX,
    true
  );
  const shellAllowRelativeCwd = parseBoolean(
    env.BRAIN_SHELL_CWD_POLICY_ALLOW_RELATIVE,
    true
  );
  config.shellRuntime.profile = resolveShellRuntimeProfile({
    requestedProfile: requestedShellProfile,
    executableOverride: shellExecutableOverride,
    platform: process.platform,
    env,
    allowRealShellExecution: config.permissions.allowRealShellExecution,
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

  config.agentPulse.enabled = parseBoolean(
    env.BRAIN_AGENT_PULSE_ENABLED,
    config.agentPulse.enabled
  );
  const pulseTimezoneOffsetRaw =
    env.BRAIN_AGENT_PULSE_TZ_OFFSET_MINUTES
    ?? env.BRAIN_AGENT_PULSE_TIMEZONE_OFFSET_MINUTES;
  config.agentPulse.timezoneOffsetMinutes = parseInteger(
    pulseTimezoneOffsetRaw,
    config.agentPulse.timezoneOffsetMinutes
  );
  config.agentPulse.quietHoursStartHourLocal = parseHourOfDay(
    env.BRAIN_AGENT_PULSE_QUIET_START_HOUR,
    config.agentPulse.quietHoursStartHourLocal
  );
  config.agentPulse.quietHoursEndHourLocal = parseHourOfDay(
    env.BRAIN_AGENT_PULSE_QUIET_END_HOUR,
    config.agentPulse.quietHoursEndHourLocal
  );
  config.agentPulse.minIntervalMinutes = parsePositiveInteger(
    env.BRAIN_AGENT_PULSE_MIN_INTERVAL_MINUTES,
    config.agentPulse.minIntervalMinutes
  );
  config.agentPulse.enableDynamicPulse = parseBoolean(
    env.BRAIN_ENABLE_DYNAMIC_PULSE,
    config.agentPulse.enableDynamicPulse
  );
  config.reflection.reflectOnSuccess = parseBoolean(
    env.BRAIN_REFLECT_ON_SUCCESS,
    config.reflection.reflectOnSuccess
  );
  config.embeddings.enabled = parseBoolean(
    env.BRAIN_ENABLE_EMBEDDINGS,
    config.embeddings.enabled
  );
  const configuredEmbeddingModelDir = env.BRAIN_EMBEDDING_MODEL_DIR?.trim();
  if (configuredEmbeddingModelDir) {
    config.embeddings.modelDir = configuredEmbeddingModelDir;
  }
  const configuredVectorSqlitePath = env.BRAIN_VECTOR_SQLITE_PATH?.trim();
  if (configuredVectorSqlitePath) {
    config.embeddings.vectorSqlitePath = configuredVectorSqlitePath;
  }
  appendProtectedPathPrefix(
    config.dna.protectedPathPrefixes,
    config.embeddings.vectorSqlitePath
  );
  config.persistence.ledgerBackend = parseLedgerBackend(env.BRAIN_LEDGER_BACKEND);
  const configuredLedgerSqlitePath = env.BRAIN_LEDGER_SQLITE_PATH?.trim();
  if (configuredLedgerSqlitePath) {
    config.persistence.ledgerSqlitePath = configuredLedgerSqlitePath;
  }
  config.persistence.exportJsonOnWrite = parseBoolean(
    env.BRAIN_LEDGER_EXPORT_JSON_ON_WRITE,
    config.persistence.exportJsonOnWrite
  );
  appendProtectedPathPrefix(
    config.dna.protectedPathPrefixes,
    config.persistence.ledgerSqlitePath
  );
  config.observability.traceEnabled = parseBoolean(
    env.BRAIN_TRACE_LOG_ENABLED,
    config.observability.traceEnabled
  );
  const configuredTraceLogPath = env.BRAIN_TRACE_LOG_PATH?.trim();
  if (configuredTraceLogPath) {
    config.observability.traceLogPath = configuredTraceLogPath;
  }
  appendProtectedPathPrefix(
    config.dna.protectedPathPrefixes,
    config.observability.traceLogPath
  );

  // Budget controls are owner-configurable only and treated as immutable by runtime actions.
  config.limits.maxEstimatedCostUsd = parsePositiveNumber(
    env.BRAIN_MAX_ACTION_COST_USD,
    config.limits.maxEstimatedCostUsd
  );
  config.limits.maxCumulativeEstimatedCostUsd = parsePositiveNumber(
    env.BRAIN_MAX_CUMULATIVE_COST_USD,
    config.limits.maxCumulativeEstimatedCostUsd
  );
  config.limits.maxCumulativeModelSpendUsd = parsePositiveNumber(
    env.BRAIN_MAX_MODEL_SPEND_USD,
    config.limits.maxCumulativeModelSpendUsd
  );
  config.limits.maxSubagentsPerTask = parsePositiveInteger(
    env.BRAIN_MAX_SUBAGENTS_PER_TASK,
    config.limits.maxSubagentsPerTask
  );
  config.limits.maxSubagentDepth = parsePositiveInteger(
    env.BRAIN_MAX_SUBAGENT_DEPTH,
    config.limits.maxSubagentDepth
  );
  config.limits.maxAutonomousIterations = parseInteger(
    env.BRAIN_MAX_AUTONOMOUS_ITERATIONS,
    config.limits.maxAutonomousIterations
  );
  config.limits.maxAutonomousConsecutiveNoProgressIterations = parsePositiveInteger(
    env.BRAIN_AUTONOMOUS_MAX_CONSECUTIVE_NO_PROGRESS,
    config.limits.maxAutonomousConsecutiveNoProgressIterations
  );
  config.limits.maxDaemonGoalRollovers = parseNonNegativeInteger(
    env.BRAIN_MAX_DAEMON_GOAL_ROLLOVERS,
    config.limits.maxDaemonGoalRollovers
  );

  const profileMemoryPath = env.BRAIN_PROFILE_MEMORY_PATH?.trim();
  if (profileMemoryPath) {
    appendProtectedPathPrefix(config.dna.protectedPathPrefixes, profileMemoryPath);
  }

  return config;
}
