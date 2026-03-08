/**
 * @fileoverview Tests runtime-profile config behavior, including full-access safety latch and execution toggles.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import { createBrainConfigFromEnv, DEFAULT_BRAIN_CONFIG } from "../../src/core/config";
import { HOST_TEST_PRIVATE_DIR } from "../support/windowsPathFixtures";

test("defaults to isolated runtime mode", () => {
  const config = createBrainConfigFromEnv({});
  assert.equal(config.runtime.mode, "isolated");
  assert.equal(config.permissions.allowShellCommandAction, false);
  assert.equal(config.permissions.allowNetworkWriteAction, false);
  assert.equal(config.permissions.allowCreateSkillAction, true);
  assert.equal(config.permissions.enforceSandboxListDirectory, true);
  assert.equal(config.reflection.reflectOnSuccess, false);
  assert.equal(config.persistence.ledgerBackend, "json");
  assert.equal(config.persistence.ledgerSqlitePath, "runtime/ledgers.sqlite");
  assert.equal(config.persistence.exportJsonOnWrite, true);
  assert.equal(config.observability.traceEnabled, false);
  assert.equal(config.observability.traceLogPath, "runtime/runtime_trace.jsonl");
  assert.equal(config.browserVerification.headless, true);
});

test("requires explicit acknowledgement for full access mode", () => {
  assert.throws(
    () =>
      createBrainConfigFromEnv({
        BRAIN_RUNTIME_MODE: "full_access"
      }),
    /BRAIN_ALLOW_FULL_ACCESS/
  );
});

test("builds full access profile when acknowledgement is set", () => {
  const config = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true"
  });

  assert.equal(config.runtime.mode, "full_access");
  assert.equal(config.permissions.allowShellCommandAction, true);
  assert.equal(config.permissions.allowNetworkWriteAction, true);
  assert.equal(config.permissions.enforceSandboxDelete, false);
  assert.equal(config.permissions.enforceSandboxListDirectory, false);
});

test("can enable real side effects explicitly", () => {
  const config = createBrainConfigFromEnv({
    BRAIN_RUNTIME_MODE: "full_access",
    BRAIN_ALLOW_FULL_ACCESS: "true",
    BRAIN_ENABLE_REAL_SHELL: "true",
    BRAIN_ENABLE_REAL_NETWORK_WRITE: "true",
    BRAIN_SHELL_PROFILE: "bash",
    BRAIN_SHELL_EXECUTABLE: process.execPath
  });

  assert.equal(config.permissions.allowRealShellExecution, true);
  assert.equal(config.permissions.allowRealNetworkWrite, true);
});

test("default constant remains isolated and side-effect safe", () => {
  assert.equal(DEFAULT_BRAIN_CONFIG.runtime.mode, "isolated");
  assert.equal(DEFAULT_BRAIN_CONFIG.permissions.allowRealShellExecution, false);
  assert.equal(DEFAULT_BRAIN_CONFIG.permissions.allowRealNetworkWrite, false);
});

test("defaults dual budget controls for per-action and cumulative limits", () => {
  const config = createBrainConfigFromEnv({});
  assert.equal(config.limits.maxEstimatedCostUsd, 1.25);
  assert.equal(config.limits.maxCumulativeEstimatedCostUsd, 10);
  assert.equal(config.limits.maxCumulativeModelSpendUsd, 10);
  assert.equal(config.limits.maxSubagentsPerTask, 2);
  assert.equal(config.limits.maxSubagentDepth, 1);
  assert.equal(config.limits.maxAutonomousConsecutiveNoProgressIterations, 3);
  assert.equal(config.limits.maxDaemonGoalRollovers, 0);
});

test("supports env overrides for per-action and cumulative budget limits", () => {
  const config = createBrainConfigFromEnv({
    BRAIN_MAX_ACTION_COST_USD: "0.5",
    BRAIN_MAX_CUMULATIVE_COST_USD: "12",
    BRAIN_MAX_MODEL_SPEND_USD: "3",
    BRAIN_MAX_SUBAGENTS_PER_TASK: "4",
    BRAIN_MAX_SUBAGENT_DEPTH: "2",
    BRAIN_AUTONOMOUS_MAX_CONSECUTIVE_NO_PROGRESS: "6",
    BRAIN_MAX_DAEMON_GOAL_ROLLOVERS: "6",
    BRAIN_PER_TURN_DEADLINE_MS: "120000"
  });

  assert.equal(config.limits.maxEstimatedCostUsd, 0.5);
  assert.equal(config.limits.maxCumulativeEstimatedCostUsd, 12);
  assert.equal(config.limits.maxCumulativeModelSpendUsd, 3);
  assert.equal(config.limits.maxSubagentsPerTask, 4);
  assert.equal(config.limits.maxSubagentDepth, 2);
  assert.equal(config.limits.maxAutonomousConsecutiveNoProgressIterations, 6);
  assert.equal(config.limits.maxDaemonGoalRollovers, 6);
  assert.equal(config.limits.perTurnDeadlineMs, 120000);
});

test("fails closed when per-turn deadline env override is out of bounds", () => {
  assert.throws(
    () =>
      createBrainConfigFromEnv({
        BRAIN_PER_TURN_DEADLINE_MS: "1000"
      }),
    /BRAIN_PER_TURN_DEADLINE_MS out of range/
  );
});

test("falls back for negative daemon rollover limits", () => {
  const config = createBrainConfigFromEnv({
    BRAIN_MAX_DAEMON_GOAL_ROLLOVERS: "-4"
  });
  assert.equal(config.limits.maxDaemonGoalRollovers, DEFAULT_BRAIN_CONFIG.limits.maxDaemonGoalRollovers);
});

test("protects default and configured profile-memory paths from runtime modification", () => {
  const defaultConfig = createBrainConfigFromEnv({});
  assert.equal(
    defaultConfig.dna.protectedPathPrefixes.includes("runtime/profile_memory.secure.json"),
    true
  );
  assert.equal(
    defaultConfig.dna.protectedPathPrefixes.includes("runtime/memory_access_log.json"),
    true
  );
  assert.equal(
    defaultConfig.dna.protectedPathPrefixes.includes("runtime/runtime_trace.jsonl"),
    true
  );
  assert.equal(
    defaultConfig.dna.protectedPathPrefixes.includes("runtime/ledgers.sqlite"),
    true
  );

  const configuredConfig = createBrainConfigFromEnv({
    BRAIN_PROFILE_MEMORY_PATH: "runtime/private/profile_memory.secure.json"
  });
  assert.equal(
    configuredConfig.dna.protectedPathPrefixes.includes(
      "runtime/private/profile_memory.secure.json"
    ),
    true
  );
});

test("supports owner-declared user protected paths from env", () => {
  const config = createBrainConfigFromEnv({
    BRAIN_USER_PROTECTED_PATHS: `runtime/owner-safe;"${HOST_TEST_PRIVATE_DIR}"`
  });

  assert.equal(
    config.dna.protectedPathPrefixes.includes("runtime/owner-safe"),
    true
  );
  assert.equal(
    config.dna.protectedPathPrefixes.includes(HOST_TEST_PRIVATE_DIR),
    true
  );
});

test("deduplicates normalized user protected paths", () => {
  const config = createBrainConfigFromEnv({
    BRAIN_USER_PROTECTED_PATHS: "memory/;MeMoRy\\"
  });
  const normalizedMemoryPrefixCount = config.dna.protectedPathPrefixes
    .map((prefix) => prefix.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase())
    .filter((prefix) => prefix === "memory")
    .length;

  assert.equal(normalizedMemoryPrefixCount, 1);
});

test("fails closed when user protected path config contains empty entries", () => {
  assert.throws(
    () =>
      createBrainConfigFromEnv({
        BRAIN_USER_PROTECTED_PATHS: "runtime/safe;;runtime/other"
      }),
    /BRAIN_USER_PROTECTED_PATHS contains an empty path entry/
  );
});

test("fails closed when user protected path config contains invalid characters", () => {
  assert.throws(
    () =>
      createBrainConfigFromEnv({
        BRAIN_USER_PROTECTED_PATHS: "runtime/safe*"
      }),
    /BRAIN_USER_PROTECTED_PATHS contains invalid path entry/
  );
});

test("supports agent pulse env overrides including midnight quiet-hour boundaries", () => {
  const config = createBrainConfigFromEnv({
    BRAIN_AGENT_PULSE_ENABLED: "true",
    BRAIN_AGENT_PULSE_TZ_OFFSET_MINUTES: "-300",
    BRAIN_AGENT_PULSE_QUIET_START_HOUR: "0",
    BRAIN_AGENT_PULSE_QUIET_END_HOUR: "6",
    BRAIN_AGENT_PULSE_MIN_INTERVAL_MINUTES: "30"
  });

  assert.equal(config.agentPulse.enabled, true);
  assert.equal(config.agentPulse.timezoneOffsetMinutes, -300);
  assert.equal(config.agentPulse.quietHoursStartHourLocal, 0);
  assert.equal(config.agentPulse.quietHoursEndHourLocal, 6);
  assert.equal(config.agentPulse.minIntervalMinutes, 30);
});

test("supports legacy agent pulse timezone env alias", () => {
  const config = createBrainConfigFromEnv({
    BRAIN_AGENT_PULSE_TIMEZONE_OFFSET_MINUTES: "-360"
  });
  assert.equal(config.agentPulse.timezoneOffsetMinutes, -360);
});

test("falls back to defaults when agent pulse env hours are out of range", () => {
  const config = createBrainConfigFromEnv({
    BRAIN_AGENT_PULSE_QUIET_START_HOUR: "-1",
    BRAIN_AGENT_PULSE_QUIET_END_HOUR: "24"
  });

  assert.equal(
    config.agentPulse.quietHoursStartHourLocal,
    DEFAULT_BRAIN_CONFIG.agentPulse.quietHoursStartHourLocal
  );
  assert.equal(
    config.agentPulse.quietHoursEndHourLocal,
    DEFAULT_BRAIN_CONFIG.agentPulse.quietHoursEndHourLocal
  );
});

test("supports success-reflection env override", () => {
  const enabled = createBrainConfigFromEnv({
    BRAIN_REFLECT_ON_SUCCESS: "true"
  });
  assert.equal(enabled.reflection.reflectOnSuccess, true);

  const disabled = createBrainConfigFromEnv({
    BRAIN_REFLECT_ON_SUCCESS: "false"
  });
  assert.equal(disabled.reflection.reflectOnSuccess, false);
});

test("supports ledger backend sqlite env overrides", () => {
  const config = createBrainConfigFromEnv({
    BRAIN_LEDGER_BACKEND: "sqlite",
    BRAIN_LEDGER_SQLITE_PATH: "runtime/custom_ledgers.sqlite",
    BRAIN_LEDGER_EXPORT_JSON_ON_WRITE: "false"
  });

  assert.equal(config.persistence.ledgerBackend, "sqlite");
  assert.equal(config.persistence.ledgerSqlitePath, "runtime/custom_ledgers.sqlite");
  assert.equal(config.persistence.exportJsonOnWrite, false);
  assert.equal(
    config.dna.protectedPathPrefixes.includes("runtime/custom_ledgers.sqlite"),
    true
  );
});

test("supports structured trace logging env overrides", () => {
  const config = createBrainConfigFromEnv({
    BRAIN_TRACE_LOG_ENABLED: "true",
    BRAIN_TRACE_LOG_PATH: "runtime/custom_trace.jsonl"
  });

  assert.equal(config.observability.traceEnabled, true);
  assert.equal(config.observability.traceLogPath, "runtime/custom_trace.jsonl");
  assert.equal(
    config.dna.protectedPathPrefixes.includes("runtime/custom_trace.jsonl"),
    true
  );
});

test("supports headed browser verification env override", () => {
  const config = createBrainConfigFromEnv({
    BRAIN_BROWSER_VERIFY_HEADLESS: "false"
  });

  assert.equal(config.browserVerification.headless, false);
});

test("supports visible browser verification alias with precedence over headless flag", () => {
  const config = createBrainConfigFromEnv({
    BRAIN_BROWSER_VERIFY_HEADLESS: "true",
    BRAIN_BROWSER_VERIFY_VISIBLE: "true"
  });

  assert.equal(config.browserVerification.headless, false);
});

test("defaults deterministic shell runtime profile and bounds", () => {
  const config = createBrainConfigFromEnv({});
  const expectedExecutable = process.platform === "win32" ? "pwsh" : "bash";
  assert.equal(config.shellRuntime.profile.profileVersion, "v1");
  assert.equal(config.shellRuntime.profile.invocationMode, "inline_command");
  assert.equal(config.shellRuntime.profile.executable, expectedExecutable);
  assert.equal(config.shellRuntime.profile.commandMaxChars, 4000);
  assert.equal(config.shellRuntime.profile.timeoutMsDefault, 10000);
  assert.equal(config.shellRuntime.timeoutBoundsMs.min, 250);
  assert.equal(config.shellRuntime.timeoutBoundsMs.max, 120000);
});

test("supports deterministic shell runtime env overrides", () => {
  const config = createBrainConfigFromEnv({
    BRAIN_SHELL_PROFILE: "bash",
    BRAIN_SHELL_TIMEOUT_MS: "20000",
    BRAIN_SHELL_COMMAND_MAX_CHARS: "6000",
    BRAIN_SHELL_ENV_MODE: "allowlist",
    BRAIN_SHELL_ENV_ALLOWLIST: "PATH,HOME",
    BRAIN_SHELL_ENV_DENYLIST: "TOKEN,SECRET"
  });

  assert.equal(config.shellRuntime.profile.shellKind, "bash");
  assert.equal(config.shellRuntime.profile.timeoutMsDefault, 20000);
  assert.equal(config.shellRuntime.profile.commandMaxChars, 6000);
  assert.equal(config.shellRuntime.profile.envPolicy.mode, "allowlist");
  assert.deepEqual(config.shellRuntime.profile.envPolicy.allowlist, ["PATH", "HOME"]);
  assert.deepEqual(config.shellRuntime.profile.envPolicy.denylist, ["TOKEN", "SECRET"]);
});

test("supports deterministic zsh shell runtime env overrides", () => {
  const config = createBrainConfigFromEnv({
    BRAIN_SHELL_PROFILE: "zsh",
    BRAIN_SHELL_TIMEOUT_MS: "20000",
    BRAIN_SHELL_COMMAND_MAX_CHARS: "6000"
  });

  assert.equal(config.shellRuntime.profile.shellKind, "zsh");
  assert.equal(config.shellRuntime.profile.executable, "zsh");
  assert.deepEqual(config.shellRuntime.profile.wrapperArgs, ["-lc"]);
  assert.equal(config.shellRuntime.profile.timeoutMsDefault, 20000);
  assert.equal(config.shellRuntime.profile.commandMaxChars, 6000);
});

test("fails closed on invalid shell profile enum", () => {
  assert.throws(
    () =>
      createBrainConfigFromEnv({
        BRAIN_SHELL_PROFILE: "fish"
      }),
    /SHELL_PROFILE_INVALID/
  );
});

test("fails closed on invalid shell command max chars bound", () => {
  assert.throws(
    () =>
      createBrainConfigFromEnv({
        BRAIN_SHELL_COMMAND_MAX_CHARS: "100"
      }),
    /BRAIN_SHELL_COMMAND_MAX_CHARS out of range/
  );
});

test("does not require shell executable resolution when real shell execution is disabled", () => {
  const config = createBrainConfigFromEnv({
    BRAIN_SHELL_PROFILE: "bash",
    BRAIN_SHELL_EXECUTABLE: "bash"
  });
  assert.equal(config.shellRuntime.profile.executable, "bash");
});

test("fails closed when real shell execution is enabled and executable override cannot be resolved", () => {
  assert.throws(
    () =>
      createBrainConfigFromEnv({
        BRAIN_RUNTIME_MODE: "full_access",
        BRAIN_ALLOW_FULL_ACCESS: "true",
        BRAIN_ENABLE_REAL_SHELL: "true",
        BRAIN_SHELL_EXECUTABLE: path.join(process.cwd(), "does_not_exist_shell_executable")
      }),
    /SHELL_EXECUTABLE_NOT_FOUND/
  );
});

test("fails closed for wsl_bash profile on non-win32 hosts", () => {
  if (process.platform === "win32") {
    const config = createBrainConfigFromEnv({
      BRAIN_SHELL_PROFILE: "wsl_bash"
    });
    assert.equal(config.shellRuntime.profile.shellKind, "wsl_bash");
    return;
  }

  assert.throws(
    () =>
      createBrainConfigFromEnv({
        BRAIN_SHELL_PROFILE: "wsl_bash"
      }),
    /SHELL_PROFILE_NOT_SUPPORTED_ON_PLATFORM/
  );
});
