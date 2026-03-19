#!/usr/bin/env node

/**
 * @fileoverview Runs the governed production CLI runtime for task, autonomous, and daemon modes.
 */

import { AutonomousLoop } from "./core/agentLoop";
import { MAIN_AGENT_ID } from "./core/agentIdentity";
import { buildDefaultBrain } from "./core/buildBrain";
import { createBrainConfigFromEnv } from "./core/config";
import { ensureEnvLoaded } from "./core/envLoader";
import { makeId } from "./core/ids";
import { TaskRequest } from "./core/types";
import { createModelClientFromEnv } from "./models/createModelClient";
import { runCodexCliCommand } from "./models/codex/cli";
import { readCodexAuthStatus } from "./models/codex/authStore";
import { resolveCodexModel } from "./models/codex/modelResolution";
import { normalizeModelBackend } from "./models/backendConfig";
import { buildCodexProfileEnvironment } from "./models/codex/profileState";

export type CliMode = "task" | "autonomous" | "daemon" | "auth";
export type CodexAuthAction = "login" | "status" | "logout";

export interface ParsedCliCommand {
  mode: CliMode;
  goal?: string;
  provider?: "codex";
  action?: CodexAuthAction;
  deviceAuth?: boolean;
  profileId?: string | null;
}

interface ParsedCliFailure {
  exitCode: 0 | 1;
  stream: "stdout" | "stderr";
  message: string;
}

export type ParsedCliArgs =
  | {
    ok: true;
    command: ParsedCliCommand;
  }
  | {
    ok: false;
    failure: ParsedCliFailure;
  };

export interface DaemonContract {
  maxGoalRollovers: number;
}

const USAGE_TEXT = [
  "Usage: node dist/index.js [--autonomous | --daemon] <goal text>",
  "       node dist/index.js auth codex <login|status|logout> [--device-auth] [--profile <id>]",
  "",
  "Modes:",
  "  default       Run one governed task and exit.",
  "  --autonomous  Run bounded autonomous iterations for one goal.",
  "  --daemon      Chain goals with explicit daemon safeguards.",
  "  auth codex    Manage Codex subscription-backed login state.",
  "",
  "Daemon contract (fail-closed):",
  "  BRAIN_ALLOW_DAEMON_MODE=true",
  "  BRAIN_MAX_AUTONOMOUS_ITERATIONS must be > 0",
  "  BRAIN_MAX_DAEMON_GOAL_ROLLOVERS must be an integer > 0"
].join("\n");

/**
 * Renders the CLI usage line.
 *
 * **Why it exists:**
 * Keeps usage formatting in one place so help text and error output stay aligned.
 *
 * **What it talks to:**
 * - Local constant `USAGE_TEXT`.
 *
 * @returns Canonical usage text printed for help and invalid invocations.
 */
export function renderUsage(): string {
  return USAGE_TEXT;
}

/**
 * Evaluates whether a string token is a supported "true" flag.
 *
 * **Why it exists:**
 * Daemon safety latch parsing must remain explicit and deterministic.
 *
 * **What it talks to:**
 * - Local normalization helpers only.
 *
 * @param value - Raw environment value.
 * @returns `true` only for explicit truthy values.
 */
function isTrueFlag(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Builds a parse failure result for deterministic CLI error handling.
 *
 * **Why it exists:**
 * Keeps parse-failure construction centralized so command parsing stays simple.
 *
 * **What it talks to:**
 * - Local `ParsedCliFailure` type.
 *
 * @param exitCode - Exit code for the failure.
 * @param stream - Output stream to use for the message.
 * @param message - User-visible error/help message.
 * @returns Structured parse failure result.
 */
function toParseFailure(
  exitCode: 0 | 1,
  stream: "stdout" | "stderr",
  message: string
): ParsedCliArgs {
  return {
    ok: false,
    failure: {
      exitCode,
      stream,
      message
    }
  };
}

/**
 * Parses CLI args into a typed command contract.
 *
 * **Why it exists:**
 * Ensures the CLI mode/goal contract is deterministic and fail-closed on ambiguity.
 *
 * **What it talks to:**
 * - Local parse helpers and `renderUsage`.
 *
 * @param rawArgs - CLI args excluding node/script paths.
 * @returns Parsed command or parse failure with stream/exit metadata.
 */
export function parseCliArgs(rawArgs: readonly string[]): ParsedCliArgs {
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    return toParseFailure(0, "stdout", renderUsage());
  }

  if (rawArgs[0]?.trim().toLowerCase() === "auth") {
    return parseAuthCliArgs(rawArgs.slice(1));
  }

  let mode: CliMode = "task";
  const goalTokens: string[] = [];

  for (const rawArg of rawArgs) {
    const token = rawArg.trim();
    if (token.length === 0) {
      continue;
    }

    if (token === "--autonomous") {
      if (mode === "daemon") {
        return toParseFailure(
          1,
          "stderr",
          "Cannot combine --autonomous and --daemon.\n" + renderUsage()
        );
      }
      mode = "autonomous";
      continue;
    }

    if (token === "--daemon") {
      if (mode === "autonomous") {
        return toParseFailure(
          1,
          "stderr",
          "Cannot combine --autonomous and --daemon.\n" + renderUsage()
        );
      }
      mode = "daemon";
      continue;
    }

    if (token.startsWith("-")) {
      return toParseFailure(
        1,
        "stderr",
        `Unknown flag: ${token}\n${renderUsage()}`
      );
    }

    goalTokens.push(token);
  }

  if (goalTokens.length === 0) {
    return toParseFailure(1, "stderr", renderUsage());
  }

  const goal = goalTokens.join(" ").trim();
  if (!goal) {
    return toParseFailure(1, "stderr", renderUsage());
  }

  return {
    ok: true,
    command: {
      mode,
      goal
    }
  };
}

