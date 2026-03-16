/**
 * @fileoverview Defines runtime configuration for governance, safety limits, DNA constraints, and model routing policies.
 */

import { ensureEnvLoaded } from "./envLoader";
import type {
  BrainConfig
} from "./configRuntime/envContracts";
import {
  SHELL_COMMAND_MAX_CHARS_BOUNDS,
  SHELL_TIMEOUT_MS_BOUNDS
} from "./shellRuntimeProfile";
import {
  parseBoolean,
  parseBoundedPositiveInteger,
  parseBrowserVerificationHeadless,
  appendProtectedPathPrefix,
  parseHourOfDay,
  parseInteger,
  parseLedgerBackend,
  parseNonNegativeInteger,
  parsePositiveInteger,
  parsePositiveNumber,
  parseRuntimeMode,
  parseUserProtectedPathPrefixes
} from "./configRuntime/configParsing";
import {
  buildDefaultShellRuntimeProfile,
  buildMutableConfigForRuntimeMode,
  resolveConfiguredShellRuntimeProfile
} from "./configRuntime/platformProfiles";

export type {
  BrainConfig,
  LedgerBackend,
  ModelPolicy,
  OrganRole,
  RuntimeMode
} from "./configRuntime/envContracts";

const PER_TURN_DEADLINE_MS_BOUNDS = {
  min: 5_000,
  max: 600_000
} as const;

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
      "start_process",
      "check_process",
      "stop_process",
      "probe_port",
      "probe_http",
      "verify_browser",
      "open_browser",
      "close_browser",
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
      "brain_per_turn_deadline_ms",
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
  browserVerification: {
    headless: true
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
  let config = buildMutableConfigForRuntimeMode(DEFAULT_BRAIN_CONFIG, runtimeMode);

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

  config.shellRuntime.profile = resolveConfiguredShellRuntimeProfile({
    env,
    shellRuntime: config.shellRuntime,
    allowRealShellExecution: config.permissions.allowRealShellExecution,
    platform: process.platform
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
  config.browserVerification.headless = parseBrowserVerificationHeadless(
    env,
    config.browserVerification.headless
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
  config.limits.perTurnDeadlineMs = parseBoundedPositiveInteger(
    env.BRAIN_PER_TURN_DEADLINE_MS,
    config.limits.perTurnDeadlineMs,
    PER_TURN_DEADLINE_MS_BOUNDS,
    "BRAIN_PER_TURN_DEADLINE_MS"
  );

  const profileMemoryPath = env.BRAIN_PROFILE_MEMORY_PATH?.trim();
  if (profileMemoryPath) {
    appendProtectedPathPrefix(config.dna.protectedPathPrefixes, profileMemoryPath);
  }

  return config;
}
