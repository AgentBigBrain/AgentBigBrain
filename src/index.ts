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

export type CliMode = "task" | "autonomous" | "daemon";

export interface ParsedCliCommand {
  mode: CliMode;
  goal: string;
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
  "",
  "Modes:",
  "  default       Run one governed task and exit.",
  "  --autonomous  Run bounded autonomous iterations for one goal.",
  "  --daemon      Chain goals with explicit daemon safeguards.",
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
    if (parsed.command.mode === "task") {
      await runTaskMode(parsed.command.goal);
      return 0;
    }

    if (parsed.command.mode === "autonomous") {
      await runLoopMode(parsed.command.goal, "autonomous", signalLifecycle.signal);
      return 0;
    }

    const daemonContract = resolveDaemonContract(process.env);
    await runLoopMode(parsed.command.goal, "daemon", signalLifecycle.signal, daemonContract);
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