/**
 * Parses owner-facing auth subcommands into a typed CLI contract.
 *
 * @param rawArgs - CLI args after the leading `auth` token.
 * @returns Parsed auth command or structured parse failure.
 */
function parseAuthCliArgs(rawArgs: readonly string[]): ParsedCliArgs {
  const provider = rawArgs[0]?.trim().toLowerCase();
  if (provider !== "codex") {
    return toParseFailure(1, "stderr", `Unsupported auth provider.\n${renderUsage()}`);
  }

  const action = rawArgs[1]?.trim().toLowerCase();
  if (action !== "login" && action !== "status" && action !== "logout") {
    return toParseFailure(1, "stderr", `Unsupported auth action.\n${renderUsage()}`);
  }

  let deviceAuth = false;
  let profileId: string | null = null;
  for (let index = 2; index < rawArgs.length; index += 1) {
    const token = rawArgs[index]?.trim();
    if (!token) {
      continue;
    }
    if (token === "--device-auth") {
      deviceAuth = true;
      continue;
    }
    if (token === "--profile") {
      const value = rawArgs[index + 1]?.trim();
      if (!value) {
        return toParseFailure(1, "stderr", "Missing value for --profile.");
      }
      profileId = value;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) {
      return toParseFailure(1, "stderr", `Unknown flag: ${token}\n${renderUsage()}`);
    }
    return toParseFailure(1, "stderr", `Unexpected auth argument: ${token}\n${renderUsage()}`);
  }

  return {
    ok: true,
    command: {
      mode: "auth",
      provider: "codex",
      action,
      deviceAuth,
      profileId
    }
  };
}

/**
 * Resolves daemon startup safeguards from environment and config limits.
 *
 * **Why it exists:**
 * Daemon mode must fail closed unless explicit operator acknowledgement and bounded limits are provided.
 *
 * **What it talks to:**
 * - Runtime environment variables.
 * - `createBrainConfigFromEnv` for deterministic iteration limit checks.
 *
 * @param env - Environment map used for daemon contract checks.
 * @returns Parsed daemon contract with bounded rollover limit.
 */
export function resolveDaemonContract(env: NodeJS.ProcessEnv): DaemonContract {
  if (!isTrueFlag(env.BRAIN_ALLOW_DAEMON_MODE)) {
    throw new Error(
      "Daemon mode requires explicit acknowledgement: set BRAIN_ALLOW_DAEMON_MODE=true."
    );
  }

  const config = createBrainConfigFromEnv(env);
  if (config.limits.maxAutonomousIterations <= 0) {
    throw new Error(
      "Daemon mode requires BRAIN_MAX_AUTONOMOUS_ITERATIONS > 0 for bounded loop behavior."
    );
  }

  if (config.limits.maxDaemonGoalRollovers <= 0) {
    throw new Error(
      "Daemon mode requires BRAIN_MAX_DAEMON_GOAL_ROLLOVERS to be set to an integer > 0."
    );
  }

  return {
    maxGoalRollovers: config.limits.maxDaemonGoalRollovers
  };
}

/**
 * Registers deterministic SIGINT/SIGTERM handlers for CLI modes.
 *
 * **Why it exists:**
 * Ensures autonomous/daemon runs can be cancelled cleanly and without interactive prompts.
 *
 * **What it talks to:**
 * - Process signal handlers.
 * - `AbortController` used by autonomous loop execution.
 *
 * @param mode - Selected CLI mode.
 * @returns Signal handle containing an abort signal and cleanup callback.
 */
