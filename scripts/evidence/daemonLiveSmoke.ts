/**
 * @fileoverview Runs a daemon-mode live smoke through the production CLI entrypoint contract and writes a deterministic artifact.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { runCliFromArgv } from "../../src/index";

const ARTIFACT_PATH = path.resolve(process.cwd(), "runtime/evidence/daemon_live_smoke_report.json");
const COMMAND_NAME = "npm run test:daemon:live_smoke";

interface DaemonLiveSmokeScenarioResult {
  id: "daemon_latch_denied" | "daemon_latch_allowed_bounded";
  exitCode: number;
  pass: boolean;
  detail: string;
}

interface DaemonLiveSmokeArtifact {
  generatedAt: string;
  command: string;
  scenarios: readonly DaemonLiveSmokeScenarioResult[];
  passCriteria: {
    latchDeniedPass: boolean;
    latchAllowedPass: boolean;
    overallPass: boolean;
  };
}

/**
 * Executes a callback with temporary environment overrides and deterministic restore.
 *
 * **Why it exists:**
 * Live-smoke runs should not leak env mutations into caller process state.
 *
 * **What it talks to:**
 * - Reads/writes `process.env`.
 *
 * @param overrides - Env keys to set/unset for callback execution.
 * @param callback - Async callback executed under temporary env values.
 * @returns Callback result.
 */
async function withEnvOverrides<T>(
  overrides: Partial<Record<string, string | undefined>>,
  callback: () => Promise<T>
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await callback();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

/**
 * Runs one daemon live-smoke scenario and captures structured outcome.
 *
 * **Why it exists:**
 * Keeps scenario execution + pass criteria in one deterministic helper.
 *
 * **What it talks to:**
 * - Executes production CLI runtime through `runCliFromArgv(...)`.
 *
 * @param id - Scenario identifier.
 * @param envOverrides - Env overrides used for this scenario.
 * @param expectedExitCode - Expected CLI exit code.
 * @param goal - Goal text passed to daemon mode.
 * @returns Structured scenario result.
 */
async function runDaemonScenario(
  id: DaemonLiveSmokeScenarioResult["id"],
  envOverrides: Partial<Record<string, string | undefined>>,
  expectedExitCode: number,
  goal: string
): Promise<DaemonLiveSmokeScenarioResult> {
  const exitCode = await withEnvOverrides(envOverrides, async () => {
    return runCliFromArgv(["--daemon", goal]);
  });

  const pass = exitCode === expectedExitCode;
  return {
    id,
    exitCode,
    pass,
    detail: pass
      ? `Observed expected exit code ${expectedExitCode}.`
      : `Expected exit code ${expectedExitCode} but observed ${exitCode}.`
  };
}

/**
 * Executes the daemon live smoke and returns artifact payload.
 *
 * **Why it exists:**
 * Provides one deterministic orchestration point for all daemon smoke scenarios.
 *
 * **What it talks to:**
 * - Calls scenario helpers that execute `runCliFromArgv`.
 *
 * @returns Daemon live-smoke artifact payload.
 */
async function runLiveSmoke(): Promise<DaemonLiveSmokeArtifact> {
  const latchDenied = await runDaemonScenario(
    "daemon_latch_denied",
    {
      BRAIN_MODEL_BACKEND: "mock",
      BRAIN_ALLOW_DAEMON_MODE: undefined,
      BRAIN_MAX_AUTONOMOUS_ITERATIONS: "1",
      BRAIN_MAX_DAEMON_GOAL_ROLLOVERS: "1"
    },
    1,
    "daemon live smoke denied"
  );

  const latchAllowed = await runDaemonScenario(
    "daemon_latch_allowed_bounded",
    {
      BRAIN_MODEL_BACKEND: "mock",
      BRAIN_ALLOW_DAEMON_MODE: "true",
      BRAIN_MAX_AUTONOMOUS_ITERATIONS: "1",
      BRAIN_MAX_DAEMON_GOAL_ROLLOVERS: "1"
    },
    0,
    "daemon live smoke done"
  );

  const latchDeniedPass = latchDenied.pass;
  const latchAllowedPass = latchAllowed.pass;

  return {
    generatedAt: new Date().toISOString(),
    command: COMMAND_NAME,
    scenarios: [latchDenied, latchAllowed],
    passCriteria: {
      latchDeniedPass,
      latchAllowedPass,
      overallPass: latchDeniedPass && latchAllowedPass
    }
  };
}

/**
 * Executes script entrypoint and writes artifact.
 *
 * **Why it exists:**
 * Keeps top-level I/O and exit behavior explicit for CI/manual review.
 *
 * **What it talks to:**
 * - Writes JSON artifact to `runtime/evidence/`.
 */
async function main(): Promise<void> {
  const artifact = await runLiveSmoke();
  await mkdir(path.dirname(ARTIFACT_PATH), { recursive: true });
  await writeFile(ARTIFACT_PATH, JSON.stringify(artifact, null, 2), "utf8");

  console.log(`Daemon live smoke artifact: ${ARTIFACT_PATH}`);
  console.log(`Pass status: ${artifact.passCriteria.overallPass ? "PASS" : "FAIL"}`);

  if (!artifact.passCriteria.overallPass) {
    process.exitCode = 1;
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