function registerSignalHandlers(mode: CliMode): {
  signal: AbortSignal;
  detach: () => void;
} {
  const controller = new AbortController();

  /**
   * Handles termination signal and propagates cancellation state.
   *
   * **Why it exists:**
   * Keeps SIGINT/SIGTERM handling consistent and idempotent.
   *
   * **What it talks to:**
   * - Local `AbortController` and console output.
   *
   * @param signal - Process signal name.
   */
  const stop = (signal: NodeJS.Signals): void => {
    if (controller.signal.aborted) {
      return;
    }

    if (mode === "task") {
      console.error(
        `[CLI] Received ${signal}. Waiting for the current task to finish before exit.`
      );
      return;
    }

    console.error(`[CLI] Received ${signal}. Stopping ${mode} loop...`);
    controller.abort();
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  return {
    signal: controller.signal,
    detach: () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  };
}

/**
 * Builds a task request from CLI goal text.
 *
 * **Why it exists:**
 * Keeps CLI task payload creation deterministic and aligned with runtime interfaces.
 *
 * **What it talks to:**
 * - `makeId` and `MAIN_AGENT_ID`.
 *
 * @param goal - Goal text supplied by the operator.
 * @returns Task request object suitable for `BrainOrchestrator.runTask`.
 */
function buildTaskRequest(goal: string): TaskRequest {
  return {
    id: makeId("task"),
    agentId: MAIN_AGENT_ID,
    goal,
    userInput: goal,
    createdAt: new Date().toISOString()
  };
}

/**
 * Renders redacted owner-facing Codex auth status text.
 *
 * @returns Human-readable Codex auth status.
 */
export async function renderCodexAuthStatus(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const effectiveEnv = buildCodexProfileEnvironment(env);
  const status = await readCodexAuthStatus(effectiveEnv);
  const activeBackend = normalizeModelBackend(effectiveEnv.BRAIN_MODEL_BACKEND);
  const modelMappings = [
    `small-fast-model -> ${resolveCodexModel("small-fast-model", effectiveEnv).providerModel}`,
    `small-policy-model -> ${resolveCodexModel("small-policy-model", effectiveEnv).providerModel}`,
    `medium-general-model -> ${resolveCodexModel("medium-general-model", effectiveEnv).providerModel}`,
    `medium-policy-model -> ${resolveCodexModel("medium-policy-model", effectiveEnv).providerModel}`,
    `large-reasoning-model -> ${resolveCodexModel("large-reasoning-model", effectiveEnv).providerModel}`
  ];
  if (!status.available || !status.auth) {
    return [
      "Codex auth status: unavailable",
      `Active backend: ${activeBackend}`,
      "Resolved role mappings:",
      ...modelMappings.map((mapping) => `  - ${mapping}`),
      `State dir: ${status.stateDir}`,
      `Auth file: ${status.authFilePath}`,
      `Legacy fallback: ${status.usingLegacyFallback ? "yes" : "no"}`,
      "Reason: no usable Codex login state was found."
    ].join("\n");
  }

  return [
    "Codex auth status: available",
    `Active backend: ${activeBackend}`,
    `Profile: ${status.profileId}`,
    `State dir: ${status.stateDir}`,
    `Auth file: ${status.authFilePath}`,
    `Legacy fallback: ${status.usingLegacyFallback ? "yes" : "no"}`,
    `Auth mode: ${status.auth.authMode || "unknown"}`,
    `Account id: ${status.auth.accountId ?? "unknown"}`,
    `Last refresh: ${status.auth.lastRefreshAt ?? "unknown"}`,
    `Access token present: ${status.auth.accessTokenPresent ? "yes" : "no"}`,
    `Refresh token present: ${status.auth.refreshTokenPresent ? "yes" : "no"}`,
    "Resolved role mappings:",
    ...modelMappings.map((mapping) => `  - ${mapping}`)
  ].join("\n");
}

/**
 * Executes owner-facing Codex auth management commands.
 *
 * @param command - Parsed auth command.
 */
async function runAuthMode(command: ParsedCliCommand): Promise<void> {
  if (command.provider !== "codex" || !command.action) {
    throw new Error("Auth mode requires a concrete provider and action.");
  }

  const authEnv = buildCodexProfileEnvironment(process.env, command.profileId ?? null);

  if (command.action === "status") {
    console.log(await renderCodexAuthStatus(authEnv));
    return;
  }

  if (command.action === "login") {
    const args = ["login"];
    if (command.deviceAuth) {
      args.push("--device-auth");
    }
    const result = await runCodexCliCommand(args, {
      env: authEnv
    });
    if (result.stdout.trim()) {
      console.log(result.stdout.trim());
    }
    if (result.stderr.trim()) {
      console.error(result.stderr.trim());
    }
    if (result.exitCode !== 0) {
      throw new Error(`Codex login failed with exit code ${result.exitCode}.`);
    }
    console.log(await renderCodexAuthStatus(authEnv));
    return;
  }

  const logoutResult = await runCodexCliCommand(["logout"], {
    env: authEnv
  });
  if (logoutResult.stdout.trim()) {
    console.log(logoutResult.stdout.trim());
  }
  if (logoutResult.stderr.trim()) {
    console.error(logoutResult.stderr.trim());
  }
  if (logoutResult.exitCode !== 0) {
    throw new Error(`Codex logout failed with exit code ${logoutResult.exitCode}.`);
  }
  console.log(await renderCodexAuthStatus(authEnv));
}

/**
 * Executes one governed task via the production orchestrator path.
 *
 * **Why it exists:**
 * Provides deterministic CLI single-run behavior through the same runtime as interfaces.
 *
 * **What it talks to:**
 * - `buildDefaultBrain` and orchestrator `runTask`.
 *
 * @param goal - Task goal to execute.
 */
async function runTaskMode(goal: string): Promise<void> {
  const brain = buildDefaultBrain();
  const result = await brain.runTask(buildTaskRequest(goal));
  console.log(result.summary);
}

/**
 * Executes autonomous or daemon mode through `AutonomousLoop`.
 *
 * **Why it exists:**
 * Keeps loop-mode startup and contract wiring centralized for CLI execution.
 *
 * **What it talks to:**
 * - `createBrainConfigFromEnv`, `createModelClientFromEnv`, `buildDefaultBrain`, and `AutonomousLoop`.
 *
 * @param goal - Overarching loop goal.
 * @param mode - Loop mode (`autonomous` or `daemon`).
 * @param signal - Cancellation signal from process handlers.
 * @param daemonContract - Optional daemon policy (required for daemon mode).
 */
async function runLoopMode(
  goal: string,
  mode: "autonomous" | "daemon",
  signal: AbortSignal,
  daemonContract?: DaemonContract
): Promise<void> {
  const baseConfig = createBrainConfigFromEnv();
  const config = {
    ...baseConfig,
    runtime: {
      ...baseConfig.runtime,
      isDaemonMode: mode === "daemon"
    }
  };
  const brain = buildDefaultBrain();
  const modelClient = createModelClientFromEnv();
  const loop = new AutonomousLoop(brain, modelClient, config);
  await loop.run(
    goal,
    undefined,
    signal,
    mode === "daemon" ? daemonContract?.maxGoalRollovers : undefined
  );
}

/**
 * Runs the CLI workflow from raw argv tokens.
 *
 * **Why it exists:**
 * Provides one reusable command-execution surface for `index` and `cli` entrypoints.
 *
 * **What it talks to:**
 * - Parse helpers, runtime-mode executors, and signal lifecycle handling.
 *
 * @param rawArgs - CLI args excluding node/script paths.
 * @returns Process exit code.
 */
export async function runCliFromArgv(rawArgs: readonly string[]): Promise<number> {
  ensureEnvLoaded();
  const parsed = parseCliArgs(rawArgs);
  if (!parsed.ok) {
    if (parsed.failure.stream === "stdout") {
      console.log(parsed.failure.message);
    } else {
      console.error(parsed.failure.message);
    }
    return parsed.failure.exitCode;
  }

  const signalLifecycle = registerSignalHandlers(parsed.command.mode);
  try {
    if (parsed.command.mode === "auth") {
      await runAuthMode(parsed.command);
      return 0;
    }

    if (parsed.command.mode === "task") {
      await runTaskMode(parsed.command.goal ?? "");
      return 0;
    }

    if (parsed.command.mode === "autonomous") {
      await runLoopMode(parsed.command.goal ?? "", "autonomous", signalLifecycle.signal);
      return 0;
    }

    const daemonContract = resolveDaemonContract(process.env);
    await runLoopMode(parsed.command.goal ?? "", "daemon", signalLifecycle.signal, daemonContract);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[CLI] ${message}`);
    return 1;
  } finally {
    signalLifecycle.detach();
  }
}

/**
 * Executes this module as a script entrypoint.
 *
 * **Why it exists:**
 * Keeps top-level process handling minimal and import-safe for tests.
 *
 * **What it talks to:**
 * - `runCliFromArgv`.
 */
async function main(): Promise<void> {
  process.exitCode = await runCliFromArgv(process.argv.slice(2));
}

if (require.main === module) {
  void main();
}
